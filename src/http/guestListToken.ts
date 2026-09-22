import crypto from 'node:crypto';
import { getPublicBaseUrl, normalizePhone } from '../config.js';
import { allocateGuestListShortCode } from '../db/store.js';

export interface GuestListPayload {
  phone: string;
  eventId: number;
  exp: number;
}

export const GUEST_LIST_TOKEN_TTL_MS = 2 * 60 * 60 * 1000;

function pageSecret(): string {
  return (
    process.env.RSVP_GUEST_SECRET?.trim() ||
    process.env.WEBHOOK_SECRET?.trim() ||
    'connect-guest-list'
  );
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

export function signGuestListToken(
  phone: string,
  eventId: number,
  nowMs = Date.now(),
): string {
  const payload = {
    p: normalizePhone(phone),
    i: eventId,
    e: nowMs + GUEST_LIST_TOKEN_TTL_MS,
  };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const mac = crypto
    .createHmac('sha256', pageSecret())
    .update(body)
    .digest('base64url');
  return `${body}.${mac}`;
}

export function verifyGuestListToken(
  token: string,
  nowMs = Date.now(),
): GuestListPayload | null {
  const trimmed = token.trim();
  const dot = trimmed.lastIndexOf('.');
  if (dot <= 0) {
    return null;
  }
  const body = trimmed.slice(0, dot);
  const mac = trimmed.slice(dot + 1);
  const expected = crypto
    .createHmac('sha256', pageSecret())
    .update(body)
    .digest('base64url');
  if (!safeEqual(mac, expected)) {
    return null;
  }
  try {
    const parsed = JSON.parse(
      Buffer.from(body, 'base64url').toString('utf8'),
    ) as { p?: unknown; i?: unknown; e?: unknown };
    if (
      typeof parsed.p !== 'string' ||
      typeof parsed.i !== 'number' ||
      typeof parsed.e !== 'number'
    ) {
      return null;
    }
    if (!Number.isInteger(parsed.i) || parsed.i < 1) {
      return null;
    }
    if (parsed.e <= nowMs) {
      return null;
    }
    return {
      phone: normalizePhone(parsed.p),
      eventId: parsed.i,
      exp: parsed.e,
    };
  } catch {
    return null;
  }
}

export function guestListLongPagePath(
  phone: string,
  eventId: number,
  nowMs = Date.now(),
): string {
  return `/guests/${encodeURIComponent(signGuestListToken(phone, eventId, nowMs))}`;
}

export function guestListPagePath(
  phone: string,
  eventId: number,
  nowMs = Date.now(),
): string {
  return guestListLongPagePath(phone, eventId, nowMs);
}

export function guestListShortPagePath(
  phone: string,
  eventId: number,
  nowMs = Date.now(),
): string {
  const token = signGuestListToken(phone, eventId, nowMs);
  const code = allocateGuestListShortCode(
    token,
    eventId,
    nowMs + GUEST_LIST_TOKEN_TTL_MS,
  );
  return `/g/${encodeURIComponent(code)}`;
}

export function guestListPageUrl(
  phone: string,
  eventId: number,
  nowMs = Date.now(),
): string {
  return `${getPublicBaseUrl()}${guestListShortPagePath(phone, eventId, nowMs)}`;
}

export function guestDetailPagePath(
  phone: string,
  eventId: number,
  guestId: number,
  nowMs = Date.now(),
): string {
  return `${guestListPagePath(phone, eventId, nowMs)}/g/${guestId}`;
}
