import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildWelcomeMessage,
  formatShareRsvpInvitation,
  getFirstNameFromDisplayName,
  INVITATION_FORWARD_INSTRUCTION,
  isGreeting,
  sendInvitationWithForwardInstruction,
} from '../src/commands/welcome.js';
import type { Event } from '../src/db/store.js';

test('isGreeting recognizes common greetings', () => {
  assert.equal(isGreeting('hi'), true);
  assert.equal(isGreeting('Hello'), true);
  assert.equal(isGreeting('  hey  '), true);
  assert.equal(isGreeting('START'), true);
  assert.equal(isGreeting('good morning'), true);
  assert.equal(isGreeting('Good Evening'), true);
  assert.equal(isGreeting('help'), false);
  assert.equal(isGreeting('Patel Family'), false);
  assert.equal(isGreeting('4'), false);
});

test('getFirstNameFromDisplayName uses first whitespace token', () => {
  assert.equal(getFirstNameFromDisplayName('John Smith'), 'John');
  assert.equal(getFirstNameFromDisplayName('  Jane   Doe  '), 'Jane');
  assert.equal(getFirstNameFromDisplayName(undefined), undefined);
  assert.equal(getFirstNameFromDisplayName('   '), undefined);
});

test('buildWelcomeMessage uses the ZipNest umbrella menu', () => {
  const message = buildWelcomeMessage('John Smith');

  assert.equal(
    message,
    `Welcome to ZipNest! 👋
Your local life, simplified.

🎉 ZipEvents

🍴 ZipBite — Coming Soon

Provider`,
  );
  assert.doesNotMatch(message, /ZipShip|ZipFix|ZipRitual|ZipTable/);
});

test('buildWelcomeMessage is the same when sender name is missing', () => {
  const message = buildWelcomeMessage(undefined);

  assert.match(message, /^Welcome to ZipNest! 👋/);
  assert.doesNotMatch(message, /Welcome to ZipNest,/);
});

const SAMPLE_EVENT: Event = {
  id: 1,
  name: 'Summer BBQ',
  date: 'July 4',
  location: 'Park',
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

test('formatShareRsvpInvitation keeps existing wording and omits forward instruction', () => {
  const link =
    'https://wa.me/15551234567?text=Hi!%20I%20received%20an%20invitation.%20Please%20show%20me%20how%20to%20respond.%20Code%3A%20ABC12XY3';
  const invitation = formatShareRsvpInvitation(SAMPLE_EVENT, link);

  assert.equal(
    invitation,
    [
      "🎉 You're Invited!",
      '',
      'Summer BBQ',
      '',
      '📅 July 4',
      '🌎 Eastern Time',
      '📍 Park',
      '',
      '💌 Please RSVP here:',
      link,
      '',
      "We'd love to have you join us!",
    ].join('\n'),
  );
  assert.doesNotMatch(invitation, /Your invitation is ready/);
  assert.doesNotMatch(invitation, /Forward the message above/);
});

test('INVITATION_FORWARD_INSTRUCTION is a concise organizer-only instruction', () => {
  assert.equal(
    INVITATION_FORWARD_INSTRUCTION,
    'Forward the invitation above to your guests. Invite more, or tap Done.',
  );
});

test('sendInvitationWithForwardInstruction sends invitation then exact instruction', async () => {
  const invitation = formatShareRsvpInvitation(SAMPLE_EVENT, null);
  const sent: string[] = [];

  await sendInvitationWithForwardInstruction(async (message) => {
    sent.push(message);
  }, invitation);

  assert.equal(sent.length, 2);
  assert.equal(sent[0], invitation);
  assert.equal(sent[1], INVITATION_FORWARD_INSTRUCTION);
  assert.doesNotMatch(sent[0], /Your invitation is ready/);
});

test('sendInvitationWithForwardInstruction does not throw when instruction send fails', async () => {
  const invitation = formatShareRsvpInvitation(SAMPLE_EVENT, null);
  const sent: string[] = [];

  await sendInvitationWithForwardInstruction(async (message) => {
    sent.push(message);
    if (sent.length === 2) {
      throw new Error('instruction send failed');
    }
  }, invitation);

  assert.equal(sent.length, 2);
  assert.equal(sent[0], invitation);
  assert.equal(sent[1], INVITATION_FORWARD_INSTRUCTION);
});
