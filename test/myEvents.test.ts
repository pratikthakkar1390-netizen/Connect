import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addGuests,
  closeDb,
  createEvent,
  createInvitation,
  getDb,
  getEventById,
  listEventsForOrganizer,
  upsertRsvp,
} from '../src/db/store.js';
import {
  MANAGE_EVENT,
  MORE_EVENT,
  buildManageEventReply,
  buildMyEventsReply,
  formatEventInviteCard,
  getEventInviteStats,
  isMyEventsCommand,
  manageEventButtons,
  manageEventMoreList,
} from '../src/commands/welcome.js';
import { VIEW_RSVPS } from '../src/commands/organizer.js';

process.env.DATABASE_PATH = ':memory:';

const OWNER = '+15551111111';
const OTHER = '+15552222222';

test('isMyEventsCommand accepts payload and button title', () => {
  assert.equal(isMyEventsCommand('MY_EVENTS'), true);
  assert.equal(isMyEventsCommand('My Events'), true);
  assert.equal(isMyEventsCommand('  my events  '), true);
  assert.equal(isMyEventsCommand('VIEW_OPTIONS'), false);
});

test('My Events includes zero-invitation events and ignores invitation_count limit', () => {
  getDb();
  const event = createEvent('New Party', 'July 4', 'Park', OWNER, {
    invitationCount: 50,
  });

  const owned = listEventsForOrganizer(OWNER);
  assert.equal(owned.length, 1);
  assert.equal(owned[0].id, event.id);

  const stats = getEventInviteStats(event.id);
  assert.equal(stats.invitationsSent, 0);
  assert.equal(stats.yes, 0);
  assert.equal(stats.no, 0);
  assert.equal(stats.maybe, 0);
  assert.equal(stats.awaiting, 0);

  const card = formatEventInviteCard(event);
  assert.match(card, /📅 New Party/);
  assert.match(card, /July 4/);
  assert.match(card, /📍 Park/);
  assert.match(card, /📩 Invitations sent: 0/);
  assert.match(card, /✅ Yes: 0/);
  assert.match(card, /❌ No: 0/);
  assert.match(card, /❓ Maybe: 0/);
  assert.match(card, /⏳ Awaiting response: 0/);
  assert.doesNotMatch(card, /Invitations sent: 50/);

  closeDb();
});

test('My Events counts actual invitations and RSVP responses', () => {
  getDb();
  const event = createEvent('Wedding', 'June 15', 'Hall', OWNER);
  createInvitation({ eventId: event.id, type: 'individual' });
  createInvitation({ eventId: event.id, type: 'individual' });
  const family = createInvitation({
    eventId: event.id,
    type: 'family',
    familyName: 'Patel Family',
    maxGuests: 4,
  });
  addGuests(event.id, ['+15553333333'], family.id);
  addGuests(event.id, ['+15554444444']);
  addGuests(event.id, ['+15555555555']);
  upsertRsvp(event.id, '+15553333333', 'yes', 2, 'yes', 2, 0);
  upsertRsvp(event.id, '+15554444444', 'no', 0, 'no', 0, 0);
  upsertRsvp(event.id, '+15555555555', 'maybe', 1, 'maybe', 0, 0);

  const stats = getEventInviteStats(event.id);
  assert.equal(stats.invitationsSent, 3);
  assert.equal(stats.yes, 1);
  assert.equal(stats.no, 1);
  assert.equal(stats.maybe, 1);
  assert.equal(stats.awaiting, 0);

  const card = formatEventInviteCard(event);
  assert.match(card, /📩 Invitations sent: 3/);
  assert.match(card, /✅ Yes: 1/);
  assert.match(card, /❌ No: 1/);
  assert.match(card, /❓ Maybe: 1/);
  assert.match(card, /⏳ Awaiting response: 0/);

  closeDb();
});

test('awaiting is known WhatsApp phones without an RSVP, not unopened forwards', () => {
  getDb();
  const event = createEvent('Picnic', 'Aug 1', 'Lake', OWNER);
  createInvitation({ eventId: event.id, type: 'individual' });
  createInvitation({ eventId: event.id, type: 'individual' });
  createInvitation({ eventId: event.id, type: 'group', groupName: 'Friends' });
  addGuests(event.id, ['+15553333333']);
  upsertRsvp(event.id, '+15553333333', 'yes', 1, 'yes', 1, 0);

  const stats = getEventInviteStats(event.id);
  assert.equal(stats.invitationsSent, 3);
  assert.equal(stats.yes, 1);
  assert.equal(stats.awaiting, 0);

  addGuests(event.id, ['+15554444444']);
  const after = getEventInviteStats(event.id);
  assert.equal(after.awaiting, 1);

  closeDb();
});

test('organizer ownership isolates events by organizer_phone', () => {
  getDb();
  const mine = createEvent('Mine', 'May 1', 'Home', OWNER);
  createEvent('Theirs', 'May 2', 'Hall', OTHER);

  const owned = listEventsForOrganizer(OWNER);
  assert.equal(owned.length, 1);
  assert.equal(owned[0].id, mine.id);
  assert.equal(listEventsForOrganizer(OTHER).length, 1);
  assert.equal(listEventsForOrganizer('+15559999999').length, 0);

  closeDb();
});

test('single event My Events shows card and Manage Event button', () => {
  getDb();
  const event = createEvent('BBQ', 'July 4', 'Park', OWNER);
  const replies = buildMyEventsReply([event]);

  assert.equal(replies.length, 1);
  assert.match(replies[0].message, /📅 BBQ/);
  assert.match(replies[0].message, /📩 Invitations sent: 0/);
  assert.deepEqual(replies[0].buttons, [
    { title: 'Manage Event', payload: `${MANAGE_EVENT} ${event.id}` },
  ]);
  assert.equal(replies[0].list, undefined);

  closeDb();
});

test('multiple events My Events uses a Manage Event list', () => {
  getDb();
  const first = createEvent('One', 'June 1', 'Park', OWNER);
  const second = createEvent('Two', 'June 2', 'Hall', OWNER);
  const replies = buildMyEventsReply([first, second]);

  assert.equal(replies.length, 1);
  assert.match(replies[0].message, /📅 One/);
  assert.match(replies[0].message, /📅 Two/);
  assert.equal(replies[0].list?.button, 'Manage Event');
  assert.deepEqual(
    replies[0].list?.sections[0].rows.map((row) => row.id),
    [`${MANAGE_EVENT}:${first.id}`, `${MANAGE_EVENT}:${second.id}`],
  );

  closeDb();
});

test('long My Events body is split so interactive stays under 1024 chars', () => {
  getDb();
  const events = Array.from({ length: 8 }, (_, index) =>
    createEvent(
      `Celebration ${index + 1}`,
      'Sunday, September 20, 2026 at 7:30 PM',
      'A long venue name on a long street',
      OWNER,
    ),
  );
  const replies = buildMyEventsReply(events);
  const interactive = replies.find((reply) => reply.list);
  assert.ok(interactive);
  assert.ok(interactive.message.length <= 1024);
  assert.equal(interactive.list?.button, 'Manage Event');
  assert.equal(interactive.list?.sections[0].rows.length, 8);

  closeDb();
});

test('Manage Event menu wires existing invite, RSVP, and details handlers', () => {
  getDb();
  const event = createEvent('Gala', 'Dec 1', 'Hotel', OWNER, {
    invitationCount: 80,
  });
  createInvitation({ eventId: event.id, type: 'individual' });

  const reply = buildManageEventReply(event);
  assert.match(reply.message, /📅 Gala/);
  assert.match(reply.message, /📩 Invitations sent: 1/);
  assert.doesNotMatch(reply.message, /Invitations sent: 80/);
  assert.deepEqual(manageEventButtons(event), [
    { title: '📩 Invite', payload: `START_INVITE ${event.id}` },
    { title: '👥 RSVPs', payload: `${VIEW_RSVPS} ${event.id}` },
    { title: 'More…', payload: `${MORE_EVENT} ${event.id}` },
  ]);
  assert.deepEqual(reply.buttons, manageEventButtons(event));
  assert.match(reply.message, /Children:/);
  assert.deepEqual(
    manageEventMoreList(event).sections[0].rows.map((row) => row.id),
    [
      `EDIT_EVENT:${event.id}`,
      `SEND_UPDATE:${event.id}`,
      `VOID_EVENT:${event.id}`,
      `DELETE_EVENT:${event.id}`,
    ],
  );

  closeDb();
});

test('selecting an owned event opens Manage Event, not another organizer event', () => {
  getDb();
  const mine = createEvent('Dinner', 'Nov 1', 'Cafe', OWNER);
  const theirs = createEvent('Private', 'Jan 1', 'Home', OTHER);
  createInvitation({ eventId: mine.id, type: 'individual' });

  const owned = listEventsForOrganizer(OWNER);
  assert.equal(owned.some((event) => event.id === theirs.id), false);

  const selected = getEventById(mine.id);
  assert.ok(selected);
  const reply = buildManageEventReply(selected);
  assert.match(reply.message, /📅 Dinner/);
  assert.match(reply.message, /📩 Invitations sent: 1/);
  assert.deepEqual(
    reply.buttons?.map((button) => button.title),
    [
      '📩 Invite',
      '👥 RSVPs',
      'More…',
    ],
  );
  assert.equal(reply.buttons?.[0].payload, `START_INVITE ${mine.id}`);

  closeDb();
});
