import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addGuests,
  closeDb,
  createEvent,
  getDb,
  getMessageSession,
  setGuestName,
  upsertMessageSession,
} from '../src/db/store.js';
import {
  formatOrganizerRsvpNotification,
  resolveGuestDisplayName,
} from '../src/rsvp/organizerNotify.js';

process.env.DATABASE_PATH = ':memory:';

test('formatOrganizerRsvpNotification yes response', () => {
  const message = formatOrganizerRsvpNotification(
    'Summer BBQ',
    'Jane Doe',
    'yes',
    2,
    1,
    3,
  );

  assert.match(message, /🔔 New RSVP received!/);
  assert.match(message, /Summer BBQ/);
  assert.match(message, /👤 Jane Doe/);
  assert.match(message, /✅ Yes/);
  assert.match(message, /👨 Adults: 2/);
  assert.match(message, /👧 Children: 1/);
  assert.match(message, /Total attending: 3/);
});

test('formatOrganizerRsvpNotification no response', () => {
  const message = formatOrganizerRsvpNotification(
    'Summer BBQ',
    '+1 555 222 2222',
    'no',
    0,
    0,
    0,
  );

  assert.match(message, /🔔 RSVP Update/);
  assert.match(message, /❌ No/);
  assert.doesNotMatch(message, /Adults:/);
});

test('formatOrganizerRsvpNotification maybe response', () => {
  const message = formatOrganizerRsvpNotification(
    'Summer BBQ',
    'Alex',
    'maybe',
    0,
    0,
    0,
  );

  assert.match(message, /🔔 RSVP Update/);
  assert.match(message, /🤔 Maybe/);
});

test('message_sessions upsert and lookup', () => {
  getDb();
  upsertMessageSession('+15551111111', 'conv-abc', 'acct-123');
  upsertMessageSession('+15551111111', 'conv-def', 'acct-456');

  const session = getMessageSession('+15551111111');
  assert.equal(session?.conversation_id, 'conv-def');
  assert.equal(session?.account_id, 'acct-456');

  closeDb();
});

test('resolveGuestDisplayName prefers stored name then sender then phone', () => {
  getDb();
  const event = createEvent('Party', 'July 4', 'Park', '+15551111111');
  addGuests(event.id, ['+15552222222']);

  assert.equal(
    resolveGuestDisplayName(event.id, '+15552222222', 'Push Name'),
    'Push Name',
  );

  setGuestName(event.id, '+15552222222', 'Stored Name');
  assert.equal(
    resolveGuestDisplayName(event.id, '+15552222222', 'Push Name'),
    'Stored Name',
  );

  assert.equal(
    resolveGuestDisplayName(event.id, '+15553333333', undefined),
    '+1 555 333 3333',
  );

  addGuests(event.id, ['web:550e8400-e29b-41d4-a716-446655440000']);
  assert.equal(
    resolveGuestDisplayName(
      event.id,
      'web:550e8400-e29b-41d4-a716-446655440000',
      undefined,
    ),
    'Guest',
  );
  setGuestName(event.id, 'web:550e8400-e29b-41d4-a716-446655440000', 'Maya Singh');
  assert.equal(
    resolveGuestDisplayName(
      event.id,
      'web:550e8400-e29b-41d4-a716-446655440000',
      undefined,
    ),
    'Maya Singh',
  );

  closeDb();
});
