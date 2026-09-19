import test from 'node:test';
import assert from 'node:assert/strict';
import {
  closeDb,
  getConversationState,
  getDb,
  setConversationState,
} from '../src/db/store.js';
import { WHATSAPP_LIST_ROW_TITLE_LIMIT } from '../src/whatsapp/eventList.js';
import {
  ADD_DETAILS,
  SKIP_DETAILS,
  ADULTS_ONLY,
  CHILDREN_ALLOWED,
  ADD_DETAILS_BUTTONS,
  ADD_DETAILS_PROMPT,
  CHILDREN_POLICY_BUTTONS,
  CHILDREN_POLICY_PROMPT,
  DEADLINE_2_WEEKS,
  DEADLINE_CUSTOM,
  DEADLINE_SKIP,
  IMAGE_SKIP,
  MERIDIEM_PROMPT,
  REMINDER_1,
  REMINDER_2,
  REMINDER_3,
  REMINDER_BUTTONS,
  REMINDER_LIST_BUTTON,
  REMINDER_NONE,
  REMINDER_PROMPT,
  RSVP_DEADLINE_LIST_BUTTON,
  RSVP_DEADLINE_PROMPT,
  SKIP_STEP_TITLE,
  TIME_PROMPT,
  continueCreateEventFlow,
  formatDateQuestion,
  formatEventConfirmation,
  formatReminderDays,
  formatTimeQuestion,
  parseChildrenPolicyChoice,
  parseRsvpDeadlineChoice,
  reminderChoiceList,
  rsvpDeadlineChoiceList,
  CONFIRM_EVENT,
  setCreateEventMessageSender,
  setCreateEventReminderSending,
} from '../src/commands/createEventFlow.js';
import {
  DRESS_SKIP,
  eventThemeChoiceList,
} from '../src/events/theme.js';
import { parseEventDate, rsvpDeadlineWeeksBefore } from '../src/dates/eventDate.js';
import { handleOrganizerCommand } from '../src/commands/organizer.js';
import { inviteTypeButtons } from '../src/commands/inviteFlow.js';
import {
  getIncomingMessageContext,
  getInteractiveReply,
  type ZernioWebhookPayload,
} from '../src/webhooks/zernio.js';
import type { SendMessageParams } from '../src/zernio/client.js';
import { toWhatsAppListRowId } from '../src/whatsapp/eventList.js';

process.env.DATABASE_PATH = ':memory:';

const PHONE = '+15551118888';
const ctx = {
  phone: PHONE,
  conversationId: 'conv-create',
  accountId: 'acct-create',
};

const sent: SendMessageParams[] = [];

function lastMessage(): SendMessageParams {
  const message = sent.at(-1);
  assert.ok(message, 'expected a create-event reply');
  return message;
}

test.beforeEach(() => {
  getDb();
  sent.length = 0;
  setCreateEventMessageSender(async (params) => {
    sent.push(params);
  });
});

test.afterEach(() => {
  setCreateEventMessageSender();
  setCreateEventReminderSending();
  closeDb();
});

function zernioButtonReply(options: {
  id: string;
  title: string;
  interactiveId: string;
  buttonPayload?: string;
}): ZernioWebhookPayload {
  return {
    id: options.id,
    event: 'message.received',
    account: { id: ctx.accountId },
    conversation: { id: ctx.conversationId },
    message: {
      conversationId: ctx.conversationId,
      text: options.title,
      sender: { phoneNumber: PHONE },
    },
    metadata: {
      interactiveType: 'button_reply',
      interactiveId: options.interactiveId,
      ...(options.buttonPayload !== undefined
        ? { buttonPayload: options.buttonPayload }
        : {}),
    },
  };
}

async function handleZernioChildrenButton(
  payload: ZernioWebhookPayload,
): Promise<boolean> {
  const incoming = getIncomingMessageContext(payload);
  const interactive = getInteractiveReply(payload);
  return handleOrganizerCommand({
    phone: incoming.phone ?? PHONE,
    text: incoming.text,
    conversationId: incoming.conversationId ?? ctx.conversationId,
    accountId: incoming.accountId ?? ctx.accountId,
    interactiveId: interactive.interactiveId,
    buttonPayload: interactive.buttonPayload,
    interactiveType: interactive.interactiveType,
  });
}

function assertWhatsAppLegalReminderPrompt(reply: SendMessageParams): void {
  assert.equal(reply.message, REMINDER_PROMPT);
  assert.equal(reply.buttons, undefined);
  assert.deepEqual(reply.list, reminderChoiceList());
  assert.equal(reply.list?.button, REMINDER_LIST_BUTTON);
  assert.equal(reply.list?.sections[0].title, 'RSVP Reminder');
  assert.equal(reply.list?.sections[0].rows.length, 4);
  assert.deepEqual(
    reply.list?.sections[0].rows.map((row) => row.id),
    [REMINDER_1, REMINDER_2, REMINDER_3, REMINDER_NONE],
  );
  assert.equal(
    reply.list?.sections[0].rows.every(
      (row) => row.title.length <= WHATSAPP_LIST_ROW_TITLE_LIMIT,
    ),
    true,
  );
}

test('NL date with time continues to location without a correctness confirm', async () => {
  setConversationState(PHONE, 'WAITING_FOR_EVENT_DATE', { name: 'Wedding' });

  await continueCreateEventFlow(ctx, 'this Friday at 7:30 PM');

  const state = getConversationState(PHONE);
  assert.equal(state?.state, 'WAITING_FOR_EVENT_LOCATION');
  assert.match(state?.date ?? '', /Friday/);
  assert.match(state?.date ?? '', /7:30\s*PM/i);

  const reply = lastMessage();
  assert.match(reply.message, /Where will \*Wedding\* be held/);
  assert.doesNotMatch(reply.message, /Is this correct/i);
  assert.doesNotMatch(reply.message, /Got it/);
  assert.doesNotMatch(reply.message, /Please confirm your event/);
});

test('Friday without time stays on date/time and asks for a start time', async () => {
  setConversationState(PHONE, 'WAITING_FOR_EVENT_DATE', { name: 'Wedding' });

  await continueCreateEventFlow(ctx, 'Friday');

  const state = getConversationState(PHONE);
  assert.equal(state?.state, 'WAITING_FOR_EVENT_TIME');
  assert.ok(state?.date);
  assert.doesNotMatch(state?.date ?? '', / at /);
  assert.ok(lastMessage().message.includes(TIME_PROMPT));
  assert.match(lastMessage().message, /\/d\//);
});

test('around evening stays on date/time and asks for a specific time', async () => {
  setConversationState(PHONE, 'WAITING_FOR_EVENT_DATE', { name: 'Wedding' });

  await continueCreateEventFlow(ctx, 'around evening');

  assert.equal(getConversationState(PHONE)?.state, 'WAITING_FOR_EVENT_DATE');
  assert.match(lastMessage().message, /specific start time/i);
  assert.doesNotMatch(lastMessage().message, /Is this correct/i);
});

test('7:30 without AM or PM stays and asks for AM or PM', async () => {
  setConversationState(PHONE, 'WAITING_FOR_EVENT_DATE', { name: 'Wedding' });

  await continueCreateEventFlow(ctx, '7:30');

  assert.equal(getConversationState(PHONE)?.state, 'WAITING_FOR_EVENT_DATE');
  assert.ok(lastMessage().message.includes(MERIDIEM_PROMPT));
  assert.match(lastMessage().message, /\/d\//);
});

test('time step 7:30 without AM or PM stays on time', async () => {
  setConversationState(PHONE, 'WAITING_FOR_EVENT_TIME', {
    name: 'Wedding',
    date: 'Sunday, September 20, 2026',
  });

  await continueCreateEventFlow(ctx, '7:30');

  const state = getConversationState(PHONE);
  assert.equal(state?.state, 'WAITING_FOR_EVENT_TIME');
  assert.equal(state?.date, 'Sunday, September 20, 2026');
  assert.ok(lastMessage().message.includes(MERIDIEM_PROMPT));
  assert.match(lastMessage().message, /\/d\//);
});

test('valid 7:30 PM on the time step continues to location without confirm', async () => {
  setConversationState(PHONE, 'WAITING_FOR_EVENT_TIME', {
    name: 'Wedding',
    date: 'Sunday, September 20, 2026',
  });

  await continueCreateEventFlow(ctx, '7:30 PM');

  const state = getConversationState(PHONE);
  assert.equal(state?.state, 'WAITING_FOR_EVENT_LOCATION');
  assert.equal(state?.date, 'Sunday, September 20, 2026 at 7:30 PM');
  assert.match(lastMessage().message, /Where will \*Wedding\* be held/);
  assert.doesNotMatch(lastMessage().message, /Is this correct/i);
});

test('reminder uses interactive buttons and a valid tap skips extra confirm', async () => {
  setConversationState(PHONE, 'WAITING_FOR_REMINDER_SETTING', {
    name: 'Wedding',
    date: 'Sunday, September 20, 2026 at 7:30 PM',
    location: 'Hall',
    rsvp_deadline: 'Tuesday, September 15, 2026',
    children_allowed: 1,
  });

  assert.deepEqual(
    REMINDER_BUTTONS.map((button) => button.title),
    ['1 day before RSVP closes', '2 days before RSVP close', '3 days before RSVP close', 'No reminder'],
  );
  assert.equal(formatReminderDays(null), 'No reminder');
  assert.equal(formatReminderDays(1), '1 day before RSVP closes');
  assert.equal(formatReminderDays(2), '2 days before RSVP closes');

  await continueCreateEventFlow(ctx, 'REMINDER_1');

  const state = getConversationState(PHONE);
  assert.equal(state?.state, 'WAITING_FOR_CHILDREN_POLICY');
  assert.equal(state?.reminder_days, 1);

  const reply = lastMessage();
  assert.equal(reply.message, CHILDREN_POLICY_PROMPT);
  assert.doesNotMatch(reply.message, /Is this correct/i);
  assert.deepEqual(reply.buttons?.map((button) => button.payload), [
    CHILDREN_POLICY_BUTTONS[0].payload,
    CHILDREN_POLICY_BUTTONS[1].payload,
  ]);
});

test('unrecognized reminder reply stays and re-shows the buttons', async () => {
  setConversationState(PHONE, 'WAITING_FOR_REMINDER_SETTING', {
    name: 'Wedding',
    date: 'Sunday, September 20, 2026 at 7:30 PM',
    location: 'Hall',
  });

  await continueCreateEventFlow(ctx, 'maybe later');

  assert.equal(
    getConversationState(PHONE)?.state,
    'WAITING_FOR_REMINDER_SETTING',
  );
  const reply = lastMessage();
  assertWhatsAppLegalReminderPrompt(reply);
  assert.doesNotMatch(reply.message, /Please confirm your event/);
});

test('create summary shows the resolved date and time', () => {
  const summary = formatEventConfirmation({
    organizer_phone: PHONE,
    state: 'CONFIRMING_EVENT',
    name: 'Wedding',
    date: 'Friday, September 11, 2026 at 7:30 PM',
    location: 'Hall',
    invitation_count: null,
    rsvp_deadline: null,
    children_allowed: 1,
    reminder_days: null,
    event_id: null,
    adult_count: null,
    child_count: null,
    invitation_id: null,
    invite_type: null,
    family_name: null,
    max_guests: null,
    group_name: null,
    updated_at: '',
  });

  assert.match(summary, /Please confirm your event/);
  assert.match(summary, /Friday, September 11, 2026 at 7:30 PM/);
  assert.doesNotMatch(summary, /this Friday/i);
});

test('Who can attend buttons use Adults only / Adults & Children payloads', () => {
  assert.equal(CHILDREN_POLICY_PROMPT, 'Who can attend?');
  assert.deepEqual(CHILDREN_POLICY_BUTTONS, [
    { title: 'Adults only', payload: ADULTS_ONLY },
    { title: 'Adults & Children', payload: CHILDREN_ALLOWED },
  ]);
  assert.equal(parseChildrenPolicyChoice(ADULTS_ONLY), 0);
  assert.equal(parseChildrenPolicyChoice('Adults only'), 0);
  assert.equal(parseChildrenPolicyChoice(CHILDREN_ALLOWED), 1);
  assert.equal(parseChildrenPolicyChoice('Adults & Children'), 1);
  assert.equal(parseChildrenPolicyChoice('Adults &amp; Children'), 1);
  assert.equal(parseChildrenPolicyChoice('Children allowed'), 1);
});

function seedChildrenPolicy(): void {
  setConversationState(PHONE, 'WAITING_FOR_CHILDREN_POLICY', {
    name: 'Wedding',
    date: 'Sunday, September 20, 2026 at 7:30 PM',
    location: 'Hall',
    rsvp_deadline: 'Tuesday, September 15, 2026',
  });
}

test('Adults only button saves children_allowed=0 and goes to the next step', async () => {
  seedChildrenPolicy();

  const handled = await continueCreateEventFlow(ctx, ADULTS_ONLY);

  assert.equal(handled, true);
  const state = getConversationState(PHONE);
  assert.equal(state?.state, 'CONFIRMING_EVENT');
  assert.equal(state?.children_allowed, 0);
  const reply = lastMessage();
  assert.match(reply.message, /Please confirm your event/);
  assert.match(reply.message, /Adults only/);
  assert.doesNotMatch(reply.message, /Is this correct/i);
  assert.doesNotMatch(reply.message, /Who can attend/);
  assert.deepEqual(reply.buttons?.map((button) => button.title), [
    'Confirm',
    'Cancel',
  ]);
});

test('Adults & Children button saves children_allowed=1 and goes to the next step', async () => {
  seedChildrenPolicy();

  const handled = await continueCreateEventFlow(ctx, 'Adults & Children');

  assert.equal(handled, true);
  const state = getConversationState(PHONE);
  assert.equal(state?.state, 'CONFIRMING_EVENT');
  assert.equal(state?.children_allowed, 1);
  const reply = lastMessage();
  assert.match(reply.message, /Please confirm your event/);
  assert.match(reply.message, /Adults & Children/);
  assert.doesNotMatch(reply.message, /Is this correct/i);
  assert.doesNotMatch(reply.message, /Who can attend/);
});

test('children policy interactive id is used when buttonPayload is empty and text is the prompt', async () => {
  seedChildrenPolicy();

  const handled = await continueCreateEventFlow(
    {
      ...ctx,
      text: CHILDREN_POLICY_PROMPT,
      buttonPayload: '',
      interactiveId: ADULTS_ONLY,
      interactiveType: 'button_reply',
    },
    CHILDREN_POLICY_PROMPT,
  );

  assert.equal(handled, true);
  const state = getConversationState(PHONE);
  assert.equal(state?.state, 'CONFIRMING_EVENT');
  assert.equal(state?.children_allowed, 0);
  assert.match(lastMessage().message, /Please confirm your event/);
});

test('organizer children button callback is not treated as greeting text', async () => {
  seedChildrenPolicy();

  const handled = await handleOrganizerCommand({
    ...ctx,
    text: 'Adults & Children',
    buttonPayload: '',
    interactiveId: CHILDREN_ALLOWED,
    interactiveType: 'button_reply',
  });

  assert.equal(handled, true);
  const state = getConversationState(PHONE);
  assert.equal(state?.state, 'CONFIRMING_EVENT');
  assert.equal(state?.children_allowed, 1);
  assert.match(lastMessage().message, /Please confirm your event/);
  assert.doesNotMatch(lastMessage().message, /Welcome to CONNECT/);
});

test('actual Zernio Adults only callback saves policy and sends next WhatsApp message', async () => {
  setCreateEventReminderSending(true);
  seedChildrenPolicy();

  const payload = zernioButtonReply({
    id: 'evt_adults_only',
    title: 'Adults only',
    interactiveId: ADULTS_ONLY,
  });
  const interactive = getInteractiveReply(payload);

  assert.deepEqual(interactive, {
    interactiveType: 'button_reply',
    interactiveId: ADULTS_ONLY,
    buttonPayload: undefined,
  });

  const handled = await handleZernioChildrenButton(payload);

  assert.equal(handled, true);
  const state = getConversationState(PHONE);
  assert.equal(state?.state, 'CONFIRMING_EVENT');
  assert.equal(state?.children_allowed, 0);
  assert.match(lastMessage().message, /Please confirm your event/);
});

test('actual Zernio Adults & Children callback saves policy and sends next WhatsApp message', async () => {
  setCreateEventReminderSending(true);
  seedChildrenPolicy();

  const payload = zernioButtonReply({
    id: 'evt_children_allowed',
    title: 'Adults & Children',
    interactiveId: CHILDREN_ALLOWED,
    buttonPayload: '',
  });
  const interactive = getInteractiveReply(payload);

  assert.equal(interactive.interactiveId, CHILDREN_ALLOWED);
  assert.equal(interactive.buttonPayload, undefined);

  const handled = await handleZernioChildrenButton(payload);

  assert.equal(handled, true);
  const state = getConversationState(PHONE);
  assert.equal(state?.state, 'CONFIRMING_EVENT');
  assert.equal(state?.children_allowed, 1);
  assert.match(lastMessage().message, /Please confirm your event/);
});

test('ordinary Adults only text still advances children policy', async () => {
  seedChildrenPolicy();

  const handled = await continueCreateEventFlow(ctx, 'Adults only');

  assert.equal(handled, true);
  const state = getConversationState(PHONE);
  assert.equal(state?.state, 'CONFIRMING_EVENT');
  assert.equal(state?.children_allowed, 0);
  assert.match(lastMessage().message, /Please confirm your event/);
});

test('reminder list_reply id advances without using the visible title', async () => {
  setConversationState(PHONE, 'WAITING_FOR_REMINDER_SETTING', {
    name: 'Wedding',
    date: 'Sunday, September 20, 2026 at 7:30 PM',
    location: 'Hall',
    rsvp_deadline: 'Tuesday, September 15, 2026',
    children_allowed: 0,
  });

  const handled = await continueCreateEventFlow(
    {
      ...ctx,
      text: 'No reminder',
      buttonPayload: '',
      interactiveId: REMINDER_NONE,
      interactiveType: 'list_reply',
    },
    'No reminder',
  );

  assert.equal(handled, true);
  const state = getConversationState(PHONE);
  assert.equal(state?.state, 'WAITING_FOR_CHILDREN_POLICY');
  assert.equal(state?.reminder_days, null);
  assert.equal(state?.children_allowed, 0);
  assert.equal(lastMessage().message, CHILDREN_POLICY_PROMPT);
});

test('Family and Individual invite buttons still work after children policy', () => {
  assert.deepEqual(
    inviteTypeButtons(9).map((button) => button.title),
    ['Individual', 'Family'],
  );
  assert.deepEqual(
    inviteTypeButtons(9).map((button) => button.payload),
    ['INVITE_INDIVIDUAL 9', 'INVITE_FAMILY 9'],
  );
});

test('No reminder button stores null and goes to the create confirm only', async () => {
  setConversationState(PHONE, 'WAITING_FOR_REMINDER_SETTING', {
    name: 'Wedding',
    date: 'Sunday, September 20, 2026 at 7:30 PM',
    location: 'Hall',
  });

  await continueCreateEventFlow(ctx, REMINDER_NONE);

  const state = getConversationState(PHONE);
  assert.equal(state?.state, 'WAITING_FOR_CHILDREN_POLICY');
  assert.equal(state?.reminder_days, null);
  assert.equal(lastMessage().message, CHILDREN_POLICY_PROMPT);
});

const REMINDER_CHOICES = [
  { title: '1 day before RSVP closes', payload: REMINDER_1, days: 1 },
  { title: '2 days before RSVP close', payload: REMINDER_2, days: 2 },
  { title: '3 days before RSVP close', payload: REMINDER_3, days: 3 },
  { title: 'No reminder', payload: REMINDER_NONE, days: null },
] as const;

for (const choice of REMINDER_CHOICES) {
  test(`RSVP reminder list_reply ${choice.title} advances once and does not re-show the menu`, async () => {
    setCreateEventReminderSending(true);
    setConversationState(PHONE, 'WAITING_FOR_REMINDER_SETTING', {
      name: 'Wedding',
      date: 'Sunday, September 20, 2026 at 7:30 PM',
      location: 'Hall',
      rsvp_deadline: 'Tuesday, September 15, 2026',
    });
    sent.length = 0;

    const sentRowId = toWhatsAppListRowId(choice.payload);
    const handled = await continueCreateEventFlow(
      {
        ...ctx,
        text: choice.title,
        buttonPayload: REMINDER_LIST_BUTTON,
        interactiveId: sentRowId,
        interactiveType: 'list_reply',
      },
      choice.title,
    );

    assert.equal(handled, true);
    assert.equal(getConversationState(PHONE)?.state, 'WAITING_FOR_CHILDREN_POLICY');
    assert.equal(getConversationState(PHONE)?.reminder_days, choice.days);
    assert.equal(sent.length, 1);
    assert.equal(lastMessage().message, CHILDREN_POLICY_PROMPT);
    assert.notEqual(lastMessage().message, REMINDER_PROMPT);
    assert.equal(lastMessage().list, undefined);
  });

  test(`RSVP reminder in-flight ${choice.payload.replace('_', ':')} id still advances`, async () => {
    setCreateEventReminderSending(true);
    setConversationState(PHONE, 'WAITING_FOR_REMINDER_SETTING', {
      name: 'Wedding',
      date: 'Sunday, September 20, 2026 at 7:30 PM',
      location: 'Hall',
    });
    sent.length = 0;

    const legacyId = choice.payload.replace('_', ':');
    await continueCreateEventFlow(
      {
        ...ctx,
        text: choice.title,
        buttonPayload: '',
        interactiveId: legacyId,
        interactiveType: 'list_reply',
      },
      choice.title,
    );

    assert.equal(getConversationState(PHONE)?.state, 'WAITING_FOR_CHILDREN_POLICY');
    assert.equal(getConversationState(PHONE)?.reminder_days, choice.days);
    assert.equal(sent.length, 1);
    assert.equal(lastMessage().message, CHILDREN_POLICY_PROMPT);
  });
}

test('selected reminder days are preserved through confirmation', async () => {
  setCreateEventReminderSending(true);
  setConversationState(PHONE, 'WAITING_FOR_REMINDER_SETTING', {
    name: 'Wedding',
    date: 'Sunday, September 20, 2026 at 7:30 PM',
    location: 'Hall',
    rsvp_deadline: 'Tuesday, September 15, 2026',
  });

  await continueCreateEventFlow(
    {
      ...ctx,
      interactiveId: REMINDER_2,
      interactiveType: 'list_reply',
      text: '2 days before RSVP close',
    },
    '2 days before RSVP close',
  );
  await continueCreateEventFlow(
    {
      ...ctx,
      interactiveId: CHILDREN_ALLOWED,
      interactiveType: 'button_reply',
    },
    'Adults & Children',
  );

  const confirming = getConversationState(PHONE);
  assert.equal(confirming?.state, 'CONFIRMING_EVENT');
  assert.equal(confirming?.reminder_days, 2);
  assert.match(formatEventConfirmation(confirming!), /Reminder: 2 days before RSVP closes/);

  await continueCreateEventFlow(
    {
      ...ctx,
      interactiveId: CONFIRM_EVENT,
      interactiveType: 'button_reply',
    },
    'Confirm',
  );
  assert.equal(getConversationState(PHONE), undefined);
});

function futureEventDate(weeks: number): string {
  const parsed = parseEventDate(`in ${weeks} weeks at 7:30 PM`);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.ok && parsed.hasTime, true);
  return parsed.ok ? parsed.formatted : '';
}

function seedDeadline(eventDate: string): void {
  setConversationState(PHONE, 'WAITING_FOR_RSVP_DEADLINE', {
    name: 'Wedding',
    date: eventDate,
    location: 'Hall',
  });
}

async function skipThemeAndDress(): Promise<void> {
  await continueCreateEventFlow(
    {
      ...ctx,
      interactiveId: 'skip',
      interactiveType: 'list_reply',
    },
    'Skip',
  );
  await continueCreateEventFlow(
    {
      ...ctx,
      interactiveId: DRESS_SKIP,
      interactiveType: 'button_reply',
    },
    '⏭️ Skip',
  );
  await continueCreateEventFlow(
    {
      ...ctx,
      interactiveId: IMAGE_SKIP,
      interactiveType: 'button_reply',
    },
    '⏭️ Skip',
  );
}

async function addDetailsThenSkipThemeAndDress(): Promise<void> {
  await continueCreateEventFlow(
    {
      ...ctx,
      interactiveId: ADD_DETAILS,
      interactiveType: 'button_reply',
    },
    'Add',
  );
  await skipThemeAndDress();
}

test('location step offers Add Details instead of jumping into optionals', async () => {
  const eventDate = futureEventDate(8);
  setConversationState(PHONE, 'WAITING_FOR_EVENT_LOCATION', {
    name: 'Wedding',
    date: eventDate,
  });

  await continueCreateEventFlow(ctx, 'Hall');

  let state = getConversationState(PHONE);
  assert.equal(state?.state, 'WAITING_FOR_ADD_DETAILS');
  assert.equal(state?.location, 'Hall');
  assert.equal(lastMessage().message, ADD_DETAILS_PROMPT);
  assert.deepEqual(
    lastMessage().buttons?.map((button) => button.payload),
    ADD_DETAILS_BUTTONS.map((button) => button.payload),
  );

  await addDetailsThenSkipThemeAndDress();

  state = getConversationState(PHONE);
  assert.equal(state?.state, 'WAITING_FOR_RSVP_DEADLINE');
  assert.equal(state?.location, 'Hall');

  const reply = lastMessage();
  assert.equal(reply.message, RSVP_DEADLINE_PROMPT);
  assert.equal(reply.buttons, undefined);
  const expected = rsvpDeadlineChoiceList(eventDate);
  assert.deepEqual(reply.list, expected);
  assert.equal(reply.list?.button, RSVP_DEADLINE_LIST_BUTTON);
  const titles = reply.list?.sections[0].rows.map((row) => row.title) ?? [];
  assert.ok(titles.includes('1 week before'));
  assert.ok(titles.includes('2 weeks before'));
  assert.ok(titles.includes('3 weeks before'));
  assert.ok(titles.includes('4 weeks before'));
  assert.ok(titles.includes('Choose a date'));
  assert.ok(titles.includes(SKIP_STEP_TITLE));
  const twoWeeks = reply.list?.sections[0].rows.find(
    (row) => row.id === DEADLINE_2_WEEKS,
  );
  assert.equal(twoWeeks?.description, 'Recommended');
});

test('Skip Add Details goes to Who with empty optionals and no extra Skip screens', async () => {
  const eventDate = futureEventDate(8);
  setConversationState(PHONE, 'WAITING_FOR_EVENT_LOCATION', {
    name: 'Wedding',
    date: eventDate,
  });
  await continueCreateEventFlow(ctx, 'Hall');
  await continueCreateEventFlow(
    {
      ...ctx,
      interactiveId: SKIP_DETAILS,
      interactiveType: 'button_reply',
    },
    'Skip',
  );

  const state = getConversationState(PHONE);
  assert.equal(state?.state, 'WAITING_FOR_CHILDREN_POLICY');
  assert.equal(state?.theme, null);
  assert.equal(state?.dress_code, null);
  assert.equal(state?.rsvp_deadline, null);
  assert.equal(state?.reminder_days, null);
  assert.equal(lastMessage().message, CHILDREN_POLICY_PROMPT);
  assert.ok(!lastMessage().message.includes('Event style'));
  assert.ok(!lastMessage().message.includes('RSVP deadline'));
});

test('2 weeks before default is offered and accepted without extra confirm', async () => {
  const eventDate = futureEventDate(8);
  seedDeadline(eventDate);

  const handled = await continueCreateEventFlow(
    {
      ...ctx,
      text: '2 weeks before',
      buttonPayload: '',
      interactiveId: DEADLINE_2_WEEKS,
      interactiveType: 'list_reply',
    },
    '2 weeks before',
  );

  assert.equal(handled, true);
  const state = getConversationState(PHONE);
  assert.equal(state?.state, 'WAITING_FOR_CHILDREN_POLICY');
  assert.match(state?.rsvp_deadline ?? '', /\d{4}/);
  assert.match(state?.rsvp_deadline ?? '', / at /);
  assert.doesNotMatch(lastMessage().message, /Please confirm your event/);
  assert.equal(lastMessage().message, CHILDREN_POLICY_PROMPT);
  assert.deepEqual(
    lastMessage().buttons?.map((button) => button.payload),
    [CHILDREN_POLICY_BUTTONS[0].payload, CHILDREN_POLICY_BUTTONS[1].payload],
  );
});

test('past week presets are hidden when the event is fewer than 4 weeks away', async () => {
  const parsed = parseEventDate('in 10 days at 7:30 PM');
  assert.equal(parsed.ok, true);
  const eventDate = parsed.ok ? parsed.formatted : '';
  setConversationState(PHONE, 'WAITING_FOR_EVENT_LOCATION', {
    name: 'Wedding',
    date: eventDate,
  });

  await continueCreateEventFlow(ctx, 'Hall');
  await addDetailsThenSkipThemeAndDress();

  const titles = lastMessage().list?.sections[0].rows.map((row) => row.title) ?? [];
  assert.ok(titles.includes('1 week before'));
  assert.equal(titles.includes('2 weeks before'), false);
  assert.equal(titles.includes('3 weeks before'), false);
  assert.equal(titles.includes('4 weeks before'), false);
  assert.ok(titles.includes('Choose a date'));
  assert.ok(titles.includes(SKIP_STEP_TITLE));
});

test('Choose a date stays on the deadline step and sends the calendar', async () => {
  const eventDate = futureEventDate(8);
  seedDeadline(eventDate);

  await continueCreateEventFlow(
    {
      ...ctx,
      interactiveId: DEADLINE_CUSTOM,
      interactiveType: 'list_reply',
    },
    'Choose a date',
  );

  assert.equal(getConversationState(PHONE)?.state, 'WAITING_FOR_RSVP_DEADLINE');
  assert.match(lastMessage().message, /\/d\//);
  assert.match(lastMessage().message, /RSVP deadline must be before the event/);
  assert.equal(lastMessage().list, undefined);
});

test('typed deadline before the event is still accepted as fallback', async () => {
  const eventDate = futureEventDate(8);
  seedDeadline(eventDate);
  const threeWeeks = rsvpDeadlineWeeksBefore(eventDate, 3);
  assert.equal(threeWeeks.ok, true);
  const typed = threeWeeks.ok ? threeWeeks.formatted : '';

  await continueCreateEventFlow(ctx, typed);

  const state = getConversationState(PHONE);
  assert.equal(state?.state, 'WAITING_FOR_CHILDREN_POLICY');
  assert.equal(state?.rsvp_deadline, typed);
  assert.equal(lastMessage().message, CHILDREN_POLICY_PROMPT);
});

test('typed deadline on or after the event is rejected', async () => {
  const eventDate = futureEventDate(8);
  seedDeadline(eventDate);

  await continueCreateEventFlow(ctx, eventDate);

  assert.equal(
    getConversationState(PHONE)?.state,
    'WAITING_FOR_RSVP_DEADLINE',
  );
  assert.match(lastMessage().message, /RSVP deadline must be before the event/);
  assert.ok(lastMessage().list);
  assert.doesNotMatch(lastMessage().message, /Please confirm your event/);
});

test('parseRsvpDeadlineChoice maps list ids and visible titles', () => {
  assert.deepEqual(parseRsvpDeadlineChoice(DEADLINE_2_WEEKS), { weeks: 2 });
  assert.deepEqual(parseRsvpDeadlineChoice('2 weeks before'), { weeks: 2 });
  assert.deepEqual(parseRsvpDeadlineChoice('Choose a date'), { custom: true });
  assert.deepEqual(parseRsvpDeadlineChoice(DEADLINE_SKIP), { skip: true });
  assert.deepEqual(parseRsvpDeadlineChoice('⏭️ Skip'), { skip: true });
  assert.equal(parseRsvpDeadlineChoice('maybe later'), undefined);
});

test('Skip on the RSVP deadline step continues without a deadline', async () => {
  const eventDate = futureEventDate(8);
  seedDeadline(eventDate);

  await continueCreateEventFlow(
    {
      ...ctx,
      interactiveId: DEADLINE_SKIP,
      interactiveType: 'list_reply',
    },
    SKIP_STEP_TITLE,
  );

  const state = getConversationState(PHONE);
  assert.equal(state?.state, 'WAITING_FOR_CHILDREN_POLICY');
  assert.equal(state?.rsvp_deadline, null);
  assert.equal(lastMessage().message, CHILDREN_POLICY_PROMPT);
});

test('Skip is not offered on name, date, time, or location', async () => {
  setConversationState(PHONE, 'WAITING_FOR_EVENT_NAME');
  await continueCreateEventFlow(ctx, '');
  assert.doesNotMatch(lastMessage().message, /Skip/);
  assert.equal(lastMessage().buttons, undefined);

  setConversationState(PHONE, 'WAITING_FOR_EVENT_DATE', { name: 'Wedding' });
  await continueCreateEventFlow(ctx, '');
  assert.doesNotMatch(lastMessage().message, /Skip/);
  assert.doesNotMatch(formatDateQuestion(PHONE, 'Wedding'), /Skip/);

  setConversationState(PHONE, 'WAITING_FOR_EVENT_TIME', {
    name: 'Wedding',
    date: 'Sunday, September 20, 2026',
  });
  await continueCreateEventFlow(ctx, '');
  assert.doesNotMatch(lastMessage().message, /Skip/);
  assert.doesNotMatch(formatTimeQuestion(PHONE), /Skip/);

  setConversationState(PHONE, 'WAITING_FOR_EVENT_LOCATION', {
    name: 'Wedding',
    date: 'Sunday, September 20, 2026 at 7:00 PM',
  });
  await continueCreateEventFlow(ctx, '');
  assert.doesNotMatch(lastMessage().message, /Skip/);

  const reminderTitles = reminderChoiceList().sections[0].rows.map((row) => row.title);
  assert.ok(reminderTitles.includes('No reminder'));
  assert.equal(reminderTitles.includes(SKIP_STEP_TITLE), false);
});
