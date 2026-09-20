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
  getGuest,
  listEventsForOrganizer,
  listRsvpsForEvent,
  setConversationState,
  upsertRsvp,
  type ConversationStep,
} from '../src/db/store.js';
import {
  handleCustomerCommand,
  isGreeting,
  isOrganizerWizardState,
  pauseOrganizerWizard,
  setCustomerMessageSender,
} from '../src/commands/welcome.js';
import { handleOrganizerCommand } from '../src/commands/organizer.js';
import {
  continueCreateEventFlow,
  setCreateEventMessageSender,
} from '../src/commands/createEventFlow.js';
import {
  continueInviteFlow,
  setInviteMessageSender,
} from '../src/commands/inviteFlow.js';
import { setEventUpdateMessageSender } from '../src/commands/eventUpdateFlow.js';
import type { CommandContext } from '../src/commands/organizer.js';
import type { SendMessageParams } from '../src/zernio/client.js';

process.env.DATABASE_PATH = ':memory:';

const PHONE = '+15551119999';
const GUEST = '+15552229999';

const GREETINGS = [
  'Hi',
  'hello',
  'HEY',
  'good morning',
  'Good Evening',
  'start',
] as const;

const CREATE_STEPS: ConversationStep[] = [
  'WAITING_FOR_EVENT_NAME',
  'WAITING_FOR_EVENT_TIMEZONE',
  'WAITING_FOR_EVENT_DATE',
  'WAITING_FOR_EVENT_TIME',
  'WAITING_FOR_EVENT_LOCATION',
  'WAITING_FOR_ADD_DETAILS',
  'WAITING_FOR_EVENT_THEME',
  'WAITING_FOR_CUSTOM_THEME',
  'WAITING_FOR_DRESS_CODE',
  'WAITING_FOR_DRESS_CODE_TEXT',
  'WAITING_FOR_EVENT_IMAGE',
  'WAITING_FOR_INVITATION_COUNT',
  'WAITING_FOR_RSVP_DEADLINE',
  'WAITING_FOR_CHILDREN_POLICY',
  'WAITING_FOR_REMINDER_SETTING',
  'CONFIRMING_EVENT',
];

const INVITE_STEPS: ConversationStep[] = [
  'WAITING_FOR_FAMILY_NAME',
  'WAITING_FOR_FAMILY_GUEST_LIMIT',
  'WAITING_FOR_GROUP_NAME',
  'WAITING_FOR_GROUP_MEMBER',
];

const UPDATE_STEPS: ConversationStep[] = [
  'WAITING_FOR_EDIT_FIELD',
  'WAITING_FOR_EDIT_NAME',
  'WAITING_FOR_EDIT_DATE',
  'WAITING_FOR_EDIT_TIME',
  'WAITING_FOR_EDIT_TIMEZONE',
  'WAITING_FOR_EDIT_LOCATION',
  'WAITING_FOR_EDIT_THEME',
  'WAITING_FOR_EDIT_CUSTOM_THEME',
  'WAITING_FOR_EDIT_DRESS',
  'WAITING_FOR_EDIT_DRESS_TEXT',
  'WAITING_FOR_EDIT_DEADLINE',
  'WAITING_FOR_EDIT_IMAGE',
  'WAITING_FOR_UPDATE_MESSAGE',
  'WAITING_FOR_UPDATE_TYPE',
];

const sent: SendMessageParams[] = [];

function ctx(text: string): CommandContext {
  return {
    phone: PHONE,
    text,
    conversationId: 'conv-greeting',
    accountId: 'acct-greeting',
    senderName: 'Ada Lovelace',
  };
}

function lastMessage(): SendMessageParams {
  const message = sent.at(-1);
  assert.ok(message, 'expected a CONNECT reply');
  return message;
}

function assertWelcomeMenu(message: SendMessageParams): void {
  assert.match(message.message, /Welcome to CONNECT/);
  assert.match(message.message, /Moments to Memory/);
  assert.doesNotMatch(message.message, /Welcome to CONNECT by zipbite/);
  assert.doesNotMatch(message.message, /How many guests can attend/);
  assert.doesNotMatch(message.message, /What would you like to call it/);
  assert.doesNotMatch(message.message, /Which family are you inviting/);
  assert.deepEqual(
    message.buttons?.map((button) => button.payload),
    ['CREATE_EVENT', 'MY_EVENTS', 'HELP'],
  );
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
  setInviteMessageSender(async (params) => {
    sent.push(params);
  });
  setEventUpdateMessageSender(async (params) => {
    sent.push(params);
  });
});

test.afterEach(() => {
  setCustomerMessageSender();
  setCreateEventMessageSender();
  setInviteMessageSender();
  setEventUpdateMessageSender();
  closeDb();
});

test('isGreeting and wizard-state helpers cover the CONNECT start phrases', () => {
  for (const greeting of GREETINGS) {
    assert.equal(isGreeting(greeting), true);
  }
  assert.equal(isGreeting('Patel Family'), false);
  assert.equal(isOrganizerWizardState('WAITING_FOR_FAMILY_GUEST_LIMIT'), true);
  assert.equal(isOrganizerWizardState('WAITING_FOR_UPDATE_MESSAGE'), true);
  assert.equal(isOrganizerWizardState('WAITING_FOR_RSVP_ADULTS'), false);
});

test('Hi while waiting for guest limit shows welcome and does not save Hi', async () => {
  const event = createEvent('Wedding', 'June 15', 'Hall', PHONE);
  setConversationState(PHONE, 'WAITING_FOR_FAMILY_GUEST_LIMIT', {
    event_id: event.id,
    invite_type: 'family',
    family_name: 'Patel Family',
  });

  const handled = await handleCustomerCommand(ctx('Hi'));

  assert.equal(handled, true);
  assertWelcomeMenu(lastMessage());
  assert.equal(getConversationState(PHONE), undefined);
  assert.equal(getEventById(event.id)?.name, 'Wedding');
  assert.equal(listEventsForOrganizer(PHONE).length, 1);
});

test('organizer Hi on a stale invite step also shows welcome', async () => {
  const event = createEvent('Wedding', 'June 15', 'Hall', PHONE);
  setConversationState(PHONE, 'WAITING_FOR_FAMILY_GUEST_LIMIT', {
    event_id: event.id,
    family_name: 'Patel Family',
  });

  const handled = await handleOrganizerCommand(ctx('Hi'));

  assert.equal(handled, true);
  assertWelcomeMenu(lastMessage());
  assert.equal(getConversationState(PHONE), undefined);
  assert.equal(getEventById(event.id)?.id, event.id);
});

test('every greeting on every create/invite step shows welcome and is not stored', async () => {
  for (const greeting of GREETINGS) {
    for (const step of [...CREATE_STEPS, ...INVITE_STEPS, ...UPDATE_STEPS]) {
      sent.length = 0;
      const event = createEvent('Garden Party', 'July 4', 'Park', PHONE);
      setConversationState(PHONE, step, {
        event_id: event.id,
        name: 'Draft Name',
        date: 'Sunday, September 20, 2026',
        location: 'Hall',
        family_name: 'Patel Family',
        group_name: 'College Friends',
      });

      const handled = await handleCustomerCommand(ctx(greeting));

      assert.equal(handled, true, `${greeting} on ${step} should be handled`);
      assertWelcomeMenu(lastMessage());
      assert.equal(getConversationState(PHONE), undefined, `${greeting} on ${step}`);
      const stored = getEventById(event.id);
      assert.ok(stored);
      assert.equal(stored.name, 'Garden Party');
      assert.notEqual(stored.name, greeting);
      assert.notEqual(stored.location, greeting);
    }
  }
});

test('valid event name still continues create-event after a prior greeting pause', async () => {
  setConversationState(PHONE, 'WAITING_FOR_EVENT_NAME');
  await handleCustomerCommand(ctx('Hi'));
  assert.equal(getConversationState(PHONE), undefined);
  assertWelcomeMenu(lastMessage());

  setConversationState(PHONE, 'WAITING_FOR_EVENT_NAME');
  const continued = await continueCreateEventFlow(ctx('Summer BBQ'), 'Summer BBQ');

  assert.equal(continued, true);
  assert.equal(getConversationState(PHONE)?.state, 'WAITING_FOR_EVENT_TIMEZONE');
  assert.equal(getConversationState(PHONE)?.name, 'Summer BBQ');
  assert.match(lastMessage().message, /What timezone is this event in/);
});

test('valid family name and guest limit still continue the invite wizard', async () => {
  const event = createEvent('Wedding', 'June 15', 'Hall', PHONE);
  setConversationState(PHONE, 'WAITING_FOR_FAMILY_NAME', {
    event_id: event.id,
    invite_type: 'family',
  });

  const named = await continueInviteFlow(ctx('Patel Family'), 'Patel Family');
  assert.equal(named, true);
  assert.equal(getConversationState(PHONE)?.state, 'WAITING_FOR_FAMILY_GUEST_LIMIT');
  assert.equal(getConversationState(PHONE)?.family_name, 'Patel Family');
  assert.match(lastMessage().message, /How many guests can attend from \*Patel Family\*/);

  const limited = await continueInviteFlow(ctx('4'), '4');
  assert.equal(limited, true);
  assert.equal(getConversationState(PHONE), undefined);
  assert.match(lastMessage().message, /Forward the invitation above/);
  assert.match(lastMessage().message, /Invite more/);
  assert.deepEqual(
    lastMessage().buttons?.map((button) => button.title),
    ['➕ Invite More', '✅ Done Sending'],
  );
});

test('greeting does not delete events or RSVPs', async () => {
  const event = createEvent('Wedding', 'June 15', 'Hall', PHONE);
  const invitation = createInvitation({ eventId: event.id, type: 'individual' });
  addGuests(event.id, [GUEST], invitation.id);
  upsertRsvp(event.id, GUEST, 'yes', 2, 'yes', 2, 0);

  setConversationState(PHONE, 'WAITING_FOR_EVENT_NAME', { name: 'Unfinished' });
  await handleCustomerCommand(ctx('hello'));

  assert.equal(getEventById(event.id)?.name, 'Wedding');
  assert.equal(getGuest(event.id, GUEST)?.phone, GUEST);
  const rsvps = listRsvpsForEvent(event.id);
  assert.equal(rsvps.length, 1);
  assert.equal(rsvps[0].status, 'yes');
  assert.equal(rsvps[0].guest_count, 2);
  assert.equal(listEventsForOrganizer(PHONE).length, 1);
});

test('continueCreateEventFlow refuses a greeting as an event name', async () => {
  setConversationState(PHONE, 'WAITING_FOR_EVENT_NAME');

  const handled = await continueCreateEventFlow(ctx('Hi'), 'Hi');

  assert.equal(handled, false);
  assert.equal(getConversationState(PHONE)?.state, 'WAITING_FOR_EVENT_NAME');
  assert.equal(getConversationState(PHONE)?.name ?? null, null);
  assert.equal(sent.length, 0);
});

test('continueInviteFlow refuses a greeting as a family name or guest limit', async () => {
  const event = createEvent('Wedding', 'June 15', 'Hall', PHONE);
  setConversationState(PHONE, 'WAITING_FOR_FAMILY_NAME', {
    event_id: event.id,
    invite_type: 'family',
  });

  assert.equal(await continueInviteFlow(ctx('Hi'), 'Hi'), false);
  assert.equal(getConversationState(PHONE)?.state, 'WAITING_FOR_FAMILY_NAME');
  assert.equal(getConversationState(PHONE)?.family_name ?? null, null);

  setConversationState(PHONE, 'WAITING_FOR_FAMILY_GUEST_LIMIT', {
    event_id: event.id,
    family_name: 'Patel Family',
  });
  assert.equal(await continueInviteFlow(ctx('hello'), 'hello'), false);
  assert.equal(getConversationState(PHONE)?.state, 'WAITING_FOR_FAMILY_GUEST_LIMIT');
  assert.equal(getConversationState(PHONE)?.family_name, 'Patel Family');
  assert.equal(getConversationState(PHONE)?.max_guests ?? null, null);
  assert.equal(sent.length, 0);
});

test('pauseOrganizerWizard clears only create/invite steps, not RSVP steps', () => {
  setConversationState(PHONE, 'WAITING_FOR_RSVP_ADULTS', {
    event_id: 1,
    adult_count: 2,
  });

  pauseOrganizerWizard(PHONE);

  assert.equal(getConversationState(PHONE)?.state, 'WAITING_FOR_RSVP_ADULTS');
  assert.equal(getConversationState(PHONE)?.adult_count, 2);
});

test('hi from RSVP conversational state still follows existing greeting behavior', async () => {
  const event = createEvent('Wedding', 'June 15', 'Hall', PHONE);
  setConversationState(PHONE, 'WAITING_FOR_RSVP_ADULTS', {
    event_id: event.id,
    adult_count: 2,
  });

  const handled = await handleCustomerCommand(ctx('hi'));

  assert.equal(handled, true);
  assertWelcomeMenu(lastMessage());
  assert.equal(getConversationState(PHONE)?.state, 'WAITING_FOR_RSVP_ADULTS');
  assert.equal(getConversationState(PHONE)?.adult_count, 2);
  assert.equal(getEventById(event.id)?.name, 'Wedding');
});

test('after greeting, a later Create Event starts the name prompt instead of guest limit', async () => {
  const event = createEvent('Wedding', 'June 15', 'Hall', PHONE);
  setConversationState(PHONE, 'WAITING_FOR_FAMILY_GUEST_LIMIT', {
    event_id: event.id,
    family_name: 'Patel Family',
  });

  await handleCustomerCommand(ctx('Hi'));
  assert.equal(getConversationState(PHONE), undefined);

  const started = await handleCustomerCommand({
    ...ctx('CREATE_EVENT'),
    buttonPayload: 'CREATE_EVENT',
  });

  assert.equal(started, true);
  assert.equal(getConversationState(PHONE)?.state, 'WAITING_FOR_EVENT_NAME');
  assert.match(lastMessage().message, /What would you like to call it/);
  assert.doesNotMatch(lastMessage().message, /How many guests can attend/);
});

test('Done Sending clears invite wizard state and does not keep asking invite more', async () => {
  const event = createEvent('Wedding', 'June 15', 'Hall', PHONE);
  setConversationState(PHONE, 'WAITING_FOR_FAMILY_NAME', {
    event_id: event.id,
    invite_type: 'family',
  });

  const handled = await handleCustomerCommand({
    ...ctx(`DONE_SENDING ${event.id}`),
    buttonPayload: `DONE_SENDING ${event.id}`,
    interactiveType: 'button_reply',
  });

  assert.equal(handled, true);
  assert.equal(getConversationState(PHONE), undefined);
  assert.equal(
    lastMessage().message,
    [
      '✅ All set!',
      '',
      'Your invitations have been sent.',
      '',
      'You can manage your event anytime from My Events.',
    ].join('\n'),
  );
  assert.doesNotMatch(lastMessage().message, /Would you like to invite anyone else/);
  assert.doesNotMatch(lastMessage().message, /Exit/);
  assert.deepEqual(lastMessage().buttons, [
    { title: '📊 View RSVPs', payload: `VIEW_RSVPS ${event.id}` },
    { title: '🏠 Main Menu', payload: 'HOME' },
  ]);
});
