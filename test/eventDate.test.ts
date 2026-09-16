import test from 'node:test';
import assert from 'node:assert/strict';
import {
  customRsvpDeadlineRange,
  getEventInstantMs,
  getEventTimezone,
  isCalendarDayAfterEvent,
  isPastCalendarIsoDate,
  parseCustomRsvpDeadlineDateTime,
  parseCustomRsvpDeadlineIso,
  parseEventDate,
  parseEventTime,
  parseRsvpDeadline,
  rsvpDeadlineWeeksBefore,
  todayInEventTimezone,
  resolveEventSchedule,
  zonedWallTimeToUtc,
} from '../src/dates/eventDate.js';

/** Saturday, September 5, 2026 at 6:00 PM America/New_York */
const FROZEN_REF = new Date('2026-09-05T22:00:00.000Z');
const TZ = 'America/New_York';

const parseOpts = { reference: FROZEN_REF, timezone: TZ };

test('getEventTimezone defaults to America/New_York', () => {
  assert.equal(getEventTimezone(), 'America/New_York');
});

test('resolveEventSchedule keeps EVENT_TIMEZONE wall clock in EDT and EST', () => {
  const edt = resolveEventSchedule('Friday, October 30, 2026 at 7:00 PM', parseOpts);
  assert.ok(edt);
  assert.equal(edt.hasTime, true);
  assert.equal(edt.timezone, TZ);
  assert.deepEqual(
    { ...edt.wall, year: edt.wall.year },
    { year: 2026, month: 10, day: 30, hour: 19, minute: 0, second: 0 },
  );
  assert.equal(edt.instant.toISOString(), '2026-10-30T23:00:00.000Z');

  const est = resolveEventSchedule('Friday, January 15, 2027 at 7:00 PM', parseOpts);
  assert.ok(est);
  assert.equal(est.hasTime, true);
  assert.deepEqual(est.wall, {
    year: 2027,
    month: 1,
    day: 15,
    hour: 19,
    minute: 0,
    second: 0,
  });
  assert.equal(est.instant.toISOString(), '2027-01-16T00:00:00.000Z');
});

test('parseEventDate resolves relative and absolute dates with time', () => {
  assert.deepEqual(parseEventDate('Next Friday at 6 PM', parseOpts), {
    ok: true,
    formatted: 'Friday, September 11, 2026 at 6:00 PM',
    hasTime: true,
  });

  assert.deepEqual(parseEventDate('Sept 20 at 7:30 PM', parseOpts), {
    ok: true,
    formatted: 'Sunday, September 20, 2026 at 7:30 PM',
    hasTime: true,
  });

  assert.deepEqual(parseEventDate('December 25 at 6 PM', parseOpts), {
    ok: true,
    formatted: 'Friday, December 25, 2026 at 6:00 PM',
    hasTime: true,
  });
});

test('parseEventDate resolves date-only inputs without inventing time', () => {
  assert.deepEqual(parseEventDate('Tomorrow', parseOpts), {
    ok: true,
    formatted: 'Sunday, September 6, 2026',
    hasTime: false,
  });

  assert.deepEqual(parseEventDate('Next Sunday', parseOpts), {
    ok: true,
    formatted: 'Sunday, September 13, 2026',
    hasTime: false,
  });

  assert.deepEqual(parseEventDate('This Saturday', parseOpts), {
    ok: true,
    formatted: 'Saturday, September 5, 2026',
    hasTime: false,
  });

  assert.deepEqual(parseEventDate('September 20', parseOpts), {
    ok: true,
    formatted: 'Sunday, September 20, 2026',
    hasTime: false,
  });
});

test('Next Sunday from Saturday resolves to the following Sunday', () => {
  const result = parseEventDate('Next Sunday', parseOpts);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.formatted, 'Sunday, September 13, 2026');
    assert.equal(result.hasTime, false);
  }
});

test('parseEventTime combines stored date with explicit time', () => {
  const dateOnly = 'Sunday, September 20, 2026';
  assert.deepEqual(parseEventTime('7:30 PM', dateOnly, parseOpts), {
    ok: true,
    formatted: 'Sunday, September 20, 2026 at 7:30 PM',
    hasTime: true,
  });
});

test('this Friday at 7:30 PM resolves calendar date and local time without guessing', () => {
  assert.deepEqual(parseEventDate('this Friday at 7:30 PM', parseOpts), {
    ok: true,
    formatted: 'Friday, September 11, 2026 at 7:30 PM',
    hasTime: true,
  });
});

test('Friday without time stays date-only so the flow can ask for time', () => {
  const result = parseEventDate('Friday', parseOpts);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.hasTime, false);
    assert.match(result.formatted, /Friday/);
  }
});

test('around evening is not a specific time', () => {
  assert.deepEqual(parseEventDate('around evening', parseOpts), {
    ok: false,
    reason: 'vagueTime',
  });
  assert.deepEqual(parseEventDate('evening', parseOpts), {
    ok: false,
    reason: 'vagueTime',
  });
  assert.deepEqual(
    parseEventTime('around evening', 'Sunday, September 20, 2026', parseOpts),
    { ok: false, reason: 'vagueTime' },
  );
});

test('7:30 without AM or PM stays until meridiem is given', () => {
  assert.deepEqual(parseEventDate('7:30', parseOpts), {
    ok: false,
    reason: 'missingMeridiem',
  });
  assert.deepEqual(
    parseEventTime('7:30', 'Sunday, September 20, 2026', parseOpts),
    { ok: false, reason: 'missingMeridiem' },
  );

  const fridayNoMeridiem = parseEventDate('this Friday at 7:30', parseOpts);
  assert.equal(fridayNoMeridiem.ok, true);
  if (fridayNoMeridiem.ok) {
    assert.equal(fridayNoMeridiem.hasTime, false);
    assert.equal(fridayNoMeridiem.timeIssue, 'missingMeridiem');
    assert.equal(fridayNoMeridiem.formatted, 'Friday, September 11, 2026');
  }
});

test('12 AM, 12 PM, and minutes are preserved in EVENT_TIMEZONE', () => {
  assert.deepEqual(parseEventDate('September 20 at 12 AM', parseOpts), {
    ok: true,
    formatted: 'Sunday, September 20, 2026 at 12:00 AM',
    hasTime: true,
  });
  assert.deepEqual(parseEventDate('September 20 at 12 PM', parseOpts), {
    ok: true,
    formatted: 'Sunday, September 20, 2026 at 12:00 PM',
    hasTime: true,
  });
  assert.deepEqual(parseEventDate('September 20 at 7:30 PM', parseOpts), {
    ok: true,
    formatted: 'Sunday, September 20, 2026 at 7:30 PM',
    hasTime: true,
  });
  assert.deepEqual(
    parseEventTime('12:00 AM', 'Sunday, September 20, 2026', parseOpts),
    {
      ok: true,
      formatted: 'Sunday, September 20, 2026 at 12:00 AM',
      hasTime: true,
    },
  );
  assert.deepEqual(
    parseEventTime('12 PM', 'Sunday, September 20, 2026', parseOpts),
    {
      ok: true,
      formatted: 'Sunday, September 20, 2026 at 12:00 PM',
      hasTime: true,
    },
  );
});

test('calendar helpers reject past YYYY-MM-DD in EVENT_TIMEZONE', () => {
  assert.equal(todayInEventTimezone(parseOpts), '2026-09-05');
  assert.equal(isPastCalendarIsoDate('2026-09-04', parseOpts), true);
  assert.equal(isPastCalendarIsoDate('2026-09-05', parseOpts), false);
  assert.equal(isPastCalendarIsoDate('2026-09-20', parseOpts), false);
  assert.equal(isPastCalendarIsoDate('not-a-date', parseOpts), false);
});

test('event date parsing does not use Date.parse for natural-language input', async () => {
  const { readFile } = await import('node:fs/promises');
  const files = [
    '../src/dates/eventDate.ts',
    '../src/commands/createEventFlow.ts',
    '../src/http/eventWhen.ts',
    '../src/http/eventWhenPage.ts',
    '../src/http/eventWhenToken.ts',
    '../src/http/rsvpPage.ts',
    '../src/http/shortRsvp.ts',
  ];
  for (const file of files) {
    const src = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /Date\.parse\s*\(/, file);
  }
});

test('parseEventDate rejects unparseable input', () => {
  assert.deepEqual(parseEventDate('maybe someday', parseOpts), {
    ok: false,
    reason: 'unparseable',
  });
  assert.deepEqual(parseEventDate('', parseOpts), {
    ok: false,
    reason: 'unparseable',
  });
});

test('parseEventTime rejects unparseable input', () => {
  assert.deepEqual(parseEventTime('soon', 'Sunday, September 20, 2026', parseOpts), {
    ok: false,
    reason: 'unparseable',
  });
});

test('parseRsvpDeadline stores year-bearing formatted strings for yearless input', () => {
  const sept15 = parseRsvpDeadline('Sept 15', parseOpts);
  assert.equal(sept15.ok, true);
  if (sept15.ok) {
    assert.equal(sept15.formatted, 'Tuesday, September 15, 2026');
    assert.equal(sept15.hasTime, false);
    assert.equal(new Date(sept15.instantMs).getUTCFullYear(), 2026);
  }

  const sept8 = parseRsvpDeadline('September 8', parseOpts);
  assert.equal(sept8.ok, true);
  if (sept8.ok) {
    assert.equal(sept8.formatted, 'Tuesday, September 8, 2026');
    assert.equal(sept8.hasTime, false);
  }

  const withTime = parseRsvpDeadline('June 10 5pm', parseOpts);
  assert.equal(withTime.ok, true);
  if (withTime.ok) {
    assert.equal(withTime.formatted, 'Wednesday, June 10, 2026 at 5:00 PM');
    assert.equal(withTime.hasTime, true);
  }
});

test('parseRsvpDeadline uses event date year for yearless deadlines', () => {
  const parsed = parseRsvpDeadline('Sept 15', {
    ...parseOpts,
    eventDate: 'Sunday, September 20, 2026 at 7:30 PM',
    reference: new Date('2025-01-01T12:00:00.000Z'),
  });
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.formatted, 'Tuesday, September 15, 2026');
  }
});

test('parseRsvpDeadline preserves year-bearing deadlines', () => {
  const parsed = parseRsvpDeadline('Sunday, September 20, 2026', parseOpts);
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.formatted, 'Sunday, September 20, 2026');
    assert.equal(parsed.hasTime, false);
  }

  const withTime = parseRsvpDeadline(
    'Wednesday, June 10, 2026 at 5:00 PM',
    parseOpts,
  );
  assert.equal(withTime.ok, true);
  if (withTime.ok) {
    assert.equal(withTime.formatted, 'Wednesday, June 10, 2026 at 5:00 PM');
    assert.equal(withTime.hasTime, true);
  }
});

test('parseRsvpDeadline date-only closes at end of day in America/New_York', () => {
  const parsed = parseRsvpDeadline('September 8', parseOpts);
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    // 11:59:59 PM EDT on September 8, 2026
    assert.equal(parsed.instantMs, Date.parse('2026-09-09T03:59:59.000Z'));
  }
});

test('isCalendarDayAfterEvent waits until the calendar day after the event', () => {
  const eventDate = 'Sunday, September 20, 2026 at 7:30 PM';

  assert.equal(
    isCalendarDayAfterEvent(eventDate, Date.parse('2026-09-20T23:30:00.000Z'), TZ),
    false,
  );
  // 11:59 PM EDT on the event day
  assert.equal(
    isCalendarDayAfterEvent(eventDate, Date.parse('2026-09-21T03:59:00.000Z'), TZ),
    false,
  );
  // midnight EDT begins the calendar day after the event
  assert.equal(
    isCalendarDayAfterEvent(eventDate, Date.parse('2026-09-21T04:00:00.000Z'), TZ),
    true,
  );
  assert.equal(
    isCalendarDayAfterEvent(eventDate, Date.parse('2026-09-22T16:00:00.000Z'), TZ),
    true,
  );
});

test('parseRsvpDeadline does not use Date.parse year 2001', () => {
  assert.equal(new Date(Date.parse('September 8')).getUTCFullYear(), 2001);
  assert.equal(new Date(Date.parse('Sept 15')).getUTCFullYear(), 2001);

  const parsed = parseRsvpDeadline('Sept 15', parseOpts);
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.notEqual(new Date(parsed.instantMs).getUTCFullYear(), 2001);
    assert.equal(new Date(parsed.instantMs).getUTCFullYear(), 2026);
  }
});

test('2 weeks before event is a year-bearing deadline before the event', () => {
  const eventDate = 'Sunday, December 20, 2026 at 7:30 PM';
  const parsed = rsvpDeadlineWeeksBefore(eventDate, 2, parseOpts);
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.formatted, 'Sunday, December 6, 2026 at 7:30 PM');
    assert.match(parsed.formatted, /2026/);
    assert.equal(parsed.hasTime, true);
    const event = parseRsvpDeadline(eventDate, parseOpts);
    assert.equal(event.ok, true);
    if (event.ok) {
      assert.ok(parsed.instantMs < event.instantMs);
    }
  }
});

test('week presets that would land in the past are omitted', () => {
  const eventDate = 'Sunday, September 20, 2026 at 7:30 PM';
  const now = new Date('2026-09-10T16:00:00.000Z');
  const opts = { reference: now, timezone: TZ, eventDate };

  assert.equal(rsvpDeadlineWeeksBefore(eventDate, 1, opts).ok, true);
  const twoWeeks = rsvpDeadlineWeeksBefore(eventDate, 2, opts);
  assert.equal(twoWeeks.ok, false);
  if (!twoWeeks.ok) {
    assert.equal(twoWeeks.reason, 'in_past');
  }
  assert.equal(rsvpDeadlineWeeksBefore(eventDate, 3, opts).ok, false);
  assert.equal(rsvpDeadlineWeeksBefore(eventDate, 4, opts).ok, false);
});

test('custom deadline range is after now and on or before the event day', () => {
  const eventDate = 'Sunday, September 20, 2026 at 7:30 PM';
  const range = customRsvpDeadlineRange(eventDate, parseOpts);
  assert.deepEqual(range, { minDate: '2026-09-05', maxDate: '2026-09-20' });
});

test('custom deadline before the event is accepted', () => {
  const eventDate = 'Sunday, September 20, 2026 at 7:30 PM';
  const parsed = parseCustomRsvpDeadlineIso('2026-09-15', eventDate, parseOpts);
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.formatted, 'Tuesday, September 15, 2026');
    assert.match(parsed.formatted, /2026/);
  }
});

test('custom deadline on or after the event is rejected', () => {
  const eventDate = 'Sunday, September 20, 2026 at 7:30 PM';
  const onEvent = parseCustomRsvpDeadlineIso('2026-09-20', eventDate, parseOpts);
  assert.equal(onEvent.ok, false);
  if (!onEvent.ok) {
    assert.equal(onEvent.reason, 'not_before_event');
  }
  const afterEvent = parseCustomRsvpDeadlineIso(
    '2026-09-21',
    eventDate,
    parseOpts,
  );
  assert.equal(afterEvent.ok, false);
});

test('7:00 PM EVENT_TIMEZONE wall time is not stored as UTC (3:00 PM EDT)', () => {
  const parsed = parseEventDate('September 20, 2026 at 7:00 PM', parseOpts);
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.formatted, 'Sunday, September 20, 2026 at 7:00 PM');
    assert.doesNotMatch(parsed.formatted, /3:00\s*PM/i);
  }

  const instant = getEventInstantMs(
    'Sunday, September 20, 2026 at 7:00 PM',
    parseOpts,
  );
  // 7:00 PM EDT = 23:00 UTC, not 19:00 UTC (which formats as 3:00 PM EDT)
  assert.equal(instant, Date.parse('2026-09-20T23:00:00.000Z'));
  assert.notEqual(instant, Date.parse('2026-09-20T19:00:00.000Z'));

  const wall = zonedWallTimeToUtc(
    { year: 2026, month: 9, day: 20, hour: 19, minute: 0, second: 0 },
    TZ,
  );
  assert.equal(wall.toISOString(), '2026-09-20T23:00:00.000Z');
});

test('AM and PM wall times keep their meridiem in EVENT_TIMEZONE', () => {
  assert.deepEqual(parseEventDate('September 20, 2026 at 9:00 AM', parseOpts), {
    ok: true,
    formatted: 'Sunday, September 20, 2026 at 9:00 AM',
    hasTime: true,
  });
  assert.deepEqual(parseEventTime('7:00 PM', 'Sunday, September 20, 2026', parseOpts), {
    ok: true,
    formatted: 'Sunday, September 20, 2026 at 7:00 PM',
    hasTime: true,
  });
});

test('custom deadline date and time before the event is accepted', () => {
  const eventDate = 'Sunday, September 20, 2026 at 7:30 PM';
  const parsed = parseCustomRsvpDeadlineDateTime(
    '2026-09-20',
    '5:00 PM',
    eventDate,
    parseOpts,
  );
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.formatted, 'Sunday, September 20, 2026 at 5:00 PM');
    assert.ok(parsed.instantMs < Date.parse('2026-09-20T23:30:00.000Z'));
  }
});

test('custom deadline time on or after the event is rejected', () => {
  const eventDate = 'Sunday, September 20, 2026 at 7:30 PM';
  const sameTime = parseCustomRsvpDeadlineDateTime(
    '2026-09-20',
    '7:30 PM',
    eventDate,
    parseOpts,
  );
  assert.equal(sameTime.ok, false);
  if (!sameTime.ok) {
    assert.equal(sameTime.reason, 'not_before_event');
  }
  const later = parseCustomRsvpDeadlineDateTime(
    '2026-09-20',
    '8:00 PM',
    eventDate,
    parseOpts,
  );
  assert.equal(later.ok, false);
});
