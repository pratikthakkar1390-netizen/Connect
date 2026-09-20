import {
  buildAckUpdateUrl,
  eventCancelTemplateName,
  eventUpdateAckTemplateName,
  eventUpdateTemplateName,
  isWebGuestPhone,
  normalizePhone,
} from '../config.js';
import {
  acknowledgeUpdateRecipient,
  allocateUniqueAckToken,
  cancelEvent,
  claimOrganizerAllAckedNotified,
  clearConversationState,
  createEventUpdate,
  deleteEvent,
  deleteEventImageIfUnreferenced,
  getConversationState,
  getEventById,
  getEventUpdateAckCounts,
  getEventUpdateById,
  getMessageSession,
  insertEventUpdateRecipient,
  isEventCancelled,
  isEventDeleted,
  listEventUpdateRecipients,
  listEventUpdateTargets,
  listEventsForOrganizer,
  listInvitationsForEvent,
  listUnacknowledgedSentRecipients,
  markUpdateRecipientReminderSent,
  setConversationState,
  updateEventDetails,
  type ConversationState,
  type ConversationStep,
  type Event,
  type EventUpdate,
  type EventUpdateTarget,
  type EventUpdateType,
} from '../db/store.js';
import { parseEventDate, parseEventTime, parseRsvpDeadline, getEventInstantMs, isDateOnlyFormatted, rsvpDeadlineWeeksBefore, resolveEventTimezone } from '../dates/eventDate.js';
import { eventTimezonePickerUrl } from '../http/eventTimezoneToken.js';
import { parseQuickTimezoneId } from '../timezones/catalog.js';
import {
  applyPickedEventTimezone,
  formatDateQuestion,
  formatDeadlineQuestion,
  formatDeadlineTimeQuestion,
  formatTimeQuestion,
  MERIDIEM_PROMPT,
  parseRsvpDeadlineChoice,
  RSVP_DEADLINE_BEFORE_EVENT,
  RSVP_DEADLINE_IN_PAST,
  RSVP_DEADLINE_PROMPT,
  rsvpDeadlineChoiceList,
  SPECIFIC_TIME_PROMPT,
  TIME_PROMPT,
  TIMEZONE_PROMPT,
  timezoneChoiceList,
  EVENT_IMAGE_PROMPT,
} from './createEventFlow.js';
import {
  isBroadcastSendSuccessful,
  sendEventNoticeBroadcast,
  sendInboxMessage,
  type InboxSendResult,
  type SendMessageParams,
} from '../zernio/client.js';
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
import { eventImagePickerUrl } from '../http/eventImageToken.js';
import {
  formatAckUpdateMessage,
  formatCancelConfirmation,
  formatCancelGuestMessage,
  formatEditedEventReview,
  formatEveryoneAcknowledgedMessage,
  formatGuestAckThankYou,
  formatInfoSendConfirmation,
  formatInfoUpdateMessage,
  formatUpdateStatusMessage,
  formatViewEventMessage,
  rsvpLinkForEvent,
} from './eventUpdateMessage.js';
import { organizerGuestDisplayName, type CommandContext } from './organizer.js';
import {
  buildEventSelectList,
  eventButtonPayload,
  eventListRowId,
  hasEventAction,
  interactiveCommandInput,
  matchEventAction,
  parseEventActionId,
} from '../whatsapp/eventList.js';

const MANAGE_EVENT = 'MANAGE_EVENT';

export const EDIT_EVENT = 'EDIT_EVENT';
export const CHANGE_NAME = 'CHANGE_NAME';
export const CHANGE_WHEN = 'CHANGE_WHEN';
export const CHANGE_TIMEZONE = 'CHANGE_TIMEZONE';
export const CHANGE_LOCATION = 'CHANGE_LOCATION';
export const CHANGE_THEME = 'CHANGE_THEME';
export const CHANGE_DRESS = 'CHANGE_DRESS';
export const CHANGE_DEADLINE = 'CHANGE_DEADLINE';
export const CHANGE_IMAGE = 'CHANGE_IMAGE';
export const IMAGE_KEEP = 'IMAGE_KEEP';
export const IMAGE_REPLACE = 'IMAGE_REPLACE';
export const IMAGE_REMOVE = 'IMAGE_REMOVE';

export const EDIT_IMAGE_BUTTONS = [
  { title: 'Keep photo', payload: IMAGE_KEEP },
  { title: 'Replace photo', payload: IMAGE_REPLACE },
  { title: 'Remove photo', payload: IMAGE_REMOVE },
];

export const EDIT_DONE = 'EDIT_DONE';
export const SEND_UPDATE = 'SEND_UPDATE';
export const VOID_EVENT = 'VOID_EVENT';
export const CONFIRM_VOID_EVENT = 'CONFIRM_VOID_EVENT';
export const DELETE_EVENT = 'DELETE_EVENT';
export const CONFIRM_DELETE_EVENT = 'CONFIRM_DELETE_EVENT';
export const KEEP_EVENT = 'KEEP_EVENT';
export const KEEP_VALUE = 'KEEP_VALUE';
export const SKIP_VALUE = 'SKIP_VALUE';
export const UPDATE_INFO = 'UPDATE_INFO';
export const UPDATE_ACK = 'UPDATE_ACK';
export const UPDATE_BACK = 'UPDATE_BACK';
export const VIEW_UPDATE_STATUS = 'VIEW_UPDATE_STATUS';
export const REMIND_UPDATE = 'REMIND_UPDATE';
export const ACK_UPDATE = 'ACK_UPDATE';
export const VIEW_EVENT_RSVP = 'VIEW_EVENT_RSVP';

const UPDATE_FLOW_STATES = new Set([
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
  'WAITING_FOR_CANCEL_CONFIRM',
  'WAITING_FOR_DELETE_CONFIRM',
]);

const NO_INVITED_GUESTS_MESSAGE =
  'No invited guests to notify yet. Send invitations first, then try Send Update again.';
const WEB_ONLY_UPDATE_MESSAGE =
  "These guests RSVP'd on the web and don't have a WhatsApp number on file. CONNECT can only send updates in WhatsApp to guests who messaged CONNECT or have a phone on the invitation.";

export function formatEditDateQuestion(
  phone: string,
  eventName?: string | null,
  currentDate?: string | null,
  intro?: string,
  timezone?: string | null,
): string {
  const current = currentDate?.trim()
    ? `Current date: *${currentDate}*\n\n`
    : '';
  return `${current}${formatDateQuestion(phone, eventName, intro, timezone)}`;
}

export function formatEditTimeQuestion(phone: string, base = TIME_PROMPT): string {
  return formatTimeQuestion(phone, base);
}

export function formatEditLocationQuestion(
  currentLocation?: string | null,
): string {
  return `Current location: *${currentLocation ?? ''}*\n\nReply with the new location.`;
}

export function keepStepButton(): { title: string; payload: string } {
  return { title: 'Keep', payload: KEEP_VALUE };
}

export function skipStepButton(): { title: string; payload: string } {
  return { title: 'Skip', payload: SKIP_VALUE };
}

function isKeepValue(input: string): boolean {
  return input.trim().toUpperCase() === KEEP_VALUE;
}

function isSkipOrKeepValue(input: string): boolean {
  const upper = input.trim().toUpperCase();
  return upper === SKIP_VALUE || upper === KEEP_VALUE;
}

type SendFn = (params: SendMessageParams) => Promise<void | InboxSendResult>;
type BroadcastFn = typeof sendEventNoticeBroadcast;
let sendMessage: SendFn = sendInboxMessage;
let sendGuestInbox: SendFn = sendInboxMessage;
let sendGuestBroadcast: BroadcastFn = sendEventNoticeBroadcast;

export type GuestNoticeSendFn = (params: {
  phone: string;
  conversationId?: string;
  accountId: string;
  message: string;
  buttons?: Array<{ title: string; payload: string }>;
  templateName?: string;
  event: Event;
  extra: string;
}) => Promise<void>;

let sendGuestNotice: GuestNoticeSendFn = defaultSendGuestNotice;

export function setEventUpdateMessageSender(send?: SendFn): void {
  sendMessage = send ?? sendInboxMessage;
}

export function setEventUpdateGuestSender(send?: GuestNoticeSendFn): void {
  sendGuestNotice = send ?? defaultSendGuestNotice;
}

export function setEventUpdateTransports(options?: {
  inbox?: SendFn;
  broadcast?: BroadcastFn;
}): void {
  sendGuestInbox = options?.inbox ?? sendInboxMessage;
  sendGuestBroadcast = options?.broadcast ?? sendEventNoticeBroadcast;
}

export function isEventUpdateFlowState(state?: string | null): boolean {
  return Boolean(state && UPDATE_FLOW_STATES.has(state));
}

const EVENT_UPDATE_ACTIONS = [
  EDIT_EVENT,
  CHANGE_NAME,
  CHANGE_WHEN,
  CHANGE_TIMEZONE,
  CHANGE_LOCATION,
  CHANGE_THEME,
  CHANGE_DRESS,
  CHANGE_DEADLINE,
  CHANGE_IMAGE,
  EDIT_DONE,
  SEND_UPDATE,
  VOID_EVENT,
  CONFIRM_VOID_EVENT,
  DELETE_EVENT,
  CONFIRM_DELETE_EVENT,
  KEEP_EVENT,
  UPDATE_INFO,
  UPDATE_ACK,
  UPDATE_BACK,
  VIEW_UPDATE_STATUS,
  REMIND_UPDATE,
  ACK_UPDATE,
  VIEW_EVENT_RSVP,
] as const;

export function isEventUpdateCommand(input: string): boolean {
  return EVENT_UPDATE_ACTIONS.some((action) => hasEventAction(input, action));
}

export function isGuestUpdateCommand(input: string): boolean {
  return hasEventAction(input, ACK_UPDATE) || hasEventAction(input, VIEW_EVENT_RSVP);
}

function parseIdSuffix(input: string, prefix: string): number | null {
  return parseEventActionId(input, prefix);
}

function isEventOwner(event: Event, phone: string): boolean {
  return event.organizer_phone === normalizePhone(phone);
}

function requireMatchingWizard(
  ctx: CommandContext,
  eventId: number,
  expected: ConversationStep,
): boolean {
  const state = getConversationState(ctx.phone);
  return Boolean(
    state && state.state === expected && state.event_id === eventId,
  );
}

async function reply(
  ctx: CommandContext,
  message: string,
  buttons?: Array<{ title: string; payload: string }>,
  list?: SendMessageParams['list'],
): Promise<void> {
  await sendMessage({
    conversationId: ctx.conversationId,
    accountId: ctx.accountId,
    message,
    buttons,
    list,
  });
}

async function denyAccess(ctx: CommandContext): Promise<void> {
  await reply(ctx, "That event wasn't found or you don't have access.");
}

async function requireOwnedEvent(
  ctx: CommandContext,
  eventId: number | null,
): Promise<Event | null> {
  if (eventId == null) {
    await denyAccess(ctx);
    return null;
  }
  const event = getEventById(eventId);
  if (!event || !isEventOwner(event, ctx.phone) || isEventDeleted(event)) {
    await denyAccess(ctx);
    return null;
  }
  return event;
}

function manageEventButton(eventId: number): { title: string; payload: string } {
  return { title: 'Manage Event', payload: eventButtonPayload(MANAGE_EVENT, eventId) };
}

function sendUpdateTypeButtons(
  eventId: number,
): Array<{ title: string; payload: string }> {
  return [
    { title: '📨 Information Only', payload: eventButtonPayload(UPDATE_INFO, eventId) },
    { title: '⚠️ Require Ack', payload: eventButtonPayload(UPDATE_ACK, eventId) },
    { title: '← Back', payload: eventButtonPayload(UPDATE_BACK, eventId) },
  ];
}

function ackStatusButtons(
  updateId: number,
): Array<{ title: string; payload: string }> {
  const update = getEventUpdateById(updateId);
  return [
    { title: '📋 View Status', payload: `${VIEW_UPDATE_STATUS} ${updateId}` },
    { title: '📢 Send Reminder', payload: `${REMIND_UPDATE} ${updateId}` },
    { title: 'Done', payload: `${MANAGE_EVENT} ${update?.event_id ?? ''}`.trim() },
  ];
}

function guestViewRsvpButton(eventId: number) {
  return { title: 'View RSVP', payload: `${VIEW_EVENT_RSVP} ${eventId}` };
}

async function defaultSendGuestNotice(params: {
  phone: string;
  conversationId?: string;
  accountId: string;
  message: string;
  buttons?: Array<{ title: string; payload: string }>;
  templateName?: string;
  event: Event;
  extra: string;
}): Promise<void> {
  const session = getMessageSession(params.phone);
  const conversationId = params.conversationId || session?.conversation_id;
  const accountId = session?.account_id || params.accountId;

  if (conversationId) {
    try {
      await sendGuestInbox({
        conversationId,
        accountId,
        message: params.message,
        buttons: params.buttons,
      });
      return;
    } catch (error) {
      console.error(
        `Event update inbox send failed for ${params.phone}:`,
        error,
      );
    }
  }

  if (params.templateName) {
    const result = await sendGuestBroadcast({
      templateName: params.templateName,
      eventName: params.event.name,
      eventDate: params.event.date,
      eventLocation: params.event.location,
      extra: params.extra,
      phones: [params.phone],
      broadcastName: `event-notice-${params.event.id}-${Date.now()}`,
    });
    if (!isBroadcastSendSuccessful(result)) {
      throw new Error(
        `Event notice broadcast failed for ${params.phone}: sent=${result.sent} failed=${result.failed}`,
      );
    }
    return;
  }

  throw new Error('No in-session conversation and no event-update template');
}

function templateForType(type: EventUpdateType): string | undefined {
  if (type === 'ack') {
    return eventUpdateAckTemplateName();
  }
  if (type === 'cancel') {
    return eventCancelTemplateName();
  }
  return eventUpdateTemplateName();
}

async function deliverToTargets(input: {
  ctx: CommandContext;
  event: Event;
  targets: EventUpdateTarget[];
  type: EventUpdateType;
  message?: string | null;
}): Promise<EventUpdate> {
  const latest = getEventById(input.event.id) ?? input.event;
  const update = createEventUpdate({
    eventId: latest.id,
    type: input.type,
    name: latest.name,
    date: latest.date,
    location: latest.location,
    message: input.message,
  });

  for (const target of input.targets) {
    const ackToken =
      input.type === 'ack' ? allocateUniqueAckToken() : null;
    const ackUrl = ackToken ? buildAckUpdateUrl(ackToken) : null;
    const body =
      input.type === 'cancel'
        ? formatCancelGuestMessage(latest)
        : input.type === 'ack'
          ? formatAckUpdateMessage(latest, input.message, ackUrl)
          : formatInfoUpdateMessage(latest, input.message);
    const extra =
      input.type === 'ack'
        ? ackUrl || ' '
        : input.message?.trim() || rsvpLinkForEvent(latest) || ' ';
    const buttons =
      input.type === 'ack' ? [guestViewRsvpButton(latest.id)] : undefined;
    const session = getMessageSession(target.phone);
    try {
      await sendGuestNotice({
        phone: target.phone,
        conversationId: session?.conversation_id,
        accountId: session?.account_id || input.ctx.accountId,
        message: body,
        buttons,
        templateName: templateForType(input.type),
        event: latest,
        extra,
      });
      insertEventUpdateRecipient({
        updateId: update.id,
        invitationId: target.invitationId,
        guestId: target.guestId,
        phone: target.phone,
        sendStatus: 'sent',
        ackToken,
      });
    } catch (error) {
      console.error(`Event update send failed for ${target.phone}:`, error);
      insertEventUpdateRecipient({
        updateId: update.id,
        invitationId: target.invitationId,
        guestId: target.guestId,
        phone: target.phone,
        sendStatus: 'failed',
        ackToken,
      });
    }
  }

  return update;
}

async function showManageEvent(ctx: CommandContext, event: Event): Promise<void> {
  const { buildManageEventReply } = await import('./welcome.js');
  const replyPayload = buildManageEventReply(event);
  await reply(ctx, replyPayload.message, replyPayload.buttons);
}

async function requireOwnedAction(
  ctx: CommandContext,
  input: string,
  action: string,
): Promise<Event | null> {
  const selected = matchEventAction(input, action);
  if (!selected.match || selected.invalidSuffix) {
    await denyAccess(ctx);
    return null;
  }
  return requireOwnedEvent(ctx, selected.eventId ?? null);
}

async function showDeleteEventPicker(ctx: CommandContext): Promise<boolean> {
  const events = listEventsForOrganizer(ctx.phone);
  if (events.length === 0) {
    await reply(
      ctx,
      "You don't have any events yet. Tap below to create your first one!",
      [{ title: 'Create an Event', payload: 'CREATE_EVENT' }],
    );
    return true;
  }
  if (events.length === 1) {
    return promptDeleteEvent(ctx, events[0]);
  }
  await reply(
    ctx,
    'Pick an event to delete:',
    undefined,
    buildEventSelectList(events, DELETE_EVENT, {
      button: 'Delete Event',
      sectionTitle: 'Your events',
    }),
  );
  return true;
}

export async function handleEventUpdateCommand(
  ctx: CommandContext,
  input: string,
): Promise<boolean> {
  const trimmed = interactiveCommandInput({
    interactiveType: ctx.interactiveType,
    interactiveId: ctx.interactiveId,
    buttonPayload: ctx.buttonPayload,
    text: input?.trim() || ctx.text,
  });

  if (hasEventAction(trimmed, EDIT_EVENT)) {
    const event = await requireOwnedAction(ctx, trimmed, EDIT_EVENT);
    if (!event) {
      return true;
    }
    return startEditEvent(ctx, event);
  }

  if (hasEventAction(trimmed, CHANGE_NAME)) {
    const event = await requireOwnedAction(ctx, trimmed, CHANGE_NAME);
    if (!event) {
      return true;
    }
    return promptEditName(ctx, event);
  }

  if (hasEventAction(trimmed, CHANGE_WHEN)) {
    const event = await requireOwnedAction(ctx, trimmed, CHANGE_WHEN);
    if (!event) {
      return true;
    }
    return promptEditWhen(ctx, event);
  }

  if (hasEventAction(trimmed, CHANGE_TIMEZONE)) {
    const event = await requireOwnedAction(ctx, trimmed, CHANGE_TIMEZONE);
    if (!event) {
      return true;
    }
    return promptEditTimezone(ctx, event);
  }

  if (hasEventAction(trimmed, CHANGE_LOCATION)) {
    const event = await requireOwnedAction(ctx, trimmed, CHANGE_LOCATION);
    if (!event) {
      return true;
    }
    return promptEditLocation(ctx, event);
  }

  if (hasEventAction(trimmed, CHANGE_THEME)) {
    const event = await requireOwnedAction(ctx, trimmed, CHANGE_THEME);
    if (!event) {
      return true;
    }
    return promptEditTheme(ctx, event);
  }

  if (hasEventAction(trimmed, CHANGE_DRESS)) {
    const event = await requireOwnedAction(ctx, trimmed, CHANGE_DRESS);
    if (!event) {
      return true;
    }
    return promptEditDress(ctx, event);
  }

  if (hasEventAction(trimmed, CHANGE_DEADLINE)) {
    const event = await requireOwnedAction(ctx, trimmed, CHANGE_DEADLINE);
    if (!event) {
      return true;
    }
    return promptEditDeadline(ctx, event);
  }

  if (hasEventAction(trimmed, CHANGE_IMAGE)) {
    const event = await requireOwnedAction(ctx, trimmed, CHANGE_IMAGE);
    if (!event) {
      return true;
    }
    return promptEditImage(ctx, event);
  }

  if (hasEventAction(trimmed, EDIT_DONE)) {
    const event = await requireOwnedAction(ctx, trimmed, EDIT_DONE);
    if (!event) {
      return true;
    }
    clearConversationState(ctx.phone);
    await showManageEvent(ctx, event);
    return true;
  }

  if (hasEventAction(trimmed, SEND_UPDATE)) {
    const event = await requireOwnedAction(ctx, trimmed, SEND_UPDATE);
    if (!event) {
      return true;
    }
    return startSendUpdate(ctx, event);
  }

  if (hasEventAction(trimmed, VOID_EVENT)) {
    const event = await requireOwnedAction(ctx, trimmed, VOID_EVENT);
    if (!event) {
      return true;
    }
    return promptCancelEvent(ctx, event);
  }

  if (hasEventAction(trimmed, DELETE_EVENT)) {
    const selected = matchEventAction(trimmed, DELETE_EVENT);
    if (selected.invalidSuffix) {
      await denyAccess(ctx);
      return true;
    }
    if (selected.eventId == null) {
      return showDeleteEventPicker(ctx);
    }
    const event = await requireOwnedEvent(ctx, selected.eventId);
    if (!event) {
      return true;
    }
    return promptDeleteEvent(ctx, event);
  }

  if (hasEventAction(trimmed, CONFIRM_DELETE_EVENT)) {
    const event = await requireOwnedEvent(
      ctx,
      parseIdSuffix(trimmed, CONFIRM_DELETE_EVENT),
    );
    if (!event) {
      return true;
    }
    if (!requireMatchingWizard(ctx, event.id, 'WAITING_FOR_DELETE_CONFIRM')) {
      await reply(
        ctx,
        'That delete confirmation is no longer active. Open Manage Event and tap Delete Event to start again.',
        [manageEventButton(event.id)],
      );
      return true;
    }
    return finishDeleteEvent(ctx, event);
  }

  if (hasEventAction(trimmed, KEEP_EVENT)) {
    const event = await requireOwnedEvent(ctx, parseIdSuffix(trimmed, KEEP_EVENT));
    if (!event) {
      return true;
    }
    clearConversationState(ctx.phone);
    await showManageEvent(ctx, event);
    return true;
  }

  if (hasEventAction(trimmed, CONFIRM_VOID_EVENT)) {
    const event = await requireOwnedEvent(
      ctx,
      parseIdSuffix(trimmed, CONFIRM_VOID_EVENT),
    );
    if (!event) {
      return true;
    }
    if (!requireMatchingWizard(ctx, event.id, 'WAITING_FOR_CANCEL_CONFIRM')) {
      await reply(
        ctx,
        'That cancel confirmation is no longer active. Open Manage Event and tap Cancel Event to start again.',
        [manageEventButton(event.id)],
      );
      return true;
    }
    return finishCancelEvent(ctx, event);
  }

  if (hasEventAction(trimmed, UPDATE_INFO)) {
    const event = await requireOwnedEvent(ctx, parseIdSuffix(trimmed, UPDATE_INFO));
    if (!event) {
      return true;
    }
    if (!requireMatchingWizard(ctx, event.id, 'WAITING_FOR_UPDATE_TYPE')) {
      await reply(
        ctx,
        'That Send Update step is no longer active. Open Manage Event and tap Send Update to start again.',
        [manageEventButton(event.id)],
      );
      return true;
    }
    return finishSendUpdate(ctx, event, 'info');
  }

  if (hasEventAction(trimmed, UPDATE_ACK)) {
    const event = await requireOwnedEvent(ctx, parseIdSuffix(trimmed, UPDATE_ACK));
    if (!event) {
      return true;
    }
    if (!requireMatchingWizard(ctx, event.id, 'WAITING_FOR_UPDATE_TYPE')) {
      await reply(
        ctx,
        'That Send Update step is no longer active. Open Manage Event and tap Send Update to start again.',
        [manageEventButton(event.id)],
      );
      return true;
    }
    return finishSendUpdate(ctx, event, 'ack');
  }

  if (hasEventAction(trimmed, UPDATE_BACK)) {
    const event = await requireOwnedEvent(ctx, parseIdSuffix(trimmed, UPDATE_BACK));
    if (!event) {
      return true;
    }
    clearConversationState(ctx.phone);
    await showManageEvent(ctx, event);
    return true;
  }

  if (hasEventAction(trimmed, VIEW_UPDATE_STATUS)) {
    const updateId = parseIdSuffix(trimmed, VIEW_UPDATE_STATUS);
    if (updateId == null) {
      await denyAccess(ctx);
      return true;
    }
    return showUpdateStatus(ctx, updateId);
  }

  if (hasEventAction(trimmed, REMIND_UPDATE)) {
    const updateId = parseIdSuffix(trimmed, REMIND_UPDATE);
    if (updateId == null) {
      await denyAccess(ctx);
      return true;
    }
    return sendAckReminders(ctx, updateId);
  }

  if (hasEventAction(trimmed, ACK_UPDATE) || hasEventAction(trimmed, VIEW_EVENT_RSVP)) {
    return handleGuestUpdateCommand(ctx, trimmed);
  }

  return continueEventUpdateFlow(ctx, trimmed);
}

export async function continueEventUpdateFlow(
  ctx: CommandContext,
  input: string,
): Promise<boolean> {
  const state = getConversationState(ctx.phone);
  if (!state || !isEventUpdateFlowState(state.state)) {
    return false;
  }

  const { isGreeting } = await import('./welcome.js');
  if (isGreeting(input)) {
    return false;
  }

  switch (state.state) {
    case 'WAITING_FOR_EDIT_FIELD': {
      const event =
        state.event_id != null ? getEventById(state.event_id) : undefined;
      if (!event || isEventDeleted(event)) {
        clearConversationState(ctx.phone);
        await denyAccess(ctx);
        return true;
      }
      return startEditEvent(ctx, event);
    }
    case 'WAITING_FOR_EDIT_NAME':
      return handleEditName(ctx, state, input);
    case 'WAITING_FOR_EDIT_DATE':
      return handleEditDate(ctx, state, input);
    case 'WAITING_FOR_EDIT_TIME':
      return handleEditTime(ctx, state, input);
    case 'WAITING_FOR_EDIT_TIMEZONE':
      return handleEditTimezone(ctx, state, input);
    case 'WAITING_FOR_EDIT_LOCATION':
      return handleEditLocation(ctx, state, input);
    case 'WAITING_FOR_EDIT_THEME':
      return handleEditTheme(ctx, state, input);
    case 'WAITING_FOR_EDIT_CUSTOM_THEME':
      return handleEditCustomTheme(ctx, state, input);
    case 'WAITING_FOR_EDIT_DRESS':
      return handleEditDress(ctx, state, input);
    case 'WAITING_FOR_EDIT_DRESS_TEXT':
      return handleEditDressText(ctx, state, input);
    case 'WAITING_FOR_EDIT_DEADLINE':
      return handleEditDeadline(ctx, state, input);
    case 'WAITING_FOR_EDIT_IMAGE':
      return handleEditImage(ctx, state, input);
    case 'WAITING_FOR_UPDATE_MESSAGE':
      return handleUpdateMessage(ctx, state, input);
    case 'WAITING_FOR_UPDATE_TYPE':
      await reply(
        ctx,
        '📢 Send Event Update\n\nChoose how guests should receive this update:',
        sendUpdateTypeButtons(state.event_id ?? 0),
      );
      return true;
    case 'WAITING_FOR_CANCEL_CONFIRM': {
      const event =
        state.event_id != null ? getEventById(state.event_id) : undefined;
      if (!event || isEventDeleted(event)) {
        clearConversationState(ctx.phone);
        await denyAccess(ctx);
        return true;
      }
      return promptCancelEvent(ctx, event);
    }
    case 'WAITING_FOR_DELETE_CONFIRM': {
      const event =
        state.event_id != null ? getEventById(state.event_id) : undefined;
      if (!event || isEventDeleted(event)) {
        clearConversationState(ctx.phone);
        await denyAccess(ctx);
        return true;
      }
      return promptDeleteEvent(ctx, event);
    }
    default:
      return false;
  }
}

function editEventDraft(event: Event) {
  return {
    event_id: event.id,
    name: event.name,
    date: event.date,
    location: event.location,
    theme: event.theme ?? null,
    custom_theme: event.custom_theme ?? null,
    dress_code: event.dress_code ?? null,
    rsvp_deadline: event.rsvp_deadline ?? null,
    location_place_id: event.location_place_id ?? null,
    location_maps_url: event.location_maps_url ?? null,
    location_address: event.location_address ?? null,
    image_filename: event.image_filename ?? null,
    timezone: event.timezone ?? null,
    update_message: null,
  };
}

export function editFieldList(event: Event): NonNullable<SendMessageParams['list']> {
  return {
    button: 'Change',
    sections: [
      {
        title: 'Edit',
        rows: [
          { id: eventListRowId(CHANGE_NAME, event.id), title: 'Name' },
          { id: eventListRowId(CHANGE_WHEN, event.id), title: 'Date & Time' },
          { id: eventListRowId(CHANGE_TIMEZONE, event.id), title: 'Timezone' },
          { id: eventListRowId(CHANGE_LOCATION, event.id), title: 'Location' },
          { id: eventListRowId(CHANGE_THEME, event.id), title: 'Event Style' },
          { id: eventListRowId(CHANGE_DRESS, event.id), title: 'What to Wear' },
          { id: eventListRowId(CHANGE_IMAGE, event.id), title: 'Event Image' },
          { id: eventListRowId(CHANGE_DEADLINE, event.id), title: 'RSVP Deadline' },
          { id: eventListRowId(EDIT_DONE, event.id), title: 'Done' },
        ],
      },
    ],
  };
}

async function startEditEvent(ctx: CommandContext, event: Event): Promise<boolean> {
  if (isEventCancelled(event)) {
    await reply(
      ctx,
      'This event is cancelled. You can still view saved RSVPs.',
      [manageEventButton(event.id)],
    );
    return true;
  }

  clearConversationState(ctx.phone);
  setConversationState(ctx.phone, 'WAITING_FOR_EDIT_FIELD', editEventDraft(event));
  await reply(
    ctx,
    'What would you like to change?',
    undefined,
    editFieldList(event),
  );
  return true;
}

function seedEditField(
  ctx: CommandContext,
  event: Event,
  state: ConversationStep,
): void {
  setConversationState(ctx.phone, state, editEventDraft(event));
}

async function promptEditName(ctx: CommandContext, event: Event): Promise<boolean> {
  if (isEventCancelled(event)) {
    return startEditEvent(ctx, event);
  }
  seedEditField(ctx, event, 'WAITING_FOR_EDIT_NAME');
  await reply(ctx, `Current name: *${event.name}*\n\nReply with the new name.`);
  return true;
}

async function promptEditWhen(ctx: CommandContext, event: Event): Promise<boolean> {
  if (isEventCancelled(event)) {
    return startEditEvent(ctx, event);
  }
  seedEditField(ctx, event, 'WAITING_FOR_EDIT_DATE');
  await reply(ctx, formatEditDateQuestion(ctx.phone, event.name, event.date, undefined, event.timezone));
  return true;
}

async function promptEditTimezone(ctx: CommandContext, event: Event): Promise<boolean> {
  if (isEventCancelled(event)) {
    return startEditEvent(ctx, event);
  }
  seedEditField(ctx, event, 'WAITING_FOR_EDIT_TIMEZONE');
  await reply(ctx, TIMEZONE_PROMPT, undefined, timezoneChoiceList());
  return true;
}

async function promptEditLocation(ctx: CommandContext, event: Event): Promise<boolean> {
  if (isEventCancelled(event)) {
    return startEditEvent(ctx, event);
  }
  seedEditField(ctx, event, 'WAITING_FOR_EDIT_LOCATION');
  await reply(ctx, formatEditLocationQuestion(event.location));
  return true;
}

async function promptEditTheme(ctx: CommandContext, event: Event): Promise<boolean> {
  if (isEventCancelled(event)) {
    return startEditEvent(ctx, event);
  }
  seedEditField(ctx, event, 'WAITING_FOR_EDIT_THEME');
  await sendEditThemeQuestion(ctx);
  return true;
}

async function promptEditDress(ctx: CommandContext, event: Event): Promise<boolean> {
  if (isEventCancelled(event)) {
    return startEditEvent(ctx, event);
  }
  seedEditField(ctx, event, 'WAITING_FOR_EDIT_DRESS');
  await sendEditDressQuestion(ctx);
  return true;
}

async function promptEditDeadline(ctx: CommandContext, event: Event): Promise<boolean> {
  if (isEventCancelled(event)) {
    return startEditEvent(ctx, event);
  }
  seedEditField(ctx, event, 'WAITING_FOR_EDIT_DEADLINE');
  await sendEditDeadlineQuestion(ctx, event.date);
  return true;
}

export function parseEditImageChoice(
  input: string,
): { keep: true } | { replace: true } | { remove: true } | undefined {
  const normalized = input
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (
    normalized === 'IMAGE KEEP' ||
    normalized === 'KEEP PHOTO' ||
    normalized === 'KEEP'
  ) {
    return { keep: true };
  }
  if (
    normalized === 'IMAGE REPLACE' ||
    normalized === 'REPLACE PHOTO' ||
    normalized === 'REPLACE' ||
    normalized === 'IMAGE CHOOSE' ||
    normalized === 'CHOOSE FROM PHONE'
  ) {
    return { replace: true };
  }
  if (
    normalized === 'IMAGE REMOVE' ||
    normalized === 'REMOVE PHOTO' ||
    normalized === 'REMOVE'
  ) {
    return { remove: true };
  }
  return undefined;
}

function formatEditImageQuestion(event: Event): string {
  const current = event.image_filename?.trim()
    ? 'This event has a photo.'
    : 'No photo yet.';
  return `${EVENT_IMAGE_PROMPT}\n\n${current}`;
}

async function promptEditImage(ctx: CommandContext, event: Event): Promise<boolean> {
  if (isEventCancelled(event)) {
    return startEditEvent(ctx, event);
  }
  seedEditField(ctx, event, 'WAITING_FOR_EDIT_IMAGE');
  await reply(ctx, formatEditImageQuestion(event), [...EDIT_IMAGE_BUTTONS]);
  return true;
}

async function handleEditImage(
  ctx: CommandContext,
  state: ConversationState,
  input: string,
): Promise<boolean> {
  const event = state.event_id != null ? getEventById(state.event_id) : undefined;
  if (!event || isEventDeleted(event) || isEventCancelled(event)) {
    clearConversationState(ctx.phone);
    await denyAccess(ctx);
    return true;
  }
  const choice = parseEditImageChoice(input);
  if (choice && 'keep' in choice) {
    return finishEditEvent(ctx, state);
  }
  if (choice && 'replace' in choice) {
    await reply(
      ctx,
      `Open this link on your phone to choose a photo:\n${eventImagePickerUrl(ctx.phone)}`,
    );
    return true;
  }
  if (choice && 'remove' in choice) {
    const next = setConversationState(ctx.phone, 'WAITING_FOR_EDIT_IMAGE', {
      image_filename: null,
    });
    return finishEditEvent(ctx, next);
  }
  await reply(ctx, formatEditImageQuestion(event), [...EDIT_IMAGE_BUTTONS]);
  return true;
}

async function handleEditName(
  ctx: CommandContext,
  state: ConversationState,
  input: string,
): Promise<boolean> {
  if (isKeepValue(input) || !input.trim()) {
    await reply(ctx, 'Reply with the new event name.');
    return true;
  }
  const next = setConversationState(ctx.phone, 'WAITING_FOR_EDIT_NAME', {
    name: input.trim(),
  });
  return finishEditEvent(ctx, next);
}

function editTz(state: ConversationState): string {
  return resolveEventTimezone(state.timezone);
}

async function handleEditTimezone(
  ctx: CommandContext,
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
  const iana = parseQuickTimezoneId(compact) || parseQuickTimezoneId(input);
  if (!iana) {
    await reply(ctx, TIMEZONE_PROMPT, undefined, timezoneChoiceList());
    return true;
  }
  const applied = await applyPickedEventTimezone(ctx.phone, iana);
  if (!applied.ok) {
    await reply(ctx, TIMEZONE_PROMPT, undefined, timezoneChoiceList());
  }
  return true;
}

async function handleEditDate(
  ctx: CommandContext,
  state: ConversationState,
  input: string,
): Promise<boolean> {
  if (isKeepValue(input) || !input.trim()) {
    await reply(ctx, formatEditDateQuestion(ctx.phone, state.name, state.date, undefined, state.timezone));
    return true;
  }

  const parsed = parseEventDate(input, { timezone: editTz(state) });
  if (!parsed.ok) {
    await reply(
      ctx,
      formatEditDateQuestion(
        ctx.phone,
        state.name,
        state.date,
        parsed.reason === 'missingMeridiem'
          ? MERIDIEM_PROMPT
          : parsed.reason === 'vagueTime'
            ? SPECIFIC_TIME_PROMPT
            : parsed.reason === 'ambiguous'
              ? 'That date could mean more than one thing. Please reply with a clearer date.'
              : "I couldn't understand that date. Please try again.",
        state.timezone,
      ),
    );
    return true;
  }

  if (!parsed.hasTime) {
    setConversationState(ctx.phone, 'WAITING_FOR_EDIT_TIME', {
      date: parsed.formatted,
    });
    await reply(
      ctx,
      formatEditTimeQuestion(
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

  const next = setConversationState(ctx.phone, 'WAITING_FOR_EDIT_DATE', {
    date: parsed.formatted,
  });
  return finishEditEvent(ctx, next);
}

async function handleEditTime(
  ctx: CommandContext,
  state: ConversationState,
  input: string,
): Promise<boolean> {
  if (isKeepValue(input) || !input.trim()) {
    await reply(ctx, formatEditTimeQuestion(ctx.phone));
    return true;
  }

  const parsed = parseEventTime(input, state.date?.trim() ?? '', { timezone: editTz(state) });
  if (!parsed.ok) {
    await reply(
      ctx,
      formatEditTimeQuestion(
        ctx.phone,
        parsed.reason === 'missingMeridiem'
          ? MERIDIEM_PROMPT
          : `${SPECIFIC_TIME_PROMPT}\n\n${TIME_PROMPT}`,
      ),
    );
    return true;
  }

  const next = setConversationState(ctx.phone, 'WAITING_FOR_EDIT_TIME', {
    date: parsed.formatted,
  });
  return finishEditEvent(ctx, next);
}

async function handleEditLocation(
  ctx: CommandContext,
  _state: ConversationState,
  input: string,
): Promise<boolean> {
  if (isKeepValue(input) || !input.trim()) {
    const state = getConversationState(ctx.phone);
    await reply(ctx, formatEditLocationQuestion(state?.location));
    return true;
  }
  return continueEditAfterLocation(ctx, locationDraft(input));
}

async function continueEditAfterLocation(
  ctx: CommandContext,
  draft: LocationDraft,
): Promise<boolean> {
  if (!draft.location.trim()) {
    const state = getConversationState(ctx.phone);
    await reply(ctx, formatEditLocationQuestion(state?.location));
    return true;
  }
  const next = setConversationState(ctx.phone, 'WAITING_FOR_EDIT_LOCATION', draft);
  return finishEditEvent(ctx, next);
}

async function handleEditTheme(
  ctx: CommandContext,
  state: ConversationState,
  input: string,
): Promise<boolean> {
  if (isKeepValue(input)) {
    await sendEditThemeQuestion(ctx);
    return true;
  }
  const choice = parseThemeChoice(input);
  if (!choice) {
    await sendEditThemeQuestion(ctx);
    return true;
  }
  if ('skip' in choice) {
    const next = setConversationState(ctx.phone, 'WAITING_FOR_EDIT_THEME', {
      theme: null,
      custom_theme: null,
    });
    return finishEditEvent(ctx, next);
  }
  if (choice.theme === 'custom') {
    setConversationState(ctx.phone, 'WAITING_FOR_EDIT_CUSTOM_THEME', {
      theme: 'custom',
    });
    await reply(ctx, formatEditCustomThemeQuestion(state.custom_theme));
    return true;
  }
  const next = setConversationState(ctx.phone, 'WAITING_FOR_EDIT_THEME', {
    theme: choice.theme,
    custom_theme: null,
  });
  return finishEditEvent(ctx, next);
}

async function handleEditCustomTheme(
  ctx: CommandContext,
  state: ConversationState,
  input: string,
): Promise<boolean> {
  if (isKeepValue(input) || !input.trim()) {
    await reply(ctx, formatEditCustomThemeQuestion(state.custom_theme));
    return true;
  }
  const custom = sanitizeCustomTheme(input);
  if (!custom) {
    await reply(ctx, formatEditCustomThemeQuestion(state.custom_theme));
    return true;
  }
  const next = setConversationState(ctx.phone, 'WAITING_FOR_EDIT_CUSTOM_THEME', {
    theme: 'custom',
    custom_theme: custom,
  });
  return finishEditEvent(ctx, next);
}

async function handleEditDress(
  ctx: CommandContext,
  state: ConversationState,
  input: string,
): Promise<boolean> {
  if (isKeepValue(input)) {
    await sendEditDressQuestion(ctx);
    return true;
  }
  const choice = parseDressChoice(input);
  if (choice && 'skip' in choice) {
    const next = setConversationState(ctx.phone, 'WAITING_FOR_EDIT_DRESS', {
      dress_code: null,
    });
    return finishEditEvent(ctx, next);
  }
  if (choice && 'enter' in choice) {
    setConversationState(ctx.phone, 'WAITING_FOR_EDIT_DRESS_TEXT');
    await reply(ctx, formatEditDressTextQuestion(state.dress_code));
    return true;
  }
  if (!input.trim()) {
    await sendEditDressQuestion(ctx);
    return true;
  }
  const next = setConversationState(ctx.phone, 'WAITING_FOR_EDIT_DRESS', {
    dress_code: sanitizeDressCode(input),
  });
  return finishEditEvent(ctx, next);
}

async function handleEditDressText(
  ctx: CommandContext,
  state: ConversationState,
  input: string,
): Promise<boolean> {
  if (isKeepValue(input)) {
    await reply(ctx, formatEditDressTextQuestion(state.dress_code));
    return true;
  }
  const skipped = parseDressChoice(input);
  if (skipped && 'skip' in skipped) {
    const next = setConversationState(ctx.phone, 'WAITING_FOR_EDIT_DRESS_TEXT', {
      dress_code: null,
    });
    return finishEditEvent(ctx, next);
  }
  const dress = sanitizeDressCode(input);
  if (!dress) {
    await reply(ctx, formatEditDressTextQuestion(state.dress_code));
    return true;
  }
  const next = setConversationState(ctx.phone, 'WAITING_FOR_EDIT_DRESS_TEXT', {
    dress_code: dress,
  });
  return finishEditEvent(ctx, next);
}

async function handleEditDeadline(
  ctx: CommandContext,
  state: ConversationState,
  input: string,
): Promise<boolean> {
  if (isKeepValue(input)) {
    await sendEditDeadlineQuestion(ctx, state.date);
    return true;
  }
  const choice = parseRsvpDeadlineChoice(input);
  if (choice && 'custom' in choice) {
    await reply(ctx, formatDeadlineQuestion(ctx.phone));
    return true;
  }
  if (choice && 'skip' in choice) {
    const next = setConversationState(ctx.phone, 'WAITING_FOR_EDIT_DEADLINE', {
      rsvp_deadline: null,
    });
    return finishEditEvent(ctx, next);
  }
  if (choice && 'weeks' in choice) {
    const computed = rsvpDeadlineWeeksBefore(state.date ?? '', choice.weeks, {
      timezone: editTz(state),
    });
    if (!computed.ok) {
      await sendEditDeadlineQuestion(ctx, state.date, RSVP_DEADLINE_BEFORE_EVENT);
      return true;
    }
    const next = setConversationState(ctx.phone, 'WAITING_FOR_EDIT_DEADLINE', {
      rsvp_deadline: computed.formatted,
    });
    return finishEditEvent(ctx, next);
  }

  if (isDateOnlyFormatted(state.rsvp_deadline) && input.trim()) {
    const parsedTime = parseEventTime(input, state.rsvp_deadline ?? '', {
      timezone: editTz(state),
    });
    if (parsedTime.ok) {
      const eventMs = state.date ? getEventInstantMs(state.date, { timezone: editTz(state) }) : null;
      const deadline = parseRsvpDeadline(parsedTime.formatted, {
        eventDate: state.date,
        timezone: editTz(state),
      });
      if (
        deadline.ok &&
        (eventMs === null || deadline.instantMs < eventMs) &&
        deadline.instantMs > Date.now()
      ) {
        const next = setConversationState(ctx.phone, 'WAITING_FOR_EDIT_DEADLINE', {
          rsvp_deadline: deadline.formatted,
        });
        return finishEditEvent(ctx, next);
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
  }

  if (!input.trim()) {
    if (isDateOnlyFormatted(state.rsvp_deadline)) {
      await reply(ctx, formatDeadlineTimeQuestion(ctx.phone));
      return true;
    }
    await sendEditDeadlineQuestion(ctx, state.date);
    return true;
  }

  const parsed = parseRsvpDeadline(input, {
    eventDate: state.date,
    timezone: editTz(state),
  });
  if (!parsed.ok) {
    await sendEditDeadlineQuestion(
      ctx,
      state.date,
      "I couldn't understand that deadline. Please choose from the list or reply with a date.",
    );
    return true;
  }
  const eventMs = state.date ? getEventInstantMs(state.date, { timezone: editTz(state) }) : null;
  if (
    (eventMs !== null && parsed.instantMs >= eventMs) ||
    parsed.instantMs <= Date.now()
  ) {
    await sendEditDeadlineQuestion(ctx, state.date, RSVP_DEADLINE_BEFORE_EVENT);
    return true;
  }
  const next = setConversationState(ctx.phone, 'WAITING_FOR_EDIT_DEADLINE', {
    rsvp_deadline: parsed.formatted,
  });
  return finishEditEvent(ctx, next);
}

export function persistEditedEventDraft(phone: string): Event | undefined {
  const state = getConversationState(phone);
  if (!state || state.event_id == null) {
    return undefined;
  }
  const location = state.location?.trim() || '';
  if (!location) {
    return undefined;
  }
  const existing = getEventById(state.event_id);
  const previousImage = existing?.image_filename ?? null;
  const saved = updateEventDetails(state.event_id, {
    name: state.name?.trim() || '',
    date: state.date?.trim() || '',
    location,
    theme: state.theme ?? null,
    custom_theme: state.custom_theme ?? null,
    dress_code: state.dress_code ?? null,
    rsvp_deadline: state.rsvp_deadline ?? null,
    location_place_id: state.location_place_id ?? null,
    location_maps_url: state.location_maps_url ?? null,
    location_address: state.location_address ?? null,
    image_filename: state.image_filename ?? null,
    timezone: state.timezone ?? existing?.timezone ?? null,
  });
  clearConversationState(phone);
  if (previousImage && previousImage !== (saved?.image_filename ?? null)) {
    deleteEventImageIfUnreferenced(previousImage);
  }
  return saved;
}

export function editedEventNotifyButtons(
  eventId: number,
): Array<{ title: string; payload: string }> {
  return [
    { title: '📢 Send Update', payload: `${SEND_UPDATE} ${eventId}` },
    { title: 'Done', payload: `${MANAGE_EVENT} ${eventId}` },
  ];
}

async function finishEditEvent(
  ctx: CommandContext,
  _state: ConversationState,
): Promise<boolean> {
  const saved = persistEditedEventDraft(ctx.phone);
  if (!saved) {
    clearConversationState(ctx.phone);
    await denyAccess(ctx);
    return true;
  }

  await reply(ctx, formatEditedEventReview(saved), editedEventNotifyButtons(saved.id));
  return true;
}

function formatEditThemeQuestion(currentTheme?: string | null, custom?: string | null): string {
  const current =
    currentTheme === 'custom' && custom?.trim()
      ? `Current style: *${custom.trim()}*\n\n`
      : themeLabel(currentTheme)
        ? `Current style: *${themeLabel(currentTheme)}*\n\n`
        : 'No style selected.\n\n';
  return `${current}${THEME_PROMPT}`;
}

function formatEditCustomThemeQuestion(current?: string | null): string {
  const existing = current?.trim()
    ? `Current custom style: *${current.trim()}*\n\n`
    : '';
  return `${existing}${CUSTOM_THEME_PROMPT}`;
}

function formatEditDressQuestion(current?: string | null): string {
  const existing = current?.trim()
    ? `Current What to Wear: *${current.trim()}*\n\n`
    : 'No What to Wear selected.\n\n';
  return `${existing}${DRESS_CODE_PROMPT}`;
}

function formatEditDressTextQuestion(current?: string | null): string {
  const existing = current?.trim()
    ? `Current What to Wear: *${current.trim()}*\n\n`
    : '';
  return `${existing}${DRESS_CODE_TEXT_PROMPT}`;
}

async function sendEditThemeQuestion(ctx: CommandContext): Promise<void> {
  const state = getConversationState(ctx.phone);
  await sendMessage({
    conversationId: ctx.conversationId,
    accountId: ctx.accountId,
    message: formatEditThemeQuestion(state?.theme, state?.custom_theme),
    list: eventThemeChoiceList(),
  });
}

async function sendEditDressQuestion(ctx: CommandContext): Promise<void> {
  const state = getConversationState(ctx.phone);
  await reply(ctx, formatEditDressQuestion(state?.dress_code), [
    ...DRESS_CODE_BUTTONS,
  ]);
}

async function sendEditDeadlineQuestion(
  ctx: CommandContext,
  eventDate?: string | null,
  extra?: string,
): Promise<void> {
  const message = extra
    ? `${RSVP_DEADLINE_PROMPT}\n\n${extra}`
    : RSVP_DEADLINE_PROMPT;
  const state = getConversationState(ctx.phone);
  await sendMessage({
    conversationId: ctx.conversationId,
    accountId: ctx.accountId,
    message,
    list: rsvpDeadlineChoiceList(eventDate, state?.timezone),
  });
}

async function startSendUpdate(ctx: CommandContext, event: Event): Promise<boolean> {
  if (isEventCancelled(event)) {
    await reply(
      ctx,
      'This event is cancelled, so guests cannot be sent an update.',
      [manageEventButton(event.id)],
    );
    return true;
  }

  const targets = listEventUpdateTargets(event.id);
  if (targets.length === 0) {
    clearConversationState(ctx.phone);
    const invited = listInvitationsForEvent(event.id).length > 0;
    await reply(
      ctx,
      invited ? WEB_ONLY_UPDATE_MESSAGE : NO_INVITED_GUESTS_MESSAGE,
      [manageEventButton(event.id)],
    );
    return true;
  }

  clearConversationState(ctx.phone);
  setConversationState(ctx.phone, 'WAITING_FOR_UPDATE_MESSAGE', {
    event_id: event.id,
    name: event.name,
    date: event.date,
    location: event.location,
    update_message: null,
  });
  await reply(
    ctx,
    'What should guests know? Reply with a short message (for example parking or weather), or tap Skip.',
    [skipStepButton()],
  );
  return true;
}

async function handleUpdateMessage(
  ctx: CommandContext,
  state: ConversationState,
  input: string,
): Promise<boolean> {
  const eventId = state.event_id;
  if (eventId == null) {
    clearConversationState(ctx.phone);
    await denyAccess(ctx);
    return true;
  }

  if (!input.trim()) {
    await reply(
      ctx,
      'What should guests know? Reply with a short message, or tap Skip.',
      [skipStepButton()],
    );
    return true;
  }
  const message = isSkipOrKeepValue(input) ? null : input.trim();
  setConversationState(ctx.phone, 'WAITING_FOR_UPDATE_TYPE', {
    event_id: eventId,
    update_message: message,
  });
  await reply(
    ctx,
    '📢 Send Event Update\n\nChoose how guests should receive this update:',
    sendUpdateTypeButtons(eventId),
  );
  return true;
}

async function finishSendUpdate(
  ctx: CommandContext,
  event: Event,
  type: 'info' | 'ack',
): Promise<boolean> {
  const latest = getEventById(event.id) ?? event;
  if (isEventCancelled(latest)) {
    clearConversationState(ctx.phone);
    await reply(
      ctx,
      'This event is cancelled, so guests cannot be sent an update.',
      [manageEventButton(latest.id)],
    );
    return true;
  }

  const targets = listEventUpdateTargets(latest.id);
  const draft = getConversationState(ctx.phone);
  const customMessage = draft?.event_id === latest.id ? draft.update_message : null;
  clearConversationState(ctx.phone);

  if (targets.length === 0) {
    const invited = listInvitationsForEvent(latest.id).length > 0;
    await reply(
      ctx,
      invited ? WEB_ONLY_UPDATE_MESSAGE : NO_INVITED_GUESTS_MESSAGE,
      [manageEventButton(latest.id)],
    );
    return true;
  }

  const update = await deliverToTargets({
    ctx,
    event: latest,
    targets,
    type,
    message: customMessage,
  });
  const counts = getEventUpdateAckCounts(update.id);

  if (type === 'info') {
    await reply(
      ctx,
      formatInfoSendConfirmation(latest.name, counts.sent, counts.failed),
      [manageEventButton(latest.id)],
    );
    return true;
  }

  await reply(
    ctx,
    formatUpdateStatusMessage(latest.name, counts),
    ackStatusButtons(update.id),
  );
  return true;
}

async function promptCancelEvent(ctx: CommandContext, event: Event): Promise<boolean> {
  if (isEventCancelled(event)) {
    await reply(ctx, 'This event is already cancelled.', [
      manageEventButton(event.id),
    ]);
    return true;
  }

  clearConversationState(ctx.phone);
  setConversationState(ctx.phone, 'WAITING_FOR_CANCEL_CONFIRM', {
    event_id: event.id,
    name: event.name,
    date: event.date,
    location: event.location,
    update_message: null,
  });
  await reply(
    ctx,
    '⚠️ Cancel Event?\n\nThis will mark the event as cancelled and notify your invited guests.',
    [
      { title: '❌ Cancel Event', payload: `${CONFIRM_VOID_EVENT} ${event.id}` },
      { title: 'Keep Event', payload: `${KEEP_EVENT} ${event.id}` },
    ],
  );
  return true;
}

async function finishCancelEvent(ctx: CommandContext, event: Event): Promise<boolean> {
  if (isEventCancelled(event)) {
    clearConversationState(ctx.phone);
    await reply(ctx, 'This event is already cancelled.', [
      manageEventButton(event.id),
    ]);
    return true;
  }

  const cancelled = cancelEvent(event.id);
  clearConversationState(ctx.phone);
  if (!cancelled) {
    await denyAccess(ctx);
    return true;
  }

  const targets = listEventUpdateTargets(cancelled.id);
  let sent = 0;
  let failed = 0;
  if (targets.length > 0) {
    const update = await deliverToTargets({
      ctx,
      event: cancelled,
      targets,
      type: 'cancel',
    });
    const counts = getEventUpdateAckCounts(update.id);
    sent = counts.sent;
    failed = counts.failed;
  }

  await reply(ctx, formatCancelConfirmation(cancelled.name, sent, failed), [
    manageEventButton(cancelled.id),
  ]);
  return true;
}

async function promptDeleteEvent(ctx: CommandContext, event: Event): Promise<boolean> {
  clearConversationState(ctx.phone);
  setConversationState(ctx.phone, 'WAITING_FOR_DELETE_CONFIRM', {
    event_id: event.id,
    name: event.name,
    date: event.date,
    location: event.location,
    update_message: null,
  });
  await reply(
    ctx,
    [
      event.name,
      '',
      'Remove this event from your list? RSVP history will be kept.',
    ].join('\n'),
    [
      { title: 'Cancel', payload: `${KEEP_EVENT} ${event.id}` },
      { title: '🗑️ Delete', payload: `${CONFIRM_DELETE_EVENT} ${event.id}` },
    ],
  );
  return true;
}

async function finishDeleteEvent(ctx: CommandContext, event: Event): Promise<boolean> {
  const deleted = deleteEvent(event.id);
  clearConversationState(ctx.phone);
  if (!deleted) {
    await denyAccess(ctx);
    return true;
  }

  await reply(
    ctx,
    [
      '✅ Event deleted.',
      '',
      'The event has been removed from your My Events list.',
    ].join('\n'),
    [{ title: '🏠 Main Menu', payload: 'HOME' }],
  );
  return true;
}

function recipientDisplayName(row: {
  guest_name?: string | null;
  family_name?: string | null;
  invitation_type?: string | null;
  phone: string;
}): string {
  if (row.invitation_type === 'family' && row.family_name?.trim()) {
    return row.family_name.trim();
  }
  return organizerGuestDisplayName(row.guest_name, row.phone);
}

async function showUpdateStatus(
  ctx: CommandContext,
  updateId: number,
): Promise<boolean> {
  const update = getEventUpdateById(updateId);
  const event = update ? getEventById(update.event_id) : undefined;
  if (!update || !event || isEventDeleted(event) || !isEventOwner(event, ctx.phone)) {
    await denyAccess(ctx);
    return true;
  }

  const counts = getEventUpdateAckCounts(update.id);
  const lines = [formatUpdateStatusMessage(event.name, counts), ''];
  for (const row of listEventUpdateRecipients(update.id)) {
    if (row.send_status !== 'sent') {
      continue;
    }
    const name = recipientDisplayName(row);
    if (isWebGuestPhone(row.phone) || name.toLowerCase().startsWith('web:')) {
      continue;
    }
    lines.push(
      row.acknowledged_at
        ? `✅ ${name} — Acknowledged`
        : `⏳ ${name} — Awaiting`,
    );
  }

  await reply(ctx, lines.join('\n').trim(), ackStatusButtons(update.id));
  return true;
}

async function sendAckReminders(
  ctx: CommandContext,
  updateId: number,
): Promise<boolean> {
  const update = getEventUpdateById(updateId);
  const event = update ? getEventById(update.event_id) : undefined;
  if (!update || !event || isEventDeleted(event) || !isEventOwner(event, ctx.phone)) {
    await denyAccess(ctx);
    return true;
  }

  if (!update.acknowledgement_required) {
    await reply(ctx, 'This update does not require acknowledgement.', [
      manageEventButton(event.id),
    ]);
    return true;
  }

  if (isEventCancelled(event)) {
    await reply(
      ctx,
      'This event is cancelled, so acknowledgement reminders cannot be sent.',
      [manageEventButton(event.id)],
    );
    return true;
  }

  const outstanding = listUnacknowledgedSentRecipients(update.id);
  const latest = getEventById(event.id) ?? event;
  let reminded = 0;

  for (const row of outstanding) {
    const ackUrl = row.ack_token ? buildAckUpdateUrl(row.ack_token) : null;
    const body = formatAckUpdateMessage(latest, update.message, ackUrl);
    const session = getMessageSession(row.phone);
    try {
      await sendGuestNotice({
        phone: row.phone,
        conversationId: session?.conversation_id,
        accountId: session?.account_id || ctx.accountId,
        message: body,
        buttons: [guestViewRsvpButton(latest.id)],
        templateName: eventUpdateAckTemplateName(),
        event: latest,
        extra: ackUrl || update.message?.trim() || rsvpLinkForEvent(latest) || ' ',
      });
      markUpdateRecipientReminderSent(row.id);
      reminded += 1;
    } catch (error) {
      console.error(`Ack reminder failed for ${row.phone}:`, error);
    }
  }

  const counts = getEventUpdateAckCounts(update.id);
  await reply(
    ctx,
    [
      formatUpdateStatusMessage(latest.name, counts),
      '',
      reminded === 0
        ? 'No outstanding guests to remind.'
        : `Reminder sent to ${reminded} guest${reminded === 1 ? '' : 's'} still awaiting acknowledgement.`,
    ].join('\n'),
    ackStatusButtons(update.id),
  );
  return true;
}

export async function handleGuestUpdateCommand(
  ctx: CommandContext,
  input: string,
): Promise<boolean> {
  const trimmed = interactiveCommandInput({
    interactiveType: ctx.interactiveType,
    interactiveId: ctx.interactiveId,
    buttonPayload: ctx.buttonPayload,
    text: input?.trim() || ctx.text,
  });

  if (hasEventAction(trimmed, ACK_UPDATE)) {
    const updateId = parseIdSuffix(trimmed, ACK_UPDATE);
    if (updateId == null) {
      return false;
    }
    return recordGuestAcknowledgement(ctx, updateId);
  }

  if (hasEventAction(trimmed, VIEW_EVENT_RSVP)) {
    const eventId = parseIdSuffix(trimmed, VIEW_EVENT_RSVP);
    if (eventId == null) {
      return false;
    }
    const event = getEventById(eventId);
    if (!event || isEventDeleted(event)) {
      await reply(ctx, "We couldn't find that event.");
      return true;
    }
    if (isEventCancelled(event)) {
      await reply(ctx, formatCancelGuestMessage(event));
      return true;
    }
    await reply(ctx, formatViewEventMessage(event));
    return true;
  }

  return false;
}

async function recordGuestAcknowledgement(
  ctx: CommandContext,
  updateId: number,
): Promise<boolean> {
  const update = getEventUpdateById(updateId);
  const event = update ? getEventById(update.event_id) : undefined;
  if (!update || !event || isEventDeleted(event) || !update.acknowledgement_required) {
    return false;
  }

  const result = acknowledgeUpdateRecipient(update.id, ctx.phone);
  if (!result.ok) {
    return false;
  }

  const latest = getEventById(event.id) ?? event;
  await reply(ctx, formatGuestAckThankYou(latest), [
    { title: '💌 Update RSVP', payload: `${VIEW_EVENT_RSVP} ${latest.id}` },
  ]);

  if (!result.already) {
    await maybeNotifyEveryoneAcknowledged(update, latest);
  }
  return true;
}

export async function notifyIfEveryoneAcknowledged(
  updateId: number,
): Promise<void> {
  const update = getEventUpdateById(updateId);
  const event = update ? getEventById(update.event_id) : undefined;
  if (!update || !event) {
    return;
  }
  await maybeNotifyEveryoneAcknowledged(update, event);
}

async function maybeNotifyEveryoneAcknowledged(
  update: EventUpdate,
  event: Event,
): Promise<void> {
  const counts = getEventUpdateAckCounts(update.id);
  if (counts.sent === 0 || counts.awaiting > 0) {
    return;
  }
  if (!claimOrganizerAllAckedNotified(update.id)) {
    return;
  }

  const session = getMessageSession(event.organizer_phone);
  if (!session) {
    console.warn(
      `No message session for organizer ${event.organizer_phone}; skipping all-acked notify`,
    );
    return;
  }

  try {
    await sendMessage({
      conversationId: session.conversation_id,
      accountId: session.account_id,
      message: formatEveryoneAcknowledgedMessage(event.name, counts.sent),
    });
  } catch (error) {
    console.error('Failed to notify organizer that everyone acknowledged:', error);
  }
}

export const EVENT_CANCELLED_GUEST_MESSAGE =
  '❌ Event Cancelled\n\nThis event has been cancelled by the organizer.';
