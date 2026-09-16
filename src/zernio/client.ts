import { Zernio } from '@zernio/node';
import { config } from '../config.js';
import {
  toWhatsAppListRowId,
  truncateListText,
  WHATSAPP_LIST_ROW_TITLE_LIMIT,
} from '../whatsapp/eventList.js';

let client: Zernio | null = null;

export function getZernioClient(): Zernio {
  if (!client) {
    if (!config.zernioApiKey) {
      throw new Error('ZERNIO_API_KEY is not configured');
    }
    client = new Zernio({ apiKey: config.zernioApiKey });
  }
  return client;
}

export interface InboxListSection {
  title?: string;
  rows: Array<{ id: string; title: string; description?: string }>;
}

export interface SendMessageParams {
  conversationId: string;
  accountId: string;
  message: string;
  buttons?: Array<{ title: string; payload: string }>;
  list?: {
    button: string;
    sections: InboxListSection[];
  };
}

const WHATSAPP_MAX_REPLY_BUTTONS = 3;

/** True only when Zernio reports at least one successful send and zero failures. */
export function isBroadcastSendSuccessful(result: {
  sent?: number;
  failed?: number;
}): boolean {
  return (result.sent ?? 0) > 0 && (result.failed ?? 0) === 0;
}

function inboxInteractiveBody(
  message: string,
  buttons?: Array<{ title: string; payload: string }>,
  list?: SendMessageParams['list'],
): Record<string, unknown> {
  if (list) {
    return {
      interactive: {
        type: 'list' as const,
        body: { text: message },
        action: {
          button: list.button,
          sections: list.sections.map((section) => ({
            ...section,
            rows: section.rows.map((row) => ({
              ...row,
              id: toWhatsAppListRowId(row.id),
              title: truncateListText(row.title, WHATSAPP_LIST_ROW_TITLE_LIMIT),
            })),
          })),
        },
      },
    };
  }

  if (!buttons?.length) {
    return {};
  }

  // WhatsApp reply buttons max out at 3; extra choices must be a list.
  if (buttons.length > WHATSAPP_MAX_REPLY_BUTTONS) {
    return {
      interactive: {
        type: 'list' as const,
        body: { text: message },
        action: {
          button: 'Choose',
          sections: [
            {
              rows: buttons.map((button) => ({
                id: toWhatsAppListRowId(button.payload),
                title: truncateListText(
                  button.title,
                  WHATSAPP_LIST_ROW_TITLE_LIMIT,
                ),
              })),
            },
          ],
        },
      },
    };
  }

  return {
    buttons: buttons.map((button) => ({
      type: 'postback' as const,
      title: button.title,
      payload: button.payload,
    })),
  };
}

export type InboxSendFn = (
  params: SendMessageParams,
) => Promise<InboxSendResult | void>;

export type InboxOutboundType = 'text' | 'buttons' | 'list';

export type InboxSendResult = {
  ok: boolean;
  type: InboxOutboundType;
  status?: number;
  code?: string;
  messageId?: string;
};

export function outboundMessageType(
  params: Pick<SendMessageParams, 'buttons' | 'list'>,
): InboxOutboundType {
  if (params.list) {
    return 'list';
  }
  if (params.buttons?.length) {
    return 'buttons';
  }
  return 'text';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function readStatus(value: unknown): number | undefined {
  const record = asRecord(value);
  const status = record?.status;
  return typeof status === 'number' ? status : undefined;
}

function readMessageId(value: unknown): string | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  if (typeof record.messageId === 'string' && record.messageId.trim()) {
    return record.messageId;
  }
  const nested = asRecord(record.data);
  if (typeof nested?.messageId === 'string' && nested.messageId.trim()) {
    return nested.messageId;
  }
  return undefined;
}

/** Inspect the Zernio SDK return (or thrown error) without logging secrets. */
export function inspectInboxSendResult(
  raw: unknown,
  type: InboxOutboundType,
  error?: unknown,
): InboxSendResult {
  if (error) {
    const record = asRecord(error);
    const status =
      (typeof record?.statusCode === 'number' ? record.statusCode : undefined) ??
      (typeof record?.status === 'number' ? record.status : undefined);
    const code =
      typeof record?.code === 'string'
        ? record.code
        : error instanceof Error
          ? error.name
          : 'SEND_ERROR';
    return { ok: false, type, status, code };
  }

  const envelope = asRecord(raw);
  if (!envelope) {
    return { ok: false, type, code: 'EMPTY_RESULT' };
  }

  const status = readStatus(envelope.response) ?? readStatus(envelope);
  const sdkError = envelope.error;
  if (sdkError) {
    const err = asRecord(sdkError);
    return {
      ok: false,
      type,
      status,
      code:
        typeof err?.code === 'string'
          ? err.code
          : typeof err?.error === 'string'
            ? err.error
            : 'SEND_ERROR',
    };
  }

  const payload = asRecord(envelope.data) ?? envelope;
  if (payload.success === false) {
    return { ok: false, type, status, code: 'SEND_REJECTED', messageId: readMessageId(payload) };
  }
  if (status != null && status >= 400) {
    return { ok: false, type, status, code: 'HTTP_ERROR', messageId: readMessageId(payload) };
  }

  return {
    ok: true,
    type,
    status: status ?? 200,
    messageId: readMessageId(payload),
  };
}

function logInboxSendResult(result: InboxSendResult): void {
  console.info(
    '[zernio-send]',
    JSON.stringify({
      type: result.type,
      ok: result.ok,
      status: result.status ?? null,
      code: result.code ?? null,
      messageId: result.messageId ?? null,
    }),
  );
}

export function isInboxSendSuccessful(
  result: InboxSendResult | void | null | undefined,
): boolean {
  if (result == null) {
    return true;
  }
  return result.ok === true;
}

export async function sendInboxMessage(
  params: SendMessageParams,
): Promise<InboxSendResult> {
  const type = outboundMessageType(params);
  try {
    const zernio = getZernioClient();
    const raw = await zernio.messages.sendInboxMessage({
      path: { conversationId: params.conversationId },
      body: {
        accountId: params.accountId,
        message: params.message,
        ...inboxInteractiveBody(params.message, params.buttons, params.list),
      },
    });
    const inspected = inspectInboxSendResult(raw, type);
    logInboxSendResult(inspected);
    if (!inspected.ok) {
      throw new Error('Zernio inbox send rejected');
    }
    return inspected;
  } catch (error) {
    if (error instanceof Error && error.message === 'Zernio inbox send rejected') {
      throw error;
    }
    const inspected = inspectInboxSendResult(undefined, type, error);
    logInboxSendResult(inspected);
    throw error;
  }
}

export interface BroadcastInviteParams {
  eventName: string;
  eventDate: string;
  eventLocation: string;
  phones: string[];
  broadcastName: string;
}

export async function sendEventInviteBroadcast({
  eventName,
  eventDate,
  eventLocation,
  phones,
  broadcastName,
}: BroadcastInviteParams): Promise<{ sent: number; failed: number; broadcastId: string }> {
  const zernio = getZernioClient();

  const { data: broadcastResult } = await zernio.broadcasts.createBroadcast({
    body: {
      profileId: config.zernioProfileId,
      accountId: config.zernioWhatsappAccountId,
      platform: 'whatsapp',
      name: broadcastName,
      template: {
        name: config.rsvpTemplateName,
        language: config.rsvpTemplateLanguage,
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: eventName },
              { type: 'text', text: eventDate },
              { type: 'text', text: eventLocation },
            ],
          },
        ],
      },
    },
  });

  const broadcastId = broadcastResult.broadcast.id;

  await zernio.broadcasts.addBroadcastRecipients({
    path: { broadcastId },
    body: { phones },
  });

  const { data: sendResult } = await zernio.broadcasts.sendBroadcast({
    path: { broadcastId },
  });

  return {
    broadcastId,
    sent: sendResult.sent ?? 0,
    failed: sendResult.failed ?? 0,
  };
}

export interface BroadcastReminderParams {
  eventName: string;
  eventDate: string;
  rsvpDeadline: string;
  rsvpCode: string;
  phones: string[];
  broadcastName: string;
}

export async function sendReminderBroadcast({
  eventName,
  eventDate,
  rsvpDeadline,
  rsvpCode,
  phones,
  broadcastName,
}: BroadcastReminderParams): Promise<{ sent: number; failed: number; broadcastId: string }> {
  if (!config.reminderTemplateName?.trim()) {
    throw new Error('REMINDER_TEMPLATE_NAME is not configured');
  }

  const zernio = getZernioClient();

  const { data: broadcastResult } = await zernio.broadcasts.createBroadcast({
    body: {
      profileId: config.zernioProfileId,
      accountId: config.zernioWhatsappAccountId,
      platform: 'whatsapp',
      name: broadcastName,
      template: {
        name: config.reminderTemplateName,
        language: config.reminderTemplateLanguage,
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: eventName },
              { type: 'text', text: eventDate },
              { type: 'text', text: rsvpDeadline },
              { type: 'text', text: rsvpCode },
            ],
          },
        ],
      },
    },
  });

  const broadcastId = broadcastResult.broadcast.id;

  await zernio.broadcasts.addBroadcastRecipients({
    path: { broadcastId },
    body: { phones },
  });

  const { data: sendResult } = await zernio.broadcasts.sendBroadcast({
    path: { broadcastId },
  });

  return {
    broadcastId,
    sent: sendResult.sent ?? 0,
    failed: sendResult.failed ?? 0,
  };
}

export interface BroadcastEventNoticeParams {
  templateName: string;
  eventName: string;
  eventDate: string;
  eventLocation: string;
  extra: string;
  phones: string[];
  broadcastName: string;
}

/** Optional out-of-window template. Caller must pass an approved template name. */
export async function sendEventNoticeBroadcast({
  templateName,
  eventName,
  eventDate,
  eventLocation,
  extra,
  phones,
  broadcastName,
}: BroadcastEventNoticeParams): Promise<{ sent: number; failed: number; broadcastId: string }> {
  const zernio = getZernioClient();

  const { data: broadcastResult } = await zernio.broadcasts.createBroadcast({
    body: {
      profileId: config.zernioProfileId,
      accountId: config.zernioWhatsappAccountId,
      platform: 'whatsapp',
      name: broadcastName,
      template: {
        name: templateName,
        language: config.eventUpdateTemplateLanguage,
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: eventName },
              { type: 'text', text: eventDate },
              { type: 'text', text: eventLocation },
              { type: 'text', text: extra || ' ' },
            ],
          },
        ],
      },
    },
  });

  const broadcastId = broadcastResult.broadcast.id;

  await zernio.broadcasts.addBroadcastRecipients({
    path: { broadcastId },
    body: { phones },
  });

  const { data: sendResult } = await zernio.broadcasts.sendBroadcast({
    path: { broadcastId },
  });

  return {
    broadcastId,
    sent: sendResult.sent ?? 0,
    failed: sendResult.failed ?? 0,
  };
}

export interface SendConnectContactCardParams {
  conversationId: string;
  accountId: string;
  formattedName: string;
  phone: string;
  message?: string;
}

export async function sendConnectContactCard({
  conversationId,
  accountId,
  formattedName,
  phone,
  message = 'Tap the contact card below, then choose *Add to contacts* to save CONNECT by zipbite.',
}: SendConnectContactCardParams): Promise<void> {
  const zernio = getZernioClient();
  await zernio.messages.sendInboxMessage({
    path: { conversationId },
    body: {
      accountId,
      message,
      contacts: [
        {
          name: {
            formatted_name: formattedName,
            first_name: 'CONNECT',
            last_name: 'by zipbite',
          },
          phones: [{ phone, type: 'CELL' }],
        },
      ],
    },
  });
}

export async function sendInteractiveInvite({
  accountId,
  conversationId,
  eventName,
  eventDate,
  eventLocation,
}: {
  accountId: string;
  conversationId: string;
  eventName: string;
  eventDate: string;
  eventLocation: string;
}): Promise<void> {
  const zernio = getZernioClient();
  await zernio.messages.sendInboxMessage({
    path: { conversationId },
    body: {
      accountId,
      message: `You're invited to ${eventName}!\n\n📅 ${eventDate}\n📍 ${eventLocation}\n\nPlease RSVP for this invitation.`,
      buttons: [
        { type: 'postback', title: 'Yes', payload: 'rsvp_yes' },
        { type: 'postback', title: 'No', payload: 'rsvp_no' },
        { type: 'postback', title: 'Maybe', payload: 'rsvp_maybe' },
      ],
    },
  });
}
