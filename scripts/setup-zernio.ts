import 'dotenv/config';
import { config, assertConfigForZernioScripts } from '../src/config.js';

function main(): void {
  console.log('=== Zernio Setup Check ===\n');

  const checks: Array<{ name: string; ok: boolean; hint?: string }> = [
    {
      name: 'ZERNIO_API_KEY',
      ok: Boolean(config.zernioApiKey),
      hint: 'Get from Zernio dashboard → Settings → API Keys',
    },
    {
      name: 'ZERNIO_PROFILE_ID',
      ok: Boolean(config.zernioProfileId),
      hint: 'Create a profile via dashboard or POST /v1/profiles',
    },
    {
      name: 'ZERNIO_WHATSAPP_ACCOUNT_ID',
      ok: Boolean(config.zernioWhatsappAccountId),
      hint: 'Connect WhatsApp via GET /v1/connect/whatsapp?profileId=...',
    },
    {
      name: 'WEBHOOK_SECRET',
      ok: Boolean(config.webhookSecret),
      hint: 'Generate a random string for HMAC verification',
    },
    {
      name: 'ORGANIZER_PHONE',
      ok: Boolean(config.organizerPhone),
      hint: 'Your phone in E.164 format, e.g. +15551234567',
    },
  ];

  for (const check of checks) {
    const status = check.ok ? '✅' : '❌';
    console.log(`${status} ${check.name}`);
    if (!check.ok && check.hint) {
      console.log(`   → ${check.hint}`);
    }
  }

  console.log('\n--- Setup Steps ---\n');
  console.log('1. Sign up: https://zernio.com/signup');
  console.log('2. Connect WhatsApp Business Account (Embedded Signup)');
  console.log('3. Provision a dedicated WhatsApp number (~$3/mo US)');
  console.log('4. Copy API key, profile ID, and account ID to .env');
  console.log('5. Run: npm run setup:template');
  console.log('6. Deploy server and run: npm run setup:webhook');
  console.log('7. Text HELP to your WhatsApp business number\n');

  if (config.zernioApiKey && config.zernioProfileId) {
    console.log('Connect URL (open in browser):');
    console.log(
      `https://zernio.com/api/v1/connect/whatsapp?profileId=${config.zernioProfileId}`,
    );
    console.log('\nOr with curl:');
    console.log(
      `curl "https://zernio.com/api/v1/connect/whatsapp?profileId=${config.zernioProfileId}" \\\n  -H "Authorization: Bearer ${config.zernioApiKey.slice(0, 8)}..."`,
    );
  }

  try {
    assertConfigForZernioScripts();
    console.log('\n✅ Minimum Zernio config present for API scripts.');
  } catch {
    console.log('\n⚠️  Copy .env.example to .env and fill in values.');
    process.exit(1);
  }
}

main();
