import express from 'express';
import { config, assertConfigForRuntime } from './config.js';
import { getDb, sweepAbandonedEventImages } from './db/store.js';
import { handleZernioWebhook } from './webhooks/zernio.js';
import { shortRsvpRouter } from './http/shortRsvp.js';
import { ackUpdateRouter } from './http/ackUpdate.js';
import { eventWhenRouter } from './http/eventWhen.js';
import { eventTimezoneRouter } from './http/eventTimezone.js';
import { vendorPickupRouter } from './http/vendorPickup.js';
import { eventImageRouter } from './http/eventImage.js';
import { myEventsRouter } from './http/myEvents.js';
import { guestListRouter } from './http/guestList.js';
import adminRouter from './admin/router.js';
import { isAdminEnabled } from './admin/auth.js';
import { startReminderScheduler } from './reminders/scheduler.js';

try {
  assertConfigForRuntime();
} catch (error) {
  console.warn(
    `Warning: ${error instanceof Error ? error.message : error}. Server will start but messaging requires full config.`,
  );
}

getDb();
sweepAbandonedEventImages();

const app = express();

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'whatsapp-rsvp' });
});

app.use(shortRsvpRouter);
app.use(ackUpdateRouter);
app.use(eventImageRouter);
app.use(eventWhenRouter);
app.use(eventTimezoneRouter);
app.use(vendorPickupRouter);
app.use(myEventsRouter);
app.use(guestListRouter);

app.post(
  '/webhooks/zernio',
  express.raw({ type: 'application/json' }),
  (req, res) => {
    void handleZernioWebhook(req, res);
  },
);

app.use('/admin', adminRouter);

app.listen(config.port, () => {
  console.log(`WhatsApp RSVP server listening on port ${config.port}`);
  console.log(`Webhook endpoint: POST /webhooks/zernio`);
  console.log(`Health check: GET /health`);
  console.log(`Short RSVP: GET|POST /r/:code`);
  console.log(`Ack update: GET|POST /a/:token`);
  console.log(`Event image: GET /i/:token and GET|POST /p/:code`);
  console.log(`Event when picker: GET|POST /d/:code and /when/:token`);
  console.log(`Event timezone picker: GET|POST /tz/:token`);
  console.log(`Vendor pickup picker: GET|POST /pickup/:token`);
  console.log(`My Events delete: GET|POST /e/:code and /my-events/:token`);
  console.log(`Guest list: GET /guests/:token and GET /guests/:token/g/:guestId`);
  if (isAdminEnabled()) {
    console.log(`Admin dashboard: GET /admin (Basic Auth)`);
  }
  startReminderScheduler();
});
