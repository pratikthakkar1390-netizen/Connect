import test from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, getDb } from '../src/db/store.js';
import { getEventTimezone, zonedWallTimeToUtc } from '../src/dates/eventDate.js';
import { handleCustomerOrderInbound } from '../src/vendors/orders/flow.js';
import { setVendorMessageSender } from '../src/vendors/flow.js';
import {
  createVendor,
  setVendorZernioWhatsAppAccountId,
} from '../src/vendors/store.js';
import { ensureOrderAheadCatalog } from '../src/vendors/orders/catalog.js';
import type { CommandContext } from '../src/commands/organizer.js';
import type { SendMessageParams } from '../src/zernio/client.js';
import {
  isPickupClosedDay,
  isSameDayPickupOpen,
  minSelectablePickupDate,
  setVendorPickupClock,
  validateVendorPickup,
  validateVendorPickupDate,
} from '../src/vendors/orders/pickup.js';
import { createVendorOrder, type CartItem } from '../src/vendors/orders/store.js';
import {
  renderVendorPickupDatePage,
  renderVendorPickupTimePage,
} from '../src/http/vendorPickupPage.js';

process.env.DATABASE_PATH = ':memory:';

const TODAY = '2026-09-19';
const SUNDAY = '2026-09-20';
const MONDAY = '2026-09-21';
const TUESDAY = '2026-09-22';
const FUTURE_SUNDAY = '2026-09-27';
const FUTURE_MONDAY = '2026-09-28';
const FUTURE_TUESDAY = '2026-09-29';
const sent: SendMessageParams[] = [];

function wallClock(isoDate: string, hour: number, minute = 0): Date {
  const [year, month, day] = isoDate.split('-').map(Number);
  return zonedWallTimeToUtc(
    { year, month, day, hour, minute, second: 0 },
    getEventTimezone(),
  );
}

function at(hour: number, minute = 0): Date {
  return wallClock(TODAY, hour, minute);
}

function reason(
  date: string,
  time: string,
  now: Date,
): string | undefined {
  const result = validateVendorPickup(date, time, now);
  return result.ok ? undefined : result.reason;
}

test.beforeEach(() => {
  sent.length = 0;
  setVendorPickupClock(() => at(10, 0));
  setVendorMessageSender(async (params) => {
    sent.push(params);
  });
});

test.afterEach(() => {
  setVendorPickupClock();
  setVendorMessageSender();
  closeDb();
});

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

function setupVendor() {
  getDb();
  const vendor = createVendor({
    whatsappPhone: '+15557770999',
    category: 'INDIAN_BAKERY',
    status: 'ACTIVE',
  });
  setVendorZernioWhatsAppAccountId(vendor.id, 'acct-vendor-pickup');
  const products = ensureOrderAheadCatalog(vendor.id);
  return { vendor, productId: products[0].id };
}

function tryCreate(
  productId: number,
  vendorId: number,
  pickupDate: string,
  pickupTime: string,
  now: Date,
) {
  return createVendorOrder({
    vendorId,
    customerPhone: '+15557770101',
    pickupDate,
    pickupTime,
    items: orderItems(productId),
    now,
  });
}

test('Tuesday pickup at 12:00 PM → allowed', () => {
  const now = at(10, 0);
  assert.equal(validateVendorPickup(TUESDAY, '12:00 PM', now).ok, true);
  const { vendor, productId } = setupVendor();
  const order = tryCreate(productId, vendor.id, TUESDAY, '12:00 PM', now);
  assert.equal(order.pickup_time, '12:00 PM');
});

test('Tuesday pickup at 12:17 PM → allowed', () => {
  const now = at(10, 0);
  assert.equal(validateVendorPickup(TUESDAY, '12:17 PM', now).ok, true);
  const { vendor, productId } = setupVendor();
  const order = tryCreate(productId, vendor.id, TUESDAY, '12:17 PM', now);
  assert.equal(order.pickup_time, '12:17 PM');
});

test('Tuesday pickup at 5:37 PM → allowed', () => {
  const now = at(10, 0);
  assert.equal(validateVendorPickup(TUESDAY, '5:37 PM', now).ok, true);
  const { vendor, productId } = setupVendor();
  assert.equal(
    tryCreate(productId, vendor.id, TUESDAY, '5:37 PM', now).pickup_time,
    '5:37 PM',
  );
});

test('Tuesday pickup at 7:55 PM → allowed', () => {
  const now = at(10, 0);
  const { vendor, productId } = setupVendor();
  assert.equal(
    tryCreate(productId, vendor.id, TUESDAY, '7:55 PM', now).pickup_time,
    '7:55 PM',
  );
});

test('Tuesday pickup at 8:00 PM → allowed', () => {
  const now = at(10, 0);
  assert.equal(validateVendorPickup(TUESDAY, '8:00 PM', now).ok, true);
  const { vendor, productId } = setupVendor();
  assert.equal(
    tryCreate(productId, vendor.id, TUESDAY, '8:00 PM', now).pickup_time,
    '8:00 PM',
  );
});

test('Tuesday pickup at 8:01 PM → rejected', () => {
  const now = at(10, 0);
  assert.equal(reason(TUESDAY, '8:01 PM', now), 'outside_hours');
  const { vendor, productId } = setupVendor();
  assert.throws(
    () => tryCreate(productId, vendor.id, TUESDAY, '8:01 PM', now),
    /12:00 PM to 8:00 PM/,
  );
});

test('Tuesday pickup at 11:59 AM → rejected', () => {
  const now = at(10, 0);
  assert.equal(reason(TUESDAY, '11:59 AM', now), 'outside_hours');
  const { vendor, productId } = setupVendor();
  assert.throws(
    () => tryCreate(productId, vendor.id, TUESDAY, '11:59 AM', now),
    /12:00 PM to 8:00 PM/,
  );
});

test('Monday pickup at 12:00 PM → rejected', () => {
  const now = at(10, 0);
  assert.equal(isPickupClosedDay(MONDAY), true);
  assert.equal(validateVendorPickupDate(MONDAY, now).ok, false);
  assert.equal(reason(MONDAY, '12:00 PM', now), 'closed_monday');
  const { vendor, productId } = setupVendor();
  assert.throws(
    () => tryCreate(productId, vendor.id, MONDAY, '12:00 PM', now),
    /not available on Monday/,
  );
});

test('Monday pickup at 8:00 PM → rejected', () => {
  const now = at(10, 0);
  assert.equal(reason(MONDAY, '8:00 PM', now), 'closed_monday');
  const { vendor, productId } = setupVendor();
  assert.throws(
    () => tryCreate(productId, vendor.id, MONDAY, '8:00 PM', now),
    /not available on Monday/,
  );
});

test('Same-day order at 10:00 AM for 5:37 PM → allowed', () => {
  const now = at(10, 0);
  setVendorPickupClock(() => now);
  assert.equal(isSameDayPickupOpen(now), true);
  assert.equal(minSelectablePickupDate(now), TODAY);
  assert.equal(validateVendorPickup(TODAY, '5:37 PM', now).ok, true);
  const { vendor, productId } = setupVendor();
  const order = tryCreate(productId, vendor.id, TODAY, '5:37 PM', now);
  assert.equal(order.pickup_date, TODAY);
  assert.equal(order.pickup_time, '5:37 PM');
});

test('Same-day order at 11:59 AM → allowed if pickup is 12–8 PM', () => {
  const now = at(11, 59);
  setVendorPickupClock(() => now);
  assert.equal(isSameDayPickupOpen(now), true);
  assert.equal(validateVendorPickup(TODAY, '12:00 PM', now).ok, true);
  assert.equal(validateVendorPickup(TODAY, '8:00 PM', now).ok, true);
  const { vendor, productId } = setupVendor();
  const order = tryCreate(productId, vendor.id, TODAY, '12:17 PM', now);
  assert.equal(order.pickup_date, TODAY);
});

test('Same-day order at 12:00 PM → rejected', () => {
  const now = at(12, 0);
  setVendorPickupClock(() => now);
  assert.equal(isSameDayPickupOpen(now), false);
  assert.equal(minSelectablePickupDate(now), SUNDAY);
  assert.equal(validateVendorPickupDate(TODAY, now).ok, false);
  assert.equal(reason(TODAY, '5:37 PM', now), 'same_day_closed');
  const { vendor, productId } = setupVendor();
  assert.throws(
    () => tryCreate(productId, vendor.id, TODAY, '5:37 PM', now),
    /Same-day pickup is only available before 12:00 PM/,
  );
});

test('Same-day order after 12:00 PM → rejected', () => {
  const now = at(17, 0);
  setVendorPickupClock(() => now);
  assert.equal(reason(TODAY, '5:37 PM', now), 'same_day_closed');
  assert.equal(validateVendorPickup(SUNDAY, '1:43 PM', now).ok, true);
  const { vendor, productId } = setupVendor();
  assert.throws(
    () => tryCreate(productId, vendor.id, TODAY, '7:00 PM', now),
    /Same-day pickup is only available before 12:00 PM/,
  );
  const later = tryCreate(productId, vendor.id, SUNDAY, '1:43 PM', now);
  assert.equal(later.pickup_date, SUNDAY);
});

test('Tomorrow pickup → allowed if tomorrow is not Monday', () => {
  const now = at(15, 0);
  setVendorPickupClock(() => now);
  assert.equal(isPickupClosedDay(SUNDAY), false);
  assert.equal(validateVendorPickup(SUNDAY, '12:17 PM', now).ok, true);
  const { vendor, productId } = setupVendor();
  const order = tryCreate(productId, vendor.id, SUNDAY, '12:17 PM', now);
  assert.equal(order.pickup_date, SUNDAY);
});

test('Future Tuesday → allowed', () => {
  const now = at(22, 0);
  setVendorPickupClock(() => now);
  const { vendor, productId } = setupVendor();
  const order = tryCreate(productId, vendor.id, FUTURE_TUESDAY, '3:03 PM', now);
  assert.equal(order.pickup_date, FUTURE_TUESDAY);
});

test('Future Sunday → allowed', () => {
  const now = at(10, 0);
  const { vendor, productId } = setupVendor();
  const order = tryCreate(productId, vendor.id, FUTURE_SUNDAY, '8:00 PM', now);
  assert.equal(order.pickup_date, FUTURE_SUNDAY);
});

test('Future Monday → rejected', () => {
  const now = at(10, 0);
  assert.equal(reason(FUTURE_MONDAY, '12:00 PM', now), 'closed_monday');
  const { vendor, productId } = setupVendor();
  assert.throws(
    () => tryCreate(productId, vendor.id, FUTURE_MONDAY, '5:37 PM', now),
    /not available on Monday/,
  );
});

test('Past date → rejected', () => {
  const now = at(10, 0);
  assert.equal(reason('2026-09-18', '5:37 PM', now), 'past_date');
  const { vendor, productId } = setupVendor();
  assert.throws(
    () => tryCreate(productId, vendor.id, '2026-09-18', '5:37 PM', now),
    /today or a future date/,
  );
});

test("Today's pickup time already passed → rejected", () => {
  const now = at(12, 1);
  setVendorPickupClock(() => now);
  assert.equal(validateVendorPickup(TODAY, '12:00 PM', now).ok, false);
  assert.equal(validateVendorPickup(TODAY, '5:37 PM', now).ok, false);
  const { vendor, productId } = setupVendor();
  assert.throws(
    () => tryCreate(productId, vendor.id, TODAY, '12:00 PM', now),
    /Same-day pickup is only available before 12:00 PM|already passed/,
  );
});

test('Future date with arbitrary valid time → allowed', () => {
  const now = at(18, 0);
  setVendorPickupClock(() => now);
  assert.equal(validateVendorPickup('2026-11-01', '1:43 PM', now).ok, true);
  const { vendor, productId } = setupVendor();
  const order = tryCreate(productId, vendor.id, '2026-11-01', '1:43 PM', now);
  assert.equal(order.pickup_date, '2026-11-01');
  assert.equal(order.pickup_time, '1:43 PM');
});

test('Future date with time outside 12–8 PM → rejected', () => {
  const now = at(18, 0);
  setVendorPickupClock(() => now);
  assert.equal(reason('2026-11-01', '11:59 AM', now), 'outside_hours');
  assert.equal(reason('2026-11-01', '8:01 PM', now), 'outside_hours');
  const { vendor, productId } = setupVendor();
  assert.throws(
    () => tryCreate(productId, vendor.id, '2026-11-01', '11:00 AM', now),
    /12:00 PM to 8:00 PM/,
  );
});

test('Sunday after noon skips Monday for the next selectable date', () => {
  const now = wallClock(SUNDAY, 13, 0);
  setVendorPickupClock(() => now);
  assert.equal(minSelectablePickupDate(now), TUESDAY);
  assert.equal(validateVendorPickupDate(MONDAY, now).ok, false);
  assert.equal(validateVendorPickup(TUESDAY, '12:00 PM', now).ok, true);
});

test('pickup web picker uses date then any-minute time selects, not a slot list', () => {
  const dateHtml = renderVendorPickupDatePage({ minDate: TODAY });
  assert.match(dateHtml, /type="date"/);
  assert.match(dateHtml, /name="date"/);
  const timeHtml = renderVendorPickupTimePage({ dateValue: TUESDAY });
  assert.match(timeHtml, /name="hour"/);
  assert.match(timeHtml, /name="minute"/);
  assert.match(timeHtml, /<option value="17">17<\/option>/);
  assert.match(timeHtml, /<option value="37">37<\/option>/);
  assert.match(timeHtml, /<option value="55">55<\/option>/);
  assert.doesNotMatch(timeHtml, /5:30 PM/);
  assert.doesNotMatch(timeHtml, /VENDOR_PTIME/);
});

test('WhatsApp offers Today before noon and hides it at/after noon', async () => {
  getDb();
  const vendor = createVendor({
    whatsappPhone: '+15557770888',
    category: 'INDIAN_BAKERY',
    status: 'ACTIVE',
  });
  const products = ensureOrderAheadCatalog(vendor.id);
  const base: CommandContext = {
    phone: '+15557770102',
    text: '',
    conversationId: 'conv-pickup-ui',
    accountId: 'acct-vendor-pickup-ui',
  };

  await handleCustomerOrderInbound(
    {
      ...base,
      interactiveType: 'list_reply',
      interactiveId: `VENDOR_BUY:${products[0].id}`,
    },
    vendor,
  );
  await handleCustomerOrderInbound(
    {
      ...base,
      interactiveType: 'button_reply',
      interactiveId: 'VENDOR_QTY:1',
      buttonPayload: 'VENDOR_QTY:1',
    },
    vendor,
  );

  sent.length = 0;
  setVendorPickupClock(() => at(10, 0));
  await handleCustomerOrderInbound(
    {
      ...base,
      interactiveType: 'button_reply',
      interactiveId: 'VENDOR_PICKUP_TIME',
      buttonPayload: 'VENDOR_PICKUP_TIME',
    },
    vendor,
  );
  assert.match(sent.at(-1)?.message ?? '', /\/pickup\//);
  assert.match(sent.at(-1)?.message ?? '', /12:00 PM–8:00 PM/);
  assert.doesNotMatch(sent.at(-1)?.message ?? '', /VENDOR_PTIME/);
  assert.ok(sent.at(-1)?.buttons?.some((button) => button.title === 'Today'));
  assert.equal(sent.at(-1)?.list?.sections?.length ?? 0, 0);

  sent.length = 0;
  setVendorPickupClock(() => at(12, 0));
  await handleCustomerOrderInbound(
    {
      ...base,
      interactiveType: 'button_reply',
      interactiveId: 'VENDOR_PICKUP_TIME',
      buttonPayload: 'VENDOR_PICKUP_TIME',
    },
    vendor,
  );
  assert.match(sent.at(-1)?.message ?? '', /\/pickup\//);
  assert.equal(
    sent.at(-1)?.buttons?.some((button) => button.title === 'Today') ?? false,
    false,
  );
});
