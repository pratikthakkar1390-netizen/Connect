export type AdminNav = 'home' | 'events' | 'customers' | 'activity' | 'more';

import type { RsvpStatus } from '../db/store.js';
import type { AdminHealth, HealthState, OverallHealth } from './health.js';

export function esc(value: string | number | null | undefined): string {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatAttendanceDisplay(
  status: RsvpStatus,
  guestCount: number,
  adultCount: number,
  childCount: number,
): string {
  if (status !== 'yes') {
    return '—';
  }
  if (adultCount > 0 || childCount > 0) {
    return `${adultCount + childCount} (${adultCount} adults, ${childCount} children)`;
  }
  return String(guestCount);
}

function navItem(
  href: string,
  label: string,
  icon: string,
  active: AdminNav,
  key: AdminNav,
): string {
  const cls = active === key ? 'nav-item active' : 'nav-item';
  return `<a class="${cls}" href="${esc(href)}">${icon}<span>${esc(label)}</span></a>`;
}

const ICONS = {
  home: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 11.5 12 4l8 7.5V20a1 1 0 0 1-1 1h-5v-6H10v6H5a1 1 0 0 1-1-1z"/></svg>`,
  events: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>`,
  customers: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3"/><path d="M4 19c.5-3 2.8-5 5-5s4.5 2 5 5"/><circle cx="17" cy="9" r="2.4"/><path d="M20.5 19c-.3-2.2-1.8-3.8-3.5-3.8"/></svg>`,
  activity: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h4l2.5-7 3 14 2.5-7H20"/></svg>`,
  more: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>`,
};

export function overallDot(overall: OverallHealth): string {
  if (overall === 'healthy') {
    return 'ok';
  }
  if (overall === 'degraded') {
    return 'warn';
  }
  return 'down';
}

export function healthMark(state: HealthState): string {
  if (state === 'healthy') {
    return '🟢';
  }
  if (state === 'degraded') {
    return '🟠';
  }
  if (state === 'unhealthy') {
    return '🔴';
  }
  return '⚪';
}

export function overallMark(overall: OverallHealth): string {
  if (overall === 'healthy') {
    return '🟢';
  }
  if (overall === 'degraded') {
    return '🟠';
  }
  return '🔴';
}

export function layout(
  active: AdminNav,
  title: string,
  body: string,
  health: AdminHealth,
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="robots" content="noindex, nofollow">
  <title>${esc(title)} — CONNECT Admin</title>
  <link rel="stylesheet" href="/admin/styles.css">
</head>
<body>
  <header class="topbar">
    <div class="brand-block">
      <div class="brand">CONNECT</div>
      <div class="brand-sub">Admin Dashboard</div>
    </div>
    <div class="overall overall-${overallDot(health.overall)}" role="status">
      <span class="overall-mark">${overallMark(health.overall)}</span>
      <span class="overall-text">${esc(health.overallLabel)}</span>
    </div>
  </header>
  <main class="main">
    ${body}
  </main>
  <nav class="tabbar" aria-label="Admin">
    ${navItem('/admin', 'Home', ICONS.home, active, 'home')}
    ${navItem('/admin/events', 'Events', ICONS.events, active, 'events')}
    ${navItem('/admin/customers', 'Customers', ICONS.customers, active, 'customers')}
    ${navItem('/admin/activity', 'Activity', ICONS.activity, active, 'activity')}
    ${navItem('/admin/more', 'More', ICONS.more, active, 'more')}
  </nav>
</body>
</html>`;
}

export function statusBadge(status: string): string {
  const cls = `status status-${esc(status)}`;
  return `<span class="${cls}">${esc(status)}</span>`;
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) {
    return '—';
  }
  const date = new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`);
  if (Number.isNaN(date.getTime())) {
    return String(iso);
  }
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function searchForm(action: string, query: string, placeholder: string): string {
  const q = esc(query);
  return `<form class="search-bar" method="get" action="${esc(action)}">
    <input type="search" name="q" value="${q}" placeholder="${esc(placeholder)}" aria-label="Search">
  </form>`;
}

export function statCards(
  stats: Array<{ label: string; value: number | string; hint?: string }>,
): string {
  const cards = stats
    .map(
      (s) => `<div class="stat-card">
        <div class="card-label">${esc(s.label)}</div>
        <div class="card-value">${esc(s.value)}</div>
        ${s.hint ? `<div class="card-hint">${esc(s.hint)}</div>` : ''}
      </div>`,
    )
    .join('');
  return `<div class="stats">${cards}</div>`;
}

export function emptyState(message: string): string {
  return `<div class="empty">${esc(message)}</div>`;
}
