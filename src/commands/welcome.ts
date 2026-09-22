import { buildRsvpWhatsAppLink, buildShortRsvpUrl, normalizePhone } from '../config.js';
import { formatEventTimezoneLine } from '../dates/eventDate.js';
import { themeLabel } from '../events/theme.js';
import {
  clearConversationState,
  findEventByRsvpCode,
  getConversationState,
  getEventById,
  getEventGuests,
  getRsvpSummary,
  isEventDeleted,
  listEventsForOrganizer,
  listInvitationsForEvent,
  listInvitationsWithMembers,
  listRsvpsForEvent,
  countKnownAwaitingRecipients,
  type Event,
} from '../db/store.js';
import {
  sendInboxMessage,
  type InboxListSection,
  type InboxSendResult,
  type SendMessageParams,
} from '../zernio/client.js';
import {
  continueCreateEventFlow,
  formatReminderDays,
  startCreateEventFlow,
} from './createEventFlow.js';
import { myEventsPageUrl } from '../http/myEventsToken.js';
import {
  GUEST_LIST,
  buildGuestListReply,
  formatGuestDetailsMessage,
  getGuestListEntry,
  loadOwnedEventForGuestList,
  parseGuestDetailAction,
} from './guestList.js';
import {
  handleSaveConnectContact,
  isSaveConnectContactCommand,
} from './saveContact.js';
import {
  formatRsvpStatusMessage,
  VIEW_RSVPS,
  type CommandContext,
} from './organizer.js';
import {
  buildEventSelectList,
  eventButtonPayload,
  eventListRowId,
  hasEventAction,
  interactiveCommandInput,
  matchEventAction,
  parseEventActionId,
  WHATSAPP_LIST_MAX_ROWS,
} from '../whatsapp/eventList.js';

export const MY_EVENTS = 'MY_EVENTS';
export const SELECT_EVENT = 'SELECT_EVENT';
export const MANAGE_EVENT = 'MANAGE_EVENT';
export const EVENT_DETAILS = 'EVENT_DETAILS';
export const MORE_EVENT = 'MORE_EVENT';
export const SHARE_RSVP = 'SHARE_RSVP';
export const HOME = 'HOME';
/** @deprecated Old View Options lobby; still accepted as an alias for HOME. */
export const VIEW_OPTIONS = 'VIEW_OPTIONS';

const WELCOME_BODY = `Moments to Memory

Create events, invite guests, and manage RSVPs — simply through WhatsApp.`;

const GREETINGS = new Set([
  'HI',
  'HELLO',
  'HEY',
  'START',
  'GOOD MORNING',
  'GOOD EVENING',
]);

const ORGANIZER_WIZARD_STATES = new Set([
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
  'WAITING_FOR_FAMILY_NAME',
  'WAITING_FOR_FAMILY_GUEST_LIMIT',
  'WAITING_FOR_GROUP_NAME',
  'WAITING_FOR_GROUP_MEMBER',
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

const WHATSAPP_INTERACTIVE_BODY_LIMIT = 1024;

export const HOME_BUTTONS = [
  { title: '➕ Create Event', payload: 'CREATE_EVENT' },
  { title: '📅 My Events', payload: MY_EVENTS },
  { title: '❓ Help', payload: 'HELP' },
];

const CUSTOMER_HELP_TEXT = `*CONNECT Help*

Create and share events, then track RSVPs right here.

Tap a button below to get started.`;

export function isGreeting(text: string): boolean {
  return GREETINGS.has(text.trim().toUpperCase());
}

export function isOrganizerWizardState(state?: string | null): boolean {
  return Boolean(state && ORGANIZER_WIZARD_STATES.has(state));
}

/** Pause create-event / invite / vendor wizard routing without deleting saved records. */
export function pauseOrganizerWizard(phone: string): void {
  const existing = getConversationState(phone);
  if (
    existing &&
    (isOrganizerWizardState(existing.state) ||
      existing.state.startsWith('VENDOR_'))
  ) {
    clearConversationState(phone);
  }
}

/** CONNECT Welcome after a greeting or a stale Vendor list tap. Does not recreate Vendor state. */
export async function routeToConnectWelcome(ctx: CommandContext): Promise<void> {
  pauseOrganizerWizard(ctx.phone);
  await sendWelcome(ctx);
}

type CustomerSendFn = (
  params: SendMessageParams,
) => Promise<void | InboxSendResult>;
let sendCustomerMessage: CustomerSendFn = sendInboxMessage;

/** Test-only seam so greeting / welcome routing can be asserted without WhatsApp. */
export function setCustomerMessageSender(send?: CustomerSendFn): void {
  sendCustomerMessage = send ?? sendInboxMessage;
}

export function getFirstNameFromDisplayName(displayName?: string): string | undefined {
  const trimmed = displayName?.trim();
  if (!trimmed) {
    return undefined;
  }

  const firstToken = trimmed.split(/\s+/)[0];
  return firstToken || undefined;
}

export function buildWelcomeMessage(_senderName?: string): string {
  return `Welcome to CONNECT! 👋\n\n${WELCOME_BODY}`;
}

function isEventOwner(event: Event, phone: string): boolean {
  return event.organizer_phone === normalizePhone(phone);
}

export interface InboxReply {
  message: string;
  buttons?: Array<{ title: string; payload: string }>;
  list?: {
    button: string;
    sections: InboxListSection[];
  };
}

export interface EventInviteStats {
  invitationsSent: number;
  yes: number;
  no: number;
  maybe: number;
  awaiting: number;
}

async function reply(
  ctx: CommandContext,
  message: string,
  buttons?: Array<{ title: string; payload: string }>,
  list?: InboxReply['list'],
): Promise<void> {
  await sendCustomerMessage({
    conversationId: ctx.conversationId,
    accountId: ctx.accountId,
    message,
    buttons,
    list,
  });
}

async function sendReplies(ctx: CommandContext, replies: InboxReply[]): Promise<void> {
  for (const item of replies) {
    await reply(ctx, item.message, item.buttons, item.list);
  }
}

async function denyAccess(ctx: CommandContext): Promise<void> {
  await reply(
    ctx,
    "That event wasn't found or you don't have access.",
  );
}

export function isMyEventsCommand(input: string): boolean {
  return input.trim().toUpperCase().replace(/\s+/g, '_') === MY_EVENTS;
}

export function isHomeCommand(input: string): boolean {
  const upper = input.trim().toUpperCase().replace(/\s+/g, '_');
  return upper === HOME;
}

function isViewOptionsPayload(input: string): boolean {
  return input.trim().toUpperCase().replace(/\s+/g, '_') === VIEW_OPTIONS;
}

export function getEventInviteStats(eventId: number): EventInviteStats {
  const invitations = listInvitationsForEvent(eventId);
  const invitationsSent = invitations.length;
  const summary = getRsvpSummary(eventId);
  const guests = getEventGuests(eventId);
  const rsvps = listRsvpsForEvent(eventId);
  const event = getEventById(eventId);
  return {
    invitationsSent,
    yes: summary.yes,
    no: summary.no,
    maybe: summary.maybe,
    awaiting: countKnownAwaitingRecipients({
      organizerPhone: event?.organizer_phone ?? '',
      guests,
      rsvps,
      invitations,
    }),
  };
}

export function formatEventInviteCard(event: Event): string {
  const stats = getEventInviteStats(event.id);
  const lines = [
    `📅 ${event.name}`,
    event.date,
    formatEventTimezoneLine(event.timezone),
    `📍 ${event.location}`,
  ];
  if (event.cancelled_at) {
    lines.push('❌ Event cancelled');
  }
  lines.push(
    '',
    `📩 Invitations sent: ${stats.invitationsSent}`,
    `✅ Yes: ${stats.yes}`,
    `❌ No: ${stats.no}`,
    `❓ Maybe: ${stats.maybe}`,
    `⏳ Awaiting response: ${stats.awaiting}`,
  );
  return lines.join('\n');
}

export function formatEventDetailsMessage(event: Event): string {
  const extra: string[] = [];
  if (event.rsvp_deadline?.trim()) {
    extra.push(`⏰ RSVP deadline: ${event.rsvp_deadline}`);
  }
  extra.push(
    event.children_allowed === 0 ? 'Children: Adults only' : 'Children: Allowed',
  );
  if (event.theme === 'custom' && event.custom_theme?.trim()) {
    extra.push(`🎨 Event Style: ${event.custom_theme.trim()}`);
  } else {
    const label = themeLabel(event.theme);
    if (label) {
      extra.push(`🎨 Event Style: ${label}`);
    }
  }
  if (event.dress_code?.trim()) {
    extra.push(`👗 What to Wear: ${event.dress_code.trim()}`);
  }
  if (event.reminder_days != null) {
    extra.push(`Reminder: ${formatReminderDays(event.reminder_days)}`);
  }
  return extra.length > 0
    ? `${formatEventInviteCard(event)}\n\n${extra.join('\n')}`
    : formatEventInviteCard(event);
}

export function manageEventButtons(
  event: Event,
): Array<{ title: string; payload: string }> {
  return [
    { title: '📩 Invite', payload: eventButtonPayload('START_INVITE', event.id) },
    { title: '👥 RSVPs', payload: eventButtonPayload(VIEW_RSVPS, event.id) },
    { title: 'More…', payload: eventButtonPayload(MORE_EVENT, event.id) },
  ];
}

export function manageEventMoreList(event: Event): NonNullable<InboxReply['list']> {
  return {
    button: 'More',
    sections: [
      {
        title: 'Manage',
        rows: [
          {
            id: eventListRowId(GUEST_LIST, event.id),
            title: '👥 Guest List',
          },
          {
            id: eventListRowId('EDIT_EVENT', event.id),
            title: '✏️ Edit Event',
          },
          {
            id: eventListRowId('SEND_UPDATE', event.id),
            title: '📢 Send Update',
          },
          {
            id: eventListRowId('VOID_EVENT', event.id),
            title: '❌ Cancel Event',
          },
          {
            id: eventListRowId('DELETE_EVENT', event.id),
            title: '🗑️ Delete Event',
          },
        ],
      },
    ],
  };
}

export function buildManageEventReply(event: Event): InboxReply {
  return {
    message: formatEventDetailsMessage(event),
    buttons: manageEventButtons(event),
  };
}

export function buildManageEventMoreReply(event: Event): InboxReply {
  return {
    message: `More options for *${event.name}*:`,
    list: manageEventMoreList(event),
  };
}

export function buildMyEventsReply(events: Event[]): InboxReply[] {
  if (events.length === 0) {
    return [];
  }

  if (events.length === 1) {
    return [
      {
        message: formatEventInviteCard(events[0]),
        buttons: [
          {
            title: 'Manage Event',
            payload: eventButtonPayload(MANAGE_EVENT, events[0].id),
          },
        ],
      },
    ];
  }

  const cards = events.map((event) => formatEventInviteCard(event)).join('\n\n');
  const list = buildEventSelectList(events, MANAGE_EVENT, {
    button: 'Manage Event',
    sectionTitle: 'Your events',
  });

  if (events.length > WHATSAPP_LIST_MAX_ROWS) {
    const notice = `\n\nShowing ${WHATSAPP_LIST_MAX_ROWS} events. Open the web link below to see all of them.`;
    const body = `${cards}${notice}`;
    if (body.length <= WHATSAPP_INTERACTIVE_BODY_LIMIT) {
      return [{ message: body, list }];
    }
    return [
      { message: `${cards}${notice}` },
      { message: 'Select an event to manage:', list },
    ];
  }

  if (cards.length <= WHATSAPP_INTERACTIVE_BODY_LIMIT) {
    return [{ message: cards, list }];
  }

  return [
    { message: cards },
    { message: 'Select an event to manage:', list },
  ];
}

export function buildBulkDeleteEventsReply(phone: string): InboxReply {
  return {
    message: `Select events to delete:\n${myEventsPageUrl(phone)}`,
  };
}

async function sendCustomerHelp(ctx: CommandContext): Promise<void> {
  await reply(ctx, CUSTOMER_HELP_TEXT, HOME_BUTTONS);
}

async function sendWelcome(ctx: CommandContext): Promise<void> {
  await reply(ctx, buildWelcomeMessage(ctx.senderName), HOME_BUTTONS);
}

async function sendHome(ctx: CommandContext): Promise<void> {
  await reply(ctx, 'What would you like to do?', HOME_BUTTONS);
}

async function sendCreatePrompt(ctx: CommandContext): Promise<void> {
  await reply(
    ctx,
    "You don't have any events yet. Tap below to create your first one!",
    [{ title: 'Create an Event', payload: 'CREATE_EVENT' }],
  );
}

async function handleMyEvents(ctx: CommandContext): Promise<void> {
  const events = listEventsForOrganizer(ctx.phone);

  if (events.length === 0) {
    await sendCreatePrompt(ctx);
    return;
  }

  const replies = [...buildMyEventsReply(events)];
  if (events.length > 1) {
    replies.push(buildBulkDeleteEventsReply(ctx.phone));
  }
  await sendReplies(ctx, replies);
}

async function handleManageEvent(ctx: CommandContext, eventId?: number): Promise<void> {
  if (eventId === undefined) {
    const events = listEventsForOrganizer(ctx.phone);
    if (events.length === 0) {
      await sendCreatePrompt(ctx);
      return;
    }
    if (events.length === 1) {
      await sendReplies(ctx, [buildManageEventReply(events[0])]);
      return;
    }
    await sendReplies(ctx, buildMyEventsReply(events));
    return;
  }

  const event = getEventById(eventId);
  if (!event || !isEventOwner(event, ctx.phone) || isEventDeleted(event)) {
    await denyAccess(ctx);
    return;
  }

  await sendReplies(ctx, [buildManageEventReply(event)]);
}

async function handleGuestList(ctx: CommandContext, eventId?: number): Promise<void> {
  if (eventId === undefined) {
    const events = listEventsForOrganizer(ctx.phone);
    if (events.length === 0) {
      await sendCreatePrompt(ctx);
      return;
    }
    if (events.length === 1) {
      await sendReplies(ctx, [buildGuestListReply(events[0], ctx.phone)]);
      return;
    }
    await sendReplies(ctx, buildMyEventsReply(events));
    return;
  }

  const event = loadOwnedEventForGuestList(eventId, ctx.phone);
  if (!event) {
    await denyAccess(ctx);
    return;
  }

  await sendReplies(ctx, [buildGuestListReply(event, ctx.phone)]);
}

async function handleGuestDetail(
  ctx: CommandContext,
  eventId: number,
  guestId: number,
): Promise<void> {
  const event = loadOwnedEventForGuestList(eventId, ctx.phone);
  if (!event) {
    await denyAccess(ctx);
    return;
  }
  const entry = getGuestListEntry(event.id, guestId);
  if (!entry) {
    await reply(ctx, 'That guest was not found on this event.');
    return;
  }
  await reply(ctx, formatGuestDetailsMessage(entry));
}

async function handleMoreEvent(ctx: CommandContext, eventId: number): Promise<void> {
  const event = getEventById(eventId);
  if (!event || !isEventOwner(event, ctx.phone) || isEventDeleted(event)) {
    await denyAccess(ctx);
    return;
  }

  await sendReplies(ctx, [buildManageEventMoreReply(event)]);
}

async function handleEventDetails(ctx: CommandContext, eventId: number): Promise<void> {
  const event = getEventById(eventId);
  if (!event || !isEventOwner(event, ctx.phone) || isEventDeleted(event)) {
    await denyAccess(ctx);
    return;
  }

  await sendReplies(ctx, [buildManageEventReply(event)]);
}

async function handleViewRsvps(ctx: CommandContext, eventId?: number): Promise<void> {
  if (eventId !== undefined) {
    const event = getEventById(eventId);
    if (!event || !isEventOwner(event, ctx.phone) || isEventDeleted(event)) {
      await denyAccess(ctx);
      return;
    }

    const summary = getRsvpSummary(event.id);
    const guests = getEventGuests(event.id);
    const rsvps = listRsvpsForEvent(event.id);
    await reply(
      ctx,
      formatRsvpStatusMessage(
        event,
        summary,
        guests,
        rsvps,
        listInvitationsWithMembers(event.id),
      ),
    );
    return;
  }

  const events = listEventsForOrganizer(ctx.phone);
  if (events.length === 0) {
    await sendCreatePrompt(ctx);
    return;
  }

  if (events.length === 1) {
    await handleViewRsvps(ctx, events[0].id);
    return;
  }

  const lines = [
    '*Pick an event to view RSVPs:*',
    ...events.map((event) => `• *${event.name}* — ${event.date}`),
  ];

  if (events.length > WHATSAPP_LIST_MAX_ROWS) {
    lines.push(
      '',
      `Showing ${WHATSAPP_LIST_MAX_ROWS} events. Open My Events on the web to view the rest:`,
      myEventsPageUrl(ctx.phone),
    );
  }

  await reply(
    ctx,
    lines.join('\n'),
    undefined,
    buildEventSelectList(events, VIEW_RSVPS, {
      button: 'View RSVPs',
      sectionTitle: 'Your events',
    }),
  );
}

import {
  formatShareRsvpInvitation,
  sendInvitationWithForwardInstruction,
} from './invitationMessage.js';

export {
  formatShareRsvpInvitation,
  INVITATION_FORWARD_INSTRUCTION,
  sendInvitationWithForwardInstruction,
} from './invitationMessage.js';

async function handleShareRsvp(ctx: CommandContext, code?: string): Promise<void> {
  let event: Event | undefined;

  if (code) {
    event = findEventByRsvpCode(code);
    if (!event || !isEventOwner(event, ctx.phone) || isEventDeleted(event)) {
      await denyAccess(ctx);
      return;
    }
  } else {
    const events = listEventsForOrganizer(ctx.phone);
    if (events.length === 0) {
      await sendCreatePrompt(ctx);
      return;
    }
    if (events.length === 1) {
      event = events[0];
    } else {
      await handleMyEvents(ctx);
      return;
    }
  }

  const link = event.short_code
    ? buildShortRsvpUrl(event.short_code)
    : buildRsvpWhatsAppLink(event.rsvp_code);
  await sendInvitationWithForwardInstruction(
    (message) => reply(ctx, message),
    formatShareRsvpInvitation(event, link),
  );
}

function isButtonCallback(ctx: CommandContext): boolean {
  return (
    ctx.interactiveType === 'button_reply' ||
    ctx.interactiveType === 'list_reply' ||
    Boolean(ctx.interactiveId?.trim()) ||
    Boolean(ctx.buttonPayload?.trim())
  );
}

export async function handleCustomerCommand(
  ctx: CommandContext,
): Promise<boolean> {
  const input = interactiveCommandInput(ctx);
  const trimmed = input.trim();
  const upper = trimmed.toUpperCase();

  if (
    !isButtonCallback(ctx) &&
    (isGreeting(ctx.text) || isGreeting(trimmed))
  ) {
    await routeToConnectWelcome(ctx);
    return true;
  }

  const {
    handleVendorCommand,
    isVendorCommand,
    isVendorConversationState,
    isVendorEntryText,
    shouldHandleVendor,
  } = await import('../vendors/flow.js');
  if (
    !isVendorEntryText(trimmed) &&
    !isVendorEntryText(ctx.text) &&
    !isVendorConversationState(getConversationState(ctx.phone)?.state) &&
    (isVendorCommand(trimmed) || isVendorCommand(ctx.text))
  ) {
    await routeToConnectWelcome(ctx);
    return true;
  }

  if (
    shouldHandleVendor(ctx.phone, trimmed) ||
    shouldHandleVendor(ctx.phone, ctx.text)
  ) {
    return handleVendorCommand(ctx);
  }

  if (upper === 'CREATE_EVENT') {
    await startCreateEventFlow(ctx);
    return true;
  }

  if (upper === 'HELP' || upper === '?') {
    await sendCustomerHelp(ctx);
    return true;
  }

  if (isHomeCommand(trimmed) || (isButtonCallback(ctx) && isViewOptionsPayload(trimmed))) {
    await sendHome(ctx);
    return true;
  }

  if (isSaveConnectContactCommand(trimmed)) {
    await handleSaveConnectContact(ctx);
    return true;
  }

  if (isMyEventsCommand(trimmed)) {
    await handleMyEvents(ctx);
    return true;
  }

  if (hasEventAction(trimmed, MANAGE_EVENT) || hasEventAction(trimmed, SELECT_EVENT)) {
    const action = hasEventAction(trimmed, SELECT_EVENT) ? SELECT_EVENT : MANAGE_EVENT;
    const selected = matchEventAction(trimmed, action);
    if (selected.invalidSuffix) {
      await denyAccess(ctx);
      return true;
    }
    await handleManageEvent(ctx, selected.eventId);
    return true;
  }

  if (isButtonCallback(ctx) && hasEventAction(trimmed, EVENT_DETAILS)) {
    const eventId = parseEventActionId(trimmed, EVENT_DETAILS);
    if (eventId == null) {
      await denyAccess(ctx);
      return true;
    }
    await handleEventDetails(ctx, eventId);
    return true;
  }

  if (hasEventAction(trimmed, GUEST_LIST)) {
    const selected = matchEventAction(trimmed, GUEST_LIST);
    if (selected.invalidSuffix) {
      await denyAccess(ctx);
      return true;
    }
    await handleGuestList(ctx, selected.eventId);
    return true;
  }

  const guestDetail = parseGuestDetailAction(trimmed);
  if (guestDetail) {
    await handleGuestDetail(ctx, guestDetail.eventId, guestDetail.guestId);
    return true;
  }

  if (hasEventAction(trimmed, MORE_EVENT)) {
    const eventId = parseEventActionId(trimmed, MORE_EVENT);
    if (eventId == null) {
      await denyAccess(ctx);
      return true;
    }
    await handleMoreEvent(ctx, eventId);
    return true;
  }

  if (hasEventAction(trimmed, VIEW_RSVPS)) {
    const selected = matchEventAction(trimmed, VIEW_RSVPS);
    if (selected.invalidSuffix) {
      await denyAccess(ctx);
      return true;
    }
    await handleViewRsvps(ctx, selected.eventId);
    return true;
  }

  if (isButtonCallback(ctx) && upper.startsWith(`${SHARE_RSVP} `)) {
    const code = trimmed.slice(SHARE_RSVP.length + 1).trim();
    if (!code) {
      await handleShareRsvp(ctx);
      return true;
    }
    await handleShareRsvp(ctx, code);
    return true;
  }

  if (isButtonCallback(ctx) && upper === SHARE_RSVP) {
    await handleShareRsvp(ctx);
    return true;
  }

  if (upper.startsWith('START_INVITE') || upper.startsWith('INVITE_') || upper.startsWith('ADD_GROUP_MEMBER') || upper.startsWith('DONE_GROUP') || upper.startsWith('DONE_SENDING') || upper.startsWith('FAMILY_LIMIT_')) {
    const { handleInviteCommand, isInviteCommand } = await import('./inviteFlow.js');
    if (isInviteCommand(trimmed) || upper.startsWith('FAMILY_LIMIT_')) {
      return handleInviteCommand(ctx, trimmed);
    }
  }

  {
    const {
      handleEventUpdateCommand,
      isEventUpdateCommand,
    } = await import('./eventUpdateFlow.js');
    if (isEventUpdateCommand(trimmed)) {
      return handleEventUpdateCommand(ctx, trimmed);
    }
  }

  const existingState = getConversationState(ctx.phone);
  if (existingState) {
    const { isVendorConversationState } = await import('../vendors/flow.js');
    if (isVendorConversationState(existingState.state)) {
      return handleVendorCommand(ctx);
    }
    const { continueInviteFlow, isInviteFlowState } = await import('./inviteFlow.js');
    if (isInviteFlowState(existingState.state)) {
      return continueInviteFlow(ctx, trimmed);
    }
    const {
      continueEventUpdateFlow,
      isEventUpdateFlowState,
    } = await import('./eventUpdateFlow.js');
    if (isEventUpdateFlowState(existingState.state)) {
      return continueEventUpdateFlow(ctx, trimmed);
    }
    return continueCreateEventFlow(ctx, trimmed);
  }

  return false;
}
