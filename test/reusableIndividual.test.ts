import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import {
  addGuests,
  checkFamilyRsvpLimit,
  closeDb,
  createEvent,
  createFamilyInvitation,
  createInvitation,
  getDb,
  getEventGuests,
  getGuest,
  getRsvp,
  getRsvpSummary,
  listEventUpdateTargets,
  listInvitationsForEvent,
  listInvitationsWithMembers,
  listRsvpsForEvent,
  lookupShortRsvpTarget,
  setGuestName,
  upsertRsvp,
} from '../src/db/store.js';
import { shortRsvpRouter } from '../src/http/shortRsvp.js';
import {
  CONNECT_VCARD_PATH,
  buildConnectVCard,
} from '../src/commands/saveContact.js';
import {
  formatRsvpStatusMessage,
} from '../src/commands/organizer.js';
import { getEventInviteStats } from '../src/commands/welcome.js';
import { isWebGuestPhone } from '../src/config.js';

process.env.DATABASE_PATH = ':memory:';
process.env.WHATSAPP_BUSINESS_PHONE = '+15551234567';

const OWNER = '+15551111111';
const GUEST_A = '+15552220001';
const EVENT_DATE = 'Sunday, July 4, 2026 at 2:00 PM';

function cookieHeader(res: Response): string {
  const parts =
    typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : [res.headers.get('set-cookie') ?? ''];
  return parts
    .filter(Boolean)
    .map((part) => part.split(';', 1)[0])
    .join('; ');
}

async function postRsvp(
  url: string,
  body: Record<string, string>,
  cookie = '',
): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...(cookie ? { cookie } : {}),
    },
    body: new URLSearchParams(body).toString(),
    redirect: 'manual',
  });
}

function withShortRsvpServer(
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(shortRsvpRouter);
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

test('A. same Individual link stores Yes, No, and Maybe as separate RSVPs', async () => {
  getDb();
  const event = createEvent('Picnic', EVENT_DATE, 'Park', OWNER);
  const invitation = createInvitation({ eventId: event.id, type: 'individual' });
  const urlCode = event.short_code;

  await withShortRsvpServer(async (baseUrl) => {
    const url = `${baseUrl}/r/${urlCode}`;

    const firstOpen = await fetch(url);
    const cookie1 = cookieHeader(firstOpen);
    const first = await postRsvp(
      url,
      { response: 'yes', name: 'John', adults: '2', children: '1', whatsapp: '7325552001' },
      cookie1,
    );
    assert.equal(first.status, 200);
    assert.match(await first.text(), /Thank you, John/);

    const secondOpen = await fetch(url);
    const cookie2 = cookieHeader(secondOpen);
    assert.notEqual(cookie2, cookie1);
    const second = await postRsvp(
      url,
      { response: 'no', name: 'Sarah', whatsapp: '7325552002' },
      cookie2,
    );
    assert.equal(second.status, 200);
    assert.match(await second.text(), /Thank you, Sarah/);

    const thirdOpen = await fetch(url);
    const cookie3 = cookieHeader(thirdOpen);
    const third = await postRsvp(
      url,
      { response: 'maybe', name: 'Michael', whatsapp: '7325552003' },
      cookie3,
    );
    assert.equal(third.status, 200);
    assert.match(await third.text(), /Thank you, Michael/);
  });

  const rsvps = listRsvpsForEvent(event.id).filter((row) => row.status !== 'pending');
  assert.equal(rsvps.length, 3);
  const byName = new Map(
    rsvps.map((row) => [getGuest(event.id, row.phone)?.name, row]),
  );
  assert.equal(byName.get('John')?.status, 'yes');
  assert.equal(byName.get('John')?.adult_count, 2);
  assert.equal(byName.get('John')?.child_count, 1);
  assert.equal(byName.get('Sarah')?.status, 'no');
  assert.equal(byName.get('Michael')?.status, 'maybe');
  assert.equal(new Set(rsvps.map((row) => row.phone)).size, 3);
  assert.equal(rsvps.every((row) => isWebGuestPhone(row.phone)), true);
  assert.equal(
    rsvps.every(
      (row) => getGuest(event.id, row.phone)?.invitation_id === invitation.id,
    ),
    true,
  );
  closeDb();
});

test('B. dashboard counts each Individual respondent and keeps invitations sent as invitation rows', async () => {
  getDb();
  const event = createEvent('Picnic', EVENT_DATE, 'Park', OWNER);
  createInvitation({ eventId: event.id, type: 'individual' });

  await withShortRsvpServer(async (baseUrl) => {
    const url = `${baseUrl}/r/${event.short_code}`;
    await postRsvp(url, {
      response: 'yes',
      name: 'John',
      adults: '2',
      children: '1',
      whatsapp: '7325552011',
    });
    await postRsvp(url, { response: 'no', name: 'Sarah', whatsapp: '7325552012' });
    await postRsvp(url, { response: 'maybe', name: 'Michael', whatsapp: '7325552013' });
  });

  const stats = getEventInviteStats(event.id);
  assert.equal(stats.invitationsSent, 1);
  assert.equal(stats.yes, 1);
  assert.equal(stats.no, 1);
  assert.equal(stats.maybe, 1);
  assert.equal(stats.awaiting, 0);

  const summary = getRsvpSummary(event.id);
  assert.equal(summary.expectedAttendance, 3);
  assert.equal(summary.totalAdults, 2);
  assert.equal(summary.totalChildren, 1);

  const status = formatRsvpStatusMessage(
    event,
    summary,
    getEventGuests(event.id),
    listRsvpsForEvent(event.id),
    listInvitationsWithMembers(event.id),
  );
  assert.match(status, /Invitations: 1/);
  assert.match(status, /Yes: 1/);
  assert.match(status, /No: 1/);
  assert.match(status, /Maybe: 1/);
  assert.match(status, /Awaiting: 0/);
  assert.match(status, /John — Yes/);
  assert.match(status, /Sarah — No/);
  assert.match(status, /Michael — Maybe/);
  assert.doesNotMatch(status, /web:/);
  closeDb();
});

test('C. returning cookie edits only that respondent on a reusable Individual link', async () => {
  getDb();
  const event = createEvent('Picnic', EVENT_DATE, 'Park', OWNER, {
    childrenAllowed: true,
  });
  createInvitation({ eventId: event.id, type: 'individual' });

  await withShortRsvpServer(async (baseUrl) => {
    const url = `${baseUrl}/r/${event.short_code}`;
    const cookie1 = cookieHeader(await fetch(url));
    await postRsvp(
      url,
      {
        response: 'yes',
        name: 'John',
        adults: '1',
        children: '0',
        whatsapp: '7325552021',
      },
      cookie1,
    );
    const cookie2 = cookieHeader(await fetch(url));
    await postRsvp(url, { response: 'no', name: 'Sarah', whatsapp: '7325552022' }, cookie2);

    const updated = await postRsvp(
      url,
      { response: 'maybe', name: 'John', whatsapp: '7325552023' },
      cookie1,
    );
    assert.equal(updated.status, 200);
    assert.match(await updated.text(), /Thank you, John/);
  });

  const rsvps = listRsvpsForEvent(event.id).filter((row) => row.status !== 'pending');
  assert.equal(rsvps.length, 2);
  const john = rsvps.find((row) => getGuest(event.id, row.phone)?.name === 'John');
  const sarah = rsvps.find((row) => getGuest(event.id, row.phone)?.name === 'Sarah');
  assert.equal(john?.status, 'maybe');
  assert.equal(sarah?.status, 'no');
  closeDb();
});

test('D. Family guest limit and single-family RSVP stay unchanged', async () => {
  getDb();
  const event = createEvent('Wedding', EVENT_DATE, 'Hall', OWNER);
  const family = createFamilyInvitation(event.id, 'Patel Family', 3);
  addGuests(event.id, [GUEST_A], family.id);
  setGuestName(event.id, GUEST_A, 'David Patel');

  assert.equal(checkFamilyRsvpLimit(family, 2, 1).allowed, true);
  assert.equal(checkFamilyRsvpLimit(family, 3, 1).allowed, false);

  await withShortRsvpServer(async (baseUrl) => {
    const url = `${baseUrl}/r/${family.short_code}`;
    const over = await postRsvp(url, {
      response: 'yes',
      name: 'Priya Patel',
      adults: '3',
      children: '1',
    });
    assert.equal(over.status, 400);
    assert.match(await over.text(), /up to 3 guests/);

    const ok = await postRsvp(url, {
      response: 'yes',
      name: 'Priya Patel',
      adults: '2',
      children: '1',
    });
    assert.equal(ok.status, 200);
  });

  assert.equal(getRsvp(event.id, GUEST_A)?.status, 'yes');
  assert.equal(getGuest(event.id, GUEST_A)?.name, 'Priya Patel');
  assert.equal(
    listRsvpsForEvent(event.id).filter((row) => isWebGuestPhone(row.phone)).length,
    0,
  );
  assert.equal(listEventUpdateTargets(event.id)[0]?.phone, GUEST_A);
  closeDb();
});

test('E. existing Individual event short links stay reusable', async () => {
  getDb();
  const event = createEvent('Gala', EVENT_DATE, 'Hotel', OWNER);
  const invitation = createInvitation({ eventId: event.id, type: 'individual' });
  assert.equal(invitation.short_code, null);
  assert.equal(
    lookupShortRsvpTarget(event.short_code ?? '')?.invitation?.id,
    invitation.id,
  );
  assert.equal(lookupShortRsvpTarget(event.short_code ?? '')?.event.id, event.id);

  await withShortRsvpServer(async (baseUrl) => {
    const url = `${baseUrl}/r/${event.short_code}`;
    const first = await postRsvp(url, {
      response: 'no',
      name: 'Alex Chen',
      whatsapp: '7325552031',
    });
    assert.equal(first.status, 200);
    const second = await postRsvp(url, {
      response: 'maybe',
      name: 'Riley Cohen',
      whatsapp: '7325552032',
    });
    assert.equal(second.status, 200);
  });

  const rsvps = listRsvpsForEvent(event.id).filter((row) => row.status !== 'pending');
  assert.equal(rsvps.length, 2);
  closeDb();
});

test('F. Send Update targets unique WhatsApp phones and skips web-only respondents', async () => {
  getDb();
  const event = createEvent('Dinner', EVENT_DATE, 'Hall', OWNER);
  const invitation = createInvitation({ eventId: event.id, type: 'individual' });
  addGuests(event.id, [GUEST_A, GUEST_A], invitation.id);
  addGuests(event.id, [OWNER], invitation.id);

  await withShortRsvpServer(async (baseUrl) => {
    const url = `${baseUrl}/r/${event.short_code}`;
    await postRsvp(url, {
      response: 'yes',
      name: 'John',
      adults: '1',
      children: '0',
      whatsapp: '7325552041',
    });
    await postRsvp(url, { response: 'no', name: 'Sarah', whatsapp: '7325552042' });
  });

  const targets = listEventUpdateTargets(event.id);
  assert.deepEqual(
    targets.map((row) => row.phone).sort(),
    [GUEST_A, '+17325552041', '+17325552042'].sort(),
  );
  assert.equal(
    listRsvpsForEvent(event.id).filter((row) => isWebGuestPhone(row.phone)).length,
    2,
  );
  assert.equal(getRsvp(event.id, GUEST_A)?.status, 'pending');

  const webOnly = createEvent('Web Only', EVENT_DATE, 'Hall', OWNER);
  createInvitation({ eventId: webOnly.id, type: 'individual' });
  await withShortRsvpServer(async (baseUrl) => {
    await postRsvp(`${baseUrl}/r/${webOnly.short_code}`, {
      response: 'yes',
      name: 'Alex Rivera',
      adults: '1',
      children: '0',
      whatsapp: '7325552043',
    });
  });
  assert.equal(listEventUpdateTargets(webOnly.id).length, 1);
  assert.equal(listEventUpdateTargets(webOnly.id)[0]?.phone, '+17325552043');
  closeDb();
});

test('G. success page offers Save CONNECT vCard and never Back to WhatsApp', async () => {
  getDb();
  const event = createEvent('Picnic', EVENT_DATE, 'Park', OWNER);

  await withShortRsvpServer(async (baseUrl) => {
    const res = await postRsvp(`${baseUrl}/r/${event.short_code}`, {
      response: 'no',
      name: 'Jordan Lee',
      whatsapp: '7325552044',
    });
    const body = await res.text();
    assert.match(body, /RSVP Confirmed!/);
    assert.match(body, /Thank you, Jordan Lee\. Your RSVP has been recorded\./);
    assert.match(body, /📱 Save CONNECT/);
    assert.match(
      body,
      /Save our number so you can easily find CONNECT for future events/,
    );
    assert.match(body, />Save CONNECT</);
    assert.match(body, new RegExp(`href="${CONNECT_VCARD_PATH}"`));
    assert.match(body, /Need to change your RSVP\?/);
    assert.match(body, /Simply open the invitation link again to update your response\./);
    assert.match(body, /Powered by zipbite/);
    assert.doesNotMatch(body, /Back to WhatsApp/);
    assert.doesNotMatch(body, /You can close this page and return to WhatsApp/);
    assert.doesNotMatch(body, /wa\.me/);
    assert.doesNotMatch(body, /whatsapp:\/\//);

    const vcardRes = await fetch(`${baseUrl}${CONNECT_VCARD_PATH}`);
    assert.equal(vcardRes.status, 200);
    assert.match(vcardRes.headers.get('content-type') ?? '', /vcard/i);
    const vcard = await vcardRes.text();
    assert.equal(vcard, buildConnectVCard());
    assert.match(vcard, /FN:CONNECT/);
    assert.match(vcard, /\+15551234567/);
  });

  closeDb();
});

test('Individual reusable link does not invent awaiting for unopened forwards', () => {
  getDb();
  const event = createEvent('Picnic', EVENT_DATE, 'Park', OWNER);
  createInvitation({ eventId: event.id, type: 'individual' });
  const stats = getEventInviteStats(event.id);
  assert.equal(stats.invitationsSent, 1);
  assert.equal(stats.awaiting, 0);
  closeDb();
});

test('Individual invitation records stay one reusable link even after a second send', () => {
  getDb();
  const event = createEvent('Picnic', EVENT_DATE, 'Park', OWNER);
  createInvitation({ eventId: event.id, type: 'individual' });
  assert.equal(
    listInvitationsForEvent(event.id).filter((row) => row.type === 'individual')
      .length,
    1,
  );
  closeDb();
});

test('Individual web RSVP requires a valid WhatsApp number and does not use the organizer', async () => {
  getDb();
  const event = createEvent('Gala', EVENT_DATE, 'Hotel', OWNER);
  createInvitation({ eventId: event.id, type: 'individual' });

  await withShortRsvpServer(async (baseUrl) => {
    const url = `${baseUrl}/r/${event.short_code}`;
    const named = await postRsvp(url, { response: 'no', name: 'Asha Patel' });
    assert.match(await named.text(), /WhatsApp Number/);
    const invalid = await postRsvp(url, {
      response: 'no',
      name: 'Asha Patel',
      whatsapp: '12',
    });
    assert.equal(invalid.status, 400);
    assert.match(await invalid.text(), /valid WhatsApp number/);
    const organizer = await postRsvp(url, {
      response: 'no',
      name: 'Asha Patel',
      whatsapp: '5551111111',
    });
    assert.equal(organizer.status, 400);
    assert.match(await organizer.text(), /not the organizer/);
    const saved = await postRsvp(url, {
      response: 'no',
      name: 'Asha Patel',
      whatsapp: '7325554001',
    });
    const body = await saved.text();
    assert.match(body, /RSVP Confirmed/);
    assert.doesNotMatch(body, /7325554001/);
    assert.doesNotMatch(body, /\+17325554001/);
  });

  const rsvp = listRsvpsForEvent(event.id).find((row) => row.status === 'no');
  assert.ok(rsvp);
  assert.ok(isWebGuestPhone(rsvp.phone));
  assert.equal(getGuest(event.id, rsvp.phone)?.whatsapp_phone, '+17325554001');
  assert.deepEqual(
    listEventUpdateTargets(event.id).map((row) => row.phone),
    ['+17325554001'],
  );
  assert.equal(
    listEventUpdateTargets(event.id).some((row) => row.phone === OWNER),
    false,
  );
  closeDb();
});

test('same Individual cookie updates that respondent WhatsApp number only', async () => {
  getDb();
  const event = createEvent('Gala', EVENT_DATE, 'Hotel', OWNER);
  createInvitation({ eventId: event.id, type: 'individual' });

  await withShortRsvpServer(async (baseUrl) => {
    const url = `${baseUrl}/r/${event.short_code}`;
    const first = await postRsvp(url, {
      response: 'yes',
      name: 'Asha Patel',
      adults: '1',
      children: '0',
      whatsapp: '7325554011',
    });
    const cookie = cookieHeader(first);
    await postRsvp(url, {
      response: 'no',
      name: 'Other Person',
      whatsapp: '7325554012',
    });
    const updated = await postRsvp(
      url,
      {
        response: 'maybe',
        name: 'Asha Patel',
        whatsapp: '7325554013',
      },
      cookie,
    );
    assert.equal(updated.status, 200);
  });

  const asha = listRsvpsForEvent(event.id).find(
    (row) => getGuest(event.id, row.phone)?.name === 'Asha Patel',
  );
  const other = listRsvpsForEvent(event.id).find(
    (row) => getGuest(event.id, row.phone)?.name === 'Other Person',
  );
  assert.equal(asha?.status, 'maybe');
  assert.equal(getGuest(event.id, asha!.phone)?.whatsapp_phone, '+17325554013');
  assert.equal(other?.status, 'no');
  assert.equal(getGuest(event.id, other!.phone)?.whatsapp_phone, '+17325554012');
  closeDb();
});
