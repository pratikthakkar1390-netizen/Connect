import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import {
  closeDb,
  createEvent,
  ensureEventTimezoneColumns,
  getConversationState,
  getDb,
  getEventById,
  isRsvpDeadlinePassed,
  listEventsForOrganizer,
  setConversationState,
  updateEventDetails,
  upsertMessageSession,
} from '../src/db/store.js';
import {
  CONFIRM_EVENT,
  continueCreateEventFlow,
  explicitConversationTimezone,
  TIMEZONE_PROMPT,
  timezoneChoiceList,
  applyPickedEventTimezone,
  setCreateEventMessageSender,
} from '../src/commands/createEventFlow.js';
import {
  formatEventTimezoneLine,
  getEventInstantMs,
  isCalendarDayAfterEvent,
  isValidZonedWallTime,
  parseEventDate,
  parseRsvpDeadline,
  reminderWindowStartMs,
  resolveEventSchedule,
  resolveEventTimezone,
  zonedWallTimeFromInstant,
} from '../src/dates/eventDate.js';
import { isReminderDue } from '../src/reminders/targeting.js';
import { shouldSendOrganizerPostEvent } from '../src/reminders/scheduler.js';
import {
  formatTimezoneLabel,
  searchTimezoneCities,
  TIMEZONE_CITIES,
  TIMEZONE_QUICK_SELECT,
} from '../src/timezones/catalog.js';
import { eventTimezoneRouter } from '../src/http/eventTimezone.js';
import { eventTimezonePickerUrl, signEventTimezoneToken } from '../src/http/eventTimezoneToken.js';
import { formatShareRsvpInvitation } from '../src/commands/invitationMessage.js';
import type { SendMessageParams } from '../src/zernio/client.js';

process.env.DATABASE_PATH = ':memory:';
process.env.WEBHOOK_SECRET = 'event-timezone-test-secret';

const PHONE = '+15551119991';
const ctx = {
  phone: PHONE,
  conversationId: 'conv-tz',
  accountId: 'acct-tz',
};
const sent: SendMessageParams[] = [];

test.beforeEach(() => {
  closeDb();
  getDb();
  sent.length = 0;
  setCreateEventMessageSender(async (params) => {
    sent.push(params);
  });
});

test.after(() => {
  closeDb();
});

const ZONES = [
  'America/New_York',
  'America/Los_Angeles',
  'Europe/London',
  'Asia/Kolkata',
  'Australia/Sydney',
] as const;

const SEVEN_PM = 'Thursday, October 15, 2026 at 7:00 PM';

function withTzServer(fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(eventTimezoneRouter);
  const server = http.createServer(app);
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('no listen address'));
        return;
      }
      void fn(`http://127.0.0.1:${address.port}`)
        .then(resolve, reject)
        .finally(() => server.close());
    });
  });
}

test('WhatsApp timezone prompt and quick-select rows match the approved copy', async () => {
  setConversationState(PHONE, 'WAITING_FOR_EVENT_NAME');
  await continueCreateEventFlow(ctx, 'Diwali Dinner');
  assert.equal(getConversationState(PHONE)?.state, 'WAITING_FOR_EVENT_TIMEZONE');
  assert.equal(lastMessage().message, TIMEZONE_PROMPT);
  assert.deepEqual(
    timezoneChoiceList().sections[0].rows.map((row) => row.title),
    [
      'New York (Eastern)',
      'Chicago (Central)',
      'Denver (Mountain)',
      'Los Angeles (Pacific)',
      'London',
      'India',
      'Sydney',
      'More cities',
    ],
  );
  assert.equal(TIMEZONE_QUICK_SELECT.length, 8);
  assert.ok(TIMEZONE_CITIES.length > TIMEZONE_QUICK_SELECT.length);
});

test('quick-select India stores Asia/Kolkata and continues to the date step', async () => {
  setConversationState(PHONE, 'WAITING_FOR_EVENT_TIMEZONE', { name: 'Diwali Dinner' });
  upsertMessageSession(PHONE, ctx.conversationId, ctx.accountId);
  await continueCreateEventFlow(ctx, 'TZ:Asia/Kolkata');
  const state = getConversationState(PHONE);
  assert.equal(state?.state, 'WAITING_FOR_EVENT_DATE');
  assert.equal(state?.timezone, 'Asia/Kolkata');
  assert.match(lastMessage().message, /India Time/);
  assert.doesNotMatch(lastMessage().message, /Asia\/Kolkata/);
});

test('More cities replies with the signed web picker URL', async () => {
  setConversationState(PHONE, 'WAITING_FOR_EVENT_TIMEZONE', { name: 'Party' });
  await continueCreateEventFlow(ctx, 'TZ_MORE');
  assert.equal(getConversationState(PHONE)?.state, 'WAITING_FOR_EVENT_TIMEZONE');
  assert.match(lastMessage().message, /Search any city worldwide/);
  assert.match(lastMessage().message, /\/tz\//);
  assert.match(eventTimezonePickerUrl(PHONE), /\/tz\//);
});

test('catalog search finds aliases such as Mumbai/Bombay without exposing IANA in labels', () => {
  const mumbai = searchTimezoneCities('Mumbai');
  const bombay = searchTimezoneCities('Bombay');
  assert.ok(mumbai.some((hit) => hit.iana === 'Asia/Kolkata' && hit.city === 'Mumbai'));
  assert.ok(bombay.some((hit) => hit.iana === 'Asia/Kolkata'));
  for (const hit of [...mumbai, ...bombay]) {
    assert.doesNotMatch(hit.label, /\//);
    assert.doesNotMatch(hit.city, /Asia\//);
  }
  assert.ok(searchTimezoneCities('Auckland').length > 0);
  assert.ok(searchTimezoneCities('Buenos Aires').length > 0);
  assert.equal(formatTimezoneLabel('America/Los_Angeles'), 'Pacific Time');
  assert.doesNotMatch(formatTimezoneLabel('America/Los_Angeles'), /America\//);
});

test('two events at 7:00 PM on the same calendar date keep wall.hour === 19 in all five zones', () => {
  const instants = new Set<string>();
  for (const timezone of ZONES) {
    const schedule = resolveEventSchedule(SEVEN_PM, { timezone });
    assert.ok(schedule);
    assert.equal(schedule.wall.hour, 19);
    assert.equal(schedule.wall.minute, 0);
    assert.equal(schedule.timezone, timezone);
    assert.match(schedule.instant.toISOString(), /Z$/);
    instants.add(schedule.instant.toISOString());
    const parsed = parseEventDate(SEVEN_PM, { timezone });
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.match(parsed.formatted, /7:00\s*PM/);
      assert.doesNotMatch(parsed.formatted, /10:00\s*PM/);
    }
  }
  assert.equal(instants.size, ZONES.length);
  const ny = getEventInstantMs(SEVEN_PM, { timezone: 'America/New_York' });
  const la = getEventInstantMs(SEVEN_PM, { timezone: 'America/Los_Angeles' });
  assert.ok(ny != null && la != null);
  assert.equal(la - ny, 3 * 60 * 60 * 1000);
});

test('DST transitions keep 7:00 PM wall clock in New York and London', () => {
  const edt = resolveEventSchedule('Sunday, March 8, 2026 at 7:00 PM', {
    timezone: 'America/New_York',
  });
  const est = resolveEventSchedule('Sunday, November 1, 2026 at 7:00 PM', {
    timezone: 'America/New_York',
  });
  assert.ok(edt && est);
  assert.equal(edt.wall.hour, 19);
  assert.equal(est.wall.hour, 19);
  assert.notEqual(edt.instant.toISOString(), est.instant.toISOString());

  const bst = resolveEventSchedule('Sunday, March 29, 2026 at 7:00 PM', {
    timezone: 'Europe/London',
  });
  const gmt = resolveEventSchedule('Sunday, October 25, 2026 at 7:00 PM', {
    timezone: 'Europe/London',
  });
  assert.ok(bst && gmt);
  assert.equal(bst.wall.hour, 19);
  assert.equal(gmt.wall.hour, 19);
});

test('future dates months ahead parse in Sydney and Kolkata', () => {
  const sydney = parseEventDate('March 20, 2027 at 7:00 PM', {
    timezone: 'Australia/Sydney',
    reference: new Date('2026-09-19T12:00:00.000Z'),
  });
  assert.equal(sydney.ok, true);
  if (sydney.ok) {
    assert.match(sydney.formatted, /March 20, 2027/);
    assert.match(sydney.formatted, /7:00\s*PM/);
  }
  const india = resolveEventSchedule('Friday, January 15, 2027 at 7:00 PM', {
    timezone: 'Asia/Kolkata',
  });
  assert.ok(india);
  assert.equal(india.wall.hour, 19);
  assert.equal(india.instant.toISOString(), '2027-01-15T13:30:00.000Z');
});

test('invalid DST gap times are rejected; fall-back evenings remain 7:00 PM', () => {
  assert.equal(
    isValidZonedWallTime(
      { year: 2026, month: 3, day: 8, hour: 2, minute: 30, second: 0 },
      'America/New_York',
    ),
    false,
  );
  const gap = parseEventDate('March 8, 2026 at 2:30 AM', {
    timezone: 'America/New_York',
  });
  assert.equal(gap.ok, false);

  const evening = parseEventDate('November 1, 2026 at 7:00 PM', {
    timezone: 'America/New_York',
  });
  assert.equal(evening.ok, true);
});

test('RSVP date-only deadlines close at 11:59:59 PM in the event timezone', () => {
  const deadline = parseRsvpDeadline('October 10, 2026', {
    timezone: 'America/Los_Angeles',
    eventDate: SEVEN_PM,
  });
  assert.equal(deadline.ok, true);
  if (deadline.ok) {
    const wall = zonedWallTimeFromInstant(new Date(deadline.instantMs), 'America/Los_Angeles');
    assert.equal(wall.hour, 23);
    assert.equal(wall.minute, 59);
    assert.equal(wall.second, 59);
    assert.equal(wall.day, 10);
  }
  const timed = parseRsvpDeadline('October 10, 2026 at 5:00 PM', {
    timezone: 'Asia/Kolkata',
    eventDate: SEVEN_PM,
  });
  assert.equal(timed.ok, true);
  if (timed.ok) {
    const wall = zonedWallTimeFromInstant(new Date(timed.instantMs), 'Asia/Kolkata');
    assert.equal(wall.hour, 17);
  }

  const event = createEvent('Gala', SEVEN_PM, 'Hall', PHONE, {
    timezone: 'America/Los_Angeles',
    rsvpDeadline: 'October 10, 2026',
  });
  assert.equal(
    isRsvpDeadlinePassed(event.rsvp_deadline, {
      eventDate: event.date,
      timezone: event.timezone ?? undefined,
      now: new Date('2026-10-11T06:59:59.000Z'),
    }),
    false,
  );
  assert.equal(
    isRsvpDeadlinePassed(event.rsvp_deadline, {
      eventDate: event.date,
      timezone: event.timezone ?? undefined,
      now: new Date('2026-10-11T07:00:00.000Z'),
    }),
    true,
  );
});

test('reminder windows subtract N calendar days in the event timezone, not N*86400000', () => {
  const deadline = 'Sunday, March 8, 2026 at 7:00 PM';
  const timezone = 'America/New_York';
  const start = reminderWindowStartMs(deadline, 1, { timezone });
  assert.ok(start != null);
  const naive = Date.parse('2026-03-08T23:00:00.000Z') - 86_400_000;
  assert.notEqual(start, naive);
  const wall = zonedWallTimeFromInstant(new Date(start), timezone);
  assert.equal(wall.day, 7);
  assert.equal(wall.hour, 19);

  assert.equal(
    isReminderDue({
      nowMs: Date.parse('2026-03-08T00:00:00.000Z'),
      deadline,
      reminderDays: 1,
      reminderSentAt: null,
      timezone,
    }),
    true,
  );
  assert.equal(
    isReminderDue({
      nowMs: Date.parse('2026-03-07T23:00:00.000Z'),
      deadline,
      reminderDays: 1,
      reminderSentAt: null,
      timezone,
    }),
    false,
  );
  assert.equal(
    isReminderDue({
      nowMs: Date.parse('2026-03-07T23:00:00.000Z'),
      deadline,
      reminderDays: 1,
      reminderSentAt: 'already',
      timezone,
    }),
    false,
  );
});

test('post-event calculations use the event timezone calendar day', () => {
  const event = createEvent('Gala', SEVEN_PM, 'Hall', PHONE, {
    timezone: 'Australia/Sydney',
  });
  assert.equal(
    isCalendarDayAfterEvent(event.date, Date.parse('2026-10-15T08:00:00.000Z'), event.timezone ?? undefined),
    false,
  );
  assert.equal(
    isCalendarDayAfterEvent(event.date, Date.parse('2026-10-15T14:00:00.000Z'), event.timezone ?? undefined),
    true,
  );
  assert.equal(
    shouldSendOrganizerPostEvent(event, Date.parse('2026-10-15T08:00:00.000Z')),
    false,
  );
});

test('existing events are backfilled with EVENT_TIMEZONE and keep the same wall-clock date', () => {
  const db = getDb();
  db.exec(`UPDATE events SET timezone = NULL`);
  const created = createEvent('Legacy', SEVEN_PM, 'Hall', PHONE);
  db.prepare(`UPDATE events SET timezone = NULL WHERE id = ?`).run(created.id);
  ensureEventTimezoneColumns(db);
  const event = getEventById(created.id);
  assert.ok(event);
  assert.equal(event.timezone, resolveEventTimezone());
  assert.equal(event.date, SEVEN_PM);
  const before = getEventInstantMs(SEVEN_PM, { timezone: 'America/New_York' });
  const after = getEventInstantMs(event.date, { timezone: event.timezone ?? undefined });
  assert.equal(before, after);
});

test('createEvent without an explicit timezone still uses the legacy EVENT_TIMEZONE instant', () => {
  const event = createEvent('Compat', SEVEN_PM, 'Hall', PHONE);
  assert.equal(event.timezone, 'America/New_York');
  assert.equal(
    getEventInstantMs(event.date, { timezone: event.timezone ?? undefined }),
    Date.parse('2026-10-15T23:00:00.000Z'),
  );
});

test('editing timezone keeps 7:00 PM digits and changes the instant', () => {
  const event = createEvent('Gala', SEVEN_PM, 'Hall', PHONE, {
    timezone: 'America/New_York',
  });
  const before = getEventInstantMs(event.date, { timezone: event.timezone ?? undefined });
  const saved = updateEventDetails(event.id, {
    name: event.name,
    date: event.date,
    location: event.location,
    timezone: 'America/Los_Angeles',
  });
  assert.ok(saved);
  assert.equal(saved.date, SEVEN_PM);
  assert.equal(saved.timezone, 'America/Los_Angeles');
  const after = getEventInstantMs(saved.date, { timezone: saved.timezone ?? undefined });
  assert.notEqual(before, after);
  assert.equal(zonedWallTimeFromInstant(new Date(after!), 'America/Los_Angeles').hour, 19);
});

test('invitations show a human timezone label and never IANA or converted clock time', () => {
  const event = createEvent('Gala', SEVEN_PM, 'Hall', PHONE, {
    timezone: 'America/Los_Angeles',
  });
  const invitation = formatShareRsvpInvitation(event, 'https://connect.zip-bite.com/r/ABC12XYZ');
  assert.match(invitation, /📅 Thursday, October 15, 2026 at 7:00 PM/);
  assert.match(invitation, /🌎 Pacific Time/);
  assert.doesNotMatch(invitation, /America\/Los_Angeles/);
  assert.doesNotMatch(invitation, /10:00\s*PM/);
  assert.equal(formatEventTimezoneLine('America/Los_Angeles'), '🌎 Pacific Time');
});

test('More Cities web picker saves the canonical IANA timezone on conversation state', async () => {
  setConversationState(PHONE, 'WAITING_FOR_EVENT_TIMEZONE', { name: 'Worldwide Party' });
  upsertMessageSession(PHONE, ctx.conversationId, ctx.accountId);
  await withTzServer(async (baseUrl) => {
    const token = signEventTimezoneToken(PHONE);
    const search = await fetch(`${baseUrl}/tz/${encodeURIComponent(token)}?q=Bombay`);
    const searchHtml = await search.text();
    assert.match(searchHtml, /Mumbai/);
    assert.doesNotMatch(searchHtml, />Asia\/Kolkata</);
    const posted = await fetch(`${baseUrl}/tz/${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'iana=Asia/Kolkata',
    });
    const done = await posted.text();
    assert.match(done, /India Time/);
    assert.doesNotMatch(done, /Asia\/Kolkata/);
  });
  const state = getConversationState(PHONE);
  assert.equal(state?.timezone, 'Asia/Kolkata');
  assert.equal(state?.state, 'WAITING_FOR_EVENT_DATE');
});

test('applyPickedEventTimezone on edit keeps the stored date string', async () => {
  const event = createEvent('Gala', SEVEN_PM, 'Hall', PHONE, {
    timezone: 'America/New_York',
  });
  setConversationState(PHONE, 'WAITING_FOR_EDIT_TIMEZONE', {
    event_id: event.id,
    name: event.name,
    date: event.date,
    location: event.location,
    timezone: event.timezone,
  });
  upsertMessageSession(PHONE, ctx.conversationId, ctx.accountId);
  const applied = await applyPickedEventTimezone(PHONE, 'America/Los_Angeles');
  assert.equal(applied.ok, true);
  const saved = getEventById(event.id);
  assert.equal(saved?.date, SEVEN_PM);
  assert.equal(saved?.timezone, 'America/Los_Angeles');
});

test('wizard confirm without timezone does not persist a new event', async () => {
  assert.equal(explicitConversationTimezone(null), null);
  assert.equal(explicitConversationTimezone(''), null);
  assert.equal(explicitConversationTimezone('Not/AZone'), null);

  setConversationState(PHONE, 'CONFIRMING_EVENT', {
    name: 'No Zone Party',
    date: SEVEN_PM,
    location: 'Hall',
    children_allowed: 1,
  });
  await continueCreateEventFlow(
    {
      ...ctx,
      interactiveId: CONFIRM_EVENT,
      interactiveType: 'button_reply',
    },
    'Confirm',
  );

  assert.equal(listEventsForOrganizer(PHONE).length, 0);
  assert.equal(getConversationState(PHONE)?.state, 'WAITING_FOR_EVENT_NAME');
  assert.match(lastMessage().message, /start over/i);
});

test('wizard confirm with an explicit IANA timezone persists it on the new event', async () => {
  setConversationState(PHONE, 'CONFIRMING_EVENT', {
    name: 'Sydney Dinner',
    date: SEVEN_PM,
    location: 'Harbour',
    children_allowed: 1,
    timezone: 'Australia/Sydney',
  });
  await continueCreateEventFlow(
    {
      ...ctx,
      interactiveId: CONFIRM_EVENT,
      interactiveType: 'button_reply',
    },
    'Confirm',
  );

  const events = listEventsForOrganizer(PHONE);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.timezone, 'Australia/Sydney');
  assert.ok(events[0]?.timezone?.trim());
  assert.equal(getConversationState(PHONE), undefined);
  const row = getDb()
    .prepare(`SELECT timezone FROM events WHERE id = ?`)
    .get(events[0].id) as { timezone: string };
  assert.equal(row.timezone, 'Australia/Sydney');
});

test('naming a new event always returns to the timezone step with no leftover timezone', async () => {
  setConversationState(PHONE, 'WAITING_FOR_EVENT_NAME', {
    timezone: 'Europe/London',
  });
  await continueCreateEventFlow(ctx, 'Fresh Event');
  const state = getConversationState(PHONE);
  assert.equal(state?.state, 'WAITING_FOR_EVENT_TIMEZONE');
  assert.equal(state?.timezone, null);
  assert.equal(state?.name, 'Fresh Event');
});

function lastMessage(): SendMessageParams {
  const message = sent.at(-1);
  assert.ok(message, 'expected a timezone reply');
  return message;
}
