// reviews.ts: client reviews about Daedabyte (Google Business, the website, anywhere), kept
// in brand/reviews.json and edited from the dashboard. The quote template draws from these;
// a quote must appear verbatim in one of them.
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { ROOT } from './config.js';

export const REVIEWS_PATH = path.join(ROOT, 'brand', 'reviews.json');

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
