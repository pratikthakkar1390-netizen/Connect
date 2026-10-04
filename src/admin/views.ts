import { getEventInstantMs, resolveEventTimezone } from '../dates/eventDate.js';
import { formatTimezoneLabel } from '../timezones/catalog.js';
import type {
  AdminCustomerRow,
  AdminEventDetail,
  AdminEventRow,
  AdminFailedSendRow,
  AdminFeedRow,
  AdminOverviewStats,
  InvitationWithMembers,
  Rsvp,
} from '../db/store.js';
import type { AdminHealth, HealthState } from './health.js';
import {
  emptyState,
  esc,
  formatAttendanceDisplay,
  formatDateTime,
  healthMark,
  layout,
  searchForm,
  statCards,
  statusBadge,
} from './html.js';
import { formatReminderDays } from '../commands/createEventFlow.js';
import { adminGuestLabel } from './privacy.js';

function eventLifecycle(event: {
  date: string;
  timezone?: string | null;
  cancelledAt?: string | null;
  deletedAt?: string | null;
}): { key: string; label: string } {
  if (event.deletedAt?.trim()) {
    return { key: 'deleted', label: 'Deleted' };
  }
  if (event.cancelledAt?.trim()) {
    return { key: 'cancelled', label: 'Cancelled' };
  }
  const instant = getEventInstantMs(event.date, {
    timezone: resolveEventTimezone(event.timezone),
  });
  if (instant != null && instant < Date.now()) {
    return { key: 'past', label: 'Past' };
  }
  return { key: 'upcoming', label: 'Upcoming' };
}

function rsvpSplit(event: Pick<AdminEventRow, 'yes' | 'no' | 'maybe' | 'pending'>): string {
  return `Yes ${event.yes} · No ${event.no} · Maybe ${event.maybe} · Awaiting ${event.pending}`;
}

function eventCard(event: AdminEventRow): string {
  const life = eventLifecycle({
    date: event.date,
    cancelledAt: event.cancelledAt,
    deletedAt: event.deletedAt,
  });
  return `<a class="list-card" href="/admin/events/${event.id}">
    <div class="list-title">${esc(event.name)}</div>
    <div class="list-meta">${esc(event.organizerPhone)}</div>
    <div class="list-meta">${esc(event.date)} · ${esc(event.location)}</div>
    <div class="chips">
      ${statusBadge(life.key)}
      <span class="chip">${esc(String(event.guestCount))} guests</span>
      <span class="chip">${esc(rsvpSplit(event))}</span>
    </div>
  </a>`;
}

function invitationSummary(invitations: InvitationWithMembers[]): string {
  if (invitations.length === 0) {
    return 'None recorded';
  }
  const parts: string[] = [];
  for (const invitation of invitations) {
    if (invitation.type === 'individual') {
      parts.push('Individual');
    } else if (invitation.type === 'family') {
      const max =
        invitation.max_guests != null ? ` (max ${invitation.max_guests})` : '';
      parts.push(`${invitation.family_name ?? 'Family'}${max}`);
    } else {
      const names = invitation.members.map((member) => member.member_name).join(', ');
      parts.push(
        names
          ? `${invitation.group_name ?? 'Group'}: ${names}`
          : (invitation.group_name ?? 'Group'),
      );
    }
  }
  return parts.join(' · ');
}

function feedLabel(type: string): string {
  switch (type) {
    case 'event_created':
      return 'Event created';
    case 'rsvp_yes':
      return 'RSVP Yes';
    case 'rsvp_no':
      return 'RSVP No';
    case 'rsvp_maybe':
      return 'RSVP Maybe';
    case 'invitation_created':
      return 'Invitation sent';
    case 'reminder_sent':
      return 'Reminder sent';
    case 'event_update_info':
      return 'Event update sent';
    case 'event_update_ack':
      return 'Event update sent';
    case 'event_update_cancel':
      return 'Event update sent';
    case 'event_cancelled':
      return 'Event cancelled';
    case 'update_failed':
      return 'Failed send';
    default:
      return type.replaceAll('_', ' ');
  }
}

function feedLine(row: AdminFeedRow): string {
  const who = row.guestPhone
    ? adminGuestLabel(row.guestName, row.guestPhone)
    : row.organizerPhone ?? '';
  const event = row.eventName ?? 'Event';
  return `${esc(feedLabel(row.type))} · ${esc(event)}${who ? ` · ${esc(who)}` : ''}`;
}

export function renderHome(
  health: AdminHealth,
  stats: AdminOverviewStats,
  feed: AdminFeedRow[],
): string {
  const cards = statCards([
    { label: 'Events', value: stats.totalEvents },
    { label: 'Customers', value: stats.totalCustomers },
    { label: 'Guests', value: stats.totalGuests },
    {
      label: 'RSVPs',
      value: stats.totalResponses,
      hint: `Yes ${stats.rsvpYes} · No ${stats.rsvpNo} · Maybe ${stats.rsvpMaybe} · Awaiting ${stats.rsvpAwaiting}`,
    },
    { label: 'Invitations sent', value: stats.invitationsSent },
    { label: 'Reminders sent', value: stats.remindersSent },
  ]);

  const activity =
    feed.length === 0
      ? emptyState('No recent activity yet.')
      : `<div class="stack">${feed
          .slice(0, 8)
          .map(
            (row) => `<div class="list-card">
            <div class="list-title">${feedLine(row)}</div>
            <div class="list-meta">${esc(formatDateTime(row.at))}</div>
          </div>`,
          )
          .join('')}</div>`;

  const body = `
    <h1 class="page-title">Home</h1>
    <p class="lede">Read-only view of CONNECT activity.</p>
    ${cards}
    <section class="section">
      <h2 class="section-title">RSVP breakdown</h2>
      ${statCards([
        { label: 'Yes', value: stats.rsvpYes, hint: `${stats.yesAdults} adults · ${stats.yesChildren} children` },
        { label: 'No', value: stats.rsvpNo },
        { label: 'Maybe', value: stats.rsvpMaybe },
        { label: 'Awaiting', value: stats.rsvpAwaiting },
      ])}
    </section>
    <section class="section">
      <h2 class="section-title">Message activity</h2>
      ${statCards([
        { label: 'Invitations created', value: stats.invitationsSent, hint: 'Invitation records, not carrier delivery' },
        { label: 'Reminders marked sent', value: stats.remindersSent, hint: 'Per event, not per guest' },
        { label: 'Updates sent', value: stats.eventUpdatesSent },
        { label: 'Updates failed', value: stats.eventUpdatesFailed },
      ])}
    </section>
    <section class="section">
      <h2 class="section-title">Recent activity</h2>
      ${activity}
    </section>`;

  return layout('home', 'Home', body, health);
}

export function renderEvents(
  health: AdminHealth,
  events: AdminEventRow[],
  query: string,
): string {
  const upcoming: AdminEventRow[] = [];
  const past: AdminEventRow[] = [];
  for (const event of events) {
    const life = eventLifecycle({
      date: event.date,
      cancelledAt: event.cancelledAt,
      deletedAt: event.deletedAt,
    });
    if (life.key === 'past' || life.key === 'deleted') {
      past.push(event);
    } else {
      upcoming.push(event);
    }
  }

  const section = (title: string, rows: AdminEventRow[], empty: string) => `
    <section class="section">
      <h2 class="section-title">${esc(title)}</h2>
      ${
        rows.length === 0
          ? emptyState(empty)
          : `<div class="stack">${rows.map(eventCard).join('')}</div>`
      }
    </section>`;

  const body = `
    <h1 class="page-title">Events</h1>
    <p class="lede">${events.length} events</p>
    ${searchForm('/admin/events', query, 'Search by name or organizer…')}
    ${section('Upcoming', upcoming, query ? 'No upcoming matches.' : 'No upcoming events.')}
    ${section('Recent / past', past, query ? 'No past matches.' : 'No past events.')}`;

  return layout('events', 'Events', body, health);
}

export function renderEventDetail(
  health: AdminHealth,
  detail: AdminEventDetail,
): string {
  const event = detail.event;
  const life = eventLifecycle({
    date: event.date,
    timezone: event.timezone,
    cancelledAt: event.cancelled_at,
    deletedAt: event.deleted_at,
  });
  const rsvps = detail.rsvps
    .map((rsvp: Rsvp) => {
      const guest = adminGuestLabel(rsvp.guest_name, rsvp.phone);
      return `<div class="kv">
        <div>
          <div class="kv-label">${esc(guest)}</div>
          <div class="kv-value">${esc(
            formatAttendanceDisplay(
              rsvp.status,
              rsvp.guest_count,
              rsvp.adult_count,
              rsvp.child_count,
            ),
          )}</div>
        </div>
        ${statusBadge(rsvp.status)}
      </div>`;
    })
    .join('');

  const updates =
    detail.updates.length === 0
      ? emptyState('No event updates recorded.')
      : detail.updates
          .map(
            (update) => `<div class="kv">
            <div>
              <div class="kv-label">${esc(update.type)} update</div>
              <div class="kv-value">${esc(formatDateTime(update.created_at))} · sent ${update.sent} · failed ${update.failed}</div>
            </div>
          </div>`,
          )
          .join('');

  const body = `
    <a class="back" href="/admin/events">Events</a>
    <h1 class="page-title">${esc(event.name)}</h1>
    <p class="lede">${statusBadge(life.key)}</p>
    <div class="panel">
      <div class="kv"><span class="kv-label">Organizer</span><span class="mono">${esc(event.organizer_phone)}</span></div>
      <div class="kv"><span class="kv-label">Date / time</span><span>${esc(event.date)}</span></div>
      <div class="kv"><span class="kv-label">Timezone</span><span>${esc(formatTimezoneLabel(resolveEventTimezone(event.timezone)))}</span></div>
      <div class="kv"><span class="kv-label">Location</span><span>${esc(event.location)}</span></div>
      <div class="kv"><span class="kv-label">Guests</span><span>${esc(String(detail.guestCount))}</span></div>
      <div class="kv"><span class="kv-label">Invitations</span><span>${esc(String(detail.invitationCount))}</span></div>
      <div class="kv"><span class="kv-label">RSVP</span><span>Yes ${detail.summary.yes} · No ${detail.summary.no} · Maybe ${detail.summary.maybe} · Awaiting ${detail.summary.pending}</span></div>
      <div class="kv"><span class="kv-label">Adults / children (Yes)</span><span>${esc(String(detail.summary.totalAdults))} / ${esc(String(detail.summary.totalChildren))}</span></div>
      <div class="kv"><span class="kv-label">Event image</span><span>${event.image_filename?.trim() ? 'On file' : 'None'}</span></div>
      <div class="kv"><span class="kv-label">Reminder</span><span>${
        event.reminder_sent_at
          ? `Sent ${formatDateTime(event.reminder_sent_at)}`
          : event.reminder_days
            ? `Configured (${formatReminderDays(event.reminder_days)})`
            : 'Not configured'
      }</span></div>
      <div class="kv"><span class="kv-label">Invitation types</span><span>${esc(invitationSummary(detail.invitations))}</span></div>
    </div>
    <section class="section">
      <h2 class="section-title">Guests / RSVP</h2>
      <div class="panel">${rsvps || emptyState('No RSVPs yet.')}</div>
    </section>
    <section class="section">
      <h2 class="section-title">Event updates</h2>
      <div class="panel">${updates}</div>
    </section>`;

  return layout('events', event.name, body, health);
}

export function renderCustomers(
  health: AdminHealth,
  customers: AdminCustomerRow[],
  query: string,
): string {
  const cards =
    customers.length === 0
      ? emptyState(query ? 'No customers match your search.' : 'No customers yet.')
      : `<div class="stack">${customers
          .map(
            (customer) => `<a class="list-card" href="/admin/customers/${encodeURIComponent(customer.phone)}">
            <div class="list-title mono">${esc(customer.phone)}</div>
            <div class="list-meta">Last activity ${esc(formatDateTime(customer.lastActivityAt))}</div>
            <div class="chips">
              <span class="chip">${esc(String(customer.eventCount))} events</span>
              <span class="chip">${esc(String(customer.invitationCount))} invitations</span>
              <span class="chip">${esc(String(customer.rsvpReceivedCount))} RSVPs</span>
            </div>
          </a>`,
          )
          .join('')}</div>`;

  const body = `
    <h1 class="page-title">Customers</h1>
    <p class="lede">Event organizers (${customers.length})</p>
    ${searchForm('/admin/customers', query, 'Search by WhatsApp number…')}
    ${cards}`;

  return layout('customers', 'Customers', body, health);
}

export function renderCustomerDetail(
  health: AdminHealth,
  customer: AdminCustomerRow,
  events: AdminEventRow[],
): string {
  const body = `
    <a class="back" href="/admin/customers">Customers</a>
    <h1 class="page-title">Organizer</h1>
    <div class="panel">
      <div class="kv"><span class="kv-label">WhatsApp</span><span class="mono">${esc(customer.phone)}</span></div>
      <div class="kv"><span class="kv-label">First event</span><span>${esc(formatDateTime(customer.joinedAt))}</span></div>
      <div class="kv"><span class="kv-label">Last activity</span><span>${esc(formatDateTime(customer.lastActivityAt))}</span></div>
      <div class="kv"><span class="kv-label">Events</span><span>${esc(String(customer.eventCount))}</span></div>
      <div class="kv"><span class="kv-label">Invitations</span><span>${esc(String(customer.invitationCount))}</span></div>
      <div class="kv"><span class="kv-label">RSVPs received</span><span>${esc(String(customer.rsvpReceivedCount))}</span></div>
    </div>
    <section class="section">
      <h2 class="section-title">Events</h2>
      ${
        events.length === 0
          ? emptyState('No events for this organizer.')
          : `<div class="stack">${events.map(eventCard).join('')}</div>`
      }
    </section>`;

  return layout('customers', 'Organizer', body, health);
}

export function renderActivity(health: AdminHealth, feed: AdminFeedRow[]): string {
  const cards =
    feed.length === 0
      ? emptyState('No activity recorded yet.')
      : `<div class="stack">${feed
          .map(
            (row) => `<div class="list-card">
            <div class="list-title">${feedLine(row)}</div>
            <div class="list-meta">${esc(formatDateTime(row.at))}</div>
          </div>`,
          )
          .join('')}</div>`;

  const body = `
    <h1 class="page-title">Activity</h1>
    <p class="lede">Recent CONNECT operations from stored records.</p>
    ${cards}`;

  return layout('activity', 'Activity', body, health);
}

export function renderMore(
  health: AdminHealth,
  failed: AdminFailedSendRow[],
): string {
  const checks = health.checks
    .map(
      (check) => `<div class="health-row">
        <div>${healthMark(check.state)}</div>
        <div class="health-copy">
          <div class="health-label">${esc(check.label)} · ${esc(healthStateLabel(check.state))}</div>
          <div class="health-detail">${esc(check.detail)}</div>
        </div>
      </div>`,
    )
    .join('');

  const errors =
    failed.length === 0
      ? emptyState(
          'No stored send failures. Invitation and reminder broadcast errors are not recorded in the database.',
        )
      : `<div class="stack">${failed
          .map(
            (row) => `<div class="list-card">
            <div class="list-title">Event update failed</div>
            <div class="list-meta">${esc(formatDateTime(row.at))} · ${esc(row.eventName)} · ${esc(
              adminGuestLabel(row.guestName, row.guestPhone),
            )}</div>
            <div class="chips">${statusBadge(row.status)}</div>
          </div>`,
          )
          .join('')}</div>`;

  const body = `
    <h1 class="page-title">More</h1>
    <p class="lede">${overallMarkSafe(health)}</p>
    <section class="section">
      <h2 class="section-title">Business operations</h2>
      <div class="panel">
        <a class="list-card" href="/admin/providers">
          <div class="list-title">Provider onboarding</div>
          <div class="list-meta">Create secure links and review provider applications</div>
        </a>
      </div>
    </section>
    <section class="section">
      <h2 class="section-title">System health</h2>
      <div class="panel">${checks}</div>
    </section>
    <section class="section">
      <h2 class="section-title">Error center</h2>
      ${errors}
    </section>`;

  return layout('more', 'More', body, health);
}

function overallMarkSafe(health: AdminHealth): string {
  if (health.overall === 'healthy') {
    return '🟢 All Systems Operational';
  }
  if (health.overall === 'degraded') {
    return '🟠 Attention Needed';
  }
  return '🔴 Action Required';
}

function healthStateLabel(state: HealthState): string {
  if (state === 'healthy') {
    return 'Healthy';
  }
  if (state === 'degraded') {
    return 'Attention Needed';
  }
  if (state === 'unhealthy') {
    return 'Action Required';
  }
  return 'Not monitored';
}
