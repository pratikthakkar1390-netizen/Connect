import {
  getEffectiveAdultCount,
  getEffectiveChildCount,
  getEffectiveTotalAttending,
  countKnownAwaitingRecipients,
  type Event,
  type Guest,
  type InvitationWithMembers,
  type Rsvp,
  type RsvpSummary,
} from '../db/store.js';
import { isWebGuestPhone, WEB_GUEST_PHONE_PREFIX } from '../config.js';
import { formatEventTimezoneLine } from '../dates/eventDate.js';

export const VIEW_RSVPS = 'VIEW_RSVPS';
const WHATSAPP_TEXT_LIMIT = 4096;
const STATUS_LABELS: Record<string, string> = {
  yes: 'Yes',
  no: 'No',
  maybe: 'Maybe',
};
const STATUS_EMOJI: Record<string, string> = {
  yes: '✅',
  no: '❌',
  maybe: '🤔',
};

export interface CommandContext {
  phone: string;
  text: string;
  conversationId: string;
  accountId: string;
  senderName?: string;
  interactiveId?: string;
  buttonPayload?: string;
  interactiveType?: string;
}

/** Organizers use the same button/menu handlers as everyone else. */
export async function handleOrganizerCommand(
  ctx: CommandContext,
): Promise<boolean> {
  const { handleCustomerCommand } = await import('./welcome.js');
  return handleCustomerCommand(ctx);
}

export function formatPhoneForDisplay(phone: string): string {
  if (isWebGuestPhone(phone)) {
    return 'Guest';
  }
  const match = phone.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  if (match) {
    return `+1 ${match[1]} ${match[2]} ${match[3]}`;
  }
  return phone;
}

/** Organizer-facing identity. Prefer guests.name; never show a web: UUID. */
export function organizerGuestDisplayName(
  name: string | null | undefined,
  phone?: string,
): string {
  const stored = name?.trim();
  if (stored && !stored.toLowerCase().startsWith(WEB_GUEST_PHONE_PREFIX)) {
    return stored;
  }
  if (phone && !isWebGuestPhone(phone)) {
    return formatPhoneForDisplay(phone);
  }
  return 'Guest';
}

export function formatRespondentLine(
  rsvp: Rsvp,
  guestName: string | null | undefined,
): string {
  const emoji = STATUS_EMOJI[rsvp.status] ?? '';
  const status = STATUS_LABELS[rsvp.status] ?? rsvp.status;
  let countDetail = '';

  if (rsvp.status === 'yes') {
    const adults = getEffectiveAdultCount(rsvp);
    const children = getEffectiveChildCount(rsvp);
    const total = getEffectiveTotalAttending(rsvp);
    if (children > 0) {
      countDetail = ` (${adults} adult${adults === 1 ? '' : 's'}, ${children} child${children === 1 ? '' : 'ren'}, ${total} total)`;
    } else if (total > 1) {
      countDetail = ` (${total} guests)`;
    }
  }

  const displayName = organizerGuestDisplayName(guestName, rsvp.phone);
  if (isWebGuestPhone(rsvp.phone)) {
    return `${emoji} ${displayName} — ${status}${countDetail}`;
  }

  const detail = `${formatPhoneForDisplay(rsvp.phone)} — ${status}${countDetail}`;
  const name = guestName?.trim();
  if (name && !name.toLowerCase().startsWith(WEB_GUEST_PHONE_PREFIX)) {
    return `${emoji} ${name}\n   ${detail}`;
  }

  return `${emoji} ${detail}`;
}

export function formatInvitationGroups(
  invitations: InvitationWithMembers[],
): string[] {
  if (invitations.length === 0) {
    return [];
  }

  const lines = ['*Invitations*'];
  const individuals = invitations.filter((invite) => invite.type === 'individual');
  const families = invitations.filter((invite) => invite.type === 'family');
  const groups = invitations.filter((invite) => invite.type === 'group');

  if (individuals.length > 0) {
    lines.push(`👤 Individual${individuals.length > 1 ? ` ×${individuals.length}` : ''}`);
  }

  for (const family of families) {
    const max =
      family.max_guests != null ? ` — max ${family.max_guests}` : '';
    lines.push(`👨‍👩‍👧 ${family.family_name ?? 'Family'}${max}`);
  }

  for (const group of groups) {
    lines.push(`👥 ${group.group_name ?? 'Group'}`);
    if (group.members.length === 0) {
      lines.push('   No people added yet.');
    } else {
      for (const member of group.members) {
        lines.push(`   • ${member.member_name}`);
      }
    }
  }

  lines.push('');
  return lines;
}

export function formatRsvpStatusMessage(
  event: Event,
  summary: RsvpSummary,
  guests: Guest[],
  rsvps: Rsvp[],
  invitationRows: InvitationWithMembers[] = [],
): string {
  const invitations =
    invitationRows.length > 0
      ? invitationRows.length
      : (event.invitation_count ?? guests.length);
  const totalResponses = summary.yes + summary.no + summary.maybe;
  const knownAwaiting = countKnownAwaitingRecipients({
    organizerPhone: event.organizer_phone,
    guests,
    rsvps,
    invitations: invitationRows,
  });
  // Invitation rows / known phones: don't invent awaiting for unopened forwards.
  // Legacy planned invitation_count with no guest rows keeps the old formula.
  const awaiting =
    invitationRows.length > 0 || guests.length > 0
      ? knownAwaiting
      : Math.max(0, invitations - totalResponses);
  const respondents = rsvps.filter((rsvp) => rsvp.status !== 'pending');
  const guestNameByPhone = new Map(guests.map((guest) => [guest.phone, guest.name]));

  const deadlineLine = event.rsvp_deadline?.trim()
    ? `⏰ RSVP deadline: ${event.rsvp_deadline}`
    : null;

  const lines = [
    `*RSVP Status: ${event.name}*`,
    `📅 ${event.date}`,
    formatEventTimezoneLine(event.timezone),
    ...(deadlineLine ? [deadlineLine] : []),
    '',
    `📨 Invitations: ${invitations}`,
    `✅ Yes: ${summary.yes}`,
    `❌ No: ${summary.no}`,
    `🤔 Maybe: ${summary.maybe}`,
    `⏳ Awaiting: ${awaiting}`,
    `👥 Expected attendance: ${summary.expectedAttendance} (${summary.totalAdults} adult${summary.totalAdults === 1 ? '' : 's'}, ${summary.totalChildren} child${summary.totalChildren === 1 ? '' : 's'})`,
    '',
    ...formatInvitationGroups(invitationRows),
    '*Respondents*',
  ];

  if (respondents.length === 0) {
    lines.push('No responses yet.');
  } else {
    for (const rsvp of respondents) {
      const guestName =
        rsvp.guest_name ?? guestNameByPhone.get(rsvp.phone) ?? null;
      lines.push(formatRespondentLine(rsvp, guestName));
    }
  }

  return truncateWhatsAppMessage(lines.join('\n'));
}

function truncateWhatsAppMessage(message: string): string {
  if (message.length <= WHATSAPP_TEXT_LIMIT) {
    return message;
  }

  const notice = '\n\n…and more responses. Message trimmed.';
  const budget = WHATSAPP_TEXT_LIMIT - notice.length;
  const sliced = message.slice(0, budget);
  const lastNewline = sliced.lastIndexOf('\n');
  const cut = lastNewline > 200 ? sliced.slice(0, lastNewline) : sliced;
  return `${cut}${notice}`;
}
