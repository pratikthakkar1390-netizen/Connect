import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { closeDb, getDb } from '../src/db/store.js';
import { getPublicBaseUrl } from '../src/config.js';
import { getEventTimezone, zonedWallTimeToUtc } from '../src/dates/eventDate.js';
import { handleCustomerOrderInbound } from '../src/vendors/orders/flow.js';
import {
  handleVendorAccountInbound,
  setVendorMessageSender,
} from '../src/vendors/flow.js';
import {
  createVendor,
  setVendorZernioWhatsAppAccountId,
} from '../src/vendors/store.js';
import { ensureOrderAheadCatalog } from '../src/vendors/orders/catalog.js';
import type { CommandContext } from '../src/commands/organizer.js';
import type { SendMessageParams } from '../src/zernio/client.js';
import { vendorPickupRouter } from '../src/http/vendorPickup.js';
import { verifyVendorPickupToken } from '../src/http/vendorPickupToken.js';
import { setVendorPickupClock } from '../src/vendors/orders/pickup.js';
import {
  getLatestCustomerOrder,
  listVendorOrders,
} from '../src/vendors/orders/store.js';

process.env.DATABASE_PATH = ':memory:';

const VENDOR_ACCT = 'acct-vendor-shop';
const CUSTOMER = '+15557773101';
const OPERATOR = '+15557773999';
const sent: SendMessageParams[] = [];

function wallClock(isoDate: string, hour: number, minute = 0): Date {
  const [year, month, day] = isoDate.split('-').map(Number);
  return zonedWallTimeToUtc(
    { year, month, day, hour, minute, second: 0 },
    getEventTimezone(),
  );
}

test.beforeEach(() => {
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
    ...extra,
  };
}

function tap(phone: string, payload: string): CommandContext {
  return ctx(phone, '', {
    interactiveType: 'button_reply',
    interactiveId: payload,
    buttonPayload: payload,
  });
}

function setupVendor() {
  getDb();
  const vendor = createVendor({
    whatsappPhone: OPERATOR,
    businessName: 'Roti House',
    category: 'INDIAN_BAKERY',
    status: 'ACTIVE',
  });
  setVendorZernioWhatsAppAccountId(vendor.id, VENDOR_ACCT);
  ensureOrderAheadCatalog(vendor.id);
  return vendor;
}

function pickupUrlFromMessages(): string {
  const match = sent
    .map((message) => message.message)
    .join('\n')
    .match(/https?:\/\/[^\s]+\/pickup\/[^\s]+/);
  assert.ok(match, 'expected a signed pickup URL');
  return match[0];
}

function withPickupServer(fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(vendorPickupRouter);
  const server = http.createServer(app);
  return new Promise((resolve, reject) => {
    server.listen(0, async () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      const baseUrl = `http://127.0.0.1:${port}`;
      try {
        await fn(baseUrl);
        server.close((err) => (err ? reject(err) : resolve()));
      } catch (error) {
        server.close(() => reject(error));
      }
    });
  });
}

test('customer on vendor account sees Shop', async () => {
  const vendor = setupVendor();
  await handleVendorAccountInbound(ctx(CUSTOMER, 'Hi'), vendor);
  const last = sent.at(-1);
  assert.match(last?.message ?? '', /🛍️ Shop/);
  assert.ok(last?.buttons?.some((button) => button.title === '🛍️ Shop'));
  assert.equal(last?.list?.sections?.some((section) =>
    section.rows.some((row) => row.id === 'VENDOR_ORDERS'),
  ) ?? false, false);
});

test('operator on vendor account does not get customer Shop flow', async () => {
  const vendor = setupVendor();
  await handleVendorAccountInbound(ctx(OPERATOR, 'Hi'), vendor);
  const last = sent.at(-1);
  assert.match(last?.message ?? '', /CONNECT Vendor/);
  assert.equal(
    last?.buttons?.some((button) => button.title === '🛍️ Shop') ?? false,
    false,
  );
  assert.doesNotMatch(last?.message ?? '', /\/pickup\//);
  assert.ok(
    last?.list?.sections?.some((section) =>
      section.rows.some((row) => row.id === 'VENDOR_ORDERS'),
    ),
  );
});

test('Shop generates a valid signed pickup token and does not create an order', async () => {
  const vendor = setupVendor();
  await handleVendorAccountInbound(ctx(CUSTOMER, 'Hi'), vendor);
  sent.length = 0;
  await handleCustomerOrderInbound(tap(CUSTOMER, 'VENDOR_SHOP'), vendor);
  const url = pickupUrlFromMessages();
  assert.match(url, /^https:\/\/connect\.zip-bite\.com\/pickup\//);
  assert.equal(url.startsWith(`${getPublicBaseUrl()}/pickup/`), true);
  const token = decodeURIComponent(url.slice(url.lastIndexOf('/') + 1));
  const payload = verifyVendorPickupToken(token);
  assert.ok(payload);
  assert.equal(payload.vendorId, vendor.id);
  assert.equal(payload.phone, CUSTOMER);
  assert.equal(payload.accountId, VENDOR_ACCT);
  assert.equal(listVendorOrders(vendor.id).length, 0);
  assert.match(sent.map((message) => message.message).join('\n'), /Order Ahead/);
});

test('opening pickup link does not create an order; Confirm Order creates exactly one', async () => {
  const vendor = setupVendor();
  const products = ensureOrderAheadCatalog(vendor.id);
  await handleVendorAccountInbound(ctx(CUSTOMER, 'Hi'), vendor);
  await handleCustomerOrderInbound(tap(CUSTOMER, 'VENDOR_SHOP'), vendor);
  const url = pickupUrlFromMessages();
  const token = decodeURIComponent(url.slice(url.lastIndexOf('/') + 1));
  assert.equal(listVendorOrders(vendor.id).length, 0);

  await withPickupServer(async (baseUrl) => {
    const getRes = await fetch(`${baseUrl}/pickup/${encodeURIComponent(token)}`);
    assert.equal(getRes.status, 200);
    const html = await getRes.text();
    assert.match(html, /Pickup date/);
    const dateRes = await fetch(`${baseUrl}/pickup/${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ step: 'date', date: '2026-09-22' }).toString(),
    });
    assert.equal(dateRes.status, 200);
    assert.match(await dateRes.text(), /Pickup time/);
    const timeRes = await fetch(`${baseUrl}/pickup/${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        step: 'time',
        date: '2026-09-22',
        hour: '5',
        minute: '37',
        meridiem: 'PM',
      }).toString(),
    });
    assert.equal(timeRes.status, 200);
  });
  assert.equal(listVendorOrders(vendor.id).length, 0);

  await handleCustomerOrderInbound(
    tap(CUSTOMER, `VENDOR_BUY:${products[0].id}`),
    vendor,
  );
  await handleCustomerOrderInbound(tap(CUSTOMER, 'VENDOR_QTY:1'), vendor);
  await handleCustomerOrderInbound(tap(CUSTOMER, 'VENDOR_CONFIRM_ORDER'), vendor);
  assert.equal(listVendorOrders(vendor.id).length, 1);
  const order = getLatestCustomerOrder(vendor.id, CUSTOMER);
  assert.ok(order);
  assert.equal(order.pickup_date, '2026-09-22');
  assert.equal(order.pickup_time, '5:37 PM');
  assert.equal(order.payment_method, 'PAY_AT_COUNTER');
});
