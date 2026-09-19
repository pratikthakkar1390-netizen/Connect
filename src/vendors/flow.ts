import type { CommandContext } from '../commands/organizer.js';
import {
  getConversationState,
  setConversationState,
  type ConversationStep,
  type VendorCategory,
} from '../db/store.js';
import {
  isInboxSendSuccessful,
  sendInboxMessage,
  type InboxListSection,
  type InboxSendResult,
  type SendMessageParams,
} from '../zernio/client.js';
import { interactiveCommandInput } from '../whatsapp/eventList.js';
import {
  findProductStarter,
  productStartersForCategory,
  starterListTitle,
} from './catalog.js';
import {
  addVendorProduct,
  createVendor,
  DuplicateVendorError,
  getVendorAvailability,
  getVendorById,
  getVendorByWhatsAppPhone,
  getVendorProductById,
  getVendorProducts,
  removeVendorProduct,
  setVendorAvailability,
  submitVendor,
  updateVendor,
  updateVendorProduct,
  type Vendor,
} from './store.js';

type SendFn = (
  params: SendMessageParams,
) => Promise<InboxSendResult | void>;
let sendVendorMessage: SendFn = sendInboxMessage;

export function setVendorMessageSender(send?: SendFn): void {
  sendVendorMessage = send ?? sendInboxMessage;
}

export interface VendorDraft {
  vendorId?: number;
  category?: VendorCategory;
  businessName?: string;
  contactName?: string;
  email?: string;
  address?: string;
  serviceArea?: string;
  description?: string;
  pricing?: string;
  productId?: number;
  productStarterKey?: string;
  productName?: string;
  productDescription?: string;
  productPrice?: string;
  productUnit?: string;
  editField?: string;
}

const VENDOR_COMMANDS = new Set([
  'VENDOR',
  'VENDORS',
  'CONNECT VENDOR',
  'CONNECT_VENDOR',
  'VENDOR_HOME',
  'VENDOR_MENU',
]);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const BUSINESS_EDIT_FIELDS = [
  { key: 'businessName', title: 'Business Name', prompt: 'Enter the business name.' },
  { key: 'contactName', title: 'Contact Person', prompt: 'Enter the contact person name.' },
  { key: 'email', title: 'Email', prompt: 'Enter the business email.' },
  { key: 'address', title: 'Address', prompt: 'Enter the business address.' },
  { key: 'serviceArea', title: 'Service Area', prompt: 'Enter the service area.' },
  { key: 'description', title: 'Description', prompt: 'Enter the business description.' },
  { key: 'pricing', title: 'Pricing', prompt: 'Enter pricing information.' },
] as const;

const PRODUCT_EDIT_FIELDS = [
  { key: 'productName', title: 'Product Name', prompt: 'Enter the product name.' },
  {
    key: 'productDescription',
    title: 'Description',
    prompt: 'Enter the product description.',
  },
  { key: 'productPrice', title: 'Price', prompt: 'Enter the price.' },
  {
    key: 'productUnit',
    title: 'Unit',
    prompt: 'Enter the unit (for example: dozen, tray, each).',
  },
] as const;

export function isVendorConversationState(state?: string | null): boolean {
  return Boolean(state?.startsWith('VENDOR_'));
}

export function normalizeVendorCommandText(input: string): string {
  return input.trim().toUpperCase().replace(/\s+/g, ' ');
}

export function isVendorEntryText(input: string): boolean {
  const upper = normalizeVendorCommandText(input);
  return (
    upper === 'VENDOR' ||
    upper === 'VENDORS' ||
    upper === 'CONNECT VENDOR'
  );
}

export function isVendorCommand(input: string): boolean {
  const upper = normalizeVendorCommandText(input);
  const compact = upper.replace(/ /g, '_');
  if (VENDOR_COMMANDS.has(upper) || VENDOR_COMMANDS.has(compact)) {
    return true;
  }
  return compact.startsWith('VENDOR_');
}

export function shouldHandleVendor(
  phone: string,
  input: string,
  accountId?: string,
): boolean {
  if (isVendorEntryText(input)) {
    return true;
  }
  return isVendorConversationState(getConversationState(phone, accountId)?.state);
}

function parseDraft(raw: string | null | undefined): VendorDraft {
  if (!raw?.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as VendorDraft;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function readDraft(phone: string, accountId?: string): VendorDraft {
  return parseDraft(getConversationState(phone, accountId)?.vendor_draft);
}

function saveState(
  phone: string,
  state: ConversationStep,
  draft: VendorDraft,
  accountId?: string,
): void {
  setConversationState(phone, state, { vendor_draft: JSON.stringify(draft) }, accountId);
}

async function reply(
  ctx: CommandContext,
  message: string,
  buttons?: Array<{ title: string; payload: string }>,
  list?: { button: string; sections: InboxListSection[] },
): Promise<boolean> {
  const result = await sendVendorMessage({
    conversationId: ctx.conversationId,
    accountId: ctx.accountId,
    message,
    buttons,
    list,
  });
  return isInboxSendSuccessful(result);
}

function categoryLabel(category: string | null | undefined): string {
  if (category === 'INDIAN_BAKERY') {
    return 'Indian Bakery';
  }
  if (category === 'CATERING') {
    return 'Catering';
  }
  return category?.trim() || '—';
}

function statusLabel(status: string): string {
  switch (status) {
    case 'UNDER_REVIEW':
      return '⏳ Under Review';
    case 'DRAFT':
      return 'Draft';
    case 'SUBMITTED':
      return 'Submitted';
    case 'APPROVED':
      return 'Approved';
    case 'REJECTED':
      return 'Rejected';
    case 'SUSPENDED':
      return 'Suspended';
    case 'ACTIVE':
      return 'Active';
    default:
      return status;
  }
}

function vendorMenuList(): { button: string; sections: InboxListSection[] } {
  return {
    button: 'Menu',
    sections: [
      {
        title: 'Business',
        rows: [
          { id: 'VENDOR_REGISTER', title: '📝 Register Business' },
          { id: 'VENDOR_MY_BUSINESS', title: '📋 My Business' },
          { id: 'VENDOR_PRODUCTS', title: '🛠️ Products' },
          { id: 'VENDOR_AVAILABILITY', title: '📅 Availability' },
        ],
      },
      {
        title: 'Coming Soon',
        rows: [
          { id: 'VENDOR_INQUIRIES', title: '💬 Inquiries' },
          { id: 'VENDOR_DASHBOARD', title: '📊 Dashboard' },
          { id: 'VENDOR_SETTINGS', title: '⚙️ Settings' },
        ],
      },
    ],
  };
}

async function sendVendorHome(ctx: CommandContext): Promise<boolean> {
  const sent = await reply(ctx, '🏪 CONNECT Vendor', undefined, vendorMenuList());
  if (!sent) {
    return false;
  }
  saveState(ctx.phone, 'VENDOR_MENU', readDraft(ctx.phone, ctx.accountId), ctx.accountId);
  return true;
}

async function sendComingSoon(ctx: CommandContext): Promise<boolean> {
  const sent = await reply(
    ctx,
    'Coming Soon\n\nThis vendor feature is not available yet.',
    undefined,
    vendorMenuList(),
  );
  if (!sent) {
    return false;
  }
  saveState(ctx.phone, 'VENDOR_MENU', readDraft(ctx.phone, ctx.accountId), ctx.accountId);
  return true;
}

async function routeStaleVendorPayload(ctx: CommandContext): Promise<boolean> {
  const { routeToConnectWelcome } = await import('../commands/welcome.js');
  await routeToConnectWelcome(ctx);
  return true;
}

function reviewMessage(vendor: Vendor): string {
  return [
    '🏪 Review Your Business',
    '',
    'Business:',
    vendor.business_name ?? '—',
    '',
    'Category:',
    categoryLabel(vendor.category),
    '',
    'Contact:',
    vendor.contact_name ?? '—',
    '',
    'Email:',
    vendor.email ?? '—',
    '',
    'Address:',
    vendor.address ?? '—',
    '',
    'Service Area:',
    vendor.service_area ?? '—',
    '',
    'Description:',
    vendor.description ?? '—',
    '',
    'Pricing:',
    vendor.pricing ?? '—',
  ].join('\n');
}

function myBusinessMessage(vendor: Vendor): string {
  return [
    '🏪 My Business',
    '',
    'Business:',
    vendor.business_name ?? '—',
    '',
    'Category:',
    categoryLabel(vendor.category),
    '',
    'Status:',
    statusLabel(vendor.status),
    '',
    'Service Area:',
    vendor.service_area ?? '—',
  ].join('\n');
}

function productReviewMessage(draft: VendorDraft): string {
  return [
    '🛠️ Review Product',
    '',
    'Product:',
    draft.productName ?? '—',
    '',
    'Description:',
    draft.productDescription ?? '—',
    '',
    'Price:',
    draft.productPrice ?? '—',
    '',
    'Unit:',
    draft.productUnit ?? '—',
  ].join('\n');
}

function vendorForContext(ctx: CommandContext): Vendor | undefined {
  const draft = readDraft(ctx.phone, ctx.accountId);
  return (
    (draft.vendorId ? getVendorById(draft.vendorId) : undefined) ??
    getVendorByWhatsAppPhone(ctx.phone)
  );
}

async function requireRegisteredVendor(ctx: CommandContext): Promise<Vendor | null> {
  const vendor = vendorForContext(ctx);
  if (!vendor) {
    const sent = await reply(ctx, "You haven't registered your business yet.", [
      { title: '📝 Register', payload: 'VENDOR_REGISTER' },
    ]);
    if (sent) {
      saveState(ctx.phone, 'VENDOR_MENU', {}, ctx.accountId);
    }
    return null;
  }
  return vendor;
}

function persistDraftVendor(phone: string, draft: VendorDraft): Vendor {
  const existing =
    (draft.vendorId ? getVendorById(draft.vendorId) : undefined) ??
    getVendorByWhatsAppPhone(phone);
  if (existing) {
    return (
      updateVendor(existing.id, {
        ...(draft.category ? { category: draft.category } : {}),
        businessName: draft.businessName ?? existing.business_name,
        contactName: draft.contactName ?? existing.contact_name,
        email: draft.email ?? existing.email,
        address: draft.address ?? existing.address,
        serviceArea: draft.serviceArea ?? existing.service_area,
        description: draft.description ?? existing.description,
        pricing: draft.pricing ?? existing.pricing,
      }) ?? existing
    );
  }
  try {
    return createVendor({
      whatsappPhone: phone,
      category: draft.category,
      businessName: draft.businessName,
      contactName: draft.contactName,
      email: draft.email,
      address: draft.address,
      serviceArea: draft.serviceArea,
      description: draft.description,
      pricing: draft.pricing,
      status: 'DRAFT',
    });
  } catch (error) {
    if (error instanceof DuplicateVendorError) {
      const vendor = getVendorByWhatsAppPhone(phone);
      if (vendor) {
        return vendor;
      }
    }
    throw error;
  }
}

async function showRegistrationReview(ctx: CommandContext): Promise<void> {
  const draft = readDraft(ctx.phone, ctx.accountId);
  const vendor = persistDraftVendor(ctx.phone, draft);
  saveState(ctx.phone, 'VENDOR_REG_REVIEW', { ...draft, vendorId: vendor.id }, ctx.accountId);
  await reply(ctx, reviewMessage(vendor), [
    { title: '✅ Submit', payload: 'VENDOR_SUBMIT' },
    { title: '✏️ Edit', payload: 'VENDOR_EDIT' },
    { title: '❌ Cancel', payload: 'VENDOR_CANCEL' },
  ]);
}

async function startRegistration(ctx: CommandContext): Promise<void> {
  const existing = getVendorByWhatsAppPhone(ctx.phone);
  if (existing && existing.status !== 'DRAFT') {
    await showMyBusiness(ctx);
    return;
  }
  if (existing?.status === 'DRAFT' && existing.business_name && existing.category) {
    const sentReview = await reply(ctx, reviewMessage(existing), [
      { title: '✅ Submit', payload: 'VENDOR_SUBMIT' },
      { title: '✏️ Edit', payload: 'VENDOR_EDIT' },
      { title: '❌ Cancel', payload: 'VENDOR_CANCEL' },
    ]);
    if (sentReview) {
      saveState(ctx.phone, 'VENDOR_REG_REVIEW', { vendorId: existing.id }, ctx.accountId);
    }
    return;
  }
  const sent = await reply(ctx, 'Register Business\n\nChoose a category.', undefined, {
    button: 'Category',
    sections: [
      {
        title: 'Category',
        rows: [
          { id: 'VENDOR_CAT_CATERING', title: '🍽️ Catering' },
          { id: 'VENDOR_CAT_BAKERY', title: '🎂 Indian Bakery' },
        ],
      },
    ],
  });
  if (!sent) {
    return;
  }
  saveState(ctx.phone, 'VENDOR_REG_CATEGORY', { vendorId: existing?.id }, ctx.accountId);
}

async function showMyBusiness(ctx: CommandContext): Promise<void> {
  const vendor = vendorForContext(ctx);
  if (!vendor) {
    await requireRegisteredVendor(ctx);
    return;
  }
  saveState(ctx.phone, 'VENDOR_MENU', { vendorId: vendor.id }, ctx.accountId);
  await reply(ctx, myBusinessMessage(vendor), [
    { title: '🛠️ Products', payload: 'VENDOR_PRODUCTS' },
    { title: '📅 Availability', payload: 'VENDOR_AVAILABILITY' },
    { title: '✏️ Edit', payload: 'VENDOR_EDIT' },
  ]);
}

async function showProducts(ctx: CommandContext): Promise<void> {
  const vendor = await requireRegisteredVendor(ctx);
  if (!vendor) {
    return;
  }
  const products = getVendorProducts(vendor.id);
  saveState(ctx.phone, 'VENDOR_PRODUCTS', { vendorId: vendor.id }, ctx.accountId);
  const rows = products.slice(0, 9).map((product) => ({
    id: `VENDOR_PROD:${product.id}`,
    title: product.product_name.slice(0, 24),
  }));
  await reply(
    ctx,
    products.length === 0
      ? '🛠️ Products\n\nYou have not added any products yet.'
      : `🛠️ Products\n\n${products.map((product) => `• ${product.product_name}`).join('\n')}`,
    [{ title: '➕ Add Product', payload: 'VENDOR_ADD_PRODUCT' }],
    rows.length > 0
      ? { button: 'View product', sections: [{ title: 'Your products', rows }] }
      : undefined,
  );
}

async function showStarterProducts(ctx: CommandContext, vendor: Vendor): Promise<void> {
  const starters = productStartersForCategory(vendor.category);
  const title =
    vendor.category === 'INDIAN_BAKERY'
      ? '🎂 Indian Bakery Products'
      : '🍽️ Catering Products';
  saveState(ctx.phone, 'VENDOR_PRODUCT_STARTER', { vendorId: vendor.id }, ctx.accountId);
  await reply(ctx, title, undefined, {
    button: 'Choose',
    sections: [
      {
        title: 'Starter options',
        rows: starters.map((starter) => ({
          id: `VENDOR_STARTER:${starter.key}`,
          title: starterListTitle(starter),
        })),
      },
    ],
  });
}

async function showAvailability(ctx: CommandContext): Promise<void> {
  const vendor = await requireRegisteredVendor(ctx);
  if (!vendor) {
    return;
  }
  const current = getVendorAvailability(vendor.id);
  saveState(ctx.phone, 'VENDOR_AVAILABILITY', { vendorId: vendor.id }, ctx.accountId);
  await reply(
    ctx,
    [
      '📅 Availability',
      '',
      'Current availability:',
      current?.availability_text || 'Not set yet.',
    ].join('\n'),
    [{ title: '✏️ Update', payload: 'VENDOR_UPDATE_AVAIL' }],
  );
}

async function showEditBusinessMenu(ctx: CommandContext): Promise<void> {
  const vendor = await requireRegisteredVendor(ctx);
  if (!vendor) {
    return;
  }
  saveState(ctx.phone, 'VENDOR_EDIT_MENU', { vendorId: vendor.id }, ctx.accountId);
  await reply(ctx, '✏️ Edit\n\nWhat would you like to change?', undefined, {
    button: 'Edit',
    sections: [
      {
        title: 'Business details',
        rows: BUSINESS_EDIT_FIELDS.map((field) => ({
          id: `VENDOR_EDITFIELD:${field.key}`,
          title: field.title.slice(0, 24),
        })),
      },
    ],
  });
}

export async function handleVendorAccountInbound(
  ctx: CommandContext,
  vendor: Vendor,
): Promise<boolean> {
  const draft = {
    ...readDraft(ctx.phone, ctx.accountId),
    vendorId: vendor.id,
  };
  saveState(
    ctx.phone,
    getConversationState(ctx.phone, ctx.accountId)?.state ?? 'VENDOR_MENU',
    draft,
    ctx.accountId,
  );

  const handled = await handleVendorCommand(ctx);
  if (handled) {
    return true;
  }

  await sendVendorHome(ctx);
  saveState(
    ctx.phone,
    'VENDOR_MENU',
    { ...readDraft(ctx.phone, ctx.accountId), vendorId: vendor.id },
    ctx.accountId,
  );
  return true;
}

export async function handleVendorCommand(ctx: CommandContext): Promise<boolean> {
  const input = interactiveCommandInput(ctx);
  const trimmed = input.trim();
  const upper = trimmed.toUpperCase();
  const compact = upper.replace(/\s+/g, '_');
  const state = getConversationState(ctx.phone, ctx.accountId);
  const draft = readDraft(ctx.phone, ctx.accountId);
  const isInteractive =
    ctx.interactiveType === 'button_reply' ||
    ctx.interactiveType === 'list_reply' ||
    Boolean(ctx.interactiveId?.trim()) ||
    Boolean(ctx.buttonPayload?.trim());

  if (!isInteractive) {
    const { isGreeting } = await import('../commands/welcome.js');
    if (isGreeting(ctx.text) || isGreeting(trimmed)) {
      return false;
    }
  }

  if (isVendorEntryText(ctx.text) || isVendorEntryText(trimmed)) {
    await sendVendorHome(ctx);
    return true;
  }

  if (!isVendorConversationState(state?.state)) {
    if (isVendorCommand(trimmed) || isVendorCommand(ctx.text)) {
      return routeStaleVendorPayload(ctx);
    }
    return false;
  }

  if (!state) {
    return false;
  }

  if (
    compact === 'VENDOR_INQUIRIES' ||
    compact === 'VENDOR_DASHBOARD' ||
    compact === 'VENDOR_SETTINGS'
  ) {
    await sendComingSoon(ctx);
    return true;
  }

  if (
    VENDOR_COMMANDS.has(upper.replace(/\s+/g, ' ')) ||
    compact === 'VENDOR_HOME' ||
    compact === 'VENDOR_MENU'
  ) {
    await sendVendorHome(ctx);
    return true;
  }

  if (compact === 'VENDOR_REGISTER') {
    await startRegistration(ctx);
    return true;
  }
  if (compact === 'VENDOR_MY_BUSINESS') {
    await showMyBusiness(ctx);
    return true;
  }
  if (compact === 'VENDOR_PRODUCTS') {
    await showProducts(ctx);
    return true;
  }
  if (compact === 'VENDOR_AVAILABILITY') {
    await showAvailability(ctx);
    return true;
  }
  if (compact === 'VENDOR_CANCEL') {
    saveState(ctx.phone, 'VENDOR_MENU', {}, ctx.accountId);
    await sendVendorHome(ctx);
    return true;
  }
  if (compact === 'VENDOR_CAT_CATERING' || compact === 'VENDOR_CAT_BAKERY') {
    const category: VendorCategory =
      compact === 'VENDOR_CAT_BAKERY' ? 'INDIAN_BAKERY' : 'CATERING';
    const next = { ...draft, category };
    const sent = await reply(ctx, 'What is your business name?');
    if (!sent) {
      return true;
    }
    const vendor = persistDraftVendor(ctx.phone, next);
    saveState(ctx.phone, 'VENDOR_REG_NAME', { ...next, vendorId: vendor.id }, ctx.accountId);
    return true;
  }
  if (compact === 'VENDOR_SUBMIT') {
    const vendor =
      (draft.vendorId ? getVendorById(draft.vendorId) : undefined) ??
      persistDraftVendor(ctx.phone, draft);
    const submitted = submitVendor(vendor.id);
    if (!submitted) {
      await reply(ctx, 'Please complete all business details before submitting.', [
        { title: '✏️ Edit', payload: 'VENDOR_EDIT' },
      ]);
      return true;
    }
    saveState(ctx.phone, 'VENDOR_MENU', { vendorId: submitted.id }, ctx.accountId);
    await reply(
      ctx,
      [
        '✅ Your vendor application has been submitted.',
        '',
        'Status: ⏳ Under Review',
        '',
        "We'll review your business information and update your application.",
        '',
        'Powered by zipbite',
      ].join('\n'),
      undefined,
      vendorMenuList(),
    );
    return true;
  }
  if (compact === 'VENDOR_EDIT') {
    await showEditBusinessMenu(ctx);
    return true;
  }
  if (compact.startsWith('VENDOR_EDITFIELD:')) {
    const key = trimmed.slice('VENDOR_EDITFIELD:'.length);
    const field = BUSINESS_EDIT_FIELDS.find((item) => item.key === key);
    if (!field) {
      await showEditBusinessMenu(ctx);
      return true;
    }
    saveState(ctx.phone, 'VENDOR_EDIT_VALUE', { ...draft, editField: field.key }, ctx.accountId);
    await reply(ctx, field.prompt);
    return true;
  }
  if (compact === 'VENDOR_ADD_PRODUCT') {
    const vendor = await requireRegisteredVendor(ctx);
    if (!vendor) {
      return true;
    }
    await showStarterProducts(ctx, vendor);
    return true;
  }
  if (compact.startsWith('VENDOR_STARTER:')) {
    const key = trimmed.slice('VENDOR_STARTER:'.length);
    const vendor = await requireRegisteredVendor(ctx);
    if (!vendor) {
      return true;
    }
    const starter = findProductStarter(vendor.category, key);
    const productName = starter?.title ?? key;
    saveState(ctx.phone, 'VENDOR_PRODUCT_NAME', {
      vendorId: vendor.id,
      productStarterKey: key,
      productName,
    }, ctx.accountId);
    await reply(
      ctx,
      `Suggested name: ${productName}\n\nSend the product name to continue.`,
    );
    return true;
  }
  if (compact.startsWith('VENDOR_PROD:')) {
    const id = Number(trimmed.slice('VENDOR_PROD:'.length));
    const product = Number.isInteger(id) ? getVendorProductById(id) : undefined;
    const vendor = vendorForContext(ctx);
    if (!product || !vendor || product.vendor_id !== vendor.id) {
      await showProducts(ctx);
      return true;
    }
    saveState(ctx.phone, 'VENDOR_PRODUCT_ACTIONS', {
      vendorId: vendor.id,
      productId: product.id,
      productName: product.product_name,
      productDescription: product.description ?? '',
      productPrice: product.price ?? '',
      productUnit: product.unit ?? '',
    }, ctx.accountId);
    await reply(
      ctx,
      [
        `🛠️ ${product.product_name}`,
        '',
        product.description || 'No description',
        `Price: ${product.price || '—'}`,
        `Unit: ${product.unit || '—'}`,
      ].join('\n'),
      [
        { title: '✏️ Edit', payload: 'VENDOR_EDIT_PRODUCT' },
        { title: '🗑️ Remove', payload: 'VENDOR_REMOVE_PRODUCT' },
        { title: 'Back', payload: 'VENDOR_PRODUCTS' },
      ],
    );
    return true;
  }
  if (compact === 'VENDOR_SAVE_PRODUCT') {
    const vendor = await requireRegisteredVendor(ctx);
    if (!vendor) {
      return true;
    }
    const current = readDraft(ctx.phone, ctx.accountId);
    if (!current.productName?.trim()) {
      await showProducts(ctx);
      return true;
    }
    if (current.productId) {
      updateVendorProduct(current.productId, {
        productName: current.productName,
        description: current.productDescription,
        price: current.productPrice,
        unit: current.productUnit,
      });
    } else {
      addVendorProduct({
        vendorId: vendor.id,
        productName: current.productName,
        category: vendor.category,
        description: current.productDescription,
        price: current.productPrice,
        unit: current.productUnit,
      });
    }
    await showProducts(ctx);
    return true;
  }
  if (compact === 'VENDOR_EDIT_PRODUCT') {
    await reply(ctx, 'What would you like to edit?', undefined, {
      button: 'Edit',
      sections: [
        {
          title: 'Product',
          rows: PRODUCT_EDIT_FIELDS.map((field) => ({
            id: `VENDOR_PEDIT:${field.key}`,
            title: field.title.slice(0, 24),
          })),
        },
      ],
    });
    return true;
  }
  if (compact.startsWith('VENDOR_PEDIT:')) {
    const key = trimmed.slice('VENDOR_PEDIT:'.length);
    const field = PRODUCT_EDIT_FIELDS.find((item) => item.key === key);
    if (!field) {
      await showProducts(ctx);
      return true;
    }
    saveState(ctx.phone, 'VENDOR_PRODUCT_EDIT_VALUE', { ...draft, editField: field.key }, ctx.accountId);
    await reply(ctx, field.prompt);
    return true;
  }
  if (compact === 'VENDOR_REMOVE_PRODUCT') {
    const current = readDraft(ctx.phone, ctx.accountId);
    if (current.productId) {
      const vendor = vendorForContext(ctx);
      const product = getVendorProductById(current.productId);
      if (vendor && product && product.vendor_id === vendor.id) {
        removeVendorProduct(product.id);
      }
    }
    await showProducts(ctx);
    return true;
  }
  if (compact === 'VENDOR_UPDATE_AVAIL') {
    const vendor = await requireRegisteredVendor(ctx);
    if (!vendor) {
      return true;
    }
    saveState(ctx.phone, 'VENDOR_AVAILABILITY_EDIT', { vendorId: vendor.id }, ctx.accountId);
    await reply(
      ctx,
      'Please describe your availability.\n\nExample:\n"Monday-Friday, 9 AM-6 PM. Weekends by appointment."',
    );
    return true;
  }

  switch (state.state) {
    case 'VENDOR_REG_CATEGORY':
      await reply(ctx, 'Please choose Catering or Indian Bakery from the menu.');
      return true;
    case 'VENDOR_REG_NAME': {
      const next = { ...draft, businessName: trimmed };
      persistDraftVendor(ctx.phone, next);
      saveState(ctx.phone, 'VENDOR_REG_CONTACT', next, ctx.accountId);
      await reply(ctx, 'Who is the contact person?');
      return true;
    }
    case 'VENDOR_REG_CONTACT': {
      const next = { ...draft, contactName: trimmed };
      persistDraftVendor(ctx.phone, next);
      saveState(ctx.phone, 'VENDOR_REG_EMAIL', next, ctx.accountId);
      await reply(ctx, 'What is the business email?');
      return true;
    }
    case 'VENDOR_REG_EMAIL': {
      if (!EMAIL_RE.test(trimmed)) {
        await reply(ctx, 'Please enter a valid email address.');
        return true;
      }
      const next = { ...draft, email: trimmed };
      persistDraftVendor(ctx.phone, next);
      saveState(ctx.phone, 'VENDOR_REG_ADDRESS', next, ctx.accountId);
      await reply(ctx, 'What is the business address?');
      return true;
    }
    case 'VENDOR_REG_ADDRESS': {
      const next = { ...draft, address: trimmed };
      persistDraftVendor(ctx.phone, next);
      saveState(ctx.phone, 'VENDOR_REG_AREA', next, ctx.accountId);
      await reply(ctx, 'What is your service area?');
      return true;
    }
    case 'VENDOR_REG_AREA': {
      const next = { ...draft, serviceArea: trimmed };
      persistDraftVendor(ctx.phone, next);
      saveState(ctx.phone, 'VENDOR_REG_DESCRIPTION', next, ctx.accountId);
      await reply(ctx, 'Describe your business.');
      return true;
    }
    case 'VENDOR_REG_DESCRIPTION': {
      const next = { ...draft, description: trimmed };
      persistDraftVendor(ctx.phone, next);
      saveState(ctx.phone, 'VENDOR_REG_PRICING', next, ctx.accountId);
      await reply(ctx, 'Share your pricing information.');
      return true;
    }
    case 'VENDOR_REG_PRICING': {
      const next = { ...draft, pricing: trimmed };
      persistDraftVendor(ctx.phone, next);
      await showRegistrationReview(ctx);
      return true;
    }
    case 'VENDOR_REG_REVIEW':
      await showRegistrationReview(ctx);
      return true;
    case 'VENDOR_EDIT_VALUE': {
      const field = BUSINESS_EDIT_FIELDS.find((item) => item.key === draft.editField);
      const vendor = await requireRegisteredVendor(ctx);
      if (!vendor || !field) {
        await showEditBusinessMenu(ctx);
        return true;
      }
      if (field.key === 'email' && !EMAIL_RE.test(trimmed)) {
        await reply(ctx, 'Please enter a valid email address.');
        return true;
      }
      if (field.key === 'businessName') {
        updateVendor(vendor.id, { businessName: trimmed });
      } else if (field.key === 'contactName') {
        updateVendor(vendor.id, { contactName: trimmed });
      } else if (field.key === 'email') {
        updateVendor(vendor.id, { email: trimmed });
      } else if (field.key === 'address') {
        updateVendor(vendor.id, { address: trimmed });
      } else if (field.key === 'serviceArea') {
        updateVendor(vendor.id, { serviceArea: trimmed });
      } else if (field.key === 'description') {
        updateVendor(vendor.id, { description: trimmed });
      } else {
        updateVendor(vendor.id, { pricing: trimmed });
      }
      await showMyBusiness(ctx);
      return true;
    }
    case 'VENDOR_PRODUCT_NAME': {
      saveState(ctx.phone, 'VENDOR_PRODUCT_DESCRIPTION', {
        ...draft,
        productName: trimmed,
      }, ctx.accountId);
      await reply(ctx, 'Enter a description.\nExample: Fresh Indian roti');
      return true;
    }
    case 'VENDOR_PRODUCT_DESCRIPTION': {
      saveState(ctx.phone, 'VENDOR_PRODUCT_PRICE', { ...draft, productDescription: trimmed }, ctx.accountId);
      await reply(ctx, 'What is the price?\nExample: $24');
      return true;
    }
    case 'VENDOR_PRODUCT_PRICE': {
      saveState(ctx.phone, 'VENDOR_PRODUCT_UNIT', { ...draft, productPrice: trimmed }, ctx.accountId);
      await reply(ctx, 'What is the unit?\nExample: dozen');
      return true;
    }
    case 'VENDOR_PRODUCT_UNIT': {
      const next = { ...draft, productUnit: trimmed };
      saveState(ctx.phone, 'VENDOR_PRODUCT_REVIEW', next, ctx.accountId);
      await reply(ctx, productReviewMessage(next), [
        { title: '✅ Save', payload: 'VENDOR_SAVE_PRODUCT' },
        { title: '✏️ Edit', payload: 'VENDOR_EDIT_PRODUCT' },
        { title: '❌ Cancel', payload: 'VENDOR_PRODUCTS' },
      ]);
      return true;
    }
    case 'VENDOR_PRODUCT_REVIEW':
      await reply(ctx, productReviewMessage(draft), [
        { title: '✅ Save', payload: 'VENDOR_SAVE_PRODUCT' },
        { title: '✏️ Edit', payload: 'VENDOR_EDIT_PRODUCT' },
        { title: '❌ Cancel', payload: 'VENDOR_PRODUCTS' },
      ]);
      return true;
    case 'VENDOR_PRODUCT_EDIT_VALUE': {
      const field = PRODUCT_EDIT_FIELDS.find((item) => item.key === draft.editField);
      if (!field) {
        await showProducts(ctx);
        return true;
      }
      const next = { ...draft, [field.key]: trimmed };
      if (next.productId) {
        updateVendorProduct(next.productId, {
          productName: next.productName,
          description: next.productDescription,
          price: next.productPrice,
          unit: next.productUnit,
        });
        await showProducts(ctx);
        return true;
      }
      saveState(ctx.phone, 'VENDOR_PRODUCT_REVIEW', next, ctx.accountId);
      await reply(ctx, productReviewMessage(next), [
        { title: '✅ Save', payload: 'VENDOR_SAVE_PRODUCT' },
        { title: '✏️ Edit', payload: 'VENDOR_EDIT_PRODUCT' },
        { title: '❌ Cancel', payload: 'VENDOR_PRODUCTS' },
      ]);
      return true;
    }
    case 'VENDOR_AVAILABILITY_EDIT': {
      const vendor = await requireRegisteredVendor(ctx);
      if (!vendor) {
        return true;
      }
      setVendorAvailability(vendor.id, trimmed);
      await showAvailability(ctx);
      return true;
    }
    default:
      await sendVendorHome(ctx);
      return true;
  }
}
