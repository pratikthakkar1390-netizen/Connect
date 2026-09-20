import { Router, type Request, type Response } from 'express';
import express from 'express';
import {
  applyAcceptedDeadline,
  formatDeadlineTimeQuestion,
  formatLocationQuestion,
  formatTimeQuestion,
  RSVP_DEADLINE_BEFORE_EVENT,
  RSVP_DEADLINE_IN_PAST,
  timeParseFailureMessage,
} from '../commands/createEventFlow.js';
import {
  editedEventNotifyButtons,
  formatEditTimeQuestion,
  persistEditedEventDraft,
} from '../commands/eventUpdateFlow.js';
import { formatEditedEventReview } from '../commands/eventUpdateMessage.js';
import {
  getConversationState,
  getMessageSession,
  lookupEventWhenTokenByShortCode,
  setConversationState,
} from '../db/store.js';
import {
  customRsvpDeadlineRange,
  getEventInstantMs,
  isCustomDeadlineIsoAllowed,
  isDateOnlyFormatted,
  isPastCalendarIsoDate,
  parseEventDate,
  parseEventTime,
  parseRsvpDeadline,
  resolveEventTimezone,
  todayInEventTimezone,
} from '../dates/eventDate.js';
import { sendInboxMessage, type InboxSendResult, type SendMessageParams } from '../zernio/client.js';
import {
  renderEventWhenDatePage,
  renderEventWhenDonePage,
  renderEventWhenTimePage,
  renderInvalidEventWhenPage,
} from './eventWhenPage.js';
import {
  eventWhenPickerPath,
  verifyEventWhenToken,
  type EventWhenPayload,
} from './eventWhenToken.js';

export const eventWhenRouter = Router();

eventWhenRouter.use(express.urlencoded({ extended: false }));

type SendFn = (params: SendMessageParams) => Promise<void | InboxSendResult>;
let sendMessage: SendFn = sendInboxMessage;

/** Test-only seam so picker WhatsApp follow-ups can be asserted. */
export function setEventWhenMessageSender(send?: SendFn): void {
  sendMessage = send ?? sendInboxMessage;
}

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTHS = [
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
];

function formScalar(value: unknown): string {
  const raw = Array.isArray(value) ? value[value.length - 1] : value;
  return typeof raw === 'string' ? raw.trim() : '';
}

function pickerTimezone(phone: string): string {
  return resolveEventTimezone(getConversationState(phone)?.timezone);
}

function tzOpts(phone: string) {
  return { timezone: pickerTimezone(phone) };
}

export function isoDateToLongDate(isoDate: string): string | null {
  const match = ISO_DATE_RE.exec(isoDate.trim());
  if (!match) {
    return null;
  }
  const month = MONTHS[Number(match[2]) - 1];
  const day = Number(match[3]);
  if (!month || day < 1 || day > 31) {
    return null;
  }
  return `${month} ${day}, ${match[1]}`;
}

export function formatPickedTime(
  hour: string,
  minute: string,
  meridiem: string,
): string | null {
  const hourNum = Number(hour);
  const minuteNum = Number(minute);
  const mer = meridiem.trim().toUpperCase();
  if (
    !Number.isInteger(hourNum) ||
    hourNum < 1 ||
    hourNum > 12 ||
    !Number.isInteger(minuteNum) ||
    minuteNum < 0 ||
    minuteNum > 59 ||
    (mer !== 'AM' && mer !== 'PM')
  ) {
    return null;
  }
  return `${hourNum}:${String(minuteNum).padStart(2, '0')} ${mer}`;
}

function sendInvalid(res: Response): void {
  res.status(404).type('html').send(renderInvalidEventWhenPage());
}

function resolvePayload(req: Request): EventWhenPayload | null {
  const code = String(req.params.code ?? '').trim();
  if (code) {
    const token = lookupEventWhenTokenByShortCode(code);
    return token ? verifyEventWhenToken(token) : null;
  }
  return verifyEventWhenToken(String(req.params.token ?? ''));
}

function pickerView(
  phone: string,
  tokenStep: EventWhenPayload['step'],
): 'date' | 'time' | 'deadline' | 'done' | 'invalid' {
  const state = getConversationState(phone);
  if (!state) {
    return 'invalid';
  }
  if (
    state.state === 'WAITING_FOR_EVENT_DATE' ||
    state.state === 'WAITING_FOR_EDIT_DATE'
  ) {
    return 'date';
  }
  if (
    state.state === 'WAITING_FOR_EVENT_TIME' ||
    state.state === 'WAITING_FOR_EDIT_TIME'
  ) {
    return tokenStep === 'date' && !state.date?.trim() ? 'date' : 'time';
  }
  if (
    state.state === 'WAITING_FOR_RSVP_DEADLINE' ||
    state.state === 'WAITING_FOR_EDIT_DEADLINE'
  ) {
    if (tokenStep === 'time' && isDateOnlyFormatted(state.rsvp_deadline)) {
      return 'time';
    }
    if (tokenStep === 'deadline' || tokenStep === 'date' || tokenStep === 'time') {
      return 'deadline';
    }
    return 'done';
  }
  if (
    state.state === 'WAITING_FOR_EVENT_LOCATION' ||
    state.state === 'WAITING_FOR_ADD_DETAILS' ||
    state.state === 'WAITING_FOR_EVENT_THEME' ||
    state.state === 'WAITING_FOR_CUSTOM_THEME' ||
    state.state === 'WAITING_FOR_DRESS_CODE' ||
    state.state === 'WAITING_FOR_DRESS_CODE_TEXT' ||
    state.state === 'WAITING_FOR_EVENT_IMAGE' ||
    state.state === 'WAITING_FOR_EDIT_FIELD' ||
    state.state === 'WAITING_FOR_EDIT_LOCATION' ||
    state.state === 'WAITING_FOR_EDIT_THEME' ||
    state.state === 'WAITING_FOR_EDIT_CUSTOM_THEME' ||
    state.state === 'WAITING_FOR_EDIT_DRESS' ||
    state.state === 'WAITING_FOR_EDIT_DRESS_TEXT' ||
    state.state === 'WAITING_FOR_EDIT_IMAGE' ||
    state.state === 'WAITING_FOR_CHILDREN_POLICY' ||
    state.state === 'WAITING_FOR_REMINDER_SETTING' ||
    state.state === 'CONFIRMING_EVENT'
  ) {
    return 'done';
  }
  return 'invalid';
}

function renderCurrentStep(
  res: Response,
  phone: string,
  tokenStep: EventWhenPayload['step'],
  extras: { dateError?: string; timeError?: string; dateValue?: string } = {},
): void {
  const view = pickerView(phone, tokenStep);
  const state = getConversationState(phone);
  if (view === 'invalid' || !state) {
    sendInvalid(res);
    return;
  }
  if (view === 'done') {
    res.type('html').send(renderEventWhenDonePage());
    return;
  }
  if (view === 'date') {
    res.type('html').send(
      renderEventWhenDatePage({
        eventName: state.name,
        minDate: todayInEventTimezone(tzOpts(phone)),
        dateValue: extras.dateValue,
        error: extras.dateError,
        includeTime: true,
      }),
    );
    return;
  }
  if (view === 'deadline') {
    const range = customRsvpDeadlineRange(state.date ?? '', tzOpts(phone));
    res.type('html').send(
      renderEventWhenDatePage({
        purpose: 'deadline',
        eventName: state.name,
        minDate: range?.minDate ?? todayInEventTimezone(tzOpts(phone)),
        maxDate: range?.maxDate,
        dateValue: extras.dateValue,
        error: extras.dateError ?? (range ? undefined : RSVP_DEADLINE_BEFORE_EVENT),
      }),
    );
    return;
  }
  const deadlineTime =
    state.state === 'WAITING_FOR_RSVP_DEADLINE' ||
    state.state === 'WAITING_FOR_EDIT_DEADLINE';
  res.type('html').send(
    renderEventWhenTimePage({
      purpose: deadlineTime ? 'deadline' : 'event',
      eventName: state.name,
      dateLabel: deadlineTime
        ? state.rsvp_deadline?.trim() || 'Choose a close time'
        : state.date?.trim() || 'Choose a start time',
      error: extras.timeError,
    }),
  );
}

async function notifyWhatsApp(
  phone: string,
  message: string,
  buttons?: Array<{ title: string; payload: string }>,
  list?: SendMessageParams['list'],
): Promise<void> {
  const session = getMessageSession(phone);
  if (!session) {
    return;
  }
  try {
    await sendMessage({
      conversationId: session.conversation_id,
      accountId: session.account_id,
      message,
      buttons,
      list,
    });
  } catch (error) {
    console.warn(
      `event when picker: failed to send WhatsApp follow-up for ${phone}: ${
        error instanceof Error ? error.message : error
      }`,
    );
  }
}

eventWhenRouter.get('/when/:token', handleEventWhenGet);
eventWhenRouter.post('/when/:token', handleEventWhenPost);
eventWhenRouter.get('/d/:code', handleEventWhenGet);
eventWhenRouter.post('/d/:code', handleEventWhenPost);

function handleEventWhenGet(req: Request, res: Response): void {
  const payload = resolvePayload(req);
  if (!payload) {
    sendInvalid(res);
    return;
  }
  renderCurrentStep(res, payload.phone, payload.step);
}

function handleEventWhenPost(req: Request, res: Response): void {
  void (async () => {
    const payload = resolvePayload(req);
    if (!payload) {
      sendInvalid(res);
      return;
    }

    const view = pickerView(payload.phone, payload.step);
    if (view === 'invalid') {
      sendInvalid(res);
      return;
    }
    if (view === 'done') {
      res.type('html').send(renderEventWhenDonePage());
      return;
    }

    const postedStep = formScalar(req.body?.step) || payload.step;

    if (view === 'deadline') {
      const isoDate = formScalar(req.body?.date);
      const longDate = isoDateToLongDate(isoDate);
      if (!longDate) {
        renderCurrentStep(res, payload.phone, 'deadline', {
          dateError: 'Please choose a date from the calendar.',
          dateValue: isoDate,
        });
        return;
      }
      if (isPastCalendarIsoDate(isoDate, tzOpts(payload.phone))) {
        renderCurrentStep(res, payload.phone, 'deadline', {
          dateError: RSVP_DEADLINE_IN_PAST,
          dateValue: isoDate,
        });
        return;
      }
      const state = getConversationState(payload.phone);
      if (!isCustomDeadlineIsoAllowed(isoDate, state?.date ?? '', tzOpts(payload.phone))) {
        renderCurrentStep(res, payload.phone, 'deadline', {
          dateError: RSVP_DEADLINE_BEFORE_EVENT,
          dateValue: isoDate,
        });
        return;
      }
      const parsed = parseEventDate(longDate, tzOpts(payload.phone));
      if (!parsed.ok) {
        renderCurrentStep(res, payload.phone, 'deadline', {
          dateError: 'Please choose a date from the calendar.',
          dateValue: isoDate,
        });
        return;
      }
      setConversationState(
        payload.phone,
        state?.state === 'WAITING_FOR_EDIT_DEADLINE'
          ? 'WAITING_FOR_EDIT_DEADLINE'
          : 'WAITING_FOR_RSVP_DEADLINE',
        {
          rsvp_deadline: parsed.formatted,
        },
      );
      await notifyWhatsApp(
        payload.phone,
        formatDeadlineTimeQuestion(payload.phone),
      );
      res.redirect(303, eventWhenPickerPath(payload.phone, 'time'));
      return;
    }

    if (view === 'date' || postedStep === 'date') {
      if (view !== 'date') {
        renderCurrentStep(res, payload.phone, payload.step);
        return;
      }
      const isoDate = formScalar(req.body?.date);
      const longDate = isoDateToLongDate(isoDate);
      if (!longDate) {
        renderCurrentStep(res, payload.phone, 'date', {
          dateError: 'Please choose a date from the calendar.',
          dateValue: isoDate,
        });
        return;
      }
      if (isPastCalendarIsoDate(isoDate, tzOpts(payload.phone))) {
        renderCurrentStep(res, payload.phone, 'date', {
          dateError: 'That date is in the past. Please choose today or a future date.',
          dateValue: isoDate,
        });
        return;
      }
      const parsed = parseEventDate(longDate, tzOpts(payload.phone));
      if (!parsed.ok) {
        renderCurrentStep(res, payload.phone, 'date', {
          dateError: 'Please choose a date from the calendar.',
          dateValue: isoDate,
        });
        return;
      }
      const pickedTime = formatPickedTime(
        formScalar(req.body?.hour),
        formScalar(req.body?.minute),
        formScalar(req.body?.meridiem),
      );
      if (pickedTime) {
        const withTime = parseEventTime(
          pickedTime,
          parsed.formatted,
          tzOpts(payload.phone),
        );
        if (withTime.ok) {
          await finishEventWhen(res, payload.phone, withTime.formatted);
          return;
        }
        renderCurrentStep(res, payload.phone, 'date', {
          dateError: timeParseFailureMessage(withTime.reason),
          dateValue: isoDate,
        });
        return;
      }
      const editing = getConversationState(payload.phone)?.state === 'WAITING_FOR_EDIT_DATE';
      setConversationState(
        payload.phone,
        editing ? 'WAITING_FOR_EDIT_TIME' : 'WAITING_FOR_EVENT_TIME',
        { date: parsed.formatted },
      );
      await notifyWhatsApp(
        payload.phone,
        editing
          ? formatEditTimeQuestion(payload.phone)
          : formatTimeQuestion(payload.phone),
      );
      res.redirect(303, eventWhenPickerPath(payload.phone, 'time'));
      return;
    }

    const state = getConversationState(payload.phone);
    const deadlineTime =
      state?.state === 'WAITING_FOR_RSVP_DEADLINE' ||
      state?.state === 'WAITING_FOR_EDIT_DEADLINE';
    const dateOnly = deadlineTime
      ? state?.rsvp_deadline?.trim() ?? ''
      : state?.date?.trim() ?? '';
    const picked = formatPickedTime(
      formScalar(req.body?.hour),
      formScalar(req.body?.minute),
      formScalar(req.body?.meridiem),
    );
    if (!picked) {
      renderCurrentStep(res, payload.phone, 'time', {
        timeError: 'Please choose an hour, minute, and AM or PM.',
      });
      return;
    }
    const parsed = parseEventTime(picked, dateOnly, tzOpts(payload.phone));
    if (!parsed.ok) {
      renderCurrentStep(res, payload.phone, 'time', {
        timeError: timeParseFailureMessage(parsed.reason),
      });
      return;
    }
    if (deadlineTime) {
      const deadline = parseRsvpDeadline(parsed.formatted, {
        eventDate: state?.date,
        timezone: pickerTimezone(payload.phone),
      });
      const eventMs = state?.date
        ? getEventInstantMs(state.date, tzOpts(payload.phone))
        : null;
      if (!deadline.ok) {
        renderCurrentStep(res, payload.phone, 'time', {
          timeError: RSVP_DEADLINE_BEFORE_EVENT,
        });
        return;
      }
      if (eventMs !== null && deadline.instantMs >= eventMs) {
        renderCurrentStep(res, payload.phone, 'time', {
          timeError: RSVP_DEADLINE_BEFORE_EVENT,
        });
        return;
      }
      if (deadline.instantMs <= Date.now()) {
        renderCurrentStep(res, payload.phone, 'time', {
          timeError: RSVP_DEADLINE_IN_PAST,
        });
        return;
      }
      if (state?.state === 'WAITING_FOR_EDIT_DEADLINE') {
        setConversationState(payload.phone, 'WAITING_FOR_EDIT_DEADLINE', {
          rsvp_deadline: deadline.formatted,
        });
        const saved = persistEditedEventDraft(payload.phone);
        if (saved) {
          await notifyWhatsApp(
            payload.phone,
            formatEditedEventReview(saved),
            editedEventNotifyButtons(saved.id),
          );
        }
        res.type('html').send(renderEventWhenDonePage());
        return;
      }
      const next = applyAcceptedDeadline(payload.phone, deadline.formatted);
      await notifyWhatsApp(payload.phone, next.message, next.buttons, next.list);
      res.type('html').send(renderEventWhenDonePage());
      return;
    }
    await finishEventWhen(res, payload.phone, parsed.formatted);
  })();
}

async function finishEventWhen(
  res: Response,
  phone: string,
  formattedDate: string,
): Promise<void> {
  const state = getConversationState(phone);
  const editing =
    state?.state === 'WAITING_FOR_EDIT_TIME' ||
    state?.state === 'WAITING_FOR_EDIT_DATE';
  setConversationState(
    phone,
    editing ? 'WAITING_FOR_EDIT_TIME' : 'WAITING_FOR_EVENT_LOCATION',
    { date: formattedDate },
  );
  if (editing) {
    const saved = persistEditedEventDraft(phone);
    if (saved) {
      await notifyWhatsApp(
        phone,
        formatEditedEventReview(saved),
        editedEventNotifyButtons(saved.id),
      );
    }
    res.type('html').send(renderEventWhenDonePage());
    return;
  }
  await notifyWhatsApp(phone, formatLocationQuestion(state?.name));
  res.type('html').send(renderEventWhenDonePage());
}
