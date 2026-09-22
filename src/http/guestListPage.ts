import { esc, formatDateTime } from '../admin/html.js';
import {
  formatGuestListRow,
  guestDisplayName,
  guestStatusLabel,
  guestWhatsAppDisplay,
  type GuestListEntry,
} from '../commands/guestList.js';
import type { Event } from '../db/store.js';
import { renderConnectLayout } from './rsvpPage.js';

const PAGE_CSS = `
<style>
.guest-search { margin: 0.85rem 0 1rem; }
.guest-search input[type="search"] {
  width: 100%;
  padding: 0.85rem 0.9rem;
  border: 1px solid var(--line);
  border-radius: 0.75rem;
  font: inherit;
  font-size: 1.05rem;
  background: #fff;
}
.guest-search button { margin-top: 0.75rem; }
.summary-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.55rem;
  margin: 0.85rem 0 1.1rem;
}
.summary-grid p {
  margin: 0;
  padding: 0.65rem 0.7rem;
  background: var(--paper);
  border-radius: 0.75rem;
  font-size: 0.95rem;
}
.guest-list { list-style: none; padding: 0; margin: 0; }
.guest-list li { margin: 0 0 0.55rem; }
.guest-list a {
  display: block;
  text-decoration: none;
  color: inherit;
  padding: 0.9rem 0.95rem;
  border: 1px solid var(--line);
  border-radius: 0.85rem;
  background: #fff;
}
.guest-list .name { font-weight: 650; }
.guest-list .meta {
  color: var(--muted);
  font-size: 0.92rem;
  margin-top: 0.25rem;
  white-space: pre-line;
}
.detail p { margin: 0.35rem 0; }
.back { display: inline-block; margin-top: 1rem; }
</style>`;

export function renderGuestListPage(state: {
  event: Event;
  summary: string;
  query?: string;
  entries: GuestListEntry[];
  tokenPath: string;
}): string {
  const rows = state.entries
    .map((entry) => {
      const row = formatGuestListRow(entry);
      const [name, ...rest] = row.split('\n');
      return `<li>
        <a href="${esc(`${state.tokenPath}/g/${entry.guestId}`)}">
          <div class="name">${esc(name)}</div>
          <div class="meta">${esc(rest.join('\n'))}</div>
        </a>
      </li>`;
    })
    .join('');
  const empty =
    state.entries.length === 0
      ? `<p class="note">${state.query?.trim() ? 'No guests match that search.' : 'No guests yet. Send invitations first.'}</p>`
      : '';
  const summaryLines = state.summary
    .split('\n')
    .filter((line) => line && line !== `🎉 ${state.event.name}` && line !== 'Summary:')
    .map((line) => `<p>${esc(line)}</p>`)
    .join('');
  const body = `
    <section class="card">
      <p class="eyebrow">👥</p>
      <h1 class="event-name">🎉 ${esc(state.event.name)}</h1>
      <div class="summary-grid">${summaryLines}</div>
      <form method="get" action="${esc(state.tokenPath)}" class="guest-search">
        <label for="guest-search">Search guests</label>
        <input id="guest-search" name="q" type="search" value="${esc(state.query ?? '')}" placeholder="Name or WhatsApp number">
        <button class="btn btn-primary" type="submit">Search</button>
      </form>
      ${empty}
      <ul class="guest-list">${rows}</ul>
    </section>`;
  return renderConnectLayout(
    `Guest List — ${state.event.name} — CONNECT`,
    body + PAGE_CSS,
  );
}

export function renderGuestDetailPage(state: {
  event: Event;
  entry: GuestListEntry;
  tokenPath: string;
}): string {
  const extra: string[] = [];
  if (state.entry.invitationType === 'family') {
    extra.push(
      `Invitation: Family${state.entry.familyName ? ` — ${state.entry.familyName}` : ''}${
        state.entry.maxGuests != null ? ` (max ${state.entry.maxGuests})` : ''
      }`,
    );
  } else if (state.entry.invitationType === 'group') {
    extra.push(
      `Invitation: Group${state.entry.groupName ? ` — ${state.entry.groupName}` : ''}`,
    );
  } else if (state.entry.invitationType === 'individual') {
    extra.push('Invitation: Individual');
  }
  const adults = state.entry.status === 'yes' ? state.entry.adultCount : 0;
  const children = state.entry.status === 'yes' ? state.entry.childCount : 0;
  const total = state.entry.status === 'yes' ? state.entry.total : 0;
  const body = `
    <section class="card">
      <p class="eyebrow">👤</p>
      <h1 class="event-name">${esc(guestDisplayName(state.entry))}</h1>
      <div class="detail">
        <p>Status: ${esc(guestStatusLabel(state.entry.status))}</p>
        <p>WhatsApp: ${esc(guestWhatsAppDisplay(state.entry))}</p>
        <p>Adults: ${adults}</p>
        <p>Children: ${children}</p>
        <p>Total: ${total}</p>
        <p>Invited: ${esc(state.entry.invitedAt ? formatDateTime(state.entry.invitedAt) : '—')}</p>
        <p>Responded: ${esc(state.entry.respondedAt ? formatDateTime(state.entry.respondedAt) : '—')}</p>
        ${extra.map((line) => `<p>${esc(line)}</p>`).join('')}
      </div>
      <a class="back" href="${esc(state.tokenPath)}">← Guest List</a>
    </section>`;
  return renderConnectLayout(
    `${guestDisplayName(state.entry)} — ${state.event.name} — CONNECT`,
    body + PAGE_CSS,
  );
}

export function renderInvalidGuestListPage(): string {
  return renderConnectLayout(
    'Guest list unavailable — CONNECT',
    `<section class="card">
      <p class="eyebrow">👥</p>
      <h1 class="event-name">Guest list unavailable</h1>
      <p class="note">This link is invalid, expired, or you do not have access to this event.</p>
    </section>`,
  );
}
