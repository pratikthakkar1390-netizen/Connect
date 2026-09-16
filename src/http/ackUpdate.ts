import { Router } from 'express';
import express from 'express';
import { buildShortRsvpUrl } from '../config.js';
import {
  acknowledgeUpdateRecipientByToken,
  lookupAckUpdateTarget,
  type AckUpdateTarget,
  type Event,
  type Invitation,
} from '../db/store.js';
import { notifyIfEveryoneAcknowledged } from '../commands/eventUpdateFlow.js';
import {
  renderAckThankYouPage,
  renderAckUpdatePage,
  renderInvalidAckPage,
} from './rsvpPage.js';

export const ackUpdateRouter = Router();

ackUpdateRouter.use(express.urlencoded({ extended: false }));

function rsvpUrlForTarget(event: Event, invitation: Invitation | null): string | null {
  if (invitation?.type === 'family' && invitation.short_code?.trim()) {
    return buildShortRsvpUrl(invitation.short_code);
  }
  return event.short_code ? buildShortRsvpUrl(event.short_code) : null;
}

function sendInvalid(res: express.Response): void {
  res.status(404).type('html').send(renderInvalidAckPage());
}

function resolveTarget(token: string): AckUpdateTarget | undefined {
  const trimmed = token.trim();
  return trimmed ? lookupAckUpdateTarget(trimmed) : undefined;
}

ackUpdateRouter.get('/a/:token', (req, res) => {
  const token = String(req.params.token ?? '');
  const target = resolveTarget(token);
  if (!target) {
    sendInvalid(res);
    return;
  }

  const rsvpUrl = rsvpUrlForTarget(target.event, target.invitation);
  if (target.recipient.acknowledged_at) {
    res.type('html').send(renderAckThankYouPage(target.event, { rsvpUrl }));
    return;
  }

  res.type('html').send(
    renderAckUpdatePage(target.event, {
      rsvpUrl,
      message: target.update.message,
    }),
  );
});

ackUpdateRouter.post('/a/:token', (req, res) => {
  void (async () => {
    const token = String(req.params.token ?? '');
    const target = resolveTarget(token);
    if (!target) {
      sendInvalid(res);
      return;
    }

    const result = acknowledgeUpdateRecipientByToken(token);
    if (!result.ok || !result.event) {
      sendInvalid(res);
      return;
    }

    if (!result.already && result.update) {
      await notifyIfEveryoneAcknowledged(result.update.id);
    }

    const rsvpUrl = rsvpUrlForTarget(result.event, target.invitation);
    res.type('html').send(renderAckThankYouPage(result.event, { rsvpUrl }));
  })();
});
