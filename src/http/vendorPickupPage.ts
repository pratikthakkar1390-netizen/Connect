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

const HOURS = ['12', '1', '2', '3', '4', '5', '6', '7', '8'];
const MINUTES = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, '0'));

function optionList(values: string[], selected?: string): string {
  return values
    .map((value) => {
      const isSelected = value === selected ? ' selected' : '';
      return `<option value="${esc(value)}"${isSelected}>${esc(value)}</option>`;
    })
    .join('');
}

export function renderVendorPickupDatePage(state: {
  minDate: string;
  dateValue?: string;
  error?: string;
}): string {
  const error = state.error ? `<p class="error">${esc(state.error)}</p>` : '';
  const body = `
    <section class="card">
      <p class="eyebrow">📅</p>
      <h1 class="event-name">Pickup date</h1>
      <p class="note">Choose Tuesday through Sunday. Pickup is closed on Monday. Same-day pickup is only available before 12:00 PM.</p>
      ${error}
      <form method="post" action="" id="date-form">
        <input type="hidden" name="step" value="date">
        <div class="picker-field">
          <label for="pickup-date">Date</label>
          <input id="pickup-date" name="date" type="date" required min="${esc(state.minDate)}" value="${esc(state.dateValue ?? '')}">
        </div>
        <button class="btn btn-primary" type="submit">Continue</button>
      </form>
    </section>`;
  const script = `${PICKER_CSS}
<script>
(function () {
  var input = document.getElementById('pickup-date');
  if (!input) return;
  var min = input.getAttribute('min') || '';
  var form = document.getElementById('date-form');
  function weekdayUtc(value) {
    var parts = String(value).split('-');
    if (parts.length !== 3) return -1;
    return new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]), 12)).getUTCDay();
  }
  function validityMessage(value) {
    if (min && value && value < min) return 'Please choose today or a future date.';
    if (weekdayUtc(value) === 1) return 'Pickup is not available on Monday. Please choose Tuesday through Sunday.';
    return '';
  }
  function rejectInvalid() {
    input.setCustomValidity(validityMessage(input.value));
  }
  input.addEventListener('change', rejectInvalid);
  input.addEventListener('input', rejectInvalid);
  if (form) {
    form.addEventListener('submit', function (event) {
      var message = validityMessage(input.value);
      if (message) {
        event.preventDefault();
        alert(message);
      }
    });
  }
  rejectInvalid();
})();
</script>`;
  return renderConnectLayout('Pickup date — CONNECT', body + script);
}

export function renderVendorPickupTimePage(state: {
  dateValue: string;
  dateLabel?: string;
  hour?: string;
  minute?: string;
  error?: string;
}): string {
  const error = state.error ? `<p class="error">${esc(state.error)}</p>` : '';
  const body = `
    <section class="card">
      <p class="eyebrow">⏰</p>
      <h1 class="event-name">Pickup time</h1>
      <p class="note">${esc(state.dateLabel ?? state.dateValue)} — choose any time from 12:00 PM to 8:00 PM.</p>
      ${error}
      <form method="post" action="" id="time-form">
        <input type="hidden" name="step" value="time">
        <input type="hidden" name="date" value="${esc(state.dateValue)}">
        <div class="time-grid">
          <div class="picker-field">
            <label for="pickup-hour">Hour</label>
            <select id="pickup-hour" name="hour" required>
              ${optionList(HOURS, state.hour ?? '12')}
            </select>
          </div>
          <div class="picker-field">
            <label for="pickup-minute">Minute</label>
            <select id="pickup-minute" name="minute" required>
              ${optionList(MINUTES, state.minute ?? '00')}
            </select>
          </div>
          <div class="picker-field">
            <label for="pickup-meridiem">AM/PM</label>
            <select id="pickup-meridiem" name="meridiem" required>
              <option value="PM" selected>PM</option>
            </select>
          </div>
        </div>
        <button class="btn btn-primary" type="submit">Continue</button>
      </form>
    </section>`;
  return renderConnectLayout('Pickup time — CONNECT', body + PICKER_CSS);
}

export function renderVendorPickupDonePage(): string {
  return renderConnectLayout(
    'Return to WhatsApp — CONNECT',
    `<section class="card success">
      <p class="success-icon">✅</p>
      <h1>Return to WhatsApp</h1>
      <p>Your pickup date and time are set. You can close this page and confirm in WhatsApp.</p>
    </section>`,
  );
}

export function renderInvalidVendorPickupPage(): string {
  return renderConnectLayout(
    'Link expired — CONNECT',
    `<section class="card">
      <p class="eyebrow">🔗</p>
      <h1 class="event-name">This picker isn’t available</h1>
      <p class="note">This link isn’t valid, or the pickup step is no longer open. Return to WhatsApp to continue.</p>
    </section>`,
  );
}
