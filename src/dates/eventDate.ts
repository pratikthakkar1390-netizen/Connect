import * as chrono from 'chrono-node';
import { config } from '../config.js';
import { formatTimezoneLabel, isValidIanaTimeZone } from '../timezones/catalog.js';

export type ParseEventDateFailureReason =
  | 'unparseable'
  | 'ambiguous'
  | 'missingMeridiem'
  | 'vagueTime';

export type EventTimeIssue = 'missingMeridiem' | 'vague';

export interface ParseEventDateSuccess {
  ok: true;
  formatted: string;
  hasTime: boolean;
  /** Set when a date was understood but the clock time is not usable yet. */
  timeIssue?: EventTimeIssue;
}

export interface ParseEventDateFailure {
  ok: false;
  reason: ParseEventDateFailureReason;
}

export type ParseEventDateResult = ParseEventDateSuccess | ParseEventDateFailure;

export interface ParseEventDateOptions {
  reference?: Date;
  timezone?: string;
}

export interface ParseRsvpDeadlineOptions extends ParseEventDateOptions {
  /** Used to pin the year of yearless deadlines (e.g. "Sept 15"). */
  eventDate?: string | null;
}

export interface ParseRsvpDeadlineSuccess extends ParseEventDateSuccess {
  /** Instant used for closed/reminder comparisons. Date-only = 11:59:59 PM EVENT_TIMEZONE. */
  instantMs: number;
}

export type ParseRsvpDeadlineResult =
  | ParseRsvpDeadlineSuccess
  | ParseEventDateFailure;

export function getEventTimezone(): string {
  return config.eventTimezone;
}

/** Legacy fallback only when an event/draft has no valid IANA timezone. */
export function resolveEventTimezone(timezone?: string | null): string {
  const trimmed = timezone?.trim() ?? '';
  if (trimmed && isValidIanaTimeZone(trimmed)) {
    return trimmed;
  }
  const fallback = getEventTimezone();
  return isValidIanaTimeZone(fallback) ? fallback : 'America/New_York';
}

export interface ZonedWallTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export interface EventSchedule {
  timezone: string;
  hasTime: boolean;
  wall: ZonedWallTime;
  instant: Date;
}

function zonedClockParts(date: Date, timezone: string): ZonedWallTime {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    hour: value('hour'),
    minute: value('minute'),
    second: value('second'),
  };
}

/** Wall-clock parts of `date` in `timezone` (default EVENT_TIMEZONE). */
export function zonedWallTimeFromInstant(
  date: Date,
  timezone?: string,
): ZonedWallTime {
  return zonedClockParts(date, timezone ?? getEventTimezone());
}

/**
 * Canonical start schedule for a stored event date string.
 * Uses parseEventDate + EVENT_TIMEZONE wall time — not JS date-string parsing.
 */
export function resolveEventSchedule(
  eventDateText: string,
  options: ParseEventDateOptions = {},
): EventSchedule | null {
  const timezone = options.timezone ?? getEventTimezone();
  const reference = options.reference ?? new Date();
  const parsed = parseEventDate(eventDateText, { timezone, reference });
  if (!parsed.ok) {
    return null;
  }
  const instantMs = getEventInstantMs(eventDateText, { timezone, reference });
  if (instantMs == null) {
    return null;
  }
  const instant = new Date(instantMs);
  return {
    timezone,
    hasTime: parsed.hasTime,
    wall: zonedClockParts(instant, timezone),
    instant,
  };
}

/** Offset east of UTC in minutes for an IANA timezone at `date`. */
export function offsetMinutesAt(date: Date, timezone: string): number {
  const shown = zonedClockParts(date, timezone);
  const wallAsUtc = Date.UTC(
    shown.year,
    shown.month - 1,
    shown.day,
    shown.hour,
    shown.minute,
    shown.second,
  );
  return Math.round((wallAsUtc - date.getTime()) / 60_000);
}

/**
 * Convert a local wall clock in `timezone` to a UTC instant.
 * Chrono-node does not understand IANA names like America/New_York, so
 * `start.date()` would treat 7:00 PM as system-local (UTC on Railway → 3:00 PM EDT).
 */
export function zonedWallTimeToUtc(
  wall: ZonedWallTime,
  timezone: string,
): Date {
  const target = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second,
  );
  let instant = target;
  for (let i = 0; i < 4; i++) {
    const shown = zonedClockParts(new Date(instant), timezone);
    const shownUtc = Date.UTC(
      shown.year,
      shown.month - 1,
      shown.day,
      shown.hour,
      shown.minute,
      shown.second,
    );
    const diff = shownUtc - target;
    if (diff === 0) {
      break;
    }
    instant -= diff;
  }
  return new Date(instant);
}

function wallClockMatches(
  instant: Date,
  wall: ZonedWallTime,
  timezone: string,
): boolean {
  const shown = zonedClockParts(instant, timezone);
  return (
    shown.year === wall.year &&
    shown.month === wall.month &&
    shown.day === wall.day &&
    shown.hour === wall.hour &&
    shown.minute === wall.minute
  );
}

/** False for DST spring-forward gaps (no such local time). */
export function isValidZonedWallTime(wall: ZonedWallTime, timezone: string): boolean {
  return wallClockMatches(zonedWallTimeToUtc(wall, timezone), wall, timezone);
}

function chronoRef(reference: Date, timezone: string) {
  return {
    instant: reference,
    timezone: offsetMinutesAt(reference, timezone),
  };
}

function instantFromParsed(
  parsed: chrono.ParsedResult,
  timezone: string,
): Date {
  // ISO/offset timestamps already name an instant. Do not re-read their
  // clock fields as EVENT_TIMEZONE wall time.
  if (parsed.start.isCertain('timezoneOffset')) {
    const text = parsed.text.trim();
    if (/[zZ]$/.test(text) || /[+-]\d{2}:?\d{2}$/.test(text)) {
      return parsed.start.date();
    }
  }
  return zonedWallTimeToUtc(
    {
      year: parsed.start.get('year') ?? 0,
      month: parsed.start.get('month') ?? 1,
      day: parsed.start.get('day') ?? 1,
      hour: parsed.start.get('hour') ?? 12,
      minute: parsed.start.get('minute') ?? 0,
      second: parsed.start.get('second') ?? 0,
    },
    timezone,
  );
}

export function parseEventDate(
  text: string,
  options: ParseEventDateOptions = {},
): ParseEventDateResult {
  const trimmed = text.trim();
  if (!trimmed) {
    return { ok: false, reason: 'unparseable' };
  }

  const timezone = options.timezone ?? getEventTimezone();
  const reference = options.reference ?? new Date();
  const results = chrono.parse(trimmed, chronoRef(reference, timezone));

  if (results.length === 0) {
    return { ok: false, reason: 'unparseable' };
  }

  const candidates = preferDatedResults(results);
  if (isAmbiguous(candidates)) {
    return { ok: false, reason: 'ambiguous' };
  }

  const parsed = candidates[0];
  const timeClass = classifyEventTime(parsed);
  const hasDate = hasExplicitDate(parsed);

  const instant = instantFromParsed(parsed, timezone);
  if (
    timeClass === 'complete' &&
    !wallClockMatches(
      instant,
      {
        year: parsed.start.get('year') ?? 0,
        month: parsed.start.get('month') ?? 1,
        day: parsed.start.get('day') ?? 1,
        hour: parsed.start.get('hour') ?? 0,
        minute: parsed.start.get('minute') ?? 0,
        second: parsed.start.get('second') ?? 0,
      },
      timezone,
    )
  ) {
    return { ok: false, reason: 'unparseable' };
  }

  if (timeClass === 'complete') {
    return {
      ok: true,
      formatted: formatEventDate(instant, true, timezone),
      hasTime: true,
    };
  }

  if (hasDate && timeClass === 'missing') {
    return {
      ok: true,
      formatted: formatEventDate(instant, false, timezone),
      hasTime: false,
    };
  }

  if (hasDate && timeClass === 'missingMeridiem') {
    return {
      ok: true,
      formatted: formatEventDate(instant, false, timezone),
      hasTime: false,
      timeIssue: 'missingMeridiem',
    };
  }

  if (hasDate && timeClass === 'vague') {
    return {
      ok: true,
      formatted: formatEventDate(instant, false, timezone),
      hasTime: false,
      timeIssue: 'vague',
    };
  }

  if (timeClass === 'missingMeridiem') {
    return { ok: false, reason: 'missingMeridiem' };
  }

  if (timeClass === 'vague') {
    return { ok: false, reason: 'vagueTime' };
  }

  return { ok: false, reason: 'unparseable' };
}

export function parseEventTime(
  timeText: string,
  dateOnlyFormatted: string,
  options: ParseEventDateOptions = {},
): ParseEventDateResult {
  const trimmed = timeText.trim();
  const dateText = dateOnlyFormatted.trim();
  if (!trimmed || !dateText) {
    return { ok: false, reason: 'unparseable' };
  }

  const timezone = options.timezone ?? getEventTimezone();
  const reference = options.reference ?? new Date();
  const combinedText = `${dateText} at ${trimmed}`;
  const results = chrono.parse(combinedText, chronoRef(reference, timezone));

  if (results.length === 0) {
    return { ok: false, reason: 'unparseable' };
  }

  const complete = results.filter((result) => classifyEventTime(result) === 'complete');
  if (complete.length === 1) {
    const instant = instantFromParsed(complete[0], timezone);
    const start = complete[0].start;
    if (
      !wallClockMatches(
        instant,
        {
          year: start.get('year') ?? 0,
          month: start.get('month') ?? 1,
          day: start.get('day') ?? 1,
          hour: start.get('hour') ?? 0,
          minute: start.get('minute') ?? 0,
          second: start.get('second') ?? 0,
        },
        timezone,
      )
    ) {
      return { ok: false, reason: 'unparseable' };
    }
    return {
      ok: true,
      formatted: formatEventDate(instant, true, timezone),
      hasTime: true,
    };
  }
  if (complete.length > 1 && isAmbiguous(complete)) {
    return { ok: false, reason: 'ambiguous' };
  }

  const timeOnly = chrono.parse(trimmed, chronoRef(reference, timezone));
  const timeClass = classifyEventTime(
    timeOnly[0] ?? results.find((result) => classifyEventTime(result) !== 'missing') ?? results[0],
  );
  if (timeClass === 'missingMeridiem') {
    return { ok: false, reason: 'missingMeridiem' };
  }
  if (timeClass === 'vague') {
    return { ok: false, reason: 'vagueTime' };
  }
  return { ok: false, reason: 'unparseable' };
}

/**
 * Parse an RSVP deadline with the same chrono + EVENT_TIMEZONE approach as event dates.
 *
 * Yearless inputs ("Sept 15", "September 8") take the event date's year when
 * available, otherwise the current year in EVENT_TIMEZONE. If that calendar
 * date has already passed relative to the reference ("now" on create), chrono
 * uses the same implied-year rule as parseEventDate.
 *
 * Date-only deadlines close at 11:59:59 PM in EVENT_TIMEZONE (end of that
 * calendar day), not UTC midnight and not Date.parse's year 2001.
 * Deadlines that include a time use that time. Year-bearing strings are
 * chrono-parsed in EVENT_TIMEZONE as-is.
 *
 * Chrono-node does not understand IANA names like America/New_York (only
 * abbreviations/offsets). Wall-clock components are converted with Intl so a
 * 7:00 PM EVENT_TIMEZONE time is not stored as 7:00 PM UTC (3:00 PM EDT).
 */
export function parseRsvpDeadline(
  text: string,
  options: ParseRsvpDeadlineOptions = {},
): ParseRsvpDeadlineResult {
  const trimmed = text.trim();
  if (!trimmed) {
    return { ok: false, reason: 'unparseable' };
  }

  const timezone = options.timezone ?? getEventTimezone();
  const fallbackRef = options.reference ?? new Date();
  const reference = resolveDeadlineReference(
    options.eventDate,
    fallbackRef,
    timezone,
  );
  const results = chrono.parse(trimmed, chronoRef(reference, timezone));

  if (results.length === 0) {
    return { ok: false, reason: 'unparseable' };
  }

  if (isAmbiguous(results)) {
    return { ok: false, reason: 'ambiguous' };
  }

  const parsed = results[0];
  const hasTime = hasExplicitTime(parsed);
  const date = instantFromParsed(parsed, timezone);
  const formatted = formatEventDate(date, hasTime, timezone);
  const instantMs = hasTime
    ? date.getTime()
    : endOfZonedDayMs(date, timezone, reference);

  return { ok: true, formatted, hasTime, instantMs };
}

export type RsvpDeadlineComputeFailureReason =
  | ParseEventDateFailureReason
  | 'in_past'
  | 'not_before_event';

export type RsvpDeadlineComputeResult =
  | ParseRsvpDeadlineSuccess
  | { ok: false; reason: RsvpDeadlineComputeFailureReason };

const ISO_CALENDAR_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

export function addIsoCalendarDays(
  isoDate: string,
  days: number,
): string | null {
  const match = ISO_CALENDAR_RE.exec(isoDate.trim());
  if (!match) {
    return null;
  }
  const utc = new Date(
    Date.UTC(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]) + days,
    ),
  );
  const year = utc.getUTCFullYear();
  const month = String(utc.getUTCMonth() + 1).padStart(2, '0');
  const day = String(utc.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function isoCalendarToLongDate(isoDate: string): string | null {
  const match = ISO_CALENDAR_RE.exec(isoDate.trim());
  if (!match) {
    return null;
  }
  const month = MONTH_NAMES[Number(match[2]) - 1];
  const day = Number(match[3]);
  if (!month || day < 1 || day > 31) {
    return null;
  }
  return `${month} ${day}, ${match[1]}`;
}

export function getEventInstantMs(
  eventDateText: string,
  options: ParseEventDateOptions = {},
): number | null {
  const trimmed = eventDateText.trim();
  if (!trimmed) {
    return null;
  }
  const timezone = options.timezone ?? getEventTimezone();
  const reference = options.reference ?? new Date();
  const results = chrono.parse(trimmed, chronoRef(reference, timezone));
  if (results.length === 0 || isAmbiguous(results)) {
    return null;
  }
  return instantFromParsed(results[0], timezone).getTime();
}

function eventClockLabel(formatted: string): string | null {
  const match = formatted.match(/ at (.+)$/);
  const clock = match?.[1]?.trim();
  return clock || null;
}

export function rsvpDeadlineWeeksBefore(
  eventDateText: string,
  weeks: number,
  options: ParseRsvpDeadlineOptions = {},
): RsvpDeadlineComputeResult {
  if (!Number.isInteger(weeks) || weeks < 1) {
    return { ok: false, reason: 'unparseable' };
  }

  const timezone = options.timezone ?? getEventTimezone();
  const now = options.reference ?? new Date();
  const eventParsed = parseEventDate(eventDateText, {
    timezone,
    reference: now,
  });
  if (!eventParsed.ok) {
    return eventParsed;
  }

  const eventDay = getEventCalendarDay(eventDateText, {
    timezone,
    reference: now,
  });
  if (!eventDay) {
    return { ok: false, reason: 'unparseable' };
  }

  const shiftedDay = addIsoCalendarDays(eventDay, -7 * weeks);
  const longDate = shiftedDay ? isoCalendarToLongDate(shiftedDay) : null;
  if (!longDate) {
    return { ok: false, reason: 'unparseable' };
  }

  const clock = eventParsed.hasTime ? eventClockLabel(eventParsed.formatted) : null;
  const deadlineText = clock ? `${longDate} at ${clock}` : longDate;
  return validateComputedDeadline(deadlineText, eventDateText, {
    timezone,
    reference: now,
    eventDate: eventDateText,
  });
}

export function customRsvpDeadlineRange(
  eventDateText: string,
  options: ParseRsvpDeadlineOptions = {},
): { minDate: string; maxDate: string } | null {
  const timezone = options.timezone ?? getEventTimezone();
  const now = options.reference ?? new Date();
  const eventMs = getEventInstantMs(eventDateText, { timezone, reference: now });
  const eventDay = getEventCalendarDay(eventDateText, {
    timezone,
    reference: now,
  });
  const today = todayInEventTimezone({ timezone, reference: now });
  if (eventMs === null || eventMs <= now.getTime() || !today || !eventDay || eventDay < today) {
    return null;
  }
  return { minDate: today, maxDate: eventDay };
}

export function parseCustomRsvpDeadlineIso(
  isoDate: string,
  eventDateText: string,
  options: ParseRsvpDeadlineOptions = {},
): RsvpDeadlineComputeResult {
  const longDate = isoCalendarToLongDate(isoDate);
  if (!longDate) {
    return { ok: false, reason: 'unparseable' };
  }
  return validateComputedDeadline(longDate, eventDateText, options);
}

export function parseCustomRsvpDeadlineDateTime(
  isoDate: string,
  clock: string,
  eventDateText: string,
  options: ParseRsvpDeadlineOptions = {},
): RsvpDeadlineComputeResult {
  const longDate = isoCalendarToLongDate(isoDate);
  const time = clock.trim();
  if (!longDate || !time) {
    return { ok: false, reason: 'unparseable' };
  }
  return validateComputedDeadline(`${longDate} at ${time}`, eventDateText, options);
}

export function isCustomDeadlineIsoAllowed(
  isoDate: string,
  eventDateText: string,
  options: ParseRsvpDeadlineOptions = {},
): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) {
    return false;
  }
  const range = customRsvpDeadlineRange(eventDateText, options);
  return Boolean(range && isoDate >= range.minDate && isoDate <= range.maxDate);
}

export function isDateOnlyFormatted(text: string | null | undefined): boolean {
  const trimmed = text?.trim() ?? '';
  return Boolean(trimmed) && !/\sat\s/i.test(trimmed);
}

function validateComputedDeadline(
  deadlineText: string,
  eventDateText: string,
  options: ParseRsvpDeadlineOptions,
): RsvpDeadlineComputeResult {
  const timezone = options.timezone ?? getEventTimezone();
  const now = options.reference ?? new Date();
  const parsed = parseRsvpDeadline(deadlineText, {
    timezone,
    reference: now,
    eventDate: eventDateText,
  });
  if (!parsed.ok) {
    return parsed;
  }

  const eventMs = getEventInstantMs(eventDateText, { timezone, reference: now });
  if (eventMs === null) {
    return { ok: false, reason: 'unparseable' };
  }
  if (parsed.instantMs >= eventMs) {
    return { ok: false, reason: 'not_before_event' };
  }
  if (parsed.instantMs <= now.getTime()) {
    return { ok: false, reason: 'in_past' };
  }
  return parsed;
}

function resolveDeadlineReference(
  eventDate: string | null | undefined,
  fallback: Date,
  timezone: string,
): Date {
  if (!eventDate?.trim()) {
    return fallback;
  }

  const results = chrono.parse(eventDate.trim(), chronoRef(fallback, timezone));
  if (results.length === 0) {
    return fallback;
  }
  return instantFromParsed(results[0], timezone);
}

/** Last second of the deadline's calendar day in EVENT_TIMEZONE. */
function endOfZonedDayMs(
  date: Date,
  timezone: string,
  reference: Date,
): number {
  const dateOnly = formatEventDate(date, false, timezone);
  const results = chrono.parse(
    `${dateOnly} at 11:59:59 PM`,
    chronoRef(reference, timezone),
  );
  if (results.length > 0 && hasExplicitTime(results[0])) {
    return instantFromParsed(results[0], timezone).getTime();
  }
  const wall = zonedClockParts(date, timezone);
  return zonedWallTimeToUtc(
    {
      year: wall.year,
      month: wall.month,
      day: wall.day,
      hour: 23,
      minute: 59,
      second: 59,
    },
    timezone,
  ).getTime();
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** Start of the reminder window: N calendar days before the deadline in `timezone`. */
export function reminderWindowStartMs(
  deadlineText: string,
  reminderDays: number,
  options: ParseRsvpDeadlineOptions = {},
): number | null {
  if (!Number.isInteger(reminderDays) || reminderDays < 1) {
    return null;
  }
  const timezone = options.timezone ?? getEventTimezone();
  const parsed = parseRsvpDeadline(deadlineText, { ...options, timezone });
  if (!parsed.ok) {
    return null;
  }
  const wall = zonedClockParts(new Date(parsed.instantMs), timezone);
  const iso = `${wall.year}-${pad2(wall.month)}-${pad2(wall.day)}`;
  const shifted = addIsoCalendarDays(iso, -reminderDays);
  if (!shifted) {
    return null;
  }
  const [year, month, day] = shifted.split('-').map(Number);
  return zonedWallTimeToUtc(
    {
      year,
      month,
      day,
      hour: wall.hour,
      minute: wall.minute,
      second: wall.second,
    },
    timezone,
  ).getTime();
}

function isAmbiguous(results: chrono.ParsedResult[]): boolean {
  if (results.length <= 1) {
    return false;
  }

  const timestamps = new Set(
    results.map((result) => result.start.date().getTime()),
  );
  return timestamps.size > 1;
}

function hasExplicitTime(result: chrono.ParsedResult): boolean {
  return result.start.isCertain('hour') && result.start.isCertain('minute');
}

function hasSafeMeridiem(result: chrono.ParsedResult): boolean {
  const hour = result.start.get('hour');
  // 24-hour clock (13:00, 00:30) does not need AM/PM.
  if (hour !== null && (hour === 0 || hour >= 13)) {
    return true;
  }
  return result.start.isCertain('meridiem');
}

function hasConfidentEventTime(result: chrono.ParsedResult): boolean {
  return hasExplicitTime(result) && hasSafeMeridiem(result);
}

function isVagueCasualTime(result: chrono.ParsedResult): boolean {
  const tags = result.tags();
  return (
    tags.has('casualReference/evening') ||
    tags.has('casualReference/morning') ||
    tags.has('casualReference/afternoon') ||
    tags.has('casualReference/night') ||
    (tags.has('casualReference/tonight') && !result.start.isCertain('hour'))
  );
}

function hasExplicitDate(result: chrono.ParsedResult): boolean {
  if (
    result.start.isCertain('day') ||
    result.start.isCertain('weekday') ||
    result.start.isCertain('month')
  ) {
    return true;
  }

  const tags = result.tags();
  return (
    tags.has('casualReference/today') ||
    tags.has('casualReference/tomorrow') ||
    tags.has('casualReference/yesterday') ||
    tags.has('casualReference/tonight') ||
    tags.has('result/relativeDate')
  );
}

type EventTimeClass = 'complete' | 'missing' | 'missingMeridiem' | 'vague';

function classifyEventTime(result: chrono.ParsedResult): EventTimeClass {
  if (hasConfidentEventTime(result)) {
    return 'complete';
  }
  if (hasExplicitTime(result) && !hasSafeMeridiem(result)) {
    return 'missingMeridiem';
  }
  if (isVagueCasualTime(result)) {
    return 'vague';
  }
  return 'missing';
}

function preferDatedResults(
  results: chrono.ParsedResult[],
): chrono.ParsedResult[] {
  const dated = results.filter(
    (result) =>
      hasExplicitDate(result) ||
      classifyEventTime(result) === 'complete' ||
      classifyEventTime(result) === 'missingMeridiem',
  );
  return dated.length > 0 ? dated : results;
}

export function todayInEventTimezone(
  options: ParseEventDateOptions = {},
): string {
  const timezone = options.timezone ?? getEventTimezone();
  const reference = options.reference ?? new Date();
  return formatZonedCalendarDay(reference, timezone);
}

/** True when `isoDate` (YYYY-MM-DD) is before today in EVENT_TIMEZONE. */
export function isPastCalendarIsoDate(
  isoDate: string,
  options: ParseEventDateOptions = {},
): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) {
    return false;
  }
  const today = todayInEventTimezone(options);
  return Boolean(today) && isoDate < today;
}

export function formatZonedCalendarDay(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  if (!year || !month || !day) {
    return '';
  }
  return `${year}-${month}-${day}`;
}

export function getEventCalendarDay(
  eventDateText: string,
  options: ParseEventDateOptions = {},
): string | null {
  const trimmed = eventDateText.trim();
  if (!trimmed) {
    return null;
  }

  const timezone = options.timezone ?? getEventTimezone();
  const reference = options.reference ?? new Date();
  const results = chrono.parse(trimmed, chronoRef(reference, timezone));
  if (results.length === 0 || isAmbiguous(results)) {
    return null;
  }

  const day = formatZonedCalendarDay(instantFromParsed(results[0], timezone), timezone);
  return day || null;
}

/** True when `now` is on a later calendar day than the event in EVENT_TIMEZONE. */
export function isCalendarDayAfterEvent(
  eventDateText: string,
  nowMs: number,
  timezone?: string,
): boolean {
  const tz = timezone ?? getEventTimezone();
  const eventDay = getEventCalendarDay(eventDateText, {
    reference: new Date(nowMs),
    timezone: tz,
  });
  if (!eventDay) {
    return false;
  }
  const nowDay = formatZonedCalendarDay(new Date(nowMs), tz);
  return Boolean(nowDay) && nowDay > eventDay;
}

function formatEventDate(
  date: Date,
  includeTime: boolean,
  timezone: string,
): string {
  if (includeTime) {
    return new Intl.DateTimeFormat('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: timezone,
    }).format(date);
  }

  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: timezone,
  }).format(date);
}

export function formatEventTimezoneLine(timezone?: string | null): string {
  return `🌎 ${formatTimezoneLabel(resolveEventTimezone(timezone))}`;
}
