import {
  getEventTimezone,
  isPastCalendarIsoDate,
  todayInEventTimezone,
  zonedWallTimeFromInstant,
  zonedWallTimeToUtc,
} from '../../dates/eventDate.js';

export const PICKUP_OPEN_MINUTES = 12 * 60;
export const PICKUP_CLOSE_MINUTES = 20 * 60;

export type PickupValidationReason =
  | 'missing'
  | 'invalid_date'
  | 'invalid_time'
  | 'past_date'
  | 'same_day_closed'
  | 'time_passed'
  | 'closed_monday'
  | 'outside_hours';

export type PickupValidation =
  | { ok: true }
  | { ok: false; reason: PickupValidationReason };

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i;
const TIME_INPUT_RE = /^(\d{1,2}):(\d{2})(?::\d{2})?$/;

let nowFn = (): Date => new Date();

export function setVendorPickupClock(now?: () => Date): void {
  nowFn = now ?? (() => new Date());
}

export function vendorPickupNow(): Date {
  return nowFn();
}

export function parsePickupTime(
  raw: string,
): { hour: number; minute: number } | null {
  const trimmed = raw.trim();
  const twelve = TIME_RE.exec(trimmed);
  if (twelve) {
    const hour12 = Number(twelve[1]);
    const minute = Number(twelve[2]);
    const meridiem = twelve[3].toUpperCase();
    if (
      !Number.isInteger(hour12) ||
      hour12 < 1 ||
      hour12 > 12 ||
      !Number.isInteger(minute) ||
      minute < 0 ||
      minute > 59
    ) {
      return null;
    }
    const hour =
      meridiem === 'AM'
        ? hour12 === 12
          ? 0
          : hour12
        : hour12 === 12
          ? 12
          : hour12 + 12;
    return { hour, minute };
  }
  const input = TIME_INPUT_RE.exec(trimmed);
  if (!input) {
    return null;
  }
  const hour = Number(input[1]);
  const minute = Number(input[2]);
  if (
    !Number.isInteger(hour) ||
    hour < 0 ||
    hour > 23 ||
    !Number.isInteger(minute) ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }
  return { hour, minute };
}

export function formatPickupTime(hour: number, minute: number): string {
  const meridiem = hour >= 12 ? 'PM' : 'AM';
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${hour12}:${String(minute).padStart(2, '0')} ${meridiem}`;
}

export function formatPickupTimeInput(raw: string): string | null {
  const parsed = parsePickupTime(raw);
  if (!parsed) {
    return null;
  }
  return formatPickupTime(parsed.hour, parsed.minute);
}

export function pickupMinutes(hour: number, minute: number): number {
  return hour * 60 + minute;
}

export function isSameDayPickupOpen(now = vendorPickupNow()): boolean {
  const wall = zonedWallTimeFromInstant(now);
  return wall.hour < 12;
}

function addCalendarDays(isoDate: string, days: number): string {
  const match = ISO_DATE_RE.exec(isoDate);
  if (!match) {
    return isoDate;
  }
  const stamp = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]) + days,
    12,
  );
  return new Date(stamp).toISOString().slice(0, 10);
}

export function weekdayInEventTimezone(isoDate: string): string {
  const match = ISO_DATE_RE.exec(isoDate.trim());
  if (!match) {
    return '';
  }
  const stamp = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    12,
  );
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    timeZone: getEventTimezone(),
  }).format(new Date(stamp));
}

export function isPickupClosedDay(isoDate: string): boolean {
  return weekdayInEventTimezone(isoDate) === 'Monday';
}

export function minSelectablePickupDate(now = vendorPickupNow()): string {
  const today = todayInEventTimezone({ reference: now });
  let date =
    isSameDayPickupOpen(now) && !isPickupClosedDay(today)
      ? today
      : addCalendarDays(today, 1);
  for (let i = 0; i < 14; i += 1) {
    if (!isPickupClosedDay(date)) {
      return date;
    }
    date = addCalendarDays(date, 1);
  }
  return date;
}

export function pickupInstantUtc(
  pickupDate: string,
  pickupTime: string,
): Date | null {
  const match = ISO_DATE_RE.exec(pickupDate.trim());
  const time = parsePickupTime(pickupTime);
  if (!match || !time) {
    return null;
  }
  return zonedWallTimeToUtc(
    {
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3]),
      hour: time.hour,
      minute: time.minute,
      second: 0,
    },
    getEventTimezone(),
  );
}

export function validateVendorPickupDate(
  pickupDate: string | null | undefined,
  now = vendorPickupNow(),
): PickupValidation {
  const date = pickupDate?.trim() ?? '';
  if (!date) {
    return { ok: false, reason: 'missing' };
  }
  if (!ISO_DATE_RE.test(date)) {
    return { ok: false, reason: 'invalid_date' };
  }
  if (isPickupClosedDay(date)) {
    return { ok: false, reason: 'closed_monday' };
  }
  if (isPastCalendarIsoDate(date, { reference: now })) {
    return { ok: false, reason: 'past_date' };
  }
  const today = todayInEventTimezone({ reference: now });
  if (date === today && !isSameDayPickupOpen(now)) {
    return { ok: false, reason: 'same_day_closed' };
  }
  return { ok: true };
}

export function validateVendorPickup(
  pickupDate: string | null | undefined,
  pickupTime: string | null | undefined,
  now = vendorPickupNow(),
): PickupValidation {
  const dateCheck = validateVendorPickupDate(pickupDate, now);
  if (!dateCheck.ok) {
    return dateCheck;
  }
  const formatted = formatPickupTimeInput(pickupTime ?? '');
  if (!formatted) {
    return { ok: false, reason: pickupTime?.trim() ? 'invalid_time' : 'missing' };
  }
  const time = parsePickupTime(formatted);
  if (!time) {
    return { ok: false, reason: 'invalid_time' };
  }
  const minutes = pickupMinutes(time.hour, time.minute);
  if (minutes < PICKUP_OPEN_MINUTES || minutes > PICKUP_CLOSE_MINUTES) {
    return { ok: false, reason: 'outside_hours' };
  }
  const instant = pickupInstantUtc(pickupDate!.trim(), formatted);
  if (!instant) {
    return { ok: false, reason: 'invalid_time' };
  }
  if (instant.getTime() <= now.getTime()) {
    return { ok: false, reason: 'time_passed' };
  }
  return { ok: true };
}

export function pickupValidationMessage(reason: PickupValidationReason): string {
  switch (reason) {
    case 'past_date':
      return 'Please choose today or a future date.';
    case 'same_day_closed':
      return 'Same-day pickup is only available before 12:00 PM. Please choose another date.';
    case 'time_passed':
      return 'That pickup time has already passed. Please choose a later time.';
    case 'closed_monday':
      return 'Pickup is not available on Monday. Please choose Tuesday through Sunday.';
    case 'outside_hours':
      return 'Pickup is available from 12:00 PM to 8:00 PM.';
    case 'missing':
      return 'Please choose a pickup date and time.';
    default:
      return 'Please choose a valid pickup date and time.';
  }
}
