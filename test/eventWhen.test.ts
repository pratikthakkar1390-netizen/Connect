import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import {
  closeDb,
  createEvent,
  getConversationState,
  getDb,
  getEventById,
  lookupEventWhenTokenByShortCode,
  setConversationState,
  upsertMessageSession,
} from '../src/db/store.js';
import {
  TIME_PROMPT,
  CHILDREN_POLICY_PROMPT,
  continueCreateEventFlow,
  setCreateEventMessageSender,
} from '../src/commands/createEventFlow.js';
import {
  formatEditDateQuestion,
  setEventUpdateMessageSender,
} from '../src/commands/eventUpdateFlow.js';
import {
  eventWhenRouter,
  formatPickedTime,
  isoDateToLongDate,
  setEventWhenMessageSender,
} from '../src/http/eventWhen.js';
import {
  eventWhenPickerUrl,
  signEventWhenToken,
  verifyEventWhenToken,
} from '../src/http/eventWhenToken.js';
import {
  getEventCalendarDay,
  parseEventDate,
  todayInEventTimezone,
} from '../src/dates/eventDate.js';
import { formatShareRsvpInvitation } from '../src/commands/invitationMessage.js';
import { formatEditedEventReview, formatInfoUpdateMessage } from '../src/commands/eventUpdateMessage.js';
import { renderRsvpPage } from '../src/http/rsvpPage.js';
import type { SendMessageParams } from '../src/zernio/client.js';

process.env.DATABASE_PATH = ':memory:';
process.env.WEBHOOK_SECRET = 'event-when-test-secret';

const PHONE = '+15551117777';
const ctx = {
  phone: PHONE,
  conversationId: 'conv-when',
  accountId: 'acct-when',
};

const sent: SendMessageParams[] = [];

function previousIsoDate(iso: string): string {
  const [year, month, day] = iso.split('-').map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day - 1));
  const y = utc.getUTCFullYear();
  const m = String(utc.getUTCMonth() + 1).padStart(2, '0');
  const d = String(utc.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function nextIsoDate(iso: string): string {
  const [year, month, day] = iso.split('-').map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day + 1));
  const y = utc.getUTCFullYear();
  const m = String(utc.getUTCMonth() + 1).padStart(2, '0');
  const d = String(utc.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function withWhenServer(fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(eventWhenRouter);
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

async function postWhen(
  url: string,
  body: Record<string, string>,
): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
    redirect: 'manual',
  });
}

test.beforeEach(() => {
  getDb();
  sent.length = 0;
  setEventWhenMessageSender(async (params) => {
    sent.push(params);
  });
  setCreateEventMessageSender(async (params) => {
    sent.push(params);
  });
  setEventUpdateMessageSender(async (params) => {
    sent.push(params);
  });
});

test.afterEach(() => {
  setEventWhenMessageSender();
  setCreateEventMessageSender();
  setEventUpdateMessageSender();
  closeDb();
});

test('signed picker token encodes phone + step and rejects tampering', () => {
  const token = signEventWhenToken(PHONE, 'date');
  const payload = verifyEventWhenToken(token);
  assert.deepEqual(payload && { phone: payload.phone, step: payload.step }, {
    phone: PHONE,
    step: 'date',
  });
  assert.equal(verifyEventWhenToken(token.slice(0, -2) + 'xx'), null);
  assert.equal(verifyEventWhenToken(token, Date.now() + 3 * 60 * 60 * 1000), null);
});

test('iso date converts without Date.parse so chrono keeps the calendar day', () => {
  assert.equal(isoDateToLongDate('2026-09-20'), 'September 20, 2026');
  assert.equal(isoDateToLongDate('yesterday'), null);
  assert.equal(formatPickedTime('7', '30', 'PM'), '7:30 PM');
  assert.equal(formatPickedTime('12', '00', 'AM'), '12:00 AM');
  assert.equal(formatPickedTime('13', '00', 'PM'), null);
});

test('calendar rejects a past date and stays on the date step', async () => {
  setConversationState(PHONE, 'WAITING_FOR_EVENT_DATE', { name: 'Wedding' });
  const token = signEventWhenToken(PHONE, 'date');
  const today = todayInEventTimezone();
  const yesterday = previousIsoDate(today);

  await withWhenServer(async (baseUrl) => {
    const res = await postWhen(`${baseUrl}/when/${token}`, {
      step: 'date',
      date: yesterday,
    });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /in the past/i);
    assert.match(html, /id="date-form"/);
    assert.doesNotMatch(html, /id="time-form"/);
    assert.doesNotMatch(html, /Is this correct/i);
  });

  assert.equal(getConversationState(PHONE)?.state, 'WAITING_FOR_EVENT_DATE');
  assert.equal(sent.length, 0);
});

test('calendar date then time picker continue without a correctness confirm', async () => {
  setConversationState(PHONE, 'WAITING_FOR_EVENT_DATE', { name: 'Wedding' });
  upsertMessageSession(PHONE, ctx.conversationId, ctx.accountId);
  const dateToken = signEventWhenToken(PHONE, 'date');
  const today = todayInEventTimezone();
  const future = nextIsoDate(today);

  await withWhenServer(async (baseUrl) => {
    const dateRes = await postWhen(`${baseUrl}/when/${dateToken}`, {
      step: 'date',
      date: future,
    });
    assert.equal(dateRes.status, 303);
    const location = dateRes.headers.get('location');
    assert.ok(location?.startsWith('/d/'));

    const afterDate = getConversationState(PHONE);
    assert.equal(afterDate?.state, 'WAITING_FOR_EVENT_TIME');
    assert.ok(afterDate?.date);
    assert.doesNotMatch(afterDate?.date ?? '', / at /);
    assert.equal(sent.length, 1);
    assert.ok(sent[0].message.includes(TIME_PROMPT));
    assert.match(sent[0].message, /\/d\//);
    assert.doesNotMatch(sent[0].message, /Is this correct/i);

    const timePage = await fetch(`${baseUrl}${location}`);
    assert.equal(timePage.status, 200);
    const timeHtml = await timePage.text();
    assert.match(timeHtml, /id="time-form"/);
    assert.match(timeHtml, /CONNECT/);
    assert.match(timeHtml, /name="hour"/);
    assert.match(timeHtml, /name="minute"/);
    assert.match(timeHtml, /name="meridiem"/);

    const timeRes = await postWhen(`${baseUrl}${location}`, {
      step: 'time',
      hour: '7',
      minute: '30',
      meridiem: 'PM',
    });
    assert.equal(timeRes.status, 200);
    const doneHtml = await timeRes.text();
    assert.match(doneHtml, /Return to WhatsApp/i);
    assert.doesNotMatch(doneHtml, /Is this correct/i);
  });

  const afterTime = getConversationState(PHONE);
  assert.equal(afterTime?.state, 'WAITING_FOR_EVENT_LOCATION');
  assert.match(afterTime?.date ?? '', /7:30\s*PM/i);
  assert.match(sent.at(-1)?.message ?? '', /Where will \*Wedding\* be held/);
});

test('one web page can save date and time together and skip the Saved dead-end', async () => {
  setConversationState(PHONE, 'WAITING_FOR_EVENT_DATE', { name: 'Wedding' });
  upsertMessageSession(PHONE, ctx.conversationId, ctx.accountId);
  const dateToken = signEventWhenToken(PHONE, 'date');
  const today = todayInEventTimezone();
  const future = nextIsoDate(today);

  await withWhenServer(async (baseUrl) => {
    const getRes = await fetch(`${baseUrl}/when/${dateToken}`);
    assert.equal(getRes.status, 200);
    const getHtml = await getRes.text();
    assert.match(getHtml, /id="date-form"/);
    assert.match(getHtml, /name="hour"/);
    assert.match(getHtml, /name="minute"/);
    assert.match(getHtml, /name="meridiem"/);
    assert.doesNotMatch(getHtml, /id="time-form"/);

    const res = await postWhen(`${baseUrl}/when/${dateToken}`, {
      step: 'date',
      date: future,
      hour: '7',
      minute: '30',
      meridiem: 'PM',
    });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Return to WhatsApp/);
    assert.doesNotMatch(html, />Saved</);
    assert.doesNotMatch(html, /Is this correct/i);
  });

  const state = getConversationState(PHONE);
  assert.equal(state?.state, 'WAITING_FOR_EVENT_LOCATION');
  assert.match(state?.date ?? '', /7:30\s*PM/i);
  assert.match(sent.at(-1)?.message ?? '', /Where will \*Wedding\* be held/);
});

test('typed date fallback still uses parseEventDate and moves to time', async () => {
  setConversationState(PHONE, 'WAITING_FOR_EVENT_DATE', { name: 'Wedding' });

  await continueCreateEventFlow(ctx, 'September 20');

  const state = getConversationState(PHONE);
  assert.equal(state?.state, 'WAITING_FOR_EVENT_TIME');
  assert.equal(state?.date, 'Sunday, September 20, 2026');
  assert.ok(sent.at(-1)?.message.includes(TIME_PROMPT));
});

test('typed time fallback still uses parseEventTime', async () => {
  setConversationState(PHONE, 'WAITING_FOR_EVENT_TIME', {
    name: 'Wedding',
    date: 'Sunday, September 20, 2026',
  });

  await continueCreateEventFlow(ctx, '7:30 PM');

  const state = getConversationState(PHONE);
  assert.equal(state?.state, 'WAITING_FOR_EVENT_LOCATION');
  assert.equal(state?.date, 'Sunday, September 20, 2026 at 7:30 PM');
});

test('invalid picker time stays on the time step with an explanation', async () => {
  setConversationState(PHONE, 'WAITING_FOR_EVENT_TIME', {
    name: 'Wedding',
    date: 'Sunday, September 20, 2026',
  });
  const token = signEventWhenToken(PHONE, 'time');

  await withWhenServer(async (baseUrl) => {
    const res = await postWhen(`${baseUrl}/when/${token}`, {
      step: 'time',
      hour: '99',
      minute: '30',
      meridiem: 'PM',
    });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /id="time-form"/);
    assert.match(html, /hour, minute, and AM or PM/i);
    assert.doesNotMatch(html, /Is this correct/i);
  });

  assert.equal(getConversationState(PHONE)?.state, 'WAITING_FOR_EVENT_TIME');
  assert.equal(getConversationState(PHONE)?.date, 'Sunday, September 20, 2026');
});

test('invalid picker token stays unavailable and does not change draft state', async () => {
  setConversationState(PHONE, 'WAITING_FOR_EVENT_DATE', { name: 'Wedding' });

  await withWhenServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/when/not-a-token`);
    assert.equal(res.status, 404);
    const html = await res.text();
    assert.match(html, /isn.t available/i);
  });

  assert.equal(getConversationState(PHONE)?.state, 'WAITING_FOR_EVENT_DATE');
});

test('edit date and time pickers reuse /when tokens and keep create-event states untouched', async () => {
  const event = createEvent(
    'Katha Night',
    'Thursday, October 1, 2026 at 5:00 PM',
    'Community Center',
    PHONE,
  );
  setConversationState(PHONE, 'WAITING_FOR_EDIT_DATE', {
    event_id: event.id,
    name: 'Katha Night',
    date: event.date,
    location: event.location,
  });
  upsertMessageSession(PHONE, ctx.conversationId, ctx.accountId);
  const dateToken = signEventWhenToken(PHONE, 'date');
  const today = todayInEventTimezone();
  const future = nextIsoDate(today);
  assert.match(formatEditDateQuestion(PHONE, 'Katha Night', 'Thursday, October 1, 2026 at 5:00 PM'), /\/d\//);

  await withWhenServer(async (baseUrl) => {
    const dateRes = await postWhen(`${baseUrl}/when/${dateToken}`, {
      step: 'date',
      date: future,
    });
    assert.equal(dateRes.status, 303);
    const location = dateRes.headers.get('location');
    assert.ok(location?.startsWith('/d/'));
    assert.equal(getConversationState(PHONE)?.state, 'WAITING_FOR_EDIT_TIME');
    assert.doesNotMatch(getConversationState(PHONE)?.date ?? '', / at /);
    assert.match(sent.at(-1)?.message ?? '', /Pick a time/);

    const timeRes = await postWhen(`${baseUrl}${location}`, {
      step: 'time',
      hour: '6',
      minute: '30',
      meridiem: 'PM',
    });
    assert.equal(timeRes.status, 200);
    assert.match(await timeRes.text(), /Return to WhatsApp/i);
  });

  assert.equal(getConversationState(PHONE), undefined);
  const latest = getEventById(event.id);
  assert.equal(latest?.location, 'Community Center');
  assert.match(latest?.date ?? '', /6:30\s*PM/i);
  assert.match(sent.at(-1)?.message ?? '', /Event updated/);
});

test('deadline calendar accepts a date then asks for time without a confirm', async () => {
  const eventParsed = parseEventDate('in 8 weeks at 7:30 PM');
  assert.equal(eventParsed.ok, true);
  const eventDate = eventParsed.ok ? eventParsed.formatted : '';
  setConversationState(PHONE, 'WAITING_FOR_RSVP_DEADLINE', {
    name: 'Wedding',
    date: eventDate,
    location: 'Hall',
  });
  upsertMessageSession(PHONE, ctx.conversationId, ctx.accountId);
  const token = signEventWhenToken(PHONE, 'deadline');
  const today = todayInEventTimezone();
  const beforeEvent = nextIsoDate(today);

  await withWhenServer(async (baseUrl) => {
    const getRes = await fetch(`${baseUrl}/when/${token}`);
    assert.equal(getRes.status, 200);
    const getHtml = await getRes.text();
    assert.match(getHtml, /When should RSVPs close/);
    assert.match(getHtml, /RSVP deadline must be before the event/);
    assert.match(getHtml, /name="step" value="deadline"/);
    assert.doesNotMatch(getHtml, /id="time-form"/);

    const res = await postWhen(`${baseUrl}/when/${token}`, {
      step: 'deadline',
      date: beforeEvent,
    });
    assert.equal(res.status, 303);
    const location = res.headers.get('location');
    assert.ok(location?.startsWith('/d/'));

    const timePage = await fetch(`${baseUrl}${location}`);
    assert.equal(timePage.status, 200);
    const timeHtml = await timePage.text();
    assert.match(timeHtml, /id="time-form"/);
    assert.match(timeHtml, /What time should RSVPs close/);
    assert.doesNotMatch(timeHtml, /Is this correct/i);

    const timeRes = await postWhen(`${baseUrl}${location}`, {
      step: 'time',
      hour: '5',
      minute: '00',
      meridiem: 'PM',
    });
    assert.equal(timeRes.status, 200);
    assert.match(await timeRes.text(), /Return to WhatsApp/i);
  });

  const state = getConversationState(PHONE);
  assert.equal(state?.state, 'WAITING_FOR_CHILDREN_POLICY');
  assert.match(state?.rsvp_deadline ?? '', /\d{4}/);
  assert.match(state?.rsvp_deadline ?? '', /5:00\s*PM/i);
  assert.equal(sent.at(-1)?.message, CHILDREN_POLICY_PROMPT);
  assert.doesNotMatch(sent.at(-1)?.message ?? '', /Is this correct/i);
});

test('deadline calendar rejects a date after the event', async () => {
  const eventParsed = parseEventDate('in 8 weeks at 7:30 PM');
  assert.equal(eventParsed.ok, true);
  const eventDate = eventParsed.ok ? eventParsed.formatted : '';
  const eventDay = getEventCalendarDay(eventDate);
  assert.ok(eventDay);
  const afterEvent = nextIsoDate(eventDay);
  setConversationState(PHONE, 'WAITING_FOR_RSVP_DEADLINE', {
    name: 'Wedding',
    date: eventDate,
    location: 'Hall',
  });
  const token = signEventWhenToken(PHONE, 'deadline');

  await withWhenServer(async (baseUrl) => {
    const res = await postWhen(`${baseUrl}/when/${token}`, {
      step: 'deadline',
      date: afterEvent,
    });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /RSVP deadline must be before the event/);
    assert.match(html, /id="date-form"/);
    assert.doesNotMatch(html, /id="time-form"/);
  });

  assert.equal(
    getConversationState(PHONE)?.state,
    'WAITING_FOR_RSVP_DEADLINE',
  );
  assert.equal(sent.length, 0);
});

test('deadline time on or after the event stays on the time step', async () => {
  const eventDate = 'Sunday, September 20, 2026 at 7:00 PM';
  setConversationState(PHONE, 'WAITING_FOR_RSVP_DEADLINE', {
    name: 'Wedding',
    date: eventDate,
    location: 'Hall',
    rsvp_deadline: 'Sunday, September 20, 2026',
  });
  const token = signEventWhenToken(PHONE, 'time');

  await withWhenServer(async (baseUrl) => {
    const res = await postWhen(`${baseUrl}/when/${token}`, {
      step: 'time',
      hour: '7',
      minute: '00',
      meridiem: 'PM',
    });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /id="time-form"/);
    assert.match(html, /RSVP deadline must be before the event/);
    assert.doesNotMatch(html, /Is this correct/i);
  });

  assert.equal(
    getConversationState(PHONE)?.state,
    'WAITING_FOR_RSVP_DEADLINE',
  );
  assert.equal(
    getConversationState(PHONE)?.rsvp_deadline,
    'Sunday, September 20, 2026',
  );
});

test('short picker URL uses 8 Crockford chars and maps to the signed token', async () => {
  setConversationState(PHONE, 'WAITING_FOR_EVENT_DATE', { name: 'Wedding' });
  const url = eventWhenPickerUrl(PHONE, 'date');
  assert.match(
    url,
    /^https:\/\/connect\.zip-bite\.com\/d\/[0-9A-HJKMNP-TV-Z]{8}$/,
  );
  const code = url.slice(url.lastIndexOf('/') + 1);
  assert.notEqual(code, PHONE);
  const token = lookupEventWhenTokenByShortCode(code);
  assert.ok(token);
  const payload = verifyEventWhenToken(token);
  assert.equal(payload?.phone, PHONE);
  assert.equal(payload?.step, 'date');

  await withWhenServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/d/${code}`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /id="date-form"/);
  });
});

test('invalid and expired short picker links stay unavailable', async () => {
  setConversationState(PHONE, 'WAITING_FOR_EVENT_DATE', { name: 'Wedding' });

  await withWhenServer(async (baseUrl) => {
    const missing = await fetch(`${baseUrl}/d/NOTFOUND`);
    assert.equal(missing.status, 404);
    assert.match(await missing.text(), /isn.t available/i);

    const expiredCode = 'EXPIRED1';
    getDb()
      .prepare(
        `INSERT INTO event_when_codes (short_code, token, expires_at) VALUES (?, ?, ?)`,
      )
      .run(expiredCode, signEventWhenToken(PHONE, 'date'), Date.now() - 1000);
    const expired = await fetch(`${baseUrl}/d/${expiredCode}`);
    assert.equal(expired.status, 404);
  });

  assert.equal(getConversationState(PHONE)?.state, 'WAITING_FOR_EVENT_DATE');
});

test('7:00 PM from the picker stays 7:00 PM on invitation, RSVP page, edit, and updates', async () => {
  setConversationState(PHONE, 'WAITING_FOR_EVENT_TIME', {
    name: 'Wedding',
    date: 'Sunday, September 20, 2026',
  });
  upsertMessageSession(PHONE, ctx.conversationId, ctx.accountId);
  const token = signEventWhenToken(PHONE, 'time');

  await withWhenServer(async (baseUrl) => {
    const timeRes = await postWhen(`${baseUrl}/when/${token}`, {
      step: 'time',
      hour: '7',
      minute: '00',
      meridiem: 'PM',
    });
    assert.equal(timeRes.status, 200);
  });

  const draft = getConversationState(PHONE);
  assert.equal(draft?.date, 'Sunday, September 20, 2026 at 7:00 PM');
  assert.doesNotMatch(draft?.date ?? '', /3:00\s*PM/i);

  const event = createEvent(
    'Wedding',
    draft?.date ?? '',
    'Hall',
    PHONE,
  );
  assert.equal(event.date, 'Sunday, September 20, 2026 at 7:00 PM');
  assert.match(event.date, /September 20, 2026/);
  assert.match(event.date, /7:00\s*PM/i);
  assert.doesNotMatch(event.date, /3:00\s*PM/i);
  assert.doesNotMatch(event.date, /7:00\s*AM/i);

  const invitation = formatShareRsvpInvitation(event, 'https://connect.zip-bite.com/r/TESTCODE');
  assert.match(invitation, /7:00\s*PM/i);
  assert.doesNotMatch(invitation, /3:00\s*PM/i);

  const rsvpHtml = renderRsvpPage(event, {
    askCounts: false,
    adults: 1,
    children: 0,
    maxGuests: null,
    childrenAllowed: true,
  });
  assert.match(rsvpHtml, /7:00\s*PM/i);
  assert.doesNotMatch(rsvpHtml, /3:00\s*PM/i);

  assert.match(formatEditedEventReview(event), /7:00\s*PM/i);
  assert.doesNotMatch(formatEditedEventReview(event), /3:00\s*PM/i);
  assert.match(formatInfoUpdateMessage(event, 'Parking update'), /7:00\s*PM/i);
  assert.doesNotMatch(formatInfoUpdateMessage(event), /3:00\s*PM/i);

  setConversationState(PHONE, 'WAITING_FOR_EDIT_DATE', {
    event_id: event.id,
    name: event.name,
    date: event.date,
    location: event.location,
  });
  assert.match(formatEditDateQuestion(PHONE, event.name, event.date), /7:00\s*PM/i);
  assert.doesNotMatch(formatEditDateQuestion(PHONE, event.name, event.date), /3:00\s*PM/i);
});
