import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addGuests,
  addInvitationMember,
  checkFamilyRsvpLimit,
  closeDb,
  createEvent,
  createFamilyInvitation,
  createInvitation,
  findEventByRsvpCode,
  getDb,
  getEventById,
  getGuest,
  listEventsForOrganizer,
  listEventsPendingOrganizerPostEvent,
  listInvitationsWithMembers,
  lookupRsvpLinkTarget,
  markGuestThankYouSent,
  markOrganizerPostEventSent,
  upsertRsvp,
} from '../src/db/store.js';
import {
  formatInviteTypePrompt,
  inviteTypeButtons,
} from '../src/commands/inviteFlow.js';
import {
  MANAGE_EVENT,
  MORE_EVENT,
  buildManageEventMoreReply,
  buildManageEventReply,
  formatEventInviteCard,
  getEventInviteStats,
} from '../src/commands/welcome.js';
import { VIEW_RSVPS } from '../src/commands/organizer.js';
import {
  GUEST_RSVP_THANK_YOU,
  ORGANIZER_POST_EVENT_MESSAGE,
  handleSaveConnectContact,
  sendSaveConnectContactWaMeFallback,
  sendSaveContactPrompt,
} from '../src/commands/saveContact.js';
import { INVITATION_FORWARD_INSTRUCTION } from '../src/commands/invitationMessage.js';
import { isCalendarDayAfterEvent } from '../src/dates/eventDate.js';
import {
  runOrganizerPostEventTick,
  shouldSendOrganizerPostEvent,
} from '../src/reminders/scheduler.js';

process.env.DATABASE_PATH = ':memory:';

const OWNER = '+15551111111';
const GUEST = '+15552222222';
const TZ = 'America/New_York';
const EVENT_DATE = 'Sunday, September 20, 2026 at 7:30 PM';

test('1. organizer invite prompt shows only Individual and Family', () => {
  const prompt = formatInviteTypePrompt('Wedding');
  assert.equal(
    prompt,
    [
      'Who would you like to invite?',
      '',
      '👤 Individual',
      'One reusable invitation link for your guests.',
      'Forward the same link to each person.',
      'Each person enters their own name and RSVP.',
      '',
      '👨‍👩‍👧‍👦 Family',
      'One invitation link for one family.',
      'Set the maximum number of guests who can attend.',
    ].join('\n'),
  );
  assert.doesNotMatch(prompt, /Group/);
  assert.doesNotMatch(prompt, /Organize multiple/);
});

test('2. invite type buttons omit Group from the active flow', () => {
  const buttons = inviteTypeButtons(42);
  assert.deepEqual(
    buttons.map((button) => button.title),
    ['Individual', 'Family'],
  );
  assert.equal(
    buttons.some((button) => button.payload.includes('INVITE_GROUP')),
    false,
  );
});

test('3. Individual invitation forwards the existing event RSVP code', () => {
  getDb();
  const event = createEvent('Wedding', EVENT_DATE, 'Hall', OWNER);
  const invitation = createInvitation({ eventId: event.id, type: 'individual' });

  assert.equal(invitation.type, 'individual');
  assert.equal(invitation.rsvp_code, null);
  assert.equal(invitation.rsvp_code ?? event.rsvp_code, event.rsvp_code);
  assert.equal(lookupRsvpLinkTarget(event.rsvp_code)?.event.id, event.id);

  closeDb();
});

test('4. Individual invitation has no phone-entry or contact-selection fields', () => {
  getDb();
  const event = createEvent('Wedding', EVENT_DATE, 'Hall', OWNER);
  const invitation = createInvitation({ eventId: event.id, type: 'individual' });

  assert.equal(invitation.family_name, null);
  assert.equal(invitation.group_name, null);
  assert.equal(invitation.max_guests, null);
  assert.doesNotMatch(INVITATION_FORWARD_INSTRUCTION, /phone/i);
  assert.doesNotMatch(INVITATION_FORWARD_INSTRUCTION, /contact/i);

  closeDb();
});

test('5. Family invitation stores name, max guests, and a unique token', () => {
  getDb();
  const event = createEvent('Wedding', EVENT_DATE, 'Hall', OWNER);
  const family = createFamilyInvitation(event.id, 'Patel Family', 4);

  assert.equal(family.type, 'family');
  assert.equal(family.family_name, 'Patel Family');
  assert.equal(family.max_guests, 4);
  assert.ok(family.rsvp_code);
  assert.notEqual(family.rsvp_code, event.rsvp_code);
  assert.equal(lookupRsvpLinkTarget(family.rsvp_code ?? '')?.invitation?.id, family.id);

  closeDb();
});

test('6. Family RSVP within the guest limit is allowed', () => {
  getDb();
  const event = createEvent('Wedding', EVENT_DATE, 'Hall', OWNER);
  const family = createFamilyInvitation(event.id, 'Patel Family', 3);
  assert.equal(checkFamilyRsvpLimit(family, 2, 1).allowed, true);

  closeDb();
});

test('7. Family RSVP over the guest limit is rejected', () => {
  getDb();
  const event = createEvent('Wedding', EVENT_DATE, 'Hall', OWNER);
  const family = createFamilyInvitation(event.id, 'Patel Family', 3);
  const over = checkFamilyRsvpLimit(family, 3, 1);
  assert.equal(over.allowed, false);
  if (!over.allowed) {
    assert.equal(over.maxGuests, 3);
  }

  closeDb();
});

test('8. existing Group invitation rows stay readable', () => {
  getDb();
  const event = createEvent('Wedding', EVENT_DATE, 'Hall', OWNER);
  const group = createInvitation({
    eventId: event.id,
    type: 'group',
    groupName: 'College Friends',
  });
  addInvitationMember(group.id, 'Mike');

  const stored = listInvitationsWithMembers(event.id).find((row) => row.id === group.id);
  assert.ok(stored);
  assert.equal(stored.type, 'group');
  assert.equal(stored.group_name, 'College Friends');
  assert.deepEqual(
    stored.members.map((member) => member.member_name),
    ['Mike'],
  );

  closeDb();
});

test('9. mixed Individual, Family, and existing Group records keep working', () => {
  getDb();
  const event = createEvent('Wedding', EVENT_DATE, 'Hall', OWNER);
  createInvitation({ eventId: event.id, type: 'individual' });
  createFamilyInvitation(event.id, 'Shah Family', 4);
  createInvitation({
    eventId: event.id,
    type: 'group',
    groupName: 'College Friends',
  });

  const invitations = listInvitationsWithMembers(event.id);
  assert.equal(invitations.filter((row) => row.type === 'individual').length, 1);
  assert.equal(invitations.filter((row) => row.type === 'family').length, 1);
  assert.equal(invitations.filter((row) => row.type === 'group').length, 1);

  closeDb();
});

test('10. existing event RSVP links still resolve', () => {
  getDb();
  const event = createEvent('Picnic', EVENT_DATE, 'Park', OWNER);
  const byCode = lookupRsvpLinkTarget(event.rsvp_code);
  assert.ok(byCode);
  assert.equal(byCode.invitation, null);
  assert.equal(findEventByRsvpCode(event.rsvp_code)?.id, event.id);

  closeDb();
});

test('11. Family invitation uses its own token, not the event code', () => {
  getDb();
  const event = createEvent('Wedding', EVENT_DATE, 'Hall', OWNER);
  const family = createFamilyInvitation(event.id, 'Patel Family', 3);
  const target = lookupRsvpLinkTarget(family.rsvp_code ?? '');
  assert.ok(target);
  assert.equal(target.event.id, event.id);
  assert.equal(target.invitation?.id, family.id);
  assert.notEqual(family.rsvp_code, event.rsvp_code);

  closeDb();
});

test('12. organizer invitation remains forwarding-based', () => {
  assert.equal(
    INVITATION_FORWARD_INSTRUCTION,
    'Forward the invitation above to your guests. Invite more, or tap Done.',
  );
});

test('13. contact card helpers send nothing', async () => {
  const ctx = { conversationId: 'conv', accountId: 'acct' };
  await assert.doesNotReject(() => sendSaveContactPrompt(ctx));
  await assert.doesNotReject(() => handleSaveConnectContact(ctx));
  await assert.doesNotReject(() => sendSaveConnectContactWaMeFallback(ctx));
});

test('14. create/invite/manage copy does not include a save-number prompt', () => {
  getDb();
  const event = createEvent('Gala', EVENT_DATE, 'Hotel', OWNER);
  const card = formatEventInviteCard(event);
  const manage = buildManageEventReply(event);
  assert.doesNotMatch(card, /save our number/i);
  assert.doesNotMatch(card, /contact card/i);
  assert.doesNotMatch(manage.message, /Thank you for using CONNECT/);
  assert.doesNotMatch(INVITATION_FORWARD_INSTRUCTION, /save our number/i);

  closeDb();
});

test('15. guest thank-you copy is exact', () => {
  assert.equal(
    GUEST_RSVP_THANK_YOU,
    `✅ Thank you! Your RSVP has been recorded.

Please save our number to your contacts so you can easily find CONNECT when you need it.

Powered by zipbite`,
  );
});

test('16. invitation received does not mark a guest thank-you', () => {
  getDb();
  const event = createEvent('Wedding', EVENT_DATE, 'Hall', OWNER);
  addGuests(event.id, [GUEST]);
  const guest = getGuest(event.id, GUEST);
  assert.ok(guest);
  assert.equal(guest.thank_you_sent_at ?? null, null);

  closeDb();
});

test('17. thank-you is claimed only after a guest row exists for a successful RSVP', () => {
  getDb();
  const event = createEvent('Wedding', EVENT_DATE, 'Hall', OWNER);
  assert.equal(markGuestThankYouSent(event.id, GUEST), false);

  addGuests(event.id, [GUEST]);
  upsertRsvp(event.id, GUEST, 'yes', 2, 'yes', 2, 0);
  assert.equal(markGuestThankYouSent(event.id, GUEST), true);
  assert.ok(getGuest(event.id, GUEST)?.thank_you_sent_at);

  closeDb();
});

test('18. RSVP edits do not claim a second thank-you', () => {
  getDb();
  const event = createEvent('Wedding', EVENT_DATE, 'Hall', OWNER);
  addGuests(event.id, [GUEST]);
  upsertRsvp(event.id, GUEST, 'yes', 1, 'yes', 1, 0);
  assert.equal(markGuestThankYouSent(event.id, GUEST), true);

  upsertRsvp(event.id, GUEST, 'no', 0, 'no', 0, 0);
  assert.equal(markGuestThankYouSent(event.id, GUEST), false);

  closeDb();
});

test('19. thank-you is not claimed when no RSVP guest exists (save never happened)', () => {
  getDb();
  const event = createEvent('Wedding', EVENT_DATE, 'Hall', OWNER);
  assert.equal(markGuestThankYouSent(event.id, GUEST), false);
  assert.equal(getGuest(event.id, GUEST), undefined);

  closeDb();
});

test('20. organizer post-event copy is exact', () => {
  assert.equal(
    ORGANIZER_POST_EVENT_MESSAGE,
    `🎉 Thank you for using CONNECT!

We hope your event was wonderful and memorable.

Keep our number saved for your next event.

Powered by zipbite`,
  );
});

test('21. post-event message is skipped before the event calendar day ends', () => {
  const event = {
    id: 1,
    name: 'Wedding',
    date: EVENT_DATE,
    location: 'Hall',
    organizer_phone: OWNER,
    rsvp_token: 'token',
    rsvp_code: 'ABC12XY3',
    invitation_count: null,
    rsvp_deadline: null,
    children_allowed: 1,
    reminder_days: null,
    reminder_sent_at: null,
    organizer_post_event_sent_at: null,
    created_at: '',
  };

  assert.equal(
    shouldSendOrganizerPostEvent(event, Date.parse('2026-09-20T23:30:00.000Z')),
    false,
  );
  assert.equal(
    isCalendarDayAfterEvent(EVENT_DATE, Date.parse('2026-09-20T23:30:00.000Z'), TZ),
    false,
  );
});

test('22. post-event message is not due at the last minute of the event day', () => {
  assert.equal(
    isCalendarDayAfterEvent(EVENT_DATE, Date.parse('2026-09-21T03:59:00.000Z'), TZ),
    false,
  );
});

test('23. post-event message is due on the calendar day after the event', () => {
  const event = {
    id: 1,
    name: 'Wedding',
    date: EVENT_DATE,
    location: 'Hall',
    organizer_phone: OWNER,
    rsvp_token: 'token',
    rsvp_code: 'ABC12XY3',
    invitation_count: null,
    rsvp_deadline: null,
    children_allowed: 1,
    reminder_days: null,
    reminder_sent_at: null,
    organizer_post_event_sent_at: null,
    created_at: '',
  };

  assert.equal(
    shouldSendOrganizerPostEvent(event, Date.parse('2026-09-21T04:05:00.000Z')),
    true,
  );
});

test('24. post-event message is skipped when already sent', () => {
  const event = {
    id: 1,
    name: 'Wedding',
    date: EVENT_DATE,
    location: 'Hall',
    organizer_phone: OWNER,
    rsvp_token: 'token',
    rsvp_code: 'ABC12XY3',
    invitation_count: null,
    rsvp_deadline: null,
    children_allowed: 1,
    reminder_days: null,
    reminder_sent_at: null,
    organizer_post_event_sent_at: '2026-09-21T12:00:00.000Z',
    created_at: '',
  };

  assert.equal(
    shouldSendOrganizerPostEvent(event, Date.parse('2026-09-22T16:00:00.000Z')),
    false,
  );
});

test('25. post-event timing is timezone-aware in EVENT_TIMEZONE', () => {
  // 11:30 PM PDT on Sept 20 is already Sept 21 in America/New_York
  assert.equal(
    isCalendarDayAfterEvent(EVENT_DATE, Date.parse('2026-09-21T06:30:00.000Z'), TZ),
    true,
  );
  assert.equal(
    isCalendarDayAfterEvent(
      EVENT_DATE,
      Date.parse('2026-09-21T06:30:00.000Z'),
      'America/Los_Angeles',
    ),
    false,
  );
});

test('26. My Events counts actual invitation records, not invitation_count', () => {
  getDb();
  const event = createEvent('Party', EVENT_DATE, 'Park', OWNER, {
    invitationCount: 50,
  });
  createInvitation({ eventId: event.id, type: 'individual' });
  createFamilyInvitation(event.id, 'Patel Family', 3);

  const stats = getEventInviteStats(event.id);
  assert.equal(stats.invitationsSent, 2);
  assert.match(formatEventInviteCard(event), /📩 Invitations sent: 2/);
  assert.doesNotMatch(formatEventInviteCard(event), /Invitations sent: 50/);
  assert.equal(listEventsForOrganizer(OWNER).length, 1);

  closeDb();
});

test('27. Manage Event keeps invite, RSVP, and details actions', () => {
  getDb();
  const event = createEvent('Gala', EVENT_DATE, 'Hotel', OWNER);
  const reply = buildManageEventReply(event);
  assert.deepEqual(reply.buttons, [
    { title: '📩 Invite', payload: `START_INVITE ${event.id}` },
    { title: '👥 RSVPs', payload: `${VIEW_RSVPS} ${event.id}` },
    { title: 'More…', payload: `${MORE_EVENT} ${event.id}` },
  ]);
  const more = buildManageEventMoreReply(event);
  assert.deepEqual(
    more.list?.sections[0].rows.map((row) => row.id),
    [
      `GUEST_LIST:${event.id}`,
      `EDIT_EVENT:${event.id}`,
      `SEND_UPDATE:${event.id}`,
      `VOID_EVENT:${event.id}`,
      `DELETE_EVENT:${event.id}`,
    ],
  );

  closeDb();
});

test('28. RSVP tracking still reports yes, no, maybe, and awaiting', () => {
  getDb();
  const event = createEvent('Picnic', EVENT_DATE, 'Lake', OWNER);
  createInvitation({ eventId: event.id, type: 'individual' });
  createInvitation({ eventId: event.id, type: 'individual' });
  createInvitation({ eventId: event.id, type: 'individual' });
  addGuests(event.id, ['+15553333333', '+15554444444', '+15555555555']);
  upsertRsvp(event.id, '+15553333333', 'yes', 2, 'yes', 1, 1);
  upsertRsvp(event.id, '+15554444444', 'no', 0, 'no', 0, 0);

  const stats = getEventInviteStats(event.id);
  assert.equal(stats.invitationsSent, 3);
  assert.equal(stats.yes, 1);
  assert.equal(stats.no, 1);
  assert.equal(stats.maybe, 0);
  assert.equal(stats.awaiting, 1);

  closeDb();
});

test('29. duplicate guest thank-you is prevented by thank_you_sent_at', () => {
  getDb();
  const event = createEvent('Wedding', EVENT_DATE, 'Hall', OWNER);
  addGuests(event.id, [GUEST]);
  assert.equal(markGuestThankYouSent(event.id, GUEST), true);
  assert.equal(markGuestThankYouSent(event.id, GUEST), false);
  assert.ok(getGuest(event.id, GUEST)?.thank_you_sent_at);

  closeDb();
});

test('30. duplicate organizer post-event is prevented and future events stay pending', async () => {
  getDb();
  const past = createEvent(
    'Past Party',
    'Friday, September 4, 2026 at 6:00 PM',
    'Hall',
    OWNER,
  );
  const future = createEvent('Future Party', EVENT_DATE, 'Hall', OWNER);

  const pending = listEventsPendingOrganizerPostEvent();
  assert.equal(pending.some((event) => event.id === past.id), true);
  assert.equal(pending.some((event) => event.id === future.id), true);

  assert.equal(markOrganizerPostEventSent(past.id), true);
  assert.equal(markOrganizerPostEventSent(past.id), false);
  assert.ok(getEventById(past.id)?.organizer_post_event_sent_at);

  await runOrganizerPostEventTick(Date.parse('2026-09-10T16:00:00.000Z'));
  assert.equal(getEventById(future.id)?.organizer_post_event_sent_at ?? null, null);

  closeDb();
});
