import crypto from 'node:crypto';
import { getPublicBaseUrl, normalizePhone } from '../config.js';
import { allocateEventWhenShortCode } from '../db/store.js';

export interface MyEventsPayload {
  phone: string;
  exp: number;
}

export const MY_EVENTS_TOKEN_TTL_MS = 2 * 60 * 60 * 1000;

function pageSecret(): string {
  return (
    process.env.RSVP_GUEST_SECRET?.trim() ||
    process.env.WEBHOOK_SECRET?.trim() ||
    'connect-my-events'
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

function signBody(body: string): string {
  const mac = crypto
    .createHmac('sha256', pageSecret())
    .update(body)
    .digest('base64url');
  return `${body}.${mac}`;
}

function verifyBody(token: string): string | null {
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
  return body;
}

export function signMyEventsToken(phone: string, nowMs = Date.now()): string {
  const payload = {
    p: normalizePhone(phone),
    t: 'my-events',
    e: nowMs + MY_EVENTS_TOKEN_TTL_MS,
  };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return signBody(body);
}

export function verifyMyEventsToken(
  token: string,
  nowMs = Date.now(),
): MyEventsPayload | null {
  const body = verifyBody(token);
  if (!body) {
    return null;
  }
  try {
    const parsed = JSON.parse(
      Buffer.from(body, 'base64url').toString('utf8'),
    ) as { p?: unknown; t?: unknown; e?: unknown };
    if (
      typeof parsed.p !== 'string' ||
      parsed.t !== 'my-events' ||
      typeof parsed.e !== 'number'
    ) {
      return null;
    }
    if (parsed.e <= nowMs) {
      return null;
    }
    return { phone: normalizePhone(parsed.p), exp: parsed.e };
  } catch {
    return null;
  }
}

export function signOwnedEventRef(phone: string, eventId: number): string {
  const payload = {
    p: normalizePhone(phone),
    i: eventId,
    t: 'event-ref',
  };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return signBody(body);
}

export function verifyOwnedEventRef(
  token: string,
  phone: string,
): number | null {
  const body = verifyBody(token);
  if (!body) {
    return null;
  }
  try {
    const parsed = JSON.parse(
      Buffer.from(body, 'base64url').toString('utf8'),
    ) as { p?: unknown; i?: unknown; t?: unknown };
    if (
      parsed.t !== 'event-ref' ||
      typeof parsed.p !== 'string' ||
      typeof parsed.i !== 'number' ||
      !Number.isInteger(parsed.i) ||
      parsed.i < 1
    ) {
      return null;
    }
    if (normalizePhone(parsed.p) !== normalizePhone(phone)) {
      return null;
    }
    return parsed.i;
  } catch {
    return null;
  }
}

export function myEventsPagePath(phone: string, nowMs = Date.now()): string {
  const token = signMyEventsToken(phone, nowMs);
  const code = allocateEventWhenShortCode(
    token,
    nowMs + MY_EVENTS_TOKEN_TTL_MS,
  );
  return `/e/${encodeURIComponent(code)}`;
}

export function myEventsPageUrl(phone: string, nowMs = Date.now()): string {
  return `${getPublicBaseUrl()}${myEventsPagePath(phone, nowMs)}`;
}
