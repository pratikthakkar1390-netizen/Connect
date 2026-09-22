import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import sharp from 'sharp';
import {
  closeDb,
  clearConversationState,
  createEvent,
  getConversationState,
  getDb,
  getEventById,
  lookupRsvpLinkTarget,
  setConversationState,
  sweepAbandonedEventImages,
  upsertMessageSession,
} from '../src/db/store.js';
import {
  EVENT_IMAGE_PROMPT,
  IMAGE_CHOOSE,
  IMAGE_SKIP,
  RSVP_DEADLINE_PROMPT,
  continueCreateEventFlow,
  setCreateEventMessageSender,
} from '../src/commands/createEventFlow.js';
import {
  EVENT_IMAGE_MAX_UPLOAD_BYTES,
  EventImageError,
  detectEventImageKind,
  eventImageFilePath,
  optimizeEventImage,
  readEventImageFile,
  saveOptimizedEventImage,
} from '../src/events/image.js';
import {
  CHANGE_IMAGE,
  EDIT_EVENT,
  IMAGE_KEEP,
  IMAGE_REMOVE,
  IMAGE_REPLACE,
  handleEventUpdateCommand,
  setEventUpdateMessageSender,
} from '../src/commands/eventUpdateFlow.js';
import {
  eventImageRouter,
  setEventImageMessageSender,
} from '../src/http/eventImage.js';
import { eventImagePickerPath } from '../src/http/eventImageToken.js';
import { renderRsvpPage } from '../src/http/rsvpPage.js';
import { shortRsvpRouter } from '../src/http/shortRsvp.js';
import type { SendMessageParams } from '../src/zernio/client.js';

process.env.DATABASE_PATH = ':memory:';

/** Those two tests freeze `new Date()` so Sep 20 stays in the RSVP-deadline window. */
const FIXED_NOW_MS = Date.parse('2026-09-05T16:00:00.000Z');
process.env.WEBHOOK_SECRET = 'event-image-test-secret';

const PHONE = '+15551116666';
const ctx = {
  phone: PHONE,
  conversationId: 'conv-image',
  accountId: 'acct-image',
};

const sent: SendMessageParams[] = [];

function lastMessage(): SendMessageParams {
  const message = sent.at(-1);
  assert.ok(message, 'expected a reply');
  return message;
}

async function tinyPng(width = 32, height = 24): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 180, g: 40, b: 60 },
    },
  })
    .png()
    .toBuffer();
}

function withImageServer(fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(eventImageRouter);
  app.use(shortRsvpRouter);
  const server = http.createServer(app);
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('no listen address'));
        return;
      }
      const baseUrl = `http://127.0.0.1:${address.port}`;
      fn(baseUrl)
        .then(resolve, reject)
        .finally(() => {
          server.close();
        });
    });
  });
}

test.beforeEach(() => {
  getDb();
  sent.length = 0;
  setCreateEventMessageSender(async (params) => {
    sent.push(params);
  });
  setEventUpdateMessageSender(async (params) => {
    sent.push(params);
  });
  setEventImageMessageSender(async (params) => {
    sent.push(params);
  });
  upsertMessageSession(PHONE, ctx.conversationId, ctx.accountId);
});

test.afterEach(() => {
  setCreateEventMessageSender();
  setEventUpdateMessageSender();
  setEventImageMessageSender();
  closeDb();
});

test('event creation with no image still works', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: FIXED_NOW_MS });
  setConversationState(PHONE, 'WAITING_FOR_EVENT_IMAGE', {
    name: 'Picnic',
    date: 'Sunday, September 20, 2026 at 7:30 PM',
    location: 'Park',
  });

  await continueCreateEventFlow(
    {
      ...ctx,
      interactiveId: IMAGE_SKIP,
      interactiveType: 'button_reply',
    },
    '⏭️ Skip',
  );

  const state = getConversationState(PHONE);
  assert.equal(state?.state, 'WAITING_FOR_RSVP_DEADLINE');
  assert.equal(state?.image_filename ?? null, null);
  assert.equal(lastMessage().message, RSVP_DEADLINE_PROMPT);

  const event = createEvent('Picnic', 'Sunday, September 20, 2026 at 7:30 PM', 'Park', PHONE);
  assert.equal(event.image_filename ?? null, null);
  const html = renderRsvpPage(event, {
    askCounts: false,
    adults: 1,
    children: 0,
    maxGuests: null,
    childrenAllowed: true,
  });
  assert.match(html, /You're Invited!/);
  assert.doesNotMatch(html, /<img class="event-photo"/);
  assert.doesNotMatch(html, /\/i\//);
});

test('Choose from Phone sends a signed upload link and stays on the image step', async () => {
  setConversationState(PHONE, 'WAITING_FOR_EVENT_IMAGE', {
    name: 'Wedding',
    date: 'Sunday, September 20, 2026 at 7:30 PM',
    location: 'Hall',
  });

  await continueCreateEventFlow(
    {
      ...ctx,
      interactiveId: IMAGE_CHOOSE,
      interactiveType: 'button_reply',
    },
    'Choose from Phone',
  );

  assert.equal(getConversationState(PHONE)?.state, 'WAITING_FOR_EVENT_IMAGE');
  assert.match(lastMessage().message, /\/p\//);
  assert.match(lastMessage().message, /choose a photo/i);
  assert.equal(lastMessage().message.includes(EVENT_IMAGE_PROMPT.split('\n')[0]), false);
});

test('invalid file type is rejected', async () => {
  await assert.rejects(
    () => optimizeEventImage(Buffer.from('not-an-image')),
    (error: unknown) => {
      assert.ok(error instanceof EventImageError);
      assert.equal(error.code, 'invalid_type');
      return true;
    },
  );
  assert.equal(detectEventImageKind(Buffer.from('GIF89a')), null);
});

test('image larger than 20 MB is rejected', async () => {
  const huge = Buffer.alloc(EVENT_IMAGE_MAX_UPLOAD_BYTES + 1, 0xff);
  huge[0] = 0xff;
  huge[1] = 0xd8;
  huge[2] = 0xff;
  await assert.rejects(
    () => optimizeEventImage(huge),
    (error: unknown) => {
      assert.ok(error instanceof EventImageError);
      assert.equal(error.code, 'too_large');
      return true;
    },
  );
});

test('optimization resizes wide images and stores webp', async () => {
  const original = await sharp({
    create: {
      width: 2400,
      height: 800,
      channels: 3,
      background: { r: 20, g: 80, b: 160 },
    },
  })
    .png()
    .toBuffer();
  const optimized = await optimizeEventImage(original);
  const meta = await sharp(optimized).metadata();
  assert.equal(meta.format, 'webp');
  assert.ok((meta.width ?? 0) <= 1600);
  assert.ok(optimized.length < original.length);
  assert.ok(optimized.length < 2 * 1024 * 1024);
});

test('event image is associated with the correct event and served on the RSVP page', async () => {
  const filenameA = await saveOptimizedEventImage(await tinyPng(64, 40));
  const filenameB = await saveOptimizedEventImage(await tinyPng(48, 48));
  const eventA = createEvent('A Party', 'May 1', 'Hall', PHONE, {
    imageFilename: filenameA,
  });
  const eventB = createEvent('B Party', 'May 2', 'Park', PHONE, {
    imageFilename: filenameB,
  });
  assert.equal(getEventById(eventA.id)?.image_filename, filenameA);
  assert.equal(getEventById(eventB.id)?.image_filename, filenameB);
  assert.notEqual(eventA.rsvp_token, eventB.rsvp_token);
  assert.notEqual(filenameA, filenameB);

  const htmlA = renderRsvpPage(eventA, {
    askCounts: false,
    adults: 1,
    children: 0,
    maxGuests: null,
    childrenAllowed: true,
  });
  const htmlB = renderRsvpPage(eventB, {
    askCounts: false,
    adults: 1,
    children: 0,
    maxGuests: null,
    childrenAllowed: true,
  });
  assert.match(htmlA, new RegExp(`/i/${eventA.rsvp_token}`));
  assert.doesNotMatch(htmlA, new RegExp(eventB.rsvp_token));
  assert.match(htmlB, new RegExp(`/i/${eventB.rsvp_token}`));

  await withImageServer(async (baseUrl) => {
    const resA = await fetch(`${baseUrl}/i/${eventA.rsvp_token}`);
    const resB = await fetch(`${baseUrl}/i/${eventB.rsvp_token}`);
    const resWrong = await fetch(`${baseUrl}/i/${eventA.rsvp_token}zz`);
    const resNone = await fetch(
      `${baseUrl}/i/${createEvent('No Photo', 'May 3', 'Yard', PHONE).rsvp_token}`,
    );
    const bytesA = Buffer.from(await resA.arrayBuffer());
    const bytesB = Buffer.from(await resB.arrayBuffer());
    assert.equal(resA.status, 200);
    assert.equal(resB.status, 200);
    assert.equal(resA.headers.get('content-type'), 'image/webp');
    assert.notDeepEqual(bytesA, bytesB);
    assert.equal(resWrong.status, 404);
    assert.equal(resNone.status, 404);

    const pathAttack = await fetch(`${baseUrl}/i/${encodeURIComponent('../' + filenameA)}`);
    assert.equal(pathAttack.status, 404);
    assert.equal(eventImageFilePath('../secret.webp'), null);
    assert.equal(eventImageFilePath(filenameA)?.endsWith(filenameA), true);
  });
});

test('upload page preview, skip, invalid type, oversize, and continue', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: FIXED_NOW_MS });
  setConversationState(PHONE, 'WAITING_FOR_EVENT_IMAGE', {
    name: 'Wedding',
    date: 'Sunday, September 20, 2026 at 7:30 PM',
    location: 'Hall',
  });
  const path = eventImagePickerPath(PHONE);

  await withImageServer(async (baseUrl) => {
    const page = await fetch(`${baseUrl}${path}`);
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(html, /Event Image|Add a photo/);
    assert.match(html, /Choose from Phone/);
    assert.match(html, /type="file"/);
    assert.match(html, /accept="image\/jpeg,image\/jpg,image\/png,image\/webp"/);

    const gif = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      body: (() => {
        const form = new FormData();
        form.append('action', 'save');
        form.append(
          'image',
          new Blob([Buffer.from('GIF89a........')], { type: 'image/gif' }),
          'x.gif',
        );
        return form;
      })(),
    });
    assert.match(await gif.text(), /JPG, JPEG, PNG, or WEBP/i);
    assert.equal(getConversationState(PHONE)?.state, 'WAITING_FOR_EVENT_IMAGE');

    const oversize = Buffer.alloc(EVENT_IMAGE_MAX_UPLOAD_BYTES + 1024, 1);
    oversize[0] = 0xff;
    oversize[1] = 0xd8;
    oversize[2] = 0xff;
    const tooBig = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      body: (() => {
        const form = new FormData();
        form.append('action', 'save');
        form.append(
          'image',
          new Blob([new Uint8Array(oversize)], { type: 'image/jpeg' }),
          'big.jpg',
        );
        return form;
      })(),
    });
    assert.match(await tooBig.text(), /20 MB/);
    assert.equal(getConversationState(PHONE)?.state, 'WAITING_FOR_EVENT_IMAGE');

    const png = await tinyPng(200, 120);
    const saved = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      body: (() => {
        const form = new FormData();
        form.append('action', 'save');
        form.append(
          'image',
          new Blob([new Uint8Array(png)], { type: 'image/png' }),
          'photo.png',
        );
        return form;
      })(),
    });
    assert.equal(saved.status, 200);
    assert.match(await saved.text(), /Photo saved/);
    const after = getConversationState(PHONE);
    assert.equal(after?.state, 'WAITING_FOR_RSVP_DEADLINE');
    assert.ok(after?.image_filename);
    assert.equal(lastMessage().message, RSVP_DEADLINE_PROMPT);
  });
});

test('unauthorized image and preview access is rejected', async () => {
  setConversationState(PHONE, 'WAITING_FOR_EVENT_IMAGE', {
    name: 'Wedding',
    date: 'Sunday, September 20, 2026 at 7:30 PM',
    location: 'Hall',
  });
  const path = eventImagePickerPath(PHONE);
  await withImageServer(async (baseUrl) => {
    const expired = await fetch(`${baseUrl}/p/not-a-code`);
    assert.equal(expired.status, 404);
    const preview = await fetch(`${baseUrl}${path}/preview`);
    assert.equal(preview.status, 404);
    const otherPhone = await fetch(`${baseUrl}/photo/tampered.token`);
    assert.equal(otherPhone.status, 404);
  });
});

test('existing short RSVP links still work for events without an image', async () => {
  const event = createEvent('Dinner', 'June 1', 'Home', PHONE);
  assert.ok(event.short_code);
  await withImageServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/r/${event.short_code}`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /You're Invited!/);
    assert.doesNotMatch(html, /<img class="event-photo"/);
    assert.ok(lookupRsvpLinkTarget(event.rsvp_code)?.event.id === event.id);
  });
});

function tap(payload: string) {
  return {
    phone: PHONE,
    text: payload,
    conversationId: ctx.conversationId,
    accountId: ctx.accountId,
    buttonPayload: payload,
    interactiveId: payload,
    interactiveType: 'button_reply' as const,
  };
}

test('abandoned draft images are deleted; saved event images are kept', async () => {
  const orphan = await saveOptimizedEventImage(await tinyPng());
  assert.ok(readEventImageFile(orphan));
  const removed = sweepAbandonedEventImages();
  assert.ok(removed.includes(orphan));
  assert.equal(readEventImageFile(orphan), null);

  const draft = await saveOptimizedEventImage(await tinyPng());
  setConversationState(PHONE, 'WAITING_FOR_EVENT_IMAGE', {
    name: 'Draft',
    date: 'Sunday, September 20, 2026 at 7:30 PM',
    location: 'Hall',
    image_filename: draft,
  });
  assert.equal(sweepAbandonedEventImages().includes(draft), false);
  assert.ok(readEventImageFile(draft));

  getDb()
    .prepare(
      `UPDATE conversation_states SET updated_at = datetime('now', '-2 days') WHERE organizer_phone = ?`,
    )
    .run(PHONE);
  assert.ok(sweepAbandonedEventImages().includes(draft));
  assert.equal(readEventImageFile(draft), null);
  assert.equal(getConversationState(PHONE)?.image_filename ?? null, null);

  const savedFile = await saveOptimizedEventImage(await tinyPng());
  const event = createEvent('Kept', 'May 1', 'Hall', PHONE, {
    imageFilename: savedFile,
  });
  setConversationState(PHONE, 'WAITING_FOR_EVENT_IMAGE', {
    name: event.name,
    date: event.date,
    location: event.location,
    image_filename: savedFile,
  });
  getDb()
    .prepare(
      `UPDATE conversation_states SET updated_at = datetime('now', '-2 days') WHERE organizer_phone = ?`,
    )
    .run(PHONE);
  assert.equal(sweepAbandonedEventImages().includes(savedFile), false);
  assert.ok(readEventImageFile(savedFile));
  assert.equal(getEventById(event.id)?.image_filename, savedFile);

  clearConversationState(PHONE);
  assert.ok(readEventImageFile(savedFile));
  assert.equal(eventImageFilePath(savedFile)?.endsWith(savedFile), true);
});

test('clearing an unfinished create deletes the draft image only', async () => {
  const draft = await saveOptimizedEventImage(await tinyPng());
  const savedFile = await saveOptimizedEventImage(await tinyPng());
  createEvent('Live', 'May 1', 'Hall', PHONE, { imageFilename: savedFile });
  setConversationState(PHONE, 'WAITING_FOR_EVENT_IMAGE', {
    name: 'Unfinished',
    date: 'Sunday, September 20, 2026 at 7:30 PM',
    location: 'Hall',
    image_filename: draft,
  });
  clearConversationState(PHONE);
  assert.equal(readEventImageFile(draft), null);
  assert.ok(readEventImageFile(savedFile));
});

test('edit event can keep, replace, or remove the image', async () => {
  const original = await saveOptimizedEventImage(await tinyPng(40, 30));
  const event = createEvent('Gala', 'Dec 1', 'Hotel', PHONE, {
    imageFilename: original,
  });

  await handleEventUpdateCommand(tap(`${EDIT_EVENT} ${event.id}`), `${EDIT_EVENT} ${event.id}`);
  assert.ok(
    lastMessage().list?.sections[0].rows.some((row) => row.title === 'Event Image'),
  );

  await handleEventUpdateCommand(
    tap(`${CHANGE_IMAGE} ${event.id}`),
    `${CHANGE_IMAGE} ${event.id}`,
  );
  assert.match(lastMessage().message, /Event Image/);
  assert.deepEqual(
    lastMessage().buttons?.map((button) => button.payload),
    [IMAGE_KEEP, IMAGE_REPLACE, IMAGE_REMOVE],
  );

  await handleEventUpdateCommand(tap(IMAGE_KEEP), IMAGE_KEEP);
  assert.equal(getEventById(event.id)?.image_filename, original);
  assert.ok(readEventImageFile(original));
  assert.match(lastMessage().message, /Event Image: Added/);

  await handleEventUpdateCommand(
    tap(`${CHANGE_IMAGE} ${event.id}`),
    `${CHANGE_IMAGE} ${event.id}`,
  );
  const path = eventImagePickerPath(PHONE);
  await withImageServer(async (baseUrl) => {
    const png = await tinyPng(80, 50);
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      body: (() => {
        const form = new FormData();
        form.append('action', 'save');
        form.append(
          'image',
          new Blob([new Uint8Array(png)], { type: 'image/png' }),
          'next.png',
        );
        return form;
      })(),
    });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Photo updated/);
  });
  const replaced = getEventById(event.id);
  assert.ok(replaced?.image_filename);
  assert.notEqual(replaced?.image_filename, original);
  assert.equal(readEventImageFile(original), null);
  assert.ok(replaced?.image_filename && readEventImageFile(replaced.image_filename));

  await handleEventUpdateCommand(
    tap(`${CHANGE_IMAGE} ${event.id}`),
    `${CHANGE_IMAGE} ${event.id}`,
  );
  await handleEventUpdateCommand(tap(IMAGE_REMOVE), IMAGE_REMOVE);
  assert.equal(getEventById(event.id)?.image_filename ?? null, null);
  assert.equal(
    replaced?.image_filename ? readEventImageFile(replaced.image_filename) : 'missing',
    null,
  );
  assert.doesNotMatch(lastMessage().message, /Event Image: Added/);
});

test('edit keep on an event without an image leaves it empty', async () => {
  const event = createEvent('Picnic', 'May 1', 'Park', PHONE);
  await handleEventUpdateCommand(
    tap(`${CHANGE_IMAGE} ${event.id}`),
    `${CHANGE_IMAGE} ${event.id}`,
  );
  await handleEventUpdateCommand(tap(IMAGE_KEEP), IMAGE_KEEP);
  assert.equal(getEventById(event.id)?.image_filename ?? null, null);
  const html = renderRsvpPage(getEventById(event.id)!, {
    askCounts: false,
    adults: 1,
    children: 0,
    maxGuests: null,
    childrenAllowed: true,
  });
  assert.doesNotMatch(html, /<img class="event-photo"/);
});

