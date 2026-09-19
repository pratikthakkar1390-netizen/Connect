import crypto from 'node:crypto';
import { getPublicBaseUrl, normalizePhone } from '../config.js';

export interface VendorPickupPayload {
  phone: string;
  accountId: string;
  vendorId: number;
  exp: number;
}

export const VENDOR_PICKUP_TOKEN_TTL_MS = 2 * 60 * 60 * 1000;

function pickerSecret(): string {
  return (
    process.env.RSVP_GUEST_SECRET?.trim() ||
    process.env.WEBHOOK_SECRET?.trim() ||
    'connect-vendor-pickup'
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

export function signVendorPickupToken(
  phone: string,
  accountId: string,
  vendorId: number,
  nowMs = Date.now(),
): string {
  const payload = {
    p: normalizePhone(phone),
    a: accountId.trim(),
    v: vendorId,
    e: nowMs + VENDOR_PICKUP_TOKEN_TTL_MS,
  };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const mac = crypto
    .createHmac('sha256', pickerSecret())
    .update(body)
    .digest('base64url');
  return `${body}.${mac}`;
}

export function verifyVendorPickupToken(
  token: string,
  nowMs = Date.now(),
): VendorPickupPayload | null {
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
    ) as { p?: unknown; a?: unknown; v?: unknown; e?: unknown };
    if (
      typeof parsed.p !== 'string' ||
      typeof parsed.a !== 'string' ||
      typeof parsed.v !== 'number' ||
      !Number.isInteger(parsed.v) ||
      typeof parsed.e !== 'number'
    ) {
      return null;
    }
    if (parsed.e <= nowMs) {
      return null;
    }
    return {
      phone: normalizePhone(parsed.p),
      accountId: parsed.a.trim(),
      vendorId: parsed.v,
      exp: parsed.e,
    };
  } catch {
    return null;
  }
}

export function vendorPickupPickerPath(
  phone: string,
  accountId: string,
  vendorId: number,
  nowMs = Date.now(),
): string {
  return `/pickup/${encodeURIComponent(signVendorPickupToken(phone, accountId, vendorId, nowMs))}`;
}

export function vendorPickupPickerUrl(
  phone: string,
  accountId: string,
  vendorId: number,
  nowMs = Date.now(),
): string {
  return `${getPublicBaseUrl()}${vendorPickupPickerPath(phone, accountId, vendorId, nowMs)}`;
}
