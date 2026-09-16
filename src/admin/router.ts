import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireAdminAuth } from './auth.js';
import { getAdminHealth } from './health.js';
import { adminGuestLabel } from './privacy.js';
import {
  renderActivity,
  renderCustomerDetail,
  renderCustomers,
  renderEventDetail,
  renderEvents,
  renderHome,
  renderMore,
} from './views.js';
import {
  getAdminCustomer,
  getAdminEventDetail,
  getAdminOverviewStats,
  listAdminActivity,
  listAdminCustomers,
  listAdminEvents,
  listAdminFailedSends,
  listAdminFeed,
} from '../db/store.js';

const router = Router();

router.use(requireAdminAuth);

const stylesPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'styles.css',
);
const stylesCss = fs.readFileSync(stylesPath, 'utf8');

function noStore(res: { setHeader: (name: string, value: string) => void }): void {
  res.setHeader('Cache-Control', 'no-store');
}

router.get('/styles.css', (_req, res) => {
  res.type('text/css').send(stylesCss);
});

router.get(['/', ''], (_req, res) => {
  noStore(res);
  const health = getAdminHealth();
  res
    .type('html')
    .send(renderHome(health, getAdminOverviewStats(), listAdminFeed(12)));
});

router.get('/events', (req, res) => {
  noStore(res);
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  res.type('html').send(renderEvents(getAdminHealth(), listAdminEvents(q), q));
});

router.get('/events/:id', (req, res) => {
  noStore(res);
  const id = Number(req.params.id);
  const detail = Number.isInteger(id) ? getAdminEventDetail(id) : undefined;
  if (!detail) {
    res.status(404).type('html').send('Not Found');
    return;
  }
  res.type('html').send(renderEventDetail(getAdminHealth(), detail));
});

router.get('/customers', (req, res) => {
  noStore(res);
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  res
    .type('html')
    .send(renderCustomers(getAdminHealth(), listAdminCustomers(q), q));
});

router.get('/customers/:phone', (req, res) => {
  noStore(res);
  const phone = typeof req.params.phone === 'string' ? req.params.phone : '';
  const customer = getAdminCustomer(phone);
  if (!customer) {
    res.status(404).type('html').send('Not Found');
    return;
  }
  res
    .type('html')
    .send(
      renderCustomerDetail(
        getAdminHealth(),
        customer,
        listAdminEvents('', customer.phone),
      ),
    );
});

router.get('/activity', (_req, res) => {
  noStore(res);
  res.type('html').send(renderActivity(getAdminHealth(), listAdminFeed(80)));
});

router.get('/more', (_req, res) => {
  noStore(res);
  res
    .type('html')
    .send(renderMore(getAdminHealth(), listAdminFailedSends(50)));
});

router.get('/api/overview', (_req, res) => {
  noStore(res);
  res.json({
    stats: getAdminOverviewStats(),
    health: getAdminHealth(),
    recentActivity: listAdminFeed(20).map(sanitizeFeedRow),
  });
});

router.get('/api/customers', (req, res) => {
  noStore(res);
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  res.json({ customers: listAdminCustomers(q) });
});

router.get('/api/customers/:phone', (req, res) => {
  noStore(res);
  const customer = getAdminCustomer(req.params.phone);
  if (!customer) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  res.json({
    customer,
    events: listAdminEvents('', customer.phone),
  });
});

router.get('/api/events', (req, res) => {
  noStore(res);
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  res.json({ events: listAdminEvents(q) });
});

router.get('/api/events/:id', (req, res) => {
  noStore(res);
  const id = Number(req.params.id);
  const detail = Number.isInteger(id) ? getAdminEventDetail(id) : undefined;
  if (!detail) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  const { event } = detail;
  res.json({
    event: {
      id: event.id,
      name: event.name,
      date: event.date,
      location: event.location,
      organizerPhone: event.organizer_phone,
      cancelledAt: event.cancelled_at ?? null,
      deletedAt: event.deleted_at ?? null,
      reminderDays: event.reminder_days,
      reminderSentAt: event.reminder_sent_at,
      hasImage: Boolean(event.image_filename?.trim()),
      rsvpCode: event.rsvp_code,
    },
    summary: detail.summary,
    guestCount: detail.guestCount,
    invitationCount: detail.invitationCount,
    guests: detail.rsvps.map((rsvp) => ({
      guest: adminGuestLabel(rsvp.guest_name, rsvp.phone),
      status: rsvp.status,
      guestCount: rsvp.guest_count,
      adultCount: rsvp.adult_count,
      childCount: rsvp.child_count,
      updatedAt: rsvp.updated_at,
    })),
    updates: detail.updates.map((update) => ({
      type: update.type,
      createdAt: update.created_at,
      sent: update.sent,
      failed: update.failed,
    })),
  });
});

router.get('/api/activity', (_req, res) => {
  noStore(res);
  res.json({
    activity: listAdminFeed(100).map(sanitizeFeedRow),
    rsvps: listAdminActivity(100).map((row) => ({
      ...row,
      guest: adminGuestLabel(row.guestName, row.guestPhone),
      guestPhone: undefined,
    })),
  });
});

router.get('/api/health', (_req, res) => {
  noStore(res);
  res.json(getAdminHealth());
});

function sanitizeFeedRow(row: ReturnType<typeof listAdminFeed>[number]) {
  return {
    at: row.at,
    type: row.type,
    eventId: row.eventId,
    eventName: row.eventName,
    organizerPhone: row.organizerPhone,
    guest: row.guestPhone
      ? adminGuestLabel(row.guestName, row.guestPhone)
      : null,
    detail: row.detail,
  };
}

export default router;
