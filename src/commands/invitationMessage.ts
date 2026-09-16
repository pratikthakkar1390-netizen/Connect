import type { Event } from '../db/store.js';

export const INVITATION_FORWARD_INSTRUCTION =
  'Forward the invitation above to your guests. Invite more, or tap Done.';

export function formatShareRsvpInvitation(
  event: Event,
  link: string | null,
  rsvpCode: string = event.rsvp_code,
): string {
  const lines = [
    "🎉 You're Invited!",
    '',
    event.name,
    '',
    `📅 ${event.date}`,
  ];

  if (event.location?.trim()) {
    lines.push(`📍 ${event.location.trim()}`);
  }

  lines.push('', '💌 Please RSVP here:');

  if (link) {
    lines.push(link);
  } else {
    lines.push(`RSVP ${rsvpCode}`);
  }

  lines.push('', "We'd love to have you join us!");

  return lines.join('\n');
}

export async function sendInvitationWithForwardInstruction(
  send: (message: string) => Promise<void>,
  invitation: string,
): Promise<void> {
  await send(invitation);
  try {
    await send(INVITATION_FORWARD_INSTRUCTION);
  } catch (error) {
    console.error('Failed to send invitation forward instruction:', error);
  }
}
