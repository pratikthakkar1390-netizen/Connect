import {
  clearConversationState,
  createEvent,
  getConversationState,
  getEventById,
  getMessageSession,
  setConversationState,
  updateEventDetails,
  type ConversationState,
} from '../db/store.js';
import { isReminderSendingEnabled } from '../config.js';
import {
  customRsvpDeadlineRange,
  formatEventTimezoneLine,
  getEventInstantMs,
  isDateOnlyFormatted,
  parseEventDate,
  parseEventTime,
  parseRsvpDeadline,
  resolveEventTimezone,
  rsvpDeadlineWeeksBefore,
} from '../dates/eventDate.js';
import { eventTimezonePickerUrl } from '../http/eventTimezoneToken.js';
import {
  parseQuickTimezoneId,
  TIMEZONE_QUICK_SELECT,
  formatTimezoneLabel,
  isValidIanaTimeZone,
} from '../timezones/catalog.js';
import { parseReminderDaysChoice } from '../reminders/targeting.js';
import {
  CUSTOM_THEME_PROMPT,
  DRESS_CODE_BUTTONS,
  DRESS_CODE_PROMPT,
  DRESS_CODE_TEXT_PROMPT,
  eventThemeChoiceList,
  parseDressChoice,
  parseThemeChoice,
  sanitizeCustomTheme,
  sanitizeDressCode,
  THEME_PROMPT,
  themeLabel,
} from '../events/theme.js';
import { locationDraft, type LocationDraft } from '../maps/location.js';
import { VIEW_RSVPS } from './organizer.js';
import { eventWhenPickerUrl } from '../http/eventWhenToken.js';
import { eventImagePickerUrl } from '../http/eventImageToken.js';
import { interactiveCommandInput } from '../whatsapp/eventList.js';
import { sendInboxMessage, type InboxSendResult, type SendMessageParams } from '../zernio/client.js';

export const CONFIRM_EVENT = 'CONFIRM_EVENT';
export const CANCEL_EVENT = 'CANCEL_EVENT';
export const ADD_DETAILS = 'ADD_DETAILS';
export const SKIP_DETAILS = 'SKIP_DETAILS';
export const CHILDREN_ALLOWED = 'CHILDREN_ALLOWED';
export const ADULTS_ONLY = 'ADULTS_ONLY';
export const REMINDER_1 = 'REMINDER_1';
export const REMINDER_2 = 'REMINDER_2';
export const REMINDER_3 = 'REMINDER_3';
export const REMINDER_NONE = 'REMINDER_NONE';

export const TIME_PROMPT = '📅 What time should the event start?';
export const TIMEZONE_PROMPT = `🌎 What timezone is this event in?

Use the local time where the event happens.
If you're traveling, pick the event's city, not where you are now.`;
export const TIMEZONE_LIST_BUTTON = 'Timezone';
export const MERIDIEM_PROMPT =
  '⏰ What time should the event start? Please include AM or PM, for example 7:30 PM.';
export const SPECIFIC_TIME_PROMPT =
  'I need a specific start time, for example 7:30 PM.';
export const REMINDER_PROMPT = `🔔 RSVP Reminder

Reminders are sent before RSVPs close, not before the event.`;
/** List row titles must stay ≤ 24 characters (WhatsApp limit). */
export const REMINDER_BUTTONS = [
  { title: '1 day before RSVP closes', payload: REMINDER_1 },
  { title: '2 days before RSVP close', payload: REMINDER_2 },
  { title: '3 days before RSVP close', payload: REMINDER_3 },
  { title: 'No reminder', payload: REMINDER_NONE },
];
/** WhatsApp allows only 3 reply buttons; 4 reminder choices must be a list. */
export const REMINDER_LIST_BUTTON = 'Choose';

export const DEADLINE_1_WEEK = 'DEADLINE_1_WEEK';
export const DEADLINE_2_WEEKS = 'DEADLINE_2_WEEKS';
export const DEADLINE_3_WEEKS = 'DEADLINE_3_WEEKS';
export const DEADLINE_4_WEEKS = 'DEADLINE_4_WEEKS';
export const DEADLINE_CUSTOM = 'DEADLINE_CUSTOM';
export const DEADLINE_SKIP = 'DEADLINE_SKIP';
export const SKIP_STEP_TITLE = '⏭️ Skip';
export const IMAGE_CHOOSE = 'IMAGE_CHOOSE';
export const IMAGE_SKIP = 'IMAGE_SKIP';

export const EVENT_IMAGE_PROMPT =
  '🖼️ Event Image\n\nAdd a photo or image to make your invitation special.';
export const EVENT_IMAGE_BUTTONS = [
  { title: 'Choose from Phone', payload: IMAGE_CHOOSE },
  { title: SKIP_STEP_TITLE, payload: IMAGE_SKIP },
];

export const RSVP_DEADLINE_PROMPT = '📅 When should RSVPs close?';
export const RSVP_DEADLINE_BEFORE_EVENT =
  'RSVP deadline must be before the event.';
export const RSVP_DEADLINE_IN_PAST =
  'That RSVP deadline is in the past. Please choose a future date and time.';
export const RSVP_DEADLINE_TOO_SOON =
  'This event is too soon to set an RSVP deadline after now and before the event starts.';
export const RSVP_DEADLINE_LIST_BUTTON = 'Choose';

export const RSVP_DEADLINE_PRESETS = [
  { weeks: 1 as const, id: DEADLINE_1_WEEK, title: '1 week before' },
  {
    weeks: 2 as const,
    id: DEADLINE_2_WEEKS,
    title: '2 weeks before',
    description: 'Recommended',
  },
  { weeks: 3 as const, id: DEADLINE_3_WEEKS, title: '3 weeks before' },
  { weeks: 4 as const, id: DEADLINE_4_WEEKS, title: '4 weeks before' },
];

export function reminderChoiceList(): NonNullable<SendMessageParams['list']> {
  return {
    button: REMINDER_LIST_BUTTON,
    sections: [
      {
        title: 'RSVP Reminder',
        rows: REMINDER_BUTTONS.map((button) => ({
          id: button.payload,
          title: button.title,
        })),
      },
    ],
  };
}

export function timezoneChoiceList(): NonNullable<SendMessageParams['list']> {
  return {
    button: TIMEZONE_LIST_BUTTON,
    sections: [
      {
        title: 'Timezone',
        rows: TIMEZONE_QUICK_SELECT.map((row) => ({
          id: row.id,
          title: row.title,
        })),
      },
    ],
  };
}

function flowTimezone(state?: { timezone?: string | null } | null): string {
  return resolveEventTimezone(state?.timezone);
}

/** New-event persist gate: only a valid conversation IANA timezone qualifies. */
export function explicitConversationTimezone(
  timezone?: string | null,
): string | null {
  const trimmed = timezone?.trim() ?? '';
  if (!trimmed || !isValidIanaTimeZone(trimmed)) {
    return null;
  }
  return trimmed;
}

export function rsvpDeadlineChoiceList(
  eventDate?: string | null,
  timezone?: string | null,
): NonNullable<SendMessageParams['list']> {
  const rows: Array<{ id: string; title: string; description?: string }> = [];
  const date = eventDate?.trim() ?? '';
  if (date) {
    for (const preset of RSVP_DEADLINE_PRESETS) {
      const computed = rsvpDeadlineWeeksBefore(date, preset.weeks, {
        timezone: flowTimezone({ timezone }),
      });
      if (!computed.ok) {
        continue;
      }
      rows.push({
        id: preset.id,
        title: preset.title,
        ...(preset.description ? { description: preset.description } : {}),
      });
    }
    if (customRsvpDeadlineRange(date, { timezone: flowTimezone({ timezone }) })) {
      rows.push({ id: DEADLINE_CUSTOM, title: 'Choose a date' });
    }
  }
  rows.push({
    id: DEADLINE_SKIP,
    title: SKIP_STEP_TITLE,
    description: 'No RSVP deadline',
  });
  return {
    button: RSVP_DEADLINE_LIST_BUTTON,
    sections: [{ title: 'RSVP deadline', rows }],
  };
}

export function parseRsvpDeadlineChoice(
  input: string,
): { weeks: 1 | 2 | 3 | 4 } | { custom: true } | { skip: true } | undefined {
  const normalized = input
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (
    normalized === 'DEADLINE 1 WEEK' ||
    normalized === '1 WEEK BEFORE'
  ) {
    return { weeks: 1 };
  }
  if (
    normalized === 'DEADLINE 2 WEEKS' ||
    normalized === '2 WEEKS BEFORE'
  ) {
    return { weeks: 2 };
  }
  if (
    normalized === 'DEADLINE 3 WEEKS' ||
    normalized === '3 WEEKS BEFORE'
  ) {
    return { weeks: 3 };
  }
  if (
    normalized === 'DEADLINE 4 WEEKS' ||
    normalized === '4 WEEKS BEFORE'
  ) {
    return { weeks: 4 };
  }
  if (
    normalized === 'DEADLINE CUSTOM' ||
    normalized === 'CHOOSE A DATE'
  ) {
    return { custom: true };
  }
  if (
    normalized === 'DEADLINE SKIP' ||
    normalized === 'SKIP' ||
    normalized === 'NONE'
  ) {
    return { skip: true };
  }
  return undefined;
}

export function formatDeadlineQuestion(phone: string): string {
  return `${RSVP_DEADLINE_PROMPT}\n\n📅 Pick a date: ${eventWhenPickerUrl(phone, 'deadline')}\n\n${RSVP_DEADLINE_BEFORE_EVENT}`;
}

export function formatDeadlineTimeQuestion(
  phone: string,
  base = '⏰ What time should RSVPs close?',
): string {
  return `${base}\n\n⏰ Pick a time: ${eventWhenPickerUrl(phone, 'time')}`;
}

export interface CreateEventContext {
  phone: string;
  conversationId: string;
  accountId: string;
  text?: string;
  interactiveId?: string;
  buttonPayload?: string;
  interactiveType?: string;
}

export const CHILDREN_POLICY_PROMPT = 'Who can attend?';
export const CHILDREN_POLICY_BUTTONS = [
  { title: 'Adults only', payload: ADULTS_ONLY },
  { title: 'Adults & Children', payload: CHILDREN_ALLOWED },
];

export const ADD_DETAILS_PROMPT =
  'Add more details? Event style, what to wear, a photo, RSVP deadline, and reminder are optional.';
export const ADD_DETAILS_BUTTONS = [
  { title: 'Skip', payload: SKIP_DETAILS },
  { title: 'Add', payload: ADD_DETAILS },
];

const NAME_PROMPT =
  "🎉 Let’s create your event!\n\nWhat would you like to call it?";

const DATE_PROMPT =
  'Or reply with the date (for example: Next Friday, September 20, or Sept 20 at 7:30 PM).';

const LOCATION_PROMPT_SUFFIX = 'Reply with the location.';

export function formatDateQuestion(
  phone: string,
  eventName?: string | null,
  intro?: string,
  timezone?: string | null,
): string {
  const heading =
    intro ?? `When is *${eventName?.trim() || 'your event'}*?`;
  const zone = timezone
    ? `\n\nTimes are in ${formatTimezoneLabel(resolveEventTimezone(timezone))}. Example: 7:00 PM ${formatTimezoneLabel(resolveEventTimezone(timezone))}.`
    : '';
  return `${heading}${zone}\n\n📅 Pick a date: ${eventWhenPickerUrl(phone, 'date')}\n\n${DATE_PROMPT}`;
}

export function formatTimeQuestion(phone: string, base = TIME_PROMPT): string {
  return `${base}\n\n⏰ Pick a time: ${eventWhenPickerUrl(phone, 'time')}`;
}

export function formatLocationQuestion(name: string | null | undefined): string {
  return locationPrompt(name);
}

type SendFn = (params: SendMessageParams) => Promise<void | InboxSendResult>;
let sendMessage: SendFn = sendInboxMessage;
let reminderSendingOverride: boolean | undefined;

/** Test-only seam so conversation UX can be asserted without WhatsApp. */
export function setCreateEventMessageSender(send?: SendFn): void {
  sendMessage = send ?? sendInboxMessage;
}

/** Test-only seam to exercise the production reminder-question path. */
export function setCreateEventReminderSending(enabled?: boolean): void {
  reminderSendingOverride = enabled;
}

function reminderSendingEnabled(): boolean {
  return reminderSendingOverride ?? isReminderSendingEnabled();
}

function locationPrompt(name: string | null | undefined): string {
  return `Where will *${name ?? 'your event'}* be held?\n\n${LOCATION_PROMPT_SUFFIX}`;
}

export async function startCreateEventFlow(
  ctx: CreateEventContext,
): Promise<void> {
  clearConversationState(ctx.phone);
  setConversationState(ctx.phone, 'WAITING_FOR_EVENT_NAME', { event_id: null });
  await reply(ctx, NAME_PROMPT);
}

function firstNonEmpty(...values: Array<string | undefined | null>): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

function isButtonCallback(ctx: CreateEventContext): boolean {
  return (
    ctx.interactiveType === 'button_reply' ||
    ctx.interactiveType === 'list_reply' ||
    Boolean(ctx.interactiveId?.trim()) ||
    Boolean(ctx.buttonPayload?.trim())
  );
}

export function parseChildrenPolicyChoice(input: string): 0 | 1 | undefined {
  const normalized = input
    .trim()
    .toUpperCase()
    .replace(/&AMP;/g, '&')
    .replace(/&/g, ' AND ')
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (normalized === 'ADULTS ONLY') {
    return 0;
  }

  if (
    normalized === 'CHILDREN ALLOWED' ||
    normalized === 'ADULTS AND CHILDREN'
  ) {
    return 1;
  }

  return undefined;
}

export async function continueCreateEventFlow(
  ctx: CreateEventContext,
  input: string,
): Promise<boolean> {
  const state = getConversationState(ctx.phone);
  if (!state) {
    return false;
  }
  if (state.state.startsWith('VENDOR_')) {
    return false;
  }

  const trimmed = firstNonEmpty(
    interactiveCommandInput(ctx),
    input,
    ctx.text,
  );
  const { isGreeting } = await import('./welcome.js');
  if (!isButtonCallback(ctx) && isGreeting(trimmed)) {
    return false;
  }

  const upper = trimmed.toUpperCase();

  switch (state.state) {
    case 'WAITING_FOR_EVENT_NAME':
      return handleEventName(ctx, trimmed);
    case 'WAITING_FOR_EVENT_TIMEZONE':
      return handleEventTimezone(ctx, state, trimmed);
    case 'WAITING_FOR_EVENT_DATE':
      return handleEventDate(ctx, state, trimmed);
    case 'WAITING_FOR_EVENT_TIME':
      return handleEventTime(ctx, state, trimmed);
    case 'WAITING_FOR_EVENT_LOCATION':
      return handleEventLocation(ctx, state, trimmed);
    case 'WAITING_FOR_ADD_DETAILS':
      return handleAddDetails(ctx, trimmed);
    case 'WAITING_FOR_EVENT_THEME':
      return handleEventTheme(ctx, trimmed);
    case 'WAITING_FOR_CUSTOM_THEME':
      return handleCustomTheme(ctx, trimmed);
    case 'WAITING_FOR_DRESS_CODE':
      return handleDressCode(ctx, trimmed);
    case 'WAITING_FOR_DRESS_CODE_TEXT':
      return handleDressCodeText(ctx, trimmed);
    case 'WAITING_FOR_EVENT_IMAGE':
      return handleEventImage(ctx, trimmed);
    case 'WAITING_FOR_INVITATION_COUNT':
      return handleLegacyInvitationCount(ctx, state, trimmed);
    case 'WAITING_FOR_RSVP_DEADLINE':
      return handleRsvpDeadline(ctx, state, trimmed);
    case 'WAITING_FOR_CHILDREN_POLICY':
      return handleChildrenPolicy(ctx, state, upper);
    case 'WAITING_FOR_REMINDER_SETTING':
      return handleReminderSetting(ctx, state, trimmed);
    case 'CONFIRMING_EVENT':
      return handleConfirmation(ctx, state, upper);
    default:
      return false;
  }
}

async function handleEventName(
  ctx: CreateEventContext,
  name: string,
): Promise<boolean> {
  if (!name) {
    await reply(ctx, NAME_PROMPT);
    return true;
  }

  setConversationState(ctx.phone, 'WAITING_FOR_EVENT_TIMEZONE', {
    name,
    event_id: null,
    timezone: null,
  });
  await sendTimezoneQuestion(ctx);
  return true;
}

async function sendTimezoneQuestion(ctx: CreateEventContext): Promise<void> {
  await sendMessage({
    conversationId: ctx.conversationId,
    accountId: ctx.accountId,
    message: TIMEZONE_PROMPT,
    list: timezoneChoiceList(),
  });
}

export async function applyPickedEventTimezone(
  phone: string,
  iana: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!isValidIanaTimeZone(iana)) {
    return { ok: false, error: 'Please choose a city from the list.' };
  }
  const existing = getConversationState(phone);
  const editing =
    existing?.state === 'WAITING_FOR_EDIT_TIMEZONE' ||
    (existing?.event_id != null && existing.state.startsWith('WAITING_FOR_EDIT'));
  if (editing && existing?.event_id != null) {
    const event = getEventById(existing.event_id);
    if (event) {
      updateEventDetails(event.id, {
        name: event.name,
        date: event.date,
        location: event.location,
        timezone: iana,
      });
    }
  }
  const nextState = editing ? 'WAITING_FOR_EDIT_FIELD' : 'WAITING_FOR_EVENT_DATE';
  const saved = setConversationState(phone, nextState, { timezone: iana });
  const session = getMessageSession(phone);
  if (session?.conversation_id) {
    const label = formatTimezoneLabel(iana);
    const message = editing
      ? `Timezone set to ${label}. 7:00 PM stays 7:00 PM in ${label}.`
      : formatDateQuestion(
          phone,
          saved.name,
          `Timezone set to ${label}. When is *${saved.name ?? 'your event'}*?`,
          iana,
        );
    await sendMessage({
      conversationId: session.conversation_id,
      accountId: session.account_id,
      message,
    });
  }
  return { ok: true };
}

async function handleEventTimezone(
  ctx: CreateEventContext,
  _state: ConversationState,
  input: string,
): Promise<boolean> {
  const compact = interactiveCommandInput(ctx).trim();
  const candidate = compact || input.trim();
  if (candidate.toUpperCase() === 'TZ_MORE' || candidate.toUpperCase() === 'MORE CITIES') {
    await reply(
      ctx,
      `Search any city worldwide:\n${eventTimezonePickerUrl(ctx.phone)}`,
    );
    return true;
  }
  const iana = parseQuickTimezoneId(compact) ?? parseQuickTimezoneId(input);
  if (!iana) {
    await sendTimezoneQuestion(ctx);
    return true;
  }
  const applied = await applyPickedEventTimezone(ctx.phone, iana);
  if (!applied.ok) {
    await sendTimezoneQuestion(ctx);
  }
  return true;
}

async function handleEventDate(
  ctx: CreateEventContext,
  state: ConversationState,
  date: string,
): Promise<boolean> {
  if (!date) {
    await reply(ctx, formatDateQuestion(ctx.phone, state.name, undefined, state.timezone));
    return true;
  }

  const parsed = parseEventDate(date, { timezone: flowTimezone(state) });
  if (!parsed.ok) {
    await reply(ctx, dateParseFailureMessage(ctx.phone, parsed.reason, state.timezone));
    return true;
  }

  if (!parsed.hasTime) {
    setConversationState(ctx.phone, 'WAITING_FOR_EVENT_TIME', {
      date: parsed.formatted,
    });
    await reply(
      ctx,
      formatTimeQuestion(
        ctx.phone,
        parsed.timeIssue === 'missingMeridiem'
          ? MERIDIEM_PROMPT
          : parsed.timeIssue === 'vague'
            ? `${SPECIFIC_TIME_PROMPT}\n\n${TIME_PROMPT}`
            : TIME_PROMPT,
      ),
    );
    return true;
  }

  setConversationState(ctx.phone, 'WAITING_FOR_EVENT_LOCATION', {
    date: parsed.formatted,
  });
  await reply(ctx, locationPrompt(state.name));
  return true;
}

async function handleEventTime(
  ctx: CreateEventContext,
  state: ConversationState,
  timeInput: string,
): Promise<boolean> {
  const dateOnly = state.date?.trim() ?? '';

  if (!timeInput) {
    await reply(ctx, formatTimeQuestion(ctx.phone));
    return true;
  }

  const parsed = parseEventTime(timeInput, dateOnly, { timezone: flowTimezone(state) });
  if (!parsed.ok) {
    await reply(ctx, formatTimeQuestion(ctx.phone, timeParseFailureMessage(parsed.reason)));
    return true;
  }

  setConversationState(ctx.phone, 'WAITING_FOR_EVENT_LOCATION', {
    date: parsed.formatted,
  });
  await reply(ctx, locationPrompt(state.name));
  return true;
}

async function handleEventLocation(
  ctx: CreateEventContext,
  state: ConversationState,
  location: string,
): Promise<boolean> {
  if (!location) {
    await reply(ctx, locationPrompt(state.name));
    return true;
  }

  return continueAfterLocation(ctx, locationDraft(location));
}

async function continueAfterLocation(
  ctx: CreateEventContext,
  draft: LocationDraft,
): Promise<boolean> {
  setConversationState(ctx.phone, 'WAITING_FOR_ADD_DETAILS', draft);
  await sendAddDetailsQuestion(ctx);
  return true;
}

export function parseAddDetailsChoice(input: string): 'add' | 'skip' | undefined {
  const normalized = input
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (normalized === 'ADD' || normalized === 'ADD DETAILS') {
    return 'add';
  }
  if (
    normalized === 'SKIP' ||
    normalized === 'SKIP DETAILS' ||
    normalized === 'NONE'
  ) {
    return 'skip';
  }
  return undefined;
}

async function handleAddDetails(
  ctx: CreateEventContext,
  input: string,
): Promise<boolean> {
  const choice = parseAddDetailsChoice(input);
  if (choice === 'skip') {
    return skipOptionalDetails(ctx);
  }
  if (choice === 'add') {
    setConversationState(ctx.phone, 'WAITING_FOR_EVENT_THEME');
    await sendThemeQuestion(ctx);
    return true;
  }
  await sendAddDetailsQuestion(ctx);
  return true;
}

async function skipOptionalDetails(ctx: CreateEventContext): Promise<boolean> {
  setConversationState(ctx.phone, 'WAITING_FOR_CHILDREN_POLICY', {
    theme: null,
    custom_theme: null,
    dress_code: null,
    image_filename: null,
    rsvp_deadline: null,
    reminder_days: null,
    children_allowed: 1,
  });
  await sendWhoQuestion(ctx);
  return true;
}

async function handleEventTheme(
  ctx: CreateEventContext,
  input: string,
): Promise<boolean> {
  const choice = parseThemeChoice(input);
  if (!choice) {
    await sendThemeQuestion(ctx);
    return true;
  }
  if ('skip' in choice) {
    setConversationState(ctx.phone, 'WAITING_FOR_DRESS_CODE', {
      theme: null,
      custom_theme: null,
    });
    await sendDressQuestion(ctx);
    return true;
  }
  if (choice.theme === 'custom') {
    setConversationState(ctx.phone, 'WAITING_FOR_CUSTOM_THEME', {
      theme: 'custom',
      custom_theme: null,
    });
    await reply(ctx, CUSTOM_THEME_PROMPT);
    return true;
  }
  setConversationState(ctx.phone, 'WAITING_FOR_DRESS_CODE', {
    theme: choice.theme,
    custom_theme: null,
  });
  await sendDressQuestion(ctx);
  return true;
}

async function handleCustomTheme(
  ctx: CreateEventContext,
  input: string,
): Promise<boolean> {
  const custom = sanitizeCustomTheme(input);
  if (!custom) {
    await reply(ctx, CUSTOM_THEME_PROMPT);
    return true;
  }
  setConversationState(ctx.phone, 'WAITING_FOR_DRESS_CODE', {
    theme: 'custom',
    custom_theme: custom,
  });
  await sendDressQuestion(ctx);
  return true;
}

async function handleDressCode(
  ctx: CreateEventContext,
  input: string,
): Promise<boolean> {
  const choice = parseDressChoice(input);
  if (choice && 'skip' in choice) {
    return continueAfterDress(ctx, null);
  }
  if (choice && 'enter' in choice) {
    setConversationState(ctx.phone, 'WAITING_FOR_DRESS_CODE_TEXT');
    await reply(ctx, DRESS_CODE_TEXT_PROMPT);
    return true;
  }
  if (!input) {
    await sendDressQuestion(ctx);
    return true;
  }
  return continueAfterDress(ctx, sanitizeDressCode(input));
}

async function handleDressCodeText(
  ctx: CreateEventContext,
  input: string,
): Promise<boolean> {
  const skipped = parseDressChoice(input);
  if (skipped && 'skip' in skipped) {
    return continueAfterDress(ctx, null);
  }
  const dress = sanitizeDressCode(input);
  if (!dress) {
    await reply(ctx, DRESS_CODE_TEXT_PROMPT);
    return true;
  }
  return continueAfterDress(ctx, dress);
}

async function continueAfterDress(
  ctx: CreateEventContext,
  dressCode: string | null,
): Promise<boolean> {
  setConversationState(ctx.phone, 'WAITING_FOR_EVENT_IMAGE', {
    dress_code: dressCode,
  });
  await sendEventImageQuestion(ctx);
  return true;
}

export function parseEventImageChoice(
  input: string,
): { choose: true } | { skip: true } | undefined {
  const normalized = input
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (
    normalized === 'IMAGE CHOOSE' ||
    normalized === 'CHOOSE FROM PHONE' ||
    normalized === 'CHOOSE'
  ) {
    return { choose: true };
  }
  if (
    normalized === 'IMAGE SKIP' ||
    normalized === 'SKIP' ||
    normalized === 'NONE'
  ) {
    return { skip: true };
  }
  return undefined;
}

async function handleEventImage(
  ctx: CreateEventContext,
  input: string,
): Promise<boolean> {
  const choice = parseEventImageChoice(input);
  if (choice && 'choose' in choice) {
    await reply(
      ctx,
      `Open this link on your phone to choose a photo:\n${eventImagePickerUrl(ctx.phone)}`,
    );
    return true;
  }
  if (choice && 'skip' in choice) {
    return continueAfterEventImage(ctx, null);
  }
  await sendEventImageQuestion(ctx);
  return true;
}

export async function continueAfterEventImage(
  ctx: CreateEventContext,
  imageFilename: string | null,
): Promise<boolean> {
  const next = applyAcceptedEventImage(ctx.phone, imageFilename);
  await sendMessage({
    conversationId: ctx.conversationId,
    accountId: ctx.accountId,
    message: next.message,
    list: next.list,
  });
  return true;
}

export function applyAcceptedEventImage(
  phone: string,
  imageFilename: string | null,
): {
  message: string;
  list: SendMessageParams['list'];
} {
  const state = setConversationState(phone, 'WAITING_FOR_RSVP_DEADLINE', {
    image_filename: imageFilename,
  });
  return deadlineQuestion(state.date, undefined, state.timezone);
}

export function deadlineQuestion(
  eventDate?: string | null,
  extra?: string,
  timezone?: string | null,
): {
  message: string;
  list: SendMessageParams['list'];
} {
  const list = rsvpDeadlineChoiceList(eventDate, timezone);
  const tooSoon =
    !customRsvpDeadlineRange(eventDate ?? '', {
      timezone: flowTimezone({ timezone }),
    }) && extra == null;
  const message = extra
    ? `${RSVP_DEADLINE_PROMPT}\n\n${extra}`
    : tooSoon
      ? `${RSVP_DEADLINE_PROMPT}\n\n${RSVP_DEADLINE_TOO_SOON}`
      : RSVP_DEADLINE_PROMPT;
  return { message, list };
}

/** Legacy wizard step removed — treat stored input as RSVP deadline. */
async function handleLegacyInvitationCount(
  ctx: CreateEventContext,
  state: ConversationState,
  input: string,
): Promise<boolean> {
  setConversationState(ctx.phone, 'WAITING_FOR_RSVP_DEADLINE');
  return handleRsvpDeadline(ctx, state, input);
}

async function handleRsvpDeadline(
  ctx: CreateEventContext,
  state: ConversationState,
  input: string,
): Promise<boolean> {
  const upper = input.toUpperCase();
  const choice = parseRsvpDeadlineChoice(input);

  if (choice && 'custom' in choice) {
    await reply(ctx, formatDeadlineQuestion(ctx.phone));
    return true;
  }

  if (choice && 'skip' in choice) {
    return acceptDeadlineAndContinue(ctx, null);
  }

  if (choice && 'weeks' in choice) {
    const computed = rsvpDeadlineWeeksBefore(state.date ?? '', choice.weeks, {
      timezone: flowTimezone(state),
    });
    if (!computed.ok) {
      await sendDeadlineQuestion(
        ctx,
        state.date,
        RSVP_DEADLINE_BEFORE_EVENT,
      );
      return true;
    }
    return acceptDeadlineAndContinue(ctx, computed.formatted);
  }

  if (upper === 'NONE' || upper === 'SKIP') {
    return acceptDeadlineAndContinue(ctx, null);
  }

  if (!input) {
    if (isDateOnlyFormatted(state.rsvp_deadline)) {
      await reply(ctx, formatDeadlineTimeQuestion(ctx.phone));
      return true;
    }
    await sendDeadlineQuestion(ctx, state.date);
    return true;
  }

  if (isDateOnlyFormatted(state.rsvp_deadline)) {
    const parsedTime = parseEventTime(input, state.rsvp_deadline ?? '', {
      timezone: flowTimezone(state),
    });
    if (parsedTime.ok) {
      const eventMs = state.date
        ? getEventInstantMs(state.date, { timezone: flowTimezone(state) })
        : null;
      const deadline = parseRsvpDeadline(parsedTime.formatted, {
        eventDate: state.date,
        timezone: flowTimezone(state),
      });
      if (
        deadline.ok &&
        (eventMs === null || deadline.instantMs < eventMs) &&
        deadline.instantMs > Date.now()
      ) {
        return acceptDeadlineAndContinue(ctx, deadline.formatted);
      }
      await reply(
        ctx,
        formatDeadlineTimeQuestion(
          ctx.phone,
          deadline.ok && deadline.instantMs <= Date.now()
            ? RSVP_DEADLINE_IN_PAST
            : RSVP_DEADLINE_BEFORE_EVENT,
        ),
      );
      return true;
    }
    if (!parsedTime.ok && parsedTime.reason !== 'unparseable') {
      await reply(
        ctx,
        formatDeadlineTimeQuestion(ctx.phone, timeParseFailureMessage(parsedTime.reason)),
      );
      return true;
    }
  }

  const parsed = parseRsvpDeadline(input, {
    eventDate: state.date,
    timezone: flowTimezone(state),
  });
  if (!parsed.ok) {
    await sendDeadlineQuestion(
      ctx,
      state.date,
      parsed.reason === 'ambiguous'
        ? 'That deadline could mean more than one thing. Please choose from the list or reply with a clearer date.'
        : "I couldn't understand that deadline. Please choose from the list or reply with a date.",
    );
    return true;
  }

  const eventMs = state.date
    ? getEventInstantMs(state.date, { timezone: flowTimezone(state) })
    : null;
  if (eventMs !== null && parsed.instantMs >= eventMs) {
    await sendDeadlineQuestion(ctx, state.date, RSVP_DEADLINE_BEFORE_EVENT);
    return true;
  }
  if (parsed.instantMs <= Date.now()) {
    await sendDeadlineQuestion(ctx, state.date, RSVP_DEADLINE_BEFORE_EVENT);
    return true;
  }

  return acceptDeadlineAndContinue(ctx, parsed.formatted);
}

async function acceptDeadlineAndContinue(
  ctx: CreateEventContext,
  deadline: string | null,
): Promise<boolean> {
  return continueAfterOptionalDeadline(ctx, deadline);
}

export function applyAcceptedDeadline(
  phone: string,
  deadline: string | null,
): {
  message: string;
  buttons?: Array<{ title: string; payload: string }>;
  list?: SendMessageParams['list'];
} {
  const nextDraft = {
    rsvp_deadline: deadline,
    children_allowed: 1,
  };
  if (reminderSendingEnabled()) {
    setConversationState(phone, 'WAITING_FOR_REMINDER_SETTING', nextDraft);
    return { message: REMINDER_PROMPT, list: reminderChoiceList() };
  }
  setConversationState(phone, 'WAITING_FOR_CHILDREN_POLICY', nextDraft);
  return {
    message: CHILDREN_POLICY_PROMPT,
    buttons: [...CHILDREN_POLICY_BUTTONS],
  };
}

export async function continueAfterOptionalDeadline(
  ctx: CreateEventContext,
  deadline: string | null,
): Promise<boolean> {
  const next = applyAcceptedDeadline(ctx.phone, deadline);
  await sendMessage({
    conversationId: ctx.conversationId,
    accountId: ctx.accountId,
    message: next.message,
    buttons: next.buttons,
    list: next.list,
  });
  return true;
}

async function handleChildrenPolicy(
  ctx: CreateEventContext,
  _state: ConversationState,
  upper: string,
): Promise<boolean> {
  const choice = parseChildrenPolicyChoice(upper);
  if (choice === undefined) {
    await reply(ctx, 'Please tap a button:', [...CHILDREN_POLICY_BUTTONS]);
    return true;
  }

  const childrenAllowed = choice;
  const next = setConversationState(ctx.phone, 'CONFIRMING_EVENT', {
    children_allowed: childrenAllowed,
  });
  await sendConfirmation(ctx, next);
  return true;
}

async function handleReminderSetting(
  ctx: CreateEventContext,
  state: ConversationState,
  input: string,
): Promise<boolean> {
  const choice = parseReminderDaysChoice(input);
  if (choice === undefined) {
    await sendReminderQuestion(ctx);
    return true;
  }

  setConversationState(ctx.phone, 'WAITING_FOR_CHILDREN_POLICY', {
    reminder_days: choice,
  });
  await sendWhoQuestion(ctx);
  return true;
}

async function handleConfirmation(
  ctx: CreateEventContext,
  state: ConversationState,
  upper: string,
): Promise<boolean> {
  if (upper === CONFIRM_EVENT || upper === 'CONFIRM') {
    return finishConfirm(ctx, state);
  }

  if (upper === CANCEL_EVENT || upper === 'CANCEL') {
    return finishCancel(ctx);
  }

  await sendConfirmation(ctx, state);
  return true;
}

async function finishConfirm(
  ctx: CreateEventContext,
  state: ConversationState,
): Promise<boolean> {
  const name = state.name?.trim() ?? '';
  const date = state.date?.trim() ?? '';
  const location = state.location?.trim() ?? '';
  const timezone = explicitConversationTimezone(state.timezone);

  if (!name || !date || !location || !timezone) {
    clearConversationState(ctx.phone);
    setConversationState(ctx.phone, 'WAITING_FOR_EVENT_NAME');
    await reply(
      ctx,
      "Something was missing from that draft. Let's start over — what would you like to call your event?",
    );
    return true;
  }

  // Always INSERT a new row. Same name/date/location/organizer must never
  // reuse an existing event, even if conversation_state still has event_id.
  const event = createEvent(name, date, location, ctx.phone, {
    rsvpDeadline: state.rsvp_deadline,
    childrenAllowed: (state.children_allowed ?? 1) === 1,
    reminderDays: state.reminder_days ?? null,
    theme: state.theme,
    customTheme: state.custom_theme,
    dressCode: state.dress_code,
    imageFilename: state.image_filename,
    locationPlaceId: state.location_place_id,
    locationMapsUrl: state.location_maps_url,
    locationAddress: state.location_address,
    timezone,
  });
  clearConversationState(ctx.phone);

  await reply(
    ctx,
    `✅ Event *${event.name}* created!\n\n📅 ${event.date}\n${formatEventTimezoneLine(event.timezone)}\n📍 ${event.location}`,
    [
      { title: 'Invite', payload: `START_INVITE ${event.id}` },
      { title: 'View RSVPs', payload: `${VIEW_RSVPS} ${event.id}` },
      { title: 'My Events', payload: 'MY_EVENTS' },
    ],
  );
  return true;
}

async function finishCancel(ctx: CreateEventContext): Promise<boolean> {
  clearConversationState(ctx.phone);
  await reply(
    ctx,
    'No problem — event creation cancelled. Tap Create Event whenever you want to try again.',
    [
      { title: '➕ Create Event', payload: 'CREATE_EVENT' },
      { title: '📅 My Events', payload: 'MY_EVENTS' },
      { title: '❓ Help', payload: 'HELP' },
    ],
  );
  return true;
}

function formatChildrenPolicy(allowed: number | null | undefined): string {
  return (allowed ?? 1) === 1 ? 'Adults & Children' : 'Adults only';
}

export function formatReminderDays(days: number | null | undefined): string {
  if (days === null || days === undefined) {
    return 'No reminder';
  }
  return days === 1
    ? '1 day before RSVP closes'
    : `${days} days before RSVP closes`;
}

function dateParseFailureMessage(
  phone: string,
  reason: 'unparseable' | 'ambiguous' | 'missingMeridiem' | 'vagueTime',
  timezone?: string | null,
): string {
  if (reason === 'ambiguous') {
    return formatDateQuestion(
      phone,
      undefined,
      'That date could mean more than one thing. Please reply with a clearer date.',
      timezone,
    );
  }
  if (reason === 'missingMeridiem') {
    return formatTimeQuestion(phone, MERIDIEM_PROMPT);
  }
  if (reason === 'vagueTime') {
    return formatDateQuestion(
      phone,
      undefined,
      SPECIFIC_TIME_PROMPT,
      timezone,
    );
  }
  return formatDateQuestion(
    phone,
    undefined,
    "I couldn't understand that date. Please try again.",
    timezone,
  );
}

export function timeParseFailureMessage(
  reason: 'unparseable' | 'ambiguous' | 'missingMeridiem' | 'vagueTime',
): string {
  if (reason === 'missingMeridiem') {
    return MERIDIEM_PROMPT;
  }
  if (reason === 'vagueTime' || reason === 'ambiguous') {
    return `${SPECIFIC_TIME_PROMPT}\n\n${TIME_PROMPT}`;
  }
  return `${SPECIFIC_TIME_PROMPT}\n\n${TIME_PROMPT}`;
}

async function sendReminderQuestion(ctx: CreateEventContext): Promise<void> {
  await sendMessage({
    conversationId: ctx.conversationId,
    accountId: ctx.accountId,
    message: REMINDER_PROMPT,
    list: reminderChoiceList(),
  });
}

async function sendDeadlineQuestion(
  ctx: CreateEventContext,
  eventDate?: string | null,
  extra?: string,
): Promise<void> {
  const timezone = getConversationState(ctx.phone)?.timezone;
  const next = deadlineQuestion(eventDate, extra, timezone);
  await sendMessage({
    conversationId: ctx.conversationId,
    accountId: ctx.accountId,
    message: next.message,
    list: next.list,
  });
}

async function sendEventImageQuestion(ctx: CreateEventContext): Promise<void> {
  await reply(ctx, EVENT_IMAGE_PROMPT, [...EVENT_IMAGE_BUTTONS]);
}

export function formatEventConfirmation(state: ConversationState): string {
  const deadline = state.rsvp_deadline?.trim()
    ? state.rsvp_deadline
    : 'None (open RSVP)';

  const reminderLine = reminderSendingEnabled()
    ? `\nReminder: ${formatReminderDays(state.reminder_days)}`
    : '';
  const themeLine = formatThemeLine(state);
  const dressLine = state.dress_code?.trim()
    ? `\nWhat to Wear: ${state.dress_code.trim()}`
    : '';
  const imageLine = state.image_filename?.trim() ? '\nEvent Image: Added' : '';
  const addressLine = state.location_address?.trim()
    ? `\n${state.location_address.trim()}`
    : '';

  return `🎉 Please confirm your event:\n\nEvent: ${state.name}\nDate: ${state.date}\n${formatEventTimezoneLine(state.timezone)}\nLocation: ${state.location}${addressLine}${themeLine}${dressLine}${imageLine}\nRSVP deadline: ${deadline}\nChildren: ${formatChildrenPolicy(state.children_allowed)}${reminderLine}`;
}

function formatThemeLine(state: ConversationState): string {
  if (state.theme === 'custom' && state.custom_theme?.trim()) {
    return `\nEvent Style: ${state.custom_theme.trim()}`;
  }
  const label = themeLabel(state.theme);
  return label ? `\nEvent Style: ${label}` : '';
}

async function sendAddDetailsQuestion(ctx: CreateEventContext): Promise<void> {
  await reply(ctx, ADD_DETAILS_PROMPT, [...ADD_DETAILS_BUTTONS]);
}

async function sendWhoQuestion(ctx: CreateEventContext): Promise<void> {
  await reply(ctx, CHILDREN_POLICY_PROMPT, [...CHILDREN_POLICY_BUTTONS]);
}

async function sendThemeQuestion(ctx: CreateEventContext): Promise<void> {
  await sendMessage({
    conversationId: ctx.conversationId,
    accountId: ctx.accountId,
    message: THEME_PROMPT,
    list: eventThemeChoiceList(),
  });
}

async function sendDressQuestion(ctx: CreateEventContext): Promise<void> {
  await reply(ctx, DRESS_CODE_PROMPT, [...DRESS_CODE_BUTTONS]);
}

async function sendConfirmation(
  ctx: CreateEventContext,
  state: ConversationState,
): Promise<void> {
  await reply(ctx, formatEventConfirmation(state), [
    { title: 'Confirm', payload: CONFIRM_EVENT },
    { title: 'Cancel', payload: CANCEL_EVENT },
  ]);
}

async function reply(
  ctx: CreateEventContext,
  message: string,
  buttons?: Array<{ title: string; payload: string }>,
): Promise<void> {
  await sendMessage({
    conversationId: ctx.conversationId,
    accountId: ctx.accountId,
    message,
    buttons,
  });
}
