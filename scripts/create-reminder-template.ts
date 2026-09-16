import 'dotenv/config';
import { assertConfigForZernioScripts, config } from '../src/config.js';
import { getZernioClient } from '../src/zernio/client.js';

const REMINDER_TEMPLATE_NAME = 'event_rsvp_reminder';
const REMINDER_BODY =
  'A quick reminder 👋\n\nYour RSVP is still pending for:\n\n{{1}}\n📅 {{2}}\n\nRSVP deadline: {{3}}\n\nPlease respond before the deadline.\n\nReply RSVP {{4}} or tap a button below.';

async function main(): Promise<void> {
  assertConfigForZernioScripts();

  const zernio = getZernioClient();
  const templateName = config.reminderTemplateName || REMINDER_TEMPLATE_NAME;

  console.log(`Creating reminder template "${templateName}"...`);

  try {
    const { data } = await zernio.whatsapp.createWhatsAppTemplate({
      body: {
        accountId: config.zernioWhatsappAccountId,
        name: templateName,
        language: config.reminderTemplateLanguage,
        category: 'UTILITY',
        components: [
          {
            type: 'body',
            text: REMINDER_BODY,
            example: {
              body_text: [
                ['Wedding', 'June 15 7pm', 'June 10 5pm', 'ABC12XY3'],
              ],
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

    console.log('Reminder template submitted for Meta review:');
    console.log(JSON.stringify(data.template, null, 2));
    console.log('\nApproval can take up to 24 hours.');
    console.log(
      'After approval, set REMINDER_TEMPLATE_NAME in Railway and redeploy.',
    );
    console.log('Check status: npm run setup:reminder-template -- --check');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('already exists') || message.includes('409')) {
      console.log('Template already exists. Checking status...');
      await checkTemplateStatus(zernio, templateName);
      return;
    }
    throw error;
  }
}

async function checkTemplateStatus(
  zernio: ReturnType<typeof getZernioClient>,
  templateName: string,
): Promise<void> {
  const { data } = await zernio.whatsapp.getWhatsAppTemplates({
    query: { accountId: config.zernioWhatsappAccountId },
  });

  const templates =
    (data as {
      templates?: Array<{ name: string; status: string; language: string }>;
    }).templates ?? data;
  const match = Array.isArray(templates)
    ? templates.find(
        (t) =>
          t.name === templateName &&
          t.language === config.reminderTemplateLanguage,
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
  const templateName = config.reminderTemplateName || REMINDER_TEMPLATE_NAME;
  await checkTemplateStatus(getZernioClient(), templateName);
} else {
  await main();
}
