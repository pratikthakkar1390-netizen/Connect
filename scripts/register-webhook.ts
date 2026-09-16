import 'dotenv/config';
import { config } from '../src/config.js';
import { getZernioClient } from '../src/zernio/client.js';

async function main(): Promise<void> {
  if (!config.zernioApiKey) {
    throw new Error('ZERNIO_API_KEY is required');
  }
  if (!config.publicWebhookUrl) {
    throw new Error('PUBLIC_WEBHOOK_URL is required (e.g. https://your-app.railway.app)');
  }
  if (!config.webhookSecret) {
    throw new Error('WEBHOOK_SECRET is required');
  }

  const webhookUrl = `${config.publicWebhookUrl.replace(/\/$/, '')}/webhooks/zernio`;
  const zernio = getZernioClient();

  console.log(`Registering webhook: ${webhookUrl}`);

  const { data } = await zernio.webhooks.createWebhookSettings({
    body: {
      name: 'rsvp-handler',
      url: webhookUrl,
      events: ['message.received'],
      secret: config.webhookSecret,
    },
  });

  console.log('Webhook registered:');
  console.log(JSON.stringify(data, null, 2));
  console.log('\nTest with: curl', config.publicWebhookUrl.replace(/\/$/, ''), '/health');
}

main().catch((error) => {
  console.error('Failed to register webhook:', error);
  process.exit(1);
});
