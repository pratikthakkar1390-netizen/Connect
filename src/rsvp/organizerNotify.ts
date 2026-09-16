import {
  formatPhoneForDisplay,
  organizerGuestDisplayName,
} from '../commands/organizer.js';
import { isWebGuestPhone, WEB_GUEST_PHONE_PREFIX } from '../config.js';
import {
  getGuestName,
  getMessageSession,
  type Event,
  type RsvpStatus,
} from '../db/store.js';
import { sendInboxMessage } from '../zernio/client.js';

export interface OrganizerRsvpNotifyParams {
  event: Event;
  guestPhone: string;
  guestName: string;
  status: RsvpStatus;
  adults: number;
  children: number;
  total: number;
  accountId: string;
}

export function formatOrganizerRsvpNotification(
  eventName: string,
  guestDisplayName: string,
  status: RsvpStatus,
  adults: number,
  children: number,
  total: number,
): string {
  const header =
    status === 'yes' ? '🔔 New RSVP received!' : '🔔 RSVP Update';

  const lines = [header, '', eventName, `👤 ${guestDisplayName}`];

  if (status === 'yes') {
    lines.push('✅ Yes', `👨 Adults: ${adults}`, `👧 Children: ${children}`);
    lines.push(`Total attending: ${total}`);
  } else if (status === 'no') {
    lines.push('❌ No');
  } else if (status === 'maybe') {
    lines.push('🤔 Maybe');
  }

  return lines.join('\n');
}

export function resolveGuestDisplayName(
  eventId: number,
  phone: string,
  senderName: string | undefined,
): string {
  const storedName = getGuestName(eventId, phone)?.trim();
  if (storedName && !storedName.toLowerCase().startsWith(WEB_GUEST_PHONE_PREFIX)) {
    return storedName;
  }
  if (isWebGuestPhone(phone)) {
    return organizerGuestDisplayName(storedName, phone);
  }
  const pushName = senderName?.trim();
  if (pushName && !pushName.toLowerCase().startsWith(WEB_GUEST_PHONE_PREFIX)) {
    return pushName;
  }
  return formatPhoneForDisplay(phone);
}

export async function notifyOrganizerOfRsvp(
  params: OrganizerRsvpNotifyParams,
): Promise<void> {
  const session = getMessageSession(params.event.organizer_phone);
  if (!session) {
    console.warn(
      `No message session for organizer ${params.event.organizer_phone}; skipping RSVP notify`,
    );
    return;
  }

  const message = formatOrganizerRsvpNotification(
    params.event.name,
    params.guestName,
    params.status,
    params.adults,
    params.children,
    params.total,
  );

  await sendInboxMessage({
    conversationId: session.conversation_id,
    accountId: session.account_id || params.accountId,
    message,
  });
}
