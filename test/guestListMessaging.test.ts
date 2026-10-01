import './setMemoryDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addGuests,
  cancelEvent,
  closeDb,
  createEvent,
  createInvitation,
  getDb,
  getEventById,
  getEventGuests,
  getRsvp,
  listEventsWithReminderConfigured,
  setGuestName,
  setGuestWhatsAppPhone,
  softDeleteOwnedEvents,
  upsertMessageSession,
  upsertRsvp,
} from '../src/db/store.js';
import { handleCustomerCommand, setCustomerMessageSender } from '../src/commands/welcome.js';
import {
  RESEND_INVITE,
  SEND_REMINDER,
  guestListIntegritySnapshot,
  guestPairRowId,
  setGuestMessagingSenders,
} from '../src/commands/guestMessaging.js';
import { handleGuestRsvp, setRsvpMessageSender } from '../src/rsvp/handler.js';
import type { CommandContext } from '../src/commands/organizer.js';
import type { SendMessageParams } from '../src/zernio/client.js';

process.env.DATABASE_PATH = ':memory:';
process.env.WEBHOOK_SECRET = 'guest-list-messaging-secret';
process.env.ZERNIO_WHATSAPP_ACCOUNT_ID = 'acct-connect';

const OWNER = '+15551119101';
const OTHER = '+15551119102';
const JOHN = '+15552229101';

const sent: SendMessageParams[] = [];
const guestInbox: SendMessageParams[] = [];
const inviteBroadcasts: Array<{ phones: string[]; eventName: string }> = [];
const reminderBroadcasts: Array<{ phones: string[]; rsvpCode: string }> = [];

function ctx(
  phone: string,
  text: string,
  extras: Partial<CommandContext> = {},
): CommandContext {
  return {
    phone,
    text,
    conversationId: `conv-${phone}`,
    accountId: 'acct-connect',
    ...extras,
  };
}

function buttonTap(phone: string, payload: string): CommandContext {
  return ctx(phone, payload, {
    interactiveId: payload,
    interactiveType: 'button_reply',
    buttonPayload: payload,
  });
}

function lastMessage(): SendMessageParams {
  const message = sent.at(-1);
  assert.ok(message, 'expected a CONNECT reply');
  return message;
}

function resetHarness(): void {
  closeDb();
  getDb();
  sent.length = 0;
  guestInbox.length = 0;
  inviteBroadcasts.length = 0;
  reminderBroadcasts.length = 0;
  setCustomerMessageSender(async (params) => {
    sent.push(params);
  });
  setRsvpMessageSender(async (params) => {
    sent.push(params);
  });
  setGuestMessagingSenders({
    inbox: async (params) => {
      guestInbox.push(params);
    },
    inviteBroadcast: async (params) => {
      inviteBroadcasts.push({
        phones: params.phones,
        eventName: params.eventName,
      });
      return { sent: params.phones.length, failed: 0, broadcastId: 'bc-invite' };
    },
    reminderBroadcast: async (params) => {
      reminderBroadcasts.push({
        phones: params.phones,
        rsvpCode: params.rsvpCode,
      });
      return { sent: params.phones.length, failed: 0, broadcastId: 'bc-remind' };
    },
  });
}

function seedJohn(status: 'yes' | 'maybe' = 'yes') {
  const event = createEvent('Wedding', 'Sep 21, 2026 at 6:00 PM', 'Hall', OWNER, {
    childrenAllowed: true,
  });
  const invite = createInvitation({ eventId: event.id, type: 'individual' });
  const john = addGuests(event.id, [JOHN], invite.id)[0];
  setGuestName(event.id, JOHN, 'John Patel');
  if (status === 'yes') {
    upsertRsvp(event.id, JOHN, 'yes', 3, 'yes', 2, 1);
  } else {
    upsertRsvp(event.id, JOHN, 'maybe', 0, 'maybe');
  }
  return { event, john };
}

test('guest list resend invitation and send reminder', async () => {
  resetHarness();
  const { event, john } = seedJohn();
  const before = guestListIntegritySnapshot(event.id);
  assert.equal(getRsvp(event.id, JOHN)?.status, 'yes');

  await handleCustomerCommand(
    buttonTap(OWNER, guestPairRowId(RESEND_INVITE, event.id, john.id)),
  );
  assert.match(lastMessage().message, /✅ Invitation sent to John Patel/);
  assert.match(lastMessage().message, /does not change their current RSVP \(Yes\)/);
  assert.equal(inviteBroadcasts.length, 1);
  assert.deepEqual(inviteBroadcasts[0]?.phones, [JOHN]);
  assert.equal(inviteBroadcasts[0]?.eventName, 'Wedding');
  assert.equal(guestInbox.length, 0);
  assert.deepEqual(guestListIntegritySnapshot(event.id), before);
  assert.equal(getRsvp(event.id, JOHN)?.status, 'yes');
  assert.equal(getRsvp(event.id, JOHN)?.adult_count, 2);
  assert.equal(getEventGuests(event.id).length, before.guestCount);

  await handleCustomerCommand(
    buttonTap(OTHER, guestPairRowId(RESEND_INVITE, event.id, john.id)),
  );
  assert.match(lastMessage().message, /wasn't found or you don't have access/);
  assert.equal(inviteBroadcasts.length, 1);

  resetHarness();
  const whatsappCase = seedJohn();
  const wa = '+15557779001';
  setGuestWhatsAppPhone(whatsappCase.event.id, JOHN, wa, OWNER);
  upsertMessageSession(JOHN, 'conv-wrong-guest-phone', 'acct-vendor');
  upsertMessageSession(wa, 'conv-john-wa', 'acct-connect');
  await handleCustomerCommand(
    buttonTap(
      OWNER,
      guestPairRowId(RESEND_INVITE, whatsappCase.event.id, whatsappCase.john.id),
    ),
  );
  assert.match(lastMessage().message, /✅ Invitation sent to John Patel/);
  assert.equal(inviteBroadcasts.length, 0);
  assert.equal(guestInbox.length, 1);
  assert.equal(guestInbox[0]?.accountId, 'acct-connect');
  assert.equal(guestInbox[0]?.conversationId, 'conv-john-wa');
  assert.match(guestInbox[0]?.message ?? '', /You're Invited!/);
  assert.match(guestInbox[0]?.message ?? '', /\/r\//);

  resetHarness();
  const reminderEvent = createEvent('Gala', 'Nov 1, 2026 at 7:00 PM', 'Hall', OWNER, {
    reminderDays: 2,
    rsvpDeadline: 'October 20, 2026 at 5:00 PM',
  });
  const reminderInvite = createInvitation({
    eventId: reminderEvent.id,
    type: 'individual',
  });
  const reminderGuest = addGuests(reminderEvent.id, [JOHN], reminderInvite.id)[0];
  setGuestName(reminderEvent.id, JOHN, 'John Patel');
  upsertRsvp(reminderEvent.id, JOHN, 'maybe', 0, 'maybe');
  upsertMessageSession(JOHN, 'conv-john-remind', 'acct-connect');
  assert.ok(
    listEventsWithReminderConfigured().some((row) => row.id === reminderEvent.id),
  );
  await handleCustomerCommand(
    buttonTap(
      OWNER,
      guestPairRowId(SEND_REMINDER, reminderEvent.id, reminderGuest.id),
    ),
  );
  assert.match(lastMessage().message, /✅ Reminder sent to John Patel/);
  assert.match(lastMessage().message, /does not change their current RSVP \(Maybe\)/);
  assert.equal(guestInbox.length, 1);
  assert.equal(guestInbox[0]?.accountId, 'acct-connect');
  assert.match(guestInbox[0]?.message ?? '', /RSVP reminder/);
  assert.equal(getRsvp(reminderEvent.id, JOHN)?.status, 'maybe');
  assert.equal(getEventById(reminderEvent.id)?.reminder_sent_at, null);
  assert.ok(
    listEventsWithReminderConfigured().some((row) => row.id === reminderEvent.id),
  );
  assert.equal(reminderBroadcasts.length, 0);

  await handleCustomerCommand(
    buttonTap(
      OTHER,
      guestPairRowId(SEND_REMINDER, reminderEvent.id, reminderGuest.id),
    ),
  );
  assert.match(lastMessage().message, /wasn't found or you don't have access/);
  assert.equal(reminderBroadcasts.length, 0);

  resetHarness();
  const cancelled = seedJohn();
  cancelEvent(cancelled.event.id);
  await handleCustomerCommand(
    buttonTap(
      OWNER,
      guestPairRowId(RESEND_INVITE, cancelled.event.id, cancelled.john.id),
    ),
  );
  assert.match(lastMessage().message, /cancelled/);
  assert.doesNotMatch(lastMessage().message, /Invitation sent/);
  await handleCustomerCommand(
    buttonTap(
      OWNER,
      guestPairRowId(SEND_REMINDER, cancelled.event.id, cancelled.john.id),
    ),
  );
  assert.match(lastMessage().message, /cancelled/);
  assert.equal(inviteBroadcasts.length, 0);
  assert.equal(reminderBroadcasts.length, 0);

  const deleted = createEvent('Brunch', 'Dec 1', 'Cafe', OWNER);
  const deletedInvite = createInvitation({ eventId: deleted.id, type: 'individual' });
  const deletedGuest = addGuests(deleted.id, [JOHN], deletedInvite.id)[0];
  softDeleteOwnedEvents(OWNER, [deleted.id]);
  await handleCustomerCommand(
    buttonTap(OWNER, guestPairRowId(RESEND_INVITE, deleted.id, deletedGuest.id)),
  );
  assert.match(lastMessage().message, /wasn't found or you don't have access/);
  await handleCustomerCommand(
    buttonTap(OWNER, guestPairRowId(SEND_REMINDER, deleted.id, deletedGuest.id)),
  );
  assert.match(lastMessage().message, /wasn't found or you don't have access/);

  resetHarness();
  const failed = seedJohn();
  setGuestMessagingSenders({
    inbox: async () => {
      throw new Error('inbox closed');
    },
    inviteBroadcast: async () => ({ sent: 0, failed: 1, broadcastId: 'bc-fail' }),
    reminderBroadcast: async () => ({ sent: 0, failed: 1, broadcastId: 'bc-fail' }),
  });
  await handleCustomerCommand(
    buttonTap(OWNER, guestPairRowId(RESEND_INVITE, failed.event.id, failed.john.id)),
  );
  assert.match(lastMessage().message, /Could not resend the invitation to John Patel/);
  assert.doesNotMatch(lastMessage().message, /✅ Invitation sent/);

  resetHarness();
  const picnicGuestPhone = '+15552229199';
  const picnic = createEvent('Picnic', 'July 4, 2027 at 1:00 PM', 'Park', OWNER, {
    childrenAllowed: true,
  });
  const picnicInvite = createInvitation({ eventId: picnic.id, type: 'individual' });
  const picnicGuest = addGuests(picnic.id, [picnicGuestPhone], picnicInvite.id)[0];
  await handleCustomerCommand(
    buttonTap(OWNER, guestPairRowId(RESEND_INVITE, picnic.id, picnicGuest.id)),
  );
  assert.match(lastMessage().message, /✅ Invitation sent/);
  const first = await handleGuestRsvp({
    phone: picnicGuestPhone,
    text: 'yes',
    conversationId: 'conv-picnic',
    accountId: 'acct-rsvp',
    rawReply: 'yes',
    senderName: 'John Patel',
  });
  assert.equal(first, 'awaiting_counts');
  const recorded = await handleGuestRsvp({
    phone: picnicGuestPhone,
    text: '2 adults 1 child',
    conversationId: 'conv-picnic',
    accountId: 'acct-rsvp',
    rawReply: '2 adults 1 child',
    senderName: 'John Patel',
  });
  assert.equal(recorded, 'rsvp_recorded');
  assert.equal(getRsvp(picnic.id, picnicGuestPhone)?.status, 'yes');
  assert.equal(getRsvp(picnic.id, picnicGuestPhone)?.adult_count, 2);

  setCustomerMessageSender();
  setRsvpMessageSender();
  setGuestMessagingSenders();
  closeDb();
});
