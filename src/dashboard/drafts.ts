// Dashboard routes for the plan and the drafts list/detail (M3). Approve / revise /
// reject land here in M4.
import type { Express } from 'express';
import path from 'node:path';
import { listDrafts, getDraft, listRuns, nextWeekOf, SLOTS, type Draft, type Slot } from '../db.js';
import { planWeek, readPlan, writePlan, siteSummaries, type Plan, type PlanDay } from '../plan.js';
import { runWeekly, renderDraftRow } from '../weekly.js';
import { startJob } from '../jobs.js';
import { hasApiKey } from '../claude.js';
import { esc } from './html.js';
import type { DraftContent } from '../validate.js';

type Page = (title: string, body: string, active: string) => string;
type Wrap = (fn: (req: import('express').Request, res: import('express').Response) => Promise<void>) => import('express').RequestHandler;

const TEMPLATES = ['list', 'stat', 'quote', 'screenshot'] as const;
const DAY_NAMES: Record<Slot, string> = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday' };

const statusColor: Record<string, string> = { pending: 'var(--aegean)', revising: 'var(--purple)', approved: '#2e7d32', scheduled: '#2e7d32', rejected: 'var(--ash)', posted: '#2e7d32', error: '#B4332B' };
const badge = (s: string) => `<span style="display:inline-block;padding:2px 9px;border-radius:99px;font-size:12px;font-weight:600;color:#fff;background:${statusColor[s] ?? 'var(--ash)'}">${esc(s)}</span>`;
const renderUrl = (p: string | null) => (p ? `/renders/${path.basename(p)}` : null);

export function registerDraftRoutes(app: Express, page: Page, wrap: Wrap): void {
  // ---- Drafts list -----------------------------------------------------------------
  app.get(
    '/',
    wrap(async (req, res) => {
      const weeks = [...new Set(listDrafts().map((d) => d.weekOf))];
      const weekOf = typeof req.query['week'] === 'string' ? req.query['week'] : weeks[0];
      const drafts = weekOf ? listDrafts({ weekOf, latestOnly: true }) : [];
      const runs = listRuns(3);
      const weekNav = weeks.length ? `<p class="muted">Week: ${weeks.map((w) => (w === weekOf ? `<b>${w}</b>` : `<a href="/?week=${w}">${w}</a>`)).join(' · ')}</p>` : '';
      const cards = drafts
        .map((d) => {
          const c = JSON.parse(d.contentJson) as DraftContent;
          const img = renderUrl(d.renderSquare);
          return `<div class="card"><div class="row" style="justify-content:space-between"><b>${DAY_NAMES[d.slot]}</b> ${badge(d.status)}</div>
            <a href="/drafts/${d.id}">${img ? `<img src="${img}?v=${d.version}" alt="" style="margin:10px 0">` : '<p class="muted">not rendered</p>'}</a>
            <div class="muted">${esc(d.template)}${d.site ? ` · ${esc(d.site)}` : ''} · v${d.version} · $${d.costUsd.toFixed(3)}</div>
            <p style="margin:8px 0 0">${esc(c.rationale)}</p></div>`;
        })
        .join('');
      const body = `<h1>Drafts</h1>
        <div class="row"><form method="post" action="/weekly"><button>Run weekly for ${esc(nextWeekOf())}</button></form>
        <a class="btn secondary" href="/plan">Plan the week</a>
        <span class="muted">${hasApiKey() ? 'Claude writes the copy.' : 'No ANTHROPIC_API_KEY: the weekly run will fail at generation.'}</span></div>
        ${weekNav}
        ${drafts.length ? `<div class="grid" style="margin-top:18px">${cards}</div>` : '<p class="muted" style="margin-top:18px">No drafts yet. Plan the week, then run weekly.</p>'}
        ${runs.length ? `<h2>Recent runs</h2><table><tr><th>Week</th><th>Started</th><th>Drafts</th><th>Cost</th><th>Errors</th></tr>${runs.map((r) => `<tr><td>${r.weekOf}</td><td class="muted">${esc(r.startedAt.slice(0, 16).replace('T', ' '))}</td><td>${r.draftsCreated}</td><td>$${r.costEstimateUsd.toFixed(3)}</td><td class="muted">${esc((JSON.parse(r.errors) as string[]).join('; ') || '-')}</td></tr>`).join('')}</table>` : ''}`;
      res.send(page('Drafts', body, '/'));
    }),
  );

  app.post('/weekly', (req, res) => {
    const weekOf = typeof req.body?.['weekOf'] === 'string' && req.body['weekOf'] ? String(req.body['weekOf']) : nextWeekOf();
    const job = startJob('weekly', `Weekly run for ${weekOf}`, (log) => runWeekly({ weekOf, log }));
    res.redirect(`/jobs/${job.id}?next=/?week=${weekOf}`);
  });

  // ---- Draft detail -----------------------------------------------------------------
  app.get(
    '/drafts/:id',
    wrap(async (req, res) => {
      const d = getDraft(String(req.params['id']));
      if (!d) {
        res.status(404).send(page('Draft', '<p>Unknown draft.</p>', '/'));
        return;
      }
      const c = JSON.parse(d.contentJson) as DraftContent;
      const versions = listDrafts({ weekOf: d.weekOf }).filter((x) => x.slot === d.slot);
      const ctx = JSON.parse(d.generationContext) as { plan?: PlanDay; calls?: { costUsd: number }[] };
      const sq = renderUrl(d.renderSquare);
      const pt = renderUrl(d.renderPortrait);
      const caption = (p: keyof DraftContent['captions']) => {
        const tags = p === 'googlebusiness' ? [] : c.hashtags[p];
        return `<div class="card"><b>${p}</b><p style="white-space:pre-wrap;margin:6px 0">${esc(c.captions[p])}</p>${tags.length ? `<p class="muted">${esc(tags.join(' '))}</p>` : ''}</div>`;
      };
      const body = `<h1>${DAY_NAMES[d.slot]}, week of ${d.weekOf} ${badge(d.status)}</h1>
        <p class="muted">${esc(d.template)}${d.site ? ` · site ${esc(d.site)}` : ''} · version ${d.version} · $${d.costUsd.toFixed(3)} · ${versions.length > 1 ? `versions: ${versions.map((v) => (v.id === d.id ? `<b>v${v.version}</b>` : `<a href="/drafts/${v.id}">v${v.version}</a>`)).join(' ')}` : ''}</p>
        ${ctx.plan ? `<p><b>Subject:</b> ${esc(ctx.plan.subject)}</p>` : ''}
        <p><b>Rationale:</b> ${esc(c.rationale)}</p>
        ${d.feedback ? `<div class="warn"><b>Feedback that led to this version:</b> ${esc(d.feedback)}</div>` : ''}
        <div class="grid" style="grid-template-columns:1fr 1fr;max-width:760px">
          <div>${sq ? `<a href="${sq}" target="_blank"><img src="${sq}?v=${d.version}" alt="square" style="max-width:360px"></a>` : ''}<p class="muted">1080×1080 · facebook, linkedin, google</p></div>
          <div>${pt ? `<a href="${pt}" target="_blank"><img src="${pt}?v=${d.version}" alt="portrait" style="max-width:360px"></a>` : ''}<p class="muted">1080×1350 · instagram</p></div>
        </div>
        ${d.template === 'quote' ? '<div class="warn">Quote template: check the quote and name against the testimonials screenshot before approving.</div>' : ''}
        <h2>Captions</h2><div class="grid">${caption('instagram')}${caption('facebook')}${caption('linkedin')}${caption('googlebusiness')}</div>
        <h2>Slots</h2><pre class="muted">${esc(JSON.stringify({ slots: c.slots, crop: c.crop }, null, 2))}</pre>
        <div class="row"><form method="post" action="/drafts/${d.id}/rerender"><button class="secondary">Re-render</button></form><a class="btn secondary" href="/?week=${d.weekOf}">Back</a></div>
        <details style="margin-top:18px"><summary class="muted">Claude conversation (${ctx.calls?.length ?? 0} call(s))</summary><pre class="muted" style="max-height:500px;overflow:auto">${esc(JSON.stringify(JSON.parse(d.generationContext), null, 2))}</pre></details>`;
      res.send(page('Draft', body, '/'));
    }),
  );

  app.post('/drafts/:id/rerender', (req, res) => {
    const d = getDraft(String(req.params['id']));
    if (!d) {
      res.status(404).send('unknown draft');
      return;
    }
    const job = startJob('render', `Re-render ${d.slot} ${d.weekOf}`, async (log) => {
      const r = await renderDraftRow(d);
      log(`wrote ${path.basename(r.renderSquare!)} and ${path.basename(r.renderPortrait!)}`);
    });
    res.redirect(`/jobs/${job.id}?next=/drafts/${d.id}`);
  });

  // ---- Plan -------------------------------------------------------------------------
  app.get(
    '/plan',
    wrap(async (_req, res) => {
      const plan = await readPlan();
      const sites = await siteSummaries();
      const weekOf = plan?.weekOf ?? nextWeekOf();
      const row = (day: PlanDay) => `<tr><td><b>${DAY_NAMES[day.slot]}</b></td>
        <td><select name="template-${day.slot}">${TEMPLATES.map((t) => `<option ${t === day.template ? 'selected' : ''}>${t}</option>`).join('')}</select></td>
        <td><select name="site-${day.slot}"><option value="">none</option>${sites.map((s) => `<option value="${esc(s.slug)}" ${s.slug === day.site ? 'selected' : ''}>${esc(s.name)}${s.kind === 'own' ? ' (ours)' : ''}${s.captured ? '' : ' (not captured)'}</option>`).join('')}</select></td>
        <td><input name="subject-${day.slot}" value="${esc(day.subject)}" style="width:100%;padding:6px;font:inherit"><br><span class="muted">${esc(day.reason)}</span></td></tr>`;
      const days = plan?.days ?? SLOTS.map((slot) => ({ slot, template: 'list' as const, subject: '', site: null, reason: '' }));
      const body = `<h1>Plan the week</h1>
        <div class="row"><form method="post" action="/plan/suggest"><input type="hidden" name="weekOf" value="${esc(weekOf)}"><button>${plan ? 'Ask Claude again' : 'Ask Claude to plan'} ${esc(weekOf)}</button></form>
        <span class="muted">${plan ? `Current plan: ${esc(plan.source)}, ${esc(plan.createdAt.slice(0, 16).replace('T', ' '))}` : 'No plan yet.'}${hasApiKey() ? '' : ' (no API key: a default rotation is used)'}</span></div>
        <form method="post" action="/plan" style="margin-top:18px">
          <label><b>Week of (Monday)</b> <input name="weekOf" value="${esc(weekOf)}" pattern="\\d{4}-\\d{2}-\\d{2}" style="padding:6px;font:inherit"></label>
          <table style="margin-top:10px"><tr><th>Day</th><th>Template</th><th>Site</th><th>Subject</th></tr>${days.map(row).join('')}</table>
          <p class="muted">quote needs a site with a captured testimonials section; screenshot needs a captured site.</p>
          <div class="row"><button>Save plan</button><button name="then" value="run" class="secondary">Save and run weekly</button></div>
        </form>`;
      res.send(page('Plan', body, '/plan'));
    }),
  );

  app.post('/plan/suggest', (req, res) => {
    const weekOf = String(req.body?.['weekOf'] || nextWeekOf());
    const job = startJob('plan', `Plan ${weekOf}`, async (log) => {
      const plan = await planWeek(weekOf, log);
      await writePlan(plan);
      log(`saved: ${plan.days.map((d) => `${d.slot}=${d.template}${d.site ? `(${d.site})` : ''}`).join(' ')}`);
    });
    res.redirect(`/jobs/${job.id}?next=/plan`);
  });

  app.post(
    '/plan',
    wrap(async (req, res) => {
      const b = req.body as Record<string, string>;
      const weekOf = b['weekOf'] ?? nextWeekOf();
      const prev = await readPlan();
      const days: PlanDay[] = SLOTS.map((slot) => {
        const old = prev?.days.find((d) => d.slot === slot);
        return {
          slot,
          template: (TEMPLATES as readonly string[]).includes(b[`template-${slot}`] ?? '') ? (b[`template-${slot}`] as PlanDay['template']) : 'list',
          site: b[`site-${slot}`] || null,
          subject: (b[`subject-${slot}`] ?? '').trim(),
          reason: old && old.template === b[`template-${slot}`] && old.subject === (b[`subject-${slot}`] ?? '').trim() ? old.reason : 'edited by reviewer',
        };
      });
      const plan: Plan = { weekOf, createdAt: new Date().toISOString(), source: 'edited', days, claude: prev?.weekOf === weekOf ? prev.claude ?? null : null };
      await writePlan(plan);
      if (b['then'] === 'run') {
        const job = startJob('weekly', `Weekly run for ${weekOf}`, (log) => runWeekly({ weekOf, log }));
        res.redirect(`/jobs/${job.id}?next=/?week=${weekOf}`);
        return;
      }
      res.redirect('/plan');
    }),
  );
}
