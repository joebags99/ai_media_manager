// Dashboard routes for the plan and the drafts list/detail (M3). Approve / revise /
// reject land here in M4.
import type { Express } from 'express';
import path from 'node:path';
import { listDrafts, getDraft, listRuns, nextWeekOf, updateDraft, SLOTS, type Draft, type Slot } from '../db.js';
import { planWeek, readPlan, writePlan, siteSummaries, type Plan, type PlanDay } from '../plan.js';
import { runWeekly, renderDraftRow } from '../weekly.js';
import { startJob } from '../jobs.js';
import { hasApiKey } from '../claude.js';
import { readManifest, siteDir } from '../capture.js';

import { loadBrand } from '../render.js';
import { validateContent } from '../validate.js';
import { approve, reject } from '../workflow.js';
import { reviseDraft } from '../revise.js';
import { esc } from './html.js';
import type { DraftContent } from '../validate.js';

type Page = (title: string, body: string, active: string) => string;
type Wrap = (fn: (req: import('express').Request, res: import('express').Response) => Promise<void>) => import('express').RequestHandler;

const TEMPLATES = ['list', 'stat', 'quote', 'screenshot'] as const;
const DAY_NAMES: Record<Slot, string> = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday' };

const statusColor: Record<string, string> = { pending: 'var(--aegean)', revising: 'var(--purple)', approved: '#2e7d32', scheduled: '#2e7d32', rejected: 'var(--ash)', posted: '#2e7d32', error: '#B4332B' };
const badge = (s: string) => `<span style="display:inline-block;padding:2px 9px;border-radius:99px;font-size:12px;font-weight:600;color:#fff;background:${statusColor[s] ?? 'var(--ash)'}">${esc(s)}</span>`;
const renderUrl = (p: string | null) => (p ? `/renders/${path.basename(p)}` : null);

/** Crop adjuster for drafts that use a screenshot: pick the shot, type a region, see it boxed, re-render. */
async function cropEditor(d: Draft, c: DraftContent): Promise<string> {
  if (!d.site) return '';
  const m = await readManifest(d.site);
  if (!m) return '';
  const canCrop = d.template === 'screenshot' || d.template === 'stat';
  if (!canCrop) return '';
  const shots = m.shots;
  const current = c.crop?.screenshot && shots.find((s) => s.file === c.crop.screenshot) ? c.crop.screenshot : shots[0]?.file ?? '';
  const [x, y, w, h] = c.crop?.region ?? [0, 0, 0, 0];
  const whole = !c.crop?.region;
  const dims = JSON.stringify(Object.fromEntries(shots.map((s) => [s.file, [s.width, s.height]])));
  const n = (name: string, v: number) => `<label>${name} <input name="${name}" type="number" min="0" value="${v}" style="width:90px;padding:4px;font:inherit"></label>`;
  return `<h2>Crop</h2>
  <form method="post" action="/drafts/${d.id}/crop" class="card" id="cropForm">
    <div class="row">
      <label>Screenshot <select name="screenshot">${d.template === 'stat' ? '<option value="">none (plain ink)</option>' : ''}${shots.map((s) => `<option value="${esc(s.file)}" ${s.file === current && c.crop?.screenshot ? 'selected' : ''}>${esc(s.file)} (${s.width}×${s.height})</option>`).join('')}</select></label>
      <label>Treatment <select name="treatment"><option ${c.crop?.treatment !== 'dimmed' ? 'selected' : ''}>framed</option><option ${c.crop?.treatment === 'dimmed' ? 'selected' : ''}>dimmed</option></select></label>
      <label><input type="checkbox" name="whole" ${whole ? 'checked' : ''}> whole image</label>
      ${n('x', x)} ${n('y', y)} ${n('w', w)} ${n('h', h)}
      <button>Save crop and re-render</button>
    </div>
    <div id="cropPreview" style="position:relative;display:inline-block;margin-top:12px;max-width:100%;overflow:hidden">
      <img id="cropImg" src="" alt="" style="max-width:720px;display:block">
      <div id="cropBox" style="position:absolute;border:3px solid var(--terracotta);box-shadow:0 0 0 9999px rgba(21,19,26,.55);pointer-events:none"></div>
    </div>
    <p class="muted">Region is in the screenshot's own pixels. Drag isn't supported yet; type numbers and watch the box. Full width (x=0, w=image width) usually looks best in the frame.</p>
  </form>
  <script>
    (() => {
      const dims = ${dims};
      const f = document.getElementById('cropForm');
      const img = document.getElementById('cropImg');
      const box = document.getElementById('cropBox');
      const get = (k) => f.elements[k];
      function draw() {
        const file = get('screenshot').value;
        const wrap = document.getElementById('cropPreview');
        if (!file) { wrap.style.display = 'none'; return; }
        wrap.style.display = 'inline-block';
        const src = '/screenshots/${esc(d.site)}/' + file;
        if (!img.src.endsWith(src)) img.src = src;
        const [W, H] = dims[file] || [1, 1];
        const whole = get('whole').checked;
        for (const k of ['x', 'y', 'w', 'h']) get(k).disabled = whole;
        if (whole && get('w').value == 0) { get('w').value = W; get('h').value = H; }
        const scale = img.clientWidth / W;
        const x = whole ? 0 : +get('x').value, y = whole ? 0 : +get('y').value, w = whole ? W : +get('w').value, h = whole ? H : +get('h').value;
        Object.assign(box.style, { left: x * scale + 'px', top: y * scale + 'px', width: w * scale + 'px', height: h * scale + 'px' });
      }
      f.addEventListener('input', draw);
      img.addEventListener('load', draw);
      draw();
    })();
  </script>`;
}

/** Approve / revise / reject for the latest pending version; status notes otherwise. */
function actions(d: Draft, versions: Draft[]): string {
  const latest = versions.reduce((a, b) => (b.version > a.version ? b : a), d);
  if (latest.id !== d.id) return `<div class="warn">This is v${d.version}; the current version is <a href="/drafts/${latest.id}">v${latest.version}</a>.</div>`;
  if (d.status === 'pending') {
    return `<h2>Review</h2>
    <div class="row" style="align-items:flex-start">
      <form method="post" action="/drafts/${d.id}/approve"><button style="background:#2e7d32">Approve</button></form>
      <form method="post" action="/drafts/${d.id}/reject" onsubmit="return confirm('Reject this draft? A rejected slot is regenerated on the next weekly run.')"><input type="hidden" name="reason" value=""><button class="danger">Reject</button></form>
    </div>
    <form method="post" action="/drafts/${d.id}/revise" class="card" style="margin-top:12px;max-width:760px">
      <b>Revise with feedback</b><br>
      <textarea name="feedback" rows="3" required placeholder="e.g. Lead with the mobile view. Drop the word 'bespoke'. Make the Google caption shorter." style="width:100%;padding:8px;font:inherit;margin:8px 0"></textarea>
      <button>Send to Claude and re-render</button>
      <span class="muted">Replays the original conversation with your note as a follow-up turn. Creates v${d.version + 1}; this version stays viewable.</span>
    </form>`;
  }
  if (d.status === 'revising') return `<div class="warn">A revision is in progress for this version.</div>`;
  if (d.status === 'approved') return `<div class="warn" style="border-color:#2e7d32">Approved. Publishing to Buffer arrives in M5.</div>`;
  if (d.status === 'rejected') return `<div class="warn">Rejected. The next weekly run will generate a fresh draft for this day.</div>`;
  return '';
}

export function registerDraftRoutes(app: Express, page: Page, wrap: Wrap): void {
  const act = (fn: (id: string, body: Record<string, string>) => Draft) => (req: import('express').Request, res: import('express').Response) => {
    const id = String(req.params['id']);
    try {
      fn(id, (req.body ?? {}) as Record<string, string>);
      res.redirect(`/drafts/${id}`);
    } catch (err) {
      res.status(400).send(page('Draft', `<h1>Not done</h1><div class="warn">${esc((err as Error).message)}</div><a class="btn" href="/drafts/${id}">Back</a>`, '/'));
    }
  };
  app.post('/drafts/:id/approve', act((id) => approve(id)));
  app.post('/drafts/:id/reject', act((id, b) => reject(id, b['reason'])));
  app.post('/drafts/:id/revise', (req, res) => {
    const id = String(req.params['id']);
    const feedback = String((req.body as Record<string, string>)['feedback'] ?? '').trim();
    if (!feedback) {
      res.redirect(`/drafts/${id}`);
      return;
    }
    const d = getDraft(id);
    if (!d) {
      res.status(404).send('unknown draft');
      return;
    }
    const job = startJob('revise', `Revise ${d.slot} ${d.weekOf} v${d.version}`, async (log) => {
      const next = await reviseDraft(id, feedback, { log });
      log(`created v${next.version}`);
      return next.id;
    });
    res.redirect(`/jobs/${job.id}?next=/drafts/${id}/latest`);
  });
  app.get('/drafts/:id/latest', (req, res) => {
    const d = getDraft(String(req.params['id']));
    if (!d) {
      res.status(404).send('unknown draft');
      return;
    }
    const latest = listDrafts({ weekOf: d.weekOf }).filter((x) => x.slot === d.slot).reduce((a, b) => (b.version > a.version ? b : a), d);
    res.redirect(`/drafts/${latest.id}`);
  });

  // ---- Drafts list -----------------------------------------------------------------
  app.get(
    '/',
    wrap(async (req, res) => {
      const weeks = [...new Set(listDrafts().map((d) => d.weekOf))];
      const weekOf = typeof req.query['week'] === 'string' ? req.query['week'] : weeks[0];
      const showAll = req.query['all'] === '1';
      const drafts = weekOf ? listDrafts({ weekOf, latestOnly: !showAll }) : [];
      const runs = listRuns(3);
      const counts = weekOf ? listDrafts({ weekOf, latestOnly: true }).reduce<Record<string, number>>((a, d) => ((a[d.status] = (a[d.status] ?? 0) + 1), a), {}) : {};
      const weekNav = weeks.length
        ? `<p class="muted">Week: ${weeks.map((w) => (w === weekOf ? `<b>${w}</b>` : `<a href="/?week=${w}">${w}</a>`)).join(' · ')}
           &nbsp;·&nbsp; ${Object.entries(counts).map(([k, v]) => `${badge(k)} ${v}`).join(' ')}
           &nbsp;·&nbsp; ${showAll ? `<a href="/?week=${weekOf}">latest versions only</a>` : `<a href="/?week=${weekOf}&all=1">all versions</a>`}</p>`
        : '';
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
        ${await cropEditor(d, c)}
        <h2>Captions</h2><div class="grid">${caption('instagram')}${caption('facebook')}${caption('linkedin')}${caption('googlebusiness')}</div>
        <h2>Slots</h2><pre class="muted">${esc(JSON.stringify({ slots: c.slots, crop: c.crop }, null, 2))}</pre>
        ${actions(d, versions)}
        <div class="row" style="margin-top:14px"><form method="post" action="/drafts/${d.id}/rerender"><button class="secondary">Re-render</button></form><a class="btn secondary" href="/?week=${d.weekOf}">Back</a></div>
        <details style="margin-top:18px"><summary class="muted">Claude conversation (${ctx.calls?.length ?? 0} call(s))</summary><pre class="muted" style="max-height:500px;overflow:auto">${esc(JSON.stringify(JSON.parse(d.generationContext), null, 2))}</pre></details>`;
      res.send(page('Draft', body, '/'));
    }),
  );

  app.post(
    '/drafts/:id/crop',
    wrap(async (req, res) => {
      const d = getDraft(String(req.params['id']));
      if (!d || !d.site) {
        res.status(404).send('unknown draft');
        return;
      }
      const b = req.body as Record<string, string>;
      const c = JSON.parse(d.contentJson) as DraftContent;
      const m = await readManifest(d.site);
      const num = (k: string) => Math.round(Number(b[k]));
      const whole = b['whole'] === 'on';
      c.crop = {
        screenshot: b['screenshot'] || null,
        region: whole || !b['screenshot'] ? null : [num('x'), num('y'), num('w'), num('h')],
        treatment: b['treatment'] === 'dimmed' ? 'dimmed' : 'framed',
      };
      const dims = Object.fromEntries((m?.shots ?? []).map((s) => [s.file, { width: s.width, height: s.height }]));
      const errors = validateContent(await loadBrand(), c, dims, d.template).filter((e) => /crop/.test(e));
      if (errors.length) {
        res.status(400).send(page('Crop', `<h1>Crop not saved</h1><div class="warn">${esc(errors.join('; '))}</div><a class="btn" href="/drafts/${d.id}">Back</a>`, '/'));
        return;
      }
      const updated = updateDraft(d.id, { contentJson: JSON.stringify(c) });
      const job = startJob('render', `Re-render ${d.slot} ${d.weekOf}`, async (log) => {
        const r = await renderDraftRow(updated);
        log(`wrote ${path.basename(r.renderSquare!)} and ${path.basename(r.renderPortrait!)}`);
      });
      res.redirect(`/jobs/${job.id}?next=/drafts/${d.id}`);
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
