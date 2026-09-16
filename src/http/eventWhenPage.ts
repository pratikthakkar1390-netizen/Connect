import { esc } from '../admin/html.js';
import { renderConnectLayout } from './rsvpPage.js';

const PICKER_CSS = `
<style>
.picker-field { margin: 0.85rem 0 0.25rem; }
.picker-field label { display: block; font-weight: 600; margin-bottom: 0.4rem; }
.picker-field input[type="date"],
.picker-field select {
  width: 100%;
  padding: 0.85rem 0.9rem;
  border: 1px solid var(--line);
  border-radius: 0.75rem;
  font: inherit;
  font-size: 1.05rem;
  background: #fff;
}
.time-grid {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 0.5rem;
}
.time-grid .picker-field { margin-top: 0; }
</style>`;

export interface EventWhenDateState {
  eventName?: string | null;
  minDate: string;
  maxDate?: string;
  dateValue?: string;
  error?: string;
  purpose?: 'event' | 'deadline';
  includeTime?: boolean;
}

export interface EventWhenTimeState {
  eventName?: string | null;
  dateLabel: string;
  hour?: string;
  minute?: string;
  meridiem?: string;
  error?: string;
  purpose?: 'event' | 'deadline';
}

function eventHeading(eventName?: string | null): string {
  return eventName?.trim() || 'your event';
}

export function renderInvalidEventWhenPage(): string {
  return renderConnectLayout(
    'Link expired — CONNECT',
    `<section class="card">
      <p class="eyebrow">🔗</p>
      <h1 class="event-name">This picker isn’t available</h1>
      <p class="note">This link isn’t valid, or the date and time step is no longer open. Return to WhatsApp to continue.</p>
    </section>`,
  );
}

export function renderEventWhenDonePage(): string {
  return renderConnectLayout(
    'Return to WhatsApp — CONNECT',
    `<section class="card success">
      <p class="success-icon">✅</p>
      <h1>Return to WhatsApp</h1>
      <p>The next question is already in WhatsApp. You can close this page.</p>
    </section>`,
  );
}

function optionList(
  values: string[],
  selected: string | undefined,
  labels?: (value: string) => string,
): string {
  return values
    .map((value) => {
      const label = labels ? labels(value) : value;
      const isSelected = value === selected ? ' selected' : '';
      return `<option value="${esc(value)}"${isSelected}>${esc(label)}</option>`;
    })
    .join('');
}

const HOURS = Array.from({ length: 12 }, (_, i) => String(i + 1));
const MINUTES = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, '0'));

export function renderEventWhenDatePage(state: EventWhenDateState): string {
  const deadline = state.purpose === 'deadline';
  const includeTime = Boolean(state.includeTime) && !deadline;
  const error = state.error ? `<p class="error">${esc(state.error)}</p>` : '';
  const heading = deadline
    ? 'When should RSVPs close?'
    : `When is ${esc(eventHeading(state.eventName))}?`;
  const note = deadline
    ? 'RSVP deadline must be before the event.'
    : includeTime
      ? 'Pick a date and time. Past dates are not allowed.'
      : 'Pick a date. Past dates are not allowed.';
  const maxAttr = state.maxDate ? ` max="${esc(state.maxDate)}"` : '';
  const timeFields = includeTime
    ? `<div class="time-grid">
          <div class="picker-field">
            <label for="event-hour">Hour</label>
            <select id="event-hour" name="hour" required>
              ${optionList(HOURS, '7')}
            </select>
          </div>
          <div class="picker-field">
            <label for="event-minute">Minute</label>
            <select id="event-minute" name="minute" required>
              ${optionList(MINUTES, '00')}
            </select>
          </div>
          <div class="picker-field">
            <label for="event-meridiem">AM/PM</label>
            <select id="event-meridiem" name="meridiem" required>
              ${optionList(['AM', 'PM'], 'PM')}
            </select>
          </div>
        </div>`
    : '';
  const body = `
    <section class="card">
      <p class="eyebrow">📅</p>
      <h1 class="event-name">${heading}</h1>
      <p class="note">${note}</p>
      ${error}
      <form method="post" action="" id="date-form">
        <input type="hidden" name="step" value="${deadline ? 'deadline' : 'date'}">
        <div class="picker-field">
          <label for="event-date">Date</label>
          <input id="event-date" name="date" type="date" required min="${esc(state.minDate)}"${maxAttr} value="${esc(state.dateValue ?? '')}">
        </div>
        ${timeFields}
        <button class="btn btn-primary" type="submit">Continue</button>
      </form>
    </section>`;
  const pastMessage = deadline
    ? 'RSVP deadline must be before the event.'
    : 'Please choose today or a future date.';
  const script = `${PICKER_CSS}
<script>
(function () {
  var input = document.getElementById('event-date');
  if (!input) return;
  var min = input.getAttribute('min') || '';
  var max = input.getAttribute('max') || '';
  var pastMessage = ${JSON.stringify(pastMessage)};
  var beforeEventMessage = 'RSVP deadline must be before the event.';
  function rejectPast() {
    if (min && input.value && input.value < min) {
      input.setCustomValidity(pastMessage);
    } else if (max && input.value && input.value > max) {
      input.setCustomValidity(beforeEventMessage);
    } else {
      input.setCustomValidity('');
    }
  }
  input.addEventListener('change', rejectPast);
  input.addEventListener('input', rejectPast);
  rejectPast();
})();
</script>`;
  return renderConnectLayout(
    deadline
      ? 'Pick a deadline — CONNECT'
      : includeTime
        ? 'Pick date and time — CONNECT'
        : 'Pick a date — CONNECT',
    body,
    script,
  );
}

export function renderEventWhenTimePage(state: EventWhenTimeState): string {
  const deadline = state.purpose === 'deadline';
  const error = state.error ? `<p class="error">${esc(state.error)}</p>` : '';
  const heading = deadline
    ? 'What time should RSVPs close?'
    : `What time should ${esc(eventHeading(state.eventName))} start?`;
  const body = `
    <section class="card">
      <p class="eyebrow">⏰</p>
      <h1 class="event-name">${heading}</h1>
      <p class="note">${esc(state.dateLabel)}</p>
      ${error}
      <form method="post" action="" id="time-form">
        <input type="hidden" name="step" value="time">
        <div class="time-grid">
          <div class="picker-field">
            <label for="event-hour">Hour</label>
            <select id="event-hour" name="hour" required>
              ${optionList(HOURS, state.hour ?? '7')}
            </select>
          </div>
          <div class="picker-field">
            <label for="event-minute">Minute</label>
            <select id="event-minute" name="minute" required>
              ${optionList(MINUTES, state.minute ?? '00')}
            </select>
          </div>
          <div class="picker-field">
            <label for="event-meridiem">AM/PM</label>
            <select id="event-meridiem" name="meridiem" required>
              ${optionList(['AM', 'PM'], state.meridiem ?? 'PM')}
            </select>
          </div>
        </div>
        <button class="btn btn-primary" type="submit">Continue</button>
      </form>
    </section>`;
  return renderConnectLayout(
    deadline ? 'Pick a deadline time — CONNECT' : 'Pick a time — CONNECT',
    body,
    PICKER_CSS,
  );
}
