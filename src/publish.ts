// publish.ts: create one scheduled Buffer post per channel for an APPROVED draft.
//
// Buffer API notes (live schema, 2026-10-25; see src/buffer.ts for the full summary):
//   - No media upload endpoint: assets are public image URLs Buffer downloads. Renders are
//     served by the dashboard at PUBLIC_BASE_URL/renders/<file>; PUBLIC_BASE_URL must be
//     reachable from the internet (a tunnel in local dev, S3 later).
//   - createPost with mode customScheduled + dueAt; deletePost to remove.
//
// Guards (pipeline-spec guardrails):
//   - Only status=approved drafts reach createPost. Anything else throws before any HTTP.
//   - TEST_MODE (default true) schedules 60 days out and logs the delete command.
//   - Live mode never schedules sooner than minHoursBetweenApprovalAndPost after now.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { bufferConfig, createPost, deletePost, type BufferConfig } from './buffer.js';
import { ROOT, TEST_MODE } from './config.js';
import { getDraft, listDrafts, updateDraft, SLOT_OFFSET, type Draft, type Slot } from './db.js';
import { loadBrand, type Brand } from './render.js';
import type { DraftContent } from './validate.js';
import { transition } from './workflow.js';

export const TEST_OFFSET_DAYS = 60;
export const MIN_HOURS_AFTER_APPROVAL = 24;
export const POST_HOUR_LOCAL = 10;

export type Platform = 'instagram' | 'facebook' | 'linkedin' | 'googlebusiness';
export const PLATFORMS: Platform[] = ['instagram', 'facebook', 'linkedin', 'googlebusiness'];

interface SpecBuffer {
  organizationId: string;
  channels: Record<Platform, string>;
}

export async function specBuffer(): Promise<SpecBuffer> {
  const spec = JSON.parse(await readFile(path.join(ROOT, 'pipeline-spec.json'), 'utf8')) as { externalServices: { buffer: SpecBuffer } };
  return spec.externalServices.buffer;
}

export function publicBaseUrl(): string {
  const base = process.env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, '');
  if (!base || !/^https?:\/\//.test(base)) {
    throw new Error('PUBLIC_BASE_URL is not set. Buffer downloads images from a public URL, so the dashboard must be reachable from the internet (e.g. a cloudflared or ngrok tunnel to localhost:3000). Set PUBLIC_BASE_URL=https://... in .env.');
  }
  return base;
}

/** Format a Date as ISO 8601 with the offset of the given IANA zone (what Buffer's dueAt wants). */
export function isoInZone(date: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'longOffset' })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const off = parts['timeZoneName'] === 'GMT' ? '+00:00' : parts['timeZoneName']!.replace('GMT', '');
  return `${parts['year']}-${parts['month']}-${parts['day']}T${parts['hour']}:${parts['minute']}:${parts['second']}${off}`;
}

/** Local wall-clock (zone) date for the draft's slot at POST_HOUR_LOCAL. */
function slotDate(weekOf: string, slot: Slot, timeZone: string): Date {
  const offset = SLOT_OFFSET[slot];
  const d = new Date(`${weekOf}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  // Find the UTC instant that is POST_HOUR_LOCAL in the zone on that calendar day.
  const guess = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), POST_HOUR_LOCAL));
  const local = isoInZone(guess, timeZone);
  const off = local.slice(19); // ±HH:MM
  const sign = off.startsWith('-') ? -1 : 1;
  const minutes = sign * (Number(off.slice(1, 3)) * 60 + Number(off.slice(4, 6)));
  return new Date(guess.getTime() - minutes * 60_000);
}

export function scheduleFor(draft: Pick<Draft, 'weekOf' | 'slot'>, timeZone: string, now = new Date(), testMode = TEST_MODE): Date {
  if (testMode) {
    const d = new Date(now.getTime() + TEST_OFFSET_DAYS * 86_400_000);
    return slotDate(d.toISOString().slice(0, 10), 'mon', timeZone);
  }
  const target = slotDate(draft.weekOf, draft.slot, timeZone);
  const earliest = new Date(now.getTime() + MIN_HOURS_AFTER_APPROVAL * 3_600_000);
  return target > earliest ? target : earliest;
}

const URL_RE = /https?:\/\/[^\s)]+/g;

/** Where hashtags and links go for a platform, from brand.json platforms. */
export function placement(brand: Brand, platform: Platform): { hashtagsIn: 'caption' | 'firstComment'; linkIn: 'caption' | 'firstComment' } {
  const p = (brand['platforms'] as Record<string, { hashtagsIn?: string; linkIn?: string }>)[platform] ?? {};
  return { hashtagsIn: p.hashtagsIn === 'firstComment' ? 'firstComment' : 'caption', linkIn: p.linkIn === 'firstComment' ? 'firstComment' : 'caption' };
}

/** The post text: caption, plus hashtags unless they go to the first comment, minus links if they do. */
export function captionFor(c: DraftContent, platform: Platform, brand?: Brand): string {
  let text = c.captions[platform].trim();
  if (platform === 'googlebusiness') return text;
  const place = brand ? placement(brand, platform) : { hashtagsIn: 'caption' as const, linkIn: 'caption' as const };
  if (place.linkIn === 'firstComment') {
    // "earns inquiries: https://x. Ask" -> "earns inquiries. Ask"; a bare URL just disappears.
    text = text
      .replace(/\s*[:\-\u2013\u2014]\s*https?:\/\/[^\s)]+[.,;:!?]?/g, '.')
      .replace(URL_RE, '')
      .replace(/[ \t]+([.,;:!?])/g, '$1')
      .replace(/\.{2,}/g, '.')
      .replace(/ {2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
  const tags = c.hashtags[platform] ?? [];
  return tags.length && place.hashtagsIn === 'caption' ? `${text}\n\n${tags.join(' ')}` : text;
}

/** The first comment: hashtags and/or links moved out of the caption; empty when nothing moves. */
export function firstCommentFor(c: DraftContent, platform: Platform, brand: Brand): string {
  if (platform === 'googlebusiness') return '';
  const place = placement(brand, platform);
  const parts: string[] = [];
  if (place.linkIn === 'firstComment') {
    const links = [...new Set((c.captions[platform].match(URL_RE) ?? []).map((u) => u.replace(/[.,;:!?]+$/, '')))];
    if (links.length) parts.push(links.join('\n'));
    else parts.push(brand.site);
  }
  if (place.hashtagsIn === 'firstComment' && c.hashtags[platform]?.length) parts.push(c.hashtags[platform].join(' '));
  return parts.join('\n\n');
}

export function altTextFor(c: DraftContent, brand: Brand): string {
  if (c.altText?.trim()) return c.altText.trim().slice(0, 200);
  const s = c.slots;
  const head = s['headline'] ?? s['claim'] ?? s['verdict'] ?? s['quote'] ?? '';
  return `${brand.name} ad: ${head}`.slice(0, 200);
}

export function buildPostInput(draft: Draft, c: DraftContent, platform: Platform, channelId: string, dueAt: string, base: string, brand: Brand): Parameters<typeof createPost>[1] {
  const file = platform === 'instagram' ? draft.renderPortrait : draft.renderSquare;
  if (!file) throw new Error(`Draft has no ${platform === 'instagram' ? 'portrait' : 'square'} render`);
  const url = `${base}/renders/${path.basename(file)}`;
  const firstComment = firstCommentFor(c, platform, brand);
  const fc = firstComment ? { firstComment } : {};
  const metadata: Record<string, unknown> = {
    instagram: { instagram: { type: 'post', shouldShareToFeed: false, ...fc } },
    facebook: { facebook: { type: 'post', ...fc } },
    linkedin: { linkedin: { ...fc } },
    googlebusiness: { google: { type: 'whats_new', detailsWhatsNew: { button: 'learn_more', link: brand['contact'] as string } } },
  }[platform];
  return {
    channelId,
    text: captionFor(c, platform, brand),
    assets: [{ image: { url, metadata: { altText: altTextFor(c, brand) } } }],
    mode: 'customScheduled',
    dueAt,
    schedulingType: 'automatic',
    metadata,
    source: 'daedabyte-ad-pipeline',
  };
}

export interface PlatformRule {
  size: string;
  hashtags: [number, number];
  link: string;
  /** Templates this platform accepts; absent = all. */
  templates?: string[];
  /** Cap on posts per week for this platform; absent = no cap. */
  maxPerWeek?: number;
}

export interface PlatformChoice {
  platform: Platform;
  /** Checked by default. */
  on: boolean;
  /** Why it is off by default, if it is. */
  reason: string | null;
}

/** Which platforms a draft should go to by default, from brand.json platform rules. */
export function defaultPlatforms(draft: Pick<Draft, 'id' | 'weekOf' | 'template'>, brand: Brand): PlatformChoice[] {
  const rules = brand['platforms'] as Record<Platform, PlatformRule>;
  return PLATFORMS.map((platform) => {
    const rule = rules[platform];
    if (rule.templates && !rule.templates.includes(draft.template)) {
      return { platform, on: false, reason: `${platform} is limited to ${rule.templates.join('/')} posts in brand.json` };
    }
    if (rule.maxPerWeek !== undefined) {
      const used = listDrafts({ weekOf: draft.weekOf, status: ['scheduled', 'posted'] }).filter((d) => d.id !== draft.id && d.bufferPostIds && platform in (JSON.parse(d.bufferPostIds) as Record<string, string>)).length;
      if (used >= rule.maxPerWeek) return { platform, on: false, reason: `${platform} already has ${used} post(s) this week (max ${rule.maxPerWeek})` };
    }
    return { platform, on: true, reason: null };
  });
}

export interface PublishOptions {
  cfg?: BufferConfig;
  log?: (s: string) => void;
  now?: Date;
  testMode?: boolean;
  timeZone?: string;
  platforms?: Platform[];
}

export interface PublishResult {
  draft: Draft;
  postIds: Partial<Record<Platform, string>>;
  scheduledAt: string;
  deleteCommand: string;
}

export function deleteCommandFor(ids: string[]): string {
  return `npm run buffer:delete -- ${ids.join(' ')}`;
}

export async function publishDraft(draftId: string, opts: PublishOptions = {}): Promise<PublishResult> {
  const log = opts.log ?? ((s: string) => console.log(`[publish] ${s}`));
  const testMode = opts.testMode ?? TEST_MODE;
  const draft = getDraft(draftId);
  if (!draft) throw new Error(`Unknown draft ${draftId}`);
  // The guard. Nothing below runs for a draft that is not approved.
  if (draft.status !== 'approved') throw new Error(`Draft is ${draft.status}; only approved drafts can be published`);
  if (!draft.renderSquare || !draft.renderPortrait) throw new Error('Draft is not rendered');

  const base = publicBaseUrl();
  const cfg = opts.cfg ?? bufferConfig();
  const brand = await loadBrand();
  const spec = await specBuffer();
  const c = JSON.parse(draft.contentJson) as DraftContent;
  const timeZone = opts.timeZone ?? 'America/Indiana/Indianapolis';
  const when = scheduleFor(draft, timeZone, opts.now, testMode);
  const dueAt = isoInZone(when, timeZone);
  log(`${testMode ? 'TEST MODE: ' : ''}scheduling for ${dueAt}`);

  const platforms = opts.platforms ?? defaultPlatforms(draft, brand).filter((p) => p.on).map((p) => p.platform);
  if (platforms.length === 0) throw new Error('No platforms selected');
  log(`channels: ${platforms.join(', ')}`);
  const postIds: Partial<Record<Platform, string>> = {};
  const errors: string[] = [];
  for (const platform of platforms) {
    const channelId = spec.channels[platform];
    try {
      const input = buildPostInput(draft, c, platform, channelId, dueAt, base, brand);
      const post = await createPost(cfg, input);
      postIds[platform] = post.id;
      log(`${platform}: post ${post.id} (${post.status})`);
    } catch (err) {
      errors.push(`${platform}: ${(err as Error).message}`);
      log(`${platform}: failed: ${(err as Error).message}`);
    }
  }

  const ids = Object.values(postIds);
  const deleteCommand = ids.length ? deleteCommandFor(ids) : '';
  if (errors.length) {
    updateDraft(draft.id, { bufferPostIds: JSON.stringify(postIds), errorMessage: errors.join('; ') });
    transition(draft.id, 'error');
    if (ids.length) log(`partial failure; posts already created can be removed with: ${deleteCommand}`);
    throw new Error(`Publish failed for ${errors.length} channel(s): ${errors.join('; ')}`);
  }
  const updated = transition(draft.id, 'scheduled', { bufferPostIds: JSON.stringify(postIds), scheduledAt: when.toISOString(), errorMessage: null });
  if (testMode) log(`test posts created 60 days out. Remove them with: ${deleteCommand}`);
  return { draft: updated, postIds, scheduledAt: when.toISOString(), deleteCommand };
}

/** Delete Buffer posts by id (the logged cleanup command). Clears them from the draft if one references them. */
export async function deleteBufferPosts(ids: string[], opts: { cfg?: BufferConfig; log?: (s: string) => void; draftId?: string } = {}): Promise<void> {
  const log = opts.log ?? ((s: string) => console.log(`[buffer] ${s}`));
  const cfg = opts.cfg ?? bufferConfig();
  for (const id of ids) {
    await deletePost(cfg, id);
    log(`deleted ${id}`);
  }
  if (opts.draftId) {
    const d = getDraft(opts.draftId);
    if (d?.bufferPostIds) {
      const map = JSON.parse(d.bufferPostIds) as Record<string, string>;
      const remaining = Object.fromEntries(Object.entries(map).filter(([, v]) => !ids.includes(v)));
      const patch: Partial<Draft> = { bufferPostIds: Object.keys(remaining).length ? JSON.stringify(remaining) : null };
      if (!Object.keys(remaining).length && d.status === 'scheduled') {
        // Back to approved so it can be published again (test cycle); spec allows error from any state only, so set directly.
        updateDraft(d.id, { ...patch, status: 'approved', scheduledAt: null });
      } else {
        updateDraft(d.id, patch);
      }
    }
  }
}
