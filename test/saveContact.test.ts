import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONNECT_VCARD_FILENAME,
  CONNECT_VCARD_PATH,
  GUEST_RSVP_THANK_YOU,
  ORGANIZER_POST_EVENT_MESSAGE,
  SAVE_CONNECT_CONTACT,
  buildConnectVCard,
  handleSaveConnectContact,
  isSaveConnectContactCommand,
  sendSaveConnectContactWaMeFallback,
  sendSaveContactPrompt,
} from '../src/commands/saveContact.js';

test('guest RSVP thank-you matches product copy', () => {
  assert.equal(
    GUEST_RSVP_THANK_YOU,
    `✅ Thank you! Your RSVP has been recorded.

Please save our number to your contacts so you can easily find CONNECT when you need it.

Powered by zipbite`,
  );
});

test('organizer post-event message matches product copy', () => {
  assert.equal(
    ORGANIZER_POST_EVENT_MESSAGE,
    `🎉 Thank you for using CONNECT!

We hope your event was wonderful and memorable.

Keep our number saved for your next event.

Powered by zipbite`,
  );
});

test('isSaveConnectContactCommand recognizes payload case-insensitively', () => {
  assert.equal(isSaveConnectContactCommand(SAVE_CONNECT_CONTACT), true);
  assert.equal(isSaveConnectContactCommand('save_connect_contact'), true);
  assert.equal(isSaveConnectContactCommand('  SAVE_CONNECT_CONTACT  '), true);
  assert.equal(isSaveConnectContactCommand('VIEW_OPTIONS'), false);
});

test('legacy save-contact helpers do not send a contact card', async () => {
  const ctx = { conversationId: 'conv', accountId: 'acct' };
  await sendSaveContactPrompt(ctx);
  await handleSaveConnectContact(ctx);
  await sendSaveConnectContactWaMeFallback(ctx);
});

test('CONNECT vCard uses the configured WhatsApp business number', () => {
  const previous = process.env.WHATSAPP_BUSINESS_PHONE;
  process.env.WHATSAPP_BUSINESS_PHONE = '+15551234567';
  try {
    const vcard = buildConnectVCard();
    assert.ok(vcard);
    assert.match(vcard, /BEGIN:VCARD/);
    assert.match(vcard, /FN:CONNECT/);
    assert.match(vcard, /TEL;TYPE=CELL,VOICE:\+15551234567/);
    assert.match(vcard, /END:VCARD/);
    assert.equal(CONNECT_VCARD_PATH, '/connect.vcf');
    assert.equal(CONNECT_VCARD_FILENAME, 'CONNECT.vcf');
  } finally {
    if (previous == null) {
      delete process.env.WHATSAPP_BUSINESS_PHONE;
    } else {
      process.env.WHATSAPP_BUSINESS_PHONE = previous;
    }
  }
});

