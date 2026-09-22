import { Router, type Request, type Response } from 'express';
import {
  buildGuestListEntries,
  formatGuestListSummary,
  getGuestListEntry,
  loadOwnedEventForGuestList,
  searchGuestListEntries,
} from '../commands/guestList.js';
import { lookupGuestListByShortCode, type Event } from '../db/store.js';
import { renderGuestDetailPage, renderGuestListPage, renderInvalidGuestListPage } from './guestListPage.js';
import { verifyGuestListToken, type GuestListPayload } from './guestListToken.js';

export const guestListRouter = Router();

function formScalar(value: unknown): string {
  const raw = Array.isArray(value) ? value[value.length - 1] : value;
  return typeof raw === 'string' ? raw.trim() : '';
}

function sendInvalid(res: Response): void {
  res.status(404).type('html').send(renderInvalidGuestListPage());
}

function resolveFromToken(token: string): { payload: GuestListPayload; event: Event } | null {
  const payload = verifyGuestListToken(token);
  if (!payload) {
    return null;
  }
  const event = loadOwnedEventForGuestList(payload.eventId, payload.phone);
  if (!event) {
    return null;
  }
  return { payload, event };
}

function resolveFromShortCode(code: string) {
  const mapped = lookupGuestListByShortCode(code);
  if (!mapped) {
    return null;
  }
  const resolved = resolveFromToken(mapped.token);
  if (!resolved || resolved.payload.eventId !== mapped.eventId) {
    return null;
  }
  return resolved;
}

function handleList(
  req: Request,
  res: Response,
  resolved: { payload: GuestListPayload; event: Event } | null,
  tokenPath: string,
): void {
  if (!resolved) {
    sendInvalid(res);
    return;
  }
  const query = formScalar(req.query?.q);
  const entries = searchGuestListEntries(
    buildGuestListEntries(resolved.event.id),
    query,
  );
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

function handleDetail(
  req: Request,
  res: Response,
  resolved: { payload: GuestListPayload; event: Event } | null,
  tokenPath: string,
): void {
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
  res.type('html').send(
    renderGuestDetailPage({
      event: resolved.event,
      entry,
      tokenPath,
    }),
  );
}

guestListRouter.get('/g/:code', (req, res) => {
  const code = String(req.params.code ?? '');
  handleList(
    req,
    res,
    resolveFromShortCode(code),
    `/g/${encodeURIComponent(code)}`,
  );
});

guestListRouter.get('/g/:code/g/:guestId', (req, res) => {
  const code = String(req.params.code ?? '');
  handleDetail(
    req,
    res,
    resolveFromShortCode(code),
    `/g/${encodeURIComponent(code)}`,
  );
});

guestListRouter.get('/guests/:token', (req, res) => {
  const token = String(req.params.token ?? '');
  handleList(
    req,
    res,
    resolveFromToken(token),
    `/guests/${encodeURIComponent(token)}`,
  );
});

guestListRouter.get('/guests/:token/g/:guestId', (req, res) => {
  const token = String(req.params.token ?? '');
  handleDetail(
    req,
    res,
    resolveFromToken(token),
    `/guests/${encodeURIComponent(token)}`,
  );
});
