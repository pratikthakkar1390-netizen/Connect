import { Router, type Request, type Response } from 'express';
import express from 'express';
import {
  applyPickedEventTimezone,
} from '../commands/createEventFlow.js';
import {
  featuredTimezoneCities,
  formatTimezoneLabel,
  isValidIanaTimeZone,
  searchTimezoneCities,
} from '../timezones/catalog.js';
import {
  renderEventTimezoneDonePage,
  renderEventTimezonePage,
  renderInvalidEventTimezonePage,
} from './eventTimezonePage.js';
import { verifyEventTimezoneToken } from './eventTimezoneToken.js';

export const eventTimezoneRouter = Router();

eventTimezoneRouter.use(express.urlencoded({ extended: false }));

function formScalar(value: unknown): string {
  const raw = Array.isArray(value) ? value[value.length - 1] : value;
  return typeof raw === 'string' ? raw.trim() : '';
}

function sendInvalid(res: Response): void {
  res.status(404).type('html').send(renderInvalidEventTimezonePage());
}

function handleGet(req: Request, res: Response): void {
  const payload = verifyEventTimezoneToken(String(req.params.token ?? ''));
  if (!payload) {
    sendInvalid(res);
    return;
  }
  const query = formScalar(req.query?.q);
  const results = query
    ? searchTimezoneCities(query)
    : featuredTimezoneCities();
  res.type('html').send(
    renderEventTimezonePage({
      query,
      results,
    }),
  );
}

async function handlePost(req: Request, res: Response): Promise<void> {
  const payload = verifyEventTimezoneToken(String(req.params.token ?? ''));
  if (!payload) {
    sendInvalid(res);
    return;
  }
  const iana = formScalar(req.body?.iana);
  if (!isValidIanaTimeZone(iana)) {
    res.status(400).type('html').send(
      renderEventTimezonePage({
        query: formScalar(req.body?.q),
        results: featuredTimezoneCities(),
        error: 'Please choose a city from the list.',
      }),
    );
    return;
  }
  const applied = await applyPickedEventTimezone(payload.phone, iana);
  if (!applied.ok) {
    res.status(400).type('html').send(
      renderEventTimezonePage({
        results: featuredTimezoneCities(),
        error: applied.error,
      }),
    );
    return;
  }
  res.type('html').send(renderEventTimezoneDonePage(formatTimezoneLabel(iana)));
}

eventTimezoneRouter.get('/tz/:token', handleGet);
eventTimezoneRouter.post('/tz/:token', (req, res) => {
  void handlePost(req, res);
});
