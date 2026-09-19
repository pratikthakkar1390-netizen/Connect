import type { CommandContext } from '../../commands/organizer.js';
import { normalizePhone } from '../../config.js';
import {
  getConversationState,
  getMessageSession,
  setConversationState,
  upsertMessageSession,
  type ConversationStep,
} from '../../db/store.js';
import { todayInEventTimezone } from '../../dates/eventDate.js';
import { vendorPickupPickerUrl } from '../../http/vendorPickupToken.js';
import { interactiveCommandInput } from '../../whatsapp/eventList.js';
import {
  isInboxSendSuccessful,
  sendInboxMessage,
  type InboxListSection,
  type InboxSendResult,
  type SendMessageParams,
} from '../../zernio/client.js';
import { getVendorById, getVendorByWhatsAppPhone, getVendorProductById, type Vendor } from '../store.js';
import { orderAheadProducts, productLabel } from './catalog.js';
import {
  customerAccepted,
  customerCancelled,
  customerOrderReceived,
  customerPickedUp,
  customerPreparing,
  customerReady,
  formatOrderItems,
  formatPickupWhen,
  myOrderMessage,
  staleStatusMessage,
  statusLabel,
  vendorNewOrderMessage,
} from './copy.js';
import { formatCents } from './money.js';
import {
  formatPickupTimeInput,
  isPickupClosedDay,
  isSameDayPickupOpen,
  pickupValidationMessage,
  validateVendorPickup,
  validateVendorPickupDate,
  vendorPickupNow,
} from './pickup.js';
import {
  cartTotalCents,
  createVendorOrder,
  getLatestCustomerOrder,
  getVendorOrderById,
  listUnnotifiedNewVendorOrders,
  listVendorOrderItems,
  listVendorOrders,
  markVendorOrderNotified,
  productToCartItem,
  transitionVendorOrder,
  type CartItem,
  type VendorOrder,
  type VendorOrderStatus,
} from './store.js';

type SendFn = (params: SendMessageParams) => Promise<InboxSendResult | void>;
let sendOrderMessage: SendFn = sendInboxMessage;

export function setVendorOrderMessageSender(send?: SendFn): void {
  sendOrderMessage = send ?? sendInboxMessage;
}

export interface OrderDraft {
  vendorId?: number;
  cart?: CartItem[];
  pendingProductId?: number;
  pickupDate?: string;
  pickupTime?: string;
  pendingCancelOrderId?: number;
}

function parseDraft(raw: string | null | undefined): OrderDraft {
  if (!raw?.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as OrderDraft;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function readOrderDraft(phone: string, accountId?: string): OrderDraft {
  return parseDraft(getConversationState(phone, accountId)?.vendor_draft);
}

function saveOrderState(
  phone: string,
  state: ConversationStep,
  draft: OrderDraft,
  accountId?: string,
): void {
  const existing = parseDraft(getConversationState(phone, accountId)?.vendor_draft);
  setConversationState(
    phone,
    state,
    { vendor_draft: JSON.stringify({ ...existing, ...draft }) },
    accountId,
  );
}

async function reply(
  ctx: CommandContext,
  message: string,
  buttons?: Array<{ title: string; payload: string }>,
  list?: { button: string; sections: InboxListSection[] },
): Promise<boolean> {
  const result = await sendOrderMessage({
    conversationId: ctx.conversationId,
    accountId: ctx.accountId,
    message,
    buttons,
    list,
  });
  return isInboxSendSuccessful(result);
}

function cartItems(draft: OrderDraft): CartItem[] {
  return Array.isArray(draft.cart) ? draft.cart : [];
}

function upsertCartItem(items: CartItem[], next: CartItem): CartItem[] {
  const index = items.findIndex((item) => item.productId === next.productId);
  if (index < 0) {
    return [...items, next];
  }
  const merged = [...items];
  merged[index] = {
    ...merged[index],
    quantity: merged[index].quantity + next.quantity,
    unitPrice: next.unitPrice,
    productName: next.productName,
  };
  return merged;
}

function formatCart(items: CartItem[]): string {
  return [
    '🛒 Your Order',
    '',
    formatOrderItems(items),
    '',
    `Total: ${formatCents(cartTotalCents(items))}`,
  ].join('\n');
}

function cartActions(): { button: string; sections: InboxListSection[] } {
  return {
    button: 'Order',
    sections: [
      {
        rows: [
          { id: 'VENDOR_ADD_MORE', title: '➕ Add More' },
          { id: 'VENDOR_PICKUP_TIME', title: '🕐 Pickup Time' },
          { id: 'VENDOR_CHANGE_ORDER', title: '✏️ Change Order' },
          { id: 'VENDOR_CANCEL_CART', title: '❌ Cancel' },
        ],
      },
    ],
  };
}

export async function showCustomerOrderMenu(
  ctx: CommandContext,
  vendor: Vendor,
): Promise<boolean> {
  const products = orderAheadProducts(vendor.id);
  const draft = readOrderDraft(ctx.phone, ctx.accountId);
  const rows = products.slice(0, 8).map((product) => {
    const emoji = product.product_name.toLowerCase().includes('methi') ? '🌿' : '🫓';
    return {
      id: `VENDOR_BUY:${product.id}`,
      title: `${emoji} ${productLabel(product)}`.slice(0, 24),
    };
  });
  rows.push({ id: 'VENDOR_VIEW_ORDER', title: '🛒 View Order' });
  rows.push({ id: 'VENDOR_MY_ORDER', title: '📦 My Order' });
  rows.push({ id: 'VENDOR_CANCEL_CART', title: '❌ Cancel' });
  const sent = await reply(ctx, '🍽️ Order Ahead\n\nChoose what you\'d like to order:', undefined, {
    button: 'Menu',
    sections: [{ rows }],
  });
  if (sent) {
    saveOrderState(
      ctx.phone,
      'VENDOR_ORDER_MENU',
      { ...draft, vendorId: vendor.id },
      ctx.accountId,
    );
  }
  return sent;
}

async function showQuantity(ctx: CommandContext, vendor: Vendor, productId: number): Promise<boolean> {
  const product = getVendorProductById(productId);
  if (!product || product.vendor_id !== vendor.id) {
    return showCustomerOrderMenu(ctx, vendor);
  }
  const sent = await reply(
    ctx,
    `${productLabel(product)}\n\nHow many?`,
    undefined,
    {
      button: 'Qty',
      sections: [
        {
          title: 'Quantity',
          rows: [1, 2, 3, 4, 5].map((qty) => ({
            id: `VENDOR_QTY:${qty}`,
            title: String(qty),
          })),
        },
        {
          rows: [
            { id: 'VENDOR_ADD_MORE', title: '➕ Add More' },
            { id: 'VENDOR_VIEW_ORDER', title: '🛒 View Order' },
            { id: 'VENDOR_CANCEL_CART', title: '❌ Cancel' },
          ],
        },
      ],
    },
  );
  if (sent) {
    saveOrderState(
      ctx.phone,
      'VENDOR_ORDER_QTY',
      {
        ...readOrderDraft(ctx.phone, ctx.accountId),
        vendorId: vendor.id,
        pendingProductId: productId,
      },
      ctx.accountId,
    );
  }
  return sent;
}

async function showCart(ctx: CommandContext, vendor: Vendor): Promise<boolean> {
  const draft = readOrderDraft(ctx.phone, ctx.accountId);
  const items = cartItems(draft);
  if (!items.length) {
    await reply(ctx, 'Your order is empty. Choose a product to get started.');
    return showCustomerOrderMenu(ctx, vendor);
  }
  const sent = await reply(ctx, formatCart(items), undefined, cartActions());
  if (sent) {
    saveOrderState(ctx.phone, 'VENDOR_ORDER_CART', { ...draft, vendorId: vendor.id }, ctx.accountId);
  }
  return sent;
}

async function showChangeOrder(ctx: CommandContext, vendor: Vendor): Promise<boolean> {
  const draft = readOrderDraft(ctx.phone, ctx.accountId);
  const items = cartItems(draft);
  if (!items.length) {
    return showCustomerOrderMenu(ctx, vendor);
  }
  const sent = await reply(ctx, '✏️ Change Order\n\nTap an item to change its quantity.', undefined, {
    button: 'Items',
    sections: [
      {
        rows: [
          ...items.map((item) => ({
            id: `VENDOR_CART_EDIT:${item.productId}`,
            title: `${item.productName} × ${item.quantity}`.slice(0, 24),
          })),
          { id: 'VENDOR_ADD_MORE', title: '➕ Add More' },
          { id: 'VENDOR_CANCEL_CART', title: '❌ Cancel' },
        ],
      },
    ],
  });
  if (sent) {
    saveOrderState(ctx.phone, 'VENDOR_ORDER_CHANGE', { ...draft, vendorId: vendor.id }, ctx.accountId);
  }
  return sent;
}

async function showPickupDate(ctx: CommandContext, vendor: Vendor): Promise<boolean> {
  const draft = readOrderDraft(ctx.phone, ctx.accountId);
  if (!cartItems(draft).length) {
    return showCustomerOrderMenu(ctx, vendor);
  }
  const now = vendorPickupNow();
  const url = vendorPickupPickerUrl(ctx.phone, ctx.accountId, vendor.id);
  const today = todayInEventTimezone({ reference: now });
  const buttons =
    isSameDayPickupOpen(now) && !isPickupClosedDay(today)
      ? [{ title: 'Today', payload: `VENDOR_PDATE:${today}` }]
      : undefined;
  const sent = await reply(
    ctx,
    [
      '🕐 When would you like to pick up?',
      '',
      'Tue–Sun, 12:00 PM–8:00 PM',
      'Closed Monday.',
      'Same-day pickup only if you order before 12:00 PM.',
      '',
      '📅 Pick a date and time:',
      url,
    ].join('\n'),
    buttons,
  );
  if (sent) {
    saveOrderState(
      ctx.phone,
      'VENDOR_ORDER_PICKUP_DATE',
      { ...draft, vendorId: vendor.id },
      ctx.accountId,
    );
  }
  return sent;
}

export async function applyPickedVendorPickupDate(
  phone: string,
  accountId: string,
  vendor: Vendor,
  dateIso: string,
  conversationId?: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const dateCheck = validateVendorPickupDate(dateIso, vendorPickupNow());
  if (!dateCheck.ok) {
    return { ok: false, error: pickupValidationMessage(dateCheck.reason) };
  }
  const session = getMessageSession(phone, accountId);
  const ctx: CommandContext = {
    phone,
    text: '',
    conversationId: conversationId || session?.conversation_id || '',
    accountId,
  };
  const draft = {
    ...readOrderDraft(phone, accountId),
    vendorId: vendor.id,
    pickupDate: dateIso,
    pickupTime: undefined,
  };
  saveOrderState(phone, 'VENDOR_ORDER_PICKUP_TIME', draft, accountId);
  if (ctx.conversationId) {
    const url = vendorPickupPickerUrl(phone, accountId, vendor.id);
    await reply(
      ctx,
      `Choose any pickup time from 12:00 PM to 8:00 PM.\n\n${url}`,
    );
  }
  return { ok: true };
}

export async function applyPickedVendorPickup(
  phone: string,
  accountId: string,
  vendor: Vendor,
  dateIso: string,
  pickupTime: string,
  conversationId?: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const formatted = formatPickupTimeInput(pickupTime);
  const pickupCheck = validateVendorPickup(
    dateIso,
    formatted ?? pickupTime,
    vendorPickupNow(),
  );
  if (!pickupCheck.ok) {
    return { ok: false, error: pickupValidationMessage(pickupCheck.reason) };
  }
  const session = getMessageSession(phone, accountId);
  const ctx: CommandContext = {
    phone,
    text: '',
    conversationId: conversationId || session?.conversation_id || '',
    accountId,
  };
  const draft = {
    ...readOrderDraft(phone, accountId),
    vendorId: vendor.id,
    pickupDate: dateIso,
    pickupTime: formatted ?? pickupTime,
  };
  saveOrderState(phone, 'VENDOR_ORDER_REVIEW', draft, accountId);
  if (ctx.conversationId) {
    await showReview(ctx, vendor);
  }
  return { ok: true };
}

function reviewMessage(draft: OrderDraft): string | undefined {
  const items = cartItems(draft);
  if (!items.length || !draft.pickupDate || !draft.pickupTime) {
    return undefined;
  }
  return [
    '🛒 Order Review',
    '',
    formatOrderItems(items),
    '',
    'Pickup:',
    formatPickupWhen(draft.pickupDate, draft.pickupTime),
    '',
    `Total: ${formatCents(cartTotalCents(items))}`,
    '',
    '💵 Pay at Counter',
  ].join('\n');
}

async function showReview(ctx: CommandContext, vendor: Vendor): Promise<boolean> {
  const draft = readOrderDraft(ctx.phone, ctx.accountId);
  const message = reviewMessage(draft);
  if (!message) {
    return showPickupDate(ctx, vendor);
  }
  const sent = await reply(ctx, message, [
    { title: '✅ Confirm Order', payload: 'VENDOR_CONFIRM_ORDER' },
    { title: '✏️ Change Order', payload: 'VENDOR_CHANGE_ORDER' },
    { title: '❌ Cancel', payload: 'VENDOR_CANCEL_CART' },
  ]);
  if (sent) {
    saveOrderState(ctx.phone, 'VENDOR_ORDER_REVIEW', { ...draft, vendorId: vendor.id }, ctx.accountId);
  }
  return sent;
}

async function notifyVendorNewOrder(
  vendor: Vendor,
  order: VendorOrder,
): Promise<boolean> {
  const liveOrder = getVendorOrderById(order.id) ?? order;
  if (liveOrder.status !== 'NEW' || liveOrder.vendor_notified_at) {
    return false;
  }
  const live = getVendorById(vendor.id) ?? vendor;
  const accountId = live.zernio_whatsapp_account_id?.trim();
  if (!accountId) {
    console.error('Vendor order notify skipped: missing vendor WhatsApp account id', liveOrder.order_number);
    return false;
  }
  const session = getMessageSession(live.whatsapp_phone, accountId);
  if (!session?.conversation_id || session.account_id !== accountId) {
    console.error(
      'Vendor order notify skipped: no vendor-account operator session',
      liveOrder.order_number,
    );
    return false;
  }
  try {
    const result = await sendOrderMessage({
      conversationId: session.conversation_id,
      accountId,
      message: vendorNewOrderMessage(liveOrder, listVendorOrderItems(liveOrder.id)),
      buttons: [
        { title: '✅ Accept Order', payload: `VENDOR_ORDER_ACCEPT:${liveOrder.id}` },
        { title: '❌ Cancel Order', payload: `VENDOR_ORDER_CANCEL:${liveOrder.id}` },
      ],
    });
    if (!isInboxSendSuccessful(result)) {
      console.error('Vendor new-order notification failed', liveOrder.order_number);
      return false;
    }
    markVendorOrderNotified(liveOrder.id);
    return true;
  } catch (error) {
    console.error('Vendor new-order notification failed', liveOrder.order_number, error);
    return false;
  }
}

export async function releasePendingVendorOrderNotifications(
  vendor: Vendor,
): Promise<void> {
  const pending = listUnnotifiedNewVendorOrders(vendor.id);
  for (const order of pending) {
    await notifyVendorNewOrder(vendor, order);
  }
}

async function notifyCustomer(
  order: VendorOrder,
  accountId: string,
  message: string,
): Promise<void> {
  const session = getMessageSession(order.customer_phone, accountId);
  if (!session?.conversation_id || session.account_id !== accountId) {
    console.error('Customer order notify skipped: no vendor-account conversation', order.order_number);
    return;
  }
  try {
    await sendOrderMessage({
      conversationId: session.conversation_id,
      accountId,
      message,
    });
  } catch (error) {
    console.error('Customer order notification failed', order.order_number, error);
  }
}

async function confirmOrder(ctx: CommandContext, vendor: Vendor): Promise<boolean> {
  const draft = readOrderDraft(ctx.phone, ctx.accountId);
  const items = cartItems(draft);
  if (!items.length) {
    await reply(ctx, 'There is no order to confirm.');
    return showCustomerOrderMenu(ctx, vendor);
  }
  if (!draft.pickupDate || !draft.pickupTime) {
    return showPickupDate(ctx, vendor);
  }
  const pickupCheck = validateVendorPickup(
    draft.pickupDate,
    draft.pickupTime,
    vendorPickupNow(),
  );
  if (!pickupCheck.ok) {
    await reply(ctx, pickupValidationMessage(pickupCheck.reason));
    return showPickupDate(ctx, vendor);
  }
  try {
    const order = createVendorOrder({
      vendorId: vendor.id,
      customerPhone: ctx.phone,
      customerName: ctx.senderName,
      pickupDate: draft.pickupDate,
      pickupTime: draft.pickupTime,
      items,
    });
    upsertMessageSession(ctx.phone, ctx.conversationId, ctx.accountId);
    saveOrderState(
      ctx.phone,
      'VENDOR_ORDER_MENU',
      { vendorId: vendor.id, cart: [], pendingProductId: undefined, pickupDate: undefined, pickupTime: undefined },
      ctx.accountId,
    );
    await reply(ctx, customerOrderReceived(order, listVendorOrderItems(order.id)));
    await notifyVendorNewOrder(vendor, order);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message.includes('missing a valid price')) {
      await reply(ctx, 'This item is not available to order yet. Please choose another item or try again later.');
      return showCustomerOrderMenu(ctx, vendor);
    }
    if (
      message.includes('pickup') ||
      message.includes('Same-day') ||
      message.includes('already passed')
    ) {
      await reply(ctx, message);
      return showPickupDate(ctx, vendor);
    }
    throw error;
  }
}

function operatorStatusButtons(order: VendorOrder): Array<{ title: string; payload: string }> {
  switch (order.status) {
    case 'NEW':
      return [
        { title: '✅ Accept Order', payload: `VENDOR_ORDER_ACCEPT:${order.id}` },
        { title: '❌ Cancel Order', payload: `VENDOR_ORDER_CANCEL:${order.id}` },
      ];
    case 'ACCEPTED':
      return [
        { title: '🕐 Preparing', payload: `VENDOR_ORDER_PREP:${order.id}` },
        { title: '❌ Cancel Order', payload: `VENDOR_ORDER_CANCEL:${order.id}` },
      ];
    case 'PREPARING':
      return [
        { title: '✅ Ready for Pickup', payload: `VENDOR_ORDER_READY:${order.id}` },
        { title: '❌ Cancel Order', payload: `VENDOR_ORDER_CANCEL:${order.id}` },
      ];
    case 'READY_FOR_PICKUP':
      return [{ title: '📦 Picked Up', payload: `VENDOR_ORDER_PICKED:${order.id}` }];
    default:
      return [];
  }
}

function vendorStatusFollowUp(order: VendorOrder): string {
  return [`Order #${order.order_number}`, '', `Status: ${statusLabel(order.status).replace(/^[^ ]+ /, '')}`].join('\n');
}

async function showOperatorOrders(ctx: CommandContext, vendor: Vendor): Promise<boolean> {
  const sent = await reply(ctx, '📦 Orders\n\n🆕 New\n👨‍🍳 Preparing\n🎉 Ready\n📦 Picked Up', undefined, {
    button: 'Orders',
    sections: [
      {
        rows: [
          { id: 'VENDOR_ORDERS_NEW', title: '🆕 New Orders' },
          { id: 'VENDOR_ORDERS_PREP', title: '👨‍🍳 Preparing' },
          { id: 'VENDOR_ORDERS_READY', title: '🎉 Ready' },
          { id: 'VENDOR_ORDERS_RECENT', title: '📋 Recent Orders' },
        ],
      },
    ],
  });
  if (sent) {
    saveOrderState(ctx.phone, 'VENDOR_ORDERS_LIST', { vendorId: vendor.id }, ctx.accountId);
  }
  return sent;
}

async function showOperatorOrderList(
  ctx: CommandContext,
  vendor: Vendor,
  status: VendorOrderStatus | 'RECENT',
): Promise<boolean> {
  const orders = listVendorOrders(vendor.id, status);
  if (!orders.length) {
    await reply(ctx, 'No orders in this list yet.');
    return showOperatorOrders(ctx, vendor);
  }
  const sent = await reply(ctx, 'Select an order.', undefined, {
    button: 'Orders',
    sections: [
      {
        rows: orders.slice(0, 10).map((order) => ({
          id: `VENDOR_ORDER_OPEN:${order.id}`,
          title: `#${order.order_number}`.slice(0, 24),
        })),
      },
    ],
  });
  if (sent) {
    saveOrderState(ctx.phone, 'VENDOR_ORDERS_LIST', { vendorId: vendor.id }, ctx.accountId);
  }
  return sent;
}

async function showOperatorOrderDetail(
  ctx: CommandContext,
  vendor: Vendor,
  order: VendorOrder,
): Promise<boolean> {
  const items = listVendorOrderItems(order.id);
  const message = [
    `📦 Order #${order.order_number}`,
    '',
    'Customer:',
    order.customer_name?.trim() || 'Customer',
    '',
    'Phone:',
    order.customer_phone,
    '',
    'Items:',
    formatOrderItems(items),
    '',
    'Pickup:',
    formatPickupWhen(order.pickup_date, order.pickup_time),
    '',
    'Total:',
    formatCents(order.total_amount),
    '',
    'Payment:',
    '💵 Pay at Counter',
    '',
    'Status:',
    statusLabel(order.status),
  ].join('\n');
  const buttons = operatorStatusButtons(order);
  const sent = await reply(ctx, message, buttons.length ? buttons : undefined);
  if (sent) {
    saveOrderState(ctx.phone, 'VENDOR_ORDER_DETAIL', { vendorId: vendor.id }, ctx.accountId);
  }
  return sent;
}

async function applyOperatorTransition(
  ctx: CommandContext,
  vendor: Vendor,
  orderId: number,
  next: VendorOrderStatus,
): Promise<boolean> {
  const result = transitionVendorOrder(orderId, next, { cancelledBy: 'VENDOR' });
  if (!result.ok) {
    await reply(ctx, 'That order could not be found.');
    return true;
  }
  if (!result.changed) {
    await reply(ctx, staleStatusMessage(result.order));
    return true;
  }
  const liveVendor = getVendorById(vendor.id) ?? vendor;
  const order = result.order;
  const items = listVendorOrderItems(order.id);
    const notifyAccount = liveVendor.zernio_whatsapp_account_id?.trim();
    if (notifyAccount) {
      if (next === 'ACCEPTED') {
        await notifyCustomer(order, notifyAccount, customerAccepted(order));
        await reply(ctx, vendorStatusFollowUp(order), operatorStatusButtons(order));
      } else if (next === 'PREPARING') {
        await notifyCustomer(order, notifyAccount, customerPreparing(order));
        await reply(ctx, vendorStatusFollowUp(order), operatorStatusButtons(order));
      } else if (next === 'READY_FOR_PICKUP') {
        await notifyCustomer(order, notifyAccount, customerReady(order, vendor.address));
        await reply(ctx, vendorStatusFollowUp(order), operatorStatusButtons(order));
      } else if (next === 'PICKED_UP') {
        await notifyCustomer(order, notifyAccount, customerPickedUp(order));
        await reply(ctx, vendorStatusFollowUp(order));
      } else if (next === 'CANCELLED') {
        await notifyCustomer(order, notifyAccount, customerCancelled(order));
        await reply(ctx, `Order #${order.order_number} has been cancelled.`);
      }
    } else if (next === 'ACCEPTED') {
      await reply(ctx, vendorStatusFollowUp(order), operatorStatusButtons(order));
    } else if (next === 'PREPARING') {
      await reply(ctx, vendorStatusFollowUp(order), operatorStatusButtons(order));
    } else if (next === 'READY_FOR_PICKUP') {
      await reply(ctx, vendorStatusFollowUp(order), operatorStatusButtons(order));
    } else if (next === 'PICKED_UP') {
      await reply(ctx, vendorStatusFollowUp(order));
    } else if (next === 'CANCELLED') {
      await reply(ctx, `Order #${order.order_number} has been cancelled.`);
    }
  void items;
  return true;
}

function parseOrderId(prefix: string, compact: string, trimmed: string): number | undefined {
  const raw = trimmed.startsWith(prefix) ? trimmed.slice(prefix.length) : compact.slice(prefix.length);
  const id = Number(raw);
  return Number.isInteger(id) ? id : undefined;
}

export function isVendorOrderCommand(input: string): boolean {
  const compact = input.trim().toUpperCase().replace(/\s+/g, '_');
  return (
    compact.startsWith('VENDOR_BUY:') ||
    compact.startsWith('VENDOR_QTY:') ||
    compact.startsWith('VENDOR_CART_') ||
    compact.startsWith('VENDOR_PDATE:') ||
    compact.startsWith('VENDOR_PTIME:') ||
    compact.startsWith('VENDOR_ORDER_') ||
    compact.startsWith('VENDOR_ORDERS') ||
    [
      'VENDOR_VIEW_ORDER',
      'VENDOR_MY_ORDER',
      'VENDOR_ADD_MORE',
      'VENDOR_CHANGE_ORDER',
      'VENDOR_CANCEL_CART',
      'VENDOR_PICKUP_TIME',
      'VENDOR_CONFIRM_ORDER',
      'VENDOR_KEEP_ORDER',
      'VENDOR_CONFIRM_CANCEL',
    ].includes(compact)
  );
}

export async function handleCustomerOrderInbound(
  ctx: CommandContext,
  vendor: Vendor,
): Promise<boolean> {
  orderAheadProducts(vendor.id);
  const compact = interactiveCommandInput(ctx).trim().toUpperCase().replace(/\s+/g, '_');
  const trimmed = interactiveCommandInput(ctx).trim();
  const draft = {
    ...readOrderDraft(ctx.phone, ctx.accountId),
    vendorId: vendor.id,
  };
  saveOrderState(
    ctx.phone,
    getConversationState(ctx.phone, ctx.accountId)?.state ?? 'VENDOR_ORDER_MENU',
    draft,
    ctx.accountId,
  );

  if (compact.startsWith('VENDOR_BUY:')) {
    const productId = Number(trimmed.slice('VENDOR_BUY:'.length));
    return showQuantity(ctx, vendor, productId);
  }
  if (compact.startsWith('VENDOR_QTY:')) {
    const quantity = Number(trimmed.slice('VENDOR_QTY:'.length));
    const pending = readOrderDraft(ctx.phone, ctx.accountId).pendingProductId;
    const product = pending ? getVendorProductById(pending) : undefined;
    if (!product) {
      return showCustomerOrderMenu(ctx, vendor);
    }
    const item = productToCartItem(product, quantity);
    if ('error' in item) {
      if (item.error === 'missing_price') {
        await reply(ctx, 'This item is not available to order yet.');
      }
      return showCustomerOrderMenu(ctx, vendor);
    }
    const nextCart = upsertCartItem(cartItems(readOrderDraft(ctx.phone, ctx.accountId)), item);
    saveOrderState(
      ctx.phone,
      'VENDOR_ORDER_CART',
      { vendorId: vendor.id, cart: nextCart, pendingProductId: undefined },
      ctx.accountId,
    );
    return showCart(ctx, vendor);
  }
  if (compact === 'VENDOR_VIEW_ORDER') {
    return showCart(ctx, vendor);
  }
  if (compact === 'VENDOR_ADD_MORE') {
    return showCustomerOrderMenu(ctx, vendor);
  }
  if (compact === 'VENDOR_CHANGE_ORDER') {
    return showChangeOrder(ctx, vendor);
  }
  if (compact.startsWith('VENDOR_CART_EDIT:')) {
    const productId = Number(trimmed.slice('VENDOR_CART_EDIT:'.length));
    saveOrderState(
      ctx.phone,
      'VENDOR_ORDER_CHANGE',
      { ...readOrderDraft(ctx.phone, ctx.accountId), pendingProductId: productId },
      ctx.accountId,
    );
    return reply(ctx, 'Update this item.', [
      { title: '➕ Add 1', payload: `VENDOR_CART_INC:${productId}` },
      { title: '➖ Remove 1', payload: `VENDOR_CART_DEC:${productId}` },
      { title: '❌ Cancel', payload: 'VENDOR_CANCEL_CART' },
    ]);
  }
  if (compact.startsWith('VENDOR_CART_INC:') || compact.startsWith('VENDOR_CART_DEC:')) {
    const productId = Number(trimmed.split(':')[1]);
    const current = cartItems(readOrderDraft(ctx.phone, ctx.accountId));
    const next = current
      .map((item) => {
        if (item.productId !== productId) {
          return item;
        }
        const quantity = compact.startsWith('VENDOR_CART_INC:')
          ? item.quantity + 1
          : item.quantity - 1;
        return { ...item, quantity };
      })
      .filter((item) => item.quantity > 0);
    saveOrderState(
      ctx.phone,
      'VENDOR_ORDER_CART',
      { vendorId: vendor.id, cart: next },
      ctx.accountId,
    );
    return showCart(ctx, vendor);
  }
  if (compact === 'VENDOR_CANCEL_CART') {
    saveOrderState(
      ctx.phone,
      'VENDOR_ORDER_MENU',
      { vendorId: vendor.id, cart: [], pendingProductId: undefined, pickupDate: undefined, pickupTime: undefined },
      ctx.accountId,
    );
    await reply(ctx, 'Your order has been cancelled.');
    return showCustomerOrderMenu(ctx, vendor);
  }
  if (compact === 'VENDOR_PICKUP_TIME') {
    return showPickupDate(ctx, vendor);
  }
  if (compact.startsWith('VENDOR_PDATE:')) {
    const iso = trimmed.slice('VENDOR_PDATE:'.length);
    const applied = await applyPickedVendorPickupDate(
      ctx.phone,
      ctx.accountId,
      vendor,
      iso,
      ctx.conversationId,
    );
    if (!applied.ok) {
      await reply(ctx, applied.error);
      return showPickupDate(ctx, vendor);
    }
    return true;
  }
  if (compact.startsWith('VENDOR_PTIME:')) {
    const time = trimmed.slice('VENDOR_PTIME:'.length);
    const current = readOrderDraft(ctx.phone, ctx.accountId);
    const applied = await applyPickedVendorPickup(
      ctx.phone,
      ctx.accountId,
      vendor,
      current.pickupDate ?? '',
      time,
      ctx.conversationId,
    );
    if (!applied.ok) {
      await reply(ctx, applied.error);
      return showPickupDate(ctx, vendor);
    }
    return true;
  }
  if (compact === 'VENDOR_CONFIRM_ORDER') {
    return confirmOrder(ctx, vendor);
  }
  if (compact === 'VENDOR_MY_ORDER') {
    const order = getLatestCustomerOrder(vendor.id, ctx.phone);
    if (!order) {
      await reply(ctx, 'You do not have an order yet.');
      return showCustomerOrderMenu(ctx, vendor);
    }
    await reply(ctx, myOrderMessage(order, listVendorOrderItems(order.id)));
    return true;
  }

  const { isGreeting } = await import('../../commands/welcome.js');
  if (isGreeting(ctx.text)) {
    return showCustomerOrderMenu(ctx, vendor);
  }
  return showCustomerOrderMenu(ctx, vendor);
}

export async function handleVendorOrderCommand(ctx: CommandContext): Promise<boolean> {
  const input = interactiveCommandInput(ctx);
  if (!isVendorOrderCommand(input) && !getConversationState(ctx.phone, ctx.accountId)?.state?.startsWith('VENDOR_ORDER')) {
    return false;
  }
  const compact = input.trim().toUpperCase().replace(/\s+/g, '_');
  const trimmed = input.trim();
  const draft = readOrderDraft(ctx.phone, ctx.accountId);
  const vendor =
    (draft.vendorId ? getVendorById(draft.vendorId) : undefined) ??
    getVendorByWhatsAppPhone(ctx.phone);
  if (!vendor) {
    return false;
  }
  const isOperator = normalizePhone(ctx.phone) === normalizePhone(vendor.whatsapp_phone);
  if (!isOperator) {
    const state = getConversationState(ctx.phone, ctx.accountId)?.state;
    if (state?.startsWith('VENDOR_ORDER') || isVendorOrderCommand(input)) {
      return handleCustomerOrderInbound(ctx, vendor);
    }
    return false;
  }
    if (compact === 'VENDOR_ORDERS') {
      return showOperatorOrders(ctx, vendor);
    }
    if (compact === 'VENDOR_ORDERS_NEW') {
      return showOperatorOrderList(ctx, vendor, 'NEW');
    }
    if (compact === 'VENDOR_ORDERS_PREP') {
      return showOperatorOrderList(ctx, vendor, 'PREPARING');
    }
    if (compact === 'VENDOR_ORDERS_READY') {
      return showOperatorOrderList(ctx, vendor, 'READY_FOR_PICKUP');
    }
    if (compact === 'VENDOR_ORDERS_RECENT') {
      return showOperatorOrderList(ctx, vendor, 'RECENT');
    }
    if (compact.startsWith('VENDOR_ORDER_OPEN:')) {
      const id = parseOrderId('VENDOR_ORDER_OPEN:', compact, trimmed);
      const order = id ? getVendorOrderById(id) : undefined;
      if (!order || order.vendor_id !== vendor.id) {
        await reply(ctx, 'That order could not be found.');
        return true;
      }
      return showOperatorOrderDetail(ctx, vendor, order);
    }
    if (compact.startsWith('VENDOR_ORDER_ACCEPT:')) {
      const id = parseOrderId('VENDOR_ORDER_ACCEPT:', compact, trimmed);
      return id ? applyOperatorTransition(ctx, vendor, id, 'ACCEPTED') : true;
    }
    if (compact.startsWith('VENDOR_ORDER_PREP:')) {
      const id = parseOrderId('VENDOR_ORDER_PREP:', compact, trimmed);
      return id ? applyOperatorTransition(ctx, vendor, id, 'PREPARING') : true;
    }
    if (compact.startsWith('VENDOR_ORDER_READY:')) {
      const id = parseOrderId('VENDOR_ORDER_READY:', compact, trimmed);
      return id ? applyOperatorTransition(ctx, vendor, id, 'READY_FOR_PICKUP') : true;
    }
    if (compact.startsWith('VENDOR_ORDER_PICKED:')) {
      const id = parseOrderId('VENDOR_ORDER_PICKED:', compact, trimmed);
      return id ? applyOperatorTransition(ctx, vendor, id, 'PICKED_UP') : true;
    }
    if (compact.startsWith('VENDOR_ORDER_CANCEL:')) {
      const id = parseOrderId('VENDOR_ORDER_CANCEL:', compact, trimmed);
      if (!id) {
        return true;
      }
      const order = getVendorOrderById(id);
      if (!order) {
        await reply(ctx, 'That order could not be found.');
        return true;
      }
      if (order.status === 'PICKED_UP' || order.status === 'CANCELLED' || order.status === 'READY_FOR_PICKUP') {
        await reply(ctx, staleStatusMessage(order));
        return true;
      }
      saveOrderState(
        ctx.phone,
        'VENDOR_ORDER_CANCEL_CONFIRM',
        { vendorId: vendor.id, pendingCancelOrderId: id },
        ctx.accountId,
      );
      await reply(ctx, `⚠️ Cancel Order #${order.order_number}?`, [
        { title: 'Yes, Cancel Order', payload: 'VENDOR_CONFIRM_CANCEL' },
        { title: 'Keep Order', payload: 'VENDOR_KEEP_ORDER' },
      ]);
      return true;
    }
    if (compact === 'VENDOR_CONFIRM_CANCEL') {
      const id = readOrderDraft(ctx.phone, ctx.accountId).pendingCancelOrderId;
      return id ? applyOperatorTransition(ctx, vendor, id, 'CANCELLED') : true;
    }
    if (compact === 'VENDOR_KEEP_ORDER') {
      await reply(ctx, 'Okay, the order was kept.');
      return true;
    }
  return false;
}

export async function notifyVendorOfOrderForTests(
  vendor: Vendor,
  order: VendorOrder,
): Promise<void> {
  await notifyVendorNewOrder(vendor, order);
}
