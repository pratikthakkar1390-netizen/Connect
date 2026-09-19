import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

export const config = {
  port: parseInt(optional('PORT', '3000'), 10),
  databasePath: optional('DATABASE_PATH', './data/rsvp.db'),
  zernioApiKey: optional('ZERNIO_API_KEY'),
  zernioProfileId: optional('ZERNIO_PROFILE_ID'),
  zernioWhatsappAccountId: optional('ZERNIO_WHATSAPP_ACCOUNT_ID'),
  webhookSecret: optional('WEBHOOK_SECRET'),
  organizerPhone: optional('ORGANIZER_PHONE'),
  coOrganizerPhones: optional('CO_ORGANIZER_PHONES')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean),
  /** WhatsApp Business number for wa.me RSVP links (E.164, e.g. +15551234567). */
  whatsappBusinessPhone: optional('WHATSAPP_BUSINESS_PHONE'),
  rsvpTemplateName: optional('RSVP_TEMPLATE_NAME', 'event_rsvp_invite'),
  rsvpTemplateLanguage: optional('RSVP_TEMPLATE_LANGUAGE', 'en_US'),
  /** Set only after Meta approves the reminder template; unset disables reminder UI + scheduler. */
  reminderTemplateName: optional('REMINDER_TEMPLATE_NAME'),
  reminderTemplateLanguage: optional('REMINDER_TEMPLATE_LANGUAGE', 'en_US'),
  /** Optional Meta templates for out-of-window event updates. Unset = inbox only. */
  eventUpdateTemplateName: optional('EVENT_UPDATE_TEMPLATE_NAME'),
  eventUpdateAckTemplateName: optional('EVENT_UPDATE_ACK_TEMPLATE_NAME'),
  eventCancelTemplateName: optional('EVENT_CANCEL_TEMPLATE_NAME'),
  eventUpdateTemplateLanguage: optional('EVENT_UPDATE_TEMPLATE_LANGUAGE', 'en_US'),
  publicWebhookUrl: optional('PUBLIC_WEBHOOK_URL'),
  /** Password for /admin dashboard (HTTP Basic Auth). Unset = admin disabled. */
  adminPassword: optional('ADMIN_PASSWORD'),
  /** IANA timezone for parsing event dates (e.g. America/New_York). */
  eventTimezone: optional('EVENT_TIMEZONE', 'America/New_York'),
};

const DEFAULT_PUBLIC_BASE_URL = 'https://connect.zip-bite.com';

/** Public origin for short RSVP URLs. Override with PUBLIC_BASE_URL. */
export function getPublicBaseUrl(): string {
  const raw = optional('PUBLIC_BASE_URL', DEFAULT_PUBLIC_BASE_URL).trim();
  return (raw || DEFAULT_PUBLIC_BASE_URL).replace(/\/+$/, '');
}

export function getOrganizerPhones(): string[] {
  const phones = new Set<string>();
  if (config.organizerPhone) {
    phones.add(normalizePhone(config.organizerPhone));
  }
  for (const phone of config.coOrganizerPhones) {
    phones.add(normalizePhone(phone));
  }
  return [...phones];
}

export function isOrganizer(phone: string): boolean {
  const normalized = normalizePhone(phone);
  return getOrganizerPhones().includes(normalized);
}

export const WEB_GUEST_PHONE_PREFIX = 'web:';

/** Synthetic guest key for web RSVPs (no WhatsApp number). Survives store phone lookups. */
export function isWebGuestPhone(phone: string): boolean {
  return phone.trim().toLowerCase().startsWith(WEB_GUEST_PHONE_PREFIX);
}

export function normalizePhone(phone: string): string {
  const trimmed = phone.trim();
  if (isWebGuestPhone(trimmed)) {
    return `${WEB_GUEST_PHONE_PREFIX}${trimmed.slice(WEB_GUEST_PHONE_PREFIX.length)}`;
  }
  if (trimmed.startsWith('+')) {
    return trimmed;
  }
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 10) {
    return `+1${digits}`;
  }
  if (digits.length === 11 && digits.startsWith('1')) {
    return `+${digits}`;
  }
  return `+${digits}`;
}

const E164_RE = /^\+[1-9]\d{7,14}$/;

/** Guest-entered WhatsApp number for Individual web RSVP. Rejects web: ids and junk. */
export function parseGuestWhatsAppNumber(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed || isWebGuestPhone(trimmed)) {
    return null;
  }
  const normalized = normalizePhone(trimmed);
  return E164_RE.test(normalized) ? normalized : null;
}

export function isReminderSendingEnabled(): boolean {
  return Boolean(config.reminderTemplateName?.trim());
}

export function eventUpdateTemplateName(): string | undefined {
  return nonemptyEnv(
    process.env.EVENT_UPDATE_TEMPLATE_NAME ?? config.eventUpdateTemplateName,
  );
}

export function eventUpdateAckTemplateName(): string | undefined {
  return nonemptyEnv(
    process.env.EVENT_UPDATE_ACK_TEMPLATE_NAME ??
      config.eventUpdateAckTemplateName,
  );
}

export function eventCancelTemplateName(): string | undefined {
  return nonemptyEnv(
    process.env.EVENT_CANCEL_TEMPLATE_NAME ?? config.eventCancelTemplateName,
  );
}

function nonemptyEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

/** Live CONNECT WhatsApp account id; prefers process.env so tests can override. */
export function connectWhatsAppAccountId(): string | undefined {
  return nonemptyEnv(process.env.ZERNIO_WHATSAPP_ACCOUNT_ID) ??
    nonemptyEnv(config.zernioWhatsappAccountId);
}

/** True when inbound traffic belongs on the existing CONNECT routing path. */
export function isConnectWhatsAppAccount(accountId: string): boolean {
  const connect = connectWhatsAppAccountId();
  if (!connect) {
    return true;
  }
  return accountId.trim() === connect;
}

export function assertConfigForRuntime(): void {
  required('ZERNIO_API_KEY');
  required('ZERNIO_PROFILE_ID');
  required('ZERNIO_WHATSAPP_ACCOUNT_ID');
  required('WEBHOOK_SECRET');
  required('ORGANIZER_PHONE');
}

export function assertConfigForZernioScripts(): void {
  required('ZERNIO_API_KEY');
  required('ZERNIO_WHATSAPP_ACCOUNT_ID');
}

/** Digits-only WhatsApp Business number, read at call time so tests can set env. */
export function getWhatsAppBusinessPhoneDigits(
  businessPhone?: string,
): string {
  const raw =
    businessPhone ??
    process.env.WHATSAPP_BUSINESS_PHONE ??
    config.whatsappBusinessPhone;
  return (raw ?? '').replace(/\D/g, '');
}

/**
 * Open a WhatsApp chat with the business number (no prefilled RSVP text).
 * `https` is wa.me; `app` is the whatsapp:// deep link for iOS/Android.
 */
export function buildWhatsAppChatLinks(businessPhone?: string): {
  https: string | null;
  app: string | null;
} {
  const digits = getWhatsAppBusinessPhoneDigits(businessPhone);
  if (!digits) {
    return { https: null, app: null };
  }
  return {
    https: `https://wa.me/${digits}`,
    app: `whatsapp://send?phone=${digits}`,
  };
}

/**
 * Click-to-chat RSVP URL with prefilled invitation message.
 * Uses short rsvp_code (not the 32-hex rsvp_token).
 * Returns null when no business phone is available.
 */
export function buildRsvpWhatsAppLink(
  code: string,
  businessPhone = config.whatsappBusinessPhone,
): string | null {
  const digits = getWhatsAppBusinessPhoneDigits(businessPhone);
  if (!digits) {
    return null;
  }
  const text = `Hi! I received an invitation. Please show me how to respond. Code: ${code}`;
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

/** Public short RSVP URL shown in invitations: https://connect.zip-bite.com/r/XXXXXX */
export function buildShortRsvpUrl(shortCode: string): string {
  return `${getPublicBaseUrl()}/r/${encodeURIComponent(shortCode.trim())}`;
}

/** Public web acknowledgement URL: https://connect.zip-bite.com/a/:token */
export function buildAckUpdateUrl(token: string): string {
  return `${getPublicBaseUrl()}/a/${encodeURIComponent(token.trim())}`;
}

/** Public organizer date/time picker: https://connect.zip-bite.com/when/:token */
export function buildEventWhenUrl(token: string): string {
  return `${getPublicBaseUrl()}/when/${encodeURIComponent(token.trim())}`;
}

/** Public short picker URL: https://connect.zip-bite.com/d/XXXXXX */
export function buildEventWhenShortUrl(shortCode: string): string {
  return `${getPublicBaseUrl()}/d/${encodeURIComponent(shortCode.trim())}`;
}
