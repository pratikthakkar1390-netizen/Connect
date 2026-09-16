import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import {
  addGuests,
  closeDb,
  createEvent,
  createEventUpdate,
  createInvitation,
  getAdminOverviewStats,
  getDb,
  insertEventUpdateRecipient,
  listAdminActivity,
  listAdminCustomers,
  listAdminEvents,
  listAdminFeed,
  markReminderSent,
  upsertRsvp,
} from '../src/db/store.js';
import { getAdminHealth } from '../src/admin/health.js';
import { shortRsvpRouter } from '../src/http/shortRsvp.js';

process.env.DATABASE_PATH = ':memory:';

function withAdminServer(
  adminPassword: string,
  fn: (baseUrl: string, origin: string) => Promise<void>,
): Promise<void> {
  const previous = process.env.ADMIN_PASSWORD;
  process.env.ADMIN_PASSWORD = adminPassword;

  return import('../src/admin/router.js').then(async ({ default: adminRouter }) => {
    const app = express();
    app.use(shortRsvpRouter);
    app.use('/admin', adminRouter);
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const origin = `http://127.0.0.1:${port}`;

    try {
      await fn(`${origin}/admin`, origin);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      process.env.ADMIN_PASSWORD = previous;
    }
  });
}

function basicAuth(password: string): string {
  return `Basic ${Buffer.from(`admin:${password}`).toString('base64')}`;
}

test('admin routes return 404 when ADMIN_PASSWORD is unset', async () => {
  await withAdminServer('', async (baseUrl) => {
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.status, 404);
    const css = await fetch(`${baseUrl}/styles.css`);
    assert.equal(css.status, 404);
  });
});

test('admin routes reject missing or wrong credentials', async () => {
  await withAdminServer('secret-pass', async (baseUrl) => {
    const unauth = await fetch(`${baseUrl}/`);
    assert.equal(unauth.status, 401);
    assert.match(unauth.headers.get('www-authenticate') ?? '', /Basic/i);

    const wrong = await fetch(`${baseUrl}/customers`, {
      headers: { Authorization: basicAuth('wrong') },
    });
    assert.equal(wrong.status, 401);

    const api = await fetch(`${baseUrl}/api/overview`);
    assert.equal(api.status, 401);

    const health = await fetch(`${baseUrl}/api/health`);
    assert.equal(health.status, 401);

    const css = await fetch(`${baseUrl}/styles.css`);
    assert.equal(css.status, 401);
  });
});

test('admin dashboard loads for valid Basic Auth', async () => {
  await withAdminServer('secret-pass', async (baseUrl) => {
    const res = await fetch(`${baseUrl}/`, {
      headers: { Authorization: basicAuth('secret-pass') },
    });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /CONNECT/);
    assert.match(html, /Admin Dashboard/);
    assert.match(html, />Home</);
    assert.match(html, />Events</);
    assert.match(html, />Customers</);
    assert.match(html, />Activity</);
    assert.match(html, />More</);
    assert.doesNotMatch(html, /Guest Phone/);

    const css = await fetch(`${baseUrl}/styles.css`, {
      headers: { Authorization: basicAuth('secret-pass') },
    });
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type') ?? '', /css/);
  });
});

test('admin aggregations count customers, events, RSVPs, and messages', () => {
  getDb();
  const eventA = createEvent('Party A', 'June 1', 'Park', '+15551111111');
  const eventB = createEvent('Party B', 'July 1', 'Hall', '+15552222222');
  addGuests(eventA.id, ['+15553333333', '+15554444444']);
  addGuests(eventB.id, ['+15555555555']);
  upsertRsvp(eventA.id, '+15553333333', 'yes', 2, 'yes +1', 2, 0);
  upsertRsvp(eventA.id, '+15554444444', 'no', 0, 'no');
  upsertRsvp(eventB.id, '+15555555555', 'maybe', 1, 'maybe');
  createInvitation({ eventId: eventA.id, type: 'individual' });
  markReminderSent(eventA.id);
  const update = createEventUpdate({
    eventId: eventA.id,
    type: 'info',
    name: eventA.name,
    date: eventA.date,
    location: eventA.location,
    message: 'Doors at 7',
  });
  insertEventUpdateRecipient({
    updateId: update.id,
    phone: '+15553333333',
    sendStatus: 'sent',
  });
  insertEventUpdateRecipient({
    updateId: update.id,
    phone: '+15554444444',
    sendStatus: 'failed',
  });

  const stats = getAdminOverviewStats();
  assert.equal(stats.totalCustomers, 2);
  assert.equal(stats.totalEvents, 2);
  assert.equal(stats.totalResponses, 3);
  assert.equal(stats.totalGuests, 3);
  assert.equal(stats.rsvpYes, 1);
  assert.equal(stats.rsvpNo, 1);
  assert.equal(stats.rsvpMaybe, 1);
  assert.equal(stats.rsvpAwaiting, 0);
  assert.equal(stats.invitationsSent, 1);
  assert.equal(stats.remindersSent, 1);
  assert.equal(stats.eventUpdatesSent, 1);
  assert.equal(stats.eventUpdatesFailed, 1);
  assert.ok(stats.newCustomers7d >= 2);
  assert.ok(stats.newCustomers30d >= 2);

  const customers = listAdminCustomers();
  assert.equal(customers.length, 2);
  const organizerA = customers.find((c) => c.phone === '+15551111111');
  assert.ok(organizerA);
  assert.equal(organizerA.eventCount, 1);
  assert.equal(organizerA.rsvpReceivedCount, 2);
  assert.equal(organizerA.invitationCount, 1);

  const events = listAdminEvents();
  assert.equal(events.length, 2);
  const partyA = events.find((e) => e.name === 'Party A');
  assert.ok(partyA);
  assert.equal(partyA.yes, 1);
  assert.equal(partyA.no, 1);
  assert.equal(partyA.totalResponses, 2);
  assert.equal(partyA.invitedCount, 2);
  assert.equal(partyA.guestCount, 2);
  assert.equal(partyA.invitationCount, 1);

  const activity = listAdminActivity();
  assert.equal(activity.length, 3);
  assert.ok(activity.every((row) => row.status !== 'pending'));

  const feed = listAdminFeed(50);
  assert.ok(feed.some((row) => row.type === 'event_created'));
  assert.ok(feed.some((row) => row.type === 'invitation_created'));
  assert.ok(feed.some((row) => row.type === 'reminder_sent'));
  assert.ok(feed.some((row) => row.type === 'update_failed'));

  const filtered = listAdminCustomers('2222');
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].phone, '+15552222222');
});

test('health checks are honest about what is monitored', () => {
  const previous = {
    key: process.env.ZERNIO_API_KEY,
    profile: process.env.ZERNIO_PROFILE_ID,
    account: process.env.ZERNIO_WHATSAPP_ACCOUNT_ID,
  };
  delete process.env.ZERNIO_API_KEY;
  delete process.env.ZERNIO_PROFILE_ID;
  delete process.env.ZERNIO_WHATSAPP_ACCOUNT_ID;

  const down = getAdminHealth();
  const byId = Object.fromEntries(down.checks.map((check) => [check.id, check]));
  assert.equal(byId.database.state, 'healthy');
  assert.equal(byId.web.state, 'healthy');
  assert.equal(byId.zernio.state, 'unhealthy');
  assert.equal(byId.reminders.state, 'unmonitored');
  assert.equal(byId['web-rsvp'].state, 'healthy');
  assert.equal(byId.images.state, 'healthy');
  assert.equal(byId.volume.state, 'unmonitored');
  assert.equal(byId.railway.state, 'unmonitored');
  assert.equal(down.overall, 'unhealthy');
  assert.equal(down.overallLabel, 'Action Required');

  process.env.ZERNIO_API_KEY = 'test-key';
  process.env.ZERNIO_PROFILE_ID = 'test-profile';
  process.env.ZERNIO_WHATSAPP_ACCOUNT_ID = 'test-account';
  const up = getAdminHealth();
  assert.equal(up.checks.find((check) => check.id === 'zernio')?.state, 'healthy');
  assert.equal(up.overall, 'healthy');
  assert.equal(up.overallLabel, 'All Systems Operational');
  assert.match(up.checks.find((check) => check.id === 'zernio')?.detail ?? '', /not pinged/i);

  process.env.ZERNIO_API_KEY = previous.key;
  process.env.ZERNIO_PROFILE_ID = previous.profile;
  process.env.ZERNIO_WHATSAPP_ACCOUNT_ID = previous.account;
});

test('authenticated admin pages expose overview, events, customers, and activity', async () => {
  getDb();
  const event = createEvent(
    'Garden Party',
    'December 1, 2099 at 7:00 PM',
    'Rooftop',
    '+15557777777',
  );
  const webId = 'web:550e8400-e29b-41d4-a716-446655440000';
  addGuests(event.id, ['+15558888888', webId]);
  upsertRsvp(event.id, '+15558888888', 'yes', 1, 'yes', 1, 0);
  upsertRsvp(event.id, webId, 'maybe', 1, 'maybe');

  await withAdminServer('secret-pass', async (baseUrl) => {
    const auth = { Authorization: basicAuth('secret-pass') };
    const home = await fetch(`${baseUrl}/`, { headers: auth });
    const homeHtml = await home.text();
    assert.equal(home.status, 200);
    assert.match(homeHtml, /Garden Party/);
    assert.doesNotMatch(homeHtml, /web:550e8400/);
    assert.doesNotMatch(homeHtml, /\/app\/data/);

    const overview = await fetch(`${baseUrl}/api/overview`, { headers: auth });
    assert.equal(overview.status, 200);
    const overviewJson = (await overview.json()) as {
      stats: { totalEvents: number; rsvpYes: number; rsvpMaybe: number };
    };
    assert.ok(overviewJson.stats.totalEvents >= 1);
    assert.ok(overviewJson.stats.rsvpYes >= 1);

    const eventsPage = await fetch(`${baseUrl}/events`, { headers: auth });
    const eventsHtml = await eventsPage.text();
    assert.equal(eventsPage.status, 200);
    assert.match(eventsHtml, /Garden Party/);
    assert.match(eventsHtml, /\+15557777777/);

    const eventJsonRes = await fetch(`${baseUrl}/api/events/${event.id}`, {
      headers: auth,
    });
    assert.equal(eventJsonRes.status, 200);
    const eventJson = (await eventJsonRes.json()) as {
      event: { rsvpToken?: string; hasImage: boolean };
      guests: Array<{ guest: string }>;
    };
    assert.equal(eventJson.event.rsvpToken, undefined);
    assert.equal(eventJson.event.hasImage, false);
    assert.ok(eventJson.guests.some((row) => row.guest === 'Guest'));
    assert.ok(!JSON.stringify(eventJson).includes(webId));

    const detail = await fetch(`${baseUrl}/events/${event.id}`, { headers: auth });
    const detailHtml = await detail.text();
    assert.equal(detail.status, 200);
    assert.match(detailHtml, /Garden Party/);
    assert.match(detailHtml, /Organizer/);
    assert.doesNotMatch(detailHtml, /web:550e8400/);
    assert.doesNotMatch(detailHtml, /Guest Phone/);

    const customers = await fetch(`${baseUrl}/customers`, { headers: auth });
    assert.equal(customers.status, 200);
    assert.match(await customers.text(), /\+15557777777/);

    const customerDetail = await fetch(
      `${baseUrl}/customers/${encodeURIComponent('+15557777777')}`,
      { headers: auth },
    );
    assert.equal(customerDetail.status, 200);
    assert.match(await customerDetail.text(), /Garden Party/);

    const activity = await fetch(`${baseUrl}/activity`, { headers: auth });
    assert.equal(activity.status, 200);
    assert.match(await activity.text(), /Activity/);

    const more = await fetch(`${baseUrl}/more`, { headers: auth });
    const moreHtml = await more.text();
    assert.equal(more.status, 200);
    assert.match(moreHtml, /System health/);
    assert.match(moreHtml, /Database/);
    assert.match(moreHtml, /Not monitored/);

    const missing = await fetch(`${baseUrl}/events/999999`, { headers: auth });
    assert.equal(missing.status, 404);
  });
});

test('public RSVP routes remain available without admin auth', async () => {
  getDb();
  const event = createEvent('Public RSVP Stay', 'May 1', 'Yard', '+15559999999');
  await withAdminServer('secret-pass', async (baseUrl, origin) => {
    const publicRes = await fetch(`${origin}/r/${event.short_code}`, {
      redirect: 'manual',
    });
    assert.notEqual(publicRes.status, 401);
    assert.notEqual(publicRes.status, 404);
    const html = await publicRes.text();
    assert.doesNotMatch(html, /Admin Dashboard/);

    const adminRes = await fetch(`${baseUrl}/api/events`);
    assert.equal(adminRes.status, 401);
  });
});

test('close admin test database', () => {
  closeDb();
});
