import test from 'node:test';
import assert from 'node:assert/strict';
import {
  closeDb,
  createEvent,
  getConversationState,
  getDb,
  setConversationState,
} from '../src/db/store.js';
import { handleCustomerCommand, setCustomerMessageSender } from '../src/commands/welcome.js';
import { setCreateEventMessageSender } from '../src/commands/createEventFlow.js';
import { handleGuestRsvp, setRsvpMessageSender } from '../src/rsvp/handler.js';
import { handleOrganizerCommand, type CommandContext } from '../src/commands/organizer.js';
import type { SendMessageParams } from '../src/zernio/client.js';
import {
  handleVendorCommand,
  isVendorConversationState,
  setVendorMessageSender,
  shouldHandleVendor,
} from '../src/vendors/flow.js';
import { inspectInboxSendResult } from '../src/zernio/client.js';
import {
  addVendorProduct,
  createVendor,
  DuplicateVendorError,
  getVendorAvailability,
  getVendorById,
  getVendorByWhatsAppPhone,
  getVendorProducts,
  removeVendorProduct,
  setVendorAvailability,
  setVendorStatus,
  submitVendor,
  updateVendor,
  updateVendorProduct,
} from '../src/vendors/store.js';
import {
  CATERING_PRODUCT_STARTERS,
  INDIAN_BAKERY_PRODUCT_STARTERS,
} from '../src/vendors/catalog.js';

process.env.DATABASE_PATH = ':memory:';

const PHONE = '+15551118888';
const BAKERY_PHONE = '+15551118889';

const sent: SendMessageParams[] = [];

function ctx(
  phone: string,
  text: string,
  extra: Partial<CommandContext> = {},
): CommandContext {
  return {
    phone,
    text,
    conversationId: 'conv-vendor',
    accountId: 'acct-vendor',
    ...extra,
  };
}

async function tap(phone: string, payload: string, list = false): Promise<void> {
  await handleVendorCommand(
    ctx(phone, '', {
      interactiveType: list ? 'list_reply' : 'button_reply',
      interactiveId: payload,
      buttonPayload: list ? undefined : payload,
    }),
  );
}

async function typeText(phone: string, text: string): Promise<void> {
  await handleVendorCommand(ctx(phone, text));
}

test('vendor store create, lookup, update, submit, and status', () => {
  getDb();
  const vendor = createVendor({
    whatsappPhone: PHONE,
    category: 'CATERING',
    businessName: 'Spice Kitchen',
    contactName: 'Asha',
    email: 'asha@example.com',
    address: '12 Oak St',
    serviceArea: 'Edison NJ',
    description: 'Gujarati catering',
    pricing: 'From $15/person',
  });
  assert.equal(vendor.status, 'DRAFT');
  assert.equal(getVendorByWhatsAppPhone(PHONE)?.id, vendor.id);
  assert.equal(getVendorById(vendor.id)?.business_name, 'Spice Kitchen');

  const updated = updateVendor(vendor.id, { businessName: 'Spice Kitchen Co' });
  assert.equal(updated?.business_name, 'Spice Kitchen Co');

  const submitted = submitVendor(vendor.id);
  assert.equal(submitted?.status, 'UNDER_REVIEW');

  const approved = setVendorStatus(vendor.id, 'APPROVED');
  assert.equal(approved?.status, 'APPROVED');
  const active = setVendorStatus(vendor.id, 'ACTIVE');
  assert.equal(active?.status, 'ACTIVE');
  const suspended = setVendorStatus(vendor.id, 'SUSPENDED');
  assert.equal(suspended?.status, 'SUSPENDED');
  const rejected = setVendorStatus(vendor.id, 'REJECTED');
  assert.equal(rejected?.status, 'REJECTED');

  assert.throws(
    () => createVendor({ whatsappPhone: PHONE, category: 'CATERING' }),
    DuplicateVendorError,
  );
});

test('vendor products and availability', () => {
  getDb();
  const vendor = getVendorByWhatsAppPhone(PHONE);
  assert.ok(vendor);
  const product = addVendorProduct({
    vendorId: vendor.id,
    productName: 'Samosas',
    category: 'CATERING',
    description: 'Party tray',
    price: '$24',
    unit: 'tray',
  });
  assert.equal(getVendorProducts(vendor.id).length, 1);
  const edited = updateVendorProduct(product.id, { price: '$28' });
  assert.equal(edited?.price, '$28');
  assert.equal(removeVendorProduct(product.id), true);
  assert.equal(getVendorProducts(vendor.id).length, 0);

  const availability = setVendorAvailability(
    vendor.id,
    'Monday-Friday 9 AM-6 PM. Weekends by appointment.',
  );
  assert.match(availability.availability_text, /Monday-Friday/);
  const again = setVendorAvailability(vendor.id, 'Weekends only');
  assert.equal(again.availability_text, 'Weekends only');
  assert.equal(getVendorAvailability(vendor.id)?.availability_text, 'Weekends only');
});

test('vendor menu routing and coming soon items', async () => {
  sent.length = 0;
  setVendorMessageSender(async (params) => {
    sent.push(params);
  });
  setCustomerMessageSender(async (params) => {
    sent.push(params);
  });
  getDb();
  const handled = await handleCustomerCommand(ctx(PHONE, 'VENDOR'));
  assert.equal(handled, true);
  assert.equal(isVendorConversationState(getConversationState(PHONE)?.state), true);
  assert.match(sent.at(-1)?.message ?? '', /ZipBite Provider/);
  assert.ok(sent.at(-1)?.list);

  await tap(PHONE, 'VENDOR_INQUIRIES', true);
  assert.match(sent.at(-1)?.message ?? '', /Coming Soon/);
  await tap(PHONE, 'VENDOR_DASHBOARD', true);
  assert.match(sent.at(-1)?.message ?? '', /Coming Soon/);
  await tap(PHONE, 'VENDOR_SETTINGS', true);
  assert.match(sent.at(-1)?.message ?? '', /Coming Soon/);
});

test('incoming normalized text VENDOR routes to the vendor menu', async () => {
  sent.length = 0;
  setVendorMessageSender(async (params) => {
    sent.push(params);
  });
  setCustomerMessageSender(async (params) => {
    sent.push(params);
  });
  getDb();
  const phone = '+15551119910';
  assert.equal(shouldHandleVendor(phone, 'VENDOR'), true);
  assert.equal(shouldHandleVendor(phone, ' vendor '), true);

  const handled = await handleOrganizerCommand(ctx(phone, 'VENDOR'));
  assert.equal(handled, true);
  const last = sent.at(-1);
  assert.match(last?.message ?? '', /🏪 ZipBite Provider/);
  const menuIds = last?.list?.sections[0]?.rows.map((row) => row.id) ?? [];
  assert.deepEqual(menuIds, [
    'VENDOR_REGISTER',
    'VENDOR_MY_BUSINESS',
    'VENDOR_PRODUCTS',
    'VENDOR_AVAILABILITY',
    'VENDOR_ORDERS',
  ]);
  assert.equal(getConversationState(phone)?.state, 'VENDOR_MENU');
});

test('catering registration, review, cancel, and submit', async () => {
  sent.length = 0;
  setVendorMessageSender(async (params) => {
    sent.push(params);
  });
  getDb();
  const phone = '+15551119901';
  await handleCustomerCommand(ctx(phone, 'Connect Vendor'));
  await tap(phone, 'VENDOR_REGISTER', true);
  assert.match(sent.at(-1)?.message ?? '', /Choose a category/);
  await tap(phone, 'VENDOR_CAT_CATERING', true);
  await typeText(phone, 'Patel Catering');
  await typeText(phone, 'Rina Patel');
  await typeText(phone, 'not-an-email');
  assert.match(sent.at(-1)?.message ?? '', /valid email/);
  await typeText(phone, 'rina@example.com');
  await typeText(phone, '100 Main St');
  await typeText(phone, 'Edison and Woodbridge');
  await typeText(phone, 'Vegetarian Gujarati catering');
  await typeText(phone, 'Trays from $40');
  const review = sent.at(-1)?.message ?? '';
  assert.match(review, /Review Your Business/);
  assert.match(review, /Patel Catering/);
  assert.match(review, /Catering/);
  assert.match(review, /Rina Patel/);
  assert.match(review, /rina@example.com/);
  assert.doesNotMatch(review, /vendor id/i);
  assert.doesNotMatch(review, /\nid\b/i);

  await tap(phone, 'VENDOR_CANCEL');
  assert.equal(getVendorByWhatsAppPhone(phone)?.status, 'DRAFT');
  assert.equal(getConversationState(phone)?.state, 'VENDOR_MENU');

  await tap(phone, 'VENDOR_REGISTER', true);
  assert.match(sent.at(-1)?.message ?? '', /Review Your Business/);
  await tap(phone, 'VENDOR_SUBMIT');
  assert.equal(getVendorByWhatsAppPhone(phone)?.status, 'UNDER_REVIEW');
  assert.match(sent.at(-1)?.message ?? '', /submitted/);
  assert.match(sent.at(-1)?.message ?? '', /Under Review/);
  assert.match(sent.at(-1)?.message ?? '', /Powered by zipbite/);
});

test('Indian bakery registration', async () => {
  sent.length = 0;
  setVendorMessageSender(async (params) => {
    sent.push(params);
  });
  getDb();
  const phone = BAKERY_PHONE;
  await handleCustomerCommand(ctx(phone, 'VENDOR'));
  await tap(phone, 'VENDOR_REGISTER', true);
  await tap(phone, 'VENDOR_CAT_BAKERY', true);
  await typeText(phone, 'Royal Sweets');
  await typeText(phone, 'Amit');
  await typeText(phone, 'amit@bakery.test');
  await typeText(phone, '5 Baker Ln');
  await typeText(phone, 'Iselin');
  await typeText(phone, 'Fresh roti and mithai');
  await typeText(phone, '$8/dozen roti');
  assert.match(sent.at(-1)?.message ?? '', /Indian Bakery/);
  await tap(phone, 'VENDOR_SUBMIT');
  const vendor = getVendorByWhatsAppPhone(phone);
  assert.equal(vendor?.category, 'INDIAN_BAKERY');
  assert.equal(vendor?.status, 'UNDER_REVIEW');
});

test('duplicate vendor registration opens My Business', async () => {
  sent.length = 0;
  setVendorMessageSender(async (params) => {
    sent.push(params);
  });
  getDb();
  await handleCustomerCommand(ctx(BAKERY_PHONE, 'VENDOR'));
  await tap(BAKERY_PHONE, 'VENDOR_REGISTER', true);
  assert.match(sent.at(-1)?.message ?? '', /My Business/);
  assert.match(sent.at(-1)?.message ?? '', /Royal Sweets/);
});

test('my business, edit, products, and availability flows', async () => {
  sent.length = 0;
  setVendorMessageSender(async (params) => {
    sent.push(params);
  });
  getDb();
  const phone = '+15551119902';
  const vendor = createVendor({
    whatsappPhone: phone,
    category: 'INDIAN_BAKERY',
    businessName: 'Roti House',
    contactName: 'Neha',
    email: 'neha@test.com',
    address: '9 Pine',
    serviceArea: 'Metuchen',
    description: 'Roti',
    pricing: '$10/dozen',
  });
  submitVendor(vendor.id);

  await handleCustomerCommand(ctx(phone, 'VENDOR'));
  await tap(phone, 'VENDOR_MY_BUSINESS', true);
  const myBusiness = sent.at(-1)?.message ?? '';
  assert.match(myBusiness, /Roti House/);
  assert.doesNotMatch(myBusiness, /Vendor ID/i);
  assert.doesNotMatch(myBusiness, /id:\s*\d+/i);

  await tap(phone, 'VENDOR_EDIT');
  await tap(phone, 'VENDOR_EDITFIELD:serviceArea', true);
  await typeText(phone, 'Edison NJ');
  assert.equal(getVendorByWhatsAppPhone(phone)?.service_area, 'Edison NJ');
  assert.equal(getVendorByWhatsAppPhone(phone)?.whatsapp_phone, phone);

  await tap(phone, 'VENDOR_ADD_PRODUCT');
  assert.match(sent.at(-1)?.message ?? '', /Indian Bakery Products/);
  const starterIds = sent.at(-1)?.list?.sections[0].rows.map((row) => row.id) ?? [];
  assert.ok(starterIds.includes('VENDOR_STARTER:roti'));
  assert.equal(getVendorProducts(vendor.id).length, 0);

  await tap(phone, 'VENDOR_STARTER:roti', true);
  assert.equal(getVendorProducts(vendor.id).length, 0);
  await typeText(phone, 'Roti');
  await typeText(phone, 'Fresh Indian roti');
  await typeText(phone, '$8');
  await typeText(phone, 'dozen');
  assert.match(sent.at(-1)?.message ?? '', /Review Product/);
  assert.match(sent.at(-1)?.message ?? '', /Roti/);
  await tap(phone, 'VENDOR_SAVE_PRODUCT');
  const products = getVendorProducts(vendor.id);
  assert.equal(products.length, 1);
  assert.equal(products[0].product_name, 'Roti');
  assert.equal(products[0].unit, 'dozen');

  await tap(phone, `VENDOR_PROD:${products[0].id}`, true);
  await tap(phone, 'VENDOR_EDIT_PRODUCT');
  await tap(phone, 'VENDOR_PEDIT:productPrice', true);
  await typeText(phone, '$9');
  assert.equal(getVendorProducts(vendor.id)[0].price, '$9');

  await tap(phone, `VENDOR_PROD:${products[0].id}`, true);
  await tap(phone, 'VENDOR_REMOVE_PRODUCT');
  assert.equal(getVendorProducts(vendor.id).length, 0);

  await tap(phone, 'VENDOR_AVAILABILITY', true);
  await tap(phone, 'VENDOR_UPDATE_AVAIL');
  await typeText(phone, 'Monday-Friday, 9 AM-6 PM. Weekends by appointment.');
  assert.match(
    getVendorAvailability(vendor.id)?.availability_text ?? '',
    /Weekends by appointment/,
  );
});

test('catering starter menu is used for catering vendors', async () => {
  sent.length = 0;
  setVendorMessageSender(async (params) => {
    sent.push(params);
  });
  getDb();
  const phone = '+15551119903';
  createVendor({
    whatsappPhone: phone,
    category: 'CATERING',
    businessName: 'Tray Co',
    contactName: 'Sam',
    email: 'sam@test.com',
    address: '1 St',
    serviceArea: 'NY',
    description: 'Trays',
    pricing: '$50',
  });
  await handleCustomerCommand(ctx(phone, 'VENDOR'));
  await tap(phone, 'VENDOR_ADD_PRODUCT');
  assert.match(sent.at(-1)?.message ?? '', /Catering Products/);
  const ids = sent.at(-1)?.list?.sections[0].rows.map((row) => row.id) ?? [];
  assert.ok(ids.includes('VENDOR_STARTER:samosas'));
  assert.equal(CATERING_PRODUCT_STARTERS.length, 5);
  assert.equal(INDIAN_BAKERY_PRODUCT_STARTERS.length, 8);
});

test('vendor state is isolated from RSVP and event creation', async () => {
  sent.length = 0;
  setVendorMessageSender(async (params) => {
    sent.push(params);
  });
  setCustomerMessageSender(async (params) => {
    sent.push(params);
  });
  setCreateEventMessageSender(async (params) => {
    sent.push(params);
  });
  setRsvpMessageSender(async (params) => {
    sent.push(params);
  });
  getDb();
  const vendorPhone = '+15551119904';
  const guestPhone = '+15551119905';
  await handleCustomerCommand(ctx(vendorPhone, 'VENDOR'));
  assert.equal(shouldHandleVendor(vendorPhone, 'yes'), true);

  const event = createEvent('Party', 'July 4', 'Park', '+15551119906');
  const rsvp = await handleGuestRsvp({
    phone: vendorPhone,
    text: 'YES',
    conversationId: 'c1',
    accountId: 'a1',
    rawReply: 'YES',
  });
  assert.equal(rsvp, null);
  assert.equal(getConversationState(vendorPhone)?.state, 'VENDOR_MENU');

  setConversationState(guestPhone, 'WAITING_FOR_EVENT_NAME', { name: null });
  assert.equal(shouldHandleVendor(guestPhone, 'VENDOR'), true);
  const vendorFromEvent = await handleCustomerCommand(ctx(guestPhone, 'VENDOR'));
  assert.equal(vendorFromEvent, true);
  assert.equal(getConversationState(guestPhone)?.state, 'VENDOR_MENU');
  assert.match(sent.at(-1)?.message ?? '', /ZipBite Provider/);

  const guestRsvp = await handleGuestRsvp({
    phone: guestPhone,
    text: 'YES',
    conversationId: 'c2',
    accountId: 'a2',
    rawReply: 'YES',
  });
  assert.equal(guestRsvp, null);
  void event;
});

test('unregistered products and availability prompt registration', async () => {
  sent.length = 0;
  setVendorMessageSender(async (params) => {
    sent.push(params);
  });
  getDb();
  const phone = '+15551119907';
  await handleCustomerCommand(ctx(phone, 'VENDOR'));
  await tap(phone, 'VENDOR_PRODUCTS', true);
  assert.match(sent.at(-1)?.message ?? '', /haven't registered/);
  await tap(phone, 'VENDOR_AVAILABILITY', true);
  assert.match(sent.at(-1)?.message ?? '', /haven't registered/);
  await tap(phone, 'VENDOR_MY_BUSINESS', true);
  assert.match(sent.at(-1)?.message ?? '', /haven't registered/);
});

function assertConnectWelcome(message: SendMessageParams | undefined): void {
  assert.ok(message);
  assert.match(message.message, /Welcome to CONNECT/);
  assert.match(message.message, /Moments to Memory/);
  assert.doesNotMatch(message.message, /ZipBite Provider/);
  assert.doesNotMatch(message.message, /What is your business name/);
  assert.doesNotMatch(message.message, /Suggested name:/);
  assert.deepEqual(
    message.buttons?.map((button) => button.payload),
    ['CREATE_EVENT', 'MY_EVENTS', 'HELP'],
  );
}

async function webhookThenCustomer(phone: string, text: string): Promise<boolean> {
  const vendorHandled = await handleVendorCommand(ctx(phone, text));
  if (vendorHandled) {
    return true;
  }
  return handleCustomerCommand(ctx(phone, text));
}

test('hi from Vendor flow returns to the CONNECT Welcome menu', async () => {
  sent.length = 0;
  setVendorMessageSender(async (params) => {
    sent.push(params);
  });
  setCustomerMessageSender(async (params) => {
    sent.push(params);
  });
  getDb();
  const phone = '+15551119910';
  await handleCustomerCommand(ctx(phone, 'VENDOR'));
  assert.equal(getConversationState(phone)?.state, 'VENDOR_MENU');

  const handled = await webhookThenCustomer(phone, 'hi');
  assert.equal(handled, true);
  assertConnectWelcome(sent.at(-1));
  assert.equal(getConversationState(phone), undefined);
  assert.equal(getVendorByWhatsAppPhone(phone), undefined);
});

test('hello from Vendor flow returns to the CONNECT Welcome menu', async () => {
  sent.length = 0;
  setVendorMessageSender(async (params) => {
    sent.push(params);
  });
  setCustomerMessageSender(async (params) => {
    sent.push(params);
  });
  getDb();
  const phone = '+15551119911';
  await handleCustomerCommand(ctx(phone, 'VENDOR'));
  await tap(phone, 'VENDOR_REGISTER', true);
  assert.equal(getConversationState(phone)?.state, 'VENDOR_REG_CATEGORY');

  const handled = await handleCustomerCommand(ctx(phone, 'hello'));
  assert.equal(handled, true);
  assertConnectWelcome(sent.at(-1));
  assert.equal(getConversationState(phone), undefined);
});

test('hi from Catering product flow returns to the CONNECT Welcome menu', async () => {
  sent.length = 0;
  setVendorMessageSender(async (params) => {
    sent.push(params);
  });
  setCustomerMessageSender(async (params) => {
    sent.push(params);
  });
  getDb();
  const phone = '+15551119912';
  const vendor = createVendor({
    whatsappPhone: phone,
    category: 'CATERING',
    businessName: 'Tray Co',
    contactName: 'Sam',
    email: 'sam@test.com',
    address: '1 St',
    serviceArea: 'NY',
    description: 'Trays',
    pricing: '$50',
  });
  await handleCustomerCommand(ctx(phone, 'VENDOR'));
  await tap(phone, 'VENDOR_ADD_PRODUCT');
  await tap(phone, 'VENDOR_STARTER:samosas', true);
  assert.equal(getConversationState(phone)?.state, 'VENDOR_PRODUCT_NAME');
  assert.match(sent.at(-1)?.message ?? '', /Suggested name:/);

  const handled = await handleCustomerCommand(ctx(phone, 'hi'));
  assert.equal(handled, true);
  assertConnectWelcome(sent.at(-1));
  assert.equal(getConversationState(phone), undefined);
  assert.equal(getVendorById(vendor.id)?.business_name, 'Tray Co');
  assert.equal(getVendorByWhatsAppPhone(phone)?.id, vendor.id);
});

test('stale VENDOR list payload after hi does not re-enter Vendor', async () => {
  sent.length = 0;
  setVendorMessageSender(async (params) => {
    sent.push(params);
  });
  setCustomerMessageSender(async (params) => {
    sent.push(params);
  });
  getDb();
  const phone = '+15551119913';
  await handleCustomerCommand(ctx(phone, 'VENDOR'));
  assert.equal(getConversationState(phone)?.state, 'VENDOR_MENU');
  assert.equal(shouldHandleVendor(phone, 'VENDOR_REGISTER'), true);

  await handleCustomerCommand(ctx(phone, 'hi'));
  assert.equal(getConversationState(phone), undefined);
  assert.equal(shouldHandleVendor(phone, 'VENDOR_REGISTER'), false);
  assert.equal(shouldHandleVendor(phone, 'VENDOR_CAT_CATERING'), false);

  const stale = await handleCustomerCommand(
    ctx(phone, '', {
      interactiveType: 'list_reply',
      interactiveId: 'VENDOR_REGISTER',
    }),
  );
  assert.equal(stale, true);
  assertConnectWelcome(sent.at(-1));
  assert.equal(getConversationState(phone), undefined);
  assert.equal(getVendorByWhatsAppPhone(phone), undefined);

  const again = await handleCustomerCommand(ctx(phone, 'VENDOR'));
  assert.equal(again, true);
  assert.equal(getConversationState(phone)?.state, 'VENDOR_MENU');
  assert.match(sent.at(-1)?.message ?? '', /ZipBite Provider/);
});

test('valid current Catering selection advances to business name', async () => {
  sent.length = 0;
  setVendorMessageSender(async (params) => {
    sent.push(params);
  });
  setCustomerMessageSender(async (params) => {
    sent.push(params);
  });
  getDb();
  const phone = '+15551119914';
  await handleCustomerCommand(ctx(phone, 'VENDOR'));
  await tap(phone, 'VENDOR_REGISTER', true);
  assert.equal(getConversationState(phone)?.state, 'VENDOR_REG_CATEGORY');
  await tap(phone, 'VENDOR_CAT_CATERING', true);
  assert.equal(getConversationState(phone)?.state, 'VENDOR_REG_NAME');
  assert.match(sent.at(-1)?.message ?? '', /business name/);
  assert.equal(getVendorByWhatsAppPhone(phone)?.category, 'CATERING');
  assert.equal(getVendorByWhatsAppPhone(phone)?.status, 'DRAFT');
});

test('stale Catering payload after hi does not recreate Vendor flow', async () => {
  sent.length = 0;
  setVendorMessageSender(async (params) => {
    sent.push(params);
  });
  setCustomerMessageSender(async (params) => {
    sent.push(params);
  });
  getDb();
  const phone = '+15551119915';
  await handleCustomerCommand(ctx(phone, 'VENDOR'));
  await tap(phone, 'VENDOR_REGISTER', true);
  await handleCustomerCommand(ctx(phone, 'hi'));
  assert.equal(getConversationState(phone), undefined);

  await handleCustomerCommand(
    ctx(phone, '', {
      interactiveType: 'list_reply',
      interactiveId: 'VENDOR_CAT_CATERING',
    }),
  );
  assertConnectWelcome(sent.at(-1));
  assert.equal(getConversationState(phone), undefined);
  assert.equal(getVendorByWhatsAppPhone(phone), undefined);
});

test('sendVendorHome persists VENDOR_MENU only after a successful send', async () => {
  sent.length = 0;
  setVendorMessageSender(async () => ({ ok: false, type: 'list' }));
  setCustomerMessageSender(async (params) => {
    sent.push(params);
  });
  getDb();
  const phone = '+15551119916';
  await handleCustomerCommand(ctx(phone, 'VENDOR'));
  assert.equal(getConversationState(phone), undefined);
  assert.equal(getVendorByWhatsAppPhone(phone), undefined);

  setVendorMessageSender(async (params) => {
    sent.push(params);
    return { ok: true, type: 'list' };
  });
  await handleCustomerCommand(ctx(phone, 'VENDOR'));
  assert.equal(getConversationState(phone)?.state, 'VENDOR_MENU');
});

test('inspectInboxSendResult treats SDK success and rejection distinctly', () => {
  const ok = inspectInboxSendResult(
    { data: { messageId: 'wamid.example' }, response: { status: 200 } },
    'buttons',
  );
  assert.equal(ok.ok, true);
  assert.equal(ok.status, 200);
  assert.equal(ok.messageId, 'wamid.example');

  const rejected = inspectInboxSendResult(
    { data: { success: false }, response: { status: 200 } },
    'list',
  );
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'SEND_REJECTED');

  const failed = inspectInboxSendResult(undefined, 'text', {
    statusCode: 400,
    code: 'VALIDATION_ERROR',
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.status, 400);
  assert.equal(failed.code, 'VALIDATION_ERROR');
});

test('close vendor test database', () => {
  closeDb();
});
