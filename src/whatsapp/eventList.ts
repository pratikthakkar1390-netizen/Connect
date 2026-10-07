import type { Event } from '../db/store.js';

export interface EventSelectList {
  button: string;
  sections: Array<{
    title?: string;
    rows: Array<{ id: string; title: string; description?: string }>;
  }>;
}

/** WhatsApp list row `id` is returned as `metadata.interactiveId`. */
export const WHATSAPP_LIST_ROW_ID_LIMIT = 200;
/** Visible list row label. Never put the event id here. */
export const WHATSAPP_LIST_ROW_TITLE_LIMIT = 24;
export const WHATSAPP_LIST_ROW_DESC_LIMIT = 72;
export const WHATSAPP_LIST_MAX_ROWS = 10;

export type EventActionMatch = {
  match: boolean;
  eventId?: number;
  invalidSuffix: boolean;
};

function firstNonEmpty(...values: Array<string | undefined | null>): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

export function truncateListText(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, Math.max(0, limit - 3))}...`;
}

/**
 * Compact unique list row id. WhatsApp/Zernio echo this as interactiveId.
 * Avoid spaces so a truncated or title-swapped reply cannot drop the numeric id.
 */
export function eventListRowId(action: string, eventId: number): string {
  return `${action}:${eventId}`;
}

/** Button payloads keep the legacy `ACTION 123` form. List rows use `ACTION:123`. */
export function eventButtonPayload(action: string, eventId: number): string {
  return `${action} ${eventId}`;
}

/**
 * Compact `ACTION 123` to `ACTION:123` when turning event-id buttons into a list.
 * Do not rewrite standalone payloads like REMINDER_1 — `_1` is not an event id.
 */
export function toWhatsAppListRowId(payload: string): string {
  const trimmed = payload.trim();
  const match = trimmed.match(/^([A-Za-z][A-Za-z0-9_]*) (\d+)$/);
  if (match) {
    return eventListRowId(match[1].toUpperCase(), Number(match[2]));
  }
  return trimmed;
}

export function parseEventActionId(
  input: string,
  action: string,
): number | null {
  const matched = matchEventAction(input, action);
  if (!matched.match || matched.invalidSuffix || matched.eventId == null) {
    return null;
  }
  return matched.eventId;
}

export function hasEventAction(input: string, action: string): boolean {
  return matchEventAction(input, action).match;
}

export function matchEventAction(
  input: string,
  action: string,
): EventActionMatch {
  const trimmed = input.trim();
  if (!trimmed) {
    return { match: false, invalidSuffix: false };
  }
  const upper = trimmed.toUpperCase();
  const prefix = action.trim().toUpperCase();
  if (!prefix) {
    return { match: false, invalidSuffix: false };
  }
  if (upper === prefix) {
    return { match: true, invalidSuffix: false };
  }

  let suffix = '';
  if (upper.startsWith(`${prefix}:`)) {
    suffix = trimmed.slice(prefix.length + 1).trim();
  } else if (upper.startsWith(`${prefix} `) || upper.startsWith(`${prefix}_`)) {
    suffix = trimmed.slice(prefix.length).trim();
  } else {
    return { match: false, invalidSuffix: false };
  }

  if (!suffix) {
    return { match: true, invalidSuffix: false };
  }
  if (!/^\d+$/.test(suffix)) {
    return { match: true, eventId: undefined, invalidSuffix: true };
  }
  const eventId = Number(suffix);
  if (!Number.isInteger(eventId) || eventId < 1) {
    return { match: true, invalidSuffix: true };
  }
  return { match: true, eventId, invalidSuffix: false };
}

export function normalizeInteractiveCommand(input: string): string {
  return input
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

const CUSTOMER_EVENT_COMMANDS = new Set([
  'ZIP_EVENTS',
  'ZIPEVENTS',
  'CREATE_EVENT',
  'CREATEEVENT',
  'MY_EVENTS',
  'MYEVENTS',
  'HELP',
  'HOME',
  'VIEW_OPTIONS',
  'VIEWOPTIONS',
]);

const CUSTOMER_EVENT_PREFIXES = [
  'MANAGE_EVENT',
  'SELECT_EVENT',
  'EVENT_DETAILS',
  'GUEST_LIST',
  'MORE_EVENT',
  'VIEW_RSVPS',
  'SHARE_RSVP',
  'START_INVITE',
  'EDIT_EVENT',
  'SEND_UPDATE',
  'VOID_EVENT',
  'DELETE_EVENT',
  'INVITE',
  'ADD_GROUP_MEMBER',
  'DONE_GROUP',
  'DONE_SENDING',
  'FAMILY_LIMIT',
  'CONFIRM_EVENT',
  'CANCEL_EVENT',
  'ADD_DETAILS',
  'SKIP_DETAILS',
];

/** ZipEvents / create-event / manage-event actions must never be consumed as vendor input. */
export function isCustomerEventCommand(input: string): boolean {
  const key = normalizeInteractiveCommand(input);
  if (!key) {
    return false;
  }
  if (CUSTOMER_EVENT_COMMANDS.has(key)) {
    return true;
  }
  return CUSTOMER_EVENT_PREFIXES.some(
    (prefix) =>
      key === prefix ||
      key.startsWith(`${prefix}_`) ||
      key.startsWith(`${prefix}:`),
  );
}

/**
 * List replies must use the row `id` (interactiveId), never the 24-char title.
 * Button / template replies still prefer buttonPayload.
 */
export function interactiveCommandInput(ctx: {
  interactiveType?: string;
  interactiveId?: string;
  buttonPayload?: string;
  text?: string;
}): string {
  if (ctx.interactiveType === 'list_reply') {
    return firstNonEmpty(ctx.interactiveId, ctx.buttonPayload, ctx.text);
  }
  return firstNonEmpty(ctx.buttonPayload, ctx.interactiveId, ctx.text);
}

export function buildEventSelectList(
  events: Event[],
  action: string,
  options: { button?: string; sectionTitle?: string } = {},
): EventSelectList {
  const rows = events.slice(0, WHATSAPP_LIST_MAX_ROWS).map((event) => {
    const id = eventListRowId(action, event.id);
    if (id.length > WHATSAPP_LIST_ROW_ID_LIMIT) {
      throw new Error(`WhatsApp list row id exceeds ${WHATSAPP_LIST_ROW_ID_LIMIT} chars`);
    }
    return {
      id,
      title: truncateListText(event.name, WHATSAPP_LIST_ROW_TITLE_LIMIT),
      description: truncateListText(
        `${event.date} · ${event.location}`,
        WHATSAPP_LIST_ROW_DESC_LIMIT,
      ),
    };
  });
  return {
    button: options.button ?? 'Choose',
    sections: [
      {
        title: options.sectionTitle ?? 'Your events',
        rows,
      },
    ],
  };
}
