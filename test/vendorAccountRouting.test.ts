import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import {
  addGuests,
  closeDb,
  createEvent,
  getConversationState,
  getDb,
  listRsvpsForEvent,
  setConversationState,
} from '../src/db/store.js';
import { config } from '../src/config.js';
import { setCustomerMessageSender } from '../src/commands/welcome.js';
import { setCreateEventMessageSender } from '../src/commands/createEventFlow.js';
import { setRsvpMessageSender } from '../src/rsvp/handler.js';
import { setVendorMessageSender } from '../src/vendors/flow.js';
import {
  createVendor,
  getVendorByZernioWhatsAppAccountId,
  setVendorZernioWhatsAppAccountId,
} from '../src/vendors/store.js';
import { handleZernioWebhook } from '../src/webhooks/zernio.js';
import type { SendMessageParams } from '../src/zernio/client.js';

process.env.DATABASE_PATH = ':memory:';

if (!process.env.ZERNIO_WHATSAPP_ACCOUNT_ID?.trim()) {
  process.env.ZERNIO_WHATSAPP_ACCOUNT_ID = 'acct-connect-routing';
}

const CONNECT_ACCOUNT = process.env.ZERNIO_WHATSAPP_ACCOUNT_ID.trim();
const VENDOR_ACCOUNT = 'acct-vendor-line-routing';
const UNKNOWN_ACCOUNT = 'acct-unknown-whatsapp';
const PHONE = '+15559990101';

const sent: SendMessageParams[] = [];
let payloadSeq = 0;

function webhookSecret(): string {
  return process.env.WEBHOOK_SECRET || config.webhookSecret;
}

function mockRes(): Response & { statusCode: number; body: unknown } {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res as Response & { statusCode: number; body: unknown };
}

async function postInbound(options: {
  accountId: string;
  text: string;
  conversationId: string;
  phone?: string;
  interactiveId?: string;
  interactiveType?: string;
  buttonPayload?: string;
}): Promise<{ statusCode: number; body: unknown }> {
  payloadSeq += 1;
  const payload = {
    id: `vendor-routing-${payloadSeq}`,
    event: 'message.received',
    account: { id: options.accountId },
    conversation: { id: options.conversationId },
    message: {
      conversationId: options.conversationId,
      text: options.text,
      sender: { phoneNumber: options.phone ?? PHONE, name: 'Test Guest' },
    },
    metadata: {
      ...(options.interactiveType
        ? { interactiveType: options.interactiveType }
        : {}),
      ...(options.interactiveId ? { interactiveId: options.interactiveId } : {}),
      ...(options.buttonPayload ? { buttonPayload: options.buttonPayload } : {}),
    },
  };
  const rawBody = Buffer.from(JSON.stringify(payload), 'utf8');
  const secret = webhookSecret();
  const headers: Record<string, string> = {};
  if (secret) {
    headers['x-zernio-signature'] = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('hex');
  }
  const req = { body: rawBody, headers } as unknown as Request;
  const res = mockRes();
  await handleZernioWebhook(req, res);
  return { statusCode: res.statusCode, body: res.body };
}

test.beforeEach(() => {
  process.env.ZERNIO_WHATSAPP_ACCOUNT_ID = CONNECT_ACCOUNT;
  getDb();
  sent.length = 0;
  const capture = async (params: SendMessageParams) => {
    sent.push(params);
  };
  setVendorMessageSender(capture);
  setCustomerMessageSender(capture);
  setCreateEventMessageSender(capture);
  setRsvpMessageSender(capture);
});

test.afterEach(() => {
  setVendorMessageSender();
  setCustomerMessageSender();
  setCreateEventMessageSender();
  setRsvpMessageSender();
  closeDb();
});

test('CONNECT account + Hi sends CONNECT Welcome', async () => {
  const result = await postInbound({
    accountId: CONNECT_ACCOUNT,
    text: 'Hi',
    conversationId: 'conv-connect-hi',
  });

  assert.equal(result.statusCode, 200);
  assert.match(JSON.stringify(result.body), /customer|organizer/);
  const welcome = sent.find((message) =>
    message.message.includes('Welcome to CONNECT'),
  );
  assert.ok(welcome, 'expected CONNECT Welcome');
  assert.equal(welcome.accountId, CONNECT_ACCOUNT);
  assert.doesNotMatch(welcome.message, /ZipBite Provider/);
});

test('vendor account + Hi enters that vendor automation, not CONNECT Welcome', async () => {
  const vendor = createVendor({
    whatsappPhone: '+15559990199',
    businessName: 'Spice Kitchen',
    category: 'CATERING',
  });
  setVendorZernioWhatsAppAccountId(vendor.id, VENDOR_ACCOUNT);
  assert.equal(
    getVendorByZernioWhatsAppAccountId(VENDOR_ACCOUNT)?.id,
    vendor.id,
  );

  const result = await postInbound({
    accountId: VENDOR_ACCOUNT,
    text: 'Hi',
    conversationId: 'conv-vendor-hi',
  });

  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body, { ok: true, route: 'vendor_account' });
  assert.equal(sent.length, 1);
  assert.match(sent[0].message, /🛍️ Shop/);
  assert.ok(sent[0].buttons?.some((button) => button.title === '🛍️ Shop'));
  assert.doesNotMatch(sent[0].message, /📦 Orders/);
  assert.equal(sent[0].accountId, VENDOR_ACCOUNT);
  assert.equal(sent[0].conversationId, 'conv-vendor-hi');
  assert.doesNotMatch(sent[0].message, /Welcome to CONNECT/);

  const draft = JSON.parse(
    getConversationState(PHONE, VENDOR_ACCOUNT)?.vendor_draft ?? '{}',
  ) as { vendorId?: number };
  assert.equal(draft.vendorId, vendor.id);
});

test('vendor account + vendor command uses the mapped vendorId', async () => {
  const vendor = createVendor({
    whatsappPhone: '+15559990200',
    businessName: 'Roti House',
    category: 'INDIAN_BAKERY',
    status: 'ACTIVE',
  });
  setVendorZernioWhatsAppAccountId(vendor.id, VENDOR_ACCOUNT);

  const result = await postInbound({
    accountId: VENDOR_ACCOUNT,
    text: '',
    conversationId: 'conv-vendor-products',
    interactiveType: 'list_reply',
    interactiveId: 'VENDOR_MY_BUSINESS',
  });

  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body, { ok: true, route: 'vendor_account' });
  assert.match(sent.at(-1)?.message ?? '', /🛍️ Shop/);
  const draft = JSON.parse(
    getConversationState(PHONE, VENDOR_ACCOUNT)?.vendor_draft ?? '{}',
  ) as { vendorId?: number };
  assert.equal(draft.vendorId, vendor.id);
});

test('unknown WhatsApp account returns 200 without CONNECT Welcome or RSVP', async () => {
  process.env.ZERNIO_WHATSAPP_ACCOUNT_ID = CONNECT_ACCOUNT;
  const event = createEvent('Garden Party', 'July 4', 'Park', '+15559990300');
  addGuests(event.id, [PHONE]);

  const result = await postInbound({
    accountId: UNKNOWN_ACCOUNT,
    text: 'YES',
    conversationId: 'conv-unknown',
  });

  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body, {
    ok: true,
    skipped: 'unknown_whatsapp_account',
  });
  assert.equal(sent.length, 0);
  assert.doesNotMatch(
    sent.map((message) => message.message).join('\n'),
    /Welcome to CONNECT/,
  );
  assert.deepEqual(
    listRsvpsForEvent(event.id).map((rsvp) => rsvp.status),
    ['pending'],
  );
  assert.equal(getConversationState(PHONE), undefined);
  assert.equal(getConversationState(PHONE, UNKNOWN_ACCOUNT), undefined);
});

test('same phone keeps separate CONNECT and vendor conversation states', async () => {
  const vendor = createVendor({
    whatsappPhone: '+15559990400',
    businessName: 'State Bakery',
    category: 'INDIAN_BAKERY',
  });
  setVendorZernioWhatsAppAccountId(vendor.id, VENDOR_ACCOUNT);

  setConversationState(PHONE, 'WAITING_FOR_EVENT_NAME', { name: 'Connect Draft' });
  setConversationState(
    PHONE,
    'VENDOR_MENU',
    { vendor_draft: JSON.stringify({ vendorId: vendor.id }) },
    VENDOR_ACCOUNT,
  );

  assert.equal(getConversationState(PHONE)?.state, 'WAITING_FOR_EVENT_NAME');
  assert.equal(getConversationState(PHONE)?.name, 'Connect Draft');
  assert.equal(getConversationState(PHONE, CONNECT_ACCOUNT)?.state, 'WAITING_FOR_EVENT_NAME');
  assert.equal(getConversationState(PHONE, VENDOR_ACCOUNT)?.state, 'VENDOR_MENU');
  assert.notEqual(
    getConversationState(PHONE, CONNECT_ACCOUNT)?.state,
    getConversationState(PHONE, VENDOR_ACCOUNT)?.state,
  );
});

test('vendor replies use the vendor accountId, not CONNECT', async () => {
  const vendor = createVendor({
    whatsappPhone: '+15559990500',
    businessName: 'Outbound Catering',
    category: 'CATERING',
  });
  setVendorZernioWhatsAppAccountId(vendor.id, VENDOR_ACCOUNT);

  await postInbound({
    accountId: VENDOR_ACCOUNT,
    text: 'Hi',
    conversationId: 'conv-vendor-outbound',
  });

  assert.ok(sent.length > 0);
  for (const message of sent) {
    assert.equal(message.accountId, VENDOR_ACCOUNT);
    assert.notEqual(message.accountId, CONNECT_ACCOUNT);
    assert.equal(message.conversationId, 'conv-vendor-outbound');
  }
});
