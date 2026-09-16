import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { WEB_GUEST_PHONE_PREFIX } from '../config.js';

export const WEB_GUEST_COOKIE = 'connect_rsvp';
const COOKIE_MAX_AGE_SEC = 60 * 60 * 24 * 365;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface CookiePayload {
  g: Record<string, string>;
}

function cookieSecret(): string {
  return (
    process.env.RSVP_GUEST_SECRET?.trim() ||
    process.env.WEBHOOK_SECRET?.trim() ||
    'connect-rsvp-cookie'
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

function signPayload(payload: CookiePayload): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const mac = crypto.createHmac('sha256', cookieSecret()).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verifyPayload(token: string): CookiePayload | null {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) {
    return null;
  }
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = crypto
    .createHmac('sha256', cookieSecret())
    .update(body)
    .digest('base64url');
  if (!safeEqual(mac, expected)) {
    return null;
  }
  try {
    const parsed = JSON.parse(
      Buffer.from(body, 'base64url').toString('utf8'),
    ) as CookiePayload;
    if (!parsed || typeof parsed !== 'object' || !parsed.g || typeof parsed.g !== 'object') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function parseCookieHeader(header: string | undefined): string | undefined {
  if (!header) {
    return undefined;
  }
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) {
      continue;
    }
    const name = part.slice(0, idx).trim();
    if (name === WEB_GUEST_COOKIE) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return undefined;
}

function readMap(req: Request): Record<string, string> {
  const token = parseCookieHeader(req.headers.cookie);
  if (!token) {
    return {};
  }
  const payload = verifyPayload(token);
  return payload?.g ?? {};
}

function writeMap(res: Response, map: Record<string, string>): void {
  const value = encodeURIComponent(signPayload({ g: map }));
  const parts = [
    `${WEB_GUEST_COOKIE}=${value}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${COOKIE_MAX_AGE_SEC}`,
  ];
  if (process.env.NODE_ENV === 'production') {
    parts.push('Secure');
  }
  res.append('Set-Cookie', parts.join('; '));
}

export function cookieKeyForShortCode(code: string): string {
  return code.trim().toUpperCase();
}

export function toWebGuestPhone(guestId: string): string {
  return `${WEB_GUEST_PHONE_PREFIX}${guestId}`;
}

/** Stable web guest phone for this short code. Sets a signed cookie keyed by the code. */
export function ensureWebGuestPhone(
  req: Request,
  res: Response,
  shortCode: string,
): string {
  const key = cookieKeyForShortCode(shortCode);
  const map = readMap(req);
  let guestId = map[key];
  if (!guestId || !UUID_RE.test(guestId)) {
    guestId = crypto.randomUUID();
    map[key] = guestId;
  }
  writeMap(res, map);
  return toWebGuestPhone(guestId);
}
