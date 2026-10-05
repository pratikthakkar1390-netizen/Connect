import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import Database from 'better-sqlite3';
import {
  addGuests,
  acknowledgeUpdateRecipient,
  cancelEvent,
  clearConversationState,
  closeDb,
  createEvent,
  deleteEvent,
  createFamilyInvitation,
  createInvitation,
  ensureEventUpdateTables,
  findInvitationRecipient,
  getConversationState,
  getDb,
  getEventById,
  getGuest,
  getRsvp,
  getEventUpdateAckCounts,
  getEventUpdateById,
  isEventCancelled,
  isEventDeleted,
  listEventsForOrganizer,
  listEventsWithReminderConfigured,
  listEventUpdateRecipients,
  listEventUpdateTargets,
  listEventUpdatesForEvent,
  listInvitationsForEvent,
  listRsvpsForEvent,
  listUnacknowledgedSentRecipients,
  lookupAckUpdateTarget,
  setConversationState,
  setGuestName,
  updateEventDetails,
  upsertMessageSession,
  upsertRsvp,
} from '../src/db/store.js';
import {
  ACK_UPDATE,
  CHANGE_LOCATION,
  CHANGE_NAME,
  CHANGE_WHEN,
  CONFIRM_DELETE_EVENT,
  CONFIRM_VOID_EVENT,
  DELETE_EVENT,
  EDIT_EVENT,
  KEEP_EVENT,
  SKIP_VALUE,
  REMIND_UPDATE,
  SEND_UPDATE,
  UPDATE_ACK,
  UPDATE_INFO,
  VIEW_EVENT_RSVP,
  VIEW_UPDATE_STATUS,
  VOID_EVENT,
  continueEventUpdateFlow,
  handleEventUpdateCommand,
  handleGuestUpdateCommand,
  isEventUpdateFlowState,
  setEventUpdateGuestSender,
  setEventUpdateMessageSender,
  setEventUpdateTransports,
} from '../src/commands/eventUpdateFlow.js';
import { ackUpdateRouter } from '../src/http/ackUpdate.js';
import {
  buildShortRsvpUrl,
  eventUpdateAckTemplateName,
  isWebGuestPhone,
} from '../src/config.js';
import { isBroadcastSendSuccessful } from '../src/zernio/client.js';
import {
  DONE_SENDING,
  INVITE_MORE,
  START_INVITE,
  handleInviteCommand,
  setInviteMessageSender,
} from '../src/commands/inviteFlow.js';
import {
  handleCustomerCommand,
  manageEventButtons,
  MORE_EVENT,
  setCustomerMessageSender,
} from '../src/commands/welcome.js';
import { handleOrganizerCommand } from '../src/commands/organizer.js';
import type { CommandContext } from '../src/commands/organizer.js';
import type { SendMessageParams } from '../src/zernio/client.js';
import { formatInfoUpdateMessage } from '../src/commands/eventUpdateMessage.js';
import { shortRsvpRouter } from '../src/http/shortRsvp.js';

process.env.DATABASE_PATH = ':memory:';

const OWNER = '+15551110000';
const GUEST_A = '+15552220001';
const GUEST_B = '+15552220002';
const GUEST_C = '+15552220003';
const GUEST_FAIL = '+15552220999';
const WEB_PHONE = 'web:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const EVENT_DATE = 'Thursday, October 1, 2026 at 5:00 PM';

const sent: SendMessageParams[] = [];
const guestNotices: Array<{
  phone: string;
  message: string;
  buttons?: Array<{ title: string; payload: string }>;
  extra?: string;
  templateName?: string;
}> = [];
const failingPhones = new Set<string>();

function ctx(phone: string, text: string, extras: Partial<CommandContext> = {}): CommandContext {
  return {
    phone,
    text,
    conversationId: `conv-${phone}`,
    accountId: 'acct-update',
    senderName: 'Organizer',
    ...extras,
  };
}

function tap(phone: string, payload: string): CommandContext {
  return ctx(phone, payload, {
    buttonPayload: payload,
    interactiveType: 'button_reply',
  });
}

function lastMessage(): SendMessageParams {
  const message = sent.at(-1);
  assert.ok(message, 'expected a reply');
  return message;
}

function seedEvent(name = 'Katha') {
  const event = createEvent(name, EVENT_DATE, 'Community Center', OWNER);
  const individual = createInvitation({ eventId: event.id, type: 'individual' });
  addGuests(event.id, [GUEST_A], individual.id);
  setGuestName(event.id, GUEST_A, 'John Patel');
  addGuests(event.id, [GUEST_B]);
  setGuestName(event.id, GUEST_B, 'Maria Patel');
  const family = createFamilyInvitation(event.id, 'Patel Family', 4);
  addGuests(event.id, [GUEST_C], family.id);
  setGuestName(event.id, GUEST_C, 'David Patel');
  addGuests(event.id, [WEB_PHONE], individual.id);
  setGuestName(event.id, WEB_PHONE, WEB_PHONE);
  for (const phone of [OWNER, GUEST_A, GUEST_B, GUEST_C]) {
    upsertMessageSession(phone, `conv-${phone}`, 'acct-update');
  }
  return { event, individual, family };
}

async function editAllFields(eventId: number): Promise<void> {
  await handleEventUpdateCommand(tap(OWNER, `${EDIT_EVENT} ${eventId}`), `${EDIT_EVENT} ${eventId}`);
  await handleEventUpdateCommand(tap(OWNER, `${CHANGE_NAME} ${eventId}`), `${CHANGE_NAME} ${eventId}`);
  await continueEventUpdateFlow(ctx(OWNER, 'Katha Night'), 'Katha Night');
  await handleEventUpdateCommand(tap(OWNER, `${EDIT_EVENT} ${eventId}`), `${EDIT_EVENT} ${eventId}`);
  await handleEventUpdateCommand(tap(OWNER, `${CHANGE_WHEN} ${eventId}`), `${CHANGE_WHEN} ${eventId}`);
  await continueEventUpdateFlow(ctx(OWNER, 'October 2, 2026 at 6:30 PM'), 'October 2, 2026 at 6:30 PM');
  await handleEventUpdateCommand(tap(OWNER, `${EDIT_EVENT} ${eventId}`), `${EDIT_EVENT} ${eventId}`);
  await handleEventUpdateCommand(
    tap(OWNER, `${CHANGE_LOCATION} ${eventId}`),
    `${CHANGE_LOCATION} ${eventId}`,
  );
  await continueEventUpdateFlow(ctx(OWNER, 'Town Hall'), 'Town Hall');
}

function withShortRsvpServer(fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(shortRsvpRouter);
  app.use(ackUpdateRouter);
  const server = http.createServer(app);
  return new Promise((resolve, reject) => {
    server.listen(0, async () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      try {
        await fn(`http://127.0.0.1:${port}`);
        server.close((err) => (err ? reject(err) : resolve()));
      } catch (error) {
        server.close(() => reject(error));
      }
    });
  });
}

async function postWebRsvp(
  baseUrl: string,
  code: string | null | undefined,
  body: Record<string, string>,
): Promise<void> {
  const url = `${baseUrl}/r/${code}`;
  const page = await fetch(url, { redirect: 'manual' });
  const setCookie =
    typeof page.headers.getSetCookie === 'function'
      ? page.headers.getSetCookie()
      : [page.headers.get('set-cookie') ?? ''];
  const cookie = setCookie
    .filter(Boolean)
    .map((part) => part.split(';', 1)[0])
    .join('; ');
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...(cookie ? { cookie } : {}),
    },
    body: new URLSearchParams(body).toString(),
    redirect: 'manual',
  });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Your RSVP has been recorded/);
}

test.beforeEach(() => {
  getDb();
  sent.length = 0;
  guestNotices.length = 0;
  failingPhones.clear();
  setCustomerMessageSender(async (params) => {
    sent.push(params);
  });
  setInviteMessageSender(async (params) => {
    sent.push(params);
  });
  setEventUpdateMessageSender(async (params) => {
    sent.push(params);
  });
  setEventUpdateGuestSender(async (params) => {
    if (failingPhones.has(params.phone)) {
      throw new Error(`inbox failed for ${params.phone}`);
    }
    guestNotices.push({
      phone: params.phone,
      message: params.message,
      buttons: params.buttons,
      extra: params.extra,
      templateName: params.templateName,
    });
  });
});

test.afterEach(() => {
  setCustomerMessageSender();
  setInviteMessageSender();
  setEventUpdateMessageSender();
  setEventUpdateGuestSender();
  setEventUpdateTransports();
  delete process.env.EVENT_UPDATE_ACK_TEMPLATE_NAME;
  closeDb();
});

test('Manage Event keeps existing actions and adds edit, update, and cancel', () => {
  const { event } = seedEvent();
  const titles = manageEventButtons(event).map((button) => button.title);
  assert.deepEqual(titles, [
    '📩 Invite',
    '👥 RSVPs',
    'More…',
  ]);
});

test('edit event name, date, time, and location persist latest values without notifying', async () => {
  const { event } = seedEvent();
  const code = event.rsvp_code;
  const short = event.short_code;

  await editAllFields(event.id);

  const latest = getEventById(event.id);
  assert.ok(latest);
  assert.equal(latest.name, 'Katha Night');
  assert.match(latest.date, /October 2, 2026/i);
  assert.match(latest.date, /6:30\s*PM/i);
  assert.equal(latest.location, 'Town Hall');
  assert.equal(latest.rsvp_code, code);
  assert.equal(latest.short_code, short);
  assert.equal(guestNotices.length, 0);
  assert.match(lastMessage().message, /Event updated/);
  assert.match(lastMessage().message, /Katha Night/);
  assert.match(lastMessage().message, /Town Hall/);
  assert.deepEqual(
    lastMessage().buttons?.map((button) => button.title),
    ['📢 Send Update', 'Done'],
  );
  assert.equal(getConversationState(OWNER), undefined);
});

test('edit event Done leaves fields unchanged', async () => {
  const { event } = seedEvent();
  await handleEventUpdateCommand(tap(OWNER, `${EDIT_EVENT} ${event.id}`), `${EDIT_EVENT} ${event.id}`);
  assert.match(lastMessage().message, /What would you like to change/);
  await handleEventUpdateCommand(tap(OWNER, `EDIT_DONE ${event.id}`), `EDIT_DONE ${event.id}`);

  const latest = getEventById(event.id);
  assert.ok(latest);
  assert.equal(latest.name, event.name);
  assert.equal(latest.date, event.date);
  assert.equal(latest.location, event.location);
  assert.equal(guestNotices.length, 0);
  assert.match(lastMessage().message, /Katha/);
});

test('edit date and time typed fallback stay on the field when invalid', async () => {
  const { event } = seedEvent();
  await handleEventUpdateCommand(tap(OWNER, `${EDIT_EVENT} ${event.id}`), `${EDIT_EVENT} ${event.id}`);
  await handleEventUpdateCommand(tap(OWNER, `${CHANGE_WHEN} ${event.id}`), `${CHANGE_WHEN} ${event.id}`);
  await continueEventUpdateFlow(ctx(OWNER, 'not-a-real-date'), 'not-a-real-date');
  assert.equal(getConversationState(OWNER)?.state, 'WAITING_FOR_EDIT_DATE');
  assert.match(lastMessage().message, /couldn't understand that date/i);
  assert.match(lastMessage().message, /\/d\//);

  await continueEventUpdateFlow(ctx(OWNER, 'October 3, 2026'), 'October 3, 2026');
  assert.equal(getConversationState(OWNER)?.state, 'WAITING_FOR_EDIT_TIME');
  assert.match(lastMessage().message, /Pick a time/);
  await continueEventUpdateFlow(ctx(OWNER, 'later'), 'later');
  assert.equal(getConversationState(OWNER)?.state, 'WAITING_FOR_EDIT_TIME');
  assert.match(lastMessage().message, /specific start time/i);
});

test('Done after edit returns to Manage Event and does not send an update', async () => {
  const { event } = seedEvent();
  await editAllFields(event.id);
  const handled = await handleCustomerCommand(
    tap(OWNER, `MANAGE_EVENT ${event.id}`),
  );
  assert.equal(handled, true);
  assert.equal(guestNotices.length, 0);
  assert.equal(listEventUpdatesForEvent(event.id).length, 0);
  assert.match(lastMessage().message, /Katha Night/);
  assert.ok(lastMessage().buttons?.some((button) => button.title === 'More…'));
  await handleCustomerCommand(tap(OWNER, `${MORE_EVENT} ${event.id}`));
  assert.ok(
    lastMessage().list?.sections[0].rows.some((row) => row.title === '📢 Send Update'),
  );
});

test('Yes, No, Maybe, and awaiting recipients all receive an update', async () => {
  const event = createEvent('Statuses', EVENT_DATE, 'Hall', OWNER);
  const invitation = createInvitation({ eventId: event.id, type: 'individual' });
  addGuests(event.id, [GUEST_A, GUEST_B, GUEST_C, GUEST_FAIL], invitation.id);
  upsertRsvp(event.id, GUEST_A, 'yes', 1, 'yes', 1, 0);
  upsertRsvp(event.id, GUEST_B, 'no', 0, 'no', 0, 0);
  upsertRsvp(event.id, GUEST_C, 'maybe', 0, 'maybe', 0, 0);
  for (const phone of [OWNER, GUEST_A, GUEST_B, GUEST_C, GUEST_FAIL]) {
    upsertMessageSession(phone, `conv-${phone}`, 'acct-update');
  }

  await handleEventUpdateCommand(
    tap(OWNER, `${SEND_UPDATE} ${event.id}`),
    `${SEND_UPDATE} ${event.id}`,
  );
  await continueEventUpdateFlow(ctx(OWNER, SKIP_VALUE), SKIP_VALUE);
  await handleEventUpdateCommand(
    tap(OWNER, `${UPDATE_INFO} ${event.id}`),
    `${UPDATE_INFO} ${event.id}`,
  );

  assert.deepEqual(
    new Set(guestNotices.map((notice) => notice.phone)),
    new Set([GUEST_A, GUEST_B, GUEST_C, GUEST_FAIL]),
  );
});

test('planned invitation_count without sent invitations is not an update audience', async () => {
  const event = createEvent('Planned', EVENT_DATE, 'Hall', OWNER, {
    invitationCount: 25,
  });
  assert.equal(listEventUpdateTargets(event.id).length, 0);
  await handleEventUpdateCommand(
    tap(OWNER, `${SEND_UPDATE} ${event.id}`),
    `${SEND_UPDATE} ${event.id}`,
  );
  assert.match(lastMessage().message, /No invited guests to notify/);
  assert.equal(guestNotices.length, 0);
});

test('web-only RSVP after a sent invitation is not told to send invitations first', async () => {
  const event = createEvent('Web Only', EVENT_DATE, 'Hall', OWNER);
  createInvitation({ eventId: event.id, type: 'individual' });
  addGuests(event.id, [WEB_PHONE]);
  upsertRsvp(event.id, WEB_PHONE, 'yes', 1, 'yes', 1, 0);

  await handleEventUpdateCommand(
    tap(OWNER, `${SEND_UPDATE} ${event.id}`),
    `${SEND_UPDATE} ${event.id}`,
  );
  assert.match(lastMessage().message, /don't have a WhatsApp number/i);
  assert.doesNotMatch(lastMessage().message, /Send invitations first/);
  assert.equal(getConversationState(OWNER), undefined);
  assert.equal(guestNotices.length, 0);
});

test('WhatsApp invitation + Individual web Yes keeps a separate web RSVP', async () => {
  const event = createEvent('Dinner', EVENT_DATE, 'Hall', OWNER);
  const invitation = createInvitation({ eventId: event.id, type: 'individual' });
  addGuests(event.id, [GUEST_A], invitation.id);
  setGuestName(event.id, GUEST_A, 'Original Guest');
  upsertMessageSession(GUEST_A, `conv-${GUEST_A}`, 'acct-update');

  await withShortRsvpServer(async (baseUrl) => {
    await postWebRsvp(baseUrl, event.short_code, {
      response: 'yes',
      name: 'John Patel',
      adults: '1',
      children: '0',
      whatsapp: '7325553001',
    });
  });

  assert.equal(getRsvp(event.id, GUEST_A)?.status, 'pending');
  assert.equal(getGuest(event.id, GUEST_A)?.phone, GUEST_A);
  assert.equal(getGuest(event.id, GUEST_A)?.name, 'Original Guest');
  const webRsvps = listRsvpsForEvent(event.id).filter(
    (row) => isWebGuestPhone(row.phone) && row.status === 'yes',
  );
  assert.equal(webRsvps.length, 1);
  assert.equal(getGuest(event.id, webRsvps[0].phone)?.name, 'John Patel');

  const targets = listEventUpdateTargets(event.id);
  assert.equal(targets.length, 2);
  assert.deepEqual(
    targets.map((row) => row.phone).sort(),
    [GUEST_A, '+17325553001'].sort(),
  );

  await handleEventUpdateCommand(
    tap(OWNER, `${SEND_UPDATE} ${event.id}`),
    `${SEND_UPDATE} ${event.id}`,
  );
  await continueEventUpdateFlow(ctx(OWNER, SKIP_VALUE), SKIP_VALUE);
  await handleEventUpdateCommand(
    tap(OWNER, `${UPDATE_INFO} ${event.id}`),
    `${UPDATE_INFO} ${event.id}`,
  );
  assert.deepEqual(
    guestNotices.map((notice) => notice.phone).sort(),
    [GUEST_A, '+17325553001'].sort(),
  );
  assert.doesNotMatch(lastMessage().message, /don't have a WhatsApp number/i);
});

test('WhatsApp invitation + Individual web No keeps a separate web RSVP', async () => {
  const event = createEvent('Dinner', EVENT_DATE, 'Hall', OWNER);
  const invitation = createInvitation({ eventId: event.id, type: 'individual' });
  addGuests(event.id, [GUEST_A], invitation.id);

  await withShortRsvpServer(async (baseUrl) => {
    await postWebRsvp(baseUrl, event.short_code, {
      response: 'no',
      name: 'John Patel',
      whatsapp: '7325553002',
    });
  });

  assert.equal(getRsvp(event.id, GUEST_A)?.status, 'pending');
  const webRsvps = listRsvpsForEvent(event.id).filter(
    (row) => isWebGuestPhone(row.phone) && row.status === 'no',
  );
  assert.equal(webRsvps.length, 1);
  assert.deepEqual(
    listEventUpdateTargets(event.id).map((row) => row.phone).sort(),
    [GUEST_A, '+17325553002'].sort(),
  );
});

test('WhatsApp invitation + Individual web Maybe keeps a separate web RSVP', async () => {
  const event = createEvent('Dinner', EVENT_DATE, 'Hall', OWNER);
  const invitation = createInvitation({ eventId: event.id, type: 'individual' });
  addGuests(event.id, [GUEST_A], invitation.id);

  await withShortRsvpServer(async (baseUrl) => {
    await postWebRsvp(baseUrl, event.short_code, {
      response: 'maybe',
      name: 'John Patel',
      whatsapp: '7325553003',
    });
  });

  assert.equal(getRsvp(event.id, GUEST_A)?.status, 'pending');
  const webRsvps = listRsvpsForEvent(event.id).filter(
    (row) => isWebGuestPhone(row.phone) && row.status === 'maybe',
  );
  assert.equal(webRsvps.length, 1);
  assert.deepEqual(
    listEventUpdateTargets(event.id).map((row) => row.phone).sort(),
    [GUEST_A, '+17325553003'].sort(),
  );
});


test('WhatsApp invitation with no RSVP is still a Send Update recipient', () => {
  const event = createEvent('Dinner', EVENT_DATE, 'Hall', OWNER);
  const invitation = createInvitation({ eventId: event.id, type: 'individual' });
  addGuests(event.id, [GUEST_A], invitation.id);

  const targets = listEventUpdateTargets(event.id);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].phone, GUEST_A);
  assert.equal(getRsvp(event.id, GUEST_A)?.status, 'pending');
});

test('invitation with no WhatsApp phone is excluded and no number is invented', async () => {
  const event = createEvent('Share Link', EVENT_DATE, 'Hall', OWNER);
  const invitation = createInvitation({ eventId: event.id, type: 'individual' });
  addGuests(event.id, [WEB_PHONE], invitation.id);
  upsertRsvp(event.id, WEB_PHONE, 'yes', 1, 'web:yes 1+0', 1, 0);
  setGuestName(event.id, WEB_PHONE, 'Alex Rivera');

  assert.equal(isWebGuestPhone(WEB_PHONE), true);
  assert.equal(getGuest(event.id, WEB_PHONE)?.whatsapp_phone ?? null, null);
  assert.equal(findInvitationRecipient(event.id, invitation, OWNER), null);
  assert.equal(listEventUpdateTargets(event.id).length, 0);
  assert.notEqual(WEB_PHONE, OWNER);
});

test('live Individual web RSVP is invitation-sourced but cannot invent a WhatsApp notify phone', async () => {
  const event = createEvent('Live Update', EVENT_DATE, 'Hall', OWNER);
  const invitation = createInvitation({ eventId: event.id, type: 'individual' });

  await withShortRsvpServer(async (baseUrl) => {
    await postWebRsvp(baseUrl, event.short_code, {
      response: 'yes',
      name: 'Priya Shah',
      adults: '1',
      children: '0',
      whatsapp: '7325553011',
    });
    await postWebRsvp(baseUrl, event.short_code, {
      response: 'yes',
      name: 'Amit Shah',
      adults: '1',
      children: '0',
      whatsapp: '7325553012',
    });
  });

  const webRsvps = listRsvpsForEvent(event.id).filter(
    (row) => isWebGuestPhone(row.phone) && row.status === 'yes',
  );
  assert.equal(webRsvps.length, 2);
  assert.equal(new Set(webRsvps.map((row) => row.phone)).size, 2);
  for (const rsvp of webRsvps) {
    assert.equal(getGuest(event.id, rsvp.phone)?.invitation_id, invitation.id);
    assert.notEqual(rsvp.phone, OWNER);
  }
  assert.equal(listEventUpdateTargets(event.id).length, 2);
  assert.deepEqual(
    listEventUpdateTargets(event.id).map((row) => row.phone).sort(),
    ['+17325553011', '+17325553012'].sort(),
  );
  assert.equal(
    listEventUpdateTargets(event.id).some((row) => row.phone === OWNER),
    false,
  );

  await handleEventUpdateCommand(
    tap(OWNER, `${SEND_UPDATE} ${event.id}`),
    `${SEND_UPDATE} ${event.id}`,
  );
  assert.doesNotMatch(lastMessage().message, /don't have a WhatsApp number/i);
  assert.doesNotMatch(lastMessage().message, /Send invitations first/);
});

test('Individual web RSVP name does not replace the invitation phone', async () => {
  const event = createEvent('Dinner', EVENT_DATE, 'Hall', OWNER);
  const invitation = createInvitation({ eventId: event.id, type: 'individual' });
  addGuests(event.id, [GUEST_A], invitation.id);
  setGuestName(event.id, GUEST_A, 'Original Guest');

  await withShortRsvpServer(async (baseUrl) => {
    await postWebRsvp(baseUrl, event.short_code, {
      response: 'yes',
      name: 'John From Web',
      adults: '1',
      children: '0',
      whatsapp: '7325553013',
    });
  });

  const guest = getGuest(event.id, GUEST_A);
  assert.equal(guest?.phone, GUEST_A);
  assert.equal(guest?.name, 'Original Guest');
  assert.equal(getRsvp(event.id, GUEST_A)?.status, 'pending');
  const web = listRsvpsForEvent(event.id).find((row) => isWebGuestPhone(row.phone));
  assert.ok(web);
  assert.equal(getGuest(event.id, web.phone)?.name, 'John From Web');
  assert.equal(web.status, 'yes');
});


test('family invitation keeps the original WhatsApp phone after web RSVP', async () => {
  const event = createEvent('Dinner', EVENT_DATE, 'Home', OWNER);
  const family = createFamilyInvitation(event.id, 'Patel Family', 5);
  addGuests(event.id, [GUEST_C], family.id);
  setGuestName(event.id, GUEST_C, 'David Patel');

  await withShortRsvpServer(async (baseUrl) => {
    await postWebRsvp(baseUrl, family.short_code, {
      response: 'yes',
      name: 'Priya Patel',
      adults: '2',
      children: '1',
    });
  });

  assert.equal(getGuest(event.id, GUEST_C)?.phone, GUEST_C);
  assert.equal(getRsvp(event.id, GUEST_C)?.status, 'yes');
  const targets = listEventUpdateTargets(event.id);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].phone, GUEST_C);
  assert.equal(targets[0].invitationId, family.id);
  assert.equal(targets[0].familyName, 'Patel Family');
  assert.equal(
    listRsvpsForEvent(event.id).some((row) => isWebGuestPhone(row.phone)),
    false,
  );
});

test('Send Update recipient count follows invitation phones, not RSVP status', () => {
  const event = createEvent('Mix', EVENT_DATE, 'Hall', OWNER);
  const yesInvite = createInvitation({ eventId: event.id, type: 'individual' });
  const pendingInvite = createInvitation({ eventId: event.id, type: 'individual' });
  const noInvite = createInvitation({ eventId: event.id, type: 'individual' });
  addGuests(event.id, [GUEST_A], yesInvite.id);
  addGuests(event.id, [GUEST_B], pendingInvite.id);
  addGuests(event.id, [GUEST_C], noInvite.id);
  upsertRsvp(event.id, GUEST_A, 'yes', 1, 'yes', 1, 0);
  upsertRsvp(event.id, GUEST_C, 'no', 0, 'no', 0, 0);

  const targets = listEventUpdateTargets(event.id);
  assert.equal(targets.length, 3);
  assert.deepEqual(
    new Set(targets.map((row) => row.phone)),
    new Set([GUEST_A, GUEST_B, GUEST_C]),
  );
});

test('failed invitation sends are not treated as delivered update recipients', () => {
  const event = createEvent('Broadcast', EVENT_DATE, 'Hall', OWNER);
  const delivered = createInvitation({ eventId: event.id, type: 'individual' });
  createInvitation({ eventId: event.id, type: 'individual' });
  addGuests(event.id, [GUEST_A], delivered.id);
  addGuests(event.id, [OWNER], delivered.id);

  const targets = listEventUpdateTargets(event.id);
  assert.deepEqual(
    targets.map((row) => row.phone),
    [GUEST_A],
  );
  assert.equal(
    targets.some((row) => row.phone === OWNER),
    false,
  );
});

test('Send Update with no recipients explains the empty target', async () => {
  const event = createEvent('Empty', EVENT_DATE, 'Hall', OWNER);
  await handleEventUpdateCommand(
    tap(OWNER, `${SEND_UPDATE} ${event.id}`),
    `${SEND_UPDATE} ${event.id}`,
  );
  assert.match(lastMessage().message, /No invited guests to notify/);
  assert.equal(getConversationState(OWNER), undefined);
  assert.equal(guestNotices.length, 0);
});

test('information-only update targets guests, uses latest details, and does not require ack', async () => {
  const { event } = seedEvent();
  await editAllFields(event.id);
  const latest = getEventById(event.id)!;

  await handleEventUpdateCommand(
    tap(OWNER, `${SEND_UPDATE} ${latest.id}`),
    `${SEND_UPDATE} ${latest.id}`,
  );
  await continueEventUpdateFlow(ctx(OWNER, 'Parking is behind the hall'), 'Parking is behind the hall');
  await handleEventUpdateCommand(
    tap(OWNER, `${UPDATE_INFO} ${latest.id}`),
    `${UPDATE_INFO} ${latest.id}`,
  );

  const updates = listEventUpdatesForEvent(latest.id);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].type, 'info');
  assert.equal(updates[0].acknowledgement_required, 0);
  assert.equal(updates[0].snapshot_name, 'Katha Night');
  assert.equal(updates[0].snapshot_location, 'Town Hall');
  assert.equal(updates[0].message, 'Parking is behind the hall');

  const recipients = listEventUpdateRecipients(updates[0].id);
  assert.equal(recipients.every((row) => row.acknowledged_at == null), true);
  assert.equal(recipients.some((row) => row.phone === WEB_PHONE), false);
  assert.deepEqual(
    new Set(guestNotices.map((notice) => notice.phone)),
    new Set([GUEST_A, GUEST_B, GUEST_C]),
  );
  assert.match(guestNotices[0].message, /📢 Event Update/);
  assert.match(guestNotices[0].message, /Katha Night/);
  assert.match(guestNotices[0].message, /Town Hall/);
  assert.match(guestNotices[0].message, /Parking is behind the hall/);
  assert.match(
    guestNotices[0].message,
    new RegExp(buildShortRsvpUrl(latest.short_code ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  );
  assert.equal(guestNotices[0].buttons, undefined);
  assert.equal(getConversationState(OWNER), undefined);
  assert.match(lastMessage().message, /Update sent/);
});

test('family invitation is one update recipient, not one per member', () => {
  const event = createEvent('Dinner', EVENT_DATE, 'Home', OWNER);
  const family = createFamilyInvitation(event.id, 'Patel Family', 5);
  addGuests(event.id, [GUEST_A, GUEST_B], family.id);
  const targets = listEventUpdateTargets(event.id);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].invitationId, family.id);
  assert.equal(targets[0].familyName, 'Patel Family');
});

test('acknowledgement update records per-update acks and treats duplicates as idempotent', async () => {
  const { event } = seedEvent();
  await handleEventUpdateCommand(
    tap(OWNER, `${SEND_UPDATE} ${event.id}`),
    `${SEND_UPDATE} ${event.id}`,
  );
  await continueEventUpdateFlow(ctx(OWNER, SKIP_VALUE), SKIP_VALUE);
  await handleEventUpdateCommand(
    tap(OWNER, `${UPDATE_ACK} ${event.id}`),
    `${UPDATE_ACK} ${event.id}`,
  );

  const first = listEventUpdatesForEvent(event.id)[0];
  assert.equal(first.acknowledgement_required, 1);
  assert.equal(getEventUpdateAckCounts(first.id).acknowledged, 0);
  assert.equal(getEventUpdateAckCounts(first.id).sent, 3);
  assert.match(guestNotices[0].message, /Important Event Update/);
  assert.match(guestNotices[0].message, /👉 Review & Acknowledge:/);
  assert.match(guestNotices[0].message, /https:\/\/connect\.zip-bite\.com\/a\//);
  assert.doesNotMatch(guestNotices[0].message, /ACK_UPDATE/);
  assert.ok(
    !guestNotices[0].buttons?.some((button) =>
      button.payload.startsWith(ACK_UPDATE),
    ),
  );
  assert.deepEqual(
    guestNotices[0].buttons?.map((button) => button.title),
    ['View RSVP'],
  );
  const firstRecipients = listEventUpdateRecipients(first.id);
  assert.ok(firstRecipients.every((row) => row.ack_token && row.ack_token.length >= 16));
  assert.equal(new Set(firstRecipients.map((row) => row.ack_token)).size, firstRecipients.length);

  const firstAck = await handleGuestUpdateCommand(
    tap(GUEST_A, `${ACK_UPDATE} ${first.id}`),
    `${ACK_UPDATE} ${first.id}`,
  );
  const duplicate = acknowledgeUpdateRecipient(first.id, GUEST_A);
  const secondAck = await handleGuestUpdateCommand(
    tap(GUEST_A, `${ACK_UPDATE} ${first.id}`),
    `${ACK_UPDATE} ${first.id}`,
  );
  assert.equal(firstAck, true);
  assert.equal(secondAck, true);
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.already, true);
  assert.equal(getEventUpdateAckCounts(first.id).acknowledged, 1);
  assert.match(lastMessage().message, /Thank you/);
  assert.match(lastMessage().message, /Community Center/);
  assert.equal(listRsvpsForEvent(event.id).every((row) => row.status === 'pending'), true);

  guestNotices.length = 0;
  await handleEventUpdateCommand(
    tap(OWNER, `${SEND_UPDATE} ${event.id}`),
    `${SEND_UPDATE} ${event.id}`,
  );
  await continueEventUpdateFlow(ctx(OWNER, SKIP_VALUE), SKIP_VALUE);
  await handleEventUpdateCommand(
    tap(OWNER, `${UPDATE_ACK} ${event.id}`),
    `${UPDATE_ACK} ${event.id}`,
  );
  const second = listEventUpdatesForEvent(event.id)[0];
  assert.notEqual(second.id, first.id);
  assert.equal(getEventUpdateAckCounts(second.id).acknowledged, 0);
  assert.equal(acknowledgeUpdateRecipient(first.id, GUEST_A).already, true);
});

test('ack status counts only successful sends and lists family identity without web ids', async () => {
  const { event } = seedEvent();
  addGuests(event.id, [GUEST_FAIL]);
  upsertMessageSession(GUEST_FAIL, 'conv-fail', 'acct-update');
  failingPhones.add(GUEST_FAIL);

  await handleEventUpdateCommand(
    tap(OWNER, `${SEND_UPDATE} ${event.id}`),
    `${SEND_UPDATE} ${event.id}`,
  );
  await continueEventUpdateFlow(ctx(OWNER, SKIP_VALUE), SKIP_VALUE);
  await handleEventUpdateCommand(
    tap(OWNER, `${UPDATE_ACK} ${event.id}`),
    `${UPDATE_ACK} ${event.id}`,
  );

  const update = listEventUpdatesForEvent(event.id)[0];
  const counts = getEventUpdateAckCounts(update.id);
  assert.equal(counts.failed, 1);
  assert.equal(counts.sent, 3);
  assert.equal(counts.acknowledged, 0);
  assert.match(lastMessage().message, /Acknowledged: 0 \/ 3/);

  await handleGuestUpdateCommand(
    tap(GUEST_A, `${ACK_UPDATE} ${update.id}`),
    `${ACK_UPDATE} ${update.id}`,
  );
  await handleEventUpdateCommand(
    tap(OWNER, `${VIEW_UPDATE_STATUS} ${update.id}`),
    `${VIEW_UPDATE_STATUS} ${update.id}`,
  );
  assert.match(lastMessage().message, /John Patel — Acknowledged/);
  assert.match(lastMessage().message, /Patel Family — Awaiting/);
  assert.doesNotMatch(lastMessage().message, /web:/);
});

test('everyone-acknowledged organizer notice fires once when the last sent guest acks', async () => {
  const event = createEvent('Katha', EVENT_DATE, 'Hall', OWNER);
  addGuests(event.id, [GUEST_A, GUEST_B]);
  setGuestName(event.id, GUEST_A, 'John Patel');
  setGuestName(event.id, GUEST_B, 'Maria Patel');
  for (const phone of [OWNER, GUEST_A, GUEST_B]) {
    upsertMessageSession(phone, `conv-${phone}`, 'acct-update');
  }

  await handleEventUpdateCommand(
    tap(OWNER, `${SEND_UPDATE} ${event.id}`),
    `${SEND_UPDATE} ${event.id}`,
  );
  await continueEventUpdateFlow(ctx(OWNER, SKIP_VALUE), SKIP_VALUE);
  await handleEventUpdateCommand(
    tap(OWNER, `${UPDATE_ACK} ${event.id}`),
    `${UPDATE_ACK} ${event.id}`,
  );
  const update = listEventUpdatesForEvent(event.id)[0];

  await handleGuestUpdateCommand(
    tap(GUEST_A, `${ACK_UPDATE} ${update.id}`),
    `${ACK_UPDATE} ${update.id}`,
  );
  assert.equal(getEventUpdateById(update.id)?.organizer_all_acked_notified_at, null);

  sent.length = 0;
  await handleGuestUpdateCommand(
    tap(GUEST_B, `${ACK_UPDATE} ${update.id}`),
    `${ACK_UPDATE} ${update.id}`,
  );
  const everyone = sent.filter((message) =>
    message.message.includes('Everyone has acknowledged the update'),
  );
  assert.equal(everyone.length, 1);
  assert.match(everyone[0].message, /Katha/);
  assert.match(everyone[0].message, /All 2 invited guests have confirmed they received/);
  assert.doesNotMatch(everyone[0].message, /read/i);
  assert.ok(getEventUpdateById(update.id)?.organizer_all_acked_notified_at);

  sent.length = 0;
  await handleGuestUpdateCommand(
    tap(GUEST_B, `${ACK_UPDATE} ${update.id}`),
    `${ACK_UPDATE} ${update.id}`,
  );
  assert.equal(
    sent.filter((message) => message.message.includes('Everyone has acknowledged')).length,
    0,
  );
});

test('ack reminder targets only sent and unacknowledged recipients', async () => {
  const { event } = seedEvent();
  await handleEventUpdateCommand(
    tap(OWNER, `${SEND_UPDATE} ${event.id}`),
    `${SEND_UPDATE} ${event.id}`,
  );
  await continueEventUpdateFlow(ctx(OWNER, SKIP_VALUE), SKIP_VALUE);
  await handleEventUpdateCommand(
    tap(OWNER, `${UPDATE_ACK} ${event.id}`),
    `${UPDATE_ACK} ${event.id}`,
  );
  const update = listEventUpdatesForEvent(event.id)[0];
  await handleGuestUpdateCommand(
    tap(GUEST_A, `${ACK_UPDATE} ${update.id}`),
    `${ACK_UPDATE} ${update.id}`,
  );

  guestNotices.length = 0;
  await handleEventUpdateCommand(
    tap(OWNER, `${REMIND_UPDATE} ${update.id}`),
    `${REMIND_UPDATE} ${update.id}`,
  );
  assert.deepEqual(
    new Set(guestNotices.map((notice) => notice.phone)),
    new Set([GUEST_B, GUEST_C]),
  );
  assert.equal(guestNotices.some((notice) => notice.phone === GUEST_A), false);
  assert.deepEqual(
    listUnacknowledgedSentRecipients(update.id).map((row) => row.phone).sort(),
    [GUEST_B, GUEST_C].sort(),
  );
});

test('Hi during update wizard is not stored as the update message', async () => {
  const { event } = seedEvent();
  setConversationState(OWNER, 'WAITING_FOR_UPDATE_MESSAGE', {
    event_id: event.id,
    update_message: null,
  });
  const handled = await handleCustomerCommand(ctx(OWNER, 'Hi'));
  assert.equal(handled, true);
  assert.equal(getConversationState(OWNER), undefined);
  assert.match(lastMessage().message, /Welcome to ZipNest/);
  assert.equal(isEventUpdateFlowState('WAITING_FOR_UPDATE_MESSAGE'), true);
});

test('Invite More and Done Sending still work after an update send', async () => {
  const { event } = seedEvent();
  await handleEventUpdateCommand(
    tap(OWNER, `${SEND_UPDATE} ${event.id}`),
    `${SEND_UPDATE} ${event.id}`,
  );
  await continueEventUpdateFlow(ctx(OWNER, SKIP_VALUE), SKIP_VALUE);
  await handleEventUpdateCommand(
    tap(OWNER, `${UPDATE_INFO} ${event.id}`),
    `${UPDATE_INFO} ${event.id}`,
  );
  assert.equal(getConversationState(OWNER), undefined);

  const more = await handleInviteCommand(
    tap(OWNER, `${INVITE_MORE} ${event.id}`),
    `${INVITE_MORE} ${event.id}`,
  );
  assert.equal(more, true);
  assert.match(lastMessage().message, /Who would you like to invite/);
  const done = await handleInviteCommand(
    tap(OWNER, `${DONE_SENDING} ${event.id}`),
    `${DONE_SENDING} ${event.id}`,
  );
  assert.equal(done, true);
  assert.equal(getConversationState(OWNER), undefined);
  assert.match(lastMessage().message, /All set/);
});

test('cancel event confirms, marks cancelled, notifies guests, and keeps RSVP rows', async () => {
  const { event } = seedEvent();
  upsertRsvp(event.id, GUEST_A, 'yes', 2, 'yes', 2, 0);
  await handleEventUpdateCommand(
    tap(OWNER, `${VOID_EVENT} ${event.id}`),
    `${VOID_EVENT} ${event.id}`,
  );
  assert.match(lastMessage().message, /Cancel Event\?/);
  assert.equal(isEventCancelled(getEventById(event.id)), false);

  await handleEventUpdateCommand(
    tap(OWNER, `${KEEP_EVENT} ${event.id}`),
    `${KEEP_EVENT} ${event.id}`,
  );
  assert.equal(isEventCancelled(getEventById(event.id)), false);

  await handleEventUpdateCommand(
    tap(OWNER, `${VOID_EVENT} ${event.id}`),
    `${VOID_EVENT} ${event.id}`,
  );
  await handleEventUpdateCommand(
    tap(OWNER, `${CONFIRM_VOID_EVENT} ${event.id}`),
    `${CONFIRM_VOID_EVENT} ${event.id}`,
  );

  const cancelled = getEventById(event.id);
  assert.ok(cancelled?.cancelled_at);
  assert.match(lastMessage().message, /Event cancelled/);
  assert.match(lastMessage().message, /3 guests were notified/);
  assert.doesNotMatch(lastMessage().message, /could not be sent/);
  assert.ok(guestNotices.some((notice) => notice.message.includes('Event Cancelled')));
  const rsvps = listRsvpsForEvent(event.id);
  assert.equal(rsvps.some((row) => row.phone === GUEST_A && row.status === 'yes'), true);
});

test('cancelled RSVP page is 410 and blocks new RSVPs while keeping the same short code', async () => {
  const { event } = seedEvent();
  upsertRsvp(event.id, GUEST_A, 'maybe', 0, 'maybe', 0, 0);
  cancelEvent(event.id);

  await withShortRsvpServer(async (baseUrl) => {
    const url = `${baseUrl}/r/${event.short_code}`;
    const getRes = await fetch(url, { redirect: 'manual' });
    assert.equal(getRes.status, 410);
    const getBody = await getRes.text();
    assert.match(getBody, /Event Cancelled/);
    assert.doesNotMatch(getBody, /Will you be attending/);

    const postRes = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ response: 'yes', name: 'New Guest', adults: '1', children: '0' }),
      redirect: 'manual',
    });
    assert.equal(postRes.status, 410);
  });

  const rsvps = listRsvpsForEvent(event.id);
  assert.equal(rsvps.some((row) => row.phone === GUEST_A && row.status === 'maybe'), true);
  assert.equal(rsvps.some((row) => row.status === 'yes'), false);
});

test('RSVP short link keeps the same code and shows latest details after an edit', async () => {
  const { event } = seedEvent();
  const short = event.short_code;
  updateEventDetails(event.id, {
    name: 'Katha Night',
    date: 'Friday, October 2, 2026 at 6:30 PM',
    location: 'Town Hall',
  });

  await withShortRsvpServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/r/${short}`, { redirect: 'manual' });
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /Katha Night/);
    assert.match(body, /Town Hall/);
    assert.match(body, /October 2, 2026/);
    assert.match(body, /Will you be attending/);
    assert.doesNotMatch(body, /Family Invitation/);
  });
});

test('info update message uses the existing short RSVP URL', () => {
  const event = createEvent('Katha', EVENT_DATE, 'Community Center', OWNER);
  const message = formatInfoUpdateMessage(event, null);
  assert.match(message, /📢 Event Update/);
  assert.match(message, /There has been an update to Katha/);
  assert.match(
    message,
    new RegExp(buildShortRsvpUrl(event.short_code ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  );
  assert.doesNotMatch(message, /Acknowledge/);
});

test('View Event / RSVP after ack does not change the guest RSVP', async () => {
  const { event } = seedEvent();
  upsertRsvp(event.id, GUEST_A, 'no', 0, 'no', 0, 0);
  await handleGuestUpdateCommand(
    tap(GUEST_A, `${VIEW_EVENT_RSVP} ${event.id}`),
    `${VIEW_EVENT_RSVP} ${event.id}`,
  );
  assert.match(lastMessage().message, /Community Center/);
  assert.match(
    lastMessage().message,
    new RegExp(buildShortRsvpUrl(event.short_code ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  );
  assert.equal(
    listRsvpsForEvent(event.id).find((row) => row.phone === GUEST_A)?.status,
    'no',
  );
});

test('organizer command routing reaches Send Update', async () => {
  const { event } = seedEvent();
  const handled = await handleOrganizerCommand(
    tap(OWNER, `${SEND_UPDATE} ${event.id}`),
  );
  assert.equal(handled, true);
  assert.match(lastMessage().message, /What should guests know/);
  assert.equal(getConversationState(OWNER)?.state, 'WAITING_FOR_UPDATE_MESSAGE');
});

async function sendRequireAckUpdate(eventId: number): Promise<number> {
  await handleEventUpdateCommand(
    tap(OWNER, `${SEND_UPDATE} ${eventId}`),
    `${SEND_UPDATE} ${eventId}`,
  );
  await continueEventUpdateFlow(ctx(OWNER, SKIP_VALUE), SKIP_VALUE);
  await handleEventUpdateCommand(
    tap(OWNER, `${UPDATE_ACK} ${eventId}`),
    `${UPDATE_ACK} ${eventId}`,
  );
  return listEventUpdatesForEvent(eventId)[0].id;
}

test('web ack token is unique, maps to one recipient, and does not expose ids', async () => {
  const { event } = seedEvent();
  upsertRsvp(event.id, GUEST_A, 'maybe', 0, 'maybe', 0, 0);
  const updateId = await sendRequireAckUpdate(event.id);
  const recipients = listEventUpdateRecipients(updateId);
  const guestA = recipients.find((row) => row.phone === GUEST_A);
  const guestB = recipients.find((row) => row.phone === GUEST_B);
  assert.ok(guestA?.ack_token);
  assert.ok(guestB?.ack_token);
  assert.notEqual(guestA.ack_token, guestB.ack_token);
  assert.match(guestA.ack_token, /^[0-9a-f]{32}$/);
  assert.doesNotMatch(guestNotices[0].message, new RegExp(`/a/${updateId}\\b`));
  assert.doesNotMatch(guestNotices[0].message, new RegExp(`/a/${event.id}\\b`));

  await withShortRsvpServer(async (baseUrl) => {
    const url = `${baseUrl}/a/${guestA.ack_token}`;
    const getRes = await fetch(url, { redirect: 'manual' });
    assert.equal(getRes.status, 200);
    const getBody = await getRes.text();
    assert.match(getBody, /Important Event Update/);
    assert.match(getBody, /Acknowledge Update/);
    assert.match(getBody, /Update RSVP/);
    assert.match(getBody, new RegExp(`/r/${event.short_code}`));
    assert.doesNotMatch(getBody, /Will you be attending/);

    const postRes = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ack: '1' }),
      redirect: 'manual',
    });
    assert.equal(postRes.status, 200);
    const postBody = await postRes.text();
    assert.match(postBody, /Thank you/);
    assert.match(postBody, /acknowledgement has been recorded/);
    assert.match(postBody, /Update RSVP/);

    const again = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ack: '1' }),
      redirect: 'manual',
    });
    assert.equal(again.status, 200);
    assert.match(await again.text(), /Thank you/);

    const other = await fetch(`${baseUrl}/a/${guestB.ack_token}`, { redirect: 'manual' });
    assert.equal(other.status, 200);
    assert.match(await other.text(), /Have you received and reviewed this update/);

    const invalid = await fetch(`${baseUrl}/a/not-a-real-token`, { redirect: 'manual' });
    assert.equal(invalid.status, 404);

    const sequential = await fetch(`${baseUrl}/a/${guestA.id}`, { redirect: 'manual' });
    assert.equal(sequential.status, 404);
  });

  assert.equal(getEventUpdateAckCounts(updateId).acknowledged, 1);
  assert.ok(listEventUpdateRecipients(updateId).find((row) => row.phone === GUEST_A)?.acknowledged_at);
  assert.equal(
    listEventUpdateRecipients(updateId).find((row) => row.phone === GUEST_B)?.acknowledged_at,
    null,
  );
  assert.equal(
    listRsvpsForEvent(event.id).find((row) => row.phone === GUEST_A)?.status,
    'maybe',
  );
  assert.equal(lookupAckUpdateTarget(guestB.ack_token ?? '')?.recipient.phone, GUEST_B);
});

test('web ack fires everyone-acknowledged organizer notice once', async () => {
  const event = createEvent('Katha', EVENT_DATE, 'Hall', OWNER);
  addGuests(event.id, [GUEST_A, GUEST_B]);
  setGuestName(event.id, GUEST_A, 'John Patel');
  setGuestName(event.id, GUEST_B, 'Maria Patel');
  for (const phone of [OWNER, GUEST_A, GUEST_B]) {
    upsertMessageSession(phone, `conv-${phone}`, 'acct-update');
  }
  const updateId = await sendRequireAckUpdate(event.id);
  const tokens = listEventUpdateRecipients(updateId).map((row) => row.ack_token ?? '');

  await withShortRsvpServer(async (baseUrl) => {
    sent.length = 0;
    await fetch(`${baseUrl}/a/${tokens[0]}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ack: '1' }),
    });
    assert.equal(
      sent.filter((message) => message.message.includes('Everyone has acknowledged')).length,
      0,
    );
    await fetch(`${baseUrl}/a/${tokens[1]}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ack: '1' }),
    });
  });

  const everyone = sent.filter((message) =>
    message.message.includes('Everyone has acknowledged the update'),
  );
  assert.equal(everyone.length, 1);
  assert.ok(getEventUpdateById(updateId)?.organizer_all_acked_notified_at);
});

test('ack template is configurable and out-of-window send uses body extra not an ack button', async () => {
  const { event } = seedEvent();
  process.env.EVENT_UPDATE_ACK_TEMPLATE_NAME = 'event_update_ack_test';
  assert.equal(eventUpdateAckTemplateName(), 'event_update_ack_test');

  const broadcasts: Array<{ templateName: string; extra: string; phones: string[] }> = [];
  setEventUpdateGuestSender();
  setEventUpdateTransports({
    inbox: async () => {
      throw new Error('outside 24h window');
    },
    broadcast: async (params) => {
      broadcasts.push({
        templateName: params.templateName,
        extra: params.extra,
        phones: params.phones,
      });
      return { sent: 1, failed: 0, broadcastId: 'b1' };
    },
  });

  await sendRequireAckUpdate(event.id);
  assert.ok(broadcasts.length >= 3);
  assert.ok(broadcasts.every((row) => row.templateName === 'event_update_ack_test'));
  assert.ok(broadcasts.every((row) => /\/a\/[0-9a-f]{32}/.test(row.extra)));
  assert.ok(broadcasts.every((row) => !row.extra.includes(ACK_UPDATE)));
  assert.equal(getEventUpdateAckCounts(listEventUpdatesForEvent(event.id)[0].id).sent, 3);
  assert.equal(getEventUpdateAckCounts(listEventUpdatesForEvent(event.id)[0].id).failed, 0);
});

test('unset ack template records failed when inbox cannot send', async () => {
  const { event } = seedEvent();
  delete process.env.EVENT_UPDATE_ACK_TEMPLATE_NAME;
  assert.equal(eventUpdateAckTemplateName(), undefined);
  setEventUpdateGuestSender();
  setEventUpdateTransports({
    inbox: async () => {
      throw new Error('outside 24h window');
    },
  });

  await sendRequireAckUpdate(event.id);
  const counts = getEventUpdateAckCounts(listEventUpdatesForEvent(event.id)[0].id);
  assert.equal(counts.sent, 0);
  assert.equal(counts.failed, 3);
});

test('broadcast sent:0 failed:1 is stored as failed and excluded from ack denominator', async () => {
  const { event } = seedEvent();
  process.env.EVENT_UPDATE_ACK_TEMPLATE_NAME = 'event_update_ack_test';
  setEventUpdateGuestSender();
  setEventUpdateTransports({
    inbox: async () => {
      throw new Error('outside 24h window');
    },
    broadcast: async () => ({ sent: 0, failed: 1, broadcastId: 'b-fail' }),
  });

  await sendRequireAckUpdate(event.id);
  const counts = getEventUpdateAckCounts(listEventUpdatesForEvent(event.id)[0].id);
  assert.equal(isBroadcastSendSuccessful({ sent: 0, failed: 1 }), false);
  assert.equal(isBroadcastSendSuccessful({ sent: 1, failed: 0 }), true);
  assert.equal(counts.sent, 0);
  assert.equal(counts.failed, 3);
  assert.match(lastMessage().message, /Acknowledged: 0 \/ 0/);
});

test('cancelled event blocks invites, updates, ack reminders, and keeps RSVPs', async () => {
  const { event } = seedEvent();
  upsertRsvp(event.id, GUEST_A, 'yes', 2, 'yes', 2, 0);
  const updateId = await sendRequireAckUpdate(event.id);
  cancelEvent(event.id);

  guestNotices.length = 0;
  await handleInviteCommand(
    tap(OWNER, `${START_INVITE} ${event.id}`),
    `${START_INVITE} ${event.id}`,
  );
  assert.match(lastMessage().message, /cancelled/);
  assert.doesNotMatch(lastMessage().message, /Who would you like to invite/);

  await handleEventUpdateCommand(
    tap(OWNER, `${SEND_UPDATE} ${event.id}`),
    `${SEND_UPDATE} ${event.id}`,
  );
  assert.match(lastMessage().message, /cancelled/);

  await handleEventUpdateCommand(
    tap(OWNER, `${REMIND_UPDATE} ${updateId}`),
    `${REMIND_UPDATE} ${updateId}`,
  );
  assert.match(lastMessage().message, /cancelled/);
  assert.equal(guestNotices.length, 0);

  assert.equal(
    listRsvpsForEvent(event.id).find((row) => row.phone === GUEST_A)?.status,
    'yes',
  );
});

test('cancel confirmation reports only successful sends', async () => {
  const { event } = seedEvent();
  addGuests(event.id, [GUEST_FAIL]);
  upsertMessageSession(GUEST_FAIL, 'conv-fail', 'acct-update');
  failingPhones.add(GUEST_FAIL);

  await handleEventUpdateCommand(
    tap(OWNER, `${VOID_EVENT} ${event.id}`),
    `${VOID_EVENT} ${event.id}`,
  );
  await handleEventUpdateCommand(
    tap(OWNER, `${CONFIRM_VOID_EVENT} ${event.id}`),
    `${CONFIRM_VOID_EVENT} ${event.id}`,
  );

  assert.match(lastMessage().message, /3 guests were notified/);
  assert.match(lastMessage().message, /1 notification could not be sent/);
  assert.doesNotMatch(lastMessage().message, /Invited guests have been notified/);
});

test('stale Send Update and Cancel payloads are rejected', async () => {
  const { event } = seedEvent();
  const other = createEvent('Other Night', EVENT_DATE, 'Other Hall', OWNER);
  addGuests(other.id, [GUEST_A]);

  setConversationState(OWNER, 'WAITING_FOR_EVENT_NAME', {
    name: 'Leftover Create Name',
    date: 'Yesterday',
    location: 'Old Place',
  });
  await handleEventUpdateCommand(
    tap(OWNER, `${SEND_UPDATE} ${event.id}`),
    `${SEND_UPDATE} ${event.id}`,
  );
  assert.equal(getConversationState(OWNER)?.name, 'Katha');
  assert.equal(getConversationState(OWNER)?.update_message, null);
  assert.doesNotMatch(getConversationState(OWNER)?.name ?? '', /Leftover/);

  guestNotices.length = 0;
  await handleEventUpdateCommand(
    tap(OWNER, `${UPDATE_ACK} ${other.id}`),
    `${UPDATE_ACK} ${other.id}`,
  );
  assert.equal(guestNotices.length, 0);
  assert.equal(listEventUpdatesForEvent(other.id).length, 0);
  assert.match(lastMessage().message, /no longer active/);

  clearConversationState(OWNER);
  guestNotices.length = 0;
  await handleEventUpdateCommand(
    tap(OWNER, `${UPDATE_ACK} ${event.id}`),
    `${UPDATE_ACK} ${event.id}`,
  );
  assert.equal(guestNotices.length, 0);
  assert.match(lastMessage().message, /no longer active/);

  await handleEventUpdateCommand(
    tap(OWNER, `${CONFIRM_VOID_EVENT} ${event.id}`),
    `${CONFIRM_VOID_EVENT} ${event.id}`,
  );
  assert.equal(isEventCancelled(getEventById(event.id)), false);
  assert.match(lastMessage().message, /no longer active/);
  assert.equal(guestNotices.length, 0);
});

test('ack_token is added after the table exists and unique-indexed', () => {
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE events (
      id INTEGER PRIMARY KEY,
      name TEXT,
      date TEXT,
      location TEXT,
      organizer_phone TEXT,
      cancelled_at TEXT
    );
    CREATE TABLE conversation_states (
      organizer_phone TEXT PRIMARY KEY,
      state TEXT,
      update_message TEXT
    );
    CREATE TABLE event_updates (
      id INTEGER PRIMARY KEY,
      event_id INTEGER,
      type TEXT,
      acknowledgement_required INTEGER,
      snapshot_name TEXT,
      snapshot_date TEXT,
      snapshot_location TEXT,
      message TEXT,
      organizer_all_acked_notified_at TEXT,
      created_at TEXT
    );
    CREATE TABLE event_update_recipients (
      id INTEGER PRIMARY KEY,
      update_id INTEGER,
      invitation_id INTEGER,
      guest_id INTEGER,
      phone TEXT,
      send_status TEXT,
      acknowledged_at TEXT,
      reminder_sent_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    INSERT INTO event_updates (
      id, event_id, type, acknowledgement_required,
      snapshot_name, snapshot_date, snapshot_location
    ) VALUES (1, 1, 'ack', 1, 'Katha', 'Oct 1', 'Hall');
    INSERT INTO event_update_recipients (id, update_id, phone, send_status)
    VALUES (1, 1, '+15552220001', 'sent');
  `);

  ensureEventUpdateTables(database);
  const columns = database
    .prepare(`PRAGMA table_info(event_update_recipients)`)
    .all() as Array<{ name: string }>;
  assert.ok(columns.some((column) => column.name === 'ack_token'));
  const row = database
    .prepare(`SELECT ack_token FROM event_update_recipients WHERE id = 1`)
    .get() as { ack_token: string };
  assert.ok(row.ack_token);
  assert.match(row.ack_token, /^[0-9a-f]{32}$/);
  const indexes = database
    .prepare(`PRAGMA index_list(event_update_recipients)`)
    .all() as Array<{ name: string }>;
  assert.ok(
    indexes.some((index) => index.name === 'idx_event_update_recipients_ack_token'),
  );
  const eventColumns = database
    .prepare(`PRAGMA table_info(events)`)
    .all() as Array<{ name: string }>;
  assert.ok(eventColumns.some((column) => column.name === 'deleted_at'));
  database.close();
});

test('delete event requires confirmation and Keep Event does not delete', async () => {
  const { event } = seedEvent();
  await handleEventUpdateCommand(
    tap(OWNER, `${DELETE_EVENT} ${event.id}`),
    `${DELETE_EVENT} ${event.id}`,
  );
  assert.match(lastMessage().message, /Remove this event from your list/);
  assert.match(lastMessage().message, /Katha/);
  assert.match(lastMessage().message, /RSVP history will be kept/);
  assert.equal(isEventDeleted(getEventById(event.id)), false);
  assert.deepEqual(
    lastMessage().buttons?.map((button) => button.title),
    ['Cancel', '🗑️ Delete'],
  );
  assert.ok(
    lastMessage().buttons?.some((button) =>
      button.payload.startsWith(CONFIRM_DELETE_EVENT),
    ),
  );
  assert.ok(
    !lastMessage().buttons?.some((button) =>
      button.payload.startsWith(VOID_EVENT) ||
      button.payload.startsWith(CONFIRM_VOID_EVENT),
    ),
  );

  await handleEventUpdateCommand(
    tap(OWNER, `${KEEP_EVENT} ${event.id}`),
    `${KEEP_EVENT} ${event.id}`,
  );
  assert.equal(isEventDeleted(getEventById(event.id)), false);
  assert.equal(isEventCancelled(getEventById(event.id)), false);
  assert.equal(guestNotices.length, 0);
});

test('confirmed delete hides the event, keeps history, and does not notify guests', async () => {
  const { event, individual } = seedEvent();
  upsertRsvp(event.id, GUEST_A, 'yes', 1, 'yes', 1, 0);
  await handleEventUpdateCommand(
    tap(OWNER, `${DELETE_EVENT} ${event.id}`),
    `${DELETE_EVENT} ${event.id}`,
  );
  await handleEventUpdateCommand(
    tap(OWNER, `${CONFIRM_DELETE_EVENT} ${event.id}`),
    `${CONFIRM_DELETE_EVENT} ${event.id}`,
  );

  const deleted = getEventById(event.id);
  assert.ok(deleted?.deleted_at);
  assert.equal(isEventDeleted(deleted), true);
  assert.equal(isEventCancelled(deleted), false);
  assert.match(lastMessage().message, /Event deleted/);
  assert.match(lastMessage().message, /removed from your My Events list/);
  assert.deepEqual(
    lastMessage().buttons?.map((button) => button.title),
    ['🏠 Main Menu'],
  );
  assert.equal(guestNotices.length, 0);
  assert.equal(listEventsForOrganizer(OWNER).some((row) => row.id === event.id), false);
  assert.equal(
    listRsvpsForEvent(event.id).some((row) => row.phone === GUEST_A && row.status === 'yes'),
    true,
  );
  assert.equal(
    listInvitationsForEvent(event.id).some((row) => row.id === individual.id),
    true,
  );

  await handleCustomerCommand(ctx(OWNER, 'MY_EVENTS'));
  assert.doesNotMatch(lastMessage().message, /📅 Katha\n/);
});

test('deleted event cannot invite, remind, update, or accept new RSVPs', async () => {
  const event = createEvent('Soon Gone', EVENT_DATE, 'Hall', OWNER, {
    rsvpDeadline: 'October 1, 2026 at 12:00 PM',
    reminderDays: 1,
  });
  createInvitation({ eventId: event.id, type: 'individual' });
  addGuests(event.id, [GUEST_A]);
  upsertMessageSession(OWNER, `conv-${OWNER}`, 'acct-update');
  upsertRsvp(event.id, GUEST_A, 'pending', 0, '', 0, 0);
  assert.ok(listEventsWithReminderConfigured().some((row) => row.id === event.id));

  deleteEvent(event.id);
  assert.equal(listEventsWithReminderConfigured().some((row) => row.id === event.id), false);

  await handleInviteCommand(
    tap(OWNER, `${START_INVITE} ${event.id}`),
    `${START_INVITE} ${event.id}`,
  );
  assert.match(lastMessage().message, /deleted/);
  assert.doesNotMatch(lastMessage().message, /Who would you like to invite/);

  await handleEventUpdateCommand(
    tap(OWNER, `${SEND_UPDATE} ${event.id}`),
    `${SEND_UPDATE} ${event.id}`,
  );
  assert.match(lastMessage().message, /wasn't found|don't have access|deleted/i);
  assert.equal(guestNotices.length, 0);

  await withShortRsvpServer(async (baseUrl) => {
    const url = `${baseUrl}/r/${event.short_code}`;
    const getRes = await fetch(url, { redirect: 'manual' });
    assert.equal(getRes.status, 404);
    const getBody = await getRes.text();
    assert.match(getBody, /isn.t available/i);
    assert.doesNotMatch(getBody, /Soon Gone/);
    assert.doesNotMatch(getBody, /Will you be attending/);

    const postRes = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        response: 'yes',
        name: 'New Guest',
        adults: '1',
        children: '0',
      }),
      redirect: 'manual',
    });
    assert.equal(postRes.status, 404);
  });

  assert.equal(
    listRsvpsForEvent(event.id).some((row) => row.status === 'yes'),
    false,
  );
});

test('another organizer and stale delete payloads cannot delete the event', async () => {
  const { event } = seedEvent();
  const other = createEvent('Other Night', EVENT_DATE, 'Other Hall', OWNER);
  addGuests(other.id, [GUEST_A]);
  const stranger = '+15551118888';

  await handleEventUpdateCommand(
    tap(stranger, `${DELETE_EVENT} ${event.id}`),
    `${DELETE_EVENT} ${event.id}`,
  );
  assert.equal(isEventDeleted(getEventById(event.id)), false);
  assert.match(lastMessage().message, /wasn't found|don't have access/i);

  await handleEventUpdateCommand(
    tap(OWNER, `${DELETE_EVENT} ${event.id}`),
    `${DELETE_EVENT} ${event.id}`,
  );
  await handleEventUpdateCommand(
    tap(OWNER, `${CONFIRM_DELETE_EVENT} ${other.id}`),
    `${CONFIRM_DELETE_EVENT} ${other.id}`,
  );
  assert.equal(isEventDeleted(getEventById(event.id)), false);
  assert.equal(isEventDeleted(getEventById(other.id)), false);
  assert.match(lastMessage().message, /no longer active/);

  clearConversationState(OWNER);
  await handleEventUpdateCommand(
    tap(OWNER, `${CONFIRM_DELETE_EVENT} ${event.id}`),
    `${CONFIRM_DELETE_EVENT} ${event.id}`,
  );
  assert.equal(isEventDeleted(getEventById(event.id)), false);
  assert.match(lastMessage().message, /no longer active/);
  assert.equal(guestNotices.length, 0);
});

test('Cancel Event remains separate from Delete Event', async () => {
  const { event } = seedEvent();
  await handleEventUpdateCommand(
    tap(OWNER, `${VOID_EVENT} ${event.id}`),
    `${VOID_EVENT} ${event.id}`,
  );
  assert.match(lastMessage().message, /Cancel Event\?/);
  assert.doesNotMatch(lastMessage().message, /Delete Event\?/);
  assert.ok(
    lastMessage().buttons?.some((button) =>
      button.payload === `${CONFIRM_VOID_EVENT} ${event.id}`,
    ),
  );
  assert.ok(
    !lastMessage().buttons?.some((button) =>
      button.payload.startsWith(CONFIRM_DELETE_EVENT) ||
      button.payload.startsWith(DELETE_EVENT),
    ),
  );
  assert.equal(isEventCancelled(getEventById(event.id)), false);
  assert.equal(isEventDeleted(getEventById(event.id)), false);
});
