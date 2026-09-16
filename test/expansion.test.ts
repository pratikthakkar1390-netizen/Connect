import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addGuests,
  closeDb,
  createEvent,
  getDb,
  getRsvpSummary,
  isRsvpDeadlinePassed,
  listRsvpsForEvent,
  upsertRsvp,
} from '../src/db/store.js';
import { formatRsvpStatusMessage } from '../src/commands/organizer.js';

process.env.DATABASE_PATH = ':memory:';

test('schema stores new event and rsvp fields', () => {
  getDb();
  const event = createEvent('Gala', 'Dec 1 7pm', 'Hall', '+15551111111', {
    invitationCount: 100,
    rsvpDeadline: 'Nov 25 5pm',
    childrenAllowed: false,
  });

  assert.equal(event.invitation_count, 100);
  assert.equal(event.rsvp_deadline, 'Nov 25 5pm');
  assert.equal(event.children_allowed, 0);
  assert.equal(event.reminder_days, null);

  addGuests(event.id, ['+15552222222']);
  upsertRsvp(event.id, '+15552222222', 'yes', 3, 'yes', 2, 1);

  const rsvps = listRsvpsForEvent(event.id);
  assert.equal(rsvps[0].adult_count, 2);
  assert.equal(rsvps[0].child_count, 1);
  assert.equal(rsvps[0].guest_count, 3);

  closeDb();
});

test('upsertRsvp edits without duplicate rows', () => {
  getDb();
  const event = createEvent('Party', 'Jan 1', 'Home', '+15551111111');
  addGuests(event.id, ['+15552222222']);

  upsertRsvp(event.id, '+15552222222', 'yes', 2, 'yes', 2, 0);
  upsertRsvp(event.id, '+15552222222', 'no', 0, 'no', 0, 0);

  const rsvps = listRsvpsForEvent(event.id);
  assert.equal(rsvps.length, 1);
  assert.equal(rsvps[0].status, 'no');
  assert.equal(rsvps[0].guest_count, 0);

  closeDb();
});

test('isRsvpDeadlinePassed treats empty deadline as open', () => {
  assert.equal(isRsvpDeadlinePassed(null), false);
  assert.equal(isRsvpDeadlinePassed(''), false);

  const past = new Date(Date.now() - 60_000).toISOString();
  assert.equal(isRsvpDeadlinePassed(past), true);

  const future = new Date(Date.now() + 86_400_000).toISOString();
  assert.equal(isRsvpDeadlinePassed(future), false);
});

test('isRsvpDeadlinePassed treats yearless September deadlines as 2026 in America/New_York', () => {
  const eventDate = 'Sunday, September 20, 2026 at 7:30 PM';
  // September 7, 2026 4:00 PM EDT
  const beforeSept8 = new Date('2026-09-07T20:00:00.000Z');
  // September 8, 2026 4:00 PM EDT — still open through end of that day
  const duringSept8 = new Date('2026-09-08T20:00:00.000Z');
  // September 9, 2026 12:00:01 AM EDT
  const afterSept8 = new Date('2026-09-09T04:00:01.000Z');
  // September 14, 2026 4:00 PM EDT
  const beforeSept15 = new Date('2026-09-14T20:00:00.000Z');
  // September 16, 2026 12:00:01 AM EDT
  const afterSept15 = new Date('2026-09-16T04:00:01.000Z');

  assert.equal(
    isRsvpDeadlinePassed('September 8', { now: beforeSept8, eventDate }),
    false,
  );
  assert.equal(
    isRsvpDeadlinePassed('September 8', { now: duringSept8, eventDate }),
    false,
  );
  assert.equal(
    isRsvpDeadlinePassed('September 8', { now: afterSept8, eventDate }),
    true,
  );

  assert.equal(
    isRsvpDeadlinePassed('Sept 15', { now: beforeSept15, eventDate }),
    false,
  );
  assert.equal(
    isRsvpDeadlinePassed('Sept 15', { now: afterSept15, eventDate }),
    true,
  );
});

test('isRsvpDeadlinePassed does not treat Date.parse 2001 as the deadline year', () => {
  const now = new Date('2026-09-06T16:00:00.000Z');
  assert.equal(new Date(Date.parse('Sept 15')).getUTCFullYear(), 2001);
  assert.equal(Date.parse('Sept 15') < now.getTime(), true);
  assert.equal(isRsvpDeadlinePassed('Sept 15', { now }), false);
  assert.equal(isRsvpDeadlinePassed('September 8', { now }), false);
});

test('attendance sums exclude no and maybe', () => {
  getDb();
  const event = createEvent('Dinner', 'Feb 1', 'Restaurant', '+15551111111', {
    invitationCount: 10,
  });
  addGuests(event.id, ['+15552222222', '+15553333333', '+15554444444']);

  upsertRsvp(event.id, '+15552222222', 'yes', 3, 'yes', 2, 1);
  upsertRsvp(event.id, '+15553333333', 'no', 0, 'no', 0, 0);
  upsertRsvp(event.id, '+15554444444', 'maybe', 0, 'maybe', 0, 0);

  const summary = getRsvpSummary(event.id);
  assert.equal(summary.yes, 1);
  assert.equal(summary.no, 1);
  assert.equal(summary.maybe, 1);
  assert.equal(summary.expectedAttendance, 3);
  assert.equal(summary.totalAdults, 2);
  assert.equal(summary.totalChildren, 1);

  closeDb();
});

test('legacy guest_count counts as adults when adult_count is zero', () => {
  getDb();
  const event = createEvent('Legacy', 'Mar 1', 'Park', '+15551111111');
  addGuests(event.id, ['+15552222222']);
  upsertRsvp(event.id, '+15552222222', 'yes', 4, 'yes');

  const summary = getRsvpSummary(event.id);
  assert.equal(summary.expectedAttendance, 4);
  assert.equal(summary.totalAdults, 4);
  assert.equal(summary.totalChildren, 0);

  closeDb();
});

test('formatRsvpStatusMessage uses invitation_count and awaiting', () => {
  const event = {
    id: 1,
    name: 'Wedding',
    date: 'June 15 7pm',
    location: '123 Main St',
    organizer_phone: '+15551111111',
    rsvp_token: 'token',
    rsvp_code: 'ABC12XY3',
    invitation_count: 20,
    rsvp_deadline: 'June 10 5pm',
    children_allowed: 1,
    reminder_days: null,
    reminder_sent_at: null,
    created_at: '2026-01-01',
  };

  const message = formatRsvpStatusMessage(
    event,
    {
      yes: 2,
      no: 1,
      maybe: 1,
      pending: 3,
      totalGuests: 5,
      totalAdults: 4,
      totalChildren: 1,
      expectedAttendance: 5,
    },
    [],
    [
      {
        id: 1,
        event_id: 1,
        phone: '+15552222222',
        status: 'yes',
        guest_count: 3,
        adult_count: 2,
        child_count: 1,
        raw_reply: 'yes',
        updated_at: '',
        guest_name: 'Alex',
      },
      {
        id: 2,
        event_id: 1,
        phone: '+15553333333',
        status: 'no',
        guest_count: 0,
        adult_count: 0,
        child_count: 0,
        raw_reply: 'no',
        updated_at: '',
      },
      {
        id: 3,
        event_id: 1,
        phone: '+15554444444',
        status: 'maybe',
        guest_count: 0,
        adult_count: 0,
        child_count: 0,
        raw_reply: 'maybe',
        updated_at: '',
      },
    ],
  );

  assert.match(message, /Invitations: 20/);
  assert.match(message, /Awaiting: 16/);
  assert.match(message, /Expected attendance: 5 \(4 adults, 1 child\)/);
  assert.match(message, /2 adults, 1 child, 3 total/);
  assert.doesNotMatch(message, /333 3333.*guests/i);
});

test('children_allowed flag stored on event', () => {
  getDb();
  const allowed = createEvent('Kids OK', 'Apr 1', 'Park', '+15551111111', {
    childrenAllowed: true,
  });
  const adultsOnly = createEvent('Adults', 'Apr 2', 'Lounge', '+15551111111', {
    childrenAllowed: false,
  });

  assert.equal(allowed.children_allowed, 1);
  assert.equal(adultsOnly.children_allowed, 0);

  closeDb();
});

test('invitation_count stored on event', () => {
  getDb();
  const event = createEvent('Banquet', 'May 1', 'Hotel', '+15551111111', {
    invitationCount: 75,
  });
  assert.equal(event.invitation_count, 75);
  closeDb();
});
