import crypto from 'node:crypto';
import { getPublicBaseUrl, normalizePhone } from '../config.js';
import { allocateEventWhenShortCode } from '../db/store.js';

export type EventWhenStep = 'date' | 'time' | 'deadline';

export interface EventWhenPayload {
  phone: string;
  step: EventWhenStep;
  exp: number;
}

export const EVENT_WHEN_TOKEN_TTL_MS = 2 * 60 * 60 * 1000;

function pickerSecret(): string {
  return (
    process.env.RSVP_GUEST_SECRET?.trim() ||
    process.env.WEBHOOK_SECRET?.trim() ||
    'connect-event-when'
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

export function signEventWhenToken(
  phone: string,
  step: EventWhenStep,
  nowMs = Date.now(),
): string {
  const payload = {
    p: normalizePhone(phone),
    s: step,
    e: nowMs + EVENT_WHEN_TOKEN_TTL_MS,
  };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const mac = crypto
    .createHmac('sha256', pickerSecret())
    .update(body)
    .digest('base64url');
  return `${body}.${mac}`;
}

export function verifyEventWhenToken(
  token: string,
  nowMs = Date.now(),
): EventWhenPayload | null {
  const trimmed = token.trim();
  const dot = trimmed.lastIndexOf('.');
  if (dot <= 0) {
    return null;
  }
  const body = trimmed.slice(0, dot);
  const mac = trimmed.slice(dot + 1);
  const expected = crypto
    .createHmac('sha256', pickerSecret())
    .update(body)
    .digest('base64url');
  if (!safeEqual(mac, expected)) {
    return null;
  }

  try {
    const parsed = JSON.parse(
      Buffer.from(body, 'base64url').toString('utf8'),
    ) as { p?: unknown; s?: unknown; e?: unknown };
    if (
      typeof parsed.p !== 'string' ||
      (parsed.s !== 'date' && parsed.s !== 'time' && parsed.s !== 'deadline') ||
      typeof parsed.e !== 'number'
    ) {
      return null;
    }
    if (parsed.e <= nowMs) {
      return null;
    }
    return {
      phone: normalizePhone(parsed.p),
      step: parsed.s,
      exp: parsed.e,
    };
  } catch {
    return null;
  }
}

export function eventWhenPickerPath(
  phone: string,
  step: EventWhenStep,
  nowMs = Date.now(),
): string {
  const token = signEventWhenToken(phone, step, nowMs);
  const code = allocateEventWhenShortCode(
    token,
    nowMs + EVENT_WHEN_TOKEN_TTL_MS,
  );
  return `/d/${encodeURIComponent(code)}`;
}

export function eventWhenPickerUrl(
  phone: string,
  step: EventWhenStep,
  nowMs = Date.now(),
): string {
  return `${getPublicBaseUrl()}${eventWhenPickerPath(phone, step, nowMs)}`;
}
