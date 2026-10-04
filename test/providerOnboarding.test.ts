import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { getDb } from '../src/db/store.js';
import type { CommandContext } from '../src/commands/organizer.js';
import { handleCustomerCommand } from '../src/commands/welcome.js';
import type { SendMessageParams } from '../src/zernio/client.js';
import {
  claimProviderOnboardingSession,
  createProviderOnboardingInvite,
  getActiveProviderOnboardingSession,
  getProviderOnboardingSessionByToken,
  PUBLIC_PROVIDER_ONBOARDING_MESSAGE,
  saveProviderOnboardingSession,
  validateProviderOnboardingToken,
} from '../src/vendors/onboarding.js';
import {
  handleVendorCommand,
  setVendorMessageSender,
  shouldHandleVendor,
} from '../src/vendors/flow.js';
import {
  createVendor,
  getVendorAvailability,
  getVendorByWhatsAppPhone,
} from '../src/vendors/store.js';
import { providerOnboardingRouter } from '../src/http/providerOnboarding.js';

process.env.DATABASE_PATH = ':memory:';

const PHONE = '+15557770001';
const OTHER_PHONE = '+15557770002';
const FLOW_PHONE = '+15557770007';
const PUBLIC_PHONE = '+15557770008';
const sent: SendMessageParams[] = [];

function ctx(
  phone: string,
  text: string,
  interactiveId?: string,
): CommandContext {
  return {
    phone,
    text,
    conversationId: `conversation-${phone}`,
    accountId: 'connect-account',
    interactiveId,
    buttonPayload: interactiveId,
    interactiveType: interactiveId ? 'button_reply' : undefined,
  };
}

async function send(phone: string, input: string, interactive = false) {
  return handleVendorCommand(ctx(phone, interactive ? '' : input, interactive ? input : undefined));
}

async function withServer(
  app: express.Express,
  run: (origin: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

function basicAuth(password: string): string {
  return `Basic ${Buffer.from(`admin:${password}`).toString('base64')}`;
}

test('provider invite stores only a hash and enforces expiry and phone ownership', () => {
  getDb();
  const invite = createProviderOnboardingInvite({ phone: PHONE });
  const stored = getDb()
    .prepare('SELECT token_hash FROM vendor_onboarding_sessions WHERE id = ?')
    .get(invite.session.id) as { token_hash: string };
  assert.notEqual(stored.token_hash, invite.token);
  assert.equal(stored.token_hash.length, 64);
  assert.equal(JSON.stringify(stored).includes(invite.token), false);
  assert.equal(claimProviderOnboardingSession({
    token: invite.token,
    phone: OTHER_PHONE,
  }), undefined);
  assert.equal(getProviderOnboardingSessionByToken(invite.token)?.claimed_at, null);

  const claimed = claimProviderOnboardingSession({
    token: invite.token,
    phone: PHONE,
  });
  assert.equal(claimed?.step, 'BUSINESS_NAME');
  assert.equal(
    saveProviderOnboardingSession({
      sessionId: claimed!.id,
      phone: OTHER_PHONE,
      step: 'OWNER_NAME',
      draft: { businessName: 'Wrong owner' },
    }),
    undefined,
  );
  const replacement = createProviderOnboardingInvite({ phone: PHONE });
  assert.equal(validateProviderOnboardingToken(invite.token), undefined);
  assert.ok(validateProviderOnboardingToken(replacement.token));

  const expired = createProviderOnboardingInvite({
    phone: '+15557770003',
    nowMs: Date.now() - 10_000,
    ttlMs: 1_000,
  });
  assert.equal(validateProviderOnboardingToken(expired.token), undefined);
  assert.equal(claimProviderOnboardingSession({
    token: expired.token,
    phone: '+15557770003',
  }), undefined);
});

test('public provider entry redirects only valid links to configured WhatsApp', async () => {
  const invite = createProviderOnboardingInvite({ phone: '+15557770004' });
  const previous = process.env.WHATSAPP_BUSINESS_PHONE;
  process.env.WHATSAPP_BUSINESS_PHONE = '+15550001111';
  const app = express();
  app.use(providerOnboardingRouter);
  await withServer(app, async (origin) => {
    const valid = await fetch(`${origin}/provider/onboard/${invite.token}`, {
      redirect: 'manual',
    });
    assert.equal(valid.status, 302);
    const location = valid.headers.get('location') ?? '';
    assert.match(location, /^https:\/\/wa\.me\/15550001111\?/);
    assert.match(decodeURIComponent(location), /ZIPBITE PROVIDER/);

    const invalid = await fetch(`${origin}/provider/onboard/not-a-token`, {
      redirect: 'manual',
    });
    assert.equal(invalid.status, 404);

    process.env.WHATSAPP_BUSINESS_PHONE = '';
    const unavailable = await fetch(
      `${origin}/provider/onboard/${invite.token}`,
      { redirect: 'manual' },
    );
    assert.equal(unavailable.status, 503);
  });
  process.env.WHATSAPP_BUSINESS_PHONE = previous;
});

test('/provider/start redirects to CONNECT WhatsApp without creating a session', async () => {
  const previous = process.env.WHATSAPP_BUSINESS_PHONE;
  process.env.WHATSAPP_BUSINESS_PHONE = '+15550001111';
  const app = express();
  app.use(providerOnboardingRouter);
  const before = (
    getDb()
      .prepare('SELECT COUNT(*) AS count FROM vendor_onboarding_sessions')
      .get() as { count: number }
  ).count;

  await withServer(app, async (origin) => {
    const response = await fetch(`${origin}/provider/start`, {
      redirect: 'manual',
    });
    assert.equal(response.status, 302);
    const location = response.headers.get('location') ?? '';
    assert.equal(
      decodeURIComponent(location),
      `https://wa.me/15550001111?text=${PUBLIC_PROVIDER_ONBOARDING_MESSAGE}`,
    );
    assert.doesNotMatch(location, /providerId|phone|token/i);

    process.env.WHATSAPP_BUSINESS_PHONE = '';
    const fallback = await fetch(`${origin}/provider/start`);
    assert.equal(fallback.status, 503);
    const html = await fallback.text();
    assert.match(html, /Become a ZipBite Provider/);
    assert.match(html, /Start your setup on WhatsApp/);
    assert.match(html, />Start on WhatsApp</);
  });

  const after = (
    getDb()
      .prepare('SELECT COUNT(*) AS count FROM vendor_onboarding_sessions')
      .get() as { count: number }
  ).count;
  assert.equal(after, before);
  process.env.WHATSAPP_BUSINESS_PHONE = previous;
});

test('public WhatsApp intent creates and resumes a sender-bound session', async () => {
  sent.length = 0;
  setVendorMessageSender(async (params) => {
    sent.push(params);
  });
  assert.equal(
    shouldHandleVendor(PUBLIC_PHONE, PUBLIC_PROVIDER_ONBOARDING_MESSAGE),
    true,
  );
  assert.equal(
    await send(PUBLIC_PHONE, PUBLIC_PROVIDER_ONBOARDING_MESSAGE),
    true,
  );
  const first = getActiveProviderOnboardingSession(PUBLIC_PHONE);
  assert.ok(first);
  assert.equal(first.expected_phone, PUBLIC_PHONE);
  assert.equal(first.step, 'BUSINESS_NAME');
  assert.ok(first.claimed_at);
  assert.equal(
    sent.at(-2)?.message,
    "🍱 Welcome to ZipBite!\nLet's get your food business set up.",
  );
  assert.match(sent.at(-1)?.message ?? '', /business name/i);

  await send(PUBLIC_PHONE, PUBLIC_PROVIDER_ONBOARDING_MESSAGE);
  const resumed = getActiveProviderOnboardingSession(PUBLIC_PHONE);
  assert.equal(resumed?.id, first.id);
  const sessionCount = (
    getDb()
      .prepare(
        `SELECT COUNT(*) AS count FROM vendor_onboarding_sessions
         WHERE expected_phone = ? AND completed_at IS NULL AND expires_at > ?`,
      )
      .get(PUBLIC_PHONE, Date.now()) as { count: number }
  ).count;
  assert.equal(sessionCount, 1);

  await send(OTHER_PHONE, PUBLIC_PROVIDER_ONBOARDING_MESSAGE);
  const other = getActiveProviderOnboardingSession(OTHER_PHONE);
  assert.ok(other);
  assert.notEqual(other.id, first.id);
  assert.equal(
    saveProviderOnboardingSession({
      sessionId: first.id,
      phone: OTHER_PHONE,
      step: 'OWNER_NAME',
      draft: { businessName: 'Cross-provider attempt' },
    }),
    undefined,
  );
});

test('WhatsApp provider onboarding resumes, validates, and updates one vendor', async () => {
  sent.length = 0;
  setVendorMessageSender(async (params) => {
    sent.push(params);
  });
  const existing = createVendor({
    whatsappPhone: FLOW_PHONE,
    businessName: 'Old Name',
    status: 'DRAFT',
  });
  const invite = createProviderOnboardingInvite({ phone: FLOW_PHONE });

  assert.equal(shouldHandleVendor(FLOW_PHONE, `CONNECT PROVIDER ${invite.token}`), true);
  assert.equal(await send(FLOW_PHONE, `CONNECT PROVIDER ${invite.token}`), true);
  assert.equal(
    sent.at(-2)?.message,
    "🍱 Welcome to ZipBite!\nLet's get your food business set up.",
  );
  assert.match(sent.at(-1)?.message ?? '', /business name/i);

  await send(FLOW_PHONE, 'C');
  assert.match(sent.at(-1)?.message ?? '', /between 2 and 500/i);
  await send(FLOW_PHONE, 'Curry Home');
  await send(FLOW_PHONE, 'Asha Patel');
  assert.match(sent.at(-1)?.message ?? '', /confirm this WhatsApp number/i);

  assert.equal(shouldHandleVendor(FLOW_PHONE, 'hello'), true);
  await handleCustomerCommand(ctx(FLOW_PHONE, 'hello'));
  assert.match(sent.at(-2)?.message ?? '', /Welcome back/i);
  assert.match(sent.at(-1)?.message ?? '', /confirm this WhatsApp number/i);

  await send(FLOW_PHONE, 'PROVIDER_PHONE_CONFIRM', true);
  await send(FLOW_PHONE, '1 Main Street');
  assert.ok(sent.at(-1)?.list);
  await send(FLOW_PHONE, 'PROVIDER_TYPE_TIFFIN', true);
  await send(FLOW_PHONE, 'PROVIDER_MENU_MANUAL', true);
  await send(FLOW_PHONE, 'PROVIDER_FREQ_DAILY', true);
  await send(FLOW_PHONE, 'PROVIDER_PAY_BOTH', true);
  await send(FLOW_PHONE, 'Mon-Fri, 9 AM-6 PM');

  const summary = sent.at(-1)?.message ?? '';
  assert.match(summary, /Curry Home/);
  assert.match(summary, /Tiffin/);
  assert.match(summary, /Manual/);
  assert.match(summary, /Both/);
  assert.match(summary, /ZipBite records payment preference only/i);
  assert.match(summary, /payment preference only/i);
  assert.equal(getActiveProviderOnboardingSession(FLOW_PHONE)?.step, 'REVIEW');

  await send(FLOW_PHONE, 'PROVIDER_ONBOARDING_CONFIRM', true);
  const completed = getVendorByWhatsAppPhone(FLOW_PHONE);
  assert.ok(completed);
  assert.equal(completed.id, existing.id);
  assert.equal(completed.business_name, 'Curry Home');
  assert.equal(completed.contact_name, 'Asha Patel');
  assert.equal(completed.provider_type, 'TIFFIN');
  assert.equal(completed.menu_source_method, 'MANUAL');
  assert.equal(completed.ordering_frequency, 'DAILY');
  assert.equal(completed.payment_preference, 'BOTH');
  assert.equal(completed.status, 'UNDER_REVIEW');
  assert.ok(completed.onboarding_completed_at);
  assert.equal(completed.onboarding_source, 'WHATSAPP_LINK');
  assert.equal(
    getVendorAvailability(completed.id)?.availability_text,
    'Mon-Fri, 9 AM-6 PM',
  );
  assert.equal(getActiveProviderOnboardingSession(FLOW_PHONE), undefined);
  assert.equal(validateProviderOnboardingToken(invite.token), undefined);
  assert.match(sent.at(-1)?.message ?? '', /Under Review/);
  assert.equal(
    sent.at(-1)?.buttons?.some((button) => button.payload === 'VENDOR_PRODUCTS'),
    true,
  );
});

test('photo and PDF preferences are hooks, not media ingestion', async () => {
  const phone = '+15557770005';
  const invite = createProviderOnboardingInvite({ phone });
  await send(phone, `CONNECT PROVIDER ${invite.token}`);
  await send(phone, 'Sweet House');
  await send(phone, 'Mina');
  await send(phone, 'PROVIDER_PHONE_CONFIRM', true);
  await send(phone, '55 Market Road');
  await send(phone, 'PROVIDER_TYPE_SWEETS', true);
  await send(phone, 'PROVIDER_MENU_PDF', true);
  await send(phone, 'PROVIDER_FREQ_WEEKLY', true);
  await send(phone, 'PROVIDER_PAY_COD', true);
  await send(phone, 'Saturdays 10 AM-4 PM');
  await send(phone, 'PROVIDER_ONBOARDING_CONFIRM', true);
  const vendor = getVendorByWhatsAppPhone(phone);
  assert.equal(vendor?.menu_source_method, 'PDF');
  assert.equal(vendor?.payment_preference, 'COD');
  assert.match(sent.at(-1)?.message ?? '', /upload review is not enabled/i);
  const paymentTables = getDb()
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name LIKE 'vendor_payment%'`,
    )
    .all();
  assert.deepEqual(paymentTables, []);
});

test('provider admin routes require Basic Auth and support review', async () => {
  const previous = process.env.ADMIN_PASSWORD;
  process.env.ADMIN_PASSWORD = 'provider-secret';
  const { default: adminRouter } = await import('../src/admin/router.js');
  const app = express();
  app.use('/admin', adminRouter);
  await withServer(app, async (origin) => {
    assert.equal((await fetch(`${origin}/admin/providers`)).status, 401);
    const headers = {
      Authorization: basicAuth('provider-secret'),
      'Content-Type': 'application/x-www-form-urlencoded',
    };
    const page = await fetch(`${origin}/admin/providers`, { headers });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Provider onboarding/);

    const inviteResponse = await fetch(`${origin}/admin/providers/invites`, {
      method: 'POST',
      headers,
      body: new URLSearchParams({ phone: '+15557770006' }),
    });
    assert.equal(inviteResponse.status, 200);
    assert.match(await inviteResponse.text(), /\/provider\/onboard\//);

    const vendor = getVendorByWhatsAppPhone(FLOW_PHONE);
    assert.ok(vendor);
    const approve = await fetch(
      `${origin}/admin/providers/${vendor.id}/status`,
      {
        method: 'POST',
        headers,
        body: new URLSearchParams({ status: 'APPROVED' }),
        redirect: 'manual',
      },
    );
    assert.equal(approve.status, 302);
    assert.equal(getVendorByWhatsAppPhone(FLOW_PHONE)?.status, 'APPROVED');

    const forbiddenStatus = await fetch(
      `${origin}/admin/providers/${vendor.id}/status`,
      {
        method: 'POST',
        headers,
        body: new URLSearchParams({ status: 'ACTIVE' }),
      },
    );
    assert.equal(forbiddenStatus.status, 404);
  });
  process.env.ADMIN_PASSWORD = previous;
});

test.after(() => {
  setVendorMessageSender();
});
