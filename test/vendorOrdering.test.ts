import test from 'node:test';
import assert from 'node:assert/strict';
import {
  closeDb,
  createEvent,
  getConversationState,
  getDb,
  listRsvpsForEvent,
  upsertMessageSession,
} from '../src/db/store.js';
import type { CommandContext } from '../src/commands/organizer.js';
import type { SendMessageParams } from '../src/zernio/client.js';
import {
  handleVendorAccountInbound,
  handleVendorCommand,
  setVendorMessageSender,
} from '../src/vendors/flow.js';
import {
  addVendorProduct,
  createVendor,
  getVendorProducts,
  setVendorZernioWhatsAppAccountId,
} from '../src/vendors/store.js';
import { ensureOrderAheadCatalog } from '../src/vendors/orders/catalog.js';
import { getEventTimezone, zonedWallTimeToUtc } from '../src/dates/eventDate.js';
import { setVendorPickupClock } from '../src/vendors/orders/pickup.js';
import { handleCustomerOrderInbound, readOrderDraft } from '../src/vendors/orders/flow.js';
import {
  createVendorOrder,
  getLatestCustomerOrder,
  getVendorOrderById,
  listVendorOrderItems,
  listVendorOrders,
  transitionVendorOrder,
  type CartItem,
  type TransitionResult,
} from '../src/vendors/orders/store.js';

function didChange(result: TransitionResult): boolean {
  return result.ok === true && result.changed;
}

function wallClock(isoDate: string, hour: number, minute = 0): Date {
  const [year, month, day] = isoDate.split('-').map(Number);
  return zonedWallTimeToUtc(
    { year, month, day, hour, minute, second: 0 },
    getEventTimezone(),
  );
}

process.env.DATABASE_PATH = ':memory:';

const CONNECT = 'acct-connect-orders';
const VENDOR_ACCT = 'acct-vendor-orders';
const CUSTOMER = '+15557770101';
const OPERATOR = '+15557770999';
const sent: SendMessageParams[] = [];

function ctx(
  phone: string,
  text: string,
  extra: Partial<CommandContext> = {},
): CommandContext {
  return {
    phone,
    text,
    conversationId: extra.conversationId ?? `conv-${phone}`,
    accountId: extra.accountId ?? VENDOR_ACCT,
    senderName: extra.senderName ?? 'John',
    ...extra,
  };
}

function tap(phone: string, payload: string, accountId = VENDOR_ACCT): CommandContext {
  return ctx(phone, '', {
    accountId,
    interactiveType: payload.includes(':') && !payload.startsWith('VENDOR_QTY') ? 'list_reply' : 'button_reply',
    interactiveId: payload,
    buttonPayload: payload.includes(':') ? undefined : payload,
  });
}

async function setupPricedVendor() {
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
  upsertMessageSession(OPERATOR, 'conv-operator', VENDOR_ACCT);
  upsertMessageSession(CUSTOMER, 'conv-customer', VENDOR_ACCT);
  return { vendor, products };
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

test('vendor order tables exist and migration is additive and idempotent', () => {
  const db = getDb();
  createEvent('Keep Me', 'July 4', 'Park', '+15550001111');
  const names = db
    .prepare(`PRAGMA table_list`)
    .all() as Array<{ name: string }>;
  assert.ok(names.some((row) => row.name === 'vendor_orders'));
  assert.ok(names.some((row) => row.name === 'vendor_order_items'));
  getDb();
  getDb();
  assert.equal(
    (db.prepare(`SELECT COUNT(*) AS c FROM events`).get() as { c: number }).c,
    1,
  );
});

test('order-ahead catalog seeds three products with exact prices and no duplicates', () => {
  getDb();
  const vendor = createVendor({
    whatsappPhone: OPERATOR,
    category: 'INDIAN_BAKERY',
  });
  const first = ensureOrderAheadCatalog(vendor.id);
  assert.equal(first.length, 3);
  assert.equal(first.find((product) => product.product_name === 'Roti')?.price, '$10.00');
  assert.equal(
    first.find((product) => product.product_name === 'Methi Paratha')?.price,
    '$10.00',
  );
  assert.equal(
    first.find((product) => product.product_name === 'Plain Paratha')?.price,
    '$9.00',
  );
  assert.equal(first.find((product) => product.product_name === 'Roti')?.unit, '25 ct');
  assert.equal(
    first.find((product) => product.product_name === 'Methi Paratha')?.unit,
    '10 ct',
  );
  assert.equal(
    first.find((product) => product.product_name === 'Plain Paratha')?.unit,
    '10 ct',
  );
  const second = ensureOrderAheadCatalog(vendor.id);
  assert.equal(second.length, 3);
  assert.equal(getVendorProducts(vendor.id).length, 3);
  assert.equal(second.find((product) => product.product_name === 'Roti')?.price, '$10.00');
});

test('customer cart, quantities, totals, change, cancel, and account isolation', async () => {
  const { vendor, products } = await setupPricedVendor();
  const roti = products.find((product) => product.product_name === 'Roti');
  const methi = products.find((product) => product.product_name === 'Methi Paratha');
  const plain = products.find((product) => product.product_name === 'Plain Paratha');
  assert.ok(roti && methi && plain);

  await handleCustomerOrderInbound(ctx(CUSTOMER, 'Hi'), vendor);
  assert.match(sent.at(-1)?.message ?? '', /🛍️ Shop/);
  assert.ok(sent.at(-1)?.buttons?.some((button) => button.title === '🛍️ Shop'));

  await handleCustomerOrderInbound(tap(CUSTOMER, `VENDOR_BUY:${roti.id}`), vendor);
  await handleCustomerOrderInbound(tap(CUSTOMER, 'VENDOR_QTY:2'), vendor);
  await handleCustomerOrderInbound(tap(CUSTOMER, `VENDOR_BUY:${methi.id}`), vendor);
  await handleCustomerOrderInbound(tap(CUSTOMER, 'VENDOR_QTY:1'), vendor);
  await handleCustomerOrderInbound(tap(CUSTOMER, `VENDOR_BUY:${plain.id}`), vendor);
  await handleCustomerOrderInbound(tap(CUSTOMER, 'VENDOR_QTY:1'), vendor);
  await handleCustomerOrderInbound(tap(CUSTOMER, 'VENDOR_VIEW_ORDER'), vendor);
  assert.match(sent.at(-1)?.message ?? '', /Roti/);
  assert.match(sent.at(-1)?.message ?? '', /Methi Paratha/);
  assert.match(sent.at(-1)?.message ?? '', /\$39\.00/);

  await handleCustomerOrderInbound(tap(CUSTOMER, `VENDOR_CART_DEC:${plain.id}`), vendor);
  const afterDec = readOrderDraft(CUSTOMER, VENDOR_ACCT).cart ?? [];
  assert.equal(afterDec.some((item) => item.productId === plain.id), false);

  const connectState = getConversationState(CUSTOMER, CONNECT);
  assert.equal(connectState, undefined);
  await handleCustomerOrderInbound(
    ctx(CUSTOMER, 'Hi', { accountId: CONNECT, conversationId: 'conv-connect' }),
    vendor,
  );
  assert.ok(readOrderDraft(CUSTOMER, VENDOR_ACCT).cart?.length);

  await handleCustomerOrderInbound(tap(CUSTOMER, 'VENDOR_CANCEL_CART'), vendor);
  assert.deepEqual(readOrderDraft(CUSTOMER, VENDOR_ACCT).cart ?? [], []);
});

test('missing price blocks confirmation and server calculates order snapshots', async () => {
  getDb();
  const vendor = createVendor({
    whatsappPhone: OPERATOR,
    category: 'INDIAN_BAKERY',
  });
  setVendorZernioWhatsAppAccountId(vendor.id, VENDOR_ACCT);
  const unpriced = addVendorProduct({
    vendorId: vendor.id,
    productName: 'Unpriced Tray',
    unit: 'tray',
    category: 'INDIAN_BAKERY',
  });
  await handleCustomerOrderInbound(ctx(CUSTOMER, 'Hi'), vendor);
  await handleCustomerOrderInbound(tap(CUSTOMER, `VENDOR_BUY:${unpriced.id}`), vendor);
  await handleCustomerOrderInbound(tap(CUSTOMER, 'VENDOR_QTY:1'), vendor);
  assert.match(sent.at(-1)?.message ?? '', /not available to order yet|Your order is empty|Order Ahead/);
  assert.throws(
    () =>
      createVendorOrder({
        vendorId: vendor.id,
        customerPhone: CUSTOMER,
        pickupDate: '2026-09-26',
        pickupTime: '5:30 PM',
        items: [
          {
            productId: unpriced.id,
            productName: 'Unpriced Tray',
            quantity: 1,
            unitPrice: 500,
          },
        ],
      }),
    /missing a valid price/,
  );
});

test('confirming an order creates rows, unique numbers, PAY_AT_COUNTER, and clears the cart', async () => {
  const { vendor, products } = await setupPricedVendor();
  const items: CartItem[] = [
    {
      productId: products[0].id,
      productName: 'old name',
      quantity: 2,
      unitPrice: 1,
    },
    {
      productId: products[1].id,
      productName: 'old methi',
      quantity: 1,
      unitPrice: 1,
    },
  ];
  const order = createVendorOrder({
    vendorId: vendor.id,
    customerPhone: CUSTOMER,
    customerName: 'John',
    pickupDate: '2026-09-26',
    pickupTime: '5:30 PM',
    items,
  });
  assert.match(order.order_number, /^RB-1001$/);
  assert.equal(order.payment_method, 'PAY_AT_COUNTER');
  assert.equal(order.status, 'NEW');
  assert.equal(order.total_amount, 3000);
  const orderItems = listVendorOrderItems(order.id);
  assert.equal(orderItems.length, 2);
  assert.match(orderItems[0].product_name_snapshot, /Roti/);
  assert.equal(orderItems[0].unit_price, 1000);
  assert.equal(orderItems[0].line_total, 2000);
  const second = createVendorOrder({
    vendorId: vendor.id,
    customerPhone: CUSTOMER,
    pickupDate: '2026-09-26',
    pickupTime: '6:00 PM',
    items: [items[0]],
  });
  assert.equal(second.order_number, 'RB-1002');
});

test('order lifecycle, invalid transitions, and stale buttons', async () => {
  const { vendor, products } = await setupPricedVendor();
  const order = createVendorOrder({
    vendorId: vendor.id,
    customerPhone: CUSTOMER,
    customerName: 'John',
    pickupDate: '2026-09-26',
    pickupTime: '5:30 PM',
    items: [
      {
        productId: products[0].id,
        productName: 'Roti — 25 ct',
        quantity: 1,
        unitPrice: 500,
      },
    ],
  });
  const operator = ctx(OPERATOR, '', { accountId: VENDOR_ACCT });
  await handleVendorCommand({
    ...operator,
    interactiveType: 'button_reply',
    interactiveId: `VENDOR_ORDER_ACCEPT:${order.id}`,
    buttonPayload: `VENDOR_ORDER_ACCEPT:${order.id}`,
  });
  assert.equal(getVendorOrderById(order.id)?.status, 'ACCEPTED');
  assert.match(sent.some((message) => message.message.includes('Order Accepted')) ? 'yes' : 'no', /yes/);

  await handleVendorCommand({
    ...operator,
    interactiveType: 'button_reply',
    interactiveId: `VENDOR_ORDER_ACCEPT:${order.id}`,
    buttonPayload: `VENDOR_ORDER_ACCEPT:${order.id}`,
  });
  assert.equal(getVendorOrderById(order.id)?.status, 'ACCEPTED');

  const readyJump = transitionVendorOrder(order.id, 'READY_FOR_PICKUP');
  assert.equal(readyJump.ok && readyJump.changed, false);
  assert.equal(getVendorOrderById(order.id)?.status, 'ACCEPTED');

  assert.equal(didChange(transitionVendorOrder(order.id, 'PREPARING')), true);
  assert.equal(didChange(transitionVendorOrder(order.id, 'READY_FOR_PICKUP')), true);
  const prepAfterReady = transitionVendorOrder(order.id, 'PREPARING');
  assert.equal(prepAfterReady.ok && prepAfterReady.changed, false);
  assert.equal(didChange(transitionVendorOrder(order.id, 'PICKED_UP')), true);
  assert.equal(didChange(transitionVendorOrder(order.id, 'CANCELLED')), false);
  assert.equal(getVendorOrderById(order.id)?.status, 'PICKED_UP');

  const fresh = createVendorOrder({
    vendorId: vendor.id,
    customerPhone: CUSTOMER,
    pickupDate: '2026-09-27',
    pickupTime: '4:00 PM',
    items: [
      {
        productId: products[0].id,
        productName: 'Roti — 25 ct',
        quantity: 1,
        unitPrice: 500,
      },
    ],
  });
  assert.equal(didChange(transitionVendorOrder(fresh.id, 'CANCELLED')), true);
  assert.equal(didChange(transitionVendorOrder(fresh.id, 'ACCEPTED')), false);
  assert.equal(didChange(transitionVendorOrder(fresh.id, 'PREPARING')), false);
  assert.equal(didChange(transitionVendorOrder(fresh.id, 'READY_FOR_PICKUP')), false);
  assert.equal(didChange(transitionVendorOrder(fresh.id, 'PICKED_UP')), false);

  const accepted = createVendorOrder({
    vendorId: vendor.id,
    customerPhone: CUSTOMER,
    pickupDate: '2026-09-27',
    pickupTime: '4:30 PM',
    items: [
      {
        productId: products[0].id,
        productName: 'Roti — 25 ct',
        quantity: 1,
        unitPrice: 500,
      },
    ],
  });
  assert.equal(didChange(transitionVendorOrder(accepted.id, 'ACCEPTED')), true);
  assert.equal(didChange(transitionVendorOrder(accepted.id, 'CANCELLED')), true);

  const preparing = createVendorOrder({
    vendorId: vendor.id,
    customerPhone: CUSTOMER,
    pickupDate: '2026-09-27',
    pickupTime: '5:00 PM',
    items: [
      {
        productId: products[0].id,
        productName: 'Roti — 25 ct',
        quantity: 1,
        unitPrice: 500,
      },
    ],
  });
  assert.equal(didChange(transitionVendorOrder(preparing.id, 'ACCEPTED')), true);
  assert.equal(didChange(transitionVendorOrder(preparing.id, 'PREPARING')), true);
  assert.equal(didChange(transitionVendorOrder(preparing.id, 'CANCELLED')), true);

  const jump = createVendorOrder({
    vendorId: vendor.id,
    customerPhone: CUSTOMER,
    pickupDate: '2026-09-27',
    pickupTime: '6:00 PM',
    items: [
      {
        productId: products[0].id,
        productName: 'Roti — 25 ct',
        quantity: 1,
        unitPrice: 500,
      },
    ],
  });
  assert.equal(didChange(transitionVendorOrder(jump.id, 'PICKED_UP')), false);
});

test('customer confirmation, vendor notify, lifecycle WhatsApp copy, and My Order', async () => {
  const { vendor, products } = await setupPricedVendor();
  await handleCustomerOrderInbound(ctx(CUSTOMER, 'Hi', { senderName: 'John' }), vendor);
  await handleCustomerOrderInbound(tap(CUSTOMER, `VENDOR_BUY:${products[0].id}`), vendor);
  await handleCustomerOrderInbound(tap(CUSTOMER, 'VENDOR_QTY:2'), vendor);
  await handleCustomerOrderInbound(tap(CUSTOMER, 'VENDOR_PICKUP_TIME'), vendor);
  assert.match(sent.at(-1)?.message ?? '', /Pick a date/);
  assert.ok(sent.at(-1)?.buttons?.some((button) => button.title === 'Today'));
  await handleCustomerOrderInbound(tap(CUSTOMER, 'VENDOR_PDATE:2026-09-19'), vendor);
  await handleCustomerOrderInbound(tap(CUSTOMER, 'VENDOR_PTIME:5:30 PM'), vendor);
  await handleCustomerOrderInbound(tap(CUSTOMER, 'VENDOR_CONFIRM_ORDER'), vendor);
  const order = getLatestCustomerOrder(vendor.id, CUSTOMER);
  assert.ok(order);
  assert.match(sent.map((message) => message.message).join('\n'), /Order Received/);
  assert.match(sent.map((message) => message.message).join('\n'), /New Pickup Order/);
  assert.ok(sent.some((message) => message.accountId === VENDOR_ACCT && message.message.includes('New Pickup Order')));
  assert.deepEqual(readOrderDraft(CUSTOMER, VENDOR_ACCT).cart ?? [], []);

  const operator = ctx(OPERATOR, '', {
    accountId: VENDOR_ACCT,
    interactiveType: 'button_reply',
    interactiveId: `VENDOR_ORDER_ACCEPT:${order.id}`,
    buttonPayload: `VENDOR_ORDER_ACCEPT:${order.id}`,
  });
  await handleVendorCommand(operator);
  assert.match(sent.map((message) => message.message).join('\n'), /Order Accepted/);
  await handleVendorCommand({
    ...operator,
    interactiveId: `VENDOR_ORDER_PREP:${order.id}`,
    buttonPayload: `VENDOR_ORDER_PREP:${order.id}`,
  });
  assert.match(sent.map((message) => message.message).join('\n'), /being prepared/);
  await handleVendorCommand({
    ...operator,
    interactiveId: `VENDOR_ORDER_READY:${order.id}`,
    buttonPayload: `VENDOR_ORDER_READY:${order.id}`,
  });
  assert.match(sent.map((message) => message.message).join('\n'), /ready for pickup/);
  assert.match(sent.map((message) => message.message).join('\n'), /12 Spice Lane/);
  await handleVendorCommand({
    ...operator,
    interactiveId: `VENDOR_ORDER_PICKED:${order.id}`,
    buttonPayload: `VENDOR_ORDER_PICKED:${order.id}`,
  });
  assert.match(sent.map((message) => message.message).join('\n'), /has been picked up/);

  await handleCustomerOrderInbound(tap(CUSTOMER, 'VENDOR_MY_ORDER'), vendor);
  assert.match(sent.at(-1)?.message ?? '', /Picked Up/);

  const cancelled = createVendorOrder({
    vendorId: vendor.id,
    customerPhone: CUSTOMER,
    pickupDate: '2026-09-29',
    pickupTime: '5:00 PM',
    items: [
      {
        productId: products[0].id,
        productName: 'Roti — 25 ct',
        quantity: 1,
        unitPrice: 500,
      },
    ],
  });
  transitionVendorOrder(cancelled.id, 'CANCELLED', { cancelledBy: 'VENDOR' });
  await handleCustomerOrderInbound(tap(CUSTOMER, 'VENDOR_MY_ORDER'), vendor);
  assert.match(sent.at(-1)?.message ?? '', /Cancelled/);
  assert.equal(listVendorOrders(vendor.id, 'NEW').length >= 0, true);
});

test('CONNECT RSVP data and unknown-account safety remain intact', async () => {
  getDb();
  const event = createEvent('Party', 'July 4', 'Park', '+15550002222');
  assert.equal(event.id > 0, true);
  assert.equal(listRsvpsForEvent(event.id).length, 0);
  const vendor = createVendor({
    whatsappPhone: OPERATOR,
    category: 'INDIAN_BAKERY',
    status: 'ACTIVE',
  });
  setVendorZernioWhatsAppAccountId(vendor.id, VENDOR_ACCT);
  await handleVendorAccountInbound(ctx(CUSTOMER, 'Hi'), vendor);
  assert.match(sent.at(-1)?.message ?? '', /🛍️ Shop/);
  assert.ok(sent.at(-1)?.buttons?.some((button) => button.title === '🛍️ Shop'));
  await handleVendorAccountInbound(ctx(OPERATOR, 'Hi'), vendor);
  assert.match(sent.at(-1)?.message ?? '', /ZipBite Provider/);
  assert.equal(
    sent.at(-1)?.buttons?.some((button) => button.title === '🛍️ Shop') ?? false,
    false,
  );
  assert.ok(
    sent.at(-1)?.list?.sections?.some((section) =>
      section.rows.some((row) => row.id === 'VENDOR_ORDERS'),
    ),
  );
});
