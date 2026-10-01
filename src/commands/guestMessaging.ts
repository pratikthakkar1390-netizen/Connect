import {
  buildRsvpWhatsAppLink,
  buildShortRsvpUrl,
  connectWhatsAppAccountId,
  isReminderSendingEnabled,
  parseGuestWhatsAppNumber,
} from '../config.js';
import { formatEventTimezoneLine } from '../dates/eventDate.js';
import {
  getEventGuests,
  getInvitationById,
  getMessageSession,
  isEventCancelled,
  isEventDeleted,
  listRsvpsForEvent,
  type Event,
  type Invitation,
} from '../db/store.js';
import {
  isBroadcastSendSuccessful,
  sendEventInviteBroadcast,
  sendInboxMessage,
  sendReminderBroadcast,
  type SendMessageParams,
} from '../zernio/client.js';
import { formatShareRsvpInvitation } from './invitationMessage.js';
import {
  guestDisplayName,
  guestStatusLabel,
  type GuestListEntry,
} from './guestList.js';

export const RESEND_INVITE = 'RESEND_INVITE';
export const SEND_REMINDER = 'SEND_REMINDER';

export type GuestMessagingKind = 'invite' | 'reminder';

export interface GuestMessagingResult {
  ok: boolean;
  message: string;
  phone?: string;
  accountId?: string;
  channel?: 'inbox' | 'template';
}

type InboxSendFn = (params: SendMessageParams) => Promise<unknown>;
type InviteBroadcastFn = typeof sendEventInviteBroadcast;
type ReminderBroadcastFn = typeof sendReminderBroadcast;

let sendGuestInbox: InboxSendFn = sendInboxMessage;
let sendInviteTemplate: InviteBroadcastFn = sendEventInviteBroadcast;
let sendReminderTemplate: ReminderBroadcastFn = sendReminderBroadcast;

/** Test-only seam. Restores production senders when called with no args. */
export function setGuestMessagingSenders(senders?: {
  inbox?: InboxSendFn;
  inviteBroadcast?: InviteBroadcastFn;
  reminderBroadcast?: ReminderBroadcastFn;
}): void {
  sendGuestInbox = senders?.inbox ?? sendInboxMessage;
  sendInviteTemplate = senders?.inviteBroadcast ?? sendEventInviteBroadcast;
  sendReminderTemplate = senders?.reminderBroadcast ?? sendReminderBroadcast;
}

export function parseGuestPairAction(
  input: string,
  action: string,
): { eventId: number; guestId: number } | null {
  const match = input
    .trim()
    .toUpperCase()
    .match(new RegExp(`^${action}[:\\s_](\\d+)[:\\s_](\\d+)$`));
  if (!match) {
    return null;
  }
  const eventId = Number(match[1]);
  const guestId = Number(match[2]);
  if (
    !Number.isInteger(eventId) ||
    !Number.isInteger(guestId) ||
    eventId < 1 ||
    guestId < 1
  ) {
    return null;
  }
  return { eventId, guestId };
}

export function guestPairRowId(
  action: string,
  eventId: number,
  guestId: number,
): string {
  return `${action}:${eventId}:${guestId}`;
}

export function guestMessagingButtons(
  event: Event,
  entry: GuestListEntry,
): Array<{ title: string; payload: string }> | undefined {
  if (isEventDeleted(event) || isEventCancelled(event)) {
    return undefined;
  }
  return [
    {
      title: 'Resend Invitation',
      payload: guestPairRowId(RESEND_INVITE, event.id, entry.guestId),
    },
    {
      title: 'Send Reminder',
      payload: guestPairRowId(SEND_REMINDER, event.id, entry.guestId),
    },
  ];
}

export function guestWhatsAppSendPhone(entry: GuestListEntry): string | null {
  const whatsapp = parseGuestWhatsAppNumber(entry.whatsappPhone);
  if (whatsapp) {
    return whatsapp;
  }
  return parseGuestWhatsAppNumber(entry.phone);
}

function reminderTemplateAvailable(): boolean {
  return Boolean(
    process.env.REMINDER_TEMPLATE_NAME?.trim() || isReminderSendingEnabled(),
  );
}

function connectSessionForGuest(phone: string) {
  const connect = connectWhatsAppAccountId();
  if (!connect) {
    return undefined;
  }
  return getMessageSession(phone, connect);
}

function invitationForGuest(entry: GuestListEntry): Invitation | undefined {
  if (entry.invitationId == null) {
    return undefined;
  }
  return getInvitationById(entry.invitationId);
}

function rsvpCodeForGuest(event: Event, entry: GuestListEntry): string {
  const invitation = invitationForGuest(entry);
  return invitation?.rsvp_code?.trim() || event.rsvp_code;
}

function rsvpLinkForGuest(event: Event, entry: GuestListEntry): string | null {
  const invitation = invitationForGuest(entry);
  if (invitation?.short_code?.trim()) {
    return buildShortRsvpUrl(invitation.short_code);
  }
  if (event.short_code?.trim()) {
    return buildShortRsvpUrl(event.short_code);
  }
  return buildRsvpWhatsAppLink(rsvpCodeForGuest(event, entry));
}

function alreadyRespondedNote(entry: GuestListEntry): string | null {
  if (entry.status === 'awaiting') {
    return null;
  }
  return `This does not change their current RSVP (${guestStatusLabel(entry.status)}).`;
}

function organizerSuccess(
  kind: GuestMessagingKind,
  entry: GuestListEntry,
): string {
  const name = guestDisplayName(entry);
  const sent =
    kind === 'invite'
      ? `✅ Invitation sent to ${name}.`
      : `✅ Reminder sent to ${name}.`;
  const note = alreadyRespondedNote(entry);
  return note ? `${sent}\n\n${note}` : sent;
}

function publicErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const trimmed = raw.replace(/\s+/g, ' ').trim();
  if (!trimmed) {
    return 'WhatsApp could not send the message.';
  }
  if (/token|secret|api[_ ]?key|authorization/i.test(trimmed)) {
    return 'WhatsApp could not send the message.';
  }
  return trimmed.length > 220 ? `${trimmed.slice(0, 217)}...` : trimmed;
}

function inviteInboxBody(event: Event, entry: GuestListEntry): string {
  return formatShareRsvpInvitation(
    event,
    rsvpLinkForGuest(event, entry),
    rsvpCodeForGuest(event, entry),
  );
}

function reminderInboxBody(event: Event, entry: GuestListEntry): string {
  const link = rsvpLinkForGuest(event, entry);
  const lines = [
    '🔔 RSVP reminder',
    '',
    event.name,
    '',
    `📅 ${event.date}`,
    formatEventTimezoneLine(event.timezone),
  ];
  if (event.location?.trim()) {
    lines.push(`📍 ${event.location.trim()}`);
  }
  if (event.rsvp_deadline?.trim()) {
    lines.push('', `RSVP by: ${event.rsvp_deadline.trim()}`);
  }
  lines.push('', '💌 Please RSVP here:');
  if (link) {
    lines.push(link);
  } else {
    lines.push(`RSVP ${rsvpCodeForGuest(event, entry)}`);
  }
  return lines.join('\n');
}

const RSVP_BUTTONS = [
  { title: 'Yes', payload: 'rsvp_yes' },
  { title: 'No', payload: 'rsvp_no' },
  { title: 'Maybe', payload: 'rsvp_maybe' },
];

async function tryInbox(params: SendMessageParams): Promise<boolean> {
  try {
    await sendGuestInbox(params);
    return true;
  } catch (error) {
    console.error(
      `Guest messaging inbox send failed for conversation ${params.conversationId}:`,
      error,
    );
    return false;
  }
}

export async function sendGuestListInvitation(
  event: Event,
  entry: GuestListEntry,
): Promise<GuestMessagingResult> {
  return sendGuestListMessage(event, entry, 'invite');
}

export async function sendGuestListReminder(
  event: Event,
  entry: GuestListEntry,
): Promise<GuestMessagingResult> {
  return sendGuestListMessage(event, entry, 'reminder');
}

async function sendGuestListMessage(
  event: Event,
  entry: GuestListEntry,
  kind: GuestMessagingKind,
): Promise<GuestMessagingResult> {
  const name = guestDisplayName(entry);
  if (isEventDeleted(event)) {
    return {
      ok: false,
      message: 'This event was deleted, so messages cannot be sent.',
    };
  }
  if (isEventCancelled(event)) {
    return {
      ok: false,
      message:
        kind === 'invite'
          ? 'This event is cancelled, so invitations cannot be resent.'
          : 'This event is cancelled, so reminders cannot be sent.',
    };
  }

  const phone = guestWhatsAppSendPhone(entry);
  if (!phone) {
    return {
      ok: false,
      message: `${name} is not on WhatsApp, so this message cannot be sent from here.`,
    };
  }

  const session = connectSessionForGuest(phone);
  const connect = connectWhatsAppAccountId();

  if (session) {
    const inboxOk = await tryInbox({
      conversationId: session.conversation_id,
      accountId: session.account_id,
      message:
        kind === 'invite'
          ? inviteInboxBody(event, entry)
          : reminderInboxBody(event, entry),
      buttons: kind === 'invite' ? RSVP_BUTTONS : undefined,
    });
    if (inboxOk) {
      return {
        ok: true,
        message: organizerSuccess(kind, entry),
        phone,
        accountId: session.account_id,
        channel: 'inbox',
      };
    }
  }

  if (kind === 'reminder' && !reminderTemplateAvailable()) {
    return {
      ok: false,
      message: session
        ? `Could not send a reminder to ${name}. WhatsApp is outside the messaging window and no reminder template is configured.`
        : `Could not send a reminder to ${name}. They are outside the 24-hour WhatsApp window and no reminder template is configured.`,
    };
  }

  if (!connect) {
    return {
      ok: false,
      message: `Could not send this message to ${name}. CONNECT WhatsApp is not configured.`,
    };
  }

  try {
    if (kind === 'invite') {
      const result = await sendInviteTemplate({
        eventName: event.name,
        eventDate: event.date,
        eventLocation: event.location,
        phones: [phone],
        broadcastName: `guest-invite-${event.id}-${Date.now()}`,
      });
      if (!isBroadcastSendSuccessful(result)) {
        return {
          ok: false,
          message: `Could not resend the invitation to ${name}. The invitation template did not send.`,
          phone,
          accountId: connect,
          channel: 'template',
        };
      }
    } else {
      const result = await sendReminderTemplate({
        eventName: event.name,
        eventDate: event.date,
        rsvpDeadline: event.rsvp_deadline?.trim() || event.date,
        rsvpCode: rsvpCodeForGuest(event, entry),
        phones: [phone],
        broadcastName: `guest-reminder-${event.id}-${Date.now()}`,
      });
      if (!isBroadcastSendSuccessful(result)) {
        return {
          ok: false,
          message: `Could not send a reminder to ${name}. The reminder template did not send.`,
          phone,
          accountId: connect,
          channel: 'template',
        };
      }
    }
  } catch (error) {
    return {
      ok: false,
      message: `Could not ${kind === 'invite' ? 'resend the invitation' : 'send a reminder'} to ${name}. ${publicErrorMessage(error)}`,
      phone,
      accountId: connect,
      channel: 'template',
    };
  }

  return {
    ok: true,
    message: organizerSuccess(kind, entry),
    phone,
    accountId: connect,
    channel: 'template',
  };
}

/** Read-only snapshot used by tests to prove resend does not mutate guests/RSVPs. */
export function guestListIntegritySnapshot(eventId: number): {
  guestCount: number;
  guestIds: number[];
  rsvps: Array<{ phone: string; status: string; adultCount: number; childCount: number }>;
} {
  const guests = getEventGuests(eventId);
  const rsvps = listRsvpsForEvent(eventId);
  return {
    guestCount: guests.length,
    guestIds: guests.map((row) => row.id).sort((a, b) => a - b),
    rsvps: rsvps.map((row) => ({
      phone: row.phone,
      status: row.status,
      adultCount: row.adult_count,
      childCount: row.child_count,
    })),
  };
}
