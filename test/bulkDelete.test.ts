import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import {
  addGuests,
  closeDb,
  createEvent,
  createInvitation,
  getDb,
  getEventById,
  isEventDeleted,
  listEventsForOrganizer,
  listInvitationsForEvent,
  listRsvpsForEvent,
  softDeleteOwnedEvents,
  upsertMessageSession,
  upsertRsvp,
} from '../src/db/store.js';
import {
  CONFIRM_DELETE_EVENT,
  DELETE_EVENT,
  KEEP_EVENT,
  handleEventUpdateCommand,
  setEventUpdateMessageSender,
} from '../src/commands/eventUpdateFlow.js';
import {
  MANAGE_EVENT,
  buildBulkDeleteEventsReply,
  buildMyEventsReply,
  handleCustomerCommand,
  setCustomerMessageSender,
} from '../src/commands/welcome.js';
import { myEventsRouter, setMyEventsMessageSender } from '../src/http/myEvents.js';
import { formatDeletedCount } from '../src/http/myEventsPage.js';
import {
  MY_EVENTS_TOKEN_TTL_MS,
  myEventsPagePath,
  signMyEventsToken,
  signOwnedEventRef,
  verifyMyEventsToken,
  verifyOwnedEventRef,
} from '../src/http/myEventsToken.js';
import type { CommandContext } from '../src/commands/organizer.js';
import type { SendMessageParams } from '../src/zernio/client.js';

process.env.DATABASE_PATH = ':memory:';
process.env.WEBHOOK_SECRET = 'bulk-delete-test-secret';

const OWNER = '+15551115001';
const OTHER = '+15552225002';
const GUEST = '+15553335003';

const sent: SendMessageParams[] = [];

function lastMessage(): SendMessageParams {
  const message = sent.at(-1);
  assert.ok(message, 'expected a reply');
  return message;
}

function tap(phone: string, payload: string): CommandContext {
  return {
    phone,
    text: payload,
    conversationId: `conv-${phone}`,
    accountId: 'acct-bulk',
    buttonPayload: payload,
    interactiveType: 'button_reply',
  };
}

function withServer(fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(myEventsRouter);
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

async function postForm(
  url: string,
  body: Record<string, string> | URLSearchParams,
): Promise<Response> {
  const params =
    body instanceof URLSearchParams ? body : new URLSearchParams(body);
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
    redirect: 'manual',
  });
}

function checkboxRefs(html: string): string[] {
  return [...html.matchAll(/name="event" value="([^"]+)"/g)].map(
    (match) => match[1],
  );
}

async function loadCheckboxRefs(
  baseUrl: string,
  path: string,
): Promise<string[]> {
  const html = await (await fetch(`${baseUrl}${path}`)).text();
  return checkboxRefs(html);
}

function withBundleServer(
  fn: (baseUrl: string, path: string) => Promise<void>,
): Promise<void> {
  return withServer(async (baseUrl) => {
    await fn(baseUrl, myEventsPagePath(OWNER));
  });
}

test.beforeEach(() => {
  getDb();
  sent.length = 0;
  setMyEventsMessageSender(async (params) => {
    sent.push(params);
  });
  setCustomerMessageSender(async (params) => {
    sent.push(params);
  });
  setEventUpdateMessageSender(async (params) => {
    sent.push(params);
  });
});

test.afterEach(() => {
  setMyEventsMessageSender();
  setCustomerMessageSender();
  setEventUpdateMessageSender();
  closeDb();
});

test('1-10. bulk delete requires confirm, soft-deletes owned events only', async () => {
  const keep = createEvent('Wedding', 'Dec 1', 'Hall', OWNER);
  const first = createEvent('Birthday Party', 'Oct 10', 'Park', OWNER);
  const second = createEvent('Dinner', 'Nov 21', 'Cafe', OWNER);
  const already = createEvent('Old', 'Jan 1', 'Home', OWNER);
  const theirs = createEvent('Private', 'Feb 2', 'Loft', OTHER);
  const invite = createInvitation({ eventId: first.id, type: 'individual' });
  addGuests(first.id, [GUEST], invite.id);
  upsertRsvp(first.id, GUEST, 'yes', 2, 'yes', 2, 0);
  softDeleteOwnedEvents(OWNER, [already.id]);
  upsertMessageSession(OWNER, 'conv-owner', 'acct-bulk');

  const listed = listEventsForOrganizer(OWNER);
  assert.equal(listed.some((event) => event.id === already.id), false);
  assert.equal(listed.length, 3);

  await withServer(async (baseUrl) => {
    const path = myEventsPagePath(OWNER);
    assert.match(path, /^\/e\/[0-9A-Z]+$/i);
    assert.notEqual(path, `/e/${first.id}`);
    assert.doesNotMatch(path, new RegExp(`/${first.id}(?:/|$)`));

    const getRes = await fetch(`${baseUrl}${path}`);
    assert.equal(getRes.status, 200);
    const selectHtml = await getRes.text();
    assert.match(selectHtml, /type="checkbox"/);
    assert.match(selectHtml, /Select All/);
    assert.match(selectHtml, /Clear All/);
    assert.match(selectHtml, /Delete Selected \(0\)/);
    assert.match(selectHtml, /Birthday Party/);
    assert.match(selectHtml, /Dinner/);
    assert.match(selectHtml, /Wedding/);
    assert.doesNotMatch(selectHtml, />Old</);
    assert.doesNotMatch(selectHtml, /Private/);
    assert.equal(selectHtml.includes(`value="${first.id}"`), false);

    const refs = checkboxRefs(selectHtml);
    assert.equal(refs.length, 3);
    const firstRef = refs.find(
      (ref) => verifyOwnedEventRef(ref, OWNER) === first.id,
    );
    const secondRef = refs.find(
      (ref) => verifyOwnedEventRef(ref, OWNER) === second.id,
    );
    assert.ok(firstRef);
    assert.ok(secondRef);

    const reviewNone = await postForm(`${baseUrl}${path}`, { action: 'review' });
    assert.equal(reviewNone.status, 200);
    assert.match(await reviewNone.text(), /Select at least one event/);
    assert.equal(isEventDeleted(getEventById(first.id)), false);

    const reviewParams = new URLSearchParams();
    reviewParams.append('action', 'review');
    reviewParams.append('event', firstRef);
    reviewParams.append('event', secondRef);
    const review = await postForm(`${baseUrl}${path}`, reviewParams);
    assert.equal(review.status, 200);
    const confirmHtml = await review.text();
    assert.match(confirmHtml, /Delete 2 events\?/);
    assert.match(confirmHtml, /RSVP\/invitation history will be retained/);
    assert.match(confirmHtml, />Delete</);
    assert.match(confirmHtml, />Cancel</);
    assert.equal(isEventDeleted(getEventById(first.id)), false);
    assert.equal(isEventDeleted(getEventById(second.id)), false);

    const cancel = await postForm(`${baseUrl}${path}`, { action: 'cancel' });
    assert.equal(cancel.status, 200);
    assert.match(await cancel.text(), /Delete Selected \(0\)/);
    assert.equal(isEventDeleted(getEventById(first.id)), false);

    const staleAlready = signOwnedEventRef(OWNER, already.id);
    const foreign = signOwnedEventRef(OTHER, theirs.id);
    const deleteParams = new URLSearchParams();
    deleteParams.append('action', 'delete');
    deleteParams.append('event', firstRef);
    deleteParams.append('event', secondRef);
    deleteParams.append('event', staleAlready);
    deleteParams.append('event', foreign);
    deleteParams.append('event', String(theirs.id));
    deleteParams.append('event', String(keep.id));

    const deleted = await postForm(`${baseUrl}${path}`, deleteParams);
    assert.equal(deleted.status, 200);
    const deletedHtml = await deleted.text();
    assert.match(deletedHtml, /✅ 2 events deleted/);
    assert.match(deletedHtml, /My Events/);
    assert.match(deletedHtml, /Wedding/);
    assert.match(deletedHtml, /Delete Selected \(0\)/);
    assert.doesNotMatch(deletedHtml, /Birthday Party/);
    assert.doesNotMatch(deletedHtml, /Dinner/);
  });

  assert.equal(isEventDeleted(getEventById(first.id)), true);
  assert.equal(isEventDeleted(getEventById(second.id)), true);
  assert.equal(isEventDeleted(getEventById(keep.id)), false);
  assert.equal(isEventDeleted(getEventById(theirs.id)), false);
  assert.equal(
    listRsvpsForEvent(first.id).some((row) => row.phone === GUEST && row.status === 'yes'),
    true,
  );
  assert.equal(
    listInvitationsForEvent(first.id).some((row) => row.id === invite.id),
    true,
  );
  assert.deepEqual(
    listEventsForOrganizer(OWNER).map((event) => event.id),
    [keep.id],
  );
  assert.match(lastMessage().message, /2 events deleted/);
  assert.deepEqual(lastMessage().buttons, [
    { title: '🏠 Main Menu', payload: 'HOME' },
  ]);

  await handleEventUpdateCommand(
    tap(OWNER, `${DELETE_EVENT} ${keep.id}`),
    `${DELETE_EVENT} ${keep.id}`,
  );
  assert.match(lastMessage().message, /Remove this event from your list/);
  assert.equal(isEventDeleted(getEventById(keep.id)), false);
  await handleEventUpdateCommand(
    tap(OWNER, `${KEEP_EVENT} ${keep.id}`),
    `${KEEP_EVENT} ${keep.id}`,
  );
  assert.equal(isEventDeleted(getEventById(keep.id)), false);
  await handleEventUpdateCommand(
    tap(OWNER, `${DELETE_EVENT} ${keep.id}`),
    `${DELETE_EVENT} ${keep.id}`,
  );
  await handleEventUpdateCommand(
    tap(OWNER, `${CONFIRM_DELETE_EVENT} ${keep.id}`),
    `${CONFIRM_DELETE_EVENT} ${keep.id}`,
  );
  assert.equal(isEventDeleted(getEventById(keep.id)), true);
  assert.equal(listEventsForOrganizer(OWNER).length, 0);
});

test('unauthorized token and raw ids cannot delete another organizer event', async () => {
  const mine = createEvent('Mine', 'May 1', 'Home', OWNER);
  const theirs = createEvent('Theirs', 'May 2', 'Hall', OTHER);

  await withServer(async (baseUrl) => {
    const ownerPath = myEventsPagePath(OWNER);
    const otherPath = myEventsPagePath(OTHER);
    const raw = await postForm(`${baseUrl}${ownerPath}`, {
      action: 'delete',
      event: String(theirs.id),
    });
    assert.match(await raw.text(), /Select at least one event/);
    assert.equal(isEventDeleted(getEventById(theirs.id)), false);

    const forged = await postForm(`${baseUrl}${ownerPath}`, {
      action: 'delete',
      event: signOwnedEventRef(OTHER, theirs.id),
    });
    assert.match(await forged.text(), /Select at least one event/);
    assert.equal(isEventDeleted(getEventById(theirs.id)), false);

    const cross = await postForm(`${baseUrl}${otherPath}`, {
      action: 'delete',
      event: signOwnedEventRef(OWNER, mine.id),
    });
    assert.match(await cross.text(), /Select at least one event/);
    assert.equal(isEventDeleted(getEventById(mine.id)), false);

    const invalid = await fetch(`${baseUrl}/e/not-a-real-code`);
    assert.equal(invalid.status, 404);
  });
});

test('My Events WhatsApp list includes the signed bulk-delete page', async () => {
  createEvent('One', 'June 1', 'Park', OWNER);
  createEvent('Two', 'June 2', 'Hall', OWNER);
  const reply = buildBulkDeleteEventsReply(OWNER);
  assert.match(reply.message, /Select events to delete/);
  assert.match(reply.message, /\/e\//);
  assert.doesNotMatch(reply.message, /\/admin/);

  await handleCustomerCommand(tap(OWNER, 'MY_EVENTS'));
  const deleteReply = sent.find((item) =>
    item.message.includes('Select events to delete'),
  );
  assert.ok(deleteReply);
  const cards = sent.find((item) => item.message.includes('📅 One'));
  assert.ok(cards);
  assert.equal(cards.list?.button, 'Manage Event');
});

test('My Events omits the web delete link when there is only one event', async () => {
  createEvent('Solo', 'June 1', 'Park', OWNER);
  await handleCustomerCommand(tap(OWNER, 'MY_EVENTS'));
  assert.equal(
    sent.some((item) => item.message.includes('Select events to delete')),
    false,
  );
  assert.match(lastMessage().message, /📅 Solo/);
});

test('signed my-events tokens expire and do not accept event-when payloads', () => {
  const token = signMyEventsToken(OWNER, 1_000);
  assert.equal(
    verifyMyEventsToken(token, 1_000 + MY_EVENTS_TOKEN_TTL_MS + 1),
    null,
  );
  const fresh = signMyEventsToken(OWNER);
  const payload = verifyMyEventsToken(fresh);
  assert.ok(payload);
  assert.equal(payload.phone, OWNER);
  assert.equal(verifyOwnedEventRef('not-signed', OWNER), null);
  assert.equal(formatDeletedCount(1), '✅ 1 event deleted.');
  assert.equal(formatDeletedCount(2), '✅ 2 events deleted.');
});

test('one selected event deletes in a single web POST', async () => {
  const keep = createEvent('Stay', 'Feb 1', 'Home', OWNER);
  const target = createEvent('Drop', 'Feb 2', 'Park', OWNER);

  await withBundleServer(async (baseUrl, path) => {
    const refs = await loadCheckboxRefs(baseUrl, path);
    const targetRef = refs.find((ref) => verifyOwnedEventRef(ref, OWNER) === target.id);
    assert.ok(targetRef);
    const res = await postForm(`${baseUrl}${path}`, {
      action: 'delete',
      event: targetRef,
    });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /✅ 1 event deleted/);
    assert.match(html, /Stay/);
    assert.doesNotMatch(html, /Drop/);
  });

  assert.equal(isEventDeleted(getEventById(target.id)), true);
  assert.equal(isEventDeleted(getEventById(keep.id)), false);
});

test('/my-events/:token bulk-deletes two events in one POST', async () => {
  const first = createEvent('Token A', 'Jun 1', 'Park', OWNER);
  const second = createEvent('Token B', 'Jun 2', 'Hall', OWNER);

  await withServer(async (baseUrl) => {
    const path = `/my-events/${encodeURIComponent(signMyEventsToken(OWNER))}`;
    const refs = await loadCheckboxRefs(baseUrl, path);
    assert.equal(refs.length, 2);
    const params = new URLSearchParams();
    params.append('action', 'delete');
    params.append('event', refs[0]);
    params.append('event', refs[1]);
    const res = await postForm(`${baseUrl}${path}`, params);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /✅ 2 events deleted/);
  });

  assert.equal(isEventDeleted(getEventById(first.id)), true);
  assert.equal(isEventDeleted(getEventById(second.id)), true);
});

test('one POST with 2 signed refs deletes both and leaves unselected', async () => {
  const keep = createEvent('Keep Me', 'Mar 1', 'Home', OWNER);
  const first = createEvent('Alpha', 'Mar 2', 'Park', OWNER);
  const second = createEvent('Bravo', 'Mar 3', 'Hall', OWNER);

  await withBundleServer(async (baseUrl, path) => {
    const refs = await loadCheckboxRefs(baseUrl, path);
    const firstRef = refs.find((ref) => verifyOwnedEventRef(ref, OWNER) === first.id);
    const secondRef = refs.find((ref) => verifyOwnedEventRef(ref, OWNER) === second.id);
    assert.ok(firstRef);
    assert.ok(secondRef);

    const params = new URLSearchParams();
    params.append('action', 'delete');
    params.append('event', firstRef);
    params.append('event', secondRef);
    const res = await postForm(`${baseUrl}${path}`, params);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /✅ 2 events deleted/);
    assert.match(html, /Keep Me/);
    assert.doesNotMatch(html, /Alpha/);
    assert.doesNotMatch(html, /Bravo/);
  });

  assert.equal(isEventDeleted(getEventById(first.id)), true);
  assert.equal(isEventDeleted(getEventById(second.id)), true);
  assert.equal(isEventDeleted(getEventById(keep.id)), false);
  assert.deepEqual(
    listEventsForOrganizer(OWNER).map((event) => event.id),
    [keep.id],
  );
});

test('one POST with 3 signed refs deletes all 3 in that action', async () => {
  const first = createEvent('One', 'Apr 1', 'Park', OWNER);
  const second = createEvent('Two', 'Apr 2', 'Hall', OWNER);
  const third = createEvent('Three', 'Apr 3', 'Cafe', OWNER);

  let requestCount = 0;
  await withServer(async (baseUrl) => {
    const path = myEventsPagePath(OWNER);
    const refs = await loadCheckboxRefs(baseUrl, path);
    assert.equal(refs.length, 3);

    const params = new URLSearchParams();
    params.append('action', 'delete');
    for (const ref of refs) {
      params.append('event', ref);
    }
    requestCount += 1;
    const res = await postForm(`${baseUrl}${path}`, params);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /✅ 3 events deleted/);
    assert.match(html, /You don’t have any events to delete/);
    assert.doesNotMatch(html, />One</);
    assert.doesNotMatch(html, />Two</);
    assert.doesNotMatch(html, />Three</);
  });

  assert.equal(requestCount, 1);
  assert.equal(isEventDeleted(getEventById(first.id)), true);
  assert.equal(isEventDeleted(getEventById(second.id)), true);
  assert.equal(isEventDeleted(getEventById(third.id)), true);
  assert.equal(listEventsForOrganizer(OWNER).length, 0);
});

test('duplicate, stale, and invalid refs in one POST do not crash', async () => {
  const live = createEvent('Live', 'May 1', 'Home', OWNER);
  const extra = createEvent('Extra', 'May 2', 'Hall', OWNER);
  const gone = createEvent('Gone', 'May 3', 'Park', OWNER);
  softDeleteOwnedEvents(OWNER, [gone.id]);

  await withBundleServer(async (baseUrl, path) => {
    const liveRef = signOwnedEventRef(OWNER, live.id);
    const params = new URLSearchParams();
    params.append('action', 'delete');
    params.append('event', liveRef);
    params.append('event', liveRef);
    params.append('event', signOwnedEventRef(OWNER, gone.id));
    params.append('event', 'not-a-signed-ref');
    params.append('event', String(extra.id));
    const res = await postForm(`${baseUrl}${path}`, params);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /✅ 1 event deleted/);
  });

  assert.equal(isEventDeleted(getEventById(live.id)), true);
  assert.equal(isEventDeleted(getEventById(extra.id)), false);
  assert.equal(listEventsForOrganizer(OWNER).map((event) => event.id).includes(extra.id), true);
});

test('bulk delete can remove both duplicate Dinner events in one POST', async () => {
  const october = createEvent('Dinner', 'October 10', 'Hall', OWNER);
  const november = createEvent('Dinner', 'November 15', 'Cafe', OWNER);
  const keep = createEvent('Katha 2', 'Sept 1', 'Temple', OWNER);

  await withBundleServer(async (baseUrl, path) => {
    const refs = await loadCheckboxRefs(baseUrl, path);
    const octoberRef = refs.find((ref) => verifyOwnedEventRef(ref, OWNER) === october.id);
    const novemberRef = refs.find((ref) => verifyOwnedEventRef(ref, OWNER) === november.id);
    assert.ok(octoberRef);
    assert.ok(novemberRef);
    const params = new URLSearchParams();
    params.append('action', 'delete');
    params.append('event', octoberRef);
    params.append('event', novemberRef);
    const res = await postForm(`${baseUrl}${path}`, params);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /✅ 2 events deleted/);
    assert.match(html, /Katha 2/);
    assert.doesNotMatch(html, />Dinner</);
  });

  assert.equal(isEventDeleted(getEventById(october.id)), true);
  assert.equal(isEventDeleted(getEventById(november.id)), true);
  assert.equal(isEventDeleted(getEventById(keep.id)), false);
});

test('duplicate-name events stay independently selectable on the delete page', async () => {
  const first = createEvent('Birthday Party', 'Oct 10', 'Hall', OWNER);
  const second = createEvent('Birthday Party', 'Nov 21', 'Garden', OWNER);
  const replies = buildMyEventsReply([first, second]);
  assert.deepEqual(
    replies[0].list?.sections[0].rows.map((row) => row.id),
    [`${MANAGE_EVENT}:${first.id}`, `${MANAGE_EVENT}:${second.id}`],
  );

  await withServer(async (baseUrl) => {
    const path = myEventsPagePath(OWNER);
    const html = await (await fetch(`${baseUrl}${path}`)).text();
    assert.equal(html.match(/Birthday Party/g)?.length, 2);
    const refs = checkboxRefs(html);
    assert.deepEqual(
      refs.map((ref) => verifyOwnedEventRef(ref, OWNER)).sort(),
      [first.id, second.id].sort(),
    );
  });
});
