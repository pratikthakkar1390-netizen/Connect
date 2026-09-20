import test from 'node:test';
import assert from 'node:assert/strict';
import {
  closeDb,
  createEvent,
  getConversationState,
  getDb,
  getEventById,
  listEventUpdatesForEvent,
  setConversationState,
  updateEventDetails,
} from '../src/db/store.js';
import {
  ADD_DETAILS_PROMPT,
  CONFIRM_EVENT,
  continueCreateEventFlow,
  formatEventConfirmation,
  setCreateEventMessageSender,
} from '../src/commands/createEventFlow.js';
import {
  CHANGE_DRESS,
  CHANGE_LOCATION,
  CHANGE_THEME,
  continueEventUpdateFlow,
  EDIT_EVENT,
  handleEventUpdateCommand,
  setEventUpdateGuestSender,
  setEventUpdateMessageSender,
} from '../src/commands/eventUpdateFlow.js';
import {
  DRESS_CODE_BUTTONS,
  DRESS_ENTER,
  DRESS_SKIP,
  EVENT_THEME_OPTIONS,
  eventThemeChoiceList,
  parseThemeChoice,
  sanitizeCustomTheme,
  sanitizeDressCode,
  themeCssClass,
  themeLabel,
  THEME_PROMPT,
} from '../src/events/theme.js';
import { buildGoogleMapsSearchUrl } from '../src/maps/location.js';
import { formatShareRsvpInvitation } from '../src/commands/invitationMessage.js';
import { renderRsvpPage } from '../src/http/rsvpPage.js';
import type { CommandContext } from '../src/commands/organizer.js';
import type { SendMessageParams } from '../src/zernio/client.js';

process.env.DATABASE_PATH = ':memory:';

const PHONE = '+15551119999';
const ctx = {
  phone: PHONE,
  conversationId: 'conv-theme',
  accountId: 'acct-theme',
};

const sent: SendMessageParams[] = [];
const guestNotices: Array<{ phone: string }> = [];

function lastMessage(): SendMessageParams {
  const message = sent.at(-1);
  assert.ok(message, 'expected a reply');
  return message;
}

function command(text: string, extras: Partial<CommandContext> = {}): CommandContext {
  return {
    phone: PHONE,
    text,
    conversationId: ctx.conversationId,
    accountId: ctx.accountId,
    ...extras,
  };
}

function listTap(id: string, title: string): CommandContext {
  return command(title, {
    interactiveId: id,
    interactiveType: 'list_reply',
  });
}

test.beforeEach(() => {
  getDb();
  sent.length = 0;
  guestNotices.length = 0;
  delete process.env.GOOGLE_MAPS_API_KEY;
  setCreateEventMessageSender(async (params) => {
    sent.push(params);
  });
  setEventUpdateMessageSender(async (params) => {
    sent.push(params);
  });
  setEventUpdateGuestSender(async (params) => {
    guestNotices.push({ phone: params.phone });
  });
});

test.afterEach(() => {
  setCreateEventMessageSender();
  setEventUpdateMessageSender();
  setEventUpdateGuestSender();
  delete process.env.GOOGLE_MAPS_API_KEY;
  closeDb();
});

test('typed location saves a Maps search URL without an API key', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    fetchCalls += 1;
    return originalFetch(...args);
  }) as typeof fetch;

  try {
    setConversationState(PHONE, 'WAITING_FOR_EVENT_LOCATION', {
      name: 'Wedding',
      date: 'Sunday, September 20, 2026 at 7:30 PM',
    });

    await continueCreateEventFlow(ctx, 'Royal Albert Palace, Edison NJ');

    const state = getConversationState(PHONE);
    const mapsUrl =
      'https://www.google.com/maps/search/?api=1&query=Royal%20Albert%20Palace%2C%20Edison%20NJ';
    assert.equal(state?.state, 'WAITING_FOR_ADD_DETAILS');
    assert.equal(state?.location, 'Royal Albert Palace, Edison NJ');
    assert.equal(state?.location_place_id, null);
    assert.equal(state?.location_maps_url, mapsUrl);
    assert.equal(state?.location_maps_url, buildGoogleMapsSearchUrl('Royal Albert Palace, Edison NJ'));
    assert.equal(fetchCalls, 0);
    assert.equal(lastMessage().message, ADD_DETAILS_PROMPT);
    assert.deepEqual(
      lastMessage().buttons?.map((button) => button.title),
      ['Skip', 'Add'],
    );
    assert.doesNotMatch(JSON.stringify(lastMessage()), /GOOGLE_MAPS_API_KEY|AIza|\/place\//);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('spaces and punctuation are URL encoded in the Maps link', () => {
  assert.equal(
    buildGoogleMapsSearchUrl('Royal Albert Palace, Edison NJ'),
    'https://www.google.com/maps/search/?api=1&query=Royal%20Albert%20Palace%2C%20Edison%20NJ',
  );
  assert.equal(
    buildGoogleMapsSearchUrl('  123 Main St. #4  '),
    'https://www.google.com/maps/search/?api=1&query=123%20Main%20St.%20%234',
  );
});

test('predefined style saves and skip What to Wear leaves dress empty', async () => {
  setConversationState(PHONE, 'WAITING_FOR_EVENT_THEME', {
    name: 'Wedding',
    date: 'Sunday, September 20, 2026 at 7:30 PM',
    location: 'Hall',
  });

  await continueCreateEventFlow(listTap('floral', '🌸 Floral'), '🌸 Floral');
  assert.equal(getConversationState(PHONE)?.state, 'WAITING_FOR_DRESS_CODE');
  assert.equal(getConversationState(PHONE)?.theme, 'floral');
  assert.equal(getConversationState(PHONE)?.custom_theme, null);
  assert.equal(DRESS_CODE_BUTTONS[0]?.payload, DRESS_SKIP);
  assert.equal(DRESS_CODE_BUTTONS[1]?.payload, DRESS_ENTER);

  await continueCreateEventFlow(
    command('⏭️ Skip', {
      interactiveId: DRESS_SKIP,
      interactiveType: 'button_reply',
    }),
    '⏭️ Skip',
  );

  const state = getConversationState(PHONE);
  assert.equal(state?.state, 'WAITING_FOR_EVENT_IMAGE');
  assert.equal(state?.theme, 'floral');
  assert.equal(state?.dress_code, null);
  assert.match(lastMessage().message, /Event Image/);
});

test('custom theme and dress code are stored separately', async () => {
  setConversationState(PHONE, 'WAITING_FOR_EVENT_THEME', {
    name: 'Garden Party',
    date: 'Sunday, September 20, 2026 at 7:30 PM',
    location: 'Hall',
  });

  await continueCreateEventFlow(listTap('custom', '✏️ Custom'), '✏️ Custom');
  assert.equal(getConversationState(PHONE)?.state, 'WAITING_FOR_CUSTOM_THEME');

  await continueCreateEventFlow(ctx, 'Elegant blue and gold garden party');
  assert.equal(getConversationState(PHONE)?.theme, 'custom');
  assert.equal(
    getConversationState(PHONE)?.custom_theme,
    'Elegant blue and gold garden party',
  );

  await continueCreateEventFlow(
    command('✏️ Custom', {
      interactiveId: DRESS_ENTER,
      interactiveType: 'button_reply',
    }),
    '✏️ Custom',
  );
  await continueCreateEventFlow(ctx, 'Blue or white');

  const state = getConversationState(PHONE);
  assert.equal(state?.state, 'WAITING_FOR_EVENT_IMAGE');
  assert.equal(state?.theme, 'custom');
  assert.equal(state?.custom_theme, 'Elegant blue and gold garden party');
  assert.equal(state?.dress_code, 'Blue or white');
});

test('skip theme leaves theme empty', async () => {
  setConversationState(PHONE, 'WAITING_FOR_EVENT_THEME', {
    name: 'Wedding',
    date: 'Sunday, September 20, 2026 at 7:30 PM',
    location: 'Hall',
  });

  await continueCreateEventFlow(listTap('skip', '⏭️ Skip'), '⏭️ Skip');

  const state = getConversationState(PHONE);
  assert.equal(state?.theme, null);
  assert.equal(state?.custom_theme, null);
  assert.equal(state?.state, 'WAITING_FOR_DRESS_CODE');
});

test('create confirm persists theme, dress, and generated maps URL', async () => {
  const mapsUrl = buildGoogleMapsSearchUrl('Royal Albert Palace, Edison NJ');
  setConversationState(PHONE, 'CONFIRMING_EVENT', {
    name: 'Wedding',
    date: 'Sunday, September 20, 2026 at 7:30 PM',
    location: 'Royal Albert Palace, Edison NJ',
    location_place_id: null,
    location_maps_url: mapsUrl,
    theme: 'floral',
    dress_code: 'Pastel colors',
    children_allowed: 1,
    timezone: 'America/New_York',
  });

  await continueCreateEventFlow(
    command('Confirm', {
      interactiveId: CONFIRM_EVENT,
      interactiveType: 'button_reply',
    }),
    'Confirm',
  );

  const events = getDb()
    .prepare(`SELECT * FROM events WHERE organizer_phone = ?`)
    .all(PHONE) as Array<ReturnType<typeof getEventById>>;
  const event = events.at(-1);
  assert.ok(event);
  assert.equal(event?.theme, 'floral');
  assert.equal(event?.dress_code, 'Pastel colors');
  assert.equal(event?.location_place_id, null);
  assert.equal(event?.location_maps_url, mapsUrl);
});

test('old events load with null theme, dress, and maps fields', () => {
  const event = createEvent('Legacy', 'May 1', 'Garden', PHONE);
  const loaded = getEventById(event.id);
  assert.ok(loaded);
  assert.equal(loaded.theme ?? null, null);
  assert.equal(loaded.custom_theme ?? null, null);
  assert.equal(loaded.dress_code ?? null, null);
  assert.equal(loaded.location_place_id ?? null, null);
  assert.equal(loaded.location_maps_url ?? null, null);
  assert.equal(loaded.location, 'Garden');

  const html = renderRsvpPage(loaded, {
    askCounts: false,
    adults: 1,
    children: 0,
    maxGuests: null,
    childrenAllowed: true,
  });
  assert.match(html, /📍 Garden/);
  assert.match(html, /View on Google Maps/);
  assert.match(html, /query=Garden/);
  assert.doesNotMatch(html, /Event Theme/);
  assert.doesNotMatch(html, /Event Style/);
  assert.doesNotMatch(html, /Dress Code/);
  assert.doesNotMatch(html, /What to Wear/);
  assert.doesNotMatch(html, /GOOGLE_MAPS_API_KEY|AIza/);
});

test('edit event can change theme, custom theme, dress, and location without sending an update', async () => {
  const event = createEvent('Katha', 'Thursday, October 1, 2026 at 5:00 PM', 'Hall', PHONE);
  await handleEventUpdateCommand(
    command(`${EDIT_EVENT} ${event.id}`, {
      buttonPayload: `${EDIT_EVENT} ${event.id}`,
      interactiveType: 'button_reply',
    }),
    `${EDIT_EVENT} ${event.id}`,
  );
  await handleEventUpdateCommand(
    command(`${CHANGE_LOCATION} ${event.id}`, {
      buttonPayload: `${CHANGE_LOCATION} ${event.id}`,
      interactiveType: 'button_reply',
    }),
    `${CHANGE_LOCATION} ${event.id}`,
  );
  await continueEventUpdateFlow(command('Town Hall'), 'Town Hall');
  await handleEventUpdateCommand(
    command(`${EDIT_EVENT} ${event.id}`, {
      buttonPayload: `${EDIT_EVENT} ${event.id}`,
      interactiveType: 'button_reply',
    }),
    `${EDIT_EVENT} ${event.id}`,
  );
  await handleEventUpdateCommand(
    command(`${CHANGE_THEME} ${event.id}`, {
      buttonPayload: `${CHANGE_THEME} ${event.id}`,
      interactiveType: 'button_reply',
    }),
    `${CHANGE_THEME} ${event.id}`,
  );
  await continueEventUpdateFlow(listTap('custom', '✏️ Custom'), '✏️ Custom');
  await continueEventUpdateFlow(command('Blue and white garden party'), 'Blue and white garden party');
  await handleEventUpdateCommand(
    command(`${EDIT_EVENT} ${event.id}`, {
      buttonPayload: `${EDIT_EVENT} ${event.id}`,
      interactiveType: 'button_reply',
    }),
    `${EDIT_EVENT} ${event.id}`,
  );
  await handleEventUpdateCommand(
    command(`${CHANGE_DRESS} ${event.id}`, {
      buttonPayload: `${CHANGE_DRESS} ${event.id}`,
      interactiveType: 'button_reply',
    }),
    `${CHANGE_DRESS} ${event.id}`,
  );
  await continueEventUpdateFlow(
    command('✏️ Custom', {
      interactiveId: DRESS_ENTER,
      interactiveType: 'button_reply',
    }),
    '✏️ Custom',
  );
  await continueEventUpdateFlow(command('Pastel colors'), 'Pastel colors');

  const latest = getEventById(event.id);
  assert.ok(latest);
  assert.equal(latest.location, 'Town Hall');
  assert.equal(latest.location_place_id, null);
  assert.equal(latest.location_maps_url, buildGoogleMapsSearchUrl('Town Hall'));
  assert.equal(latest.theme, 'custom');
  assert.equal(latest.custom_theme, 'Blue and white garden party');
  assert.equal(latest.dress_code, 'Pastel colors');
  assert.equal(guestNotices.length, 0);
  assert.equal(listEventUpdatesForEvent(event.id).length, 0);
  assert.match(lastMessage().message, /Event updated/);
  assert.equal(getConversationState(PHONE), undefined);
});

test('updateEventDetails can persist a predefined theme', () => {
  const event = createEvent('Dinner', 'May 1', 'Home', PHONE);
  const updated = updateEventDetails(event.id, {
    name: event.name,
    date: event.date,
    location: event.location,
    theme: 'birthday',
    dress_code: 'Casual',
  });
  assert.equal(updated?.theme, 'birthday');
  assert.equal(updated?.dress_code, 'Casual');
  assert.equal(getEventById(event.id)?.theme, 'birthday');
});

test('RSVP page shows theme, dress, and maps link when set', () => {
  const mapsUrl = buildGoogleMapsSearchUrl('Royal Albert Palace, Edison NJ');
  const event = createEvent(
    'Anniversary',
    'Sunday, September 20, 2026 at 7:30 PM',
    'Royal Albert Palace',
    PHONE,
    {
      theme: 'elegant',
      dressCode: 'Blue or white',
      locationMapsUrl: mapsUrl,
      locationAddress: '123 Main Street, Edison, NJ',
    },
  );

  const html = renderRsvpPage(event, {
    askCounts: false,
    adults: 1,
    children: 0,
    maxGuests: null,
    childrenAllowed: true,
  });

  assert.match(html, /📍 Royal Albert Palace/);
  assert.match(html, /123 Main Street, Edison, NJ/);
  assert.match(html, /View on Google Maps/);
  assert.match(html, /query=Royal%20Albert%20Palace%2C%20Edison%20NJ/);
  assert.match(html, /🎨 Event Style/);
  assert.match(html, /✨ Elegant/);
  assert.doesNotMatch(html, /Event Theme/);
  assert.match(html, /👗 What to Wear/);
  assert.doesNotMatch(html, /Dress Code/);
  assert.match(html, /Blue or white/);
  assert.match(html, /theme-elegant/);
  assert.doesNotMatch(html, /GOOGLE_MAPS_API_KEY|AIza/);
  assert.doesNotMatch(html, /<iframe/i);
});

test('RSVP page shows escaped custom theme as subtitle and section', () => {
  const event = createEvent(
    'Garden Party',
    'Sunday, September 20, 2026 at 7:30 PM',
    'Park',
    PHONE,
    {
      theme: 'custom',
      customTheme: 'Elegant <script>alert(1)</script> garden party',
      dressCode: 'White & gold',
    },
  );

  const html = renderRsvpPage(event, {
    askCounts: false,
    adults: 1,
    children: 0,
    maxGuests: null,
    childrenAllowed: true,
  });

  assert.match(html, /theme-elegant/);
  assert.match(html, /theme-custom/);
  assert.match(html, /Elegant &lt;script&gt;alert\(1\)&lt;\/script&gt; garden party/);
  assert.match(html, /White &amp; gold/);
  assert.match(html, /View on Google Maps/);
  assert.match(html, /query=Park/);
  assert.doesNotMatch(html, /<script>alert/);
});

test('RSVP page hides the Maps link when there is no location', () => {
  const event = createEvent('Dinner', 'May 1', 'Home', PHONE);
  const html = renderRsvpPage(
    { ...event, location: '', location_maps_url: null },
    {
      askCounts: false,
      adults: 1,
      children: 0,
      maxGuests: null,
      childrenAllowed: true,
    },
  );
  assert.doesNotMatch(html, /View on Google Maps/);
});

test('confirmation and theme helpers stay button-driven', () => {
  assert.equal(EVENT_THEME_OPTIONS.length, 10);
  assert.equal(EVENT_THEME_OPTIONS[0]?.id, 'skip');
  assert.deepEqual(
    EVENT_THEME_OPTIONS.map((option) => option.id),
    [
      'skip',
      'floral',
      'elegant',
      'colorful',
      'natural',
      'classic',
      'festive',
      'modern',
      'minimal',
      'custom',
    ],
  );
  assert.match(THEME_PROMPT, /🎨 Event Style/);
  assert.match(THEME_PROMPT, /Choose a style for your event/);
  assert.doesNotMatch(THEME_PROMPT, /Event Theme/);
  assert.equal(eventThemeChoiceList().sections[0].title, 'Event Style');
  assert.deepEqual(
    eventThemeChoiceList().sections[0].rows.map((row) => row.id),
    EVENT_THEME_OPTIONS.map((option) => option.id),
  );
  assert.equal(DRESS_CODE_BUTTONS[0]?.title, '⏭️ Skip');
  assert.equal(DRESS_CODE_BUTTONS[1]?.title, '✏️ Custom');
  assert.deepEqual(parseThemeChoice('🌸 Floral'), { theme: 'floral' });
  assert.deepEqual(parseThemeChoice('skip'), { skip: true });
  assert.equal(parseThemeChoice('💍 Wedding'), undefined);
  assert.equal(sanitizeCustomTheme(`  ${'x'.repeat(400)}  `).length, 300);
  assert.equal(sanitizeDressCode(`  ${'y'.repeat(250)}  `).length, 200);

  const summary = formatEventConfirmation({
    organizer_phone: PHONE,
    state: 'CONFIRMING_EVENT',
    name: 'Wedding',
    date: 'Friday, September 11, 2026 at 7:30 PM',
    location: 'Hall',
    invitation_count: null,
    rsvp_deadline: null,
    children_allowed: 1,
    reminder_days: null,
    event_id: null,
    adult_count: null,
    child_count: null,
    invitation_id: null,
    invite_type: null,
    family_name: null,
    max_guests: null,
    group_name: null,
    theme: 'floral',
    dress_code: 'Pastel colors',
    updated_at: '',
  });
  assert.match(summary, /Event Style: 🌸 Floral/);
  assert.match(summary, /What to Wear: Pastel colors/);
  assert.doesNotMatch(summary, /Theme:/);
  assert.doesNotMatch(summary, /Dress code:/);
});

test('skipped style and What to Wear stay off the RSVP page', () => {
  const event = createEvent(
    'Picnic',
    'Sunday, September 20, 2026 at 7:30 PM',
    'Park',
    PHONE,
  );
  const html = renderRsvpPage(event, {
    askCounts: false,
    adults: 1,
    children: 0,
    maxGuests: null,
    childrenAllowed: true,
  });
  assert.doesNotMatch(html, /Event Style/);
  assert.doesNotMatch(html, /What to Wear/);
  assert.doesNotMatch(html, /Event Theme/);
  assert.doesNotMatch(html, /Dress Code/);
});

test('old theme IDs still render on RSVP and keep CSS classes', () => {
  const event = createEvent(
    'Anniversary',
    'Sunday, September 20, 2026 at 7:30 PM',
    'Hall',
    PHONE,
    { theme: 'wedding', dressCode: 'Formal' },
  );
  const html = renderRsvpPage(event, {
    askCounts: false,
    adults: 1,
    children: 0,
    maxGuests: null,
    childrenAllowed: true,
  });
  assert.equal(themeLabel('wedding'), '💍 Wedding');
  assert.equal(themeLabel('birthday'), '🎂 Birthday');
  assert.equal(themeLabel('baby_shower'), '👶 Baby Shower');
  assert.equal(themeLabel('celebration'), '🎉 Celebration');
  assert.equal(themeLabel('traditional'), '🪔 Traditional');
  assert.equal(themeLabel('business'), '💼 Business');
  assert.equal(themeLabel('casual'), '🌿 Casual');
  assert.equal(themeCssClass('wedding'), 'theme-wedding');
  assert.match(html, /🎨 Event Style/);
  assert.match(html, /💍 Wedding/);
  assert.match(html, /👗 What to Wear/);
  assert.match(html, /Formal/);
  assert.match(html, /theme-wedding/);
  assert.equal(getEventById(event.id)?.theme, 'wedding');
});

test('WhatsApp invitations stay free of long style and wear text', () => {
  const event = createEvent(
    'Garden Party',
    'Sunday, September 20, 2026 at 7:30 PM',
    'Park',
    PHONE,
    {
      theme: 'custom',
      customTheme: 'Blue and white, elegant garden party with soft floral design',
      dressCode: 'Everyone wear white or navy blue',
    },
  );
  const invitation = formatShareRsvpInvitation(event, 'https://connect.zip-bite.com/r/ABC12');
  assert.match(invitation, /Garden Party/);
  assert.doesNotMatch(invitation, /elegant garden party/);
  assert.doesNotMatch(invitation, /Everyone wear white/);
  assert.doesNotMatch(invitation, /Event Style/);
  assert.doesNotMatch(invitation, /What to Wear/);
});

test('edit Event Style skip clears the stored style', async () => {
  const event = createEvent('Dinner', 'May 1', 'Home', PHONE, {
    theme: 'elegant',
    dressCode: 'Navy blue',
  });
  await handleEventUpdateCommand(
    command(`${EDIT_EVENT} ${event.id}`, {
      buttonPayload: `${EDIT_EVENT} ${event.id}`,
      interactiveType: 'button_reply',
    }),
    `${EDIT_EVENT} ${event.id}`,
  );
  await handleEventUpdateCommand(
    command(`${CHANGE_THEME} ${event.id}`, {
      buttonPayload: `${CHANGE_THEME} ${event.id}`,
      interactiveType: 'button_reply',
    }),
    `${CHANGE_THEME} ${event.id}`,
  );
  await continueEventUpdateFlow(listTap('skip', '⏭️ Skip'), '⏭️ Skip');

  const latest = getEventById(event.id);
  assert.ok(latest);
  assert.equal(latest.theme, null);
  assert.equal(latest.custom_theme, null);
  assert.equal(latest.dress_code, 'Navy blue');
  assert.equal(guestNotices.length, 0);
  assert.equal(listEventUpdatesForEvent(event.id).length, 0);
});
