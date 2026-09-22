import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addGuests,
  closeDb,
  createEvent,
  createInvitation,
  deleteEvent,
  ensureEventNameOrganizerIndex,
  getConversationState,
  getDb,
  getEventById,
  listEventsForOrganizer,
  listInvitationsForEvent,
  listRsvpsForEvent,
  setConversationState,
  upsertRsvp,
} from '../src/db/store.js';
import {
  CONFIRM_EVENT,
  continueCreateEventFlow,
  setCreateEventMessageSender,
  startCreateEventFlow,
} from '../src/commands/createEventFlow.js';
import {
  MANAGE_EVENT,
  MORE_EVENT,
  buildManageEventReply,
  buildMyEventsReply,
  handleCustomerCommand,
  manageEventMoreList,
  setCustomerMessageSender,
} from '../src/commands/welcome.js';
import { VIEW_RSVPS } from '../src/commands/organizer.js';
import type { CommandContext } from '../src/commands/organizer.js';
import type { SendMessageParams } from '../src/zernio/client.js';

process.env.DATABASE_PATH = ':memory:';

const OWNER = '+15551114001';
const OTHER = '+15552224002';
const GUEST_A = '+15553334003';
const GUEST_B = '+15554444004';

const ctx = {
  phone: OWNER,
  conversationId: 'conv-dup',
  accountId: 'acct-dup',
};

const sent: SendMessageParams[] = [];

function lastMessage(): SendMessageParams {
  const message = sent.at(-1);
  assert.ok(message, 'expected a reply');
  return message;
}

function command(
  phone: string,
  payload: string,
  extras: Partial<CommandContext> = {},
): CommandContext {
  return {
    phone,
    text: payload,
    conversationId: `conv-${phone}`,
    accountId: 'acct-dup',
    buttonPayload: payload,
    interactiveType: 'button_reply',
    ...extras,
  };
}

test.beforeEach(() => {
  getDb();
  sent.length = 0;
  setCreateEventMessageSender(async (params) => {
    sent.push(params);
  });
  setCustomerMessageSender(async (params) => {
    sent.push(params);
  });
});

test.afterEach(() => {
  setCreateEventMessageSender();
  setCustomerMessageSender();
  closeDb();
});

test('1-11. same name always inserts a new event and My Events manages by id', async () => {
  const first = createEvent(
    'Birthday Party',
    'October 10, 2026 at 6:00 PM',
    'Hall',
    OWNER,
  );
  setConversationState(OWNER, 'CONFIRMING_EVENT', {
    name: 'Birthday Party',
    date: 'November 21, 2026 at 5:00 PM',
    location: 'Garden',
    event_id: first.id,
    timezone: 'America/New_York',
  });

  await continueCreateEventFlow(ctx, CONFIRM_EVENT);

  const owned = listEventsForOrganizer(OWNER).sort((a, b) => a.id - b.id);
  assert.equal(owned.length, 2);
  const second = owned.find((event) => event.id !== first.id);
  assert.ok(second);
  assert.notEqual(first.id, second.id);
  assert.equal(first.name, 'Birthday Party');
  assert.equal(second.name, 'Birthday Party');
  assert.equal(first.date, 'October 10, 2026 at 6:00 PM');
  assert.equal(second.date, 'November 21, 2026 at 5:00 PM');
  assert.equal(first.location, 'Hall');
  assert.equal(second.location, 'Garden');
  assert.notEqual(first.rsvp_code, second.rsvp_code);
  assert.notEqual(first.short_code, second.short_code);
  assert.notEqual(first.rsvp_token, second.rsvp_token);

  const replies = buildMyEventsReply(owned);
  const interactive = replies.find((reply) => reply.list);
  assert.ok(interactive);
  assert.deepEqual(
    interactive.list?.sections[0].rows.map((row) => row.id),
    [`${MANAGE_EVENT}:${owned[0].id}`, `${MANAGE_EVENT}:${owned[1].id}`],
  );
  assert.match(replies[0].message, /📅 Birthday Party[\s\S]*📅 Birthday Party/);

  await handleCustomerCommand(command(OWNER, `${MANAGE_EVENT} ${first.id}`));
  assert.match(lastMessage().message, /📅 Birthday Party/);
  assert.match(lastMessage().message, /October 10, 2026/);
  assert.doesNotMatch(lastMessage().message, /November 21, 2026/);
  assert.equal(lastMessage().buttons?.[0].payload, `START_INVITE ${first.id}`);

  await handleCustomerCommand(command(OWNER, `${MANAGE_EVENT} ${second.id}`));
  assert.match(lastMessage().message, /November 21, 2026/);
  assert.doesNotMatch(lastMessage().message, /October 10, 2026/);
  assert.equal(lastMessage().buttons?.[0].payload, `START_INVITE ${second.id}`);

  addGuests(first.id, [GUEST_A]);
  addGuests(second.id, [GUEST_B]);
  upsertRsvp(first.id, GUEST_A, 'yes', 2, 'yes', 2, 0);
  upsertRsvp(second.id, GUEST_B, 'no', 0, 'no', 0, 0);
  assert.equal(listRsvpsForEvent(first.id)[0]?.status, 'yes');
  assert.equal(listRsvpsForEvent(second.id)[0]?.status, 'no');
  assert.equal(listRsvpsForEvent(first.id).some((row) => row.phone === GUEST_B), false);

  deleteEvent(first.id);
  assert.ok(getEventById(first.id)?.deleted_at);
  const remaining = listEventsForOrganizer(OWNER);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].id, second.id);
  assert.equal(remaining[0].date, 'November 21, 2026 at 5:00 PM');
  assert.equal(listRsvpsForEvent(second.id)[0]?.status, 'no');
  assert.equal(getEventById(second.id)?.deleted_at ?? null, null);
});

test('three or more events can share the same name', async () => {
  const created = [
    createEvent('Birthday Party', 'June 1', 'Park', OWNER),
    createEvent('Birthday Party', 'July 2', 'Hall', OWNER),
    createEvent('Birthday Party', 'August 3', 'Home', OWNER),
  ];
  const ids = new Set(created.map((event) => event.id));
  assert.equal(ids.size, 3);
  const listed = listEventsForOrganizer(OWNER);
  assert.equal(listed.length, 3);
  assert.equal(listed.every((event) => event.name === 'Birthday Party'), true);

  const replies = buildMyEventsReply(listed);
  const rows = replies.find((reply) => reply.list)?.list?.sections[0].rows ?? [];
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((row) => row.id).sort(),
    created.map((event) => `${MANAGE_EVENT}:${event.id}`).sort(),
  );
});

test('name-organizer uniqueness is dropped and RSVP uniqueness stays', () => {
  const database = getDb();
  database.exec(`DROP INDEX IF EXISTS idx_events_name_organizer`);
  database.exec(
    `CREATE UNIQUE INDEX idx_legacy_name_org ON events (name, organizer_phone)`,
  );

  const first = createEvent('Twins', 'May 1', 'Hall', OWNER);
  assert.throws(() => createEvent('Twins', 'May 2', 'Park', OWNER));

  ensureEventNameOrganizerIndex(database);
  const second = createEvent('Twins', 'May 2', 'Park', OWNER);
  assert.notEqual(first.id, second.id);

  const indexes = database
    .prepare(`PRAGMA index_list(events)`)
    .all() as Array<{ name: string; unique: number }>;
  const nameOrganizer = indexes.find(
    (index) => index.name === 'idx_events_name_organizer',
  );
  assert.ok(nameOrganizer);
  assert.equal(nameOrganizer.unique, 0);
  assert.equal(
    indexes.some((index) => index.name === 'idx_legacy_name_org'),
    false,
  );
  assert.equal(
    indexes.find((index) => index.name === 'idx_events_rsvp_token')?.unique,
    1,
  );
  assert.equal(
    indexes.find((index) => index.name === 'idx_events_rsvp_code')?.unique,
    1,
  );
  assert.equal(
    indexes.find((index) => index.name === 'idx_events_short_code')?.unique,
    1,
  );
});

test('CREATE_EVENT clears leftover event_id so confirm cannot update the old row', async () => {
  const existing = createEvent('Birthday Party', 'May 1', 'Hall', OWNER);
  setConversationState(OWNER, 'WAITING_FOR_DELETE_CONFIRM', {
    event_id: existing.id,
    name: existing.name,
  });

  await startCreateEventFlow(ctx);
  const draft = getConversationState(OWNER);
  assert.equal(draft?.state, 'WAITING_FOR_EVENT_NAME');
  assert.equal(draft?.event_id, null);

  setConversationState(OWNER, 'CONFIRMING_EVENT', {
    name: 'Birthday Party',
    date: 'June 2',
    location: 'Garden',
    event_id: existing.id,
    timezone: 'America/New_York',
  });
  await continueCreateEventFlow(ctx, 'CONFIRM');

  const owned = listEventsForOrganizer(OWNER);
  assert.equal(owned.length, 2);
  assert.equal(getEventById(existing.id)?.location, 'Hall');
  assert.ok(owned.some((event) => event.id !== existing.id && event.location === 'Garden'));
});

test('Manage Event payloads stay id-based for duplicate names', () => {
  const first = createEvent('Dinner', 'Nov 1', 'Cafe', OWNER);
  const second = createEvent('Dinner', 'Dec 1', 'Home', OWNER);
  createEvent('Dinner', 'Jan 1', 'Hall', OTHER);

  const owned = listEventsForOrganizer(OWNER);
  assert.equal(owned.length, 2);
  const reply = buildManageEventReply(first);
  assert.deepEqual(
    reply.buttons?.map((button) => button.payload),
    [
      `START_INVITE ${first.id}`,
      `${VIEW_RSVPS} ${first.id}`,
      `${MORE_EVENT} ${first.id}`,
    ],
  );
  assert.deepEqual(
    manageEventMoreList(first).sections[0].rows.map((row) => row.id),
    [
      `GUEST_LIST:${first.id}`,
      `EDIT_EVENT:${first.id}`,
      `SEND_UPDATE:${first.id}`,
      `VOID_EVENT:${first.id}`,
      `DELETE_EVENT:${first.id}`,
    ],
  );
  assert.notEqual(first.id, second.id);
});

test('independent invitations stay on the matching same-name event', () => {
  const first = createEvent('Birthday Party', 'Oct 10', 'Hall', OWNER);
  const second = createEvent('Birthday Party', 'Nov 21', 'Garden', OWNER);
  const invite = createInvitation({ eventId: first.id, type: 'individual' });
  addGuests(first.id, [GUEST_A], invite.id);

  assert.equal(listInvitationsForEvent(first.id).length, 1);
  assert.equal(listInvitationsForEvent(second.id).length, 0);
  deleteEvent(second.id);
  assert.equal(listInvitationsForEvent(first.id).length, 1);
  assert.deepEqual(
    listEventsForOrganizer(OWNER).map((event) => event.id),
    [first.id],
  );
});
