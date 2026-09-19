import test from 'node:test';
import assert from 'node:assert/strict';
import {
  closeDb,
  getConversationState,
  getDb,
  upsertMessageSession,
} from '../src/db/store.js';
import { getEventTimezone, zonedWallTimeToUtc } from '../src/dates/eventDate.js';
import type { CommandContext } from '../src/commands/organizer.js';
import type { SendMessageParams } from '../src/zernio/client.js';
import {
  handleVendorAccountInbound,
  handleVendorCommand,
  setVendorMessageSender,
} from '../src/vendors/flow.js';
import {
  createVendor,
  setVendorZernioWhatsAppAccountId,
} from '../src/vendors/store.js';
import { ensureOrderAheadCatalog } from '../src/vendors/orders/catalog.js';
import {
  handleCustomerOrderInbound,
  notifyVendorOfOrderForTests,
} from '../src/vendors/orders/flow.js';
import { setVendorPickupClock } from '../src/vendors/orders/pickup.js';
import {
  createVendorOrder,
  getLatestCustomerOrder,
  getVendorOrderById,
  listVendorOrders,
  type CartItem,
} from '../src/vendors/orders/store.js';

process.env.DATABASE_PATH = ':memory:';

const CONNECT = 'acct-connect-notify';
const VENDOR_ACCT = 'acct-vendor-notify';
const CUSTOMER = '+15557772101';
const OPERATOR = '+15557772999';
const sent: SendMessageParams[] = [];

function wallClock(isoDate: string, hour: number, minute = 0): Date {
  const [year, month, day] = isoDate.split('-').map(Number);
  return zonedWallTimeToUtc(
    { year, month, day, hour, minute, second: 0 },
    getEventTimezone(),
  );
}

function ctx(
  phone: string,
  extra: Partial<CommandContext> = {},
): CommandContext {
  return {
    phone,
    text: extra.text ?? '',
    conversationId: extra.conversationId ?? `conv-${phone}`,
    accountId: extra.accountId ?? VENDOR_ACCT,
    senderName: extra.senderName ?? 'John',
    ...extra,
  };
}

function setup() {
  getDb();
  const vendor = createVendor({
    whatsappPhone: OPERATOR,
    businessName: 'Roti House',
    category: 'INDIAN_BAKERY',
    address: '12 Spice Lane',
    status: 'ACTIVE',
  });
  setVendorZernioWhatsAppAccountId(vendor.id, VENDOR_ACCT);
  const products = ensureOrderAheadCatalog(vendor.id);
  upsertMessageSession(CUSTOMER, 'conv-customer-vendor', VENDOR_ACCT);
  return { vendor, products };
}

function orderItems(productId: number): CartItem[] {
  return [
    {
      productId,
      productName: 'Roti — 25 ct',
      quantity: 1,
      unitPrice: 1000,
    },
  ];
}

function placeOrder(
  vendorId: number,
  productId: number,
  pickupDate = '2026-09-26',
) {
  return createVendorOrder({
    vendorId,
    customerPhone: CUSTOMER,
    customerName: 'John',
    pickupDate,
    pickupTime: '5:30 PM',
    items: orderItems(productId),
    now: wallClock('2026-09-19', 10, 0),
  });
}

test.beforeEach(() => {
  process.env.ZERNIO_WHATSAPP_ACCOUNT_ID = CONNECT;
  sent.length = 0;
  setVendorPickupClock(() => wallClock('2026-09-19', 10, 0));
  setVendorMessageSender(async (params) => {
    sent.push(params);
  });
});

test.afterEach(() => {
  setVendorPickupClock();
  setVendorMessageSender();
  closeDb();
});

test('order is saved when operator has no vendor-account session', async () => {
  const { vendor, products } = setup();
  upsertMessageSession(OPERATOR, 'conv-operator-connect', CONNECT);
  const order = placeOrder(vendor.id, products[0].id);
  assert.equal(order.status, 'NEW');
  assert.equal(order.vendor_notified_at, null);
  await notifyVendorOfOrderForTests(vendor, order);
  assert.equal(getVendorOrderById(order.id)?.status, 'NEW');
  assert.equal(getVendorOrderById(order.id)?.vendor_notified_at, null);
  assert.equal(
    sent.some(
      (message) =>
        message.message.includes('New Pickup Order') &&
        message.conversationId === 'conv-operator-connect',
    ),
    false,
  );
  assert.equal(
    sent.some(
      (message) =>
        message.accountId === VENDOR_ACCT &&
        message.conversationId === 'conv-operator-connect',
    ),
    false,
  );
});

test('vendor notification uses vendor accountId and operator vendor-account conversation', async () => {
  const { vendor, products } = setup();
  upsertMessageSession(OPERATOR, 'conv-operator-vendor', VENDOR_ACCT);
  const order = placeOrder(vendor.id, products[0].id);
  await notifyVendorOfOrderForTests(vendor, order);
  const notify = sent.find((message) => message.message.includes('New Pickup Order'));
  assert.ok(notify);
  assert.equal(notify.accountId, VENDOR_ACCT);
  assert.equal(notify.conversationId, 'conv-operator-vendor');
  assert.match(notify.message, /\+15557772101/);
  assert.ok(
    notify.buttons?.some((button) => button.payload === `VENDOR_ORDER_ACCEPT:${order.id}`),
  );
  assert.ok(getVendorOrderById(order.id)?.vendor_notified_at);
});

test('missing vendor-account session does not fall back to CONNECT session', async () => {
  const { vendor, products } = setup();
  upsertMessageSession(OPERATOR, 'conv-operator-connect', CONNECT);
  const order = placeOrder(vendor.id, products[0].id, '2026-09-27');
  await notifyVendorOfOrderForTests(vendor, order);
  assert.equal(sent.length, 0);
  assert.equal(getVendorOrderById(order.id)?.vendor_notified_at, null);
});

test('first operator inbound on vendor account releases pending NEW orders', async () => {
  const { vendor, products } = setup();
  const first = placeOrder(vendor.id, products[0].id, '2026-09-26');
  const second = placeOrder(vendor.id, products[0].id, '2026-09-27');
  assert.equal(getVendorOrderById(first.id)?.vendor_notified_at, null);
  upsertMessageSession(OPERATOR, 'conv-operator-vendor', VENDOR_ACCT);
  await handleVendorAccountInbound(
    ctx(OPERATOR, {
      text: 'Hi',
      conversationId: 'conv-operator-vendor',
      accountId: VENDOR_ACCT,
    }),
    vendor,
  );
  const notifies = sent.filter((message) => message.message.includes('New Pickup Order'));
  assert.equal(notifies.length, 2);
  assert.ok(notifies.every((message) => message.accountId === VENDOR_ACCT));
  assert.ok(notifies.every((message) => message.conversationId === 'conv-operator-vendor'));
  assert.ok(getVendorOrderById(first.id)?.vendor_notified_at);
  assert.ok(getVendorOrderById(second.id)?.vendor_notified_at);
});

test('failed send leaves vendor_notified_at NULL and does not resend a successful order', async () => {
  const { vendor, products } = setup();
  upsertMessageSession(OPERATOR, 'conv-operator-vendor', VENDOR_ACCT);
  const first = placeOrder(vendor.id, products[0].id, '2026-09-26');
  const second = placeOrder(vendor.id, products[0].id, '2026-09-27');
  setVendorMessageSender(async (params) => {
    sent.push(params);
    if (params.message.includes(second.order_number)) {
      return { ok: false, type: 'buttons' };
    }
  });
  await notifyVendorOfOrderForTests(vendor, first);
  await notifyVendorOfOrderForTests(vendor, second);
  assert.ok(getVendorOrderById(first.id)?.vendor_notified_at);
  assert.equal(getVendorOrderById(second.id)?.vendor_notified_at, null);

  sent.length = 0;
  setVendorMessageSender(async (params) => {
    sent.push(params);
  });
  await notifyVendorOfOrderForTests(vendor, first);
  await notifyVendorOfOrderForTests(vendor, second);
  assert.equal(
    sent.filter((message) => message.message.includes(first.order_number)).length,
    0,
  );
  assert.equal(
    sent.filter((message) => message.message.includes(second.order_number)).length,
    1,
  );
  assert.ok(getVendorOrderById(second.id)?.vendor_notified_at);
});

test('operator Vendor Orders fallback and customer status use vendor-account conversations', async () => {
  const { vendor, products } = setup();
  upsertMessageSession(OPERATOR, 'conv-operator-connect', CONNECT);
  const order = placeOrder(vendor.id, products[0].id);
  await handleVendorCommand(
    ctx(OPERATOR, {
      accountId: CONNECT,
      conversationId: 'conv-operator-connect',
      interactiveType: 'list_reply',
      interactiveId: 'VENDOR_ORDERS',
    }),
  );
  assert.match(sent.at(-1)?.message ?? '', /📦 Orders/);
  assert.equal(sent.at(-1)?.accountId, CONNECT);
  assert.equal(listVendorOrders(vendor.id, 'NEW').some((row) => row.id === order.id), true);

  upsertMessageSession(OPERATOR, 'conv-operator-vendor', VENDOR_ACCT);
  sent.length = 0;
  await handleVendorCommand({
    ...ctx(OPERATOR, {
      accountId: VENDOR_ACCT,
      conversationId: 'conv-operator-vendor',
      interactiveType: 'button_reply',
      interactiveId: `VENDOR_ORDER_ACCEPT:${order.id}`,
      buttonPayload: `VENDOR_ORDER_ACCEPT:${order.id}`,
    }),
  });
  const customerStatus = sent.find((message) =>
    message.message.includes('Order Accepted'),
  );
  assert.ok(customerStatus);
  assert.equal(customerStatus.accountId, VENDOR_ACCT);
  assert.equal(customerStatus.conversationId, 'conv-customer-vendor');
  const operatorFollowUp = sent.find(
    (message) =>
      message.conversationId === 'conv-operator-vendor' &&
      message.message.includes(order.order_number),
  );
  assert.ok(operatorFollowUp);
  assert.equal(operatorFollowUp.accountId, VENDOR_ACCT);
});

test('customer confirmation still succeeds without operator vendor-account session', async () => {
  const { vendor, products } = setup();
  await handleCustomerOrderInbound(ctx(CUSTOMER, { text: 'Hi' }), vendor);
  await handleCustomerOrderInbound(
    ctx(CUSTOMER, {
      interactiveType: 'list_reply',
      interactiveId: `VENDOR_BUY:${products[0].id}`,
    }),
    vendor,
  );
  await handleCustomerOrderInbound(
    ctx(CUSTOMER, {
      interactiveType: 'button_reply',
      interactiveId: 'VENDOR_QTY:1',
      buttonPayload: 'VENDOR_QTY:1',
    }),
    vendor,
  );
  await handleCustomerOrderInbound(
    ctx(CUSTOMER, {
      interactiveType: 'button_reply',
      interactiveId: 'VENDOR_PICKUP_TIME',
      buttonPayload: 'VENDOR_PICKUP_TIME',
    }),
    vendor,
  );
  await handleCustomerOrderInbound(
    ctx(CUSTOMER, {
      interactiveType: 'button_reply',
      interactiveId: 'VENDOR_PDATE:2026-09-26',
      buttonPayload: 'VENDOR_PDATE:2026-09-26',
    }),
    vendor,
  );
  await handleCustomerOrderInbound(
    ctx(CUSTOMER, {
      interactiveType: 'list_reply',
      interactiveId: 'VENDOR_PTIME:5:30 PM',
    }),
    vendor,
  );
  await handleCustomerOrderInbound(
    ctx(CUSTOMER, {
      interactiveType: 'button_reply',
      interactiveId: 'VENDOR_CONFIRM_ORDER',
      buttonPayload: 'VENDOR_CONFIRM_ORDER',
    }),
    vendor,
  );
  const order = getLatestCustomerOrder(vendor.id, CUSTOMER);
  assert.ok(order);
  assert.equal(order.status, 'NEW');
  assert.equal(order.vendor_notified_at, null);
  assert.match(sent.map((message) => message.message).join('\n'), /Order Received/);
  assert.doesNotMatch(sent.map((message) => message.message).join('\n'), /New Pickup Order/);
  assert.ok(getConversationState(CUSTOMER, VENDOR_ACCT));
});
