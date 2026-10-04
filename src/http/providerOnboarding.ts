import { Router } from 'express';
import {
  providerOnboardingWhatsAppUrl,
  publicProviderOnboardingWhatsAppUrl,
  validateProviderOnboardingToken,
} from '../vendors/onboarding.js';

export const providerOnboardingRouter = Router();

providerOnboardingRouter.get('/provider/start', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  const whatsappUrl = publicProviderOnboardingWhatsAppUrl();
  if (whatsappUrl) {
    res.redirect(302, whatsappUrl);
    return;
  }
  res.status(503).type('html').send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Become a ZipBite Provider</title>
  <style>
    body{font-family:system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#f7f5ef;color:#17221b}
    main{text-align:center;padding:2rem}
    a{display:inline-block;margin-top:1rem;padding:.9rem 1.25rem;border-radius:.75rem;background:#d9d9d9;color:#555;text-decoration:none;pointer-events:none}
  </style>
</head>
<body><main>
  <h1>Become a ZipBite Provider</h1>
  <p>Start your setup on WhatsApp</p>
  <a href="#" aria-disabled="true">Start on WhatsApp</a>
</main></body>
</html>`);
});

providerOnboardingRouter.get('/provider/onboard/:token', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  const token = String(req.params.token ?? '');
  if (!validateProviderOnboardingToken(token)) {
    res.status(404).type('html').send(
      '<!doctype html><title>Link unavailable</title><h1>Onboarding link unavailable</h1><p>This link is invalid, expired, or already completed.</p>',
    );
    return;
  }
  const whatsappUrl = providerOnboardingWhatsAppUrl(token);
  if (!whatsappUrl) {
    res.status(503).type('html').send(
      '<!doctype html><title>WhatsApp unavailable</title><h1>WhatsApp unavailable</h1><p>ZipBite WhatsApp is not configured for onboarding.</p>',
    );
    return;
  }
  res.redirect(302, whatsappUrl);
});
