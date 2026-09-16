import 'dotenv/config';
import { assertConfigForZernioScripts, config } from '../src/config.js';
import { getZernioClient } from '../src/zernio/client.js';

async function main(): Promise<void> {
  assertConfigForZernioScripts();

  const zernio = getZernioClient();

  console.log(`Creating template "${config.rsvpTemplateName}"...`);

  try {
    const { data } = await zernio.whatsapp.createWhatsAppTemplate({
      body: {
        accountId: config.zernioWhatsappAccountId,
        name: config.rsvpTemplateName,
        language: config.rsvpTemplateLanguage,
        category: 'UTILITY',
        components: [
          {
            type: 'body',
            text: "You're invited to {{1}}!\n\n📅 {{2}}\n📍 {{3}}\n\nTap a button below to RSVP, or reply YES / NO / MAYBE.",
            example: {
              body_text: [['Wedding', 'June 15 7pm', '123 Main St']],
            },
          },
          {
            type: 'buttons',
            buttons: [
              { type: 'quick_reply', text: 'Yes' },
              { type: 'quick_reply', text: 'No' },
              { type: 'quick_reply', text: 'Maybe' },
            ],
          },
        ],
      },
    });

    console.log('Template submitted for Meta review:');
    console.log(JSON.stringify(data.template, null, 2));
    console.log('\nApproval can take up to 24 hours.');
    console.log('Check status: npm run setup:template -- --check');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('already exists') || message.includes('409')) {
      console.log('Template already exists. Checking status...');
      await checkTemplateStatus(zernio);
      return;
    }
    throw error;
  }
}

async function checkTemplateStatus(
  zernio: ReturnType<typeof getZernioClient>,
): Promise<void> {
  const { data } = await zernio.whatsapp.getWhatsAppTemplates({
    query: { accountId: config.zernioWhatsappAccountId },
  });

  const templates = (data as { templates?: Array<{ name: string; status: string; language: string }> }).templates ?? data;
  const match = Array.isArray(templates)
    ? templates.find(
        (t) =>
          t.name === config.rsvpTemplateName &&
          t.language === config.rsvpTemplateLanguage,
      )
    : undefined;

  if (match) {
    console.log(`Template "${match.name}" (${match.language}): ${match.status}`);
  } else {
    console.log('Template not found. Run without --check to create it.');
  }
}

if (process.argv.includes('--check')) {
  assertConfigForZernioScripts();
  await checkTemplateStatus(getZernioClient());
} else {
  await main();
}
