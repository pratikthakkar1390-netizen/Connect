import { esc } from '../admin/html.js';
import type { Event } from '../db/store.js';
import { renderConnectLayout } from './rsvpPage.js';
import { formatEventTimezoneLine } from '../dates/eventDate.js';
import { signOwnedEventRef } from './myEventsToken.js';

const PAGE_CSS = `
<style>
.event-pick { list-style: none; margin: 0 0 1rem; padding: 0; display: grid; gap: 0.65rem; }
.event-pick li { margin: 0; }
.event-pick label {
  display: flex;
  align-items: flex-start;
  gap: 0.75rem;
  padding: 0.85rem 0.9rem;
  border: 1px solid var(--line);
  border-radius: 0.9rem;
  background: var(--paper);
  cursor: pointer;
}
.event-pick input { margin-top: 0.3rem; width: 1.15rem; height: 1.15rem; flex: 0 0 auto; }
.event-pick .pick-name { margin: 0; font-weight: 650; }
.event-pick .pick-meta { margin: 0.2rem 0 0; color: var(--muted); font-size: 0.92rem; }
.btn-row { display: grid; gap: 0.65rem; margin-top: 0.5rem; }
.pick-toolbar { grid-template-columns: 1fr 1fr; margin: 0 0 0.75rem; }
.btn-danger { background: var(--no-bg); color: var(--no); border-color: #fecdd3; }
.btn-muted { background: #fff; color: var(--ink); border-color: var(--line); }
.flash-ok {
  margin: 0 0 0.85rem;
  padding: 0.75rem 0.85rem;
  border-radius: 0.75rem;
  background: var(--yes-bg);
  color: var(--yes);
  font-weight: 650;
}
#delete-selected:disabled { opacity: 0.45; cursor: not-allowed; }
</style>`;

const COUNT_SCRIPT = `
<script>
(function () {
  var form = document.getElementById('bulk-delete-form');
  var button = document.getElementById('delete-selected');
  var selectAll = document.getElementById('select-all');
  var clearAll = document.getElementById('clear-all');
  if (!form || !button) return;
  function boxes() {
    return form.querySelectorAll('input[name="event"]');
  }
  function selectedCount() {
    return form.querySelectorAll('input[name="event"]:checked').length;
  }
  function refresh() {
    var n = selectedCount();
    button.textContent = '🗑️ Delete Selected (' + n + ')';
    button.disabled = n < 1;
  }
  function setAll(checked) {
    boxes().forEach(function (box) { box.checked = checked; });
    refresh();
  }
  if (selectAll) selectAll.addEventListener('click', function () { setAll(true); });
  if (clearAll) clearAll.addEventListener('click', function () { setAll(false); });
  form.addEventListener('change', refresh);
  form.addEventListener('submit', function (event) {
    var n = selectedCount();
    if (n < 1) {
      event.preventDefault();
      return;
    }
    var action = form.querySelector('input[name="action"]');
    if (action && action.value === 'review') {
      if (!window.confirm('Delete ' + n + ' event' + (n === 1 ? '' : 's') + '?')) {
        event.preventDefault();
        return;
      }
      action.value = 'delete';
    }
  });
  refresh();
})();
</script>`;

export function renderInvalidMyEventsPage(): string {
  return renderConnectLayout(
    'Link expired — CONNECT',
    `<section class="card">
      <p class="eyebrow">🗑️</p>
      <h1 class="event-name">This page isn’t available</h1>
      <p class="note">This link isn’t valid or has expired. Return to WhatsApp and tap My Events for a new link.</p>
    </section>`,
  );
}

export function renderMyEventsSelectPage(
  phone: string,
  events: Event[],
  extras: { error?: string; success?: string } = {},
): string {
  const error = extras.error
    ? `<p class="error">${esc(extras.error)}</p>`
    : '';
  const success = extras.success
    ? `<p class="flash-ok">${esc(extras.success)}</p>`
    : '';
  if (events.length === 0) {
    return renderConnectLayout(
      'My Events — CONNECT',
      `<section class="card">
        <p class="eyebrow">🗑️</p>
        <h1 class="event-name">My Events</h1>
        ${success}
        <p class="note">You don’t have any events to delete.</p>
      </section>`,
    );
  }

  const items = events
    .map((event) => {
      const ref = signOwnedEventRef(phone, event.id);
      return `<li>
        <label>
          <input type="checkbox" name="event" value="${esc(ref)}">
          <span>
            <p class="pick-name">${esc(event.name)}</p>
            <p class="pick-meta">${esc(event.date)} · ${esc(formatEventTimezoneLine(event.timezone).replace('🌎 ', ''))} · ${esc(event.location)}</p>
          </span>
        </label>
      </li>`;
    })
    .join('');

  return renderConnectLayout(
    'My Events — CONNECT',
    `<section class="card">
      <p class="eyebrow">🗑️</p>
      <h1 class="event-name">My Events</h1>
      <p class="note">Select events to delete. RSVP and invitation history is kept.</p>
      ${success}
      ${error}
      <form method="post" action="" id="bulk-delete-form">
        <input type="hidden" name="action" value="review">
        <div class="btn-row pick-toolbar">
          <button class="btn btn-muted" type="button" id="select-all">Select All</button>
          <button class="btn btn-muted" type="button" id="clear-all">Clear All</button>
        </div>
        <ul class="event-pick">${items}</ul>
        <button class="btn btn-danger" type="submit" id="delete-selected" disabled>🗑️ Delete Selected (0)</button>
      </form>
    </section>`,
    `${PAGE_CSS}${COUNT_SCRIPT}`,
  );
}

export function renderMyEventsConfirmPage(
  events: Event[],
  signedRefs: string[],
): string {
  const count = events.length;
  const names = events
    .map(
      (event) =>
        `<li>
          <p class="pick-name">${esc(event.name)}</p>
          <p class="pick-meta">${esc(event.date)} · ${esc(formatEventTimezoneLine(event.timezone).replace('🌎 ', ''))} · ${esc(event.location)}</p>
        </li>`,
    )
    .join('');
  const hidden = signedRefs
    .map((ref) => `<input type="hidden" name="event" value="${esc(ref)}">`)
    .join('');

  return renderConnectLayout(
    'Delete events — CONNECT',
    `<section class="card">
      <p class="eyebrow">🗑️</p>
      <h1 class="event-name">Delete ${count} event${count === 1 ? '' : 's'}?</h1>
      <p class="note">This will remove them from My Events. Existing RSVP/invitation history will be retained.</p>
      <ul class="event-pick">${names}</ul>
      <div class="btn-row">
        <form method="post" action="">
          ${hidden}
          <input type="hidden" name="action" value="delete">
          <button class="btn btn-danger" type="submit">Delete</button>
        </form>
        <form method="post" action="">
          <input type="hidden" name="action" value="cancel">
          <button class="btn btn-muted" type="submit">Cancel</button>
        </form>
      </div>
    </section>`,
    PAGE_CSS,
  );
}

export function renderMyEventsDeletedPage(count: number): string {
  return renderConnectLayout(
    'Events deleted — CONNECT',
    `<section class="card success">
      <p class="success-icon">✅</p>
      <h1>${esc(formatDeletedCount(count))}</h1>
      <p>You can close this page and return to WhatsApp.</p>
    </section>`,
  );
}

export function formatDeletedCount(count: number): string {
  return `✅ ${count} event${count === 1 ? '' : 's'} deleted.`;
}
