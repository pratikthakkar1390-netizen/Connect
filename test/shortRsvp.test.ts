import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import {
  allocateUniqueShortCode,
  checkFamilyRsvpLimit,
  closeDb,
  createEvent,
  createFamilyInvitation,
  createInvitation,
  ensureInvitationTables,
  ensureShortCodeColumns,
  findEventByRsvpCode,
  findEventByRsvpToken,
  generateShortCode,
  getDb,
  addGuests,
  getEventGuests,
  getGuest,
  getPendingGuestPhonesForEvent,
  getRsvp,
  getRsvpSummary,
  listRsvpsForEvent,
  lookupRsvpLinkTarget,
  lookupShortRsvpTarget,
  setGuestName,
} from '../src/db/store.js';
import {
  isSavedWebGuestName,
  normalizeWebGuestName,
} from '../src/rsvp/webRsvp.js';
import { parseRsvpLinkToken } from '../src/rsvp/parser.js';
import {
  buildRsvpWhatsAppLink,
  buildShortRsvpUrl,
  buildWhatsAppChatLinks,
  getPublicBaseUrl,
  isWebGuestPhone,
} from '../src/config.js';
import { shortRsvpRouter } from '../src/http/shortRsvp.js';
import { WEB_GUEST_COOKIE } from '../src/http/webGuest.js';
import {
  formatRespondentLine,
  formatRsvpStatusMessage,
  organizerGuestDisplayName,
} from '../src/commands/organizer.js';

process.env.DATABASE_PATH = ':memory:';
process.env.WHATSAPP_BUSINESS_PHONE = '+15551234567';

const SHORT_CODE_RE = /^[0-9A-HJKMNP-TV-Z]{8}$/;
const PREFILL =
  'Hi! I received an invitation. Please show me how to respond. Code:';

function cookieHeader(res: Response): string {
  const parts =
    typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : [res.headers.get('set-cookie') ?? ''];
  return parts
    .filter(Boolean)
    .map((part) => part.split(';', 1)[0])
    .join('; ');
}

async function postRsvp(
  url: string,
  body: Record<string, string> | URLSearchParams,
  cookie = '',
): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...(cookie ? { cookie } : {}),
    },
    body: body instanceof URLSearchParams ? body.toString() : new URLSearchParams(body).toString(),
    redirect: 'manual',
  });
}

function formFields(html: string, formId: string): URLSearchParams {
  const match = html.match(
    new RegExp(`<form[^>]*\\bid="${formId}"[\\s\\S]*?</form>`),
  );
  assert.ok(match, `missing form #${formId}`);
  const params = new URLSearchParams();
  const form = match[0];
  for (const tag of form.matchAll(/<(?:input|button)[^>]*>/gi)) {
    const name = /\bname="([^"]*)"/.exec(tag[0])?.[1];
    if (!name) {
      continue;
    }
    if (tag[0].startsWith('<button') && !/\btype="submit"/.test(tag[0])) {
      continue;
    }
    params.append(name, /\bvalue="([^"]*)"/.exec(tag[0])?.[1] ?? '');
  }
  return params;
}

function withShortRsvpServer(
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(shortRsvpRouter);
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

test('short code generation uses 8+ Crockford chars from a random alphabet', () => {
  const codes = new Set<string>();
  for (let i = 0; i < 40; i++) {
    const code = generateShortCode();
    assert.match(code, SHORT_CODE_RE);
    assert.doesNotMatch(code, /[ILOU]/);
    assert.notEqual(code, String(i));
    codes.add(code);
  }
  assert.ok(codes.size >= 38);
});

test('short codes are globally unique across events and family invitations', () => {
  getDb();
  const codes = new Set<string>();
  for (let i = 0; i < 8; i++) {
    const event = createEvent(`Event ${i}`, 'June 15', 'Hall', `+15551111${100 + i}`);
    assert.ok(event.short_code);
    assert.match(event.short_code, SHORT_CODE_RE);
    assert.notEqual(event.short_code, String(event.id));
    assert.notEqual(event.short_code, event.rsvp_token);
    assert.ok(!codes.has(event.short_code.toUpperCase()));
    codes.add(event.short_code.toUpperCase());

    const family = createFamilyInvitation(event.id, `Family ${i}`, 3);
    assert.ok(family.short_code);
    assert.match(family.short_code, SHORT_CODE_RE);
    assert.notEqual(family.short_code, String(family.id));
    assert.notEqual(family.short_code, event.short_code);
    assert.ok(!codes.has(family.short_code.toUpperCase()));
    codes.add(family.short_code.toUpperCase());
  }

  const extra = allocateUniqueShortCode();
  assert.match(extra, SHORT_CODE_RE);
  assert.equal(codes.has(extra.toUpperCase()), false);
  closeDb();
});

test('individual RSVP links use the event short URL, not wa.me', () => {
  getDb();
  const event = createEvent('Wedding', 'June 15', 'Hall', '+15551111111');
  const invitation = createInvitation({ eventId: event.id, type: 'individual' });

  assert.equal(invitation.short_code, null);
  assert.ok(event.short_code);
  assert.equal(
    buildShortRsvpUrl(event.short_code),
    `${getPublicBaseUrl()}/r/${event.short_code}`,
  );
  assert.match(
    buildShortRsvpUrl(event.short_code),
    /^https:\/\/connect\.zip-bite\.com\/r\/[0-9A-HJKMNP-TV-Z]{8}$/,
  );
  assert.equal(lookupShortRsvpTarget(event.short_code)?.event.id, event.id);
  assert.equal(
    lookupShortRsvpTarget(event.short_code)?.invitation?.id,
    invitation.id,
  );
  closeDb();
});

test('family RSVP links get a unique short URL and keep guest limits', () => {
  getDb();
  const event = createEvent('Wedding', 'June 15', 'Hall', '+15551111111');
  const family = createFamilyInvitation(event.id, 'Patel Family', 3);

  assert.ok(family.short_code);
  assert.ok(family.rsvp_code);
  assert.notEqual(family.short_code, event.short_code);
  assert.notEqual(family.rsvp_code, event.rsvp_code);
  assert.equal(
    lookupShortRsvpTarget(family.short_code)?.invitation?.id,
    family.id,
  );
  assert.equal(checkFamilyRsvpLimit(family, 2, 1).allowed, true);
  assert.equal(checkFamilyRsvpLimit(family, 3, 1).allowed, false);
  closeDb();
});

test('GET /r/:code opens a CONNECT RSVP page instead of wa.me', async () => {
  getDb();
  const event = createEvent(
    'Picnic',
    'Sunday, July 4, 2026 at 2:00 PM',
    'Park',
    '+15551111111',
  );
  const family = createFamilyInvitation(event.id, 'Shah Family', 4);

  await withShortRsvpServer(async (baseUrl) => {
    const eventRes = await fetch(`${baseUrl}/r/${event.short_code}`, {
      redirect: 'manual',
    });
    assert.equal(eventRes.status, 200);
    assert.equal(eventRes.headers.get('location'), null);
    const eventBody = await eventRes.text();
    assert.match(eventBody, /You're Invited!/);
    assert.match(eventBody, /Picnic/);
    assert.match(eventBody, /📅/);
    assert.match(eventBody, /Sunday, July 4, 2026/);
    assert.match(eventBody, /⏰/);
    assert.match(eventBody, /2:00 PM/);
    assert.match(eventBody, /📍/);
    assert.match(eventBody, /Park/);
    assert.match(eventBody, /Will you be attending\?/);
    assert.match(eventBody, /Yes, I'll be there/);
    assert.match(eventBody, /Can't make it/);
    assert.match(eventBody, /Maybe/);
    assert.match(eventBody, /CONNECT/);
    assert.match(eventBody, /by zipbite/);
    assert.match(eventBody, /Moments to Memory/);
    assert.doesNotMatch(eventBody, /Family Invitation/);
    assert.doesNotMatch(eventBody, /Will your family be attending/);
    assert.doesNotMatch(eventBody, /Up to \d+ guests/);
    assert.doesNotMatch(eventBody, /wa\.me/);
    assert.doesNotMatch(eventBody, /Back to WhatsApp/);
    assert.doesNotMatch(eventBody, new RegExp(event.rsvp_token));
    assert.doesNotMatch(eventBody, /event_id/i);
    assert.match(eventRes.headers.get('set-cookie') ?? '', new RegExp(WEB_GUEST_COOKIE));

    const familyRes = await fetch(`${baseUrl}/r/${family.short_code}`, {
      redirect: 'manual',
    });
    assert.equal(familyRes.status, 200);
    const familyBody = await familyRes.text();
    assert.match(familyBody, /Picnic/);
    assert.match(familyBody, /👨‍👩‍👧‍👦 Family Invitation/);
    assert.match(familyBody, /Up to 4 guests/);
    assert.match(familyBody, /Will your family be attending\?/);
    assert.doesNotMatch(familyBody, /Will you be attending\?/);
    assert.doesNotMatch(familyBody, /wa\.me/);
    assert.doesNotMatch(familyBody, new RegExp(event.rsvp_token));
  });

  closeDb();
});

test('GET /r/:code returns a generic 404 for invalid codes', async () => {
  getDb();
  createEvent('Picnic', 'July 4', 'Park', '+15551111111');

  await withShortRsvpServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/r/NOTFOUND`, { redirect: 'manual' });
    assert.equal(res.status, 404);
    const body = await res.text();
    assert.match(body, /isn't valid|not available|Invitation/i);
    assert.doesNotMatch(body, /sqlite/i);
    assert.doesNotMatch(body, /rsvp_token/i);
    assert.doesNotMatch(body, /Picnic/);
    assert.doesNotMatch(body, /15551111111/);
  });

  closeDb();
});

test('GET /r/:code shows a closed page after the RSVP deadline', async () => {
  getDb();
  const event = createEvent('Gala', 'August 1', 'Hotel', '+15551111111', {
    rsvpDeadline: new Date(Date.now() - 60_000).toISOString(),
  });

  await withShortRsvpServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/r/${event.short_code}`, {
      redirect: 'manual',
    });
    assert.equal(res.status, 410);
    const body = await res.text();
    assert.match(body, /closed/i);
    assert.doesNotMatch(body, /wa\.me/);
    assert.doesNotMatch(body, new RegExp(event.rsvp_token));
    assert.doesNotMatch(body, /sqlite/i);
  });

  closeDb();
});

test('web RSVP records No without opening WhatsApp', async () => {
  getDb();
  const event = createEvent('Dinner', 'May 1', 'Home', '+15551111111');

  await withShortRsvpServer(async (baseUrl) => {
    const url = `${baseUrl}/r/${event.short_code}`;
    const opened = await fetch(url, { redirect: 'manual' });
    const cookie = cookieHeader(opened);
    const named = await postRsvp(url, { response: 'no' }, cookie);
    assert.equal(named.status, 200);
    const namedBody = await named.text();
    assert.match(namedBody, /What's your name\?/);
    assert.match(namedBody, /Please enter your name so the organizer knows who responded/);
    assert.doesNotMatch(namedBody, /Your RSVP has been recorded/);

    const phoneStep = await postRsvp(
      url,
      { response: 'no', name: 'Jordan Lee' },
      cookieHeader(named) || cookie,
    );
    const phoneBody = await phoneStep.text();
    assert.match(phoneBody, /WhatsApp Number/);
    assert.match(phoneBody, /event updates/);
    assert.doesNotMatch(phoneBody, /Your RSVP has been recorded/);

    const res = await postRsvp(
      url,
      { response: 'no', name: 'Jordan Lee', whatsapp: '7325551001' },
      cookieHeader(phoneStep) || cookie,
    );
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /RSVP Confirmed!/);
    assert.match(body, /Thank you, Jordan Lee\. Your RSVP has been recorded\./);
    assert.match(body, /Need to change your RSVP\?/);
    assert.match(body, /Simply open the invitation link again to update your response\./);
    assert.match(body, /📱 Save CONNECT/);
    assert.match(body, /Save our number so you can easily find CONNECT for future events/);
    assert.match(body, />Save CONNECT</);
    assert.match(body, /href="\/connect\.vcf"/);
    assert.match(body, /Powered by zipbite/);
    assert.doesNotMatch(body, /You can close this page and return to WhatsApp/);
    assert.doesNotMatch(body, /Back to WhatsApp/);
    assert.doesNotMatch(body, />Exit</);
    assert.doesNotMatch(body, /wa\.me/);
    assert.doesNotMatch(body, /whatsapp:\/\//);
    assert.equal(res.headers.get('location'), null);
  });

  const rsvps = listRsvpsForEvent(event.id).filter((row) => row.status !== 'pending');
  assert.equal(rsvps.length, 1);
  assert.equal(rsvps[0].status, 'no');
  assert.ok(isWebGuestPhone(rsvps[0].phone));
  assert.equal(getGuest(event.id, rsvps[0].phone)?.name, 'Jordan Lee');
  assert.equal(getGuest(event.id, rsvps[0].phone)?.whatsapp_phone, '+17325551001');
  const status = formatRsvpStatusMessage(
    event,
    getRsvpSummary(event.id),
    getEventGuests(event.id),
    rsvps,
  );
  assert.match(status, /Jordan Lee — No/);
  assert.doesNotMatch(status, /web:/);
  closeDb();
});

test('web RSVP records Maybe without a WhatsApp message', async () => {
  getDb();
  const event = createEvent('Brunch', 'May 2', 'Cafe', '+15551111111');

  await withShortRsvpServer(async (baseUrl) => {
    const url = `${baseUrl}/r/${event.short_code}`;
    const named = await postRsvp(url, { response: 'maybe' });
    assert.match(await named.text(), /What's your name\?/);
    const res = await postRsvp(url, { response: 'maybe', name: 'Alex Chen' });
    assert.match(await res.text(), /WhatsApp Number/);
    const saved = await postRsvp(url, {
      response: 'maybe',
      name: 'Alex Chen',
      whatsapp: '7325551002',
    });
    assert.equal(saved.status, 200);
    const body = await saved.text();
    assert.match(body, /RSVP Confirmed!/);
    assert.match(body, /Thank you, Alex Chen\. Your RSVP has been recorded\./);
    assert.match(body, /Need to change your RSVP\?/);
    assert.match(body, /Simply open the invitation link again to update your response\./);
    assert.match(body, /📱 Save CONNECT/);
    assert.match(body, />Save CONNECT</);
    assert.doesNotMatch(body, /You can close this page and return to WhatsApp/);
    assert.doesNotMatch(body, /Back to WhatsApp/);
    assert.doesNotMatch(body, /wa\.me/);
    assert.doesNotMatch(body, /whatsapp:\/\//);
  });

  const rsvp = listRsvpsForEvent(event.id).find((row) => row.status === 'maybe');
  assert.ok(rsvp);
  assert.ok(isWebGuestPhone(rsvp.phone));
  assert.equal(getGuest(event.id, rsvp.phone)?.name, 'Alex Chen');
  assert.match(
    formatRespondentLine(rsvp, getGuest(event.id, rsvp.phone)?.name),
    /Alex Chen — Maybe/,
  );
  closeDb();
});

test('Individual Yes name POST from the HTML form reaches counts, not the choice prompt', async () => {
  getDb();
  const event = createEvent('Garden Party', 'June 8', 'Garden', '+15551111111', {
    childrenAllowed: true,
  });

  await withShortRsvpServer(async (baseUrl) => {
    const url = `${baseUrl}/r/${event.short_code}`;
    const cookie = cookieHeader(await fetch(url));
    const named = await postRsvp(url, { response: 'yes' }, cookie);
    assert.equal(named.status, 200);
    const namedHtml = await named.text();
    assert.match(namedHtml, /What's your name\?/);
    assert.match(namedHtml, /<form[^>]*id="name-form"/);
    assert.doesNotMatch(namedHtml, /Please choose Yes, No, or Maybe/);

    const fields = formFields(namedHtml, 'name-form');
    assert.equal(fields.get('response'), 'yes');
    fields.set('name', 'Sam Rivera');
    const next = await postRsvp(url, fields, cookieHeader(named) || cookie);
    assert.equal(next.status, 200);
    const phoneHtml = await next.text();
    assert.match(phoneHtml, /WhatsApp Number/);
    const phoneFields = formFields(phoneHtml, 'whatsapp-form');
    phoneFields.set('whatsapp', '7325551003');
    const counts = await postRsvp(url, phoneFields, cookieHeader(next) || cookie);
    assert.equal(counts.status, 200);
    const body = await counts.text();
    assert.doesNotMatch(body, /Please choose Yes, No, or Maybe/);
    assert.doesNotMatch(body, /Will you be attending\?/);
    assert.match(body, /Who will be attending\?/);
    assert.match(body, /counts open/);
  });

  assert.equal(
    listRsvpsForEvent(event.id).some((row) => row.status === 'yes'),
    false,
  );
  closeDb();
});

test('Individual Yes confirm form with duplicate response still saves', async () => {
  getDb();
  const event = createEvent('Patio Dinner', 'June 9', 'Patio', '+15551111111', {
    childrenAllowed: true,
  });

  await withShortRsvpServer(async (baseUrl) => {
    const url = `${baseUrl}/r/${event.short_code}`;
    const cookie = cookieHeader(await fetch(url));
    const counts = await postRsvp(
      url,
      { response: 'yes', name: 'Sam Rivera' },
      cookie,
    );
    const phoneHtml = await counts.text();
    assert.match(phoneHtml, /WhatsApp Number/);
    const withPhone = await postRsvp(
      url,
      { response: 'yes', name: 'Sam Rivera', whatsapp: '7325551004' },
      cookie,
    );
    const countsHtml = await withPhone.text();
    assert.match(countsHtml, /Who will be attending\?/);

    const fields = formFields(countsHtml, 'rsvp-form');
    assert.ok(fields.getAll('response').length >= 2);
    assert.deepEqual(fields.getAll('response'), ['yes', 'yes']);
    assert.equal(fields.get('name'), 'Sam Rivera');

    const saved = await postRsvp(url, fields, cookieHeader(withPhone) || cookie);
    assert.equal(saved.status, 200);
    const body = await saved.text();
    assert.doesNotMatch(body, /Please choose Yes, No, or Maybe/);
    assert.match(body, /Your RSVP has been recorded/);
  });

  const rsvp = listRsvpsForEvent(event.id).find((row) => row.status === 'yes');
  assert.ok(rsvp);
  assert.equal(getGuest(event.id, rsvp.phone)?.name, 'Sam Rivera');
  closeDb();
});

test('Family Yes name and confirm forms use the same response fields', async () => {
  getDb();
  const event = createEvent('Wedding', 'June 15', 'Hall', '+15551111111', {
    childrenAllowed: true,
  });
  const family = createFamilyInvitation(event.id, 'Rivera Family', 4);

  await withShortRsvpServer(async (baseUrl) => {
    const url = `${baseUrl}/r/${family.short_code}`;
    const cookie = cookieHeader(await fetch(url));
    const named = await postRsvp(url, { response: 'yes' }, cookie);
    const namedHtml = await named.text();
    assert.match(namedHtml, /Who is responding for this family\?/);
    assert.doesNotMatch(namedHtml, /What's your name\?/);
    const nameFields = formFields(namedHtml, 'name-form');
    nameFields.set('name', 'Alex Rivera');
    const counts = await postRsvp(url, nameFields, cookieHeader(named) || cookie);
    const countsHtml = await counts.text();
    assert.doesNotMatch(countsHtml, /Please choose Yes, No, or Maybe/);
    assert.match(countsHtml, /How many people will attend\?/);
    assert.match(countsHtml, /1 of 4 guests/);
    assert.match(countsHtml, /data-max-guests="4"/);
    assert.doesNotMatch(countsHtml, /Who will be attending\?/);

    const confirm = formFields(countsHtml, 'rsvp-form');
    assert.ok(confirm.getAll('response').length >= 2);
    const saved = await postRsvp(url, confirm, cookieHeader(counts) || cookie);
    assert.equal(saved.status, 200);
    assert.match(await saved.text(), /Your RSVP has been recorded/);
  });

  const rsvp = listRsvpsForEvent(event.id).find((row) => row.status === 'yes');
  assert.ok(rsvp);
  assert.equal(getGuest(event.id, rsvp.phone)?.name, 'Alex Rivera');
  assert.equal(getGuest(event.id, rsvp.phone)?.invitation_id, family.id);
  closeDb();
});

test('Family No asks respondent name then saves without counts', async () => {
  getDb();
  const event = createEvent('Reunion', 'July 10', 'Park', '+15551111111', {
    childrenAllowed: true,
  });
  const family = createFamilyInvitation(event.id, 'Nguyen Family', 5);

  await withShortRsvpServer(async (baseUrl) => {
    const url = `${baseUrl}/r/${family.short_code}`;
    const cookie = cookieHeader(await fetch(url));
    const named = await postRsvp(url, { response: 'no' }, cookie);
    const namedHtml = await named.text();
    assert.match(namedHtml, /Who is responding for this family\?/);
    assert.doesNotMatch(namedHtml, /What's your name\?/);
    assert.doesNotMatch(namedHtml, /How many people will attend/);
    assert.doesNotMatch(namedHtml, /Who will be attending\?/);
    assert.doesNotMatch(namedHtml, /Your RSVP has been recorded/);

    const res = await postRsvp(
      url,
      { response: 'no', name: 'Kim Nguyen' },
      cookieHeader(named) || cookie,
    );
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /RSVP Confirmed!/);
    assert.match(body, /Thank you, Kim Nguyen\. Your RSVP has been recorded\./);
    assert.doesNotMatch(body, /Back to WhatsApp/);
    assert.doesNotMatch(body, /wa\.me/);
    assert.doesNotMatch(body, /How many people will attend/);
  });

  const rsvp = listRsvpsForEvent(event.id).find((row) => row.status === 'no');
  assert.ok(rsvp);
  assert.equal(getGuest(event.id, rsvp.phone)?.name, 'Kim Nguyen');
  assert.equal(getGuest(event.id, rsvp.phone)?.invitation_id, family.id);
  closeDb();
});

test('Family Maybe asks respondent name then saves without counts', async () => {
  getDb();
  const event = createEvent('Picnic', 'July 11', 'Lake', '+15551111111', {
    childrenAllowed: true,
  });
  const family = createFamilyInvitation(event.id, 'Ortiz Family', 6);

  await withShortRsvpServer(async (baseUrl) => {
    const url = `${baseUrl}/r/${family.short_code}`;
    const cookie = cookieHeader(await fetch(url));
    const named = await postRsvp(url, { response: 'maybe' }, cookie);
    const namedHtml = await named.text();
    assert.match(namedHtml, /Who is responding for this family\?/);
    assert.doesNotMatch(namedHtml, /What's your name\?/);
    assert.doesNotMatch(namedHtml, /How many people will attend/);
    assert.doesNotMatch(namedHtml, /Who will be attending\?/);

    const res = await postRsvp(
      url,
      { response: 'maybe', name: 'Diego Ortiz' },
      cookieHeader(named) || cookie,
    );
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /RSVP Confirmed!/);
    assert.match(body, /Thank you, Diego Ortiz\. Your RSVP has been recorded\./);
    assert.doesNotMatch(body, /Back to WhatsApp/);
    assert.doesNotMatch(body, /How many people will attend/);
  });

  const rsvp = listRsvpsForEvent(event.id).find((row) => row.status === 'maybe');
  assert.ok(rsvp);
  assert.equal(getGuest(event.id, rsvp.phone)?.name, 'Diego Ortiz');
  assert.equal(getGuest(event.id, rsvp.phone)?.invitation_id, family.id);
  closeDb();
});

test('Yes without guest counts asks who will be attending', async () => {
  getDb();
  const event = createEvent('Party', 'June 1', 'Hall', '+15551111111');

  await withShortRsvpServer(async (baseUrl) => {
    const url = `${baseUrl}/r/${event.short_code}`;
    const named = await postRsvp(url, { response: 'yes' });
    assert.equal(named.status, 200);
    const namedBody = await named.text();
    assert.match(namedBody, /What's your name\?/);
    assert.doesNotMatch(namedBody, /Who will be attending\?/);
    assert.doesNotMatch(namedBody, /Your RSVP has been recorded/);

    const res = await postRsvp(url, { response: 'yes', name: 'Sam Rivera' });
    assert.equal(res.status, 200);
    const phoneBody = await res.text();
    assert.match(phoneBody, /WhatsApp Number/);
    assert.doesNotMatch(phoneBody, /Who will be attending\?/);

    const counts = await postRsvp(url, {
      response: 'yes',
      name: 'Sam Rivera',
      whatsapp: '7325551005',
    });
    assert.equal(counts.status, 200);
    const body = await counts.text();
    assert.match(body, /Who will be attending\?/);
    assert.match(body, /counts open/);
    assert.doesNotMatch(body, /Your RSVP has been recorded/);
  });

  assert.equal(
    listRsvpsForEvent(event.id).some((row) => row.status === 'yes'),
    false,
  );
  closeDb();
});

test('web RSVP Yes with children allowed stores adult and child counts', async () => {
  getDb();
  const event = createEvent('Party', 'June 1', 'Hall', '+15551111111', {
    childrenAllowed: true,
  });

  await withShortRsvpServer(async (baseUrl) => {
    const url = `${baseUrl}/r/${event.short_code}`;
    const opened = await fetch(url);
    const cookie = cookieHeader(opened);
    const page = await opened.text();
    assert.match(page, /Will you be attending\?/);

    const named = await postRsvp(url, { response: 'yes' }, cookie);
    const namedBody = await named.text();
    assert.match(namedBody, /What's your name\?/);

    const counts = await postRsvp(
      url,
      { response: 'yes', name: 'Priya Shah' },
      cookieHeader(named) || cookie,
    );
    const phoneBody = await counts.text();
    assert.match(phoneBody, /WhatsApp Number/);
    const withPhone = await postRsvp(
      url,
      {
        response: 'yes',
        name: 'Priya Shah',
        whatsapp: '7325551006',
      },
      cookieHeader(counts) || cookie,
    );
    const countsBody = await withPhone.text();
    assert.match(countsBody, /Who will be attending\?/);
    assert.match(countsBody, /Children/);

    const res = await postRsvp(
      url,
      {
        response: 'yes',
        name: 'Priya Shah',
        whatsapp: '7325551006',
        adults: '2',
        children: '1',
      },
      cookieHeader(withPhone) || cookie,
    );
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /RSVP Confirmed!/);
    assert.match(body, /Thank you, Priya Shah\. Your RSVP has been recorded\./);
    assert.match(body, /Need to change your RSVP\?/);
    assert.match(body, /Simply open the invitation link again to update your response\./);
    assert.match(body, /📱 Save CONNECT/);
    assert.match(body, />Save CONNECT</);
    assert.doesNotMatch(body, /You can close this page and return to WhatsApp/);
    assert.doesNotMatch(body, /Back to WhatsApp/);
    assert.doesNotMatch(body, /id="back-to-whatsapp"/);
    assert.doesNotMatch(body, /whatsapp:\/\//);
    assert.doesNotMatch(body, /wa\.me/);
    assert.doesNotMatch(body, /window\.location\.href = app/);
    assert.doesNotMatch(body, /window\.location\.href = web/);
    assert.doesNotMatch(body, />Exit</);
  });

  const rsvp = listRsvpsForEvent(event.id).find((row) => row.status === 'yes');
  assert.ok(rsvp);
  assert.equal(rsvp.adult_count, 2);
  assert.equal(rsvp.child_count, 1);
  assert.equal(rsvp.guest_count, 3);
  assert.equal(getGuest(event.id, rsvp.phone)?.name, 'Priya Shah');
  const status = formatRsvpStatusMessage(
    event,
    getRsvpSummary(event.id),
    getEventGuests(event.id),
    [rsvp],
  );
  assert.match(status, /Priya Shah — Yes/);
  assert.doesNotMatch(status, /web:/);
  closeDb();
});

test('adults-only web RSVP hides children controls', async () => {
  getDb();
  const event = createEvent('Dinner', 'June 2', 'Home', '+15551111111', {
    childrenAllowed: false,
  });

  await withShortRsvpServer(async (baseUrl) => {
    const url = `${baseUrl}/r/${event.short_code}`;
    const cookie = cookieHeader(await fetch(url));
    const named = await postRsvp(url, { response: 'yes', name: 'Chris Park' }, cookie);
    assert.match(await named.text(), /WhatsApp Number/);
    const pageRes = await postRsvp(
      url,
      {
        response: 'yes',
        name: 'Chris Park',
        whatsapp: '7325551007',
      },
      cookieHeader(named) || cookie,
    );
    const page = await pageRes.text();
    assert.match(page, /Adults/);
    assert.doesNotMatch(page, />Children</);
    assert.doesNotMatch(page, /name="children"/);

    const res = await postRsvp(
      url,
      {
        response: 'yes',
        name: 'Chris Park',
        whatsapp: '7325551007',
        adults: '3',
        children: '9',
      },
      cookieHeader(pageRes) || cookie,
    );
    assert.equal(res.status, 200);
  });

  const rsvp = listRsvpsForEvent(event.id).find((row) => row.status === 'yes');
  assert.ok(rsvp);
  assert.equal(rsvp.adult_count, 3);
  assert.equal(rsvp.child_count, 0);
  closeDb();
});

test('family guest-limit is enforced on the web RSVP page', async () => {
  getDb();
  const event = createEvent('Wedding', 'June 15', 'Hall', '+15551111111');
  const family = createFamilyInvitation(event.id, 'Patel Family', 3);

  await withShortRsvpServer(async (baseUrl) => {
    const url = `${baseUrl}/r/${family.short_code}`;
    const opened = await fetch(url);
    const cookie = cookieHeader(opened);
    const page = await opened.text();
    assert.match(page, /👨‍👩‍👧‍👦 Family Invitation/);
    assert.match(page, /Up to 3 guests/);
    const over = await postRsvp(
      url,
      { response: 'yes', name: 'Patel Guest', adults: '3', children: '1' },
      cookie,
    );
    assert.equal(over.status, 400);
    const overBody = await over.text();
    assert.match(overBody, /up to 3 guests/);
    assert.equal(
      listRsvpsForEvent(event.id).some((row) => row.status === 'yes'),
      false,
    );

    const ok = await postRsvp(
      url,
      { response: 'yes', name: 'Patel Guest', adults: '2', children: '1' },
      cookie,
    );
    assert.equal(ok.status, 200);
  });

  const rsvp = listRsvpsForEvent(event.id).find((row) => row.status === 'yes');
  assert.ok(rsvp);
  assert.equal(rsvp.guest_count, 3);
  assert.ok(isWebGuestPhone(rsvp.phone));
  assert.equal(getGuest(event.id, rsvp.phone)?.invitation_id, family.id);
  closeDb();
});

test('returning to the same short link shows and updates the current RSVP', async () => {
  getDb();
  const event = createEvent('Picnic', 'July 4', 'Park', '+15551111111', {
    childrenAllowed: true,
  });

  await withShortRsvpServer(async (baseUrl) => {
    const url = `${baseUrl}/r/${event.short_code}`;
    const first = await postRsvp(url, { response: 'no', name: 'Taylor Brooks' });
    assert.match(await first.text(), /WhatsApp Number/);
    const saved = await postRsvp(url, {
      response: 'no',
      name: 'Taylor Brooks',
      whatsapp: '7325551008',
    });
    const cookie = cookieHeader(saved);
    assert.match(await saved.text(), /Your RSVP has been recorded/);

    const again = await fetch(url, { headers: { cookie } });
    const againBody = await again.text();
    assert.match(againBody, /already responded/);
    assert.match(againBody, /btn-no selected/);
    assert.doesNotMatch(againBody, /What's your name\?/);

    const updated = await postRsvp(
      url,
      { response: 'yes', adults: '1', children: '2' },
      cookie,
    );
    assert.equal(updated.status, 200);

    const after = await fetch(url, { headers: { cookie: cookieHeader(updated) || cookie } });
    const afterBody = await after.text();
    assert.match(afterBody, /btn-yes selected/);
    assert.match(afterBody, /value="1"/);
    assert.match(afterBody, /value="2"/);
  });

  const rsvps = listRsvpsForEvent(event.id).filter((row) =>
    isWebGuestPhone(row.phone),
  );
  assert.equal(rsvps.length, 1);
  assert.equal(rsvps[0].status, 'yes');
  assert.equal(rsvps[0].adult_count, 1);
  assert.equal(rsvps[0].child_count, 2);
  assert.equal(getGuest(event.id, rsvps[0].phone)?.name, 'Taylor Brooks');
  closeDb();
});

test('placeholder names are not treated as a saved web guest name', () => {
  for (const name of ['', '   ', 'Guest', 'guest', 'GUEST', 'web:abc', null, undefined]) {
    assert.equal(normalizeWebGuestName(name), null);
    assert.equal(isSavedWebGuestName(name), false);
  }
  assert.equal(normalizeWebGuestName('Maya Singh'), 'Maya Singh');
  assert.equal(isSavedWebGuestName('Maya Singh'), true);
  assert.equal(isSavedWebGuestName('Patel Guest'), true);
});

test('fresh web visitor first POST asks for a name and does not upsert RSVP', async () => {
  getDb();
  const event = createEvent('Shower', 'May 4', 'Garden', '+15551111111', {
    childrenAllowed: true,
  });

  await withShortRsvpServer(async (baseUrl) => {
    const url = `${baseUrl}/r/${event.short_code}`;
    for (const response of ['yes', 'no', 'maybe'] as const) {
      const res = await postRsvp(url, { response });
      assert.equal(res.status, 200);
      const body = await res.text();
      assert.match(body, /What's your name\?/);
      assert.match(body, /id="guest-name"/);
      assert.match(body, /name="name"/);
      assert.doesNotMatch(body, /Your RSVP has been recorded/);
      assert.doesNotMatch(body, /Who will be attending\?/);
    }
  });

  assert.equal(
    listRsvpsForEvent(event.id).some((row) => row.status !== 'pending'),
    false,
  );
  assert.equal(getEventGuests(event.id).length, 0);
  closeDb();
});

test('cookie with placeholder name Guest still asks for name before save', async () => {
  getDb();
  const event = createEvent('Rehearsal', 'May 5', 'Hall', '+15551111111', {
    childrenAllowed: true,
  });

  await withShortRsvpServer(async (baseUrl) => {
    const url = `${baseUrl}/r/${event.short_code}`;
    const seeded = await postRsvp(url, {
      response: 'no',
      name: 'Temp Seed',
      whatsapp: '7325551009',
    });
    const cookie = cookieHeader(seeded);
    assert.match(await seeded.text(), /Your RSVP has been recorded/);

    const seededRsvp = listRsvpsForEvent(event.id).find((row) => row.status === 'no');
    assert.ok(seededRsvp);
    setGuestName(event.id, seededRsvp.phone, 'Guest');
    assert.equal(getGuest(event.id, seededRsvp.phone)?.name, 'Guest');
    assert.equal(isSavedWebGuestName(getGuest(event.id, seededRsvp.phone)?.name), false);

    for (const response of ['yes', 'no', 'maybe'] as const) {
      const named = await postRsvp(url, { response }, cookie);
      assert.equal(named.status, 200);
      const namedBody = await named.text();
      assert.match(namedBody, /What's your name\?/);
      assert.match(namedBody, /id="guest-name"/);
      assert.doesNotMatch(namedBody, /Your RSVP has been recorded/);
      assert.equal(getRsvp(event.id, seededRsvp.phone)?.status, 'no');
    }

    const saved = await postRsvp(
      url,
      { response: 'maybe', name: 'Riley Cohen', whatsapp: '7325551010' },
      cookie,
    );
    assert.equal(saved.status, 200);
    assert.match(await saved.text(), /Your RSVP has been recorded/);
    assert.equal(getGuest(event.id, seededRsvp.phone)?.name, 'Riley Cohen');
    assert.equal(getRsvp(event.id, seededRsvp.phone)?.status, 'maybe');
    assert.match(
      formatRespondentLine(
        getRsvp(event.id, seededRsvp.phone)!,
        getGuest(event.id, seededRsvp.phone)?.name,
      ),
      /Riley Cohen — Maybe/,
    );
  });

  closeDb();
});

test('empty web guest name is rejected and nothing is saved', async () => {
  getDb();
  const event = createEvent('Mixer', 'May 3', 'Loft', '+15551111111');

  await withShortRsvpServer(async (baseUrl) => {
    const url = `${baseUrl}/r/${event.short_code}`;
    const cookie = cookieHeader(await fetch(url));

    for (const name of [
      '',
      '   ',
      'Guest',
      'guest',
      'GUEST',
      'web:550e8400-e29b-41d4-a716-446655440000',
    ]) {
      const res = await postRsvp(url, { response: 'no', name }, cookie);
      assert.equal(res.status, 400);
      const body = await res.text();
      assert.match(body, /What's your name\?/);
      assert.match(body, /id="guest-name"/);
      assert.match(body, /Please enter your name so the organizer knows who responded/);
      assert.doesNotMatch(body, /Your RSVP has been recorded/);
    }

    const tooLong = await postRsvp(
      url,
      { response: 'maybe', name: 'A'.repeat(81) },
      cookie,
    );
    assert.equal(tooLong.status, 400);
    assert.match(await tooLong.text(), /80 characters or fewer/);
  });

  assert.equal(
    listRsvpsForEvent(event.id).some((row) => row.status !== 'pending'),
    false,
  );
  closeDb();
});

test('organizer respondents never show a web UUID', () => {
  const webPhone = 'web:550e8400-e29b-41d4-a716-446655440000';
  const rsvp = {
    id: 1,
    event_id: 1,
    phone: webPhone,
    status: 'yes' as const,
    guest_count: 1,
    adult_count: 1,
    child_count: 0,
    raw_reply: 'web:yes 1+0',
    updated_at: '',
  };

  assert.equal(formatRespondentLine(rsvp, 'John Smith'), '✅ John Smith — Yes');
  assert.equal(formatRespondentLine(rsvp, null), '✅ Guest — Yes');
  assert.equal(formatRespondentLine(rsvp, webPhone), '✅ Guest — Yes');
  assert.equal(organizerGuestDisplayName(null, webPhone), 'Guest');
  assert.equal(organizerGuestDisplayName('web:abc', webPhone), 'Guest');
  assert.equal(organizerGuestDisplayName('John Smith', webPhone), 'John Smith');
  assert.doesNotMatch(formatRespondentLine(rsvp, 'John Smith'), /web:/);
  assert.doesNotMatch(formatRespondentLine(rsvp, null), /550e8400/);
});

test('closed deadline rejects a web RSVP POST', async () => {
  getDb();
  const event = createEvent('Late', 'August 1', 'Hall', '+15551111111', {
    rsvpDeadline: new Date(Date.now() - 60_000).toISOString(),
  });

  await withShortRsvpServer(async (baseUrl) => {
    const res = await postRsvp(`${baseUrl}/r/${event.short_code}`, {
      response: 'yes',
      adults: '1',
    });
    assert.equal(res.status, 410);
    assert.match(await res.text(), /closed/i);
  });

  assert.equal(listRsvpsForEvent(event.id).length, 0);
  closeDb();
});

test('web guests are not reminder targets and keep the family invitation', async () => {
  getDb();
  const event = createEvent('Wedding', 'June 15', 'Hall', '+15551111111', {
    rsvpDeadline: new Date(Date.now() + 86_400_000 * 3).toISOString(),
    reminderDays: 1,
  });
  const family = createFamilyInvitation(event.id, 'Shah Family', 4);

  await withShortRsvpServer(async (baseUrl) => {
    await postRsvp(`${baseUrl}/r/${family.short_code}`, {
      response: 'maybe',
      name: 'Shah Guest',
    });
  });

  const rsvp = listRsvpsForEvent(event.id).find((row) => row.status === 'maybe');
  assert.ok(rsvp);
  assert.ok(isWebGuestPhone(rsvp.phone));
  assert.equal(getRsvp(event.id, rsvp.phone)?.status, 'maybe');
  assert.equal(getGuest(event.id, rsvp.phone)?.invitation_id, family.id);

  addGuests(event.id, ['web:550e8400-e29b-41d4-a716-446655440000']);
  assert.equal(getPendingGuestPhonesForEvent(event.id).includes('web:550e8400-e29b-41d4-a716-446655440000'), false);
  closeDb();
});

test('WhatsApp chat links open the business number without RSVP prefill', () => {
  const links = buildWhatsAppChatLinks('+15551234567');
  assert.equal(links.https, 'https://wa.me/15551234567');
  assert.equal(links.app, 'whatsapp://send?phone=15551234567');
  assert.doesNotMatch(links.https ?? '', /\?text=/);
  assert.deepEqual(buildWhatsAppChatLinks(''), { https: null, app: null });
});

test('existing long RSVP links still resolve via parser and token lookup', () => {
  getDb();
  const event = createEvent('Gala', 'August 1', 'Hotel', '+15551111111');
  const family = createFamilyInvitation(event.id, 'Patel Family', 3);

  const eventPrefill = `${PREFILL} ${event.rsvp_code}`;
  const familyPrefill = `${PREFILL} ${family.rsvp_code}`;
  const longLink = buildRsvpWhatsAppLink(event.rsvp_code, '+15551234567');

  assert.equal(parseRsvpLinkToken(eventPrefill), event.rsvp_code);
  assert.equal(parseRsvpLinkToken(familyPrefill), family.rsvp_code);
  assert.equal(lookupRsvpLinkTarget(event.rsvp_code)?.event.id, event.id);
  assert.equal(lookupRsvpLinkTarget(event.rsvp_token)?.event.id, event.id);
  assert.equal(findEventByRsvpToken(event.rsvp_token)?.id, event.id);
  assert.equal(findEventByRsvpCode(event.rsvp_code)?.id, event.id);
  assert.equal(lookupRsvpLinkTarget(family.rsvp_code ?? '')?.invitation?.id, family.id);
  assert.ok(longLink?.startsWith('https://wa.me/'));
  assert.match(longLink ?? '', /Code%3A/);
  closeDb();
});

test('schema.sql does not crash existing events tables that lack short_code', () => {
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      date TEXT NOT NULL,
      location TEXT NOT NULL,
      organizer_phone TEXT NOT NULL,
      rsvp_token TEXT UNIQUE,
      rsvp_code TEXT UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE invitations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      family_name TEXT,
      group_name TEXT,
      max_guests INTEGER,
      rsvp_code TEXT UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO events (name, date, location, organizer_phone, rsvp_token, rsvp_code)
    VALUES ('Legacy', 'May 1', 'Garden', '+15551111111', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'LEGACY01');
    INSERT INTO invitations (event_id, type, family_name, max_guests, rsvp_code)
    VALUES (1, 'family', 'Lee Family', 2, 'FAMCODE1');
  `);

  const schemaPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '../src/db/schema.sql',
  );
  assert.doesNotThrow(() => database.exec(fs.readFileSync(schemaPath, 'utf8')));
  assert.doesNotThrow(() => ensureInvitationTables(database));
  assert.doesNotThrow(() => ensureShortCodeColumns(database));

  const event = database
    .prepare(`SELECT rsvp_token, rsvp_code, short_code FROM events WHERE id = 1`)
    .get() as { rsvp_token: string; rsvp_code: string; short_code: string };
  const family = database
    .prepare(`SELECT rsvp_code, short_code FROM invitations WHERE id = 1`)
    .get() as { rsvp_code: string; short_code: string };

  assert.equal(event.rsvp_token, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(event.rsvp_code, 'LEGACY01');
  assert.match(event.short_code, SHORT_CODE_RE);
  assert.equal(family.rsvp_code, 'FAMCODE1');
  assert.match(family.short_code, SHORT_CODE_RE);
  database.close();
});

test('existing events keep tokens and codes; backfill does not overwrite short codes', () => {
  getDb();
  const event = createEvent('Existing', 'May 1', 'Garden', '+15551111111');
  const family = createFamilyInvitation(event.id, 'Lee Family', 2);
  const token = event.rsvp_token;
  const rsvpCode = event.rsvp_code;
  const eventShort = event.short_code;
  const familyShort = family.short_code;
  const familyRsvp = family.rsvp_code;

  ensureShortCodeColumns();
  const refreshedEvent = findEventByRsvpToken(token);
  const refreshedFamily = lookupShortRsvpTarget(familyShort ?? '')?.invitation;

  assert.equal(refreshedEvent?.rsvp_token, token);
  assert.equal(refreshedEvent?.rsvp_code, rsvpCode);
  assert.equal(refreshedEvent?.short_code, eventShort);
  assert.equal(refreshedFamily?.rsvp_code, familyRsvp);
  assert.equal(refreshedFamily?.short_code, familyShort);

  getDb()
    .prepare(`UPDATE events SET short_code = NULL WHERE id = ?`)
    .run(event.id);
  getDb()
    .prepare(`UPDATE invitations SET short_code = NULL WHERE id = ?`)
    .run(family.id);
  ensureShortCodeColumns();

  const backfilledEvent = findEventByRsvpToken(token);
  const backfilledFamily = lookupRsvpLinkTarget(familyRsvp ?? '')?.invitation;
  assert.equal(backfilledEvent?.rsvp_token, token);
  assert.equal(backfilledEvent?.rsvp_code, rsvpCode);
  assert.ok(backfilledEvent?.short_code);
  assert.match(backfilledEvent?.short_code ?? '', SHORT_CODE_RE);
  assert.ok(backfilledFamily?.short_code);
  assert.match(backfilledFamily?.short_code ?? '', SHORT_CODE_RE);
  assert.equal(backfilledFamily?.rsvp_code, familyRsvp);
  closeDb();
});
