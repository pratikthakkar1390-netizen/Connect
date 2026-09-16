import { getWhatsAppBusinessPhoneDigits } from '../config.js';

export const SAVE_CONNECT_CONTACT = 'SAVE_CONNECT_CONTACT';
export const CONNECT_VCARD_PATH = '/connect.vcf';
export const CONNECT_VCARD_FILENAME = 'CONNECT.vcf';
export const CONNECT_CONTACT_NAME = 'CONNECT';

/** vCard for the CONNECT WhatsApp business number. Null when the number is unset. */
export function buildConnectVCard(businessPhone?: string): string | null {
  const digits = getWhatsAppBusinessPhoneDigits(businessPhone);
  if (!digits) {
    return null;
  }
  return [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `FN:${CONNECT_CONTACT_NAME}`,
    `N:${CONNECT_CONTACT_NAME};;;;`,
    `TEL;TYPE=CELL,VOICE:+${digits}`,
    'END:VCARD',
    '',
  ].join('\r\n');
}

export const GUEST_RSVP_THANK_YOU = `✅ Thank you! Your RSVP has been recorded.

Please save our number to your contacts so you can easily find CONNECT when you need it.

Powered by zipbite`;

export const ORGANIZER_POST_EVENT_MESSAGE = `🎉 Thank you for using CONNECT!

We hope your event was wonderful and memorable.

Keep our number saved for your next event.

Powered by zipbite`;

export interface SaveContactContext {
  conversationId: string;
  accountId: string;
}

/** Contact cards are no longer sent. Kept so callers and legacy buttons stay safe. */
export async function sendSaveContactPrompt(
  _ctx: SaveContactContext,
): Promise<void> {
  return;
}

/** Handles leftover SAVE_CONNECT_CONTACT button taps without sending a contact card. */
export async function handleSaveConnectContact(
  _ctx: SaveContactContext,
): Promise<void> {
  return;
}

/** Legacy wa.me fallback — no longer sends a save-number prompt. */
export async function sendSaveConnectContactWaMeFallback(
  _ctx: SaveContactContext,
): Promise<void> {
  return;
}

export function isSaveConnectContactCommand(input: string): boolean {
  return input.trim().toUpperCase() === SAVE_CONNECT_CONTACT;
}
