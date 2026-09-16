import type { SendMessageParams } from '../zernio/client.js';

export const THEME_SKIP = 'skip';
export const THEME_CUSTOM = 'custom';
export const DRESS_ENTER = 'DRESS_ENTER';
export const DRESS_SKIP = 'DRESS_SKIP';

export const THEME_PROMPT = '🎨 Event Style\n\nChoose a style for your event.';
export const CUSTOM_THEME_PROMPT =
  "✏️ Describe your event style\n\nTell us how you'd like your event to look.\n\nExample: Blue and white, elegant garden party with soft floral design.";
export const DRESS_CODE_PROMPT =
  "👗 What to Wear\n\nTell your guests what you'd like them to wear.";
export const DRESS_CODE_TEXT_PROMPT =
  "Reply with what you'd like guests to wear, or send Skip.";
export const THEME_LIST_BUTTON = 'Choose';
export const CUSTOM_THEME_MAX = 300;
export const DRESS_CODE_MAX = 200;

export const EVENT_THEME_OPTIONS = [
  { id: 'skip', title: '⏭️ Skip' },
  { id: 'floral', title: '🌸 Floral' },
  { id: 'elegant', title: '✨ Elegant' },
  { id: 'colorful', title: '🎨 Colorful' },
  { id: 'natural', title: '🌿 Natural' },
  { id: 'classic', title: '🕯️ Classic' },
  { id: 'festive', title: '🪩 Festive' },
  { id: 'modern', title: '🖤 Modern' },
  { id: 'minimal', title: '🤍 Minimal' },
  { id: 'custom', title: '✏️ Custom' },
] as const;

/** Old occasion IDs still stored on existing events. Do not offer for new picks. */
export const LEGACY_THEME_OPTIONS = [
  { id: 'celebration', title: '🎉 Celebration' },
  { id: 'birthday', title: '🎂 Birthday' },
  { id: 'wedding', title: '💍 Wedding' },
  { id: 'baby_shower', title: '👶 Baby Shower' },
  { id: 'traditional', title: '🪔 Traditional' },
  { id: 'business', title: '💼 Business' },
  { id: 'casual', title: '🌿 Casual' },
] as const;

export type EventThemeId = (typeof EVENT_THEME_OPTIONS)[number]['id'];
export type NewStoredEventThemeId = Exclude<EventThemeId, 'skip'>;
export type LegacyEventThemeId = (typeof LEGACY_THEME_OPTIONS)[number]['id'];
export type StoredEventThemeId = NewStoredEventThemeId | LegacyEventThemeId;

const THEME_LABELS = new Map<string, string>([
  ...EVENT_THEME_OPTIONS.map((option) => [option.id, option.title] as const),
  ...LEGACY_THEME_OPTIONS.map((option) => [option.id, option.title] as const),
]);

const THEME_IDS = new Set<string>(THEME_LABELS.keys());
const STORED_THEME_IDS = new Set<string>(
  [...THEME_IDS].filter((id) => id !== 'skip'),
);
const NEW_THEME_IDS = new Set<string>(
  EVENT_THEME_OPTIONS.filter((option) => option.id !== 'skip').map(
    (option) => option.id,
  ),
);

export const DRESS_CODE_BUTTONS = [
  { title: '⏭️ Skip', payload: DRESS_SKIP },
  { title: '✏️ Custom', payload: DRESS_ENTER },
];

export function eventThemeChoiceList(): NonNullable<SendMessageParams['list']> {
  return {
    button: THEME_LIST_BUTTON,
    sections: [
      {
        title: 'Event Style',
        rows: EVENT_THEME_OPTIONS.map((option) => ({
          id: option.id,
          title: option.title,
        })),
      },
    ],
  };
}

function normalizeChoice(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseThemeChoice(
  input: string,
): { theme: NewStoredEventThemeId } | { skip: true } | undefined {
  const normalized = normalizeChoice(input);

  if (!normalized) {
    return undefined;
  }
  if (
    normalized === 'skip' ||
    normalized === 'theme skip' ||
    normalized === 'style skip' ||
    normalized === 'event style skip' ||
    normalized === 'none'
  ) {
    return { skip: true };
  }
  if (
    normalized === 'custom' ||
    normalized === 'theme custom' ||
    normalized === 'style custom' ||
    normalized === 'event style custom'
  ) {
    return { theme: 'custom' };
  }

  for (const option of EVENT_THEME_OPTIONS) {
    if (option.id === 'skip' || option.id === 'custom') {
      continue;
    }
    const titleNorm = normalizeChoice(option.title);
    if (
      normalized === option.id ||
      normalized === titleNorm ||
      normalized === `style ${option.id}` ||
      normalized === `theme ${option.id}`
    ) {
      return { theme: option.id };
    }
  }
  return undefined;
}

export function parseDressChoice(
  input: string,
): { enter: true } | { skip: true } | undefined {
  const normalized = input
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (
    normalized === 'DRESS ENTER' ||
    normalized === 'ENTER DRESS CODE' ||
    normalized === 'ENTER' ||
    normalized === 'CUSTOM' ||
    normalized === 'DRESS CUSTOM' ||
    normalized === 'WHAT TO WEAR CUSTOM'
  ) {
    return { enter: true };
  }
  if (
    normalized === 'DRESS SKIP' ||
    normalized === 'SKIP' ||
    normalized === 'NONE'
  ) {
    return { skip: true };
  }
  return undefined;
}

export function sanitizeOrganizerText(input: string, max: number): string {
  return input.replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, max);
}

export function sanitizeCustomTheme(input: string): string {
  return sanitizeOrganizerText(input, CUSTOM_THEME_MAX);
}

export function sanitizeDressCode(input: string): string {
  return sanitizeOrganizerText(input, DRESS_CODE_MAX);
}

export function isStoredThemeId(value: string | null | undefined): value is StoredEventThemeId {
  return Boolean(value && STORED_THEME_IDS.has(value));
}

export function isNewThemeId(value: string | null | undefined): value is NewStoredEventThemeId {
  return Boolean(value && NEW_THEME_IDS.has(value));
}

export function themeLabel(theme: string | null | undefined): string | null {
  if (!theme || !THEME_IDS.has(theme) || theme === 'skip') {
    return null;
  }
  return THEME_LABELS.get(theme) ?? null;
}

export function themeDisplayText(event: {
  theme?: string | null;
  custom_theme?: string | null;
}): string | null {
  if (event.theme === 'custom') {
    const custom = event.custom_theme?.trim();
    return custom || '✏️ Custom';
  }
  return themeLabel(event.theme ?? null);
}

export function themeCssClass(theme: string | null | undefined): string {
  if (theme === 'custom') {
    return 'theme-elegant theme-custom';
  }
  if (isStoredThemeId(theme)) {
    return `theme-${theme}`;
  }
  return '';
}

export const EVENT_THEME_PAGE_CSS = `
body.theme-celebration {
  --ink: #4a2808;
  --muted: #8a5a2b;
  --line: #f3d19a;
  --paper: #fff6e4;
  --card: #fffdf8;
  --accent: #c2410c;
  background:
    radial-gradient(1100px 380px at 50% -70px, #ffe7b3 0%, transparent 62%),
    #fff8ee;
}
body.theme-birthday {
  --ink: #4a1458;
  --muted: #7e4a8a;
  --line: #f5c6e0;
  --paper: #fff1f7;
  --card: #fffafc;
  --accent: #be185d;
  background:
    radial-gradient(1100px 380px at 50% -70px, #ffd6ec 0%, transparent 62%),
    #fff5fa;
}
body.theme-wedding {
  --ink: #3f2a2a;
  --muted: #7a6464;
  --line: #ead7d0;
  --paper: #fff7f4;
  --card: #fffcfb;
  --accent: #9f1239;
  background:
    radial-gradient(1100px 380px at 50% -70px, #f8e4dc 0%, transparent 62%),
    #faf6f3;
}
body.theme-baby_shower {
  --ink: #234e52;
  --muted: #5b7c80;
  --line: #cde7e4;
  --paper: #f3fbfa;
  --card: #fcfffe;
  --accent: #0f766e;
  background:
    radial-gradient(1100px 380px at 50% -70px, #d9f3f0 0%, transparent 62%),
    #f4fbf9;
}
body.theme-traditional {
  --ink: #4a1609;
  --muted: #8b4d1f;
  --line: #efc48a;
  --paper: #fff4e2;
  --card: #fffaf2;
  --accent: #b45309;
  background:
    radial-gradient(1100px 380px at 50% -70px, #f6d59a 0%, transparent 62%),
    #fbf3e6;
}
body.theme-business {
  --ink: #0f172a;
  --muted: #475569;
  --line: #d6deea;
  --paper: #f4f7fb;
  --card: #ffffff;
  --accent: #1e3a5f;
  background:
    radial-gradient(1100px 380px at 50% -70px, #dbe4f0 0%, transparent 62%),
    #eef2f6;
}
body.theme-casual {
  --ink: #14532d;
  --muted: #4d7c59;
  --line: #c9e4c7;
  --paper: #f3faf1;
  --card: #fcfffb;
  --accent: #3f6212;
  background:
    radial-gradient(1100px 380px at 50% -70px, #d8f0c8 0%, transparent 62%),
    #f4faf0;
}
body.theme-floral {
  --ink: #4a1830;
  --muted: #8a4a68;
  --line: #f3c5d8;
  --paper: #fff4f8;
  --card: #fffafc;
  --accent: #be185d;
  background:
    radial-gradient(1100px 380px at 50% -70px, #ffd6e8 0%, transparent 62%),
    #fff6f9;
}
body.theme-elegant,
body.theme-custom {
  --ink: #1c1917;
  --muted: #57534e;
  --line: #e7e0d5;
  --paper: #f7f3ec;
  --card: #fffdf9;
  --accent: #292524;
  background:
    radial-gradient(1100px 380px at 50% -70px, #ece4d4 0%, transparent 62%),
    #f4f0e8;
}
body.theme-colorful {
  --ink: #3b0764;
  --muted: #6d28d9;
  --line: #e9d5ff;
  --paper: #faf5ff;
  --card: #fffdfd;
  --accent: #c026d3;
  background:
    radial-gradient(1100px 380px at 50% -70px, #fde68a 0%, transparent 55%),
    radial-gradient(900px 320px at 100% 0, #fbcfe8 0%, transparent 50%),
    #fff7ed;
}
body.theme-natural {
  --ink: #365314;
  --muted: #4d7c47;
  --line: #d4e3c4;
  --paper: #f6faf1;
  --card: #fcfef9;
  --accent: #3f6212;
  background:
    radial-gradient(1100px 380px at 50% -70px, #d9f99d 0%, transparent 62%),
    #f4f7ee;
}
body.theme-classic {
  --ink: #3f2a14;
  --muted: #7c5a2a;
  --line: #e8d5b0;
  --paper: #fbf6ea;
  --card: #fffdf7;
  --accent: #92400e;
  background:
    radial-gradient(1100px 380px at 50% -70px, #f5e6c4 0%, transparent 62%),
    #f7f1e4;
}
body.theme-festive {
  --ink: #3b0764;
  --muted: #6b21a8;
  --line: #e9d5ff;
  --paper: #faf5ff;
  --card: #fffdfb;
  --accent: #a21caf;
  background:
    radial-gradient(1100px 380px at 50% -70px, #fde047 0%, transparent 58%),
    #faf5ff;
}
body.theme-modern {
  --ink: #0f172a;
  --muted: #475569;
  --line: #cbd5e1;
  --paper: #f1f5f9;
  --card: #ffffff;
  --accent: #111827;
  background:
    radial-gradient(1100px 380px at 50% -70px, #cbd5e1 0%, transparent 62%),
    #e2e8f0;
}
body.theme-minimal {
  --ink: #292524;
  --muted: #78716c;
  --line: #e7e5e4;
  --paper: #fafaf9;
  --card: #ffffff;
  --accent: #44403c;
  background:
    radial-gradient(1100px 380px at 50% -70px, #f5f5f4 0%, transparent 62%),
    #f8f8f7;
}
.theme-note, .dress-block, .theme-block {
  margin: 0 0 0.85rem;
  padding: 0.8rem 0.9rem;
  background: var(--paper);
  border-radius: 0.9rem;
}
.theme-block p, .dress-block p, .theme-note {
  margin: 0;
}
.theme-kicker, .dress-kicker {
  margin: 0 0 0.25rem;
  font-size: 0.82rem;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--muted);
  font-weight: 650;
}
.maps-link {
  color: var(--accent);
  font-weight: 650;
  text-decoration: none;
}
.maps-link:hover { text-decoration: underline; }
.meta .address {
  color: var(--muted);
  padding-left: 1.35rem;
}
`;
