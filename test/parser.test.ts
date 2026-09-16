import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTextRsvp, parseInteractiveRsvp, parseGuestCounts, formatConfirmation, parseRsvpLinkToken } from '../src/rsvp/parser.js';
import {
  getIncomingMessageContext,
  getInteractiveReply,
  getSenderDisplayName,
  verifyWebhookSignature,
} from '../src/webhooks/zernio.js';
import crypto from 'node:crypto';
import {
  createEvent,
  addGuests,
  upsertRsvp,
  setGuestName,
  getRsvpSummary,
  listRsvpsForEvent,
  getEventGuests,
  closeDb,
  getDb,
  findEventByRsvpToken,
  findEventByRsvpCode,
} from '../src/db/store.js';
import {
  formatPhoneForDisplay,
  formatRsvpStatusMessage,
  formatRespondentLine,
} from '../src/commands/organizer.js';
import { buildRsvpWhatsAppLink, normalizePhone, parseGuestWhatsAppNumber } from '../src/config.js';

process.env.DATABASE_PATH = ':memory:';

test('parseTextRsvp handles yes/no/maybe', () => {
  assert.deepEqual(parseTextRsvp('yes'), { status: 'yes', guestCount: 1 });
  assert.deepEqual(parseTextRsvp('NO'), { status: 'no', guestCount: 0 });
  assert.deepEqual(parseTextRsvp('maybe'), { status: 'maybe', guestCount: 1 });
  assert.deepEqual(parseTextRsvp('+2 yes'), { status: 'yes', guestCount: 3 });
  assert.deepEqual(parseTextRsvp('yes 4 guests'), { status: 'yes', guestCount: 4 });
  assert.equal(parseTextRsvp('hello'), null);
  assert.equal(parseTextRsvp('RSVP abcdef0123456789abcdef0123456789'), null);
  assert.equal(parseTextRsvp('RSVP ABC12XY3'), null);
  assert.equal(
    parseTextRsvp("Hi, I'd like to RSVP for this invitation. RSVP: ABC12XY3"),
    null,
  );
  assert.equal(
    parseTextRsvp(
      'Hi! I received an invitation. Please show me how to respond. Code: ABC12XY3',
    ),
    null,
  );
});

test('parseGuestCounts reads pair, labeled, and single-number replies', () => {
  assert.deepEqual(parseGuestCounts('2 and 0'), { adults: 2, children: 0, pair: true });
  assert.deepEqual(parseGuestCounts('2,1'), { adults: 2, children: 1, pair: true });
  assert.deepEqual(parseGuestCounts('2 1'), { adults: 2, children: 1, pair: true });
  assert.deepEqual(parseGuestCounts('2 adults 1 child'), {
    adults: 2,
    children: 1,
    pair: true,
  });
  assert.deepEqual(parseGuestCounts('2 adults'), { adults: 2, children: 0, pair: false });
  assert.deepEqual(parseGuestCounts('3'), { adults: 3, children: 0, pair: false });
  assert.equal(parseGuestCounts('hello'), undefined);
  assert.equal(parseGuestCounts('0'), undefined);
});

test('parseRsvpLinkToken reads RSVP token and bare hex', () => {
  const token = 'abcdef0123456789abcdef0123456789';
  assert.equal(parseRsvpLinkToken(`RSVP ${token}`), token);
  assert.equal(parseRsvpLinkToken(`rsvp ${token}`), token);
  assert.equal(parseRsvpLinkToken(token), token);
  assert.equal(parseRsvpLinkToken('RSVP yes'), null);
  assert.equal(parseRsvpLinkToken('hello'), null);
});

test('parseRsvpLinkToken reads prefixed short RSVP codes', () => {
  assert.equal(parseRsvpLinkToken('RSVP ABC12XY3'), 'ABC12XY3');
  assert.equal(parseRsvpLinkToken('rsvp abc12xy3'), 'abc12xy3');
  assert.equal(parseRsvpLinkToken('ABC12XY3'), null);
});

test('parseRsvpLinkToken reads Code colon and legacy RSVP colon codes', () => {
  const token = 'abcdef0123456789abcdef0123456789';
  const newSentence =
    `Hi! I received an invitation. Please show me how to respond. Code: ${token}`;
  assert.equal(parseRsvpLinkToken(newSentence), token);
  assert.equal(
    parseRsvpLinkToken(
      'Hi! I received an invitation. Please show me how to respond. Code: ABC12XY3',
    ),
    'ABC12XY3',
  );
  assert.equal(parseRsvpLinkToken('Code: ABC12XY3'), 'ABC12XY3');

  const oldSentence = `Hi, I'd like to RSVP for this invitation. RSVP: ${token}`;
  assert.equal(parseRsvpLinkToken(oldSentence), token);
  assert.equal(
    parseRsvpLinkToken("Hi, I'd like to RSVP for this invitation. RSVP: ABC12XY3"),
    'ABC12XY3',
  );
  assert.equal(parseRsvpLinkToken('RSVP: ABC12XY3'), 'ABC12XY3');
});

test('parseInteractiveRsvp handles button payloads', () => {
  assert.deepEqual(parseInteractiveRsvp('rsvp_yes'), { status: 'yes', guestCount: 1 });
  assert.deepEqual(parseInteractiveRsvp('rsvp_no'), { status: 'no', guestCount: 0 });
  assert.deepEqual(parseInteractiveRsvp('rsvp_maybe'), { status: 'maybe', guestCount: 1 });
});

test('formatConfirmation includes event details', () => {
  const msg = formatConfirmation('Wedding', 'June 15', 'yes', 2);
  assert.match(msg, /Wedding/);
  assert.match(msg, /2 guests/);
});

test('verifyWebhookSignature validates HMAC', () => {
  const secret = 'test-secret';
  const body = Buffer.from('{"event":"message.received"}');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');

  const original = process.env.WEBHOOK_SECRET;
  process.env.WEBHOOK_SECRET = secret;

  assert.equal(verifyWebhookSignature(body, sig), true);
  assert.equal(verifyWebhookSignature(body, 'bad'), false);

  process.env.WEBHOOK_SECRET = original;
});

test('getInteractiveReply ignores empty buttonPayload so interactiveId wins', () => {
  const reply = getInteractiveReply({
    id: 'event_btn',
    event: 'message.received',
    metadata: {
      interactiveType: 'button_reply',
      interactiveId: 'ADULTS_ONLY',
      buttonPayload: '',
    },
  });

  assert.deepEqual(reply, {
    interactiveType: 'button_reply',
    interactiveId: 'ADULTS_ONLY',
    buttonPayload: undefined,
  });
});

test('getInteractiveReply reads actual Zernio button_reply metadata, not the title', () => {
  const adultsOnly = getInteractiveReply({
    id: 'wh_adults_only',
    event: 'message.received',
    account: { id: 'account_123' },
    conversation: { id: 'conversation_123' },
    message: {
      conversationId: 'conversation_123',
      text: 'Adults only',
      sender: { phoneNumber: '+15551118888' },
    },
    metadata: {
      interactiveType: 'button_reply',
      interactiveId: 'ADULTS_ONLY',
    },
  });
  const childrenAllowed = getInteractiveReply({
    id: 'wh_children_allowed',
    event: 'message.received',
    account: { id: 'account_123' },
    conversation: { id: 'conversation_123' },
    message: {
      conversationId: 'conversation_123',
      text: 'Adults & Children',
      sender: { phoneNumber: '+15551118888' },
    },
    metadata: {
      interactiveType: 'button_reply',
      interactiveId: 'CHILDREN_ALLOWED',
      buttonPayload: '',
    },
  });

  assert.deepEqual(adultsOnly, {
    interactiveType: 'button_reply',
    interactiveId: 'ADULTS_ONLY',
    buttonPayload: undefined,
  });
  assert.deepEqual(childrenAllowed, {
    interactiveType: 'button_reply',
    interactiveId: 'CHILDREN_ALLOWED',
    buttonPayload: undefined,
  });
});

test('getIncomingMessageContext reads the current Zernio message.received shape', () => {
  const context = getIncomingMessageContext({
    id: 'event_123',
    event: 'message.received',
    account: { id: 'account_123' },
    conversation: { id: 'conversation_123' },
    message: {
      conversationId: 'conversation_123',
      text: 'HELP',
      sender: { phoneNumber: '+15551234567' },
    },
  });

  assert.deepEqual(context, {
    phone: '+15551234567',
    senderName: undefined,
    text: 'HELP',
    conversationId: 'conversation_123',
    accountId: 'account_123',
  });
});

test('getSenderDisplayName reads sender profile fields', () => {
  assert.equal(
    getSenderDisplayName({
      id: '1',
      event: 'message.received',
      message: { sender: { name: 'John Smith' } },
    }),
    'John Smith',
  );
  assert.equal(
    getSenderDisplayName({
      id: '2',
      event: 'message.received',
      message: { sender: { pushName: 'Jane Doe' } },
    }),
    'Jane Doe',
  );
  assert.equal(
    getSenderDisplayName({
      id: '3',
      event: 'message.received',
      message: { sender: { phoneNumber: '+15551234567' } },
    }),
    undefined,
  );
});

test('normalizePhone converts to E.164', () => {
  assert.equal(normalizePhone('5551234567'), '+15551234567');
  assert.equal(normalizePhone('+15551234567'), '+15551234567');
});

test('normalizePhone leaves web guest ids unchanged', () => {
  assert.equal(
    normalizePhone('web:550e8400-e29b-41d4-a716-446655440000'),
    'web:550e8400-e29b-41d4-a716-446655440000',
  );
});

test('parseGuestWhatsAppNumber stores E.164 and rejects junk', () => {
  assert.equal(parseGuestWhatsAppNumber('7325551234'), '+17325551234');
  assert.equal(parseGuestWhatsAppNumber('+17325551234'), '+17325551234');
  assert.equal(parseGuestWhatsAppNumber('web:abc'), null);
  assert.equal(parseGuestWhatsAppNumber('12'), null);
  assert.equal(parseGuestWhatsAppNumber(''), null);
});

test('database stores events and RSVPs', () => {
  getDb();
  const event = createEvent('Wedding', 'June 15', '123 Main St', '+15551111111');
  assert.ok(event.rsvp_token);
  assert.match(event.rsvp_token, /^[a-f0-9]{32}$/);
  assert.equal(findEventByRsvpToken(event.rsvp_token)?.id, event.id);
  assert.ok(event.rsvp_code);
  assert.match(event.rsvp_code, /^[0-9A-HJKMNP-TV-Z]{8}$/);
  assert.equal(findEventByRsvpCode(event.rsvp_code)?.id, event.id);
  addGuests(event.id, ['+15552222222', '+15553333333']);
  upsertRsvp(event.id, '+15552222222', 'yes', 2, 'yes +1');
  upsertRsvp(event.id, '+15553333333', 'no', 0, 'no');

  const summary = getRsvpSummary(event.id);
  assert.equal(summary.yes, 1);
  assert.equal(summary.no, 1);
  assert.equal(summary.totalGuests, 2);
  assert.equal(summary.expectedAttendance, 2);
  assert.equal(summary.pending, 0);

  const rsvps = listRsvpsForEvent(event.id);
  assert.equal(rsvps.length, 2);
  assert.equal(rsvps[0].status, 'yes');
  assert.equal(rsvps[0].phone, '+15552222222');
  assert.equal(rsvps[0].guest_count, 2);
  assert.equal(rsvps[1].status, 'no');

  closeDb();
});

test('formatRsvpStatusMessage includes totals and respondents', () => {
  const event = {
    id: 1,
    name: 'Wedding',
    date: 'June 15 7pm',
    location: '123 Main St',
    organizer_phone: '+15551111111',
    rsvp_token: 'token',
    rsvp_code: 'ABC12XY3',
    invitation_count: null,
    rsvp_deadline: null,
    children_allowed: 1,
    reminder_days: null,
    reminder_sent_at: null,
    created_at: '2026-01-01',
  };
  const message = formatRsvpStatusMessage(
    event,
    {
      yes: 1,
      no: 1,
      maybe: 1,
      pending: 1,
      totalGuests: 2,
      totalAdults: 2,
      totalChildren: 0,
      expectedAttendance: 2,
    },
    [
      { id: 1, event_id: 1, phone: '+15552222222', name: null, conversation_id: null, invited_at: '' },
      { id: 2, event_id: 1, phone: '+15553333333', name: null, conversation_id: null, invited_at: '' },
      { id: 3, event_id: 1, phone: '+15554444444', name: null, conversation_id: null, invited_at: '' },
      { id: 4, event_id: 1, phone: '+15555555555', name: null, conversation_id: null, invited_at: '' },
    ],
    [
      {
        id: 1,
        event_id: 1,
        phone: '+15552222222',
        status: 'yes',
        guest_count: 2,
        adult_count: 0,
        child_count: 0,
        raw_reply: 'yes +1',
        updated_at: '',
      },
      {
        id: 2,
        event_id: 1,
        phone: '+15553333333',
        status: 'no',
        guest_count: 0,
        adult_count: 0,
        child_count: 0,
        raw_reply: 'no',
        updated_at: '',
      },
      {
        id: 3,
        event_id: 1,
        phone: '+15554444444',
        status: 'maybe',
        guest_count: 0,
        adult_count: 0,
        child_count: 0,
        raw_reply: 'maybe',
        updated_at: '',
      },
      {
        id: 4,
        event_id: 1,
        phone: '+15555555555',
        status: 'pending',
        guest_count: 1,
        adult_count: 0,
        child_count: 0,
        raw_reply: null,
        updated_at: '',
      },
    ],
  );

  assert.match(message, /RSVP Status: Wedding/);
  assert.match(message, /June 15 7pm/);
  assert.match(message, /Yes: 1/);
  assert.match(message, /No: 1/);
  assert.match(message, /Maybe: 1/);
  assert.match(message, /Invitations: 4/);
  assert.match(message, /✅ \+1 555 222 2222 — Yes \(2 guests\)/);
  assert.match(message, /❌ \+1 555 333 3333 — No/);
  assert.match(message, /🤔 \+1 555 444 4444 — Maybe/);
  assert.doesNotMatch(message, /555 555 5555/);
});

test('formatRsvpStatusMessage shows guest name when stored', () => {
  const event = {
    id: 1,
    name: 'Wedding',
    date: 'June 15 7pm',
    location: '123 Main St',
    organizer_phone: '+15551111111',
    rsvp_token: 'token',
    rsvp_code: 'ABC12XY3',
    invitation_count: 10,
    rsvp_deadline: null,
    children_allowed: 1,
    reminder_days: null,
    reminder_sent_at: null,
    created_at: '2026-01-01',
  };
  const message = formatRsvpStatusMessage(
    event,
    {
      yes: 1,
      no: 0,
      maybe: 0,
      pending: 0,
      totalGuests: 2,
      totalAdults: 2,
      totalChildren: 0,
      expectedAttendance: 2,
    },
    [{ id: 1, event_id: 1, phone: '+15552222222', name: 'John Smith', conversation_id: null, invited_at: '' }],
    [
      {
        id: 1,
        event_id: 1,
        phone: '+15552222222',
        status: 'yes',
        guest_count: 2,
        adult_count: 0,
        child_count: 0,
        raw_reply: 'yes +1',
        updated_at: '',
        guest_name: 'John Smith',
      },
    ],
  );

  assert.match(message, /✅ John Smith/);
  assert.match(message, /\+1 555 222 2222 — Yes \(2 guests\)/);
});

test('formatRespondentLine formats with and without name', () => {
  const rsvp = {
    id: 1,
    event_id: 1,
    phone: '+15552222222',
    status: 'yes' as const,
    guest_count: 2,
    adult_count: 0,
    child_count: 0,
    raw_reply: 'yes',
    updated_at: '',
  };

  assert.equal(
    formatRespondentLine(rsvp, 'John Smith'),
    '✅ John Smith\n   +1 555 222 2222 — Yes (2 guests)',
  );
  assert.equal(
    formatRespondentLine(rsvp, null),
    '✅ +1 555 222 2222 — Yes (2 guests)',
  );
});

test('listRsvpsForEvent includes guest_name from join', () => {
  getDb();
  const event = createEvent('Party', 'July 4', 'Park', '+15551111111');
  addGuests(event.id, ['+15552222222']);
  setGuestName(event.id, '+15552222222', 'John Smith');
  upsertRsvp(event.id, '+15552222222', 'yes', 1, 'yes');

  const rsvps = listRsvpsForEvent(event.id);
  assert.equal(rsvps.length, 1);
  assert.equal(rsvps[0].guest_name, 'John Smith');

  const guests = getEventGuests(event.id);
  assert.equal(guests[0].name, 'John Smith');

  closeDb();
});

test('formatPhoneForDisplay lightly groups +1 numbers', () => {
  assert.equal(formatPhoneForDisplay('+15551234567'), '+1 555 123 4567');
  assert.equal(formatPhoneForDisplay('+442071838750'), '+442071838750');
  assert.equal(
    formatPhoneForDisplay('web:550e8400-e29b-41d4-a716-446655440000'),
    'Guest',
  );
});

test('buildRsvpWhatsAppLink encodes RSVP short code and uses digits only', () => {
  const code = 'ABC12XY3';
  const text =
    `Hi! I received an invitation. Please show me how to respond. Code: ${code}`;
  const link = buildRsvpWhatsAppLink(code, '+15551234567');
  assert.equal(link, `https://wa.me/15551234567?text=${encodeURIComponent(text)}`);
  assert.equal(
    link,
    'https://wa.me/15551234567?text=Hi!%20I%20received%20an%20invitation.%20Please%20show%20me%20how%20to%20respond.%20Code%3A%20ABC12XY3',
  );
  assert.equal(buildRsvpWhatsAppLink(code, ''), null);
});
