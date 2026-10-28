// metrics.ts: pull per-post performance from Buffer for scheduled/posted drafts, store it,
// summarise by template and platform, and hand the planner a short performance brief.
import { bufferConfig, getPostMetrics, type BufferConfig } from './buffer.js';
import { listDrafts, openDb, updateDraft, type Draft } from './db.js';
import { ORG_ID } from './config.js';
import type { Platform } from './publish.js';

export interface MetricRow {
  draftId: string;
  platform: Platform;
  postId: string;
  status: string;
  sentAt: string | null;
  externalLink: string | null;
  impressions: number;
  reach: number;
  engagement: number;
  clicks: number;
  raw: string;
  fetchedAt: string;
}

const SCHEMA = `CREATE TABLE IF NOT EXISTS metrics (
  draftId TEXT NOT NULL, platform TEXT NOT NULL, postId TEXT NOT NULL, status TEXT NOT NULL,
  sentAt TEXT, externalLink TEXT, impressions REAL NOT NULL DEFAULT 0, reach REAL NOT NULL DEFAULT 0,
  engagement REAL NOT NULL DEFAULT 0, clicks REAL NOT NULL DEFAULT 0, raw TEXT NOT NULL, fetchedAt TEXT NOT NULL,
  PRIMARY KEY (draftId, platform)
);`;

function db() {
  const d = openDb();
  d.exec(SCHEMA);
  return d;
}

const ENGAGEMENT_TYPES = ['likes', 'comments', 'shares', 'reactions', 'saves', 'reposts', 'quotes', 'favorites'];

export function engagementOf(values: Record<string, number>): number {
  return ENGAGEMENT_TYPES.reduce((a, k) => a + (values[k] ?? 0), 0);
}

export function metricsForDraft(draftId: string): MetricRow[] {
  return db().prepare('SELECT * FROM metrics WHERE draftId = ? ORDER BY platform').all(draftId) as MetricRow[];
}

export function allMetrics(): MetricRow[] {
  return db().prepare('SELECT * FROM metrics ORDER BY sentAt DESC').all() as MetricRow[];
}

export interface SyncOptions {
  cfg?: BufferConfig;
  log?: (s: string) => void;
  /** Re-fetch rows fetched more recently than this many hours? Default: skip them. */
  minAgeHours?: number;
  /** Ignore posts sent longer ago than this. Default 90 days. */
  maxDays?: number;
  now?: Date;
}

/** Fetch metrics for every draft with Buffer posts. Moves scheduled -> posted once all its posts are sent. */
export async function syncMetrics(opts: SyncOptions = {}): Promise<{ fetched: number; skipped: number; posted: number }> {
  const log = opts.log ?? (() => {});
  const cfg = opts.cfg ?? bufferConfig();
  const now = opts.now ?? new Date();
  const minAge = (opts.minAgeHours ?? 20) * 3_600_000;
  const maxAge = (opts.maxDays ?? 90) * 86_400_000;
  const d = db();
  const upsert = d.prepare(`INSERT INTO metrics (draftId, platform, postId, status, sentAt, externalLink, impressions, reach, engagement, clicks, raw, fetchedAt)
    VALUES (@draftId, @platform, @postId, @status, @sentAt, @externalLink, @impressions, @reach, @engagement, @clicks, @raw, @fetchedAt)
    ON CONFLICT(draftId, platform) DO UPDATE SET status=excluded.status, sentAt=excluded.sentAt, externalLink=excluded.externalLink, impressions=excluded.impressions, reach=excluded.reach, engagement=excluded.engagement, clicks=excluded.clicks, raw=excluded.raw, fetchedAt=excluded.fetchedAt`);
  const existing = new Map(allMetrics().map((m) => [`${m.draftId}:${m.platform}`, m]));
  let fetched = 0, skipped = 0, posted = 0;
  const drafts = listDrafts({ status: ['scheduled', 'posted'] }).filter((x) => x.bufferPostIds);
  for (const draft of drafts) {
    if (draft.scheduledAt && now.getTime() - Date.parse(draft.scheduledAt) > maxAge) {
      skipped++;
      continue;
    }
    const ids = JSON.parse(draft.bufferPostIds!) as Record<Platform, string>;
    const statuses: string[] = [];
    for (const [platform, postId] of Object.entries(ids) as [Platform, string][]) {
      const prev = existing.get(`${draft.id}:${platform}`);
      if (prev && now.getTime() - Date.parse(prev.fetchedAt) < minAge) {
        statuses.push(prev.status);
        skipped++;
        continue;
      }
      try {
        const m = await getPostMetrics(cfg, postId);
        const row: MetricRow = {
          draftId: draft.id, platform, postId, status: m.status, sentAt: m.sentAt, externalLink: m.externalLink,
          impressions: m.values['impressions'] ?? m.values['views'] ?? 0, reach: m.values['reach'] ?? 0,
          engagement: engagementOf(m.values), clicks: m.values['clicks'] ?? 0, raw: JSON.stringify(m.values), fetchedAt: now.toISOString(),
        };
        upsert.run(row);
        statuses.push(m.status);
        fetched++;
        log(`${draft.weekOf} ${draft.slot} ${platform}: ${m.status}${m.status === 'sent' ? `, ${row.impressions} impressions, ${row.engagement} engagement` : ''}`);
      } catch (err) {
        log(`${draft.weekOf} ${draft.slot} ${platform}: ${(err as Error).message}`);
      }
    }
    if (draft.status === 'scheduled' && statuses.length === Object.keys(ids).length && statuses.every((s) => s === 'sent')) {
      updateDraft(draft.id, { status: 'posted' });
      posted++;
    }
  }
  log(`metrics: ${fetched} fetched, ${skipped} skipped, ${posted} draft(s) now posted`);
  return { fetched, skipped, posted };
}

export interface Agg {
  key: string;
  posts: number;
  impressions: number;
  engagement: number;
  clicks: number;
  /** engagement per 100 impressions */
  rate: number;
}

function aggregate(rows: MetricRow[], keyOf: (r: MetricRow, d: Draft) => string, drafts: Map<string, Draft>): Agg[] {
  const by = new Map<string, Agg>();
  for (const r of rows) {
    const d = drafts.get(r.draftId);
    if (!d || r.status !== 'sent') continue;
    const key = keyOf(r, d);
    const a = by.get(key) ?? { key, posts: 0, impressions: 0, engagement: 0, clicks: 0, rate: 0 };
    a.posts++;
    a.impressions += r.impressions;
    a.engagement += r.engagement;
    a.clicks += r.clicks;
    by.set(key, a);
  }
  for (const a of by.values()) a.rate = a.impressions ? (a.engagement / a.impressions) * 100 : 0;
  return [...by.values()].sort((x, y) => y.rate - x.rate);
}

export interface Performance {
  sentPosts: number;
  byTemplate: Agg[];
  byPlatform: Agg[];
  byTemplatePlatform: Agg[];
  top: { draft: Draft; platform: Platform; impressions: number; engagement: number; line: string }[];
}

export function performance(): Performance {
  const rows = allMetrics();
  const drafts = new Map(listDrafts().map((d) => [d.id, d]));
  const sent = rows.filter((r) => r.status === 'sent' && drafts.has(r.draftId));
  const top = sent
    .map((r) => {
      const draft = drafts.get(r.draftId)!;
      const c = JSON.parse(draft.contentJson) as { slots?: Record<string, string> };
      const s = c.slots ?? {};
      return { draft, platform: r.platform, impressions: r.impressions, engagement: r.engagement, line: s['headline'] ?? s['claim'] ?? s['verdict'] ?? s['quote'] ?? s['question'] ?? s['tip'] ?? s['greeting'] ?? Object.values(s)[0] ?? '' };
    })
    .sort((a, b) => b.engagement - a.engagement || b.impressions - a.impressions)
    .slice(0, 8);
  return {
    sentPosts: sent.length,
    byTemplate: aggregate(rows, (_r, d) => d.template, drafts),
    byPlatform: aggregate(rows, (r) => r.platform, drafts),
    byTemplatePlatform: aggregate(rows, (r, d) => `${d.template} on ${r.platform}`, drafts),
    top,
  };
}

/** Short text for the planner. Empty until there is enough data to mean anything. */
export function performanceBrief(minPosts = 8): string {
  const p = performance();
  if (p.sentPosts < minPosts) return '';
  const fmt = (a: Agg) => `${a.key}: ${a.posts} posts, ${Math.round(a.impressions / a.posts)} avg impressions, ${a.rate.toFixed(1)} engagement per 100`;
  return [
    `PERFORMANCE SO FAR (${p.sentPosts} sent posts; engagement = likes+comments+shares+saves):`,
    'By template:',
    ...p.byTemplate.map((a) => `- ${fmt(a)}`),
    'By platform:',
    ...p.byPlatform.map((a) => `- ${fmt(a)}`),
    'Best posts:',
    ...p.top.slice(0, 5).map((t) => `- ${t.draft.template} "${t.line}" on ${t.platform}: ${t.engagement} engagement, ${t.impressions} impressions`),
    'Lean toward what works, but keep variety; one strong week is not a rule.',
  ].join('\n');
}
