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
  findInvitationByRsvpCode,
  getConversationState,
  getDb,
  getGuest,
  listInvitationsForEvent,
  listInvitationsWithMembers,
  lookupRsvpLinkTarget,
  lookupShortRsvpTarget,
  setConversationState,
  upsertRsvp,
} from '../src/db/store.js';
import {
  formatShareRsvpInvitation,
  INVITATION_FORWARD_INSTRUCTION,
  sendInvitationWithForwardInstruction,
} from '../src/commands/welcome.js';
import {
  familyLimitExceededMessage,
  formatInviteTypePrompt,
  inviteTypeButtons,
  parseFamilyLimitPayload,
  afterInviteButtons,
  afterDoneSendingButtons,
  AFTER_INVITE_SENT_MESSAGE,
  DONE_SENDING_MESSAGE,
  handleInviteCommand,
  setInviteMessageSender,
} from '../src/commands/inviteFlow.js';
import { formatInvitationGroups } from '../src/commands/organizer.js';
import { parseRsvpLinkToken } from '../src/rsvp/parser.js';
import { buildShortRsvpUrl } from '../src/config.js';
import type { CommandContext } from '../src/commands/organizer.js';
import type { SendMessageParams } from '../src/zernio/client.js';

process.env.DATABASE_PATH = ':memory:';

test('individual invitation uses the event RSVP code, not a unique token', () => {
  getDb();
  const event = createEvent('Wedding', 'June 15', 'Hall', '+15551111111');
  const invitation = createInvitation({ eventId: event.id, type: 'individual' });

  assert.equal(invitation.type, 'individual');
  assert.equal(invitation.rsvp_code, null);
  assert.equal(invitation.family_name, null);
  assert.equal(invitation.max_guests, null);

  const link = buildShortRsvpUrl(event.short_code ?? '');
  const message = formatShareRsvpInvitation(event, link);
  assert.equal(lookupRsvpLinkTarget(event.rsvp_code)?.invitation?.id, invitation.id);
  assert.equal(
    lookupShortRsvpTarget(event.short_code ?? '')?.invitation?.id,
    invitation.id,
  );
  assert.match(message, new RegExp(event.short_code ?? 'MISSING'));
  assert.match(message, /https:\/\/connect\.zip-bite\.com\/r\//);
  assert.doesNotMatch(message, /wa\.me/);
  assert.doesNotMatch(message, /Your invitation is ready/);
  assert.doesNotMatch(message, /Forward the message above/);

  closeDb();
});

test('family invitation stores a unique RSVP code and max guest limit', () => {
  getDb();
  const event = createEvent('Wedding', 'June 15', 'Hall', '+15551111111');
  const family = createFamilyInvitation(event.id, 'Patel Family', 3);

  assert.equal(family.type, 'family');
  assert.equal(family.family_name, 'Patel Family');
  assert.equal(family.max_guests, 3);
  assert.ok(family.rsvp_code);
  assert.match(family.rsvp_code, /^[0-9A-HJKMNP-TV-Z]{8}$/);
  assert.ok(family.short_code);
  assert.match(family.short_code, /^[0-9A-HJKMNP-TV-Z]{8}$/);
  assert.notEqual(family.rsvp_code, event.rsvp_code);
  assert.notEqual(family.short_code, event.short_code);
  assert.equal(findInvitationByRsvpCode(family.rsvp_code)?.id, family.id);
  assert.equal(findEventByRsvpCode(event.rsvp_code)?.id, event.id);

  const target = lookupRsvpLinkTarget(family.rsvp_code);
  assert.ok(target);
  assert.equal(target.event.id, event.id);
  assert.equal(target.invitation?.id, family.id);

  closeDb();
});

test('family RSVP within the guest limit is allowed', () => {
  getDb();
  const event = createEvent('Wedding', 'June 15', 'Hall', '+15551111111');
  const family = createFamilyInvitation(event.id, 'Patel Family', 3);
  addGuests(event.id, ['+15552222222'], family.id);

  assert.equal(checkFamilyRsvpLimit(family, 2, 1).allowed, true);
  upsertRsvp(event.id, '+15552222222', 'yes', 3, 'yes', 2, 1);
  assert.equal(getGuest(event.id, '+15552222222')?.invitation_id, family.id);

  closeDb();
});

test('family RSVP exceeding the guest limit is rejected', () => {
  getDb();
  const event = createEvent('Wedding', 'June 15', 'Hall', '+15551111111');
  const family = createFamilyInvitation(event.id, 'Patel Family', 3);

  const over = checkFamilyRsvpLimit(family, 3, 1);
  assert.equal(over.allowed, false);
  if (!over.allowed) {
    assert.equal(over.maxGuests, 3);
  }
  assert.equal(
    familyLimitExceededMessage(3),
    'This invitation allows up to 3 guests. Please try a smaller number.',
  );

  closeDb();
});

test('group invitation stores named members without a shared RSVP link', () => {
  getDb();
  const event = createEvent('Wedding', 'June 15', 'Hall', '+15551111111');
  const group = createInvitation({
    eventId: event.id,
    type: 'group',
    groupName: 'College Friends',
  });
  addInvitationMember(group.id, 'Mike');
  addInvitationMember(group.id, 'David');
  addInvitationMember(group.id, 'Sarah');

  assert.equal(group.rsvp_code, null);
  assert.equal(group.max_guests, null);

  const withMembers = listInvitationsWithMembers(event.id);
  const stored = withMembers.find((row) => row.id === group.id);
  assert.ok(stored);
  assert.deepEqual(
    stored.members.map((member) => member.member_name),
    ['Mike', 'David', 'Sarah'],
  );

  closeDb();
});

test('one event can mix individual, family, and group invitations', () => {
  getDb();
  const event = createEvent('Wedding', 'June 15', 'Hall', '+15551111111');
  createInvitation({ eventId: event.id, type: 'individual' });
  createFamilyInvitation(event.id, 'Patel Family', 3);
  createFamilyInvitation(event.id, 'Shah Family', 4);
  const group = createInvitation({
    eventId: event.id,
    type: 'group',
    groupName: 'College Friends',
  });
  addInvitationMember(group.id, 'Mike');
  addInvitationMember(group.id, 'David');
  addInvitationMember(group.id, 'Sarah');

  const invitations = listInvitationsWithMembers(event.id);
  assert.equal(invitations.filter((row) => row.type === 'individual').length, 1);
  assert.equal(invitations.filter((row) => row.type === 'family').length, 2);
  assert.equal(invitations.filter((row) => row.type === 'group').length, 1);

  const grouped = formatInvitationGroups(invitations).join('\n');
  assert.match(grouped, /Individual/);
  assert.match(grouped, /Patel Family — max 3/);
  assert.match(grouped, /Shah Family — max 4/);
  assert.match(grouped, /College Friends/);
  assert.match(grouped, /Mike/);
  assert.match(grouped, /David/);
  assert.match(grouped, /Sarah/);

  closeDb();
});

test('existing event RSVP links still resolve after invitation tables exist', () => {
  getDb();
  const event = createEvent('Picnic', 'July 4', 'Park', '+15551111111');
  const byCode = lookupRsvpLinkTarget(event.rsvp_code);
  const byToken = lookupRsvpLinkTarget(event.rsvp_token);

  assert.ok(byCode);
  assert.equal(byCode.event.id, event.id);
  assert.equal(byCode.invitation, null);
  assert.ok(byToken);
  assert.equal(byToken.event.id, event.id);
  assert.equal(findEventByRsvpCode(event.rsvp_code)?.id, event.id);

  const prefill = `Hi! I received an invitation. Please show me how to respond. Code: ${event.rsvp_code}`;
  assert.equal(parseRsvpLinkToken(prefill), event.rsvp_code);

  closeDb();
});

test('family invitation message uses the family token and omits organizer instruction', () => {
  getDb();
  const event = createEvent('Wedding', 'June 15', 'Hall', '+15551111111');
  const family = createFamilyInvitation(event.id, 'Patel Family', 3);
  const link = buildShortRsvpUrl(family.short_code ?? '');
  const invitation = formatShareRsvpInvitation(
    event,
    link,
    family.rsvp_code ?? event.rsvp_code,
  );

  assert.match(invitation, new RegExp(family.short_code ?? 'MISSING'));
  assert.match(invitation, /https:\/\/connect\.zip-bite\.com\/r\//);
  assert.doesNotMatch(invitation, /wa\.me/);
  assert.doesNotMatch(invitation, new RegExp(event.short_code ?? 'MISSING'));
  assert.doesNotMatch(invitation, /Your invitation is ready/);
  assert.doesNotMatch(invitation, /Forward the message above/);
  assert.equal(
    parseRsvpLinkToken(
      `Hi! I received an invitation. Please show me how to respond. Code: ${family.rsvp_code}`,
    ),
    family.rsvp_code,
  );

  closeDb();
});

test('organizer gets a concise forwarding instruction after the invitation', async () => {
  const event = {
    id: 1,
    name: 'Wedding',
    date: 'June 15',
    location: 'Hall',
    organizer_phone: '+15551111111',
    rsvp_token: 'token',
    rsvp_code: 'ABC12XY3',
    invitation_count: null,
    rsvp_deadline: null,
    children_allowed: 1,
    reminder_days: null,
    reminder_sent_at: null,
    created_at: '',
  };
  const invitation = formatShareRsvpInvitation(event, null);
  const sent: string[] = [];
  await sendInvitationWithForwardInstruction(async (message) => {
    sent.push(message);
  }, invitation);

  assert.equal(sent.length, 2);
  assert.equal(sent[0], invitation);
  assert.equal(sent[1], INVITATION_FORWARD_INSTRUCTION);
  assert.doesNotMatch(sent[0], /Your invitation is ready/);
});

test('invite type prompt and family limit payloads stay interactive', () => {
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
  assert.deepEqual(inviteTypeButtons(9), [
    { title: 'Individual', payload: 'INVITE_INDIVIDUAL 9' },
    { title: 'Family', payload: 'INVITE_FAMILY 9' },
  ]);
  assert.deepEqual(parseFamilyLimitPayload('FAMILY_LIMIT_3_9'), {
    maxGuests: 3,
    eventId: 9,
  });
  assert.equal(parseFamilyLimitPayload('not-a-limit'), null);
});

test('after a successful invite the organizer is asked to invite more or finish', () => {
  assert.equal(
    AFTER_INVITE_SENT_MESSAGE,
    'Forward the invitation above to your guests. Invite more, or tap Done.',
  );
  assert.deepEqual(afterInviteButtons(9), [
    { title: '➕ Invite More', payload: 'INVITE_MORE 9' },
    { title: '✅ Done Sending', payload: 'DONE_SENDING 9' },
  ]);
  assert.equal(
    afterInviteButtons(9).every((button) => button.title.length <= 20),
    true,
  );
  assert.doesNotMatch(AFTER_INVITE_SENT_MESSAGE, /Exit/);
  assert.equal(
    DONE_SENDING_MESSAGE,
    '✅ All set!\n\nYour invitations have been sent.\n\nYou can manage your event anytime from My Events.',
  );
  assert.deepEqual(afterDoneSendingButtons(9), [
    { title: '📊 View RSVPs', payload: 'VIEW_RSVPS 9' },
    { title: '🏠 Main Menu', payload: 'HOME' },
  ]);
  assert.equal(
    afterDoneSendingButtons(9).every((button) => button.title.length <= 20),
    true,
  );
  assert.doesNotMatch(DONE_SENDING_MESSAGE, /Exit/);
});

test('Invite More reopens the type picker and Done Sending clears wizard state', async () => {
  getDb();
  const sent: SendMessageParams[] = [];
  setInviteMessageSender(async (params) => {
    sent.push(params);
  });
  const owner = '+15551111111';
  const event = createEvent('Wedding', 'June 15', 'Hall', owner);
  const ctx = (text: string): CommandContext => ({
    phone: owner,
    text,
    conversationId: 'conv-invite',
    accountId: 'acct-invite',
  });

  try {
    await handleInviteCommand(ctx(`INVITE_INDIVIDUAL ${event.id}`), `INVITE_INDIVIDUAL ${event.id}`);
    assert.equal(sent.length, 2);
    assert.match(sent[0].message, /You're Invited/);
    const afterSend = sent.at(-1);
    assert.ok(afterSend);
    assert.equal(afterSend.message, AFTER_INVITE_SENT_MESSAGE);
    assert.deepEqual(afterSend.buttons, afterInviteButtons(event.id));
    assert.equal(getConversationState(owner), undefined);
    assert.equal(
      listInvitationsForEvent(event.id).filter((row) => row.type === 'individual')
        .length,
      1,
    );

    sent.length = 0;
    await handleInviteCommand(
      ctx(`INVITE_INDIVIDUAL ${event.id}`),
      `INVITE_INDIVIDUAL ${event.id}`,
    );
    assert.equal(
      listInvitationsForEvent(event.id).filter((row) => row.type === 'individual')
        .length,
      1,
    );
    assert.equal(sent.length, 1);
    assert.match(sent[0].message, /same Individual invitation link/);
    assert.doesNotMatch(sent[0].message, /You're Invited/);
    assert.deepEqual(sent[0].buttons, afterInviteButtons(event.id));

    sent.length = 0;
    await handleInviteCommand(ctx(`INVITE_MORE ${event.id}`), `INVITE_MORE ${event.id}`);
    const more = sent.at(-1);
    assert.ok(more);
    assert.equal(more.message, formatInviteTypePrompt(event.name));
    assert.deepEqual(more.buttons, inviteTypeButtons(event.id));

    sent.length = 0;
    setConversationState(owner, 'WAITING_FOR_FAMILY_NAME', {
      event_id: event.id,
      invite_type: 'family',
    });
    await handleInviteCommand(ctx(`DONE_SENDING ${event.id}`), `DONE_SENDING ${event.id}`);
    assert.equal(getConversationState(owner), undefined);
    const done = sent.at(-1);
    assert.ok(done);
    assert.equal(done.message, DONE_SENDING_MESSAGE);
    assert.deepEqual(done.buttons, afterDoneSendingButtons(event.id));
    assert.doesNotMatch(done.message, /Would you like to invite anyone else/);
    assert.doesNotMatch(done.message, /Exit/);
  } finally {
    setInviteMessageSender();
    closeDb();
  }
});
