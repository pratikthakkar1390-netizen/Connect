import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addGuests,
  closeDb,
  createEvent,
  createFamilyInvitation,
  createInvitation,
  getConversationState,
  getDb,
  getGuest,
  getRsvp,
  listRsvpsForEvent,
  markGuestThankYouSent,
} from '../src/db/store.js';
import { GUEST_RSVP_THANK_YOU } from '../src/commands/saveContact.js';
import { handleGuestRsvp, setRsvpMessageSender } from '../src/rsvp/handler.js';
import { formatConfirmation } from '../src/rsvp/parser.js';
import type { SendMessageParams } from '../src/zernio/client.js';

process.env.DATABASE_PATH = ':memory:';

const GUEST = '+15552228001';
const OWNER = '+15551118001';

const sent: SendMessageParams[] = [];

function ctx(text: string) {
  return {
    phone: GUEST,
    text,
    conversationId: 'conv-guest',
    accountId: 'acct-rsvp',
    rawReply: text,
    senderName: 'Maya',
  };
}

test.beforeEach(() => {
  getDb();
  sent.length = 0;
  setRsvpMessageSender(async (params) => {
    sent.push(params);
  });
});

test.afterEach(() => {
  setRsvpMessageSender();
  closeDb();
});

test('Yes with children allowed asks for both counts in one message', async () => {
  const event = createEvent('Picnic', 'July 4', 'Park', OWNER, {
    childrenAllowed: true,
  });
  const invite = createInvitation({ eventId: event.id, type: 'individual' });
  addGuests(event.id, [GUEST], invite.id);

  const first = await handleGuestRsvp(ctx('yes'));
  assert.equal(first, 'awaiting_counts');
  assert.equal(getConversationState(GUEST)?.state, 'WAITING_FOR_RSVP_COUNTS');
  assert.match(sent.at(-1)?.message ?? '', /How many adults\? How many children/);
  assert.match(sent.at(-1)?.message ?? '', /2 and 0/);

  sent.length = 0;
  const recorded = await handleGuestRsvp(ctx('2 adults 1 child'));
  assert.equal(recorded, 'rsvp_recorded');
  assert.equal(sent.length, 1);
  assert.match(sent[0]?.message ?? '', /You're confirmed/);
  assert.match(sent[0]?.message ?? '', /Thank you! Your RSVP has been recorded/);
  assert.equal(getConversationState(GUEST), undefined);
  const rsvp = getRsvp(event.id, GUEST);
  assert.equal(rsvp?.status, 'yes');
  assert.equal(rsvp?.adult_count, 2);
  assert.equal(rsvp?.child_count, 1);
});

test('Yes with children parses 2,1 and two numbers', async () => {
  const event = createEvent('BBQ', 'July 5', 'Yard', OWNER, {
    childrenAllowed: true,
  });
  addGuests(event.id, [GUEST]);

  await handleGuestRsvp(ctx('yes'));
  assert.equal(await handleGuestRsvp(ctx('2,1')), 'rsvp_recorded');
  assert.equal(getRsvp(event.id, GUEST)?.adult_count, 2);
  assert.equal(getRsvp(event.id, GUEST)?.child_count, 1);

  await handleGuestRsvp(ctx('yes'));
  assert.equal(await handleGuestRsvp(ctx('2 and 0')), 'rsvp_recorded');
  assert.equal(getRsvp(event.id, GUEST)?.adult_count, 2);
  assert.equal(getRsvp(event.id, GUEST)?.child_count, 0);
});

test('a single number while children are allowed re-prompts instead of assuming 0 children', async () => {
  const event = createEvent('Gala', 'Aug 1', 'Hall', OWNER, {
    childrenAllowed: true,
  });
  addGuests(event.id, [GUEST]);

  await handleGuestRsvp(ctx('yes'));
  const again = await handleGuestRsvp(ctx('2'));
  assert.equal(again, 'awaiting_counts');
  assert.equal(getConversationState(GUEST)?.state, 'WAITING_FOR_RSVP_COUNTS');
  assert.equal(getRsvp(event.id, GUEST)?.status, 'pending');
  assert.equal(
    listRsvpsForEvent(event.id).filter((row) => row.status === 'yes').length,
    0,
  );
});

test('adults-only Yes still asks for one adult count', async () => {
  const event = createEvent('Dinner', 'Sept 1', 'Cafe', OWNER, {
    childrenAllowed: false,
  });
  addGuests(event.id, [GUEST]);

  const first = await handleGuestRsvp(ctx('yes'));
  assert.equal(first, 'awaiting_adults');
  assert.match(sent.at(-1)?.message ?? '', /How many adults will attend/);
  assert.equal(await handleGuestRsvp(ctx('2')), 'rsvp_recorded');
  const rsvp = getRsvp(event.id, GUEST);
  assert.equal(rsvp?.adult_count, 2);
  assert.equal(rsvp?.child_count, 0);
});

test('Family guest limit still rejects combined counts over the max', async () => {
  const event = createEvent('Wedding', 'Oct 1', 'Hall', OWNER, {
    childrenAllowed: true,
  });
  const family = createFamilyInvitation(event.id, 'Patel Family', 3);
  addGuests(event.id, [GUEST], family.id);

  await handleGuestRsvp(ctx('yes'));
  const over = await handleGuestRsvp(ctx('3,1'));
  assert.equal(over, 'family_limit');
  assert.match(sent.at(-1)?.message ?? '', /up to 3 guests/);
  assert.equal(getRsvp(event.id, GUEST)?.status, 'pending');
  assert.equal(
    listRsvpsForEvent(event.id).filter((row) => row.status === 'yes').length,
    0,
  );

  const ok = await handleGuestRsvp(ctx('2 and 1'));
  assert.equal(ok, 'rsvp_recorded');
  assert.equal(getRsvp(event.id, GUEST)?.guest_count, 3);
});

test('first RSVP sends confirmation and thank-you in one outbound message', async () => {
  const event = createEvent('Picnic', 'July 4', 'Park', OWNER);
  addGuests(event.id, [GUEST]);

  const result = await handleGuestRsvp(ctx('no'));
  assert.equal(result, 'rsvp_recorded');
  assert.equal(sent.length, 1);
  assert.equal(
    sent[0]?.message,
    `${formatConfirmation(event.name, event.date, 'no', 0)}\n\n${GUEST_RSVP_THANK_YOU}`,
  );
  const rsvp = getRsvp(event.id, GUEST);
  assert.equal(rsvp?.status, 'no');
  assert.equal(rsvp?.guest_count, 0);
  assert.ok(getGuest(event.id, GUEST)?.thank_you_sent_at);
  assert.equal(markGuestThankYouSent(event.id, GUEST), false);
});

test('later RSVP sends confirmation only after thank-you was claimed', async () => {
  const event = createEvent('Picnic', 'July 4', 'Park', OWNER);
  addGuests(event.id, [GUEST]);

  await handleGuestRsvp(ctx('no'));
  sent.length = 0;

  const result = await handleGuestRsvp(ctx('maybe'));
  assert.equal(result, 'rsvp_recorded');
  assert.equal(sent.length, 1);
  assert.equal(
    sent[0]?.message,
    formatConfirmation(event.name, event.date, 'maybe', 0),
  );
  assert.equal(sent[0]?.message.includes(GUEST_RSVP_THANK_YOU), false);
  assert.equal(getRsvp(event.id, GUEST)?.status, 'maybe');
  assert.equal(markGuestThankYouSent(event.id, GUEST), false);
});

test('RSVP send failure does not mark the guest thank-you as sent', async () => {
  const event = createEvent('Picnic', 'July 4', 'Park', OWNER);
  addGuests(event.id, [GUEST]);
  setRsvpMessageSender(async () => {
    throw new Error('send failed');
  });

  await assert.rejects(() => handleGuestRsvp(ctx('no')), /send failed/);
  assert.equal(getRsvp(event.id, GUEST)?.status, 'no');
  assert.equal(getGuest(event.id, GUEST)?.thank_you_sent_at ?? null, null);
  assert.equal(markGuestThankYouSent(event.id, GUEST), true);
});
