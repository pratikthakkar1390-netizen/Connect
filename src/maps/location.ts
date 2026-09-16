export interface LocationDraft {
  location: string;
  location_address: string | null;
  location_place_id: string | null;
  location_maps_url: string | null;
}

export function buildGoogleMapsSearchUrl(query: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query.trim())}`;
}

export function isSafeMapsUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') {
      return false;
    }
    const host = parsed.hostname.toLowerCase();
    if (host === 'www.google.com' || host === 'maps.google.com') {
      return parsed.pathname.startsWith('/maps');
    }
    return host === 'maps.app.goo.gl';
  } catch {
    return false;
  }
}

export function locationDraft(location: string): LocationDraft {
  const trimmed = location.trim();
  return {
    location: trimmed,
    location_address: null,
    location_place_id: null,
    location_maps_url: trimmed ? buildGoogleMapsSearchUrl(trimmed) : null,
  };
}

export function resolveEventMapsUrl(event: {
  location?: string | null;
  location_maps_url?: string | null;
}): string | null {
  const stored = event.location_maps_url?.trim();
  if (stored && isSafeMapsUrl(stored)) {
    return stored;
  }
  const location = event.location?.trim();
  if (!location) {
    return null;
  }
  const generated = buildGoogleMapsSearchUrl(location);
  return isSafeMapsUrl(generated) ? generated : null;
}
