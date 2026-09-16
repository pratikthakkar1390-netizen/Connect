import { buildShortRsvpUrl } from '../config.js';
import type { Event, EventUpdateAckCounts } from '../db/store.js';
import { themeLabel } from '../events/theme.js';

export function splitEventWhen(date: string): {
  dateLabel: string;
  timeLabel: string | null;
} {
  const match = date.trim().match(/^(.*?)\s+at\s+(.+)$/i);
  if (match) {
    return { dateLabel: match[1].trim(), timeLabel: match[2].trim() };
  }
  return { dateLabel: date.trim(), timeLabel: null };
}

export function formatEventDetailLines(
  name: string,
  date: string,
  location: string,
): string {
  const when = splitEventWhen(date);
  const lines = [name, '', `📅 ${when.dateLabel}`];
  if (when.timeLabel) {
    lines.push(`⏰ ${when.timeLabel}`);
  }
  if (location.trim()) {
    lines.push(`📍 ${location.trim()}`);
  }
  return lines.join('\n');
}

export function formatEditedEventReview(event: Event): string {
  const extras: string[] = [];
  if (event.theme === 'custom' && event.custom_theme?.trim()) {
    extras.push(`🎨 Event Style: ${event.custom_theme.trim()}`);
  } else {
    const label = themeLabel(event.theme);
    if (label) {
      extras.push(`🎨 Event Style: ${label}`);
    }
  }
  if (event.dress_code?.trim()) {
    extras.push(`👗 What to Wear: ${event.dress_code.trim()}`);
  }
  if (event.image_filename?.trim()) {
    extras.push('🖼️ Event Image: Added');
  }
  return [
    '✅ Event updated!',
    '',
    formatEventDetailLines(event.name, event.date, event.location),
    ...(extras.length ? ['', ...extras] : []),
    '',
    'Would you like to notify your guests?',
  ].join('\n');
}

export function rsvpLinkForEvent(event: Event): string | null {
  return event.short_code ? buildShortRsvpUrl(event.short_code) : null;
}

function appendOptionalMessage(lines: string[], message?: string | null): void {
  const trimmed = message?.trim();
  if (trimmed) {
    lines.push(trimmed, '');
  }
}

export function formatInfoUpdateMessage(
  event: Event,
  message?: string | null,
): string {
  const lines = [
    '📢 Event Update',
    '',
    `There has been an update to ${event.name}.`,
    '',
  ];
  appendOptionalMessage(lines, message);
  const when = splitEventWhen(event.date);
  lines.push(`📅 ${when.dateLabel}`);
  if (when.timeLabel) {
    lines.push(`⏰ ${when.timeLabel}`);
  }
  lines.push(`📍 ${event.location}`, '', 'Please check the latest event details.');
  const link = rsvpLinkForEvent(event);
  if (link) {
    lines.push('', '💌 RSVP / Update your response:', link);
  }
  return lines.join('\n');
}

export function formatAckUpdateMessage(
  event: Event,
  message?: string | null,
  ackUrl?: string | null,
): string {
  const lines = [
    '⚠️ Important Event Update',
    '',
    `There has been an important update to ${event.name}.`,
    '',
  ];
  appendOptionalMessage(lines, message);
  const when = splitEventWhen(event.date);
  lines.push(`📅 ${when.dateLabel}`);
  if (when.timeLabel) {
    lines.push(`⏰ ${when.timeLabel}`);
  }
  lines.push(
    `📍 ${event.location}`,
    '',
    'Please review the updated event details.',
  );
  if (ackUrl?.trim()) {
    lines.push('', '👉 Review & Acknowledge:', ackUrl.trim());
  }
  return lines.join('\n');
}

export function formatCancelGuestMessage(event: Event): string {
  const when = splitEventWhen(event.date);
  const lines = [
    '❌ Event Cancelled',
    '',
    `${event.name} has been cancelled by the organizer.`,
    '',
    `📅 ${when.dateLabel}`,
  ];
  if (when.timeLabel) {
    lines.push(`⏰ ${when.timeLabel}`);
  }
  lines.push(`📍 ${event.location}`);
  return lines.join('\n');
}

export function formatGuestAckThankYou(event: Event): string {
  const when = splitEventWhen(event.date);
  const lines = [
    '✅ Thank you!',
    '',
    'Your acknowledgement has been recorded.',
    '',
    'The latest event details are:',
    '',
    `📅 ${when.dateLabel}`,
  ];
  if (when.timeLabel) {
    lines.push(`⏰ ${when.timeLabel}`);
  }
  lines.push(`📍 ${event.location}`);
  return lines.join('\n');
}

export function formatUpdateStatusMessage(
  eventName: string,
  counts: EventUpdateAckCounts,
): string {
  return [
    '📢 Update Status',
    '',
    eventName,
    '',
    `Acknowledged: ${counts.acknowledged} / ${counts.sent}`,
    '',
    `✅ ${counts.acknowledged} acknowledged`,
    `⏳ ${counts.awaiting} awaiting acknowledgement`,
  ].join('\n');
}

export function formatEveryoneAcknowledgedMessage(
  eventName: string,
  sentCount: number,
): string {
  return [
    '🎉 Everyone has acknowledged the update!',
    '',
    eventName,
    '',
    `All ${sentCount} invited guests have confirmed they received the latest event update.`,
  ].join('\n');
}

export function formatInfoSendConfirmation(
  eventName: string,
  sent: number,
  failed: number,
): string {
  const lines = ['✅ Update sent', '', eventName, '', `Sent to ${sent} guest${sent === 1 ? '' : 's'}.`];
  if (failed > 0) {
    lines.push(`Could not deliver to ${failed} guest${failed === 1 ? '' : 's'}.`);
  }
  return lines.join('\n');
}

export function formatCancelConfirmation(
  eventName: string,
  sent = 0,
  failed = 0,
): string {
  const lines = ['❌ Event cancelled.', '', eventName, ''];
  if (sent > 0) {
    lines.push(
      `${sent} guest${sent === 1 ? ' was' : 's were'} notified.`,
    );
  } else {
    lines.push('No guests were notified.');
  }
  if (failed > 0) {
    lines.push(
      `${failed} notification${failed === 1 ? '' : 's'} could not be sent.`,
    );
  }
  lines.push('', 'Existing RSVPs are still saved.');
  return lines.join('\n');
}

export function formatViewEventMessage(event: Event): string {
  const lines = [
    formatEventDetailLines(event.name, event.date, event.location),
  ];
  const link = rsvpLinkForEvent(event);
  if (link) {
    lines.push('', '💌 RSVP / Update your response:', link);
  }
  return lines.join('\n');
}
