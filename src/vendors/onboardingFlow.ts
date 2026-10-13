import type { CommandContext } from '../commands/organizer.js';
import { getDb } from '../db/store.js';
import type { InboxListSection } from '../zernio/client.js';
import { interactiveCommandInput } from '../whatsapp/eventList.js';
import {
  cancelProviderOnboardingSession,
  claimProviderOnboardingSession,
  completeProviderOnboardingSession,
  getActiveProviderOnboardingSession,
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

const CANCEL_BUTTON = {
  title: 'Cancel',
  payload: 'PROVIDER_ONBOARDING_CANCEL',
};
const CANCEL_ROW = {
  id: 'PROVIDER_ONBOARDING_CANCEL',
  title: 'Cancel',
};

const AVAILABILITY_PRESETS = new Map([
  ['PROVIDER_AVAIL_WEEKDAYS', 'Weekdays, Monday-Friday, 9 AM-6 PM'],
  ['PROVIDER_AVAIL_DAILY', 'Daily, every day, 9 AM-6 PM'],
  ['PROVIDER_AVAIL_WEEKENDS', 'Weekends, Saturday-Sunday, 10 AM-4 PM'],
]);

const AVAILABILITY_ROWS = [
  {
    id: 'PROVIDER_AVAIL_WEEKDAYS',
    title: 'Weekdays 9-6',
    description: 'Monday-Friday, 9 AM to 6 PM',
  },
  {
    id: 'PROVIDER_AVAIL_DAILY',
    title: 'Daily 9-6',
    description: 'Every day, 9 AM to 6 PM',
  },
  {
    id: 'PROVIDER_AVAIL_WEEKENDS',
    title: 'Weekends 10-4',
    description: 'Saturday-Sunday, 10 AM to 4 PM',
  },
  {
    id: 'PROVIDER_AVAIL_CUSTOM',
    title: 'Custom',
    description: 'Type your own days and hours',
  },
  CANCEL_ROW,
];

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

function hasCancelButton(
  buttons?: Array<{ title: string; payload: string }>,
): boolean {
  return Boolean(
    buttons?.some((button) => button.payload === 'PROVIDER_ONBOARDING_CANCEL'),
  );
}

async function sendPrompt(
  reply: ProviderReply,
  message: string,
  buttons?: Array<{ title: string; payload: string }>,
  list?: { button: string; sections: InboxListSection[] },
): Promise<void> {
  await reply(message, buttons, list);
  if (list || (buttons?.length && !hasCancelButton(buttons))) {
    await reply('Or tap Cancel to exit onboarding.', [CANCEL_BUTTON]);
  }
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
      await sendPrompt(
        reply,
        `${PROVIDER_ONBOARDING_WELCOME}\n\nWhat is your business name?`,
        [CANCEL_BUTTON],
      );
      return;
    case 'OWNER_NAME':
      await sendPrompt(reply, 'What is the provider or owner name?', [
        CANCEL_BUTTON,
      ]);
      return;
    case 'CONFIRM_PHONE':
      await sendPrompt(
        reply,
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
      await sendPrompt(
        reply,
        'What is the pickup location or business address?',
        [CANCEL_BUTTON],
      );
      return;
    case 'PROVIDER_TYPE':
      await sendPrompt(reply, 'Choose your provider type.', undefined, {
        button: 'Provider type',
        sections: [
          {
            title: 'Provider type',
            rows: [
              ...[...PROVIDER_TYPES].map(([id, value]) => ({
                id,
                title: choiceLabel(value),
              })),
              CANCEL_ROW,
            ],
          },
        ],
      });
      return;
    case 'MENU_METHOD':
      await sendPrompt(reply, 'How would you like to provide your menu?', [
        { title: 'Photos', payload: 'PROVIDER_MENU_PHOTOS' },
        { title: 'PDF', payload: 'PROVIDER_MENU_PDF' },
        { title: 'Enter manually', payload: 'PROVIDER_MENU_MANUAL' },
      ]);
      return;
    case 'ORDERING_FREQUENCY':
      await sendPrompt(reply, 'How do customers usually order from you?', undefined, {
        button: 'Ordering type',
        sections: [
          {
            title: 'Ordering frequency',
            rows: [
              ...[...ORDERING_FREQUENCIES].map(([id, value]) => ({
                id,
                title: choiceLabel(value),
              })),
              CANCEL_ROW,
            ],
          },
        ],
      });
      return;
    case 'PAYMENT_METHOD':
      await sendPrompt(reply, 'Which payment method do you support?', [
        { title: 'COD', payload: 'PROVIDER_PAY_COD' },
        { title: 'Pay First', payload: 'PROVIDER_PAY_FIRST' },
        { title: 'Both', payload: 'PROVIDER_PAY_BOTH' },
      ]);
      return;
    case 'AVAILABILITY':
      await sendPrompt(
        reply,
        'When can customers pick up? Each option lists the days and hours. Choose Custom to type a different schedule.',
        undefined,
        {
          button: 'Availability',
          sections: [
            {
              title: 'Pickup schedule',
              rows: AVAILABILITY_ROWS,
            },
          ],
        },
      );
      return;
    case 'AVAILABILITY_CUSTOM':
      await sendPrompt(
        reply,
        'Type your pickup days and hours (for example: Tue-Thu, 11 AM-7 PM, 24-hour notice).',
        [CANCEL_BUTTON],
      );
      return;
    case 'REVIEW':
      await sendPrompt(reply, providerSummary(session.expected_phone, draft), [
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
    session = startPublicProviderOnboardingSession({ phone: ctx.phone });
    await promptForStep(session, reply);
    return true;
  }
  if (token) {
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
    cancelProviderOnboardingSession(ctx.phone);
    const { routeToConnectWelcome } = await import('../commands/welcome.js');
    await routeToConnectWelcome(ctx);
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
        await reply('Enter a business name between 2 and 500 characters.', [
          CANCEL_BUTTON,
        ]);
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
        await reply('Enter an owner name between 2 and 500 characters.', [
          CANCEL_BUTTON,
        ]);
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
        await reply('Enter a pickup location between 4 and 500 characters.', [
          CANCEL_BUTTON,
        ]);
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
      if (input === 'PROVIDER_AVAIL_CUSTOM') {
        await promptForStep(save(session, 'AVAILABILITY_CUSTOM', draft), reply);
        return true;
      }
      const availability = AVAILABILITY_PRESETS.get(input);
      if (!availability) {
        await promptForStep(session, reply);
        return true;
      }
      await promptForStep(
        save(session, 'REVIEW', { ...draft, availability }),
        reply,
      );
      return true;
    }
    case 'AVAILABILITY_CUSTOM': {
      if (!validText(text, 4)) {
        await reply('Enter availability between 4 and 500 characters.', [
          CANCEL_BUTTON,
        ]);
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
