// Performance page: what Buffer reports per post, rolled up by template and platform.
import type { Express, Request, Response, RequestHandler } from 'express';
import path from 'node:path';
import { performance, syncMetrics, allMetrics, type Agg } from '../metrics.js';
import { listDrafts, type Slot } from '../db.js';
import { startJob } from '../jobs.js';
import { empty, esc, notice, pageHead, section } from './html.js';

type Page = (title: string, body: string, active: string) => string;
type Wrap = (fn: (req: Request, res: Response) => Promise<void>) => RequestHandler;
const DAY: Record<Slot, string> = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
const n = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(Math.round(v)));

function aggTable(rows: Agg[], label: string): string {
  if (!rows.length) return '<p class="muted">No sent posts yet.</p>';
  const max = Math.max(...rows.map((r) => r.rate), 0.0001);
  return `<table><tr><th>${esc(label)}</th><th>Posts</th><th>Avg impressions</th><th>Engagement / 100 impressions</th><th>Clicks</th></tr>${rows
    .map((r) => `<tr><td><b>${esc(r.key)}</b></td><td>${r.posts}</td><td>${n(r.impressions / r.posts)}</td><td><div class="row" style="gap:10px"><div style="height:10px;width:${Math.round((r.rate / max) * 160)}px;background:var(--terracotta);border-radius:5px"></div>${r.rate.toFixed(1)}</div></td><td>${n(r.clicks)}</td></tr>`)
    .join('')}</table>`;
}

export function registerPerformanceRoutes(app: Express, page: Page, wrap: Wrap): void {
  app.get(
    '/performance',
    wrap(async (_req, res) => {
      const p = performance();
      const rows = allMetrics();
      const drafts = new Map(listDrafts().map((d) => [d.id, d]));
      const pending = rows.filter((r) => r.status !== 'sent').length;
      const token = Boolean(process.env.BUFFER_ACCESS_TOKEN?.trim());
      const perPost = [...drafts.values()]
        .filter((d) => rows.some((r) => r.draftId === d.id))
        .sort((a, b) => b.weekOf.localeCompare(a.weekOf) || a.slot.localeCompare(b.slot))
        .map((d) => {
          const mine = rows.filter((r) => r.draftId === d.id);
          const c = JSON.parse(d.contentJson) as { slots?: Record<string, string> };
          const line = Object.values(c.slots ?? {})[0] ?? '';
          const cells = (['instagram', 'facebook', 'linkedin', 'googlebusiness'] as const).map((pl) => {
            const r = mine.find((x) => x.platform === pl);
            if (!r) return '<td class="muted">—</td>';
            if (r.status !== 'sent') return `<td class="muted">${esc(r.status)}</td>`;
            return `<td>${n(r.impressions)} / <b>${n(r.engagement)}</b>${r.externalLink ? ` <a href="${esc(r.externalLink)}" target="_blank" title="open post">↗</a>` : ''}</td>`;
          });
          const img = d.renderSquare ? `/renders/${path.basename(d.renderSquare)}` : '';
          return `<tr><td>${img ? `<a href="/drafts/${d.id}"><img src="${img}" alt="" style="width:56px;border-radius:4px;vertical-align:middle;margin-right:8px"></a>` : ''}<a href="/drafts/${d.id}" style="color:var(--ink)">${esc(d.weekOf)} ${DAY[d.slot]}</a><br><span class="muted">${esc(d.template)} · ${esc(line.slice(0, 40))}</span></td>${cells.join('')}</tr>`;
        })
        .join('');
      const body =
        pageHead(
          'Performance',
          'What Buffer reports for each sent post: impressions and engagement (likes, comments, shares, saves). Rolled up by template and channel, and handed to Claude when it plans a week once there are at least 8 sent posts.',
          token ? `<form method="post" action="/performance/sync"><button class="primary">Sync from Buffer</button></form>` : '',
        ) +
        (token ? '' : notice('warn', 'BUFFER_ACCESS_TOKEN is not set; nothing to sync.')) +
        (p.sentPosts === 0
          ? empty('No performance data yet', `${rows.length ? `${rows.length} post(s) tracked, ${pending} not sent yet. ` : ''}Metrics appear a day or two after a post goes out. The weekly run syncs automatically; the button syncs now.`)
          : section('By template', `${p.sentPosts} sent posts. Rate is engagement per 100 impressions; higher is better.`, aggTable(p.byTemplate, 'Template')) +
            section('By channel', '', aggTable(p.byPlatform, 'Channel')) +
            section('Template by channel', 'Which layouts work where.', aggTable(p.byTemplatePlatform, 'Template on channel')) +
            section('Best posts', '', `<ol>${p.top.map((t) => `<li><a href="/drafts/${t.draft.id}">${esc(t.draft.template)}: “${esc(t.line)}”</a> on ${esc(t.platform)} — ${n(t.engagement)} engagement, ${n(t.impressions)} impressions</li>`).join('')}</ol>`)) +
        (rows.length ? section('Every tracked post', 'Impressions / engagement per channel. ↗ opens the live post.', `<table><tr><th>Post</th><th>Instagram</th><th>Facebook</th><th>LinkedIn</th><th>Google</th></tr>${perPost}</table>`) : '');
      res.send(page('Performance', body, '/performance'));
    }),
  );

  app.post('/performance/sync', (_req, res) => {
    const job = startJob('metrics', 'Sync metrics from Buffer', (log) => syncMetrics({ log, minAgeHours: 0 }));
    res.redirect(`/jobs/${job.id}?next=/performance`);
  });
}
