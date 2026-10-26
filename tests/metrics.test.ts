import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { useDb, insertDraft, getDraft } from '../src/db.js';
import { syncMetrics, performance, performanceBrief, metricsForDraft, engagementOf } from '../src/metrics.js';
import type { BufferConfig } from '../src/buffer.js';

const content = (template: string, line: string) => JSON.stringify({ template, slots: { headline: line }, captions: {}, hashtags: {}, rationale: 'r' });
const metricsById: Record<string, { status: string; sentAt: string | null; values: Record<string, number> }> = {};
const cfg: BufferConfig = {
  token: 't', url: 'https://fake.buffer.test',
  fetch: (async (_u: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { variables: { input: { id: string } } };
    const m = metricsById[body.variables.input.id] ?? { status: 'scheduled', sentAt: null, values: {} };
    return new Response(JSON.stringify({ data: { post: { id: body.variables.input.id, status: m.status, sentAt: m.sentAt, externalLink: m.status === 'sent' ? 'https://x/post' : null, metricsUpdatedAt: null, metrics: Object.entries(m.values).map(([type, value]) => ({ type, value, unit: 'count' })) } } }), { status: 200 });
  }) as typeof fetch,
};

beforeAll(async () => {
  useDb(path.join(await mkdtemp(path.join(tmpdir(), 'mt-')), 'test.db'));
  let n = 0;
  const add = (weekOf: string, slot: 'mon' | 'tue' | 'wed', template: string, line: string, perPlatform: Record<string, Record<string, number>>, sent = true) => {
    const ids: Record<string, string> = {};
    for (const pl of Object.keys(perPlatform)) {
      const id = `p${++n}`;
      ids[pl] = id;
      metricsById[id] = { status: sent ? 'sent' : 'scheduled', sentAt: sent ? '2026-09-10T14:00:00Z' : null, values: perPlatform[pl]! };
    }
    return insertDraft({ weekOf, slot, site: null, template, contentJson: content(template, line), generationContext: '{}', costUsd: 0, status: 'scheduled', bufferPostIds: JSON.stringify(ids), scheduledAt: '2026-09-10T14:00:00Z' });
  };
  add('2026-09-07', 'mon', 'stat', '40% more calls.', { instagram: { impressions: 1000, likes: 50, comments: 5 }, facebook: { impressions: 400, reactions: 10, shares: 2 } });
  add('2026-09-07', 'tue', 'list', 'Slow. Dated.', { instagram: { impressions: 1200, likes: 12 }, facebook: { impressions: 500, reactions: 3 } });
  add('2026-09-07', 'wed', 'headline', 'Built to last.', { instagram: { impressions: 900, likes: 40, saves: 10 }, linkedin: { impressions: 300, likes: 20, comments: 4 } }, false);
});

describe('metrics', () => {
  it('syncs per-post metrics, computes engagement, and moves fully-sent drafts to posted', async () => {
    const log: string[] = [];
    const r = await syncMetrics({ cfg, log: (l) => log.push(l), now: new Date('2026-09-15T00:00:00Z') });
    expect(r.fetched).toBe(6);
    expect(r.posted).toBe(2);
    const stat = metricsForDraft(Object.keys(metricsById).length ? (await import('../src/db.js')).listDrafts({ weekOf: '2026-09-07' }).find((d) => d.template === 'stat')!.id : '');
    expect(stat.find((m) => m.platform === 'instagram')!.engagement).toBe(55);
    expect(engagementOf({ likes: 1, comments: 2, shares: 3, clicks: 99 })).toBe(6);
    const again = await syncMetrics({ cfg, now: new Date('2026-09-15T01:00:00Z') });
    expect(again.fetched).toBe(0); // fetched an hour ago; skipped
    expect(again.skipped).toBe(6);
  });
  it('aggregates by template and platform and ranks by engagement rate', () => {
    const p = performance();
    expect(p.sentPosts).toBe(4);
    expect(p.byTemplate.map((a) => a.key)).toEqual(['stat', 'list']);
    const stat = p.byTemplate[0]!;
    expect(stat.posts).toBe(2);
    expect(stat.rate).toBeCloseTo(((55 + 12) / 1400) * 100, 3);
    expect(p.byPlatform.find((a) => a.key === 'instagram')!.posts).toBe(2);
    expect(p.top[0]!.line).toBe('40% more calls.');
  });
  it('the planner brief stays empty until there is enough data, then names the leaders', () => {
    expect(performanceBrief(8)).toBe('');
    const brief = performanceBrief(2);
    expect(brief).toMatch(/PERFORMANCE SO FAR \(4 sent posts/);
    expect(brief).toMatch(/- stat: 2 posts/);
    expect(brief).toMatch(/Best posts:/);
  });
});
