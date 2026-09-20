import type { RsvpStatus } from '../db/store.js';
import { formatEventTimezoneLine } from '../dates/eventDate.js';

export interface ParsedRsvp {
  status: RsvpStatus;
  guestCount: number;
}

/** 16-byte hex from crypto.randomBytes(16).toString('hex') */
const RSVP_TOKEN_HEX = /^[a-f0-9]{32}$/i;
/** Legacy whole-message `RSVP <code|token>` from older wa.me links. */
const RSVP_PREFIX = /^RSVP\s+([A-Za-z0-9_-]{8,64})\s*$/i;
/** Current prefilled text: `... Code: <code|token>`. */
const CODE_COLON = /Code:\s*([A-Za-z0-9_-]{8,64})/i;
/** Previous prefilled text: `... RSVP: <code|token>`. */
const RSVP_COLON = /RSVP:\s*([A-Za-z0-9_-]{8,64})/i;

const STATUS_PATTERNS: Array<{ status: RsvpStatus; pattern: RegExp }> = [
  { status: 'yes', pattern: /\b(yes|yep|yeah|y|accept|attending|going|confirmed)\b/i },
  { status: 'no', pattern: /\b(no|nope|n|decline|declined|can't|cannot|wont|won't)\b/i },
  { status: 'maybe', pattern: /\b(maybe|perhaps|unsure|might|tbd|not sure)\b/i },
];

/** Parse RSVP code/token from wa.me prefilled text or legacy `RSVP <code>` messages. */
export function parseRsvpLinkToken(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  const codeColon = trimmed.match(CODE_COLON);
  if (codeColon) {
    return codeColon[1];
  }

  const rsvpColon = trimmed.match(RSVP_COLON);
  if (rsvpColon) {
    return rsvpColon[1];
  }

  const prefixed = trimmed.match(RSVP_PREFIX);
  if (prefixed) {
    return prefixed[1];
  }

  if (RSVP_TOKEN_HEX.test(trimmed)) {
    return trimmed;
  }

  return null;
}

export function parseInteractiveRsvp(
  interactiveId?: string,
  buttonPayload?: string,
  messageText?: string,
): ParsedRsvp | null {
  const token = (interactiveId ?? buttonPayload ?? messageText ?? '').toLowerCase();

  if (token.includes('rsvp_yes') || token === 'yes') {
    return { status: 'yes', guestCount: 1 };
  }
  if (token.includes('rsvp_no') || token === 'no') {
    return { status: 'no', guestCount: 0 };
  }
  if (token.includes('rsvp_maybe') || token === 'maybe') {
    return { status: 'maybe', guestCount: 1 };
  }

  return null;
}

export function parseTextRsvp(text: string): ParsedRsvp | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  if (parseRsvpLinkToken(trimmed)) {
    return null;
  }

  const interactive = parseInteractiveRsvp(undefined, undefined, trimmed);
  if (interactive) {
    return interactive;
  }

  let guestCount = 1;
  const plusMatch = trimmed.match(/\+(\d+)/);
  if (plusMatch) {
    guestCount = parseInt(plusMatch[1], 10) + 1;
  }

  const countMatch = trimmed.match(/\b(\d+)\s*(guests?|people|ppl)\b/i);
  if (countMatch) {
    guestCount = parseInt(countMatch[1], 10);
  }

  for (const { status, pattern } of STATUS_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        status,
        guestCount: status === 'yes' ? Math.max(guestCount, 1) : status === 'maybe' ? Math.max(guestCount, 1) : 0,
      };
    }
  }

  return null;
}

export function parseGuestCounts(
  input: string,
): { adults: number; children: number; pair: boolean } | undefined {
  const trimmed = input.trim();
  if (!trimmed) {
    return undefined;
  }

  const labeledAdults = trimmed.match(/(\d+)\s*adult/i);
  const labeledChildren = trimmed.match(/(\d+)\s*child/i);
  if (labeledAdults) {
    const adults = parseInt(labeledAdults[1], 10);
    const children = labeledChildren ? parseInt(labeledChildren[1], 10) : 0;
    if (Number.isFinite(adults) && adults >= 1 && Number.isFinite(children) && children >= 0) {
      return { adults, children, pair: Boolean(labeledChildren) };
    }
  }

  const pair =
    trimmed.match(/^(\d+)\s*(?:and|&|,|\/)\s*(\d+)$/i) ||
    trimmed.match(/^(\d+)\s+(\d+)$/);
  if (pair) {
    const adults = parseInt(pair[1], 10);
    const children = parseInt(pair[2], 10);
    if (Number.isFinite(adults) && adults >= 1 && Number.isFinite(children) && children >= 0) {
      return { adults, children, pair: true };
    }
  }

  if (/^\d+$/.test(trimmed)) {
    const adults = parseInt(trimmed, 10);
    if (Number.isFinite(adults) && adults >= 1) {
      return { adults, children: 0, pair: false };
    }
  }

  return undefined;
}

export function formatConfirmation(
  eventName: string,
  eventDate: string,
  status: RsvpStatus,
  guestCount: number,
  adultCount?: number,
  childCount?: number,
  timezone?: string | null,
): string {
  let message: string;
  switch (status) {
    case 'yes': {
      const adults = adultCount ?? guestCount;
      const children = childCount ?? 0;
      const total = adults + children;
      if (children > 0) {
        message = `Thanks! You're confirmed for *${eventName}* on ${eventDate}.\nTotal attending: ${total} (${adults} adult${adults === 1 ? '' : 's'}, ${children} child${children === 1 ? '' : 'ren'}).\nSee you there!`;
      } else {
        message = total > 1
          ? `Thanks! You're confirmed for *${eventName}* on ${eventDate} with ${total} guests total. See you there!`
          : `Thanks! You're confirmed for *${eventName}* on ${eventDate}. See you there!`;
      }
      break;
    }
    case 'no':
      return `Got it — we've noted you can't make *${eventName}*. Hope to see you next time!`;
    case 'maybe':
      message = `Thanks! We've marked you as *Maybe* for *${eventName}* on ${eventDate}. Reply anytime to update your RSVP.`;
      break;
    default:
      message = `RSVP updated for *${eventName}*.`;
  }
  if (timezone !== undefined) {
    message += `\n${formatEventTimezoneLine(timezone)}`;
  }
  return message;
}
