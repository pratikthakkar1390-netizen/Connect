import { buildRsvpWhatsAppLink, buildShortRsvpUrl, normalizePhone } from '../config.js';
import {
  clearConversationState,
  createFamilyInvitation,
  createInvitation,
  getConversationState,
  getEventById,
  getInvitationById,
  isEventCancelled,
  isEventDeleted,
  listEventsForOrganizer,
  listInvitationsForEvent,
  parsePositiveInteger,
  setConversationState,
  type ConversationState,
  type Event,
} from '../db/store.js';
import { sendInboxMessage, type InboxSendResult, type SendMessageParams } from '../zernio/client.js';
import {
  formatShareRsvpInvitation,
  INVITATION_FORWARD_INSTRUCTION,
} from './invitationMessage.js';
import type { CommandContext } from './organizer.js';
import { hasEventAction, parseEventActionId } from '../whatsapp/eventList.js';

const VIEW_RSVPS = 'VIEW_RSVPS';
const HOME = 'HOME';
const MY_EVENTS = 'MY_EVENTS';

export const START_INVITE = 'START_INVITE';
export const INVITE_INDIVIDUAL = 'INVITE_INDIVIDUAL';
export const INVITE_FAMILY = 'INVITE_FAMILY';
export const INVITE_GROUP = 'INVITE_GROUP';
export const INVITE_MORE = 'INVITE_MORE';
export const DONE_SENDING = 'DONE_SENDING';
export const ADD_GROUP_MEMBER = 'ADD_GROUP_MEMBER';
export const DONE_GROUP = 'DONE_GROUP';
export const FAMILY_LIMIT_PREFIX = 'FAMILY_LIMIT_';

export const AFTER_INVITE_SENT_MESSAGE = INVITATION_FORWARD_INSTRUCTION;

export const DONE_SENDING_MESSAGE = [
  '✅ All set!',
  '',
  'Your invitations have been sent.',
  '',
  'You can manage your event anytime from My Events.',
].join('\n');

const INVITE_FLOW_STATES = new Set([
  'WAITING_FOR_FAMILY_NAME',
  'WAITING_FOR_FAMILY_GUEST_LIMIT',
]);
const LEGACY_GROUP_STATES = new Set([
  'WAITING_FOR_GROUP_NAME',
  'WAITING_FOR_GROUP_MEMBER',
]);

export function isInviteFlowState(state?: string | null): boolean {
  return Boolean(
    state && (INVITE_FLOW_STATES.has(state) || LEGACY_GROUP_STATES.has(state)),
  );
}

export function isInviteCommand(input: string): boolean {
  const upper = input.trim().toUpperCase();
  return (
    hasEventAction(input, START_INVITE) ||
    hasEventAction(input, INVITE_INDIVIDUAL) ||
    hasEventAction(input, INVITE_FAMILY) ||
    hasEventAction(input, INVITE_GROUP) ||
    hasEventAction(input, INVITE_MORE) ||
    hasEventAction(input, DONE_SENDING) ||
    hasEventAction(input, ADD_GROUP_MEMBER) ||
    hasEventAction(input, DONE_GROUP) ||
    upper.startsWith(FAMILY_LIMIT_PREFIX)
  );
}

export function formatInviteTypePrompt(_eventName?: string): string {
  return [
    'Who would you like to invite?',
    '',
    '👤 Individual',
    'One reusable invitation link for your guests.',
    'Forward the same link to each person.',
    'Each person enters their own name and RSVP.',
    '',
    '👨‍👩‍👧‍👦 Family',
    'One invitation link for one family.',
    'Set the maximum number of guests who can attend.',
  ].join('\n');
}

export function inviteTypeButtons(
  eventId: number,
): Array<{ title: string; payload: string }> {
  return [
    { title: 'Individual', payload: `${INVITE_INDIVIDUAL} ${eventId}` },
    { title: 'Family', payload: `${INVITE_FAMILY} ${eventId}` },
  ];
}

export function afterInviteButtons(
  eventId: number,
): Array<{ title: string; payload: string }> {
  return [
    { title: '➕ Invite More', payload: `${INVITE_MORE} ${eventId}` },
    { title: '✅ Done Sending', payload: `${DONE_SENDING} ${eventId}` },
  ];
}

export function afterDoneSendingButtons(
  eventId: number,
): Array<{ title: string; payload: string }> {
  return [
    { title: '📊 View RSVPs', payload: `${VIEW_RSVPS} ${eventId}` },
    { title: '🏠 Main Menu', payload: HOME },
  ];
}

export function familyGuestLimitList(eventId: number) {
  return {
    button: 'Guest limit',
    sections: [
      {
        title: 'Max guests',
        rows: Array.from({ length: 10 }, (_, index) => {
          const n = index + 1;
          return {
            id: `${FAMILY_LIMIT_PREFIX}${n}_${eventId}`,
            title: n === 1 ? '1 guest' : `${n} guests`,
          };
        }),
      },
    ],
  };
}

export function parseFamilyLimitPayload(
  input: string,
): { maxGuests: number; eventId?: number } | null {
  const match = input
    .trim()
    .toUpperCase()
    .match(/^FAMILY_LIMIT_(\d+)(?:_(\d+))?$/);
  if (!match) {
    return null;
  }
  const maxGuests = parseInt(match[1], 10);
  const eventId = match[2] ? parseInt(match[2], 10) : undefined;
  if (!Number.isFinite(maxGuests) || maxGuests < 1) {
    return null;
  }
  return { maxGuests, eventId };
}

export function familyLimitExceededMessage(maxGuests: number): string {
  return `This invitation allows up to ${maxGuests} guest${maxGuests === 1 ? '' : 's'}. Please try a smaller number.`;
}

type InviteSendFn = (params: SendMessageParams) => Promise<void | InboxSendResult>;
let sendInviteMessage: InviteSendFn = sendInboxMessage;

/** Test-only seam so invite-wizard UX can be asserted without WhatsApp. */
export function setInviteMessageSender(send?: InviteSendFn): void {
  sendInviteMessage = send ?? sendInboxMessage;
}

async function reply(
  ctx: CommandContext,
  message: string,
  buttons?: Array<{ title: string; payload: string }>,
  list?: Parameters<typeof sendInboxMessage>[0]['list'],
): Promise<void> {
  await sendInviteMessage({
    conversationId: ctx.conversationId,
    accountId: ctx.accountId,
    message,
    buttons,
    list,
  });
}

function isEventOwner(event: Event, phone: string): boolean {
  return event.organizer_phone === normalizePhone(phone);
}

function parseIdSuffix(input: string, prefix: string): number | null {
  return parseEventActionId(input, prefix);
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
  if (!event || !isEventOwner(event, ctx.phone)) {
    await denyAccess(ctx);
    return null;
  }
  return event;
}

async function rejectCancelledInvite(
  ctx: CommandContext,
  event: Event,
): Promise<boolean> {
  if (isEventDeleted(event)) {
    clearConversationState(ctx.phone);
    await reply(
      ctx,
      'This event has been deleted, so new invitations cannot be sent.',
    );
    return true;
  }
  if (!isEventCancelled(event)) {
    return false;
  }
  clearConversationState(ctx.phone);
  await reply(
    ctx,
    'This event is cancelled, so new invitations cannot be sent.',
  );
  return true;
}

export async function showInviteTypePicker(
  ctx: CommandContext,
  event: Event,
): Promise<void> {
  if (await rejectCancelledInvite(ctx, event)) {
    return;
  }
  clearConversationState(ctx.phone);
  await reply(
    ctx,
    formatInviteTypePrompt(event.name),
    inviteTypeButtons(event.id),
  );
}

async function sendEventInvitation(
  ctx: CommandContext,
  event: Event,
  rsvpCode = event.rsvp_code,
  shortCode = event.short_code,
): Promise<void> {
  if (await rejectCancelledInvite(ctx, event)) {
    return;
  }
  const link = shortCode
    ? buildShortRsvpUrl(shortCode)
    : buildRsvpWhatsAppLink(rsvpCode);
  await reply(ctx, formatShareRsvpInvitation(event, link, rsvpCode));
  await reply(ctx, INVITATION_FORWARD_INSTRUCTION, afterInviteButtons(event.id));
}

async function sendReusableIndividualInvite(
  ctx: CommandContext,
  event: Event,
): Promise<void> {
  if (await rejectCancelledInvite(ctx, event)) {
    return;
  }
  const link = event.short_code
    ? buildShortRsvpUrl(event.short_code)
    : buildRsvpWhatsAppLink(event.rsvp_code);
  await reply(
    ctx,
    `Use the same Individual invitation link:\n${link}`,
    afterInviteButtons(event.id),
  );
}

async function handleIndividualInvite(
  ctx: CommandContext,
  event: Event,
): Promise<void> {
  if (await rejectCancelledInvite(ctx, event)) {
    return;
  }
  const existing = listInvitationsForEvent(event.id).find(
    (row) => row.type === 'individual',
  );
  if (!existing) {
    createInvitation({ eventId: event.id, type: 'individual' });
    clearConversationState(ctx.phone);
    await sendEventInvitation(ctx, event);
    return;
  }
  clearConversationState(ctx.phone);
  await sendReusableIndividualInvite(ctx, event);
}

async function startFamilyInvite(
  ctx: CommandContext,
  event: Event,
): Promise<void> {
  if (await rejectCancelledInvite(ctx, event)) {
    return;
  }
  setConversationState(ctx.phone, 'WAITING_FOR_FAMILY_NAME', {
    event_id: event.id,
    invite_type: 'family',
    family_name: null,
    max_guests: null,
    invitation_id: null,
  });
  await reply(ctx, 'Which family are you inviting?\n\nExample: Patel Family');
}

async function redirectLegacyGroupInvite(
  ctx: CommandContext,
  event: Event,
): Promise<void> {
  clearConversationState(ctx.phone);
  await showInviteTypePicker(ctx, event);
}

export async function handleInviteCommand(
  ctx: CommandContext,
  input: string,
): Promise<boolean> {
  const trimmed = input.trim();
  const upper = trimmed.toUpperCase();

  if (upper === START_INVITE) {
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
      await showInviteTypePicker(ctx, events[0]);
      return true;
    }
    await reply(
      ctx,
      'Pick an event first, then choose how to invite people.',
      [{ title: 'My Events', payload: MY_EVENTS }],
    );
    return true;
  }

  if (hasEventAction(trimmed, START_INVITE) || hasEventAction(trimmed, INVITE_MORE)) {
    const prefix = hasEventAction(trimmed, INVITE_MORE) ? INVITE_MORE : START_INVITE;
    const event = await requireOwnedEvent(ctx, parseIdSuffix(trimmed, prefix));
    if (!event) {
      return true;
    }
    await showInviteTypePicker(ctx, event);
    return true;
  }

  if (hasEventAction(trimmed, DONE_SENDING)) {
    clearConversationState(ctx.phone);
    const event = await requireOwnedEvent(ctx, parseIdSuffix(trimmed, DONE_SENDING));
    if (!event) {
      return true;
    }
    await reply(ctx, DONE_SENDING_MESSAGE, afterDoneSendingButtons(event.id));
    return true;
  }

  if (hasEventAction(trimmed, INVITE_INDIVIDUAL)) {
    const event = await requireOwnedEvent(
      ctx,
      parseIdSuffix(trimmed, INVITE_INDIVIDUAL),
    );
    if (!event) {
      return true;
    }
    await handleIndividualInvite(ctx, event);
    return true;
  }

  if (hasEventAction(trimmed, INVITE_FAMILY)) {
    const event = await requireOwnedEvent(
      ctx,
      parseIdSuffix(trimmed, INVITE_FAMILY),
    );
    if (!event) {
      return true;
    }
    await startFamilyInvite(ctx, event);
    return true;
  }

  if (hasEventAction(trimmed, INVITE_GROUP)) {
    const event = await requireOwnedEvent(
      ctx,
      parseIdSuffix(trimmed, INVITE_GROUP),
    );
    if (!event) {
      return true;
    }
    await showInviteTypePicker(ctx, event);
    return true;
  }

  if (hasEventAction(trimmed, ADD_GROUP_MEMBER) || hasEventAction(trimmed, DONE_GROUP)) {
    const prefix = hasEventAction(trimmed, ADD_GROUP_MEMBER)
      ? ADD_GROUP_MEMBER
      : DONE_GROUP;
    const invitationId = parseIdSuffix(trimmed, prefix);
    const invitation =
      invitationId != null ? getInvitationById(invitationId) : undefined;
    const event = invitation ? getEventById(invitation.event_id) : undefined;
    if (!invitation || !event || !isEventOwner(event, ctx.phone)) {
      await denyAccess(ctx);
      return true;
    }
    await redirectLegacyGroupInvite(ctx, event);
    return true;
  }

  return continueInviteFlow(ctx, trimmed);
}

export async function continueInviteFlow(
  ctx: CommandContext,
  input: string,
): Promise<boolean> {
  const state = getConversationState(ctx.phone);
  if (!state || !isInviteFlowState(state.state)) {
    return false;
  }

  const event = state.event_id != null ? getEventById(state.event_id) : undefined;
  if (!event) {
    clearConversationState(ctx.phone);
    await denyAccess(ctx);
    return true;
  }
  if (await rejectCancelledInvite(ctx, event)) {
    return true;
  }

  const { isGreeting } = await import('./welcome.js');
  if (isGreeting(input)) {
    return false;
  }

  switch (state.state) {
    case 'WAITING_FOR_FAMILY_NAME':
      return handleFamilyName(ctx, event, input);
    case 'WAITING_FOR_FAMILY_GUEST_LIMIT':
      return handleFamilyGuestLimit(ctx, state, input);
    case 'WAITING_FOR_GROUP_NAME':
    case 'WAITING_FOR_GROUP_MEMBER':
      await redirectLegacyGroupInvite(ctx, event);
      return true;
    default:
      return false;
  }
}

async function handleFamilyName(
  ctx: CommandContext,
  event: Event,
  input: string,
): Promise<boolean> {
  const familyName = input.trim();
  if (!familyName) {
    await reply(ctx, 'Which family are you inviting?\n\nExample: Patel Family');
    return true;
  }

  setConversationState(ctx.phone, 'WAITING_FOR_FAMILY_GUEST_LIMIT', {
    event_id: event.id,
    invite_type: 'family',
    family_name: familyName,
  });
  await reply(
    ctx,
    `How many guests can attend from *${familyName}*?\n\nChoose a limit or reply with a number.`,
    undefined,
    familyGuestLimitList(event.id),
  );
  return true;
}

async function handleFamilyGuestLimit(
  ctx: CommandContext,
  state: ConversationState,
  input: string,
): Promise<boolean> {
  const event = state.event_id != null ? getEventById(state.event_id) : undefined;
  if (!event) {
    clearConversationState(ctx.phone);
    await denyAccess(ctx);
    return true;
  }

  const fromPayload = parseFamilyLimitPayload(input);
  const maxGuests = fromPayload?.maxGuests ?? parsePositiveInteger(input);
  if (!maxGuests) {
    await reply(
      ctx,
      'How many guests can attend? Choose a limit or reply with a number (1 or more).',
      undefined,
      familyGuestLimitList(event.id),
    );
    return true;
  }

  const familyName = state.family_name?.trim();
  if (!familyName) {
    setConversationState(ctx.phone, 'WAITING_FOR_FAMILY_NAME', {
      event_id: event.id,
      invite_type: 'family',
    });
    await reply(ctx, 'Which family are you inviting?\n\nExample: Patel Family');
    return true;
  }

  const invitation = createFamilyInvitation(event.id, familyName, maxGuests);
  clearConversationState(ctx.phone);
  await sendEventInvitation(
    ctx,
    event,
    invitation.rsvp_code ?? event.rsvp_code,
    invitation.short_code ?? event.short_code,
  );
  return true;
}
