import {
  addGuests,
  checkFamilyRsvpLimit,
  clearConversationState,
  findLatestPendingEventForGuest,
  getConversationState,
  getEventById,
  getGuest,
  getInvitationById,
  isEventCancelled,
  isEventDeleted,
  isRsvpDeadlinePassed,
  lookupRsvpLinkTarget,
  parsePositiveInteger,
  setConversationState,
  setGuestConversationId,
  setGuestName,
  markGuestThankYouSent,
  upsertRsvp,
  type Event,
  type Invitation,
  type RsvpStatus,
} from '../db/store.js';
import {
  EVENT_CANCELLED_GUEST_MESSAGE,
  handleGuestUpdateCommand,
  isGuestUpdateCommand,
} from '../commands/eventUpdateFlow.js';
import { familyLimitExceededMessage } from '../commands/inviteFlow.js';
import { sendInboxMessage, sendInteractiveInvite, type InboxSendResult, type SendMessageParams } from '../zernio/client.js';
import { GUEST_RSVP_THANK_YOU } from '../commands/saveContact.js';
import {
  notifyOrganizerOfRsvp,
  resolveGuestDisplayName,
} from './organizerNotify.js';
import {
  formatConfirmation,
  parseGuestCounts,
  parseInteractiveRsvp,
  parseRsvpLinkToken,
  parseTextRsvp,
  type ParsedRsvp,
} from './parser.js';

export interface RsvpMessageContext {
  phone: string;
  senderName?: string;
  text?: string;
  interactiveId?: string;
  buttonPayload?: string;
  interactiveType?: string;
  conversationId: string;
  accountId: string;
  rawReply: string;
}

const RSVP_CLOSED_MESSAGE =
  'RSVPs for this event are now closed. Contact the organizer if you need help.';
const RSVP_COUNTS_PROMPT =
  'How many adults? How many children? Reply like 2 and 0';
const RSVP_ADULTS_PROMPT =
  'How many adults will attend? Reply with a number (1 or more).';
const RSVP_CHILDREN_PROMPT =
  'How many children will attend? Reply with 0 if none.';

type SendFn = (params: SendMessageParams) => Promise<void | InboxSendResult>;
let sendRsvpMessage: SendFn = sendInboxMessage;

/** Test-only seam so RSVP UX can be asserted without WhatsApp. */
export function setRsvpMessageSender(send?: SendFn): void {
  sendRsvpMessage = send ?? sendInboxMessage;
}

async function sendRsvpConfirmation(
  ctx: RsvpMessageContext,
  event: Event,
  message: string,
): Promise<void> {
  const alreadyThanked = Boolean(getGuest(event.id, ctx.phone)?.thank_you_sent_at);
  const outbound = alreadyThanked
    ? message
    : `${message}\n\n${GUEST_RSVP_THANK_YOU}`;

  await sendRsvpMessage({
    conversationId: ctx.conversationId,
    accountId: ctx.accountId,
    message: outbound,
  });

  if (!alreadyThanked) {
    markGuestThankYouSent(event.id, ctx.phone);
  }
}

export async function sendGuestThankYouOnce(
  ctx: Pick<RsvpMessageContext, 'phone' | 'conversationId' | 'accountId'>,
  event: Event,
): Promise<boolean> {
  if (getGuest(event.id, ctx.phone)?.thank_you_sent_at) {
    return false;
  }

  await sendRsvpMessage({
    conversationId: ctx.conversationId,
    accountId: ctx.accountId,
    message: GUEST_RSVP_THANK_YOU,
  });
  return markGuestThankYouSent(event.id, ctx.phone);
}

function recordRsvpAndNotify(
  ctx: RsvpMessageContext,
  event: Event,
  status: RsvpStatus,
  guestCount: number,
  adults: number,
  children: number,
): void {
  upsertRsvp(
    event.id,
    ctx.phone,
    status,
    guestCount,
    ctx.rawReply,
    adults,
    children,
  );

  const total = status === 'yes' ? adults + children : 0;
  void notifyOrganizerOfRsvp({
    event,
    guestPhone: ctx.phone,
    guestName: resolveGuestDisplayName(event.id, ctx.phone, ctx.senderName),
    status,
    adults,
    children,
    total,
    accountId: ctx.accountId,
  }).catch((error) => {
    console.error('Failed to notify organizer of RSVP:', error);
  });
}

export function parseRsvpFromContext(ctx: RsvpMessageContext): ParsedRsvp | null {
  if (
    ctx.interactiveType === 'button_reply' ||
    ctx.interactiveType === 'list_reply' ||
    ctx.interactiveId ||
    ctx.buttonPayload
  ) {
    const fromInteractive = parseInteractiveRsvp(
      ctx.interactiveId,
      ctx.buttonPayload,
      ctx.text,
    );
    if (fromInteractive) {
      return fromInteractive;
    }
  }

  if (ctx.text) {
    return parseTextRsvp(ctx.text);
  }

  return null;
}

function isOrganizerCreateState(phone: string): boolean {
  const state = getConversationState(phone);
  if (!state) {
    return false;
  }
  if (state.state.startsWith('VENDOR_')) {
    return true;
  }
  return (
    state.state.startsWith('WAITING_FOR_EVENT') ||
    state.state === 'WAITING_FOR_INVITATION_COUNT' ||
    state.state === 'WAITING_FOR_ADD_DETAILS' ||
    state.state === 'WAITING_FOR_CUSTOM_THEME' ||
    state.state === 'WAITING_FOR_DRESS_CODE' ||
    state.state === 'WAITING_FOR_DRESS_CODE_TEXT' ||
    state.state === 'WAITING_FOR_RSVP_DEADLINE' ||
    state.state === 'WAITING_FOR_CHILDREN_POLICY' ||
    state.state === 'WAITING_FOR_REMINDER_SETTING' ||
    state.state === 'CONFIRMING_EVENT' ||
    state.state === 'WAITING_FOR_FAMILY_NAME' ||
    state.state === 'WAITING_FOR_FAMILY_GUEST_LIMIT' ||
    state.state === 'WAITING_FOR_GROUP_NAME' ||
    state.state === 'WAITING_FOR_GROUP_MEMBER' ||
    state.state.startsWith('WAITING_FOR_EDIT_') ||
    state.state === 'WAITING_FOR_EDIT_FIELD' ||
    state.state === 'WAITING_FOR_UPDATE_MESSAGE' ||
    state.state === 'WAITING_FOR_UPDATE_TYPE' ||
    state.state === 'WAITING_FOR_CANCEL_CONFIRM' ||
    state.state === 'WAITING_FOR_DELETE_CONFIRM'
  );
}

async function rejectIfCancelled(
  ctx: RsvpMessageContext,
  event: Event,
): Promise<string | null> {
  if (isEventDeleted(event)) {
    await sendRsvpMessage({
      conversationId: ctx.conversationId,
      accountId: ctx.accountId,
      message: "We couldn't find that event.",
    });
    return 'event_deleted';
  }
  if (!isEventCancelled(event)) {
    return null;
  }
  await sendRsvpMessage({
    conversationId: ctx.conversationId,
    accountId: ctx.accountId,
    message: EVENT_CANCELLED_GUEST_MESSAGE,
  });
  return 'event_cancelled';
}

function resolveFamilyInvitation(
  eventId: number,
  phone: string,
  conversationInvitationId?: number | null,
): Invitation | undefined {
  if (conversationInvitationId) {
    const invitation = getInvitationById(conversationInvitationId);
    if (invitation && invitation.event_id === eventId) {
      return invitation;
    }
  }
  const guest = getGuest(eventId, phone);
  if (guest?.invitation_id) {
    return getInvitationById(guest.invitation_id);
  }
  return undefined;
}

async function handleRsvpLink(
  ctx: RsvpMessageContext,
  token: string,
): Promise<string> {
  const target = lookupRsvpLinkTarget(token);
  if (!target) {
    await sendRsvpMessage({
      conversationId: ctx.conversationId,
      accountId: ctx.accountId,
      message:
        "We couldn't find an event for that RSVP link. Ask the organizer for a new one.",
    });
    return 'unknown_token';
  }

  const { event, invitation } = target;
  const cancelled = await rejectIfCancelled(ctx, event);
  if (cancelled) {
    return cancelled;
  }

  if (isRsvpDeadlinePassed(event.rsvp_deadline, { eventDate: event.date })) {
    await sendRsvpMessage({
      conversationId: ctx.conversationId,
      accountId: ctx.accountId,
      message: RSVP_CLOSED_MESSAGE,
    });
    return 'deadline_closed';
  }

  addGuests(event.id, [ctx.phone], invitation?.id ?? null);
  setGuestConversationId(event.id, ctx.phone, ctx.conversationId);
  if (ctx.senderName) {
    setGuestName(event.id, ctx.phone, ctx.senderName);
  }

  await sendInteractiveInvite({
    accountId: ctx.accountId,
    conversationId: ctx.conversationId,
    eventName: event.name,
    eventDate: event.date,
    eventLocation: event.location,
  });

  return 'rsvp_prompt';
}

async function continueGuestCountFlow(
  ctx: RsvpMessageContext,
  input: string,
): Promise<string | null> {
  const state = getConversationState(ctx.phone);
  if (!state?.event_id) {
    return null;
  }

  const event = getEventById(state.event_id);
  if (!event) {
    clearConversationState(ctx.phone);
    return null;
  }

  const cancelled = await rejectIfCancelled(ctx, event);
  if (cancelled) {
    clearConversationState(ctx.phone);
    return cancelled;
  }

  if (isRsvpDeadlinePassed(event.rsvp_deadline, { eventDate: event.date })) {
    clearConversationState(ctx.phone);
    await sendRsvpMessage({
      conversationId: ctx.conversationId,
      accountId: ctx.accountId,
      message: RSVP_CLOSED_MESSAGE,
    });
    return 'deadline_closed';
  }

  setGuestConversationId(event.id, ctx.phone, ctx.conversationId);

  if (state.state === 'WAITING_FOR_RSVP_COUNTS') {
    return finishYesCounts(ctx, event, input, state.invitation_id, true);
  }

  if (state.state === 'WAITING_FOR_RSVP_ADULTS') {
    const parsed = parseGuestCounts(input);
    if (event.children_allowed === 1 && parsed?.pair) {
      return finishYesCounts(ctx, event, input, state.invitation_id, true);
    }
    const adults = parsed?.adults ?? parsePositiveInteger(input);
    if (!adults) {
      await sendRsvpMessage({
        conversationId: ctx.conversationId,
        accountId: ctx.accountId,
        message: RSVP_ADULTS_PROMPT,
      });
      return 'awaiting_adults';
    }

    const familyInvitation = resolveFamilyInvitation(
      event.id,
      ctx.phone,
      state.invitation_id,
    );
    if (event.children_allowed === 1) {
      const adultLimit = checkFamilyRsvpLimit(familyInvitation, adults, 0);
      if (!adultLimit.allowed) {
        await sendRsvpMessage({
          conversationId: ctx.conversationId,
          accountId: ctx.accountId,
          message: familyLimitExceededMessage(adultLimit.maxGuests),
        });
        return 'family_limit';
      }
      setConversationState(ctx.phone, 'WAITING_FOR_RSVP_CHILDREN', {
        event_id: event.id,
        adult_count: adults,
        invitation_id: familyInvitation?.id ?? state.invitation_id ?? null,
      });
      await sendRsvpMessage({
        conversationId: ctx.conversationId,
        accountId: ctx.accountId,
        message: RSVP_CHILDREN_PROMPT,
      });
      return 'awaiting_children';
    }

    return recordYesAttendance(ctx, event, adults, 0, familyInvitation);
  }

  if (state.state === 'WAITING_FOR_RSVP_CHILDREN') {
    const trimmed = input.trim();
    const childMatch = trimmed.match(/^\d+$/);
    if (!childMatch) {
      await sendRsvpMessage({
        conversationId: ctx.conversationId,
        accountId: ctx.accountId,
        message: RSVP_CHILDREN_PROMPT,
      });
      return 'awaiting_children';
    }

    const children = parseInt(childMatch[0], 10);
    const adults = state.adult_count ?? 1;
    const familyInvitation = resolveFamilyInvitation(
      event.id,
      ctx.phone,
      state.invitation_id,
    );
    return recordYesAttendance(ctx, event, adults, children, familyInvitation);
  }

  return null;
}

async function finishYesCounts(
  ctx: RsvpMessageContext,
  event: Event,
  input: string,
  invitationId: number | null | undefined,
  requirePair: boolean,
): Promise<string> {
  const parsed = parseGuestCounts(input);
  if (!parsed || (requirePair && !parsed.pair && event.children_allowed === 1)) {
    await sendRsvpMessage({
      conversationId: ctx.conversationId,
      accountId: ctx.accountId,
      message: RSVP_COUNTS_PROMPT,
    });
    return 'awaiting_counts';
  }
  const children = event.children_allowed === 1 ? parsed.children : 0;
  const familyInvitation = resolveFamilyInvitation(
    event.id,
    ctx.phone,
    invitationId,
  );
  return recordYesAttendance(ctx, event, parsed.adults, children, familyInvitation);
}

async function recordYesAttendance(
  ctx: RsvpMessageContext,
  event: Event,
  adults: number,
  children: number,
  familyInvitation: Invitation | undefined,
): Promise<string> {
  const limit = checkFamilyRsvpLimit(familyInvitation, adults, children);
  if (!limit.allowed) {
    await sendRsvpMessage({
      conversationId: ctx.conversationId,
      accountId: ctx.accountId,
      message: familyLimitExceededMessage(limit.maxGuests),
    });
    return 'family_limit';
  }
  const total = adults + children;
  recordRsvpAndNotify(ctx, event, 'yes', total, adults, children);
  clearConversationState(ctx.phone);
  await sendRsvpConfirmation(
    ctx,
    event,
    formatConfirmation(event.name, event.date, 'yes', total, adults, children),
  );
  return 'rsvp_recorded';
}

async function handleYesRsvp(
  ctx: RsvpMessageContext,
  event: Event,
): Promise<string> {
  setGuestConversationId(event.id, ctx.phone, ctx.conversationId);

  const guest = getGuest(event.id, ctx.phone);
  if (event.children_allowed === 1) {
    setConversationState(ctx.phone, 'WAITING_FOR_RSVP_COUNTS', {
      event_id: event.id,
      invitation_id: guest?.invitation_id ?? null,
    });
    await sendRsvpMessage({
      conversationId: ctx.conversationId,
      accountId: ctx.accountId,
      message: RSVP_COUNTS_PROMPT,
    });
    return 'awaiting_counts';
  }

  setConversationState(ctx.phone, 'WAITING_FOR_RSVP_ADULTS', {
    event_id: event.id,
    invitation_id: guest?.invitation_id ?? null,
  });

  await sendRsvpMessage({
    conversationId: ctx.conversationId,
    accountId: ctx.accountId,
    message: RSVP_ADULTS_PROMPT,
  });
  return 'awaiting_adults';
}

async function handleImmediateRsvp(
  ctx: RsvpMessageContext,
  event: Event,
  parsed: ParsedRsvp,
): Promise<string> {
  setGuestConversationId(event.id, ctx.phone, ctx.conversationId);

  if (parsed.status === 'no') {
    recordRsvpAndNotify(ctx, event, 'no', 0, 0, 0);
  } else if (parsed.status === 'maybe') {
    recordRsvpAndNotify(ctx, event, 'maybe', 0, 0, 0);
  } else {
    return handleYesRsvp(ctx, event);
  }

  const confirmation = formatConfirmation(
    event.name,
    event.date,
    parsed.status,
    0,
  );

  await sendRsvpConfirmation(ctx, event, confirmation);

  return 'rsvp_recorded';
}

export async function handleGuestRsvp(ctx: RsvpMessageContext): Promise<string | null> {
  if (isOrganizerCreateState(ctx.phone)) {
    return null;
  }

  const updateInput =
    ctx.interactiveId || ctx.buttonPayload || ctx.text || '';
  if (isGuestUpdateCommand(updateInput)) {
    const handled = await handleGuestUpdateCommand(
      {
        phone: ctx.phone,
        text: ctx.text ?? '',
        conversationId: ctx.conversationId,
        accountId: ctx.accountId,
        senderName: ctx.senderName,
        interactiveId: ctx.interactiveId,
        buttonPayload: ctx.buttonPayload,
        interactiveType: ctx.interactiveType,
      },
      updateInput,
    );
    if (handled) {
      return 'update_ack';
    }
  }

  const countFlow = await continueGuestCountFlow(ctx, ctx.text ?? '');
  if (countFlow) {
    return countFlow;
  }

  const linkToken = ctx.text ? parseRsvpLinkToken(ctx.text) : null;
  if (linkToken) {
    return handleRsvpLink(ctx, linkToken);
  }

  const parsed = parseRsvpFromContext(ctx);
  if (!parsed) {
    return null;
  }

  const event = findLatestPendingEventForGuest(ctx.phone);
  if (!event) {
    await sendRsvpMessage({
      conversationId: ctx.conversationId,
      accountId: ctx.accountId,
      message:
        "We couldn't find an active invitation for your number. If you received an invite, please reply directly to that message.",
    });
    return 'no_event';
  }

  const cancelled = await rejectIfCancelled(ctx, event);
  if (cancelled) {
    return cancelled;
  }

  if (isRsvpDeadlinePassed(event.rsvp_deadline, { eventDate: event.date })) {
    await sendRsvpMessage({
      conversationId: ctx.conversationId,
      accountId: ctx.accountId,
      message: RSVP_CLOSED_MESSAGE,
    });
    return 'deadline_closed';
  }

  if (ctx.senderName) {
    setGuestName(event.id, ctx.phone, ctx.senderName);
  }

  if (parsed.status === 'yes') {
    return handleYesRsvp(ctx, event);
  }

  return handleImmediateRsvp(ctx, event, parsed);
}

export function resolveEventForGuest(phone: string): Event | undefined {
  return findLatestPendingEventForGuest(phone);
}
