export interface TimezoneCity {
  city: string;
  country: string;
  iana: string;
  aliases?: string[];
}

export interface TimezoneSearchHit {
  city: string;
  country: string;
  iana: string;
  label: string;
}

/** WhatsApp shortcuts only — not the supported timezone list. */
export const TIMEZONE_QUICK_SELECT: Array<{
  title: string;
  id: string;
  iana?: string;
}> = [
  { title: 'New York (Eastern)', id: 'TZ:America/New_York', iana: 'America/New_York' },
  { title: 'Chicago (Central)', id: 'TZ:America/Chicago', iana: 'America/Chicago' },
  { title: 'Denver (Mountain)', id: 'TZ:America/Denver', iana: 'America/Denver' },
  {
    title: 'Los Angeles (Pacific)',
    id: 'TZ:America/Los_Angeles',
    iana: 'America/Los_Angeles',
  },
  { title: 'London', id: 'TZ:Europe/London', iana: 'Europe/London' },
  { title: 'India', id: 'TZ:Asia/Kolkata', iana: 'Asia/Kolkata' },
  { title: 'Sydney', id: 'TZ:Australia/Sydney', iana: 'Australia/Sydney' },
  { title: 'More cities', id: 'TZ_MORE' },
];

const TIMEZONE_LABELS: Record<string, string> = {
  'America/New_York': 'Eastern Time',
  'America/Chicago': 'Central Time',
  'America/Denver': 'Mountain Time',
  'America/Los_Angeles': 'Pacific Time',
  'America/Phoenix': 'Arizona Time',
  'America/Anchorage': 'Alaska Time',
  'Pacific/Honolulu': 'Hawaii Time',
  'America/Toronto': 'Eastern Time',
  'America/Vancouver': 'Pacific Time',
  'America/Mexico_City': 'Mexico City Time',
  'America/Sao_Paulo': 'Brazil Time',
  'America/Argentina/Buenos_Aires': 'Argentina Time',
  'America/Bogota': 'Colombia Time',
  'America/Lima': 'Peru Time',
  'America/Santiago': 'Chile Time',
  'Atlantic/Reykjavik': 'Iceland Time',
  'Europe/London': 'UK Time',
  'Europe/Dublin': 'Ireland Time',
  'Europe/Paris': 'Central European Time',
  'Europe/Berlin': 'Central European Time',
  'Europe/Amsterdam': 'Central European Time',
  'Europe/Rome': 'Central European Time',
  'Europe/Madrid': 'Central European Time',
  'Europe/Lisbon': 'Western European Time',
  'Europe/Athens': 'Eastern European Time',
  'Europe/Helsinki': 'Eastern European Time',
  'Europe/Istanbul': 'Turkey Time',
  'Europe/Moscow': 'Moscow Time',
  'Europe/Warsaw': 'Central European Time',
  'Europe/Stockholm': 'Central European Time',
  'Europe/Zurich': 'Central European Time',
  'Africa/Johannesburg': 'South Africa Time',
  'Africa/Cairo': 'Egypt Time',
  'Africa/Lagos': 'West Africa Time',
  'Africa/Nairobi': 'East Africa Time',
  'Africa/Casablanca': 'Morocco Time',
  'Asia/Dubai': 'Gulf Time',
  'Asia/Riyadh': 'Arabia Time',
  'Asia/Tehran': 'Iran Time',
  'Asia/Karachi': 'Pakistan Time',
  'Asia/Kolkata': 'India Time',
  'Asia/Dhaka': 'Bangladesh Time',
  'Asia/Kathmandu': 'Nepal Time',
  'Asia/Colombo': 'Sri Lanka Time',
  'Asia/Yangon': 'Myanmar Time',
  'Asia/Bangkok': 'Indochina Time',
  'Asia/Jakarta': 'Western Indonesia Time',
  'Asia/Singapore': 'Singapore Time',
  'Asia/Kuala_Lumpur': 'Malaysia Time',
  'Asia/Manila': 'Philippine Time',
  'Asia/Hong_Kong': 'Hong Kong Time',
  'Asia/Shanghai': 'China Time',
  'Asia/Taipei': 'Taipei Time',
  'Asia/Seoul': 'Korea Time',
  'Asia/Tokyo': 'Japan Time',
  'Australia/Perth': 'Australian Western Time',
  'Australia/Adelaide': 'Australian Central Time',
  'Australia/Darwin': 'Australian Central Time',
  'Australia/Sydney': 'Australian Eastern Time',
  'Australia/Melbourne': 'Australian Eastern Time',
  'Australia/Brisbane': 'Australian Eastern Time',
  'Australia/Hobart': 'Australian Eastern Time',
  'Australia/Auckland': 'New Zealand Time',
  'Pacific/Auckland': 'New Zealand Time',
  'Pacific/Fiji': 'Fiji Time',
  'Pacific/Guam': 'Chamorro Time',
  'Pacific/Pago_Pago': 'Samoa Time',
};

/** Worldwide city/location catalog. Source of truth for More Cities search. */
export const TIMEZONE_CITIES: TimezoneCity[] = [
  { city: 'New York', country: 'United States', iana: 'America/New_York', aliases: ['nyc', 'eastern', 'eastern time', 'brooklyn', 'manhattan'] },
  { city: 'Washington', country: 'United States', iana: 'America/New_York', aliases: ['dc', 'washington dc'] },
  { city: 'Boston', country: 'United States', iana: 'America/New_York' },
  { city: 'Miami', country: 'United States', iana: 'America/New_York' },
  { city: 'Atlanta', country: 'United States', iana: 'America/New_York' },
  { city: 'Philadelphia', country: 'United States', iana: 'America/New_York' },
  { city: 'Chicago', country: 'United States', iana: 'America/Chicago', aliases: ['central', 'central time'] },
  { city: 'Houston', country: 'United States', iana: 'America/Chicago' },
  { city: 'Dallas', country: 'United States', iana: 'America/Chicago' },
  { city: 'Austin', country: 'United States', iana: 'America/Chicago' },
  { city: 'Minneapolis', country: 'United States', iana: 'America/Chicago' },
  { city: 'New Orleans', country: 'United States', iana: 'America/Chicago' },
  { city: 'Denver', country: 'United States', iana: 'America/Denver', aliases: ['mountain', 'mountain time', 'colorado'] },
  { city: 'Salt Lake City', country: 'United States', iana: 'America/Denver' },
  { city: 'Phoenix', country: 'United States', iana: 'America/Phoenix', aliases: ['arizona'] },
  { city: 'Los Angeles', country: 'United States', iana: 'America/Los_Angeles', aliases: ['la', 'pacific', 'pacific time', 'hollywood'] },
  { city: 'San Francisco', country: 'United States', iana: 'America/Los_Angeles', aliases: ['sf', 'bay area'] },
  { city: 'Seattle', country: 'United States', iana: 'America/Los_Angeles' },
  { city: 'Portland', country: 'United States', iana: 'America/Los_Angeles' },
  { city: 'San Diego', country: 'United States', iana: 'America/Los_Angeles' },
  { city: 'Las Vegas', country: 'United States', iana: 'America/Los_Angeles' },
  { city: 'Anchorage', country: 'United States', iana: 'America/Anchorage', aliases: ['alaska'] },
  { city: 'Honolulu', country: 'United States', iana: 'Pacific/Honolulu', aliases: ['hawaii', 'oahu'] },
  { city: 'Toronto', country: 'Canada', iana: 'America/Toronto' },
  { city: 'Montreal', country: 'Canada', iana: 'America/Toronto' },
  { city: 'Vancouver', country: 'Canada', iana: 'America/Vancouver' },
  { city: 'Calgary', country: 'Canada', iana: 'America/Edmonton' },
  { city: 'Edmonton', country: 'Canada', iana: 'America/Edmonton' },
  { city: 'Winnipeg', country: 'Canada', iana: 'America/Winnipeg' },
  { city: 'Halifax', country: 'Canada', iana: 'America/Halifax' },
  { city: 'Mexico City', country: 'Mexico', iana: 'America/Mexico_City' },
  { city: 'Cancun', country: 'Mexico', iana: 'America/Cancun' },
  { city: 'Tijuana', country: 'Mexico', iana: 'America/Tijuana' },
  { city: 'Bogota', country: 'Colombia', iana: 'America/Bogota' },
  { city: 'Lima', country: 'Peru', iana: 'America/Lima' },
  { city: 'Quito', country: 'Ecuador', iana: 'America/Guayaquil' },
  { city: 'Caracas', country: 'Venezuela', iana: 'America/Caracas' },
  { city: 'Santiago', country: 'Chile', iana: 'America/Santiago' },
  { city: 'Buenos Aires', country: 'Argentina', iana: 'America/Argentina/Buenos_Aires', aliases: ['argentina'] },
  { city: 'Sao Paulo', country: 'Brazil', iana: 'America/Sao_Paulo', aliases: ['são paulo', 'brazil'] },
  { city: 'Rio de Janeiro', country: 'Brazil', iana: 'America/Sao_Paulo', aliases: ['rio'] },
  { city: 'Brasilia', country: 'Brazil', iana: 'America/Sao_Paulo' },
  { city: 'Reykjavik', country: 'Iceland', iana: 'Atlantic/Reykjavik' },
  { city: 'London', country: 'United Kingdom', iana: 'Europe/London', aliases: ['uk', 'england', 'britain', 'gmt', 'bst'] },
  { city: 'Manchester', country: 'United Kingdom', iana: 'Europe/London' },
  { city: 'Edinburgh', country: 'United Kingdom', iana: 'Europe/London' },
  { city: 'Dublin', country: 'Ireland', iana: 'Europe/Dublin' },
  { city: 'Lisbon', country: 'Portugal', iana: 'Europe/Lisbon' },
  { city: 'Paris', country: 'France', iana: 'Europe/Paris' },
  { city: 'Lyon', country: 'France', iana: 'Europe/Paris' },
  { city: 'Berlin', country: 'Germany', iana: 'Europe/Berlin' },
  { city: 'Munich', country: 'Germany', iana: 'Europe/Berlin' },
  { city: 'Frankfurt', country: 'Germany', iana: 'Europe/Berlin' },
  { city: 'Amsterdam', country: 'Netherlands', iana: 'Europe/Amsterdam' },
  { city: 'Brussels', country: 'Belgium', iana: 'Europe/Brussels' },
  { city: 'Zurich', country: 'Switzerland', iana: 'Europe/Zurich' },
  { city: 'Rome', country: 'Italy', iana: 'Europe/Rome' },
  { city: 'Milan', country: 'Italy', iana: 'Europe/Rome' },
  { city: 'Madrid', country: 'Spain', iana: 'Europe/Madrid' },
  { city: 'Barcelona', country: 'Spain', iana: 'Europe/Madrid' },
  { city: 'Vienna', country: 'Austria', iana: 'Europe/Vienna' },
  { city: 'Prague', country: 'Czechia', iana: 'Europe/Prague' },
  { city: 'Warsaw', country: 'Poland', iana: 'Europe/Warsaw' },
  { city: 'Stockholm', country: 'Sweden', iana: 'Europe/Stockholm' },
  { city: 'Oslo', country: 'Norway', iana: 'Europe/Oslo' },
  { city: 'Copenhagen', country: 'Denmark', iana: 'Europe/Copenhagen' },
  { city: 'Helsinki', country: 'Finland', iana: 'Europe/Helsinki' },
  { city: 'Athens', country: 'Greece', iana: 'Europe/Athens' },
  { city: 'Bucharest', country: 'Romania', iana: 'Europe/Bucharest' },
  { city: 'Budapest', country: 'Hungary', iana: 'Europe/Budapest' },
  { city: 'Istanbul', country: 'Turkey', iana: 'Europe/Istanbul' },
  { city: 'Moscow', country: 'Russia', iana: 'Europe/Moscow' },
  { city: 'Kyiv', country: 'Ukraine', iana: 'Europe/Kyiv', aliases: ['kiev'] },
  { city: 'Casablanca', country: 'Morocco', iana: 'Africa/Casablanca' },
  { city: 'Cairo', country: 'Egypt', iana: 'Africa/Cairo' },
  { city: 'Lagos', country: 'Nigeria', iana: 'Africa/Lagos' },
  { city: 'Accra', country: 'Ghana', iana: 'Africa/Accra' },
  { city: 'Nairobi', country: 'Kenya', iana: 'Africa/Nairobi' },
  { city: 'Addis Ababa', country: 'Ethiopia', iana: 'Africa/Addis_Ababa' },
  { city: 'Johannesburg', country: 'South Africa', iana: 'Africa/Johannesburg', aliases: ['joburg'] },
  { city: 'Cape Town', country: 'South Africa', iana: 'Africa/Johannesburg' },
  { city: 'Dubai', country: 'United Arab Emirates', iana: 'Asia/Dubai', aliases: ['uae'] },
  { city: 'Abu Dhabi', country: 'United Arab Emirates', iana: 'Asia/Dubai' },
  { city: 'Riyadh', country: 'Saudi Arabia', iana: 'Asia/Riyadh' },
  { city: 'Doha', country: 'Qatar', iana: 'Asia/Qatar' },
  { city: 'Kuwait City', country: 'Kuwait', iana: 'Asia/Kuwait' },
  { city: 'Tehran', country: 'Iran', iana: 'Asia/Tehran' },
  { city: 'Karachi', country: 'Pakistan', iana: 'Asia/Karachi' },
  { city: 'Islamabad', country: 'Pakistan', iana: 'Asia/Karachi' },
  { city: 'Mumbai', country: 'India', iana: 'Asia/Kolkata', aliases: ['bombay', 'india'] },
  { city: 'Delhi', country: 'India', iana: 'Asia/Kolkata', aliases: ['new delhi'] },
  { city: 'Bengaluru', country: 'India', iana: 'Asia/Kolkata', aliases: ['bangalore'] },
  { city: 'Hyderabad', country: 'India', iana: 'Asia/Kolkata' },
  { city: 'Chennai', country: 'India', iana: 'Asia/Kolkata', aliases: ['madras'] },
  { city: 'Kolkata', country: 'India', iana: 'Asia/Kolkata', aliases: ['calcutta'] },
  { city: 'Colombo', country: 'Sri Lanka', iana: 'Asia/Colombo' },
  { city: 'Kathmandu', country: 'Nepal', iana: 'Asia/Kathmandu' },
  { city: 'Dhaka', country: 'Bangladesh', iana: 'Asia/Dhaka' },
  { city: 'Yangon', country: 'Myanmar', iana: 'Asia/Yangon', aliases: ['rangoon'] },
  { city: 'Bangkok', country: 'Thailand', iana: 'Asia/Bangkok' },
  { city: 'Ho Chi Minh City', country: 'Vietnam', iana: 'Asia/Ho_Chi_Minh', aliases: ['saigon'] },
  { city: 'Hanoi', country: 'Vietnam', iana: 'Asia/Bangkok' },
  { city: 'Jakarta', country: 'Indonesia', iana: 'Asia/Jakarta' },
  { city: 'Singapore', country: 'Singapore', iana: 'Asia/Singapore' },
  { city: 'Kuala Lumpur', country: 'Malaysia', iana: 'Asia/Kuala_Lumpur' },
  { city: 'Manila', country: 'Philippines', iana: 'Asia/Manila' },
  { city: 'Hong Kong', country: 'Hong Kong', iana: 'Asia/Hong_Kong' },
  { city: 'Taipei', country: 'Taiwan', iana: 'Asia/Taipei' },
  { city: 'Shanghai', country: 'China', iana: 'Asia/Shanghai' },
  { city: 'Beijing', country: 'China', iana: 'Asia/Shanghai' },
  { city: 'Guangzhou', country: 'China', iana: 'Asia/Shanghai' },
  { city: 'Seoul', country: 'South Korea', iana: 'Asia/Seoul' },
  { city: 'Tokyo', country: 'Japan', iana: 'Asia/Tokyo' },
  { city: 'Osaka', country: 'Japan', iana: 'Asia/Tokyo' },
  { city: 'Perth', country: 'Australia', iana: 'Australia/Perth' },
  { city: 'Adelaide', country: 'Australia', iana: 'Australia/Adelaide' },
  { city: 'Darwin', country: 'Australia', iana: 'Australia/Darwin' },
  { city: 'Brisbane', country: 'Australia', iana: 'Australia/Brisbane' },
  { city: 'Sydney', country: 'Australia', iana: 'Australia/Sydney', aliases: ['nsw'] },
  { city: 'Melbourne', country: 'Australia', iana: 'Australia/Melbourne' },
  { city: 'Canberra', country: 'Australia', iana: 'Australia/Sydney' },
  { city: 'Hobart', country: 'Australia', iana: 'Australia/Hobart' },
  { city: 'Auckland', country: 'New Zealand', iana: 'Pacific/Auckland', aliases: ['nz', 'new zealand'] },
  { city: 'Wellington', country: 'New Zealand', iana: 'Pacific/Auckland' },
  { city: 'Suva', country: 'Fiji', iana: 'Pacific/Fiji' },
  { city: 'Guam', country: 'Guam', iana: 'Pacific/Guam' },
  { city: 'Pago Pago', country: 'American Samoa', iana: 'Pacific/Pago_Pago' },
];

export function isValidIanaTimeZone(id: string): boolean {
  const trimmed = id.trim();
  if (!trimmed || trimmed.startsWith('-') || /^\d/.test(trimmed)) {
    return false;
  }
  try {
    Intl.DateTimeFormat('en-US', { timeZone: trimmed }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function formatTimezoneLabel(iana: string): string {
  const id = iana.trim();
  if (TIMEZONE_LABELS[id]) {
    return TIMEZONE_LABELS[id];
  }
  const city = TIMEZONE_CITIES.find((entry) => entry.iana === id);
  if (city) {
    return `${city.city} Time`;
  }
  return 'Local time';
}

function normalizeSearch(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function searchTimezoneCities(
  query: string,
  limit = 20,
): TimezoneSearchHit[] {
  const needle = normalizeSearch(query);
  if (!needle || needle.length < 1) {
    return TIMEZONE_CITIES.slice(0, limit).map(toHit);
  }
  const scored = TIMEZONE_CITIES.map((entry) => {
    const haystacks = [
      entry.city,
      entry.country,
      ...(entry.aliases ?? []),
      formatTimezoneLabel(entry.iana),
      entry.iana.replace(/_/g, ' '),
    ].map(normalizeSearch);
    let score = 0;
    for (const hay of haystacks) {
      if (hay === needle) {
        score = Math.max(score, 100);
      } else if (hay.startsWith(needle)) {
        score = Math.max(score, 80);
      } else if (hay.includes(needle)) {
        score = Math.max(score, 50);
      }
    }
    return { entry, score };
  })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.city.localeCompare(b.entry.city));

  const seen = new Set<string>();
  const hits: TimezoneSearchHit[] = [];
  for (const row of scored) {
    const key = `${row.entry.city}|${row.entry.iana}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    hits.push(toHit(row.entry));
    if (hits.length >= limit) {
      break;
    }
  }
  return hits;
}

export function featuredTimezoneCities(limit = 24): TimezoneSearchHit[] {
  return TIMEZONE_CITIES.slice(0, limit).map(toHit);
}

function toHit(entry: TimezoneCity): TimezoneSearchHit {
  return {
    city: entry.city,
    country: entry.country,
    iana: entry.iana,
    label: formatTimezoneLabel(entry.iana),
  };
}

export function parseQuickTimezoneId(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.toUpperCase() === 'TZ_MORE' || trimmed.toUpperCase() === 'MORE CITIES') {
    return null;
  }
  const prefixed = /^TZ:(.+)$/i.exec(trimmed);
  const iana = prefixed ? prefixed[1].trim() : trimmed;
  const match = TIMEZONE_QUICK_SELECT.find(
    (row) =>
      row.iana &&
      (row.id.toUpperCase() === trimmed.toUpperCase() ||
        row.iana === iana ||
        row.title.toUpperCase() === trimmed.toUpperCase()),
  );
  if (match?.iana && isValidIanaTimeZone(match.iana)) {
    return match.iana;
  }
  if (isValidIanaTimeZone(iana) && TIMEZONE_CITIES.some((city) => city.iana === iana)) {
    return iana;
  }
  return null;
}
