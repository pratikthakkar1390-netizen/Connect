import type { CommandContext } from '../commands/organizer.js';
import { getDb } from '../db/store.js';
import type { InboxListSection } from '../zernio/client.js';
import { interactiveCommandInput } from '../whatsapp/eventList.js';
import {
  claimProviderOnboardingSession,
  completeProviderOnboardingSession,
  getActiveProviderOnboardingSession,
  getProviderOnboardingSessionByToken,
  parseProviderOnboardingDraft,
  PUBLIC_PROVIDER_ONBOARDING_MESSAGE,
  saveProviderOnboardingSession,
  startPublicProviderOnboardingSession,
  type ProviderOnboardingDraft,
  type ProviderOnboardingSession,
  type ProviderOnboardingStep,
} from './onboarding.js';
import {
  completeVendorOnboarding,
  createVendor,
  getVendorByWhatsAppPhone,
  setVendorAvailability,
} from './store.js';

type ProviderReply = (
  message: string,
  buttons?: Array<{ title: string; payload: string }>,
  list?: { button: string; sections: InboxListSection[] },
) => Promise<boolean>;

const TOKEN_RE =
  /^(?:ZIPBITE|CONNECT)\s+PROVIDER\s+([A-Za-z0-9_-]{40,64})$/i;
const MAX_TEXT_LENGTH = 500;
const PROVIDER_ONBOARDING_WELCOME =
  "🍱 Welcome to ZipBite!\nLet's get your food business set up.";
const GREETINGS = new Set([
  'HI',
  'HELLO',
  'HEY',
  'START',
  'GOOD MORNING',
  'GOOD EVENING',
]);

const PROVIDER_TYPES = new Map([
  ['PROVIDER_TYPE_TIFFIN', 'TIFFIN'],
  ['PROVIDER_TYPE_MEALS', 'HOMEMADE_MEALS'],
  ['PROVIDER_TYPE_SWEETS', 'SWEETS'],
  ['PROVIDER_TYPE_SNACKS', 'SNACKS'],
  ['PROVIDER_TYPE_OTHER', 'OTHER'],
]);

const MENU_METHODS = new Map([
  ['PROVIDER_MENU_PHOTOS', 'PHOTOS'],
  ['PROVIDER_MENU_PDF', 'PDF'],
  ['PROVIDER_MENU_MANUAL', 'MANUAL'],
]);

const ORDERING_FREQUENCIES = new Map([
  ['PROVIDER_FREQ_DAILY', 'DAILY'],
  ['PROVIDER_FREQ_WEEKLY', 'WEEKLY'],
  ['PROVIDER_FREQ_OCCASIONAL', 'OCCASIONAL'],
  ['PROVIDER_FREQ_CUSTOM', 'CUSTOM'],
]);

const PAYMENT_METHODS = new Map([
  ['PROVIDER_PAY_COD', 'COD'],
  ['PROVIDER_PAY_FIRST', 'PAY_FIRST'],
  ['PROVIDER_PAY_BOTH', 'BOTH'],
]);

const CHOICE_LABELS: Record<string, string> = {
  TIFFIN: 'Tiffin',
  HOMEMADE_MEALS: 'Homemade Meals',
  SWEETS: 'Sweets',
  SNACKS: 'Snacks',
  OTHER: 'Other',
  PHOTOS: 'Photos',
  PDF: 'PDF',
  MANUAL: 'Manual',
  DAILY: 'Daily',
  WEEKLY: 'Weekly',
  OCCASIONAL: 'Occasional / Pre-order',
  CUSTOM: 'Custom',
  COD: 'COD',
  PAY_FIRST: 'Pay First',
  BOTH: 'Both',
};

function choiceLabel(value: string | undefined): string {
  return value ? CHOICE_LABELS[value] ?? value : '—';
}

function compactInput(ctx: CommandContext): string {
  return interactiveCommandInput(ctx).trim().toUpperCase().replace(/\s+/g, '_');
}

export function providerOnboardingToken(input: string): string | null {
  return input.trim().match(TOKEN_RE)?.[1] ?? null;
}

export function isPublicProviderOnboardingIntent(input: string): boolean {
  const normalized = input
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
  const expected = PUBLIC_PROVIDER_ONBOARDING_MESSAGE
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
  return normalized === expected;
}

export function shouldHandleProviderOnboarding(
  phone: string,
  input: string,
): boolean {
  return Boolean(
    providerOnboardingToken(input) ||
      isPublicProviderOnboardingIntent(input) ||
      getActiveProviderOnboardingSession(phone),
  );
}

function maskPhone(phone: string): string {
  return phone.length <= 6
    ? phone
    : `${phone.slice(0, 3)}••••${phone.slice(-4)}`;
}

function validText(value: string, minimum = 2): boolean {
  return value.length >= minimum && value.length <= MAX_TEXT_LENGTH;
}

function save(
  session: ProviderOnboardingSession,
  step: ProviderOnboardingStep,
  draft: ProviderOnboardingDraft,
): ProviderOnboardingSession {
  const updated = saveProviderOnboardingSession({
    sessionId: session.id,
    phone: session.expected_phone,
    step,
    draft,
  });
  if (!updated) {
    throw new Error('Provider onboarding session is no longer available.');
  }
  return updated;
}

async function promptForStep(
  session: ProviderOnboardingSession,
  reply: ProviderReply,
): Promise<void> {
  const draft = parseProviderOnboardingDraft(session);
  switch (session.step) {
    case 'BUSINESS_NAME':
      await reply('What is your business name?');
      return;
    case 'OWNER_NAME':
      await reply('What is the provider or owner name?');
      return;
    case 'CONFIRM_PHONE':
      await reply(
        `Please confirm this WhatsApp number for your business: ${maskPhone(
          session.expected_phone,
        )}`,
        [
          { title: 'Confirm number', payload: 'PROVIDER_PHONE_CONFIRM' },
          { title: 'Cancel', payload: 'PROVIDER_ONBOARDING_CANCEL' },
        ],
      );
      return;
    case 'PICKUP_LOCATION':
      await reply('What is the pickup location or business address?');
      return;
    case 'PROVIDER_TYPE':
      await reply('Choose your provider type.', undefined, {
        button: 'Provider type',
        sections: [
          {
            title: 'Provider type',
            rows: [...PROVIDER_TYPES].map(([id, value]) => ({
              id,
              title: choiceLabel(value),
            })),
          },
        ],
      });
      return;
    case 'MENU_METHOD':
      await reply('How would you like to provide your menu?', [
        { title: 'Photos', payload: 'PROVIDER_MENU_PHOTOS' },
        { title: 'PDF', payload: 'PROVIDER_MENU_PDF' },
        { title: 'Enter manually', payload: 'PROVIDER_MENU_MANUAL' },
      ]);
      return;
    case 'ORDERING_FREQUENCY':
      await reply('How do customers usually order from you?', undefined, {
        button: 'Ordering type',
        sections: [
          {
            title: 'Ordering frequency',
            rows: [...ORDERING_FREQUENCIES].map(([id, value]) => ({
              id,
              title: choiceLabel(value),
            })),
          },
        ],
      });
      return;
    case 'PAYMENT_METHOD':
      await reply('Which payment method do you support?', [
        { title: 'COD', payload: 'PROVIDER_PAY_COD' },
        { title: 'Pay First', payload: 'PROVIDER_PAY_FIRST' },
        { title: 'Both', payload: 'PROVIDER_PAY_BOTH' },
      ]);
      return;
    case 'AVAILABILITY':
      await reply(
        'Share your pickup and availability information (days, hours, and any advance notice needed).',
      );
      return;
    case 'REVIEW':
      await reply(providerSummary(session.expected_phone, draft), [
        { title: 'Confirm', payload: 'PROVIDER_ONBOARDING_CONFIRM' },
        { title: 'Start over', payload: 'PROVIDER_ONBOARDING_RESTART' },
        { title: 'Cancel', payload: 'PROVIDER_ONBOARDING_CANCEL' },
      ]);
      return;
    default:
      await reply('This onboarding link is not available.');
  }
}

function providerSummary(
  phone: string,
  draft: ProviderOnboardingDraft,
): string {
  return [
    'Please review your provider details:',
    '',
    `Business: ${draft.businessName ?? '—'}`,
    `Owner: ${draft.ownerName ?? '—'}`,
    `WhatsApp: ${maskPhone(phone)}`,
    `Pickup location: ${draft.pickupLocation ?? '—'}`,
    `Provider type: ${choiceLabel(draft.providerType)}`,
    `Menu: ${choiceLabel(draft.menuMethod)}`,
    `Ordering: ${choiceLabel(draft.orderingFrequency)}`,
    `Payment: ${choiceLabel(draft.paymentMethod)}`,
    `Availability: ${draft.availability ?? '—'}`,
    '',
    'ZipBite records payment preference only. Existing order payment behavior is unchanged.',
  ].join('\n');
}

function draftComplete(draft: ProviderOnboardingDraft): boolean {
  return Boolean(
    draft.businessName &&
      draft.ownerName &&
      draft.pickupLocation &&
      draft.providerType &&
      draft.menuMethod &&
      draft.orderingFrequency &&
      draft.paymentMethod &&
      draft.availability,
  );
}

async function finishProviderOnboarding(
  ctx: CommandContext,
  session: ProviderOnboardingSession,
  reply: ProviderReply,
): Promise<void> {
  const draft = parseProviderOnboardingDraft(session);
  if (!draftComplete(draft)) {
    const reset = save(session, 'BUSINESS_NAME', {});
    await promptForStep(reset, reply);
    return;
  }
  let completed;
  try {
    completed = getDb().transaction(() => {
      let vendor = getVendorByWhatsAppPhone(ctx.phone);
      if (!vendor) {
        vendor = createVendor({
          whatsappPhone: ctx.phone,
          status: 'DRAFT',
        });
      }
      const updated = completeVendorOnboarding(vendor.id, {
        businessName: draft.businessName!,
        contactName: draft.ownerName!,
        address: draft.pickupLocation!,
        providerType: draft.providerType!,
        menuSourceMethod: draft.menuMethod!,
        orderingFrequency: draft.orderingFrequency!,
        paymentPreference: draft.paymentMethod!,
      });
      if (!updated) {
        throw new Error('Provider record is unavailable.');
      }
      setVendorAvailability(updated.id, draft.availability!);
      const completedSession = completeProviderOnboardingSession({
        sessionId: session.id,
        phone: ctx.phone,
        vendorId: updated.id,
      });
      if (!completedSession) {
        throw new Error('Provider onboarding session expired.');
      }
      return updated;
    })();
  } catch {
    await reply('We could not complete onboarding. Please try again.');
    return;
  }
  const menuNext =
    draft.menuMethod === 'MANUAL'
      ? 'You can now use Products to enter your menu manually.'
      : `Your ${choiceLabel(draft.menuMethod)} menu preference is saved. Media upload review is not enabled yet; ZipBite will follow up.`;
  await reply(
    `Your provider onboarding is complete.\n\nStatus: Under Review\n\n${menuNext}`,
    [
      { title: 'Products', payload: 'VENDOR_PRODUCTS' },
      { title: 'My Business', payload: 'VENDOR_MY_BUSINESS' },
    ],
  );
}

export async function handleProviderOnboarding(
  ctx: CommandContext,
  reply: ProviderReply,
): Promise<boolean> {
  const rawInput = interactiveCommandInput(ctx).trim();
  const token = providerOnboardingToken(rawInput);
  let session: ProviderOnboardingSession | undefined;
  if (isPublicProviderOnboardingIntent(rawInput)) {
    const existing = getActiveProviderOnboardingSession(ctx.phone);
    session = startPublicProviderOnboardingSession({ phone: ctx.phone });
    if (!existing) {
      await reply(PROVIDER_ONBOARDING_WELCOME);
    }
    await promptForStep(session, reply);
    return true;
  }
  if (token) {
    const firstClaim =
      !getProviderOnboardingSessionByToken(token)?.claimed_at;
    session = claimProviderOnboardingSession({
      token,
      phone: ctx.phone,
    });
    if (!session) {
      await reply(
        'This onboarding link is invalid, expired, already used, or belongs to another WhatsApp number.',
      );
      return true;
    }
    if (firstClaim) {
      await reply(PROVIDER_ONBOARDING_WELCOME);
    }
    await promptForStep(session, reply);
    return true;
  }

  session = getActiveProviderOnboardingSession(ctx.phone);
  if (!session) {
    return false;
  }
  if (GREETINGS.has(rawInput.toUpperCase())) {
    await reply('Welcome back. Let’s continue your provider onboarding.');
    await promptForStep(session, reply);
    return true;
  }
  const input = compactInput(ctx);
  const text = rawInput.trim();
  const draft = parseProviderOnboardingDraft(session);

  if (input === 'PROVIDER_ONBOARDING_CANCEL') {
    await reply(
      'Onboarding is paused. Open your original secure link to continue later.',
    );
    return true;
  }
  if (input === 'PROVIDER_ONBOARDING_RESTART') {
    await promptForStep(save(session, 'BUSINESS_NAME', {}), reply);
    return true;
  }
  if (input === 'PROVIDER_ONBOARDING_CONFIRM') {
    if (session.step !== 'REVIEW') {
      await promptForStep(session, reply);
      return true;
    }
    await finishProviderOnboarding(ctx, session, reply);
    return true;
  }

  switch (session.step) {
    case 'BUSINESS_NAME': {
      if (!validText(text, 2)) {
        await reply('Enter a business name between 2 and 500 characters.');
        return true;
      }
      await promptForStep(
        save(session, 'OWNER_NAME', { ...draft, businessName: text }),
        reply,
      );
      return true;
    }
    case 'OWNER_NAME': {
      if (!validText(text, 2)) {
        await reply('Enter an owner name between 2 and 500 characters.');
        return true;
      }
      await promptForStep(
        save(session, 'CONFIRM_PHONE', { ...draft, ownerName: text }),
        reply,
      );
      return true;
    }
    case 'CONFIRM_PHONE':
      if (input !== 'PROVIDER_PHONE_CONFIRM') {
        await promptForStep(session, reply);
        return true;
      }
      await promptForStep(save(session, 'PICKUP_LOCATION', draft), reply);
      return true;
    case 'PICKUP_LOCATION': {
      if (!validText(text, 4)) {
        await reply('Enter a pickup location between 4 and 500 characters.');
        return true;
      }
      await promptForStep(
        save(session, 'PROVIDER_TYPE', { ...draft, pickupLocation: text }),
        reply,
      );
      return true;
    }
    case 'PROVIDER_TYPE': {
      const providerType = PROVIDER_TYPES.get(input);
      if (!providerType) {
        await promptForStep(session, reply);
        return true;
      }
      await promptForStep(
        save(session, 'MENU_METHOD', { ...draft, providerType }),
        reply,
      );
      return true;
    }
    case 'MENU_METHOD': {
      const menuMethod = MENU_METHODS.get(input);
      if (!menuMethod) {
        await promptForStep(session, reply);
        return true;
      }
      await promptForStep(
        save(session, 'ORDERING_FREQUENCY', { ...draft, menuMethod }),
        reply,
      );
      return true;
    }
    case 'ORDERING_FREQUENCY': {
      const orderingFrequency = ORDERING_FREQUENCIES.get(input);
      if (!orderingFrequency) {
        await promptForStep(session, reply);
        return true;
      }
      await promptForStep(
        save(session, 'PAYMENT_METHOD', { ...draft, orderingFrequency }),
        reply,
      );
      return true;
    }
    case 'PAYMENT_METHOD': {
      const paymentMethod = PAYMENT_METHODS.get(input);
      if (!paymentMethod) {
        await promptForStep(session, reply);
        return true;
      }
      await promptForStep(
        save(session, 'AVAILABILITY', { ...draft, paymentMethod }),
        reply,
      );
      return true;
    }
    case 'AVAILABILITY': {
      if (!validText(text, 4)) {
        await reply('Enter availability between 4 and 500 characters.');
        return true;
      }
      await promptForStep(
        save(session, 'REVIEW', { ...draft, availability: text }),
        reply,
      );
      return true;
    }
    case 'REVIEW':
      await promptForStep(session, reply);
      return true;
    default:
      return false;
  }
}
