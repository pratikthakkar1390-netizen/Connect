import { parseRsvpDeadline } from '../dates/eventDate.js';

export interface ParseDeadlineOptions {
  eventDate?: string | null;
  reference?: Date;
  timezone?: string;
}

/** Parse organizer-entered deadline text to epoch ms, or null if unparseable. */
export function parseDeadlineToMs(
  deadline: string | null | undefined,
  options: ParseDeadlineOptions = {},
): number | null {
  const parsed = parseRsvpDeadline(deadline ?? '', {
    eventDate: options.eventDate,
    reference: options.reference,
    timezone: options.timezone,
  });
  return parsed.ok ? parsed.instantMs : null;
}

export interface ReminderDueParams {
  nowMs: number;
  deadline: string;
  reminderDays: number;
  reminderSentAt: string | null;
  eventDate?: string | null;
}

/** Whether an event is inside its one-shot reminder window (pending guests only at send time). */
export function isReminderDue({
  nowMs,
  deadline,
  reminderDays,
  reminderSentAt,
  eventDate,
}: ReminderDueParams): boolean {
  if (reminderSentAt) {
    return false;
  }
  if (!Number.isInteger(reminderDays) || reminderDays < 1) {
    return false;
  }

  const deadlineMs = parseDeadlineToMs(deadline, {
    eventDate,
    reference: new Date(nowMs),
  });
  if (deadlineMs === null) {
    return false;
  }

  // Do not send on or after the RSVP deadline.
  if (nowMs >= deadlineMs) {
    return false;
  }

  const windowStartMs = deadlineMs - reminderDays * 86_400_000;
  return nowMs >= windowStartMs;
}

export function parseReminderDaysChoice(input: string): number | null | undefined {
  const trimmed = input.trim().toUpperCase().replace(/:/g, '_');
  if (
    trimmed === 'NONE' ||
    trimmed === 'NO' ||
    trimmed === 'NO REMINDER' ||
    trimmed === '0' ||
    trimmed === 'REMINDER_NONE'
  ) {
    return null;
  }
  if (
    trimmed === '1' ||
    trimmed === 'REMINDER_1' ||
    trimmed === '1 DAY BEFORE'
  ) {
    return 1;
  }
  if (
    trimmed === '2' ||
    trimmed === 'REMINDER_2' ||
    trimmed === '2 DAYS BEFORE'
  ) {
    return 2;
  }
  if (
    trimmed === '3' ||
    trimmed === 'REMINDER_3' ||
    trimmed === '3 DAYS BEFORE'
  ) {
    return 3;
  }
  return undefined;
}
