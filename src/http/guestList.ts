import { Router, type Request, type Response } from 'express';
import {
  buildGuestListEntries,
  formatGuestListSummary,
  getGuestListEntry,
  loadOwnedEventForGuestList,
  searchGuestListEntries,
} from '../commands/guestList.js';
import { renderGuestDetailPage, renderGuestListPage, renderInvalidGuestListPage } from './guestListPage.js';
import { verifyGuestListToken } from './guestListToken.js';

export const guestListRouter = Router();

function formScalar(value: unknown): string {
  const raw = Array.isArray(value) ? value[value.length - 1] : value;
  return typeof raw === 'string' ? raw.trim() : '';
}

function sendInvalid(res: Response): void {
  res.status(404).type('html').send(renderInvalidGuestListPage());
}

function resolveOwnedEvent(req: Request) {
  const payload = verifyGuestListToken(String(req.params.token ?? ''));
  if (!payload) {
    return null;
  }
  const event = loadOwnedEventForGuestList(payload.eventId, payload.phone);
  if (!event) {
    return null;
  }
  return { payload, event };
}

function handleList(req: Request, res: Response): void {
  const resolved = resolveOwnedEvent(req);
  if (!resolved) {
    sendInvalid(res);
    return;
  }
  const query = formScalar(req.query?.q);
  const entries = searchGuestListEntries(
    buildGuestListEntries(resolved.event.id),
    query,
  );
  const tokenPath = `/guests/${encodeURIComponent(String(req.params.token ?? ''))}`;
  res.type('html').send(
    renderGuestListPage({
      event: resolved.event,
      summary: formatGuestListSummary(resolved.event),
      query,
      entries,
      tokenPath,
    }),
  );
}

function handleDetail(req: Request, res: Response): void {
  const resolved = resolveOwnedEvent(req);
  if (!resolved) {
    sendInvalid(res);
    return;
  }
  const guestId = Number(req.params.guestId);
  if (!Number.isInteger(guestId) || guestId < 1) {
    sendInvalid(res);
    return;
  }
  const entry = getGuestListEntry(resolved.event.id, guestId);
  if (!entry) {
    sendInvalid(res);
    return;
  }
  const tokenPath = `/guests/${encodeURIComponent(String(req.params.token ?? ''))}`;
  res.type('html').send(
    renderGuestDetailPage({
      event: resolved.event,
      entry,
      tokenPath,
    }),
  );
}

guestListRouter.get('/guests/:token', handleList);
guestListRouter.get('/guests/:token/g/:guestId', handleDetail);
