import crypto from 'node:crypto';
import { getPublicBaseUrl, normalizePhone } from '../config.js';
import { allocateEventWhenShortCode } from '../db/store.js';

export interface EventImagePayload {
  phone: string;
  exp: number;
}

export const EVENT_IMAGE_TOKEN_TTL_MS = 2 * 60 * 60 * 1000;

function pickerSecret(): string {
  return (
    process.env.RSVP_GUEST_SECRET?.trim() ||
    process.env.WEBHOOK_SECRET?.trim() ||
    'connect-event-image'
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

export function signEventImageToken(phone: string, nowMs = Date.now()): string {
  const payload = {
    p: normalizePhone(phone),
    k: 'img',
    e: nowMs + EVENT_IMAGE_TOKEN_TTL_MS,
  };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const mac = crypto
    .createHmac('sha256', pickerSecret())
    .update(body)
    .digest('base64url');
  return `${body}.${mac}`;
}

export function verifyEventImageToken(
  token: string,
  nowMs = Date.now(),
): EventImagePayload | null {
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
    ) as { p?: unknown; k?: unknown; e?: unknown };
    if (
      typeof parsed.p !== 'string' ||
      parsed.k !== 'img' ||
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

export function eventImagePickerPath(phone: string, nowMs = Date.now()): string {
  const token = signEventImageToken(phone, nowMs);
  const code = allocateEventWhenShortCode(
    token,
    nowMs + EVENT_IMAGE_TOKEN_TTL_MS,
  );
  return `/p/${encodeURIComponent(code)}`;
}

export function eventImagePickerUrl(phone: string, nowMs = Date.now()): string {
  return `${getPublicBaseUrl()}${eventImagePickerPath(phone, nowMs)}`;
}
