import { esc } from '../admin/html.js';
import {
  CONNECT_VCARD_FILENAME,
  CONNECT_VCARD_PATH,
  buildConnectVCard,
} from '../commands/saveContact.js';
import type { Event, Rsvp, RsvpStatus } from '../db/store.js';
import {
  EVENT_THEME_PAGE_CSS,
  themeCssClass,
  themeLabel,
} from '../events/theme.js';
import { resolveEventMapsUrl } from '../maps/location.js';
import { formatEventTimezoneLine } from '../dates/eventDate.js';

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

const PAGE_CSS = `
:root {
  --ink: #1a1a2e;
  --muted: #5c5c72;
  --line: #e6e2d8;
  --paper: #fffdf8;
  --card: #ffffff;
  --yes: #0f766e;
  --yes-bg: #ecfdf8;
  --no: #9f1239;
  --no-bg: #fff1f2;
  --maybe: #92400e;
  --maybe-bg: #fffbeb;
  --accent: #1a1a2e;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100vh;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  color: var(--ink);
  background:
    radial-gradient(1200px 400px at 50% -80px, #efe8d8 0%, transparent 60%),
    #f6f3ee;
}
.wrap {
  width: min(28rem, calc(100% - 2rem));
  margin: 0 auto;
  padding: 1.5rem 0 2.5rem;
}
.brand {
  text-align: center;
  margin-bottom: 1.25rem;
}
.brand-name {
  margin: 0;
  font-size: 1.35rem;
  letter-spacing: 0.08em;
  font-weight: 700;
}
.brand-by {
  margin: 0.15rem 0 0;
  color: var(--muted);
  font-size: 0.85rem;
}
.brand-tag {
  margin: 0.35rem 0 0;
  font-size: 0.95rem;
  font-style: italic;
  color: #3f3f56;
}
.card {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 1.25rem;
  padding: 1.4rem 1.25rem 1.5rem;
  box-shadow: 0 16px 40px rgba(26, 26, 46, 0.06);
}
.eyebrow {
  margin: 0 0 0.35rem;
  text-align: center;
  font-size: 1.15rem;
}
.event-name {
  margin: 0 0 1rem;
  text-align: center;
  font-size: 1.65rem;
  line-height: 1.2;
}
.event-photo {
  display: block;
  width: 100%;
  max-height: 20rem;
  object-fit: cover;
  border-radius: 0.9rem;
  margin: 0 0 1rem;
  background: var(--paper);
}
.meta {
  display: grid;
  gap: 0.45rem;
  margin: 0 0 1.35rem;
  padding: 0.85rem 0.9rem;
  background: var(--paper);
  border-radius: 0.9rem;
}
.meta p {
  margin: 0;
  font-size: 0.98rem;
}
.prompt {
  margin: 0 0 0.85rem;
  text-align: center;
  font-weight: 650;
}
.choices {
  display: grid;
  gap: 0.65rem;
}
.btn {
  appearance: none;
  width: 100%;
  border: 1px solid transparent;
  border-radius: 0.9rem;
  padding: 0.95rem 1rem;
  font: inherit;
  font-weight: 650;
  cursor: pointer;
}
a.btn {
  display: block;
  text-align: center;
  text-decoration: none;
}
.btn-yes { background: var(--yes-bg); color: var(--yes); border-color: #99f6e4; }
.btn-no { background: var(--no-bg); color: var(--no); border-color: #fecdd3; }
.btn-maybe { background: var(--maybe-bg); color: var(--maybe); border-color: #fde68a; }
.btn.selected { box-shadow: inset 0 0 0 2px currentColor; }
.btn-primary {
  margin-top: 1rem;
  background: var(--accent);
  color: #fff;
}
.name-block h2 {
  margin: 0 0 0.45rem;
  font-size: 1.15rem;
  text-align: center;
}
.name-field { margin: 0.85rem 0 0.25rem; }
.name-field label { display: block; font-weight: 600; margin-bottom: 0.4rem; }
.name-field input {
  width: 100%;
  padding: 0.85rem 0.9rem;
  border: 1px solid var(--line);
  border-radius: 0.75rem;
  font: inherit;
  font-size: 1rem;
}
.counts { margin-top: 1.15rem; display: none; }
.counts.open { display: block; }
.counts h2 {
  margin: 0 0 0.85rem;
  font-size: 1.05rem;
  text-align: center;
}
.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  margin-bottom: 0.7rem;
}
.row label { font-weight: 600; }
.stepper {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}
.stepper button {
  width: 2.4rem;
  height: 2.4rem;
  border: 1px solid var(--line);
  border-radius: 0.7rem;
  background: #fff;
  font-size: 1.2rem;
  cursor: pointer;
}
.stepper input {
  width: 3rem;
  height: 2.4rem;
  text-align: center;
  border: 1px solid var(--line);
  border-radius: 0.7rem;
  font: inherit;
  font-size: 1rem;
}
.error {
  margin: 0 0 0.85rem;
  padding: 0.75rem 0.85rem;
  border-radius: 0.75rem;
  background: #fff1f2;
  color: var(--no);
  font-size: 0.95rem;
}
.note {
  margin: 0 0 0.9rem;
  text-align: center;
  color: var(--muted);
  font-size: 0.92rem;
}
.success-icon {
  margin: 0 0 0.5rem;
  text-align: center;
  font-size: 1.8rem;
}
.success h1 {
  margin: 0 0 0.75rem;
  text-align: center;
  font-size: 1.35rem;
}
.success p {
  margin: 0 0 0.75rem;
  line-height: 1.5;
}
.footer {
  margin: 1.25rem 0 0;
  text-align: center;
  color: var(--muted);
  font-size: 0.85rem;
}
.family-banner {
  margin: 0 0 0.85rem;
  padding: 0.85rem 0.9rem;
  text-align: center;
  background: var(--paper);
  border-radius: 0.9rem;
}
.family-banner .family-title {
  margin: 0;
  font-weight: 650;
  font-size: 1.05rem;
}
.family-banner .family-max {
  margin: 0.3rem 0 0;
  color: var(--muted);
  font-size: 0.95rem;
}
.save-kicker {
  margin: 1.15rem 0 0.35rem;
  text-align: center;
  font-weight: 650;
}
a.btn-save {
  margin-top: 0.35rem;
  margin-bottom: 1rem;
}
.guest-total {
  margin: 0.85rem 0 0;
  text-align: center;
  font-weight: 650;
}
${EVENT_THEME_PAGE_CSS}
`;

export function renderConnectLayout(
  title: string,
  body: string,
  extraScript = '',
): string {
  return layout(title, body, extraScript);
}

function layout(
  title: string,
  body: string,
  extraScript = '',
  theme?: string | null,
): string {
  const themeClass = themeCssClass(theme);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  <style>${PAGE_CSS}</style>
</head>
<body${themeClass ? ` class="${esc(themeClass)}"` : ''}>
  <div class="wrap">
    <header class="brand">
      <p class="brand-name">CONNECT</p>
      <p class="brand-by">by zipbite</p>
      <p class="brand-tag">Moments to Memory</p>
    </header>
    ${body}
    <p class="footer">Powered by zipbite</p>
  </div>
  ${extraScript}
</body>
</html>`;
}

function eventMetaHtml(event: Event): string {
  const when = splitEventWhen(event.date);
  const lines = [`<p>📅 ${esc(when.dateLabel)}</p>`];
  if (when.timeLabel) {
    lines.push(`<p>⏰ ${esc(when.timeLabel)}</p>`);
  }
  lines.push(`<p>${esc(formatEventTimezoneLine(event.timezone))}</p>`);
  if (event.location?.trim()) {
    lines.push(`<p>📍 ${esc(event.location.trim())}</p>`);
  }
  const address = event.location_address?.trim();
  if (address && address !== event.location?.trim()) {
    lines.push(`<p class="address">${esc(address)}</p>`);
  }
  const mapsUrl = resolveEventMapsUrl(event);
  if (mapsUrl) {
    lines.push(
      `<p><a class="maps-link" href="${esc(mapsUrl)}" target="_blank" rel="noopener noreferrer">🗺️ View on Google Maps</a></p>`,
    );
  }
  return `<div class="meta">${lines.join('')}</div>`;
}

export function publicEventImageSrc(event: Event): string | null {
  if (!event.image_filename?.trim() || !event.rsvp_token?.trim()) {
    return null;
  }
  return `/i/${encodeURIComponent(event.rsvp_token.trim())}`;
}

function eventPhotoHtml(event: Event): string {
  const src = publicEventImageSrc(event);
  if (!src) {
    return '';
  }
  return `<img class="event-photo" src="${esc(src)}" alt="">`;
}

function eventThemeDressHtml(event: Event): string {
  const parts: string[] = [];
  const custom = event.theme === 'custom' ? event.custom_theme?.trim() : '';
  const predefined = event.theme !== 'custom' ? themeLabel(event.theme) : null;
  if (predefined) {
    parts.push(
      `<div class="theme-block"><p class="theme-kicker">🎨 Event Style</p><p>${esc(predefined)}</p></div>`,
    );
  } else if (custom) {
    parts.push(
      `<div class="theme-block"><p class="theme-kicker">🎨 Event Style</p><p>${esc(custom)}</p></div>`,
    );
  }
  if (event.dress_code?.trim()) {
    parts.push(
      `<div class="dress-block"><p class="dress-kicker">👗 What to Wear</p><p>${esc(event.dress_code.trim())}</p></div>`,
    );
  }
  return parts.join('');
}

export function renderInvalidRsvpPage(): string {
  return layout(
    'Invitation not found — CONNECT',
    `<section class="card">
      <p class="eyebrow">🔗</p>
      <h1 class="event-name">This invitation isn’t available</h1>
      <p class="note">This link isn't valid, or the invitation is no longer available. Ask the organizer for a new invitation if you still need to RSVP.</p>
    </section>`,
  );
}

export function renderClosedRsvpPage(eventName?: string): string {
  const heading = eventName?.trim()
    ? `RSVPs for ${eventName.trim()} are closed`
    : 'RSVPs are closed';
  return layout(
    'RSVPs closed — CONNECT',
    `<section class="card">
      <p class="eyebrow">⏰</p>
      <h1 class="event-name">${esc(heading)}</h1>
      <p class="note">This event is no longer accepting RSVPs. Contact the organizer if you need help.</p>
    </section>`,
  );
}

export function renderCancelledRsvpPage(eventName?: string): string {
  const heading = eventName?.trim() ? eventName.trim() : 'This event';
  return layout(
    'Event cancelled — CONNECT',
    `<section class="card">
      <p class="eyebrow">❌</p>
      <h1 class="event-name">Event Cancelled</h1>
      <p class="note">${esc(heading)} has been cancelled by the organizer.</p>
      <p class="note">New RSVPs are no longer accepted.</p>
    </section>`,
  );
}

export interface RsvpFormState {
  current?: Rsvp;
  askCounts: boolean;
  askName?: boolean;
  askWhatsApp?: boolean;
  selectedStatus?: RsvpStatus;
  guestName?: string;
  error?: string;
  adults: number;
  children: number;
  maxGuests: number | null;
  childrenAllowed: boolean;
  isFamily?: boolean;
}

function selectedClass(current: Rsvp | undefined, status: RsvpStatus): string {
  return current?.status === status ? ' selected' : '';
}

function hiddenFields(state: RsvpFormState, includeName: boolean): string {
  const status = state.selectedStatus ?? state.current?.status;
  const parts: string[] = [];
  if (status === 'yes' || status === 'no' || status === 'maybe') {
    parts.push(`<input type="hidden" name="response" value="${status}">`);
  }
  if (includeName && state.guestName) {
    parts.push(`<input type="hidden" name="name" value="${esc(state.guestName)}">`);
  }
  return parts.join('');
}

function renderNameForm(state: RsvpFormState): string {
  const status = state.selectedStatus ?? 'yes';
  const heading = state.isFamily
    ? 'Who is responding for this family?'
    : "What's your name?";
  const note = state.isFamily
    ? 'Enter the name of the person responding so the organizer knows who replied.'
    : 'Please enter your name so the organizer knows who responded.';
  return `<form method="post" action="" id="name-form">
        <input type="hidden" name="response" value="${status}">
        <div class="name-block">
          <h2>${heading}</h2>
          <p class="note">${note}</p>
          <div class="name-field">
            <label for="guest-name">Name</label>
            <input id="guest-name" name="name" type="text" maxlength="80" autocomplete="name" required value="${esc(state.guestName ?? '')}">
          </div>
          <button class="btn btn-primary" type="submit">Continue</button>
        </div>
      </form>`;
}

function renderWhatsAppForm(state: RsvpFormState): string {
  const status = state.selectedStatus ?? 'yes';
  return `<form method="post" action="" id="whatsapp-form">
        <input type="hidden" name="response" value="${status}">
        ${state.guestName ? `<input type="hidden" name="name" value="${esc(state.guestName)}">` : ''}
        <div class="name-block">
          <h2>📱 WhatsApp Number</h2>
          <p class="note">Enter the WhatsApp number you'd like CONNECT to use for event updates.</p>
          <div class="name-field">
            <label for="guest-whatsapp">WhatsApp number</label>
            <input id="guest-whatsapp" name="whatsapp" type="tel" inputmode="tel" autocomplete="tel" required value="">
          </div>
          <button class="btn btn-primary" type="submit">Continue</button>
        </div>
      </form>`;
}

export function renderRsvpPage(event: Event, state: RsvpFormState): string {
  const countsOpen =
    !state.askName &&
    !state.askWhatsApp &&
    (state.askCounts || state.current?.status === 'yes');
  const existingNote =
    state.current && !state.askCounts && !state.askName && !state.askWhatsApp
      ? `<p class="note">You already responded. You can update your RSVP before the deadline.</p>`
      : '';
  const error = state.error ? `<p class="error">${esc(state.error)}</p>` : '';
  const childrenRow = state.childrenAllowed
    ? `<div class="row">
          <label for="children">Children</label>
          <div class="stepper">
            <button type="button" data-target="children" data-delta="-1" aria-label="Fewer children">−</button>
            <input id="children" name="children" type="number" inputmode="numeric" min="0" max="${state.maxGuests ?? 99}" value="${state.children}">
            <button type="button" data-target="children" data-delta="1" aria-label="More children">+</button>
          </div>
        </div>`
    : '';

  const familyMaxLabel =
    state.maxGuests != null
      ? `Up to ${state.maxGuests} guest${state.maxGuests === 1 ? '' : 's'}`
      : '';
  const familyBanner = state.isFamily
    ? `<div class="family-banner">
        <p class="family-title">👨‍👩‍👧‍👦 Family Invitation</p>
        ${familyMaxLabel ? `<p class="family-max">${familyMaxLabel}</p>` : ''}
      </div>`
    : '';

  const choiceForm =
    state.askName || state.askWhatsApp || (state.askCounts && state.selectedStatus)
    ? ''
    : `<form method="post" action="" id="choice-form">
        ${familyBanner}
        <p class="prompt">${state.isFamily ? 'Will your family be attending?' : 'Will you be attending?'}</p>
        <div class="choices">
          <button class="btn btn-yes${selectedClass(state.current, 'yes')}" type="submit" name="response" value="yes" id="choice-yes">Yes, I'll be there</button>
          <button class="btn btn-no${selectedClass(state.current, 'no')}" type="submit" name="response" value="no">Can't make it</button>
          <button class="btn btn-maybe${selectedClass(state.current, 'maybe')}" type="submit" name="response" value="maybe">Maybe</button>
        </div>
      </form>`;

  const nameForm = state.askName ? renderNameForm(state) : '';
  const whatsappForm = state.askWhatsApp ? renderWhatsAppForm(state) : '';

  const liveTotal =
    state.isFamily && state.maxGuests != null
      ? `<p class="guest-total" id="guest-total">${state.adults + state.children} of ${state.maxGuests} guests</p>`
      : '';

  const countForm =
    state.askName || state.askWhatsApp
      ? ''
      : `<form method="post" action="" id="rsvp-form">
        ${hiddenFields(state, true)}
        <div class="counts${countsOpen ? ' open' : ''}" id="count-panel"${state.isFamily && state.maxGuests != null ? ` data-max-guests="${state.maxGuests}"` : ''}>
          <h2>${state.isFamily ? 'How many people will attend?' : 'Who will be attending?'}</h2>
          <div class="row">
            <label for="adults">Adults</label>
            <div class="stepper">
              <button type="button" data-target="adults" data-delta="-1" aria-label="Fewer adults">−</button>
              <input id="adults" name="adults" type="number" inputmode="numeric" min="1" max="${state.maxGuests ?? 99}" value="${state.adults}">
              <button type="button" data-target="adults" data-delta="1" aria-label="More adults">+</button>
            </div>
          </div>
          ${childrenRow}
          ${liveTotal}
          <button class="btn btn-primary" type="submit" name="response" value="yes" id="confirm-yes">Confirm RSVP</button>
        </div>
      </form>`;

  const body = `
    <section class="card">
      <p class="eyebrow">🎉 You're Invited!</p>
      <h1 class="event-name">${esc(event.name)}</h1>
      ${event.theme === 'custom' && event.custom_theme?.trim() ? `<p class="theme-note">${esc(event.custom_theme.trim())}</p>` : ''}
      ${eventPhotoHtml(event)}
      ${eventMetaHtml(event)}
      ${eventThemeDressHtml(event)}
      ${existingNote}
      ${error}
      ${!choiceForm && familyBanner ? familyBanner : ''}
      ${choiceForm}
      ${nameForm}
      ${whatsappForm}
      ${countForm}
    </section>`;

  const script = `<script>
(function () {
  var panel = document.getElementById('count-panel');
  if (!panel) return;
  var maxGuests = Number(panel.getAttribute('data-max-guests') || 0);
  var adultsInput = document.getElementById('adults');
  var childrenInput = document.getElementById('children');
  var totalEl = document.getElementById('guest-total');
  function adultVal() { return Number((adultsInput && adultsInput.value) || 0); }
  function childVal() { return Number((childrenInput && childrenInput.value) || 0); }
  function updateTotal() {
    if (!totalEl || !maxGuests) return;
    totalEl.textContent = (adultVal() + childVal()) + ' of ' + maxGuests + ' guests';
  }
  panel.querySelectorAll('button[data-target]').forEach(function (button) {
    button.addEventListener('click', function () {
      var target = document.getElementById(button.getAttribute('data-target'));
      if (!target) return;
      var delta = Number(button.getAttribute('data-delta') || 0);
      var min = Number(target.getAttribute('min') || 0);
      var max = Number(target.getAttribute('max') || 99);
      if (maxGuests) {
        var other = target.id === 'adults' ? childVal() : adultVal();
        max = Math.min(max, maxGuests - other);
      }
      var next = Math.min(max, Math.max(min, Number(target.value || 0) + delta));
      target.value = String(next);
      updateTotal();
    });
  });
  if (maxGuests) {
    [adultsInput, childrenInput].forEach(function (input) {
      if (!input) return;
      input.addEventListener('input', function () {
        var min = Number(input.getAttribute('min') || 0);
        var other = input.id === 'adults' ? childVal() : adultVal();
        var max = Math.min(Number(input.getAttribute('max') || 99), maxGuests - other);
        input.value = String(Math.min(max, Math.max(min, Number(input.value || 0))));
        updateTotal();
      });
    });
    updateTotal();
  }
})();
</script>`;

  return layout(`${event.name} — CONNECT`, body, script, event.theme);
}

export function renderInvalidAckPage(): string {
  return layout(
    'Update not found — CONNECT',
    `<section class="card">
      <p class="eyebrow">🔗</p>
      <h1 class="event-name">This acknowledgement link isn’t available</h1>
      <p class="note">This link isn't valid, or the update is no longer available. Ask the organizer if you still need to review this event update.</p>
    </section>`,
  );
}

export function renderAckUpdatePage(
  event: Event,
  options: { rsvpUrl: string | null; message?: string | null },
): string {
  const extra = options.message?.trim()
    ? `<p class="note">${esc(options.message.trim())}</p>`
    : '';
  const rsvp = options.rsvpUrl
    ? `<a class="btn btn-maybe" href="${esc(options.rsvpUrl)}">💌 Update RSVP</a>`
    : '';
  return layout(
    `${event.name} — CONNECT`,
    `<section class="card">
      <p class="eyebrow">⚠️ Important Event Update</p>
      <h1 class="event-name">${esc(event.name)}</h1>
      ${eventMetaHtml(event)}
      ${eventThemeDressHtml(event)}
      ${extra}
      <p class="prompt">Have you received and reviewed this update?</p>
      <form method="post" action="" class="choices">
        <button class="btn btn-yes" type="submit" name="ack" value="1">✅ Acknowledge Update</button>
      </form>
      ${rsvp}
    </section>`,
    '',
    event.theme,
  );
}

export function renderAckThankYouPage(
  event: Event,
  options: { rsvpUrl: string | null },
): string {
  const rsvp = options.rsvpUrl
    ? `<a class="btn btn-maybe" href="${esc(options.rsvpUrl)}">💌 Update RSVP</a>`
    : '';
  return layout(
    'Acknowledgement recorded — CONNECT',
    `<section class="card success">
      <p class="success-icon">✅</p>
      <h1>Thank you!</h1>
      <p>Your acknowledgement has been recorded.</p>
      <p class="note">If you want to change attendance, you can use Update RSVP.</p>
      ${rsvp}
    </section>`,
  );
}

export function renderSuccessPage(guestName: string): string {
  const name = guestName.trim() || 'Guest';
  const vcard = buildConnectVCard();
  const saveBlock = vcard
    ? `<p class="save-kicker">📱 Save CONNECT</p>
      <p>Save our number so you can easily find CONNECT for future events.</p>
      <a class="btn btn-primary btn-save" id="save-connect" href="${esc(CONNECT_VCARD_PATH)}" download="${esc(CONNECT_VCARD_FILENAME)}">Save CONNECT</a>`
    : '';
  return layout(
    'RSVP Confirmed — CONNECT',
    `<section class="card success">
      <p class="success-icon">✅</p>
      <h1>RSVP Confirmed!</h1>
      <p>Thank you, ${esc(name)}. Your RSVP has been recorded.</p>
      ${saveBlock}
      <p>Need to change your RSVP?</p>
      <p>Simply open the invitation link again to update your response.</p>
    </section>`,
  );
}
