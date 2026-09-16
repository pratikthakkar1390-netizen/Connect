import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addGuests,
  cancelEvent,
  closeDb,
  createEvent,
  getDb,
  getPendingGuestPhonesForEvent,
  listEventsWithReminderConfigured,
  markReminderSent,
  upsertRsvp,
} from '../src/db/store.js';
import {
  isReminderDue,
  parseDeadlineToMs,
  parseReminderDaysChoice,
} from '../src/reminders/targeting.js';

process.env.DATABASE_PATH = ':memory:';

test('parseReminderDaysChoice accepts NONE and 1-3', () => {
  assert.equal(parseReminderDaysChoice('NONE'), null);
  assert.equal(parseReminderDaysChoice('no reminder'), null);
  assert.equal(parseReminderDaysChoice('1'), 1);
  assert.equal(parseReminderDaysChoice('2 days before'), 2);
  assert.equal(parseReminderDaysChoice('REMINDER_3'), 3);
  assert.equal(parseReminderDaysChoice('REMINDER:1'), 1);
  assert.equal(parseReminderDaysChoice('REMINDER:2'), 2);
  assert.equal(parseReminderDaysChoice('REMINDER:3'), 3);
  assert.equal(parseReminderDaysChoice('maybe'), undefined);
});

test('parseReminderDaysChoice accepts reminder button titles and payloads', () => {
  assert.equal(parseReminderDaysChoice('1 day before'), 1);
  assert.equal(parseReminderDaysChoice('2 days before'), 2);
  assert.equal(parseReminderDaysChoice('3 days before'), 3);
  assert.equal(parseReminderDaysChoice('No reminder'), null);
  assert.equal(parseReminderDaysChoice('REMINDER_1'), 1);
  assert.equal(parseReminderDaysChoice('REMINDER_2'), 2);
  assert.equal(parseReminderDaysChoice('REMINDER_NONE'), null);
});

test('isReminderDue respects window, deadline, and one-shot send', () => {
  const deadline = new Date('2030-06-10T17:00:00Z').toISOString();

  const twoDaysBefore = Date.parse('2030-06-08T17:00:00Z');
  assert.equal(
    isReminderDue({
      nowMs: twoDaysBefore,
      deadline,
      reminderDays: 2,
      reminderSentAt: null,
    }),
    true,
  );

  const tooEarly = Date.parse('2030-06-07T17:00:00Z');
  assert.equal(
    isReminderDue({
      nowMs: tooEarly,
      deadline,
      reminderDays: 2,
      reminderSentAt: null,
    }),
    false,
  );

  const afterDeadline = Date.parse('2030-06-11T17:00:00Z');
  assert.equal(
    isReminderDue({
      nowMs: afterDeadline,
      deadline,
      reminderDays: 2,
      reminderSentAt: null,
    }),
    false,
  );

  assert.equal(
    isReminderDue({
      nowMs: twoDaysBefore,
      deadline,
      reminderDays: 2,
      reminderSentAt: '2026-01-01T00:00:00Z',
    }),
    false,
  );
});

test('isReminderDue requires a parseable deadline', () => {
  assert.equal(
    isReminderDue({
      nowMs: Date.now(),
      deadline: 'not-a-real-date',
      reminderDays: 1,
      reminderSentAt: null,
    }),
    false,
  );
  assert.equal(parseDeadlineToMs('not-a-real-date'), null);
});

test('isReminderDue parses yearless deadlines in EVENT_TIMEZONE, not Date.parse 2001', () => {
  const eventDate = 'Sunday, September 20, 2026 at 7:30 PM';
  assert.equal(new Date(Date.parse('Sept 15')).getUTCFullYear(), 2001);

  const deadlineMs = parseDeadlineToMs('Sept 15', {
    eventDate,
    reference: new Date('2026-09-06T16:00:00.000Z'),
  });
  assert.ok(deadlineMs !== null);
  assert.equal(new Date(deadlineMs).getUTCFullYear(), 2026);
  assert.equal(deadlineMs, Date.parse('2026-09-16T03:59:59.000Z'));

  assert.equal(
    isReminderDue({
      nowMs: Date.parse('2026-09-14T16:00:00.000Z'),
      deadline: 'Sept 15',
      eventDate,
      reminderDays: 2,
      reminderSentAt: null,
    }),
    true,
  );
  assert.equal(
    isReminderDue({
      nowMs: Date.parse('2026-09-13T16:00:00.000Z'),
      deadline: 'Sept 15',
      eventDate,
      reminderDays: 2,
      reminderSentAt: null,
    }),
    false,
  );
  assert.equal(
    isReminderDue({
      nowMs: Date.parse('2026-09-16T16:00:00.000Z'),
      deadline: 'Sept 15',
      eventDate,
      reminderDays: 2,
      reminderSentAt: null,
    }),
    false,
  );
});

test('getPendingGuestPhonesForEvent returns only invited pending guests', () => {
  getDb();
  const event = createEvent('Reminder Test', 'July 1', 'Park', '+15551111111', {
    invitationCount: 5,
    rsvpDeadline: new Date(Date.now() + 86_400_000 * 5).toISOString(),
    reminderDays: 1,
  });

  addGuests(event.id, ['+15552222222', '+15553333333', '+15554444444']);
  upsertRsvp(event.id, '+15553333333', 'yes', 2, 'yes', 2, 0);
  upsertRsvp(event.id, '+15554444444', 'no', 0, 'no', 0, 0);

  const pending = getPendingGuestPhonesForEvent(event.id);
  assert.deepEqual(pending, ['+15552222222']);

  closeDb();
});

test('listEventsWithReminderConfigured excludes sent reminders and open deadlines', () => {
  getDb();

  const withReminder = createEvent('Due', 'Aug 1', 'Hall', '+15551111111', {
    rsvpDeadline: new Date(Date.now() + 86_400_000 * 3).toISOString(),
    reminderDays: 1,
  });

  createEvent('No reminder', 'Aug 2', 'Hall', '+15551111111', {
    rsvpDeadline: new Date(Date.now() + 86_400_000 * 3).toISOString(),
  });

  createEvent('No deadline', 'Aug 3', 'Hall', '+15551111111', {
    reminderDays: 1,
  });

  const configured = listEventsWithReminderConfigured();
  assert.equal(configured.length, 1);
  assert.equal(configured[0].id, withReminder.id);

  markReminderSent(withReminder.id);
  assert.equal(listEventsWithReminderConfigured().length, 0);

  closeDb();
});

test('listEventsWithReminderConfigured skips cancelled events', () => {
  getDb();
  const event = createEvent('Due', 'Aug 1', 'Hall', '+15551111111', {
    rsvpDeadline: new Date(Date.now() + 86_400_000 * 3).toISOString(),
    reminderDays: 1,
  });
  assert.equal(listEventsWithReminderConfigured().some((row) => row.id === event.id), true);
  cancelEvent(event.id);
  assert.equal(listEventsWithReminderConfigured().some((row) => row.id === event.id), false);
  closeDb();
});

test('responded guests are excluded from pending reminder targets', () => {
  getDb();
  const deadline = new Date(Date.now() + 86_400_000 * 2).toISOString();
  const event = createEvent('Party', 'Sep 1', 'Home', '+15551111111', {
    rsvpDeadline: deadline,
    reminderDays: 1,
  });

  addGuests(event.id, ['+15552222222', '+15553333333']);
  upsertRsvp(event.id, '+15552222222', 'maybe', 0, 'maybe', 0, 0);

  const pending = getPendingGuestPhonesForEvent(event.id);
  assert.deepEqual(pending, ['+15553333333']);

  closeDb();
});
