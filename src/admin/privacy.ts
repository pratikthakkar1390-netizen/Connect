import { organizerGuestDisplayName } from '../commands/organizer.js';
import { isWebGuestPhone, WEB_GUEST_PHONE_PREFIX } from '../config.js';

export function adminGuestLabel(
  name: string | null | undefined,
  phone: string | null | undefined,
): string {
  return organizerGuestDisplayName(name, phone ?? undefined);
}

export function hidesWebGuestId(value: string | null | undefined): boolean {
  const text = value?.trim() ?? '';
  return (
    isWebGuestPhone(text) ||
    text.toLowerCase().startsWith(WEB_GUEST_PHONE_PREFIX)
  );
}
