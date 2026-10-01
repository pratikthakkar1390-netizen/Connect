import { formatDateTime } from '../admin/html.js';
import {
  isWebGuestPhone,
  normalizePhone,
} from '../config.js';
import {
  countKnownAwaitingRecipients,
  getEffectiveAdultCount,
  getEffectiveChildCount,
  getEffectiveTotalAttending,
  getEventById,
  getEventGuests,
  getRsvpSummary,
  isEventDeleted,
  listInvitationsForEvent,
  listRsvpsForEvent,
  type Event,
  type Guest,
  type Invitation,
  type InvitationType,
  type Rsvp,
} from '../db/store.js';
import { guestListPageUrl } from '../http/guestListToken.js';
import {
  formatPhoneForDisplay,
  organizerGuestDisplayName,
} from './organizer.js';
import {
  truncateListText,
  WHATSAPP_LIST_MAX_ROWS,
  WHATSAPP_LIST_ROW_DESC_LIMIT,
  WHATSAPP_LIST_ROW_TITLE_LIMIT,
} from '../whatsapp/eventList.js';

export const GUEST_LIST = 'GUEST_LIST';
export const GUEST_DETAIL = 'GUEST_DETAIL';

export type GuestListStatus = 'yes' | 'no' | 'maybe' | 'awaiting';

export interface GuestListEntry {
  guestId: number;
  eventId: number;
  name: string | null;
  phone: string;
  whatsappPhone: string | null;
  invitedAt: string;
  invitationId: number | null;
  invitationType: InvitationType | null;
  familyName: string | null;
  groupName: string | null;
  maxGuests: number | null;
  status: GuestListStatus;
  adultCount: number;
  childCount: number;
  total: number;
  respondedAt: string | null;
}

export interface GuestListReply {
  message: string;
  list?: {
    button: string;
    sections: Array<{
      title?: string;
      rows: Array<{ id: string; title: string; description?: string }>;
    }>;
  };
}

const STATUS_EMOJI: Record<GuestListStatus, string> = {
  yes: '✅',
  no: '❌',
  maybe: '❓',
  awaiting: '⏳',
};

const STATUS_LABEL: Record<GuestListStatus, string> = {
  yes: 'Yes',
  no: 'No',
  maybe: 'Maybe',
  awaiting: 'Awaiting',
};

export function parseGuestDetailAction(
  input: string,
): { eventId: number; guestId: number } | null {
  const match = input
    .trim()
    .toUpperCase()
    .match(/^GUEST_DETAIL[:\s_](\d+)[:\s_](\d+)$/);
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

export function guestDetailRowId(eventId: number, guestId: number): string {
  return `${GUEST_DETAIL}:${eventId}:${guestId}`;
}

function rsvpStatus(rsvp: Rsvp | undefined): GuestListStatus {
  if (!rsvp || rsvp.status === 'pending') {
    return 'awaiting';
  }
  if (rsvp.status === 'yes' || rsvp.status === 'no' || rsvp.status === 'maybe') {
    return rsvp.status;
  }
  return 'awaiting';
}

function toEntry(
  guest: Guest,
  rsvp: Rsvp | undefined,
  invitationById: Map<number, Invitation>,
): GuestListEntry {
  const invitation =
    guest.invitation_id != null
      ? invitationById.get(guest.invitation_id) ?? null
      : null;
  const status = rsvpStatus(rsvp);
  const responded =
    status === 'awaiting' || !rsvp?.updated_at?.trim()
      ? null
      : rsvp.updated_at;
  return {
    guestId: guest.id,
    eventId: guest.event_id,
    name: guest.name,
    phone: guest.phone,
    whatsappPhone: guest.whatsapp_phone ?? null,
    invitedAt: guest.invited_at,
    invitationId: guest.invitation_id ?? null,
    invitationType: invitation?.type ?? null,
    familyName: invitation?.family_name ?? null,
    groupName: invitation?.group_name ?? null,
    maxGuests: invitation?.max_guests ?? null,
    status,
    adultCount: rsvp ? getEffectiveAdultCount(rsvp) : 0,
    childCount: rsvp ? getEffectiveChildCount(rsvp) : 0,
    total: rsvp ? getEffectiveTotalAttending(rsvp) : 0,
    respondedAt: responded,
  };
}

export function buildGuestListEntries(eventId: number): GuestListEntry[] {
  const guests = getEventGuests(eventId);
  const rsvps = listRsvpsForEvent(eventId);
  const invitations = listInvitationsForEvent(eventId);
  const rsvpByPhone = new Map(rsvps.map((row) => [row.phone, row]));
  const invitationById = new Map(invitations.map((row) => [row.id, row]));

  return guests.map((guest) =>
    toEntry(guest, rsvpByPhone.get(guest.phone), invitationById),
  );
}

export function getGuestListEntry(
  eventId: number,
  guestId: number,
): GuestListEntry | undefined {
  return buildGuestListEntries(eventId).find((row) => row.guestId === guestId);
}

function digitString(value: string): string {
  return value.replace(/\D/g, '');
}

export function guestDisplayName(entry: GuestListEntry): string {
  return organizerGuestDisplayName(entry.name, entry.phone);
}

export function searchGuestListEntries(
  entries: GuestListEntry[],
  query: string,
): GuestListEntry[] {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return entries;
  }
  const needleDigits = digitString(needle);
  return entries.filter((entry) => {
    if (guestDisplayName(entry).toLowerCase().includes(needle)) {
      return true;
    }
    if (entry.name?.trim().toLowerCase().includes(needle)) {
      return true;
    }
    if (entry.phone.toLowerCase().includes(needle)) {
      return true;
    }
    if (entry.whatsappPhone?.toLowerCase().includes(needle)) {
      return true;
    }
    if (needleDigits.length >= 3) {
      if (digitString(entry.phone).includes(needleDigits)) {
        return true;
      }
      if (
        entry.whatsappPhone &&
        digitString(entry.whatsappPhone).includes(needleDigits)
      ) {
        return true;
      }
    }
    return false;
  });
}

export function guestWhatsAppDisplay(entry: GuestListEntry): string {
  const whatsapp = entry.whatsappPhone?.trim();
  if (whatsapp && !isWebGuestPhone(whatsapp)) {
    return formatPhoneForDisplay(whatsapp);
  }
  if (!isWebGuestPhone(entry.phone)) {
    return formatPhoneForDisplay(entry.phone);
  }
  return 'Not on WhatsApp';
}

export function formatGuestListDay(value: string | null | undefined): string {
  if (!value?.trim()) {
    return '';
  }
  const formatted = formatDateTime(value);
  if (formatted === '—') {
    return '';
  }
  const match = formatted.match(/^([A-Za-z]+ \d+)/);
  return match ? match[1] : formatted;
}

function formatPeopleCounts(adults: number, children: number): string | null {
  if (adults <= 0 && children <= 0) {
    return null;
  }
  const parts: string[] = [];
  if (adults > 0) {
    parts.push(`${adults} Adult${adults === 1 ? '' : 's'}`);
  }
  if (children > 0) {
    parts.push(`${children} Child${children === 1 ? '' : 'ren'}`);
  }
  return parts.join(' • ');
}

export function formatGuestListRow(entry: GuestListEntry): string {
  const lines = [
    guestDisplayName(entry),
    `${STATUS_EMOJI[entry.status]} ${STATUS_LABEL[entry.status]}`,
  ];
  if (entry.status === 'yes') {
    const counts = formatPeopleCounts(entry.adultCount, entry.childCount);
    if (counts) {
      lines.push(counts);
    }
  }
  if (entry.respondedAt) {
    lines.push(`Responded ${formatGuestListDay(entry.respondedAt)}`);
  } else if (entry.invitedAt) {
    lines.push(`Invited ${formatGuestListDay(entry.invitedAt)}`);
  }
  return lines.join('\n');
}

export function guestStatusLabel(status: GuestListStatus): string {
  return STATUS_LABEL[status];
}

export function guestStatusEmoji(status: GuestListStatus): string {
  return STATUS_EMOJI[status];
}

export function formatGuestDetailsMessage(entry: GuestListEntry): string {
  const adults = entry.status === 'yes' ? entry.adultCount : 0;
  const children = entry.status === 'yes' ? entry.childCount : 0;
  const total = entry.status === 'yes' ? entry.total : 0;
  const lines = [
    `👤 ${guestDisplayName(entry)}`,
    '',
    `Status: ${STATUS_EMOJI[entry.status]} ${STATUS_LABEL[entry.status]}`,
    '',
    `WhatsApp: ${guestWhatsAppDisplay(entry)}`,
    '',
    `Adults: ${adults}`,
    `Children: ${children}`,
    `Total: ${total}`,
    '',
    `Invited: ${entry.invitedAt ? formatDateTime(entry.invitedAt) : '—'}`,
    `Responded: ${entry.respondedAt ? formatDateTime(entry.respondedAt) : '—'}`,
  ];
  if (entry.status !== 'awaiting') {
    lines.push(
      '',
      'Resending an invitation or reminder does not change their current RSVP.',
    );
  }
  if (entry.invitationType === 'family') {
    const max = entry.maxGuests != null ? ` (max ${entry.maxGuests})` : '';
    lines.push(
      '',
      `Invitation: Family${entry.familyName ? ` — ${entry.familyName}` : ''}${max}`,
    );
  } else if (entry.invitationType === 'group') {
    lines.push(
      '',
      `Invitation: Group${entry.groupName ? ` — ${entry.groupName}` : ''}`,
    );
  } else if (entry.invitationType === 'individual') {
    lines.push('', 'Invitation: Individual');
  }
  return lines.join('\n');
}

export function formatGuestListSummary(event: Event): string {
  const invitations = listInvitationsForEvent(event.id);
  const summary = getRsvpSummary(event.id);
  const guests = getEventGuests(event.id);
  const rsvps = listRsvpsForEvent(event.id);
  const awaiting = countKnownAwaitingRecipients({
    organizerPhone: event.organizer_phone,
    guests,
    rsvps,
    invitations,
  });
  return [
    `🎉 ${event.name}`,
    '',
    'Summary:',
    `✅ Yes: ${summary.yes}`,
    `❓ Maybe: ${summary.maybe}`,
    `❌ No: ${summary.no}`,
    `⏳ Awaiting: ${awaiting}`,
    '',
    `👥 Total Expected: ${summary.expectedAttendance}`,
    `👨 Adults: ${summary.totalAdults}`,
    `👧 Children: ${summary.totalChildren}`,
  ].join('\n');
}

export function buildGuestListReply(
  event: Event,
  organizerPhone: string,
): GuestListReply {
  const entries = buildGuestListEntries(event.id);
  const url = guestListPageUrl(organizerPhone, event.id);
  const lines = [
    formatGuestListSummary(event),
    '',
    entries.length === 0
      ? 'No guests yet. Send invitations first.'
      : `Open the guest list to search and view details:\n${url}`,
  ];
  const rows = entries.slice(0, WHATSAPP_LIST_MAX_ROWS).map((entry) => ({
    id: guestDetailRowId(event.id, entry.guestId),
    title: truncateListText(
      guestDisplayName(entry),
      WHATSAPP_LIST_ROW_TITLE_LIMIT,
    ),
    description: truncateListText(
      `${STATUS_EMOJI[entry.status]} ${STATUS_LABEL[entry.status]}`,
      WHATSAPP_LIST_ROW_DESC_LIMIT,
    ),
  }));
  return {
    message: lines.join('\n'),
    list:
      rows.length > 0
        ? {
            button: 'Guests',
            sections: [{ title: 'Guests', rows }],
          }
        : undefined,
  };
}

export function isOrganizerOfEvent(event: Event, phone: string): boolean {
  return event.organizer_phone === normalizePhone(phone);
}

export function canAccessGuestList(
  event: Event | undefined,
  phone: string,
): event is Event {
  return Boolean(
    event && isOrganizerOfEvent(event, phone) && !isEventDeleted(event),
  );
}

export function loadOwnedEventForGuestList(
  eventId: number,
  phone: string,
): Event | undefined {
  const event = getEventById(eventId);
  return canAccessGuestList(event, phone) ? event : undefined;
}
