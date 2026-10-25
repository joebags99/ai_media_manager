// validate.ts: the claudeContract.validation rules from pipeline-spec.json, applied to a
// generated draft before it is stored. Pure functions; no I/O.
import type { Brand } from './render.js';

export interface Crop {
  screenshot: string | null;
  region: [number, number, number, number] | null;
  treatment: 'framed' | 'dimmed';
}

export interface DraftContent {
  template: string;
  slots: Record<string, string>;
  crop: Crop;
  captions: Record<'instagram' | 'facebook' | 'linkedin' | 'googlebusiness', string>;
  hashtags: Record<'instagram' | 'facebook' | 'linkedin', string[]>;
  rationale: string;
  /** Seasonal theme applied at render time (set from the plan, not by Claude). */
  theme?: string | null;
}

/** Slots the 3-5 word headline rule applies to (spec change approved 2026-10-24). */
export const HEADLINE_SLOTS: Record<string, string> = { screenshot: 'headline', stat: 'claim', list: 'verdict' };

export function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

export interface ShotDims {
  [file: string]: { width: number; height: number };
}

export function validateContent(brand: Brand, c: DraftContent, shots: ShotDims, expectedTemplate?: string): string[] {
  const errors: string[] = [];
  const def = brand.templates[c.template];
  if (!def) {
    errors.push(`template "${c.template}" is not in brand.json`);
    return errors;
  }
  if (expectedTemplate && c.template !== expectedTemplate) errors.push(`template is "${c.template}", plan said "${expectedTemplate}"`);

  for (const slot of def.slots.filter((s) => s !== 'crop')) {
    const v = c.slots?.[slot];
    if (typeof v !== 'string' || !v.trim()) errors.push(`slot "${slot}" is missing or empty`);
  }
  for (const k of Object.keys(c.slots ?? {})) if (!def.slots.includes(k)) errors.push(`unexpected slot "${k}" for ${c.template}`);

  const headlineSlot = HEADLINE_SLOTS[c.template];
  const [min, max] = (brand as unknown as { voice: { headlineWords: [number, number] } }).voice.headlineWords;
  if (headlineSlot && c.slots?.[headlineSlot]) {
    const n = wordCount(c.slots[headlineSlot]!);
    if (n < min || n > max) errors.push(`${c.template}.${headlineSlot} has ${n} words; must be ${min}-${max}`);
  }

  const banned = (brand as unknown as { voice: { banned: string[] } }).voice.banned;
  const texts: [string, string][] = [
    ...Object.entries(c.slots ?? {}).map(([k, v]) => [`slot ${k}`, v] as [string, string]),
    ...Object.entries(c.captions ?? {}).map(([k, v]) => [`caption ${k}`, v] as [string, string]),
  ];
  for (const [where, text] of texts) {
    for (const b of banned) {
      const hit = /^[\w-]+$/.test(b) ? new RegExp(`\\b${b.replace(/[-]/g, '\\-')}\\b`, 'i').test(text) : text.includes(b);
      if (hit) errors.push(`${where} contains banned "${b}"`);
    }
  }

  const platforms = (brand as unknown as { platforms: Record<string, { hashtags: [number, number] }> }).platforms;
  for (const p of ['instagram', 'facebook', 'linkedin', 'googlebusiness'] as const) {
    if (typeof c.captions?.[p] !== 'string' || !c.captions[p].trim()) errors.push(`caption for ${p} is missing`);
  }
  for (const p of ['instagram', 'facebook', 'linkedin'] as const) {
    const tags = c.hashtags?.[p] ?? [];
    const [lo, hi] = platforms[p]!.hashtags;
    if (tags.length < lo || tags.length > hi) errors.push(`${p} has ${tags.length} hashtags; must be ${lo}-${hi}`);
    for (const t of tags) if (!/^#[A-Za-z0-9_]+$/.test(t)) errors.push(`${p} hashtag "${t}" is malformed`);
  }
  const gb = c.captions?.googlebusiness ?? '';
  if (/#\w/.test(gb)) errors.push('googlebusiness caption contains a hashtag');
  if (/link in (the )?bio/i.test(gb)) errors.push('googlebusiness caption says "link in bio"');

  const needsShot = c.template === 'screenshot' || c.crop?.treatment === 'dimmed';
  if (c.crop?.screenshot) {
    const dims = shots[c.crop.screenshot];
    if (!dims) errors.push(`crop.screenshot "${c.crop.screenshot}" is not one of the provided screenshots`);
    else if (c.crop.region) {
      const [x, y, w, h] = c.crop.region;
      if (w <= 0 || h <= 0 || x < 0 || y < 0 || x + w > dims.width || y + h > dims.height) errors.push(`crop.region [${c.crop.region}] falls outside ${c.crop.screenshot} (${dims.width}x${dims.height})`);
    }
  } else if (needsShot) {
    errors.push(`${c.template} needs crop.screenshot`);
  }
  if (c.template === 'screenshot' && c.slots?.['headline'] && c.slots?.['accentWord']) {
    if (!c.slots['headline'].toLowerCase().includes(c.slots['accentWord'].toLowerCase())) errors.push('accentWord does not appear in headline');
  }
  return errors;
}
