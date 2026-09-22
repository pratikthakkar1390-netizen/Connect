import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import {
  addGuests,
  closeDb,
  createEvent,
  createFamilyInvitation,
  createInvitation,
  getDb,
  getRsvp,
  getRsvpSummary,
  setGuestName,
  setGuestWhatsAppPhone,
  softDeleteOwnedEvents,
  upsertRsvp,
} from '../src/db/store.js';
import {
  GUEST_LIST,
  buildGuestListEntries,
  formatGuestDetailsMessage,
  formatGuestListSummary,
  guestDetailRowId,
  searchGuestListEntries,
} from '../src/commands/guestList.js';
import {
  handleCustomerCommand,
  manageEventMoreList,
  setCustomerMessageSender,
} from '../src/commands/welcome.js';
import { handleGuestRsvp, setRsvpMessageSender } from '../src/rsvp/handler.js';
import { guestListRouter } from '../src/http/guestList.js';
import { signGuestListToken } from '../src/http/guestListToken.js';
import type { CommandContext } from '../src/commands/organizer.js';
import type { SendMessageParams } from '../src/zernio/client.js';

process.env.DATABASE_PATH = ':memory:';
process.env.WEBHOOK_SECRET = 'guest-list-test-secret';

const OWNER = '+15551119001';
const OTHER = '+15551119002';
const JOHN = '+15552229001';
const PRIYA = '+15552229002';
const RAJ = '+15552229003';

const sent: SendMessageParams[] = [];

function ctx(
  phone: string,
  text: string,
  extras: Partial<CommandContext> = {},
): CommandContext {
  return {
    phone,
    text,
    conversationId: `conv-${phone}`,
    accountId: 'acct-guest-list',
    ...extras,
  };
}

function listTap(phone: string, rowId: string): CommandContext {
  return ctx(phone, rowId, {
    interactiveId: rowId,
    interactiveType: 'list_reply',
  });
}

function lastMessage(): SendMessageParams {
  const message = sent.at(-1);
  assert.ok(message, 'expected a CONNECT reply');
  return message;
}

function withGuestListServer(fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(guestListRouter);
  const server = http.createServer(app);
  return new Promise((resolve, reject) => {
    server.listen(0, async () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      const baseUrl = `http://127.0.0.1:${port}`;
      try {
        await fn(baseUrl);
        server.close((err) => (err ? reject(err) : resolve()));
      } catch (error) {
        server.close(() => reject(error));
      }
    });
  });
}

function seedWedding() {
  const event = createEvent('Wedding', 'Sep 21, 2026 at 6:00 PM', 'Hall', OWNER, {
    childrenAllowed: true,
  });
  const individual = createInvitation({ eventId: event.id, type: 'individual' });
  const family = createFamilyInvitation(event.id, 'Shah Family', 4);
  const john = addGuests(event.id, [JOHN], individual.id)[0];
  const priya = addGuests(event.id, [PRIYA], family.id)[0];
  const raj = addGuests(event.id, [RAJ], individual.id)[0];
  setGuestName(event.id, JOHN, 'John Patel');
  setGuestName(event.id, PRIYA, 'Priya Shah');
  setGuestName(event.id, RAJ, 'Raj Kumar');
  upsertRsvp(event.id, JOHN, 'yes', 3, 'yes', 2, 1);
  upsertRsvp(event.id, RAJ, 'maybe', 0, 'maybe');
  return { event, john, priya, raj, family };
}

test.beforeEach(() => {
  closeDb();
  getDb();
  sent.length = 0;
  setCustomerMessageSender(async (params) => {
    sent.push(params);
  });
  setRsvpMessageSender(async (params) => {
    sent.push(params);
  });
});

test.afterEach(() => {
  setCustomerMessageSender();
  setRsvpMessageSender();
  closeDb();
});

test('Guest List loads for an authorized organizer', async () => {
  const { event, john } = seedWedding();
  assert.equal(
    manageEventMoreList(event).sections[0].rows[0]?.id,
    `${GUEST_LIST}:${event.id}`,
  );

  await handleCustomerCommand(listTap(OWNER, `${GUEST_LIST}:${event.id}`));
  const reply = lastMessage();
  assert.match(reply.message, /🎉 Wedding/);
  assert.match(reply.message, /✅ Yes: 1/);
  assert.match(reply.message, /❓ Maybe: 1/);
  assert.match(reply.message, /❌ No: 0/);
  assert.match(reply.message, /⏳ Awaiting: 1/);
  assert.match(reply.message, /👨 Adults: 2/);
  assert.match(reply.message, /👧 Children: 1/);
  assert.match(reply.message, /\/guests\//);
  assert.equal(reply.list?.button, 'Guests');
  assert.ok(
    reply.list?.sections[0].rows.some((row) => row.id === guestDetailRowId(event.id, john.id)),
  );
});

test('unauthorized user cannot access another organizer guest list', async () => {
  const { event } = seedWedding();
  await handleCustomerCommand(listTap(OTHER, `${GUEST_LIST}:${event.id}`));
  assert.match(lastMessage().message, /wasn't found or you don't have access/);

  await withGuestListServer(async (baseUrl) => {
    const otherToken = signGuestListToken(OTHER, event.id);
    const res = await fetch(`${baseUrl}/guests/${encodeURIComponent(otherToken)}`);
    assert.equal(res.status, 404);
    assert.match(await res.text(), /Guest list unavailable/);
  });
});

test('Guest List summary uses existing Yes/No/Maybe/Awaiting and adult/child totals', () => {
  const { event } = seedWedding();
  const summary = formatGuestListSummary(event);
  const rsvpSummary = getRsvpSummary(event.id);
  assert.match(summary, /✅ Yes: 1/);
  assert.match(summary, /❓ Maybe: 1/);
  assert.match(summary, /❌ No: 0/);
  assert.match(summary, /⏳ Awaiting: 1/);
  assert.match(summary, new RegExp(`👥 Total Expected: ${rsvpSummary.expectedAttendance}`));
  assert.match(summary, /👨 Adults: 2/);
  assert.match(summary, /👧 Children: 1/);
  assert.equal(rsvpSummary.yes, 1);
  assert.equal(rsvpSummary.maybe, 1);
  assert.equal(rsvpSummary.no, 0);
  assert.equal(rsvpSummary.totalAdults, 2);
  assert.equal(rsvpSummary.totalChildren, 1);
});

test('search finds guests by name case-insensitively and by WhatsApp number', () => {
  const { event } = seedWedding();
  setGuestWhatsAppPhone(event.id, PRIYA, '+15553339002', OWNER);
  const entries = buildGuestListEntries(event.id);

  const byName = searchGuestListEntries(entries, 'priya');
  assert.equal(byName.length, 1);
  assert.equal(byName[0]?.name, 'Priya Shah');

  const byPhone = searchGuestListEntries(entries, '5553339002');
  assert.equal(byPhone.length, 1);
  assert.equal(byPhone[0]?.name, 'Priya Shah');

  const byGuestPhone = searchGuestListEntries(entries, JOHN);
  assert.equal(byGuestPhone.length, 1);
  assert.equal(byGuestPhone[0]?.name, 'John Patel');
});

test('guest details show RSVP information including family invitation type', async () => {
  const { event, john, priya, family } = seedWedding();
  const johnEntry = buildGuestListEntries(event.id).find((row) => row.guestId === john.id);
  assert.ok(johnEntry);
  const details = formatGuestDetailsMessage(johnEntry);
  assert.match(details, /👤 John Patel/);
  assert.match(details, /Status: Yes/);
  assert.match(details, /Adults: 2/);
  assert.match(details, /Children: 1/);
  assert.match(details, /Total: 3/);
  assert.match(details, /Invitation: Individual/);
  assert.doesNotMatch(details, /raw_reply/);

  await handleCustomerCommand(
    listTap(OWNER, guestDetailRowId(event.id, priya.id)),
  );
  assert.match(lastMessage().message, /👤 Priya Shah/);
  assert.match(lastMessage().message, /Status: Awaiting/);
  assert.match(lastMessage().message, /Invitation: Family — Shah Family \(max 4\)/);
  assert.equal(family.max_guests, 4);

  await withGuestListServer(async (baseUrl) => {
    const token = signGuestListToken(OWNER, event.id);
    const listRes = await fetch(`${baseUrl}/guests/${encodeURIComponent(token)}`);
    assert.equal(listRes.status, 200);
    const listHtml = await listRes.text();
    assert.match(listHtml, /John Patel/);
    assert.match(listHtml, /Priya Shah/);

    const searchRes = await fetch(
      `${baseUrl}/guests/${encodeURIComponent(token)}?q=${encodeURIComponent('kumar')}`,
    );
    const searchHtml = await searchRes.text();
    assert.match(searchHtml, /Raj Kumar/);
    assert.doesNotMatch(searchHtml, /John Patel/);

    const detailRes = await fetch(
      `${baseUrl}/guests/${encodeURIComponent(token)}/g/${john.id}`,
    );
    assert.equal(detailRes.status, 200);
    const detailHtml = await detailRes.text();
    assert.match(detailHtml, /John Patel/);
    assert.match(detailHtml, /Status: Yes/);
    assert.match(detailHtml, /Adults: 2/);
    assert.match(detailHtml, /Children: 1/);
  });
});

test('existing RSVP recording is unchanged after Guest List reads', async () => {
  const event = createEvent('Picnic', 'July 4', 'Park', OWNER, {
    childrenAllowed: true,
  });
  const invite = createInvitation({ eventId: event.id, type: 'individual' });
  addGuests(event.id, [JOHN], invite.id);

  const first = await handleGuestRsvp({
    phone: JOHN,
    text: 'yes',
    conversationId: 'conv-john',
    accountId: 'acct-rsvp',
    rawReply: 'yes',
    senderName: 'John Patel',
  });
  assert.equal(first, 'awaiting_counts');

  const recorded = await handleGuestRsvp({
    phone: JOHN,
    text: '2 adults 1 child',
    conversationId: 'conv-john',
    accountId: 'acct-rsvp',
    rawReply: '2 adults 1 child',
    senderName: 'John Patel',
  });
  assert.equal(recorded, 'rsvp_recorded');
  const rsvp = getRsvp(event.id, JOHN);
  assert.equal(rsvp?.status, 'yes');
  assert.equal(rsvp?.adult_count, 2);
  assert.equal(rsvp?.child_count, 1);

  const entries = buildGuestListEntries(event.id);
  assert.equal(entries[0]?.status, 'yes');
  assert.equal(entries[0]?.adultCount, 2);
  assert.equal(getRsvp(event.id, JOHN)?.adult_count, 2);
});

test('soft-deleted events stay hidden from Guest List', async () => {
  const { event } = seedWedding();
  softDeleteOwnedEvents(OWNER, [event.id]);
  await handleCustomerCommand(listTap(OWNER, `${GUEST_LIST}:${event.id}`));
  assert.match(lastMessage().message, /wasn't found or you don't have access/);

  await withGuestListServer(async (baseUrl) => {
    const token = signGuestListToken(OWNER, event.id);
    const res = await fetch(`${baseUrl}/guests/${encodeURIComponent(token)}`);
    assert.equal(res.status, 404);
  });
});
