// reviews.ts: client reviews about Daedabyte (Google Business, the website, anywhere), kept
// in brand/reviews.json and edited from the dashboard. The quote template draws from these;
// a quote must appear verbatim in one of them.
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { ROOT } from './config.js';

// Tests point REVIEWS_FILE at a scratch file so they never read or write the real list.
export const REVIEWS_PATH = process.env.REVIEWS_FILE?.trim() || path.join(ROOT, 'brand', 'reviews.json');

export interface Review {
  id: string;
  name: string;
  business: string;
  text: string;
  source: 'google' | 'site' | 'other';
  date: string | null;
  addedAt: string;
}

export async function listReviews(): Promise<Review[]> {
  try {
    return JSON.parse(await readFile(REVIEWS_PATH, 'utf8')) as Review[];
  } catch {
    return [];
  }
}

async function save(reviews: Review[]): Promise<void> {
  await writeFile(REVIEWS_PATH, JSON.stringify(reviews, null, 2) + '\n');
}

export async function addReview(input: Omit<Review, 'id' | 'addedAt'>): Promise<Review> {
  const text = input.text.trim().replace(/\s+/g, ' ');
  if (!input.name.trim()) throw new Error('Review needs the reviewer’s name');
  if (text.length < 20) throw new Error('Review text is too short to quote');
  const r: Review = { id: randomUUID(), name: input.name.trim(), business: input.business.trim(), text, source: input.source, date: input.date || null, addedAt: new Date().toISOString() };
  await save([r, ...(await listReviews())]);
  return r;
}

export async function removeReview(id: string): Promise<void> {
  await save((await listReviews()).filter((r) => r.id !== id));
}

const norm = (s: string) => s.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[.!?,;:"'()\-…]/g, '').replace(/\s+/g, ' ').trim();

/** The review a quote was taken from, if the quote appears verbatim (ignoring punctuation and case) in one; else null. */
export function reviewForQuote(quote: string, reviews: Review[]): Review | null {
  const q = norm(quote);
  if (!q) return null;
  return reviews.find((r) => norm(r.text).includes(q)) ?? null;
}

// ---- Google Places API (New) ------------------------------------------------------
// GET https://places.googleapis.com/v1/places/{placeId}  with headers
//   X-Goog-Api-Key: <GOOGLE_PLACES_API_KEY>   X-Goog-FieldMask: displayName,reviews
// Returns up to five of the place's reviews (Google picks which). The owner-side
// Business Profile API returns all of them but needs OAuth plus a quota application.

export interface PlacesReview {
  name: string;
  rating?: number;
  text?: { text: string; languageCode?: string };
  authorAttribution?: { displayName?: string };
  publishTime?: string;
}

export interface GoogleConfig {
  apiKey: string;
  placeId: string;
  fetch?: typeof fetch;
}

export function googleConfig(): GoogleConfig {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY?.trim();
  const placeId = process.env.GOOGLE_PLACE_ID?.trim();
  if (!apiKey) throw new Error('GOOGLE_PLACES_API_KEY is not set');
  if (!placeId) throw new Error('GOOGLE_PLACE_ID is not set');
  return { apiKey, placeId };
}

export async function fetchGoogleReviews(cfg: GoogleConfig): Promise<{ place: string; reviews: PlacesReview[] }> {
  const f = cfg.fetch ?? fetch;
  const res = await f(`https://places.googleapis.com/v1/places/${encodeURIComponent(cfg.placeId)}`, {
    headers: { 'X-Goog-Api-Key': cfg.apiKey, 'X-Goog-FieldMask': 'displayName,reviews' },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Google Places ${res.status}: ${text.slice(0, 300)}`);
  const body = JSON.parse(text) as { displayName?: { text?: string }; reviews?: PlacesReview[] };
  return { place: body.displayName?.text ?? cfg.placeId, reviews: body.reviews ?? [] };
}

/** Look up a Place ID from a business name and area (Places API New text search). */
export async function findPlaceId(apiKey: string, query: string, f: typeof fetch = fetch): Promise<{ id: string; name: string; address: string }[]> {
  const res = await f('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress' },
    body: JSON.stringify({ textQuery: query, maxResultCount: 5 }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Google Places ${res.status}: ${text.slice(0, 300)}`);
  const body = JSON.parse(text) as { places?: { id: string; displayName?: { text?: string }; formattedAddress?: string }[] };
  return (body.places ?? []).map((p) => ({ id: p.id, name: p.displayName?.text ?? '', address: p.formattedAddress ?? '' }));
}

/** Import Google reviews not already on file (matched by text). Returns the ones added. */
export async function importGoogleReviews(cfg: GoogleConfig, log: (s: string) => void = () => {}): Promise<{ added: Review[]; skipped: number; place: string }> {
  const { place, reviews } = await fetchGoogleReviews(cfg);
  log(`Google returned ${reviews.length} review(s) for ${place}`);
  const existing = await listReviews();
  const have = new Set(existing.map((r) => norm(r.text)));
  const added: Review[] = [];
  let skipped = 0;
  for (const g of reviews) {
    const body = g.text?.text?.trim().replace(/\s+/g, ' ') ?? '';
    if (body.length < 20) {
      skipped++;
      continue;
    }
    if (have.has(norm(body))) {
      skipped++;
      continue;
    }
    if (g.rating !== undefined && g.rating < 4) {
      log(`skipping a ${g.rating}-star review from ${g.authorAttribution?.displayName ?? 'unknown'}`);
      skipped++;
      continue;
    }
    const r = await addReview({ name: g.authorAttribution?.displayName ?? 'Google reviewer', business: '', text: body, source: 'google', date: g.publishTime ? g.publishTime.slice(0, 10) : null });
    have.add(norm(body));
    added.push(r);
    log(`added review from ${r.name}${r.date ? ` (${r.date})` : ''}`);
  }
  return { added, skipped, place };
}
