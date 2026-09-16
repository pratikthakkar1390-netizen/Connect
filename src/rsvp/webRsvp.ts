import { config, isWebGuestPhone, WEB_GUEST_PHONE_PREFIX } from '../config.js';
import { familyLimitExceededMessage } from '../commands/inviteFlow.js';
import {
  addGuests,
  checkFamilyRsvpLimit,
  findInvitationRecipient,
  getGuestName,
  getGuestWhatsAppPhone,
  getRsvp,
  parsePositiveInteger,
  setGuestName,
  setGuestWhatsAppPhone,
  upsertRsvp,
  type Event,
  type Invitation,
  type Rsvp,
  type RsvpStatus,
} from '../db/store.js';
import {
  notifyOrganizerOfRsvp,
  resolveGuestDisplayName,
} from './organizerNotify.js';
import { formatConfirmation } from './parser.js';

export const WEB_GUEST_NAME_MAX_LEN = 80;

export type WebRsvpFailure =
  | { ok: false; reason: 'invalid' }
  | { ok: false; reason: 'name'; message: string }
  | { ok: false; reason: 'phone'; message: string }
  | { ok: false; reason: 'limit'; message: string; maxGuests: number };

export type WebRsvpResult = { ok: true; rsvp: Rsvp } | WebRsvpFailure;

export function stripWhatsAppMarkup(text: string): string {
  return text.replace(/\*/g, '');
}

export function webRsvpConfirmation(
  event: Event,
  status: RsvpStatus,
  adults: number,
  children: number,
): string {
  const total = status === 'yes' ? adults + children : 0;
  return stripWhatsAppMarkup(
    formatConfirmation(event.name, event.date, status, total, adults, children),
  );
}

function parseChildrenCount(raw: string | undefined): number | null {
  if (raw == null || raw.trim() === '') {
    return 0;
  }
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  return parseInt(trimmed, 10);
}

function isPlaceholderWebGuestName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return (
    !normalized ||
    normalized === 'guest' ||
    normalized.startsWith(WEB_GUEST_PHONE_PREFIX)
  );
}

export function normalizeWebGuestName(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > WEB_GUEST_NAME_MAX_LEN) {
    return null;
  }
  if (isPlaceholderWebGuestName(trimmed)) {
    return null;
  }
  return trimmed;
}

/** Cookie guest already has a real entered name — skip asking again. */
export function isSavedWebGuestName(name: string | null | undefined): boolean {
  return normalizeWebGuestName(name) != null;
}

export function webGuestNameError(raw: unknown): string {
  if (typeof raw === 'string' && raw.trim().length > WEB_GUEST_NAME_MAX_LEN) {
    return `Please enter a name (${WEB_GUEST_NAME_MAX_LEN} characters or fewer).`;
  }
  return 'Please enter your name so the organizer knows who responded.';
}

export function webGuestPhoneError(reason?: 'organizer' | 'taken' | 'invalid'): string {
  if (reason === 'organizer') {
    return 'Please enter the guest WhatsApp number, not the organizer number.';
  }
  if (reason === 'taken') {
    return 'That WhatsApp number is already used for another RSVP on this event.';
  }
  return 'Please enter a valid WhatsApp number including country code, for example 17325551234.';
}

export function isIndividualWebRsvp(invitation: Invitation | null): boolean {
  return invitation?.type !== 'family';
}

function resolveRecordedWebGuestName(
  eventId: number,
  phone: string,
  guestName: unknown,
): { ok: true; name: string } | { ok: false; message: string } {
  const submitted = normalizeWebGuestName(guestName);
  if (submitted) {
    return { ok: true, name: submitted };
  }
  const stored = getGuestName(eventId, phone);
  if (isSavedWebGuestName(stored)) {
    return { ok: true, name: stored!.trim() };
  }
  return { ok: false, message: webGuestNameError(guestName) };
}

function notifyOrganizerOfWebRsvp(
  event: Event,
  phone: string,
  status: RsvpStatus,
  adults: number,
  children: number,
): void {
  const total = status === 'yes' ? adults + children : 0;

  void notifyOrganizerOfRsvp({
    event,
    guestPhone: phone,
    guestName: resolveGuestDisplayName(event.id, phone, undefined),
    status,
    adults,
    children,
    total,
    accountId: config.zernioWhatsappAccountId,
  }).catch((error) => {
    console.error('Failed to notify organizer of web RSVP:', error);
  });
}

export function recordWebRsvp(input: {
  event: Event;
  invitation: Invitation | null;
  phone: string;
  status: RsvpStatus;
  adultsRaw?: string;
  childrenRaw?: string;
  guestName?: string;
  whatsapp?: string;
}): WebRsvpResult {
  const { event, invitation, phone, status } = input;

  let adults = 0;
  let children = 0;

  if (status === 'yes') {
    const parsedAdults = parsePositiveInteger(input.adultsRaw ?? '');
    if (!parsedAdults) {
      return { ok: false, reason: 'invalid' };
    }
    adults = parsedAdults;
    if (event.children_allowed === 1) {
      const parsedChildren = parseChildrenCount(input.childrenRaw);
      if (parsedChildren == null) {
        return { ok: false, reason: 'invalid' };
      }
      children = parsedChildren;
    }

    const limit = checkFamilyRsvpLimit(invitation, adults, children);
    if (!limit.allowed) {
      return {
        ok: false,
        reason: 'limit',
        maxGuests: limit.maxGuests,
        message: familyLimitExceededMessage(limit.maxGuests),
      };
    }
  }

  // Family: one RSVP on the original WhatsApp phone when one exists.
  // Individual: never merge onto a WhatsApp number. Each cookie web:uuid is
  // its own guest; optional notify number is stored on that row only.
  const recipient =
    invitation?.type === 'family'
      ? findInvitationRecipient(event.id, invitation, event.organizer_phone)
      : null;
  const storagePhone = recipient?.phone ?? phone;
  const invitationId = invitation?.id ?? recipient?.invitationId ?? null;

  let recordedName: string | null = null;
  if (isWebGuestPhone(phone)) {
    const resolved = resolveRecordedWebGuestName(
      event.id,
      storagePhone,
      input.guestName,
    );
    if (!resolved.ok) {
      return { ok: false, reason: 'name', message: resolved.message };
    }
    recordedName = resolved.name;
  }

  let notifyPhone: string | null = null;
  if (isIndividualWebRsvp(invitation) && isWebGuestPhone(phone)) {
    const saved = setGuestWhatsAppPhone(
      event.id,
      storagePhone,
      input.whatsapp ?? getGuestWhatsAppPhone(event.id, storagePhone) ?? '',
      event.organizer_phone,
    );
    if (!saved.ok) {
      return { ok: false, reason: 'phone', message: webGuestPhoneError(saved.reason) };
    }
    notifyPhone = saved.phone;
  }

  addGuests(event.id, [storagePhone], invitationId);
  if (recordedName) {
    setGuestName(event.id, storagePhone, recordedName);
  }
  if (notifyPhone) {
    setGuestWhatsAppPhone(
      event.id,
      storagePhone,
      notifyPhone,
      event.organizer_phone,
    );
  }

  const rawReply =
    status === 'yes'
      ? `web:${status} ${adults}+${children}`
      : `web:${status}`;
  const total = status === 'yes' ? adults + children : 0;
  const rsvp = upsertRsvp(
    event.id,
    storagePhone,
    status,
    total,
    rawReply,
    adults,
    children,
  );

  notifyOrganizerOfWebRsvp(event, storagePhone, status, adults, children);
  return { ok: true, rsvp };
}

export function currentWebRsvp(
  eventId: number,
  phone: string,
): Rsvp | undefined {
  const rsvp = getRsvp(eventId, phone);
  if (!rsvp || rsvp.status === 'pending') {
    return undefined;
  }
  return rsvp;
}
