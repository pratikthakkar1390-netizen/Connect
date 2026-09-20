import { esc } from '../admin/html.js';
import { renderConnectLayout } from './rsvpPage.js';
import type { TimezoneSearchHit } from '../timezones/catalog.js';

const PICKER_CSS = `
<style>
.picker-field { margin: 0.85rem 0 0.25rem; }
.picker-field label { display: block; font-weight: 600; margin-bottom: 0.4rem; }
.picker-field input[type="search"] {
  width: 100%;
  padding: 0.85rem 0.9rem;
  border: 1px solid var(--line);
  border-radius: 0.75rem;
  font: inherit;
  font-size: 1.05rem;
  background: #fff;
}
.city-list { list-style: none; padding: 0; margin: 0.75rem 0 0; }
.city-list li { margin: 0 0 0.45rem; }
.city-list button {
  width: 100%;
  text-align: left;
  padding: 0.85rem 0.9rem;
  border: 1px solid var(--line);
  border-radius: 0.75rem;
  background: #fff;
  font: inherit;
  cursor: pointer;
}
.city-list .city { font-weight: 650; }
.city-list .meta { color: var(--muted); font-size: 0.92rem; margin-top: 0.15rem; }
</style>`;

export function renderEventTimezonePage(state: {
  query?: string;
  results: TimezoneSearchHit[];
  error?: string;
}): string {
  const error = state.error ? `<p class="error">${esc(state.error)}</p>` : '';
  const rows = state.results
    .map(
      (hit) => `<li>
        <form method="post" action="">
          <input type="hidden" name="iana" value="${esc(hit.iana)}">
          <button type="submit">
            <div class="city">${esc(hit.city)}</div>
            <div class="meta">${esc(hit.country)} · ${esc(hit.label)}</div>
          </button>
        </form>
      </li>`,
    )
    .join('');
  const empty =
    state.results.length === 0
      ? `<p class="note">No matching cities. Try another city or country name.</p>`
      : '';
  const body = `
    <section class="card">
      <p class="eyebrow">🌍</p>
      <h1 class="event-name">Event timezone</h1>
      <p class="note">Search for the city or country where the event happens. Times you enter next (for example 7:00 PM) will be in that local time.</p>
      ${error}
      <form method="get" action="" class="picker-field">
        <label for="tz-search">City or country</label>
        <input id="tz-search" name="q" type="search" value="${esc(state.query ?? '')}" placeholder="Mumbai, Auckland, Buenos Aires">
        <button class="btn btn-primary" type="submit" style="margin-top:0.75rem">Search</button>
      </form>
      ${empty}
      <ul class="city-list">${rows}</ul>
    </section>`;
  return renderConnectLayout('Event timezone — CONNECT', body + PICKER_CSS);
}

export function renderEventTimezoneDonePage(label: string): string {
  return renderConnectLayout(
    'Timezone saved — CONNECT',
    `<section class="card success">
      <p class="success-icon">✅</p>
      <h1>Timezone set</h1>
      <p>Times for this event are in ${esc(label)}. Return to WhatsApp to pick the date and time.</p>
    </section>`,
  );
}

export function renderInvalidEventTimezonePage(): string {
  return renderConnectLayout(
    'Link expired — CONNECT',
    `<section class="card">
      <p class="eyebrow">🔗</p>
      <h1 class="event-name">This picker isn’t available</h1>
      <p class="note">This link isn’t valid or the timezone step is no longer open. Return to WhatsApp to continue.</p>
    </section>`,
  );
}
