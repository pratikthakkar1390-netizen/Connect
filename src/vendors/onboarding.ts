import crypto from 'node:crypto';
import {
  getPublicBaseUrl,
  getWhatsAppBusinessPhoneDigits,
  normalizePhone,
  parseGuestWhatsAppNumber,
} from '../config.js';
import { getDb } from '../db/store.js';

export const PROVIDER_ONBOARDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const PUBLIC_PROVIDER_ONBOARDING_MESSAGE =
  'Hi ZipBite, I want to become a provider.';

export type ProviderOnboardingStep =
  | 'AWAITING_CLAIM'
  | 'BUSINESS_NAME'
  | 'OWNER_NAME'
  | 'CONFIRM_PHONE'
  | 'PICKUP_LOCATION'
  | 'PROVIDER_TYPE'
  | 'MENU_METHOD'
  | 'ORDERING_FREQUENCY'
  | 'PAYMENT_METHOD'
  | 'AVAILABILITY'
  | 'REVIEW'
  | 'COMPLETED';

export interface ProviderOnboardingDraft {
  businessName?: string;
  ownerName?: string;
  pickupLocation?: string;
  providerType?: string;
  menuMethod?: string;
  orderingFrequency?: string;
  paymentMethod?: string;
  availability?: string;
}

export interface ProviderOnboardingSession {
  id: number;
  token_hash: string;
  expected_phone: string;
  vendor_id: number | null;
  step: ProviderOnboardingStep;
  draft_json: string | null;
  expires_at: number;
  claimed_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProviderOnboardingInvite {
  session: ProviderOnboardingSession;
  token: string;
  url: string;
}

function tokenHash(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function validRawToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{40,64}$/.test(token);
}

export function parseProviderPhone(raw: unknown): string | null {
  return parseGuestWhatsAppNumber(raw);
}

export function createProviderOnboardingInvite(input: {
  phone: string;
  nowMs?: number;
  ttlMs?: number;
}): ProviderOnboardingInvite {
  const phone = parseProviderPhone(input.phone);
  if (!phone) {
    throw new Error('Enter a valid WhatsApp number in international format.');
  }
  const nowMs = input.nowMs ?? Date.now();
  const ttlMs = input.ttlMs ?? PROVIDER_ONBOARDING_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error('Invite expiry must be in the future.');
  }
  const token = crypto.randomBytes(32).toString('base64url');
  const database = getDb();
  const session = database.transaction(() => {
    database
      .prepare(
        `UPDATE vendor_onboarding_sessions
         SET expires_at = ?, updated_at = datetime('now')
         WHERE expected_phone = ?
           AND completed_at IS NULL
           AND expires_at > ?`,
      )
      .run(nowMs, phone, nowMs);
    return database
      .prepare(
        `INSERT INTO vendor_onboarding_sessions (
           token_hash, expected_phone, expires_at
         ) VALUES (?, ?, ?)
         RETURNING *`,
      )
      .get(
        tokenHash(token),
        phone,
        nowMs + ttlMs,
      ) as ProviderOnboardingSession;
  })();
  return {
    session,
    token,
    url: providerOnboardingUrl(token),
  };
}

export function providerOnboardingUrl(token: string): string {
  return `${getPublicBaseUrl()}/provider/onboard/${encodeURIComponent(token)}`;
}

export function getProviderOnboardingSessionByToken(
  token: string,
): ProviderOnboardingSession | undefined {
  if (!validRawToken(token)) {
    return undefined;
  }
  return getDb()
    .prepare(
      `SELECT * FROM vendor_onboarding_sessions
       WHERE token_hash = ?
       LIMIT 1`,
    )
    .get(tokenHash(token)) as ProviderOnboardingSession | undefined;
}

export function validateProviderOnboardingToken(
  token: string,
  nowMs = Date.now(),
): ProviderOnboardingSession | undefined {
  const session = getProviderOnboardingSessionByToken(token);
  if (
    !session ||
    session.completed_at ||
    session.expires_at <= nowMs
  ) {
    return undefined;
  }
  return session;
}

export function providerOnboardingWhatsAppUrl(token: string): string | null {
  if (!validateProviderOnboardingToken(token)) {
    return null;
  }
  const digits = getWhatsAppBusinessPhoneDigits();
  if (!digits) {
    return null;
  }
  const text = `ZIPBITE PROVIDER ${token}`;
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

export function publicProviderOnboardingWhatsAppUrl(): string | null {
  const digits = getWhatsAppBusinessPhoneDigits();
  if (!digits) {
    return null;
  }
  return `https://wa.me/${digits}?text=${encodeURIComponent(
    PUBLIC_PROVIDER_ONBOARDING_MESSAGE,
  )}`;
}

export function startPublicProviderOnboardingSession(input: {
  phone: string;
  nowMs?: number;
}): ProviderOnboardingSession {
  const phone = parseProviderPhone(input.phone);
  if (!phone) {
    throw new Error('A valid inbound WhatsApp phone is required.');
  }
  const nowMs = input.nowMs ?? Date.now();
  const active = getActiveProviderOnboardingSession(phone, nowMs);
  if (active) {
    return active;
  }

  const database = getDb();
  return database.transaction(() => {
    database
      .prepare(
        `UPDATE vendor_onboarding_sessions
         SET expires_at = ?, updated_at = datetime('now')
         WHERE expected_phone = ?
           AND completed_at IS NULL
           AND expires_at > ?`,
      )
      .run(nowMs, phone, nowMs);
    const internalToken = crypto.randomBytes(32).toString('base64url');
    return database
      .prepare(
        `INSERT INTO vendor_onboarding_sessions (
           token_hash, expected_phone, step, expires_at, claimed_at
         ) VALUES (?, ?, 'BUSINESS_NAME', ?, datetime('now'))
         RETURNING *`,
      )
      .get(
        tokenHash(internalToken),
        phone,
        nowMs + PROVIDER_ONBOARDING_TTL_MS,
      ) as ProviderOnboardingSession;
  })();
}

export function claimProviderOnboardingSession(input: {
  token: string;
  phone: string;
  nowMs?: number;
}): ProviderOnboardingSession | undefined {
  const phone = normalizePhone(input.phone);
  const nowMs = input.nowMs ?? Date.now();
  if (!validRawToken(input.token)) {
    return undefined;
  }
  return getDb()
    .prepare(
      `UPDATE vendor_onboarding_sessions
       SET claimed_at = COALESCE(claimed_at, datetime('now')),
           step = CASE
             WHEN step = 'AWAITING_CLAIM' THEN 'BUSINESS_NAME'
             ELSE step
           END,
           updated_at = datetime('now')
       WHERE token_hash = ?
         AND expected_phone = ?
         AND completed_at IS NULL
         AND expires_at > ?
       RETURNING *`,
    )
    .get(tokenHash(input.token), phone, nowMs) as
    | ProviderOnboardingSession
    | undefined;
}

export function cancelProviderOnboardingSession(
  phone: string,
  nowMs = Date.now(),
): void {
  getDb()
    .prepare(
      `UPDATE vendor_onboarding_sessions
       SET expires_at = ?, updated_at = datetime('now')
       WHERE expected_phone = ?
         AND completed_at IS NULL
         AND expires_at > ?`,
    )
    .run(nowMs, normalizePhone(phone), nowMs);
}

export function getActiveProviderOnboardingSession(
  phone: string,
  nowMs = Date.now(),
): ProviderOnboardingSession | undefined {
  return getDb()
    .prepare(
      `SELECT * FROM vendor_onboarding_sessions
       WHERE expected_phone = ?
         AND claimed_at IS NOT NULL
         AND completed_at IS NULL
         AND expires_at > ?
       ORDER BY claimed_at DESC, id DESC
       LIMIT 1`,
    )
    .get(normalizePhone(phone), nowMs) as
    | ProviderOnboardingSession
    | undefined;
}

export function parseProviderOnboardingDraft(
  session: ProviderOnboardingSession,
): ProviderOnboardingDraft {
  if (!session.draft_json) {
    return {};
  }
  try {
    const draft = JSON.parse(session.draft_json) as ProviderOnboardingDraft;
    return draft && typeof draft === 'object' ? draft : {};
  } catch {
    return {};
  }
}

export function saveProviderOnboardingSession(input: {
  sessionId: number;
  phone: string;
  step: ProviderOnboardingStep;
  draft: ProviderOnboardingDraft;
  vendorId?: number | null;
}): ProviderOnboardingSession | undefined {
  return getDb()
    .prepare(
      `UPDATE vendor_onboarding_sessions
       SET step = ?,
           draft_json = ?,
           vendor_id = COALESCE(?, vendor_id),
           updated_at = datetime('now')
       WHERE id = ?
         AND expected_phone = ?
         AND completed_at IS NULL
         AND expires_at > ?
       RETURNING *`,
    )
    .get(
      input.step,
      JSON.stringify(input.draft),
      input.vendorId ?? null,
      input.sessionId,
      normalizePhone(input.phone),
      Date.now(),
    ) as ProviderOnboardingSession | undefined;
}

export function completeProviderOnboardingSession(input: {
  sessionId: number;
  phone: string;
  vendorId: number;
}): ProviderOnboardingSession | undefined {
  return getDb()
    .prepare(
      `UPDATE vendor_onboarding_sessions
       SET step = 'COMPLETED',
           vendor_id = ?,
           completed_at = datetime('now'),
           updated_at = datetime('now')
       WHERE id = ?
         AND expected_phone = ?
         AND completed_at IS NULL
         AND expires_at > ?
       RETURNING *`,
    )
    .get(
      input.vendorId,
      input.sessionId,
      normalizePhone(input.phone),
      Date.now(),
    ) as ProviderOnboardingSession | undefined;
}

export function listProviderOnboardingSessions(): ProviderOnboardingSession[] {
  return getDb()
    .prepare(
      `SELECT * FROM vendor_onboarding_sessions
       ORDER BY created_at DESC, id DESC
       LIMIT 100`,
    )
    .all() as ProviderOnboardingSession[];
}
