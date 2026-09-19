import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { config, isConnectWhatsAppAccount, isOrganizer } from '../config.js';
import { handleOrganizerCommand } from '../commands/organizer.js';
import { handleCustomerCommand } from '../commands/welcome.js';
import {
  isWebhookProcessed,
  markWebhookProcessed,
  upsertMessageSession,
} from '../db/store.js';
import { handleGuestRsvp } from '../rsvp/handler.js';

export interface ZernioWebhookPayload {
  id: string;
  event: string;
  /** @deprecated Kept to accept older webhook payloads. */
  conversationId?: string;
  conversation?: {
    id?: string;
  };
  account?: { id: string };
  message?: {
    conversationId?: string;
    text?: string;
    sender?: {
      phoneNumber?: string;
      name?: string;
      pushName?: string;
      profileName?: string;
      displayName?: string;
    };
  };
  metadata?: {
    interactiveType?: 'button_reply' | 'list_reply' | 'nfm_reply' | string;
    interactiveId?: string;
    buttonPayload?: string;
  };
}

export interface IncomingMessageContext {
  phone?: string;
  senderName?: string;
  text: string;
  conversationId?: string;
  accountId?: string;
}

export function getSenderDisplayName(
  payload: ZernioWebhookPayload,
): string | undefined {
  const sender = payload.message?.sender;
  if (!sender) {
    return undefined;
  }

  for (const candidate of [
    sender.name,
    sender.pushName,
    sender.profileName,
    sender.displayName,
  ]) {
    const trimmed = candidate?.trim();
    if (trimmed) {
      return trimmed;
    }
  }

  return undefined;
}

export function getIncomingMessageContext(
  payload: ZernioWebhookPayload,
): IncomingMessageContext {
  return {
    phone: payload.message?.sender?.phoneNumber,
    senderName: getSenderDisplayName(payload),
    text: payload.message?.text ?? '',
    conversationId:
      payload.conversation?.id ??
      payload.message?.conversationId ??
      payload.conversationId,
    accountId: payload.account?.id ?? config.zernioWhatsappAccountId,
  };
}

function nonempty(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

/** Interactive reply IDs only — empty strings must not hide the real button id. */
export function getInteractiveReply(payload: ZernioWebhookPayload): {
  interactiveType?: string;
  interactiveId?: string;
  buttonPayload?: string;
} {
  return {
    interactiveType: nonempty(payload.metadata?.interactiveType),
    interactiveId: nonempty(payload.metadata?.interactiveId),
    buttonPayload: nonempty(payload.metadata?.buttonPayload),
  };
}


export function verifyWebhookSignature(
  rawBody: Buffer,
  signature: string | undefined,
): boolean {
  const webhookSecret = process.env.WEBHOOK_SECRET || config.webhookSecret;

  if (!webhookSecret) {
    return false;
  }
  if (!signature) {
    return false;
  }

  const expected = crypto
    .createHmac('sha256', webhookSecret)
    .update(rawBody)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, 'utf8'),
      Buffer.from(signature, 'utf8'),
    );
  } catch {
    return false;
  }
}

export async function handleZernioWebhook(
  req: Request,
  res: Response,
): Promise<void> {
  const rawBody = req.body as Buffer;
  const signature = req.headers['x-zernio-signature'] as string | undefined;

  if (config.webhookSecret && !verifyWebhookSignature(rawBody, signature)) {
    res.status(401).json({ error: 'Invalid signature' });
    return;
  }

  let payload: ZernioWebhookPayload;
  try {
    payload = JSON.parse(rawBody.toString('utf8')) as ZernioWebhookPayload;
  } catch {
    res.status(400).json({ error: 'Invalid JSON' });
    return;
  }

  if (payload.event !== 'message.received') {
    res.status(200).json({ ok: true, skipped: true });
    return;
  }

  if (isWebhookProcessed(payload.id)) {
    res.status(200).json({ ok: true, deduplicated: true });
    return;
  }

  const { phone, senderName, text, conversationId, accountId } =
    getIncomingMessageContext(payload);

  if (!phone || !conversationId || !accountId) {
    res.status(200).json({ ok: true, skipped: 'missing_fields' });
    return;
  }

  markWebhookProcessed(payload.id);
  upsertMessageSession(phone, conversationId, accountId);

  const interactive = getInteractiveReply(payload);

  try {
    if (!isConnectWhatsAppAccount(accountId)) {
      const { getVendorByZernioWhatsAppAccountId } = await import(
        '../vendors/store.js'
      );
      const vendor = getVendorByZernioWhatsAppAccountId(accountId);
      if (!vendor) {
        res.status(200).json({ ok: true, skipped: 'unknown_whatsapp_account' });
        return;
      }
      const { handleVendorAccountInbound } = await import('../vendors/flow.js');
      await handleVendorAccountInbound(
        {
          phone,
          text,
          conversationId,
          accountId,
          senderName,
          interactiveId: interactive.interactiveId,
          buttonPayload: interactive.buttonPayload,
          interactiveType: interactive.interactiveType,
        },
        vendor,
      );
      res.status(200).json({ ok: true, route: 'vendor_account' });
      return;
    }

    const { handleVendorCommand, shouldHandleVendor } = await import(
      '../vendors/flow.js'
    );
    const vendorInput =
      interactive.interactiveId ||
      interactive.buttonPayload ||
      text;
    if (shouldHandleVendor(phone, text, accountId) || shouldHandleVendor(phone, vendorInput, accountId)) {
      const handled = await handleVendorCommand({
        phone,
        text,
        conversationId,
        accountId,
        senderName,
        interactiveId: interactive.interactiveId,
        buttonPayload: interactive.buttonPayload,
        interactiveType: interactive.interactiveType,
      });
      if (handled) {
        res.status(200).json({ ok: true, route: 'vendor' });
        return;
      }
    }

    if (isOrganizer(phone)) {
      // Same button/menu handlers as customers; allowlist is kept for future operator-only tools.
      const handled = await handleOrganizerCommand({
        phone,
        text,
        conversationId,
        accountId,
        senderName,
        interactiveId: interactive.interactiveId,
        buttonPayload: interactive.buttonPayload,
        interactiveType: interactive.interactiveType,
      });

      if (handled) {
        res.status(200).json({ ok: true, route: 'organizer' });
        return;
      }
    }

    const rsvpResult = await handleGuestRsvp({
      phone,
      senderName,
      text,
      interactiveId: interactive.interactiveId,
      buttonPayload: interactive.buttonPayload,
      interactiveType: interactive.interactiveType,
      conversationId,
      accountId,
      rawReply: text || interactive.interactiveId || interactive.buttonPayload || '',
    });

    if (rsvpResult) {
      res.status(200).json({ ok: true, route: 'guest', result: rsvpResult });
      return;
    }

    if (isOrganizer(phone)) {
      res.status(200).json({ ok: true, route: 'organizer_unrecognized' });
      return;
    }

    const customerHandled = await handleCustomerCommand({
      phone,
      text,
      conversationId,
      accountId,
      senderName,
      interactiveId: interactive.interactiveId,
      buttonPayload: interactive.buttonPayload,
      interactiveType: interactive.interactiveType,
    });

    if (customerHandled) {
      res.status(200).json({ ok: true, route: 'customer' });
      return;
    }

    res.status(200).json({ ok: true, route: 'ignored' });
  } catch (error) {
    console.error('Webhook handler error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}
