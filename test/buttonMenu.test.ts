import test from 'node:test';
import assert from 'node:assert/strict';
import {
  closeDb,
  createEvent,
  getConversationState,
  getDb,
  getEventById,
  listEventsForOrganizer,
  setConversationState,
} from '../src/db/store.js';
import {
  EVENT_DETAILS,
  HOME,
  HOME_BUTTONS,
  MAIN_MENU_BUTTONS,
  MORE_EVENT,
  SHARE_RSVP,
  VIEW_OPTIONS,
  ZIP_EVENTS,
  buildMyEventsReply,
  handleCustomerCommand,
  isHomeCommand,
  manageEventButtons,
  manageEventMoreList,
  setCustomerMessageSender,
} from '../src/commands/welcome.js';
import { handleOrganizerCommand } from '../src/commands/organizer.js';
import {
  KEEP_VALUE,
  handleEventUpdateCommand,
  setEventUpdateMessageSender,
  EDIT_EVENT,
} from '../src/commands/eventUpdateFlow.js';
import { setCreateEventMessageSender } from '../src/commands/createEventFlow.js';
import { setVendorMessageSender } from '../src/vendors/flow.js';
import type { CommandContext } from '../src/commands/organizer.js';
import type { SendMessageParams } from '../src/zernio/client.js';

process.env.DATABASE_PATH = ':memory:';

const PHONE = '+15551118801';

const sent: SendMessageParams[] = [];

function ctx(text: string, extras: Partial<CommandContext> = {}): CommandContext {
  return {
    phone: PHONE,
    text,
    conversationId: 'conv-menu',
    accountId: 'acct-menu',
    ...extras,
  };
}

function tap(payload: string): CommandContext {
  return ctx(payload, {
    buttonPayload: payload,
    interactiveType: 'button_reply',
  });
}

function lastMessage(): SendMessageParams {
  const message = sent.at(-1);
  assert.ok(message, 'expected a CONNECT reply');
  return message;
}

function assertHomeButtons(message: SendMessageParams): void {
  assert.deepEqual(message.buttons, HOME_BUTTONS);
}

test.beforeEach(() => {
  getDb();
  sent.length = 0;
  setCustomerMessageSender(async (params) => {
    sent.push(params);
  });
  setCreateEventMessageSender(async (params) => {
    sent.push(params);
  });
  setEventUpdateMessageSender(async (params) => {
    sent.push(params);
  });
  setVendorMessageSender(async (params) => {
    sent.push(params);
  });
});

test.afterEach(() => {
  setCustomerMessageSender();
  setCreateEventMessageSender();
  setEventUpdateMessageSender();
  setVendorMessageSender();
  closeDb();
});

test('typed Home is home; VIEW_OPTIONS is Home only as a button payload', () => {
  assert.equal(isHomeCommand(HOME), true);
  assert.equal(isHomeCommand('home'), true);
  assert.equal(isHomeCommand(VIEW_OPTIONS), false);
  assert.equal(isHomeCommand('view options'), false);
  assert.equal(isHomeCommand('MY_EVENTS'), false);
});

test('typing CREATE, INVITE, LIST, STATUS, or KEEP is unhandled when idle', async () => {
  for (const typed of [
    'CREATE',
    'CREATE Wedding | June 15 7pm | 123 Main St',
    'INVITE',
    'INVITE Wedding +15551234567',
    'LIST',
    'STATUS',
    'STATUS Wedding',
    'KEEP',
    'VIEW_OPTIONS',
    'view options',
    'EVENT_DETAILS',
    'SHARE_RSVP',
  ]) {
    sent.length = 0;
    const handled = await handleCustomerCommand(ctx(typed));
    assert.equal(handled, false, typed);
    assert.equal(sent.length, 0, typed);
    assert.equal(getConversationState(PHONE), undefined, typed);
  }
});

test('typed home still opens Home', async () => {
  const handled = await handleCustomerCommand(ctx('home'));
  assert.equal(handled, true);
  assert.equal(lastMessage().message, 'What would you like to do?');
  assertHomeButtons(lastMessage());
});

test('VIEW_OPTIONS button payload still opens Home', async () => {
  const handled = await handleCustomerCommand(tap(VIEW_OPTIONS));
  assert.equal(handled, true);
  assert.equal(lastMessage().message, 'What would you like to do?');
  assertHomeButtons(lastMessage());
});

test('EVENT_DETAILS and SHARE_RSVP button payloads still work', async () => {
  const event = createEvent('Gala', 'Dec 1', 'Hotel', PHONE);

  let handled = await handleCustomerCommand(tap(`${EVENT_DETAILS} ${event.id}`));
  assert.equal(handled, true);
  assert.match(lastMessage().message, /📅 Gala/);
  assert.deepEqual(
    lastMessage().buttons?.map((button) => button.payload),
    manageEventButtons(event).map((button) => button.payload),
  );

  sent.length = 0;
  handled = await handleCustomerCommand(tap(SHARE_RSVP));
  assert.equal(handled, true);
  assert.match(lastMessage().message, /Forward the invitation above/);
});

test('typed CREATE pipe does not create an event', async () => {
  const before = listEventsForOrganizer(PHONE).length;
  await handleCustomerCommand(
    ctx('CREATE Pipe Party | June 15 7pm | 123 Main St'),
  );
  assert.equal(listEventsForOrganizer(PHONE).length, before);
  assert.equal(getConversationState(PHONE), undefined);
});

test('greeting shows ZipNest with ZipEvents as the primary action', async () => {
  const handled = await handleCustomerCommand(ctx('Hi'));
  assert.equal(handled, true);
  assert.match(lastMessage().message, /Welcome to ZipNest/);
  assert.match(lastMessage().message, /🍴 ZipBite — Coming Soon/);
  assert.match(lastMessage().message, /\nProvider$/);
  assert.deepEqual(lastMessage().buttons, MAIN_MENU_BUTTONS);
  assert.deepEqual(
    lastMessage().buttons?.map((button) => button.payload),
    [ZIP_EVENTS, 'PROVIDER'],
  );
  assert.equal(
    lastMessage().buttons?.some((button) => button.title === 'Provider'),
    true,
  );
  assert.equal(
    lastMessage().buttons?.some((button) => /ZipBite/i.test(button.title)),
    false,
  );
  assert.equal(
    lastMessage().buttons?.some((button) => button.payload === VIEW_OPTIONS),
    false,
  );
});

test('ZipEvents opens the unchanged event menu', async () => {
  const handled = await handleCustomerCommand(tap(ZIP_EVENTS));
  assert.equal(handled, true);
  assert.match(lastMessage().message, /🎉 \*ZipEvents\*/);
  assert.match(lastMessage().message, /Moments to Memory/);
  assertHomeButtons(lastMessage());
});

test('Provider button opens the existing ZipNest Provider Account', async () => {
  const handled = await handleCustomerCommand(tap('PROVIDER'));
  assert.equal(handled, true);
  assert.match(lastMessage().message, /ZipNest Provider Account/);
  assert.equal(
    lastMessage().buttons?.some((button) => button.payload === 'VENDOR_MENU'),
    true,
  );
  assert.doesNotMatch(lastMessage().message, /🎉 \*ZipEvents\*/);
});

test('typed ZipEvents from the welcome body opens the event menu', async () => {
  const handled = await handleCustomerCommand(ctx('🎉 ZipEvents'));
  assert.equal(handled, true);
  assert.match(lastMessage().message, /🎉 \*ZipEvents\*/);
  assertHomeButtons(lastMessage());
});

test('Help is the same for organizers and has no typed commands', async () => {
  await handleCustomerCommand(ctx('HELP'));
  const customer = lastMessage().message;
  assert.match(customer, /CONNECT Help/);
  assert.doesNotMatch(customer, /RSVP Bot Commands/);
  assert.doesNotMatch(customer, /\*CREATE\*/);
  assert.doesNotMatch(customer, /\*INVITE\*/);
  assert.doesNotMatch(customer, /\*LIST\*/);
  assert.doesNotMatch(customer, /\*STATUS\*/);
  assertHomeButtons(lastMessage());

  sent.length = 0;
  await handleOrganizerCommand(ctx('HELP'));
  assert.equal(lastMessage().message, customer);
  assertHomeButtons(lastMessage());
});

test('Manage Event is Invite, RSVPs, and More', () => {
  const event = createEvent('Gala', 'Dec 1', 'Hotel', PHONE);
  assert.deepEqual(
    manageEventButtons(event).map((button) => button.title),
    ['📩 Invite', '👥 RSVPs', 'More…'],
  );
  assert.deepEqual(
    manageEventMoreList(event).sections[0].rows.map((row) => row.title),
    [
      '👥 Guest List',
      '✏️ Edit Event',
      '📢 Send Update',
      '❌ Cancel Event',
      '🗑️ Delete Event',
    ],
  );
});

test('More list opens edit, update, cancel, and delete without typed STATUS', async () => {
  const event = createEvent('Gala', 'Dec 1', 'Hotel', PHONE);
  await handleCustomerCommand(tap(`${MORE_EVENT} ${event.id}`));
  assert.match(lastMessage().message, /More options for \*Gala\*/);
  assert.equal(lastMessage().list?.button, 'More');
  assert.doesNotMatch(lastMessage().message, /STATUS EventName/);
});

test('Edit Event asks which field to change instead of Keep', async () => {
  const event = createEvent('Katha', 'October 1, 2026 at 5:00 PM', 'Hall', PHONE);
  await handleEventUpdateCommand(
    tap(`${EDIT_EVENT} ${event.id}`),
    `${EDIT_EVENT} ${event.id}`,
  );
  assert.match(lastMessage().message, /What would you like to change/);
  assert.equal(lastMessage().buttons, undefined);
  assert.equal(
    lastMessage().list?.sections[0].rows.some(
      (row) => row.title === 'Keep' || row.id.includes(KEEP_VALUE),
    ),
    false,
  );
  assert.ok(
    lastMessage().list?.sections[0].rows.some((row) => row.title === 'Name'),
  );
});

test('typing KEEP during edit is treated as the new name', async () => {
  const event = createEvent('Katha', 'October 1, 2026 at 5:00 PM', 'Hall', PHONE);
  await handleEventUpdateCommand(
    tap(`${EDIT_EVENT} ${event.id}`),
    `${EDIT_EVENT} ${event.id}`,
  );
  setConversationState(PHONE, 'WAITING_FOR_EDIT_NAME', {
    event_id: event.id,
    name: event.name,
    date: event.date,
    location: event.location,
  });
  const handled = await handleCustomerCommand(ctx('KEEP'));
  assert.equal(handled, true);
  assert.equal(getEventById(event.id)?.name, 'KEEP');
  assert.equal(getConversationState(PHONE), undefined);
  assert.notEqual(lastMessage().message, 'Please use the buttons below to navigate CONNECT.');
});

test('typed CREATE during name step is used as the event name', async () => {
  setConversationState(PHONE, 'WAITING_FOR_EVENT_NAME');
  const handled = await handleCustomerCommand(ctx('CREATE'));
  assert.equal(handled, true);
  assert.equal(getConversationState(PHONE)?.state, 'WAITING_FOR_EVENT_TIMEZONE');
  assert.equal(getConversationState(PHONE)?.name, 'CREATE');
  assert.match(lastMessage().message, /What timezone is this event in/);
});

test('My Events overflow no longer tells people to type STATUS EventName', () => {
  const events = Array.from({ length: 12 }, (_, index) =>
    createEvent(`Party ${index + 1}`, 'July 4', 'Park', PHONE),
  );
  const replies = buildMyEventsReply(events);
  const body = replies.map((reply) => reply.message).join('\n');
  assert.match(body, /Open the web link below to see all of them/);
  assert.doesNotMatch(body, /STATUS EventName/);
});
