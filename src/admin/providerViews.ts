import type { AdminHealth } from './health.js';
import { esc, layout, statusBadge } from './html.js';
import type { ProviderOnboardingSession } from '../vendors/onboarding.js';
import type { Vendor } from '../vendors/store.js';

function providerCard(vendor: Vendor): string {
  const reviewActions =
    vendor.status === 'UNDER_REVIEW'
      ? `<div class="actions">
          <form method="post" action="/admin/providers/${vendor.id}/status">
            <input type="hidden" name="status" value="APPROVED">
            <button type="submit">Approve</button>
          </form>
          <form method="post" action="/admin/providers/${vendor.id}/status">
            <input type="hidden" name="status" value="REJECTED">
            <button type="submit">Reject</button>
          </form>
        </div>`
      : '';
  return `<article class="list-card">
    <div class="list-title">${esc(vendor.business_name || 'Incomplete provider')}</div>
    <div class="list-meta">${esc(vendor.contact_name || 'Owner not entered')} · ${esc(
      vendor.whatsapp_phone,
    )}</div>
    <div class="list-meta">${esc(vendor.provider_type || vendor.category || 'Type not selected')} · ${esc(
      vendor.address || 'Pickup location not entered',
    )}</div>
    <div class="chips">
      ${statusBadge(vendor.status.toLowerCase())}
      ${
        vendor.menu_source_method
          ? `<span class="chip">${esc(vendor.menu_source_method)}</span>`
          : ''
      }
      ${
        vendor.payment_preference
          ? `<span class="chip">${esc(vendor.payment_preference)}</span>`
          : ''
      }
    </div>
    ${reviewActions}
  </article>`;
}

function inviteRow(session: ProviderOnboardingSession): string {
  const state = session.completed_at
    ? 'Completed'
    : session.expires_at <= Date.now()
      ? 'Expired'
      : session.claimed_at
        ? 'In progress'
        : 'Waiting';
  return `<article class="list-card">
    <div class="list-title">${esc(session.expected_phone)}</div>
    <div class="list-meta">${esc(state)} · Step ${esc(session.step)}</div>
    <div class="list-meta">Expires ${esc(
      new Date(session.expires_at).toLocaleString('en-US'),
    )}</div>
  </article>`;
}

export function renderAdminProviders(input: {
  health: AdminHealth;
  vendors: Vendor[];
  sessions: ProviderOnboardingSession[];
  inviteUrl?: string;
  error?: string;
}): string {
  const message = input.error
    ? `<div class="alert alert-error">${esc(input.error)}</div>`
    : input.inviteUrl
      ? `<section class="panel">
          <h2>Onboarding link created</h2>
          <p>Send this one link to the intended provider:</p>
          <p><a href="${esc(input.inviteUrl)}">${esc(input.inviteUrl)}</a></p>
          <p class="muted">The link is phone-bound and expires in 7 days. It is shown here only once.</p>
        </section>`
      : '';
  const body = `
    <section class="page-head">
      <div>
        <p class="eyebrow">Providers</p>
        <h1>Provider onboarding</h1>
      </div>
    </section>
    ${message}
    <section class="panel">
      <h2>Create onboarding link</h2>
      <form method="post" action="/admin/providers/invites">
        <label>Provider WhatsApp number
          <input name="phone" inputmode="tel" placeholder="+15551234567" required>
        </label>
        <button type="submit">Create secure link</button>
      </form>
    </section>
    <section class="panel">
      <h2>Providers</h2>
      <div class="list">${input.vendors.map(providerCard).join('') || '<p>No providers yet.</p>'}</div>
    </section>
    <section class="panel">
      <h2>Recent onboarding sessions</h2>
      <div class="list">${input.sessions.map(inviteRow).join('') || '<p>No invitations yet.</p>'}</div>
    </section>`;
  return layout('more', 'Providers', body, input.health);
}
