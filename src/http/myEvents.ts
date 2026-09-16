import { Router, type Request, type Response } from 'express';
import express from 'express';
import {
  getEventById,
  getMessageSession,
  isEventDeleted,
  listEventsForOrganizer,
  lookupEventWhenTokenByShortCode,
  softDeleteOwnedEvents,
  type Event,
} from '../db/store.js';
import { normalizePhone } from '../config.js';
import { sendInboxMessage, type InboxSendResult, type SendMessageParams } from '../zernio/client.js';
import {
  formatDeletedCount,
  renderInvalidMyEventsPage,
  renderMyEventsConfirmPage,
  renderMyEventsSelectPage,
} from './myEventsPage.js';
import {
  signOwnedEventRef,
  verifyMyEventsToken,
  verifyOwnedEventRef,
  type MyEventsPayload,
} from './myEventsToken.js';

export const myEventsRouter = Router();

myEventsRouter.use(express.urlencoded({ extended: false }));

type SendFn = (params: SendMessageParams) => Promise<void | InboxSendResult>;
let sendMessage: SendFn = sendInboxMessage;

/** Test-only seam so WhatsApp follow-ups can be asserted. */
export function setMyEventsMessageSender(send?: SendFn): void {
  sendMessage = send ?? sendInboxMessage;
}

function formScalar(value: unknown): string {
  const raw = Array.isArray(value) ? value[value.length - 1] : value;
  return typeof raw === 'string' ? valueToTrimmed(raw) : '';
}

function valueToTrimmed(value: string): string {
  return value.trim();
}

function formList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }
  return typeof value === 'string' && value.trim() ? [value] : [];
}

function sendInvalid(res: Response): void {
  res.status(404).type('html').send(renderInvalidMyEventsPage());
}

function resolvePayload(req: Request): MyEventsPayload | null {
  const code = String(req.params.code ?? '').trim();
  if (code) {
    const token = lookupEventWhenTokenByShortCode(code);
    return token ? verifyMyEventsToken(token) : null;
  }
  return verifyMyEventsToken(String(req.params.token ?? ''));
}

function resolveOwnedEvents(
  phone: string,
  refs: string[],
): { events: Event[]; signedRefs: string[] } {
  const events: Event[] = [];
  const signedRefs: string[] = [];
  const seen = new Set<number>();

  for (const ref of refs) {
    const eventId = verifyOwnedEventRef(ref, phone);
    if (eventId == null || seen.has(eventId)) {
      continue;
    }
    seen.add(eventId);
    const event = getEventById(eventId);
    if (
      !event ||
      event.organizer_phone !== normalizePhone(phone) ||
      isEventDeleted(event)
    ) {
      continue;
    }
    events.push(event);
    signedRefs.push(signOwnedEventRef(phone, event.id));
  }

  return { events, signedRefs };
}

async function notifyDeleted(phone: string, count: number): Promise<void> {
  const session = getMessageSession(phone);
  if (!session) {
    return;
  }
  try {
    await sendMessage({
      conversationId: session.conversation_id,
      accountId: session.account_id,
      message: formatDeletedCount(count),
      buttons: [{ title: '🏠 Main Menu', payload: 'HOME' }],
    });
  } catch (error) {
    console.warn(
      `my events: failed to send WhatsApp follow-up for ${phone}: ${
        error instanceof Error ? error.message : error
      }`,
    );
  }
}

myEventsRouter.get('/my-events/:token', handleMyEventsGet);
myEventsRouter.post('/my-events/:token', handleMyEventsPost);
myEventsRouter.get('/e/:code', handleMyEventsGet);
myEventsRouter.post('/e/:code', handleMyEventsPost);

function handleMyEventsGet(req: Request, res: Response): void {
  const payload = resolvePayload(req);
  if (!payload) {
    sendInvalid(res);
    return;
  }
  const events = listEventsForOrganizer(payload.phone);
  res.type('html').send(renderMyEventsSelectPage(payload.phone, events));
}

function handleMyEventsPost(req: Request, res: Response): void {
  void (async () => {
    const payload = resolvePayload(req);
    if (!payload) {
      sendInvalid(res);
      return;
    }

    const action = formScalar(req.body?.action) || 'review';
    if (action === 'cancel') {
      const events = listEventsForOrganizer(payload.phone);
      res.type('html').send(renderMyEventsSelectPage(payload.phone, events));
      return;
    }

    const { events, signedRefs } = resolveOwnedEvents(
      payload.phone,
      formList(req.body?.event),
    );

    if (action !== 'delete') {
      if (events.length === 0) {
        res.type('html').send(
          renderMyEventsSelectPage(
            payload.phone,
            listEventsForOrganizer(payload.phone),
            { error: 'Select at least one event.' },
          ),
        );
        return;
      }
      res.type('html').send(renderMyEventsConfirmPage(events, signedRefs));
      return;
    }

    if (events.length === 0) {
      res.type('html').send(
        renderMyEventsSelectPage(
          payload.phone,
          listEventsForOrganizer(payload.phone),
          { error: 'Select at least one event.' },
        ),
      );
      return;
    }

    const result = softDeleteOwnedEvents(
      payload.phone,
      events.map((event) => event.id),
    );
    await notifyDeleted(payload.phone, result.deletedIds.length);
    res.type('html').send(
      renderMyEventsSelectPage(
        payload.phone,
        listEventsForOrganizer(payload.phone),
        { success: formatDeletedCount(result.deletedIds.length) },
      ),
    );
  })();
}
