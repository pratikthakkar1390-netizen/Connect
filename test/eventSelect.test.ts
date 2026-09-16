import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addGuests,
  closeDb,
  createEvent,
  createInvitation,
  getConversationState,
  getDb,
  getEventById,
  isEventDeleted,
  listEventsForOrganizer,
  listInvitationsForEvent,
  listRsvpsForEvent,
  upsertRsvp,
} from '../src/db/store.js';
import {
  CONFIRM_DELETE_EVENT,
  DELETE_EVENT,
  EDIT_EVENT,
  KEEP_EVENT,
  handleEventUpdateCommand,
  isEventUpdateCommand,
  setEventUpdateMessageSender,
} from '../src/commands/eventUpdateFlow.js';
import {
  MANAGE_EVENT,
  MORE_EVENT,
  buildMyEventsReply,
  handleCustomerCommand,
  setCustomerMessageSender,
} from '../src/commands/welcome.js';
import { VIEW_RSVPS } from '../src/commands/organizer.js';
import type { CommandContext } from '../src/commands/organizer.js';
import type { SendMessageParams } from '../src/zernio/client.js';
import {
  WHATSAPP_LIST_ROW_ID_LIMIT,
  WHATSAPP_LIST_ROW_TITLE_LIMIT,
  buildEventSelectList,
  eventListRowId,
  interactiveCommandInput,
  matchEventAction,
  parseEventActionId,
  toWhatsAppListRowId,
} from '../src/whatsapp/eventList.js';

process.env.DATABASE_PATH = ':memory:';

const OWNER = '+15551116001';
const CO_OWNER = '+15551116002';
const STRANGER = '+15551116099';

const sent: SendMessageParams[] = [];

function lastMessage(): SendMessageParams {
  const message = sent.at(-1);
  assert.ok(message, 'expected a reply');
  return message;
}

function ctx(
  phone: string,
  extras: Partial<CommandContext> & { text?: string } = {},
): CommandContext {
  return {
    phone,
    text: extras.text ?? '',
    conversationId: `conv-${phone}`,
    accountId: 'acct-select',
    ...extras,
  };
}

function tap(
  phone: string,
  payload: string,
  extras: Partial<CommandContext> = {},
): CommandContext {
  return ctx(phone, {
    text: payload,
    buttonPayload: payload,
    interactiveType: 'button_reply',
    ...extras,
  });
}

function listTap(
  phone: string,
  rowId: string,
  title: string,
): CommandContext {
  return ctx(phone, {
    text: title,
    interactiveId: rowId,
    buttonPayload: title,
    interactiveType: 'list_reply',
  });
}

test.beforeEach(() => {
  getDb();
  sent.length = 0;
  setCustomerMessageSender(async (params) => {
    sent.push(params);
  });
  setEventUpdateMessageSender(async (params) => {
    sent.push(params);
  });
});

test.afterEach(() => {
  setCustomerMessageSender();
  setEventUpdateMessageSender();
  closeDb();
});

test('list row ids stay unique, compact, and never use the event name', () => {
  const first = createEvent('Dinner', 'October 10', 'Hall', OWNER);
  const second = createEvent('Dinner', 'November 15', 'Cafe', OWNER);
  const list = buildEventSelectList([first, second], DELETE_EVENT, {
    button: 'Delete Event',
  });
  const rows = list.sections[0].rows;
  assert.deepEqual(
    rows.map((row) => row.id),
    [`${DELETE_EVENT}:${first.id}`, `${DELETE_EVENT}:${second.id}`],
  );
  assert.equal(rows[0].title, 'Dinner');
  assert.equal(rows[1].title, 'Dinner');
  assert.match(rows[0].description ?? '', /October 10/);
  assert.match(rows[1].description ?? '', /November 15/);
  assert.equal(rows.every((row) => row.id.length <= WHATSAPP_LIST_ROW_ID_LIMIT), true);
  assert.equal(rows.every((row) => row.title.length <= WHATSAPP_LIST_ROW_TITLE_LIMIT), true);
  assert.equal(parseEventActionId(rows[0].id, DELETE_EVENT), first.id);
  assert.equal(parseEventActionId('Dinner', DELETE_EVENT), null);
  assert.equal(parseEventActionId(`${DELETE_EVENT} Dinner`, DELETE_EVENT), null);
  assert.deepEqual(matchEventAction(`${DELETE_EVENT} Dinner`, DELETE_EVENT), {
    match: true,
    eventId: undefined,
    invalidSuffix: true,
  });
});

test('interactiveCommandInput uses list row id, not the 24-char title', () => {
  assert.equal(
    interactiveCommandInput({
      interactiveType: 'list_reply',
      interactiveId: `${DELETE_EVENT}:12`,
      buttonPayload: 'Dinner',
      text: 'Dinner',
    }),
    `${DELETE_EVENT}:12`,
  );
  assert.equal(
    interactiveCommandInput({
      interactiveType: 'button_reply',
      interactiveId: `${DELETE_EVENT}:12`,
      buttonPayload: `${DELETE_EVENT} 12`,
      text: 'Delete Event',
    }),
    `${DELETE_EVENT} 12`,
  );
  assert.equal(toWhatsAppListRowId(`${DELETE_EVENT} 12`), `${DELETE_EVENT}:12`);
  assert.equal(toWhatsAppListRowId(`${DELETE_EVENT}:12`), `${DELETE_EVENT}:12`);
  assert.equal(toWhatsAppListRowId('ADULTS_ONLY'), 'ADULTS_ONLY');
  assert.equal(toWhatsAppListRowId('REMINDER_1'), 'REMINDER_1');
  assert.equal(toWhatsAppListRowId('REMINDER_2'), 'REMINDER_2');
  assert.equal(toWhatsAppListRowId('REMINDER_3'), 'REMINDER_3');
  assert.equal(toWhatsAppListRowId('REMINDER_NONE'), 'REMINDER_NONE');
  assert.equal(isEventUpdateCommand(`${DELETE_EVENT}:12`), true);
  assert.equal(isEventUpdateCommand(DELETE_EVENT), true);
});

test('Delete Event with no id shows an id-based picker, not deny-access', async () => {
  const katha = createEvent('Katha 2', 'Sept 1', 'Temple', OWNER);
  const dinner = createEvent('Dinner', 'October 10', 'Hall', OWNER);
  createEvent('Test', 'Sept 2', 'Home', OWNER);

  await handleEventUpdateCommand(tap(OWNER, DELETE_EVENT), DELETE_EVENT);
  const picker = lastMessage();
  assert.match(picker.message, /Pick an event to delete/);
  assert.deepEqual(
    picker.list?.sections[0].rows.map((row) => row.id),
    listEventsForOrganizer(OWNER).map((event) => eventListRowId(DELETE_EVENT, event.id)),
  );
  assert.ok(
    picker.list?.sections[0].rows.some((row) => row.id === eventListRowId(DELETE_EVENT, katha.id)),
  );
  assert.ok(
    picker.list?.sections[0].rows.some((row) => row.id === eventListRowId(DELETE_EVENT, dinner.id)),
  );
  assert.equal(
    picker.list?.sections[0].rows.some((row) => row.id.includes('Katha')),
    false,
  );
  assert.equal(isEventDeleted(getEventById(dinner.id)), false);
});

test('Delete Event list_reply targets Dinner Oct 10, not Nov 15', async () => {
  const october = createEvent('Dinner', 'October 10', 'Hall', OWNER);
  const november = createEvent('Dinner', 'November 15', 'Cafe', OWNER);
  addGuests(october.id, ['+15553336001']);
  addGuests(november.id, ['+15553336002']);
  upsertRsvp(october.id, '+15553336001', 'yes', 2, 'yes', 2, 0);
  upsertRsvp(november.id, '+15553336002', 'maybe', 1, 'maybe', 1, 0);
  const invite = createInvitation({ eventId: october.id, type: 'individual' });

  await handleCustomerCommand(
    listTap(OWNER, eventListRowId(DELETE_EVENT, october.id), 'Dinner'),
  );
  assert.match(lastMessage().message, /Remove this event from your list/);
  assert.match(lastMessage().message, /Dinner/);
  assert.equal(getConversationState(OWNER)?.event_id, october.id);
  assert.equal(isEventDeleted(getEventById(october.id)), false);

  await handleEventUpdateCommand(
    tap(OWNER, `${KEEP_EVENT} ${october.id}`),
    `${KEEP_EVENT} ${october.id}`,
  );
  assert.equal(isEventDeleted(getEventById(october.id)), false);
  assert.equal(isEventDeleted(getEventById(november.id)), false);

  await handleCustomerCommand(
    listTap(OWNER, eventListRowId(DELETE_EVENT, october.id), 'Dinner'),
  );
  await handleEventUpdateCommand(
    tap(OWNER, `${CONFIRM_DELETE_EVENT} ${october.id}`),
    `${CONFIRM_DELETE_EVENT} ${october.id}`,
  );
  assert.equal(isEventDeleted(getEventById(october.id)), true);
  assert.equal(isEventDeleted(getEventById(november.id)), false);
  assert.deepEqual(listEventsForOrganizer(OWNER).map((event) => event.id), [november.id]);
  assert.equal(listRsvpsForEvent(october.id)[0]?.status, 'yes');
  assert.equal(listInvitationsForEvent(october.id).some((row) => row.id === invite.id), true);
  assert.equal(listRsvpsForEvent(november.id)[0]?.status, 'maybe');
});

test('Delete Event list_reply for Dinner Nov 15 leaves Oct 10', async () => {
  const october = createEvent('Dinner', 'October 10', 'Hall', OWNER);
  const november = createEvent('Dinner', 'November 15', 'Cafe', OWNER);

  await handleCustomerCommand(
    listTap(OWNER, `${DELETE_EVENT} ${november.id}`, 'Dinner'),
  );
  await handleEventUpdateCommand(
    tap(OWNER, `${CONFIRM_DELETE_EVENT}:${november.id}`),
    `${CONFIRM_DELETE_EVENT}:${november.id}`,
  );
  assert.equal(isEventDeleted(getEventById(november.id)), true);
  assert.equal(isEventDeleted(getEventById(october.id)), false);
});

test('Delete Event name suffix is rejected and does not pick a duplicate', async () => {
  const first = createEvent('Dinner', 'October 10', 'Hall', OWNER);
  createEvent('Dinner', 'November 15', 'Cafe', OWNER);

  await handleEventUpdateCommand(
    tap(OWNER, `${DELETE_EVENT} Dinner`),
    `${DELETE_EVENT} Dinner`,
  );
  assert.match(lastMessage().message, /wasn't found or you don't have access/);
  assert.equal(isEventDeleted(getEventById(first.id)), false);
  assert.equal(listEventsForOrganizer(OWNER).length, 2);
});

test('single-event Delete Event skips the picker and still requires confirm', async () => {
  const only = createEvent('Katha 2', 'Sept 1', 'Temple', OWNER);
  await handleEventUpdateCommand(tap(OWNER, DELETE_EVENT), DELETE_EVENT);
  assert.match(lastMessage().message, /Remove this event from your list/);
  assert.equal(lastMessage().list, undefined);
  assert.equal(isEventDeleted(getEventById(only.id)), false);

  await handleEventUpdateCommand(
    tap(OWNER, `${CONFIRM_DELETE_EVENT} ${only.id}`),
    `${CONFIRM_DELETE_EVENT} ${only.id}`,
  );
  assert.equal(isEventDeleted(getEventById(only.id)), true);
});

test('organizer can delete their event; unauthorized phone cannot', async () => {
  const event = createEvent('Test', 'Sept 3', 'Park', OWNER);
  await handleEventUpdateCommand(
    tap(STRANGER, `${DELETE_EVENT} ${event.id}`),
    `${DELETE_EVENT} ${event.id}`,
  );
  assert.match(lastMessage().message, /wasn't found or you don't have access/);
  assert.equal(isEventDeleted(getEventById(event.id)), false);

  await handleEventUpdateCommand(
    tap(OWNER, `${DELETE_EVENT}:${event.id}`),
    `${DELETE_EVENT}:${event.id}`,
  );
  await handleEventUpdateCommand(
    tap(OWNER, `${CONFIRM_DELETE_EVENT} ${event.id}`),
    `${CONFIRM_DELETE_EVENT} ${event.id}`,
  );
  assert.equal(isEventDeleted(getEventById(event.id)), true);
});

test('co-organizer deletes only events they own', async () => {
  const mine = createEvent('Katha 2', 'Sept 1', 'Temple', OWNER);
  const theirs = createEvent('Dinner', 'October 10', 'Hall', CO_OWNER);

  await handleEventUpdateCommand(
    tap(CO_OWNER, `${DELETE_EVENT} ${mine.id}`),
    `${DELETE_EVENT} ${mine.id}`,
  );
  assert.match(lastMessage().message, /wasn't found or you don't have access/);
  assert.equal(isEventDeleted(getEventById(mine.id)), false);

  await handleCustomerCommand(tap(CO_OWNER, DELETE_EVENT));
  assert.match(lastMessage().message, /Remove this event from your list/);
  assert.match(lastMessage().message, /Dinner/);
  await handleEventUpdateCommand(
    tap(CO_OWNER, `${CONFIRM_DELETE_EVENT} ${theirs.id}`),
    `${CONFIRM_DELETE_EVENT} ${theirs.id}`,
  );
  assert.equal(isEventDeleted(getEventById(theirs.id)), true);
  assert.equal(isEventDeleted(getEventById(mine.id)), false);
});

test('Manage Event list_reply selects the matching duplicate-name event', async () => {
  const october = createEvent('Dinner', 'October 10', 'Hall', OWNER);
  const november = createEvent('Dinner', 'November 15', 'Cafe', OWNER);
  const replies = buildMyEventsReply([october, november]);
  const rows = replies.find((reply) => reply.list)?.list?.sections[0].rows ?? [];
  assert.deepEqual(
    rows.map((row) => row.id),
    [`${MANAGE_EVENT}:${october.id}`, `${MANAGE_EVENT}:${november.id}`],
  );

  await handleCustomerCommand(
    listTap(OWNER, eventListRowId(MANAGE_EVENT, october.id), 'Dinner'),
  );
  assert.match(lastMessage().message, /October 10/);
  assert.doesNotMatch(lastMessage().message, /November 15/);
  assert.equal(
    lastMessage().buttons?.some((button) => button.payload === `${MORE_EVENT} ${october.id}`),
    true,
  );
  await handleCustomerCommand(tap(OWNER, `${MORE_EVENT} ${october.id}`));
  assert.equal(
    lastMessage().list?.sections[0].rows.some(
      (row) => row.id === eventListRowId(DELETE_EVENT, october.id),
    ),
    true,
  );

  await handleCustomerCommand(
    listTap(OWNER, eventListRowId(MANAGE_EVENT, november.id), 'Dinner'),
  );
  assert.match(lastMessage().message, /November 15/);
  assert.doesNotMatch(lastMessage().message, /October 10/);
  await handleCustomerCommand(tap(OWNER, `${MORE_EVENT} ${november.id}`));
  assert.equal(
    lastMessage().list?.sections[0].rows.some(
      (row) => row.id === eventListRowId(EDIT_EVENT, november.id),
    ),
    true,
  );
});

test('View RSVPs list_reply selects the matching duplicate-name event', async () => {
  const october = createEvent('Dinner', 'October 10', 'Hall', OWNER);
  const november = createEvent('Dinner', 'November 15', 'Cafe', OWNER);
  addGuests(october.id, ['+15553336011']);
  addGuests(november.id, ['+15553336012']);
  upsertRsvp(october.id, '+15553336011', 'yes', 2, 'yes', 2, 0);
  upsertRsvp(november.id, '+15553336012', 'no', 0, 'no', 0, 0);

  await handleCustomerCommand(tap(OWNER, VIEW_RSVPS));
  const rows = lastMessage().list?.sections[0].rows ?? [];
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((row) => parseEventActionId(row.id, VIEW_RSVPS)).sort(),
    [october.id, november.id].sort(),
  );

  await handleCustomerCommand(
    listTap(OWNER, eventListRowId(VIEW_RSVPS, october.id), 'Dinner'),
  );
  assert.match(lastMessage().message, /October 10/);
  assert.match(lastMessage().message, /Yes: 1/);
  assert.doesNotMatch(lastMessage().message, /November 15/);

  await handleCustomerCommand(
    listTap(OWNER, eventListRowId(VIEW_RSVPS, november.id), 'Dinner'),
  );
  assert.match(lastMessage().message, /November 15/);
  assert.match(lastMessage().message, /No: 1/);
  assert.doesNotMatch(lastMessage().message, /October 10/);
});
