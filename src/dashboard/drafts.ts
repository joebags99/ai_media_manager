// Dashboard routes for the plan and the drafts list/detail, with approve / revise / reject.
import type { Express, Request, Response, RequestHandler } from 'express';
import path from 'node:path';
import { listDrafts, getDraft, listRuns, nextWeekOf, mondayOf, updateDraft, SLOTS, type Draft, type Slot } from '../db.js';
import { planWeek, readPlan, writePlan, listPlannedWeeks, siteSummaries, dayContext, type Plan, type PlanDay } from '../plan.js';
import { runWeekly, renderDraftRow } from '../weekly.js';
import { startJob } from '../jobs.js';
import { hasApiKey } from '../claude.js';
import { readManifest, siteDir } from '../capture.js';
import { loadBrand, type Brand } from '../render.js';
import { validateContent, type DraftContent } from '../validate.js';
import { approve, reject, archive, duplicate, remove, clearWeek } from '../workflow.js';
import { regenerateCaptions } from '../generate.js';
import { slotPicker } from './library.js';
import { reviseDraft } from '../revise.js';
import { TEST_MODE } from '../config.js';
import { defaultPlatforms, captionFor, firstCommentFor } from '../publish.js';
import { buildDigest, sendDigest } from '../notify.js';
import { metricsForDraft } from '../metrics.js';
import { badge, empty, esc, notice, pageHead, section } from './html.js';

type Page = (title: string, body: string, active: string) => string;
type Wrap = (fn: (req: Request, res: Response) => Promise<void>) => RequestHandler;

const TEMPLATES = ['headline', 'question', 'tip', 'contrast', 'stat', 'list', 'quote', 'screenshot', 'detail', 'backdrop', 'mobile', 'holiday', 'none'] as const;
const DAY_NAMES: Record<Slot, string> = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };
const TEXT_HEAVY = new Set(['list', 'headline', 'contrast', 'question', 'tip', 'stat', 'holiday', 'quote']);
const STATUS_HELP: Record<string, string> = {
  archived: 'Shelved in the Library. Place it into a day to use it.',
  pending: 'Waiting for your review.',
  revising: 'Superseded by a newer version.',
  approved: 'Approved. Ready to publish.',
  scheduled: 'In Buffer’s queue.',
  rejected: 'Rejected. The next weekly run makes a new one for this day.',
  posted: 'Published.',
  error: 'Something failed. See the message on the draft.',
};
const renderUrl = (p: string | null) => (p ? `/renders/${path.basename(p)}` : null);
const fmt = (iso: string) => iso.slice(0, 16).replace('T', ' ');

/** The four-step strip at the top of the Drafts page. */
function steps(weekOf: string | undefined, counts: Record<string, number>): string {
  const pending = counts['pending'] ?? 0;
  const approved = counts['approved'] ?? 0;
  const s = (href: string, n: string, title: string, text: string) => `<a class="step" href="${href}"><span class="n">${n}</span><b>${title}</b><span>${text}</span></a>`;
  return `<div class="steps">
    ${s(`/plan${weekOf ? `?week=${weekOf}` : ''}`, 'STEP 1', 'Plan', 'Claude proposes a template and subject per day, holidays included. Edit, then run.')}
    ${s('/jobs', 'STEP 2', 'Generate', 'The weekly run captures sites, writes copy, renders both sizes.')}
    ${s(`/${weekOf ? `?week=${weekOf}` : ''}`, 'STEP 3', 'Review', pending ? `${pending} draft(s) waiting. Approve, revise with feedback, or reject.` : 'Approve, revise with feedback, or reject each draft.')}
    ${s('/buffer', 'STEP 4', 'Publish', approved ? `${approved} approved and ready for Buffer.` : `Approved drafts go to Buffer${TEST_MODE ? ' (test mode: 60 days out)' : ''}.`)}
  </div>`;
}

/** Approve / revise / reject / publish for the latest version; status notes otherwise. */
function actions(d: Draft, versions: Draft[], brand: Brand): string {
  const latest = versions.reduce((a, b) => (b.version > a.version ? b : a), d);
  if (latest.id !== d.id) return notice('info', `This is version ${d.version}. The current version is <a href="/drafts/${latest.id}">v${latest.version}</a>; only the current version can be acted on.`);
  if (d.status === 'pending') {
    return section(
      'Review',
      'Approve locks the copy and images. Revise sends your note to Claude as a follow-up in the same conversation and makes a new version. Reject frees the day for the next run.',
      `<div class="row" style="align-items:flex-start;gap:18px;flex-wrap:wrap">
        <div class="card" style="flex:1 1 420px">
          <b>Revise with feedback</b>
          <textarea name="feedback" form="reviseForm" rows="3" required placeholder="e.g. Lead with the mobile view. Drop the word 'bespoke'. Shorter Google caption." style="width:100%;margin:8px 0"></textarea>
          <form method="post" action="/drafts/${d.id}/revise" id="reviseForm" class="row"><button class="primary">Send to Claude and re-render</button><span class="hint">Creates v${d.version + 1}; this version stays viewable.</span></form>
        </div>
        <div class="card" style="flex:0 0 auto">
          <b>Decide</b>
          <div class="row" style="margin-top:10px">
            <form method="post" action="/drafts/${d.id}/approve" class="inline"><button class="ok">Approve</button></form>
            <form method="post" action="/drafts/${d.id}/reject" class="inline" onsubmit="return confirm('Reject this draft? The next weekly run will generate a fresh one for this day.')"><input type="hidden" name="reason" value=""><button class="danger">Reject</button></form>
          </div>
        </div>
      </div>`,
    );
  }
  if (d.status === 'approved') {
    const choices = defaultPlatforms(d, brand);
    return section(
      'Publish',
      `Creates one Buffer post per checked channel with that platform’s caption and image.${TEST_MODE ? ' Test mode: scheduled 60 days out, with a delete button afterwards.' : ' Live: scheduled for 10:00 on the slot day, never under 24h from now.'}`,
      `<form method="post" action="/drafts/${d.id}/publish" onsubmit="return confirm('${TEST_MODE ? 'TEST MODE: create posts on the checked channels, scheduled 60 days out?' : 'LIVE: schedule this post on the checked channels?'}')" class="card">
        <div class="row">${choices.map((c) => `<label title="${esc(c.reason ?? '')}"><input type="checkbox" name="platforms" value="${c.platform}" ${c.on ? 'checked' : ''}> ${c.platform}${c.reason ? ` <span class="hint">(off: ${esc(c.reason)})</span>` : ''}</label>`).join('')}</div>
        <div class="row" style="margin-top:12px"><button class="primary">${TEST_MODE ? 'Test-publish to Buffer' : 'Schedule on Buffer'}</button><span class="hint">Needs PUBLIC_BASE_URL so Buffer can fetch the renders. <a href="/buffer">Check Buffer</a>.</span></div>
        ${d.errorMessage ? notice('bad', `Last attempt: ${esc(d.errorMessage)}`) : ''}
      </form>`,
    );
  }
  if (d.status === 'scheduled' || (d.status === 'error' && d.bufferPostIds)) {
    const ids = d.bufferPostIds ? (JSON.parse(d.bufferPostIds) as Record<string, string>) : {};
    return section(
      'In Buffer',
      '',
      `${d.status === 'error' ? notice('bad', `Publish failed part-way: ${esc(d.errorMessage ?? '')}. The posts below were created and can be removed.`) : notice('ok', `Scheduled for <b>${esc(d.scheduledAt ? fmt(d.scheduledAt) : '')} UTC</b>${TEST_MODE ? ' (test mode)' : ''}.`)}
      <table style="max-width:560px"><tr><th>Channel</th><th>Buffer post id</th></tr>${Object.entries(ids).map(([p, id]) => `<tr><td>${esc(p)}</td><td class="muted">${esc(id)}</td></tr>`).join('')}</table>
      <form method="post" action="/drafts/${d.id}/unpublish" onsubmit="return confirm('Delete these ${Object.keys(ids).length} posts from Buffer?')" class="row" style="margin-top:12px"><button class="danger">Delete ${TEST_MODE ? 'test ' : ''}posts from Buffer</button><span class="hint">Same as <code>npm run buffer:delete -- ${esc(Object.values(ids).join(' '))}</code></span></form>`,
    );
  }
  if (d.status === 'revising') return notice('info', 'A revision is in progress for this version.');
  if (d.status === 'rejected') return notice('info', STATUS_HELP['rejected']!);
  if (d.status === 'archived') return section('In the library', 'Place it into a day; whatever is there already gets shelved instead.', slotPicker(`/library/${d.id}/place`, 'Place', 'primary'));
  return '';
}

/** What Buffer reports for this draft's posts, once synced. */
function metricsBlock(d: Draft): string {
  if (d.status !== 'scheduled' && d.status !== 'posted') return '';
  const rows = metricsForDraft(d.id);
  if (!rows.length) return '';
  return section(
    'Performance',
    'From Buffer. Impressions, engagement (likes, comments, shares, saves) and clicks per channel; synced by the weekly run or from the Performance page.',
    `<table style="max-width:760px"><tr><th>Channel</th><th>Status</th><th>Impressions</th><th>Engagement</th><th>Clicks</th><th></th></tr>${rows
      .map((r) => `<tr><td>${esc(r.platform)}</td><td class="muted">${esc(r.status)}${r.sentAt ? ` · ${esc(r.sentAt.slice(0, 10))}` : ''}</td><td>${Math.round(r.impressions)}</td><td><b>${Math.round(r.engagement)}</b></td><td>${Math.round(r.clicks)}</td><td>${r.externalLink ? `<a href="${esc(r.externalLink)}" target="_blank">open ↗</a>` : ''}</td></tr>`)
      .join('')}</table>`,
  );
}

/** Shelve / duplicate / recaption, for drafts that are current and not yet in Buffer. */
function utilities(d: Draft): string {
  if (!['pending', 'approved', 'rejected', 'archived', 'error'].includes(d.status)) return '';
  return section(
    'Reuse',
    'Shelve keeps this draft in the Library for a last-minute swap later. Duplicate copies it into another day as a new pending draft. New captions asks Claude for different captions and hashtags without touching the image.',
    `<div class="row" style="align-items:flex-start;gap:18px;flex-wrap:wrap">
      ${['pending', 'approved'].includes(d.status) ? `<form method="post" action="/drafts/${d.id}/archive" class="card tight"><b>Shelve for later</b><div style="margin-top:8px"><button class="secondary small">Shelve</button></div></form>` : ''}
      <div class="card tight"><b>Duplicate to</b><div style="margin-top:8px">${slotPicker(`/drafts/${d.id}/duplicate`, 'Duplicate', 'secondary', d.weekOf !== 'library' ? d.weekOf : undefined)}</div></div>
      <form method="post" action="/drafts/${d.id}/captions" class="card tight" style="flex:1 1 320px"><b>New captions</b><div class="row" style="margin-top:8px"><input name="note" placeholder="optional: what to change" style="flex:1"><button class="secondary small">Ask Claude</button></div></form>
      ${d.weekOf !== 'library' ? `<form method="post" action="/drafts/${d.id}/regenerate" class="card tight" onsubmit="return confirm('Shelve this draft and have Claude write a new one for ${DAY_NAMES[d.slot]} from the current plan?')"><b>Regenerate this day</b><div style="margin-top:8px"><button class="secondary small">Shelve and regenerate</button></div></form>` : ''}
      <form method="post" action="/drafts/${d.id}/delete" class="card tight" onsubmit="return confirm('Delete this draft for good? Shelving keeps it; deleting does not.')"><b>Delete</b><div style="margin-top:8px"><button class="danger small">Delete for good</button></div></form>
    </div>`,
  );
}

/** Edit slot text and alt text by hand, then re-render. */
function textEditor(d: Draft, c: DraftContent, brand: Brand): string {
  if (!['pending', 'approved', 'archived'].includes(d.status)) return '';
  const slots = (brand.templates[d.template]?.slots ?? []).filter((s) => s !== 'crop');
  return section(
    'Edit text',
    'Typo-level fixes without a Claude round trip. Saves into this version and re-renders; the same word-count and banned-word rules apply.',
    `<form method="post" action="/drafts/${d.id}/text" class="card">
      <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(280px,1fr))">
        ${slots.map((s) => `<label class="field" style="margin:0"><b>${esc(s)}</b>${(c.slots[s] ?? '').length > 60 ? `<textarea name="slot-${s}" rows="3">${esc(c.slots[s] ?? '')}</textarea>` : `<input name="slot-${s}" value="${esc(c.slots[s] ?? '')}">`}</label>`).join('')}
        <label class="field" style="margin:0"><b>Alt text</b><input name="altText" value="${esc(c.altText ?? '')}" maxlength="200"><span class="hint">Read by screen readers and used by LinkedIn indexing.</span></label>
      </div>
      <div class="row" style="margin-top:12px"><button class="secondary">Save text and re-render</button>${c.editedByHand ? '<span class="hint">Edited by hand.</span>' : ''}</div>
    </form>`,
  );
}

/** Crop adjuster for drafts that use a screenshot. */
async function cropEditor(d: Draft, c: DraftContent): Promise<string> {
  if (!d.site || !['screenshot', 'stat', 'detail', 'backdrop', 'mobile'].includes(d.template)) return '';
  const m = await readManifest(d.site);
  if (!m) return '';
  const shots = m.shots;
  const current = c.crop?.screenshot && shots.find((s) => s.file === c.crop.screenshot) ? c.crop.screenshot : shots[0]?.file ?? '';
  const [x, y, w, h] = c.crop?.region ?? [0, 0, 0, 0];
  const whole = !c.crop?.region;
  const dims = JSON.stringify(Object.fromEntries(shots.map((s) => [s.file, [s.width, s.height]])));
  const n = (name: string, v: number) => `<label>${name} <input name="${name}" type="number" min="0" value="${v}" style="width:88px"></label>`;
  return section(
    'Crop',
    'Which screenshot and which part of it the template shows. Type a region and watch the box; save re-renders both sizes without touching the copy. Full width usually looks best in the frame.',
    `<form method="post" action="/drafts/${d.id}/crop" class="card" id="cropForm">
    <div class="row">
      <label>Screenshot <select name="screenshot">${d.template === 'stat' ? '<option value="">none (plain ink)</option>' : ''}${shots.map((s) => `<option value="${esc(s.file)}" ${s.file === current && c.crop?.screenshot ? 'selected' : ''}>${esc(s.file)} (${s.width}×${s.height})</option>`).join('')}</select></label>
      <label>Treatment <select name="treatment"><option ${c.crop?.treatment !== 'dimmed' ? 'selected' : ''}>framed</option><option ${c.crop?.treatment === 'dimmed' ? 'selected' : ''}>dimmed</option></select></label>
      <label><input type="checkbox" name="whole" ${whole ? 'checked' : ''}> whole image</label>
      ${n('x', x)} ${n('y', y)} ${n('w', w)} ${n('h', h)}
      <button class="secondary">Save crop and re-render</button>
    </div>
    <div id="cropPreview" style="position:relative;display:inline-block;margin-top:12px;max-width:100%;overflow:hidden;border-radius:6px">
      <img id="cropImg" src="" alt="" style="max-width:720px;display:block">
      <div id="cropBox" style="position:absolute;border:3px solid var(--terracotta);box-shadow:0 0 0 9999px rgba(21,19,26,.55);pointer-events:none"></div>
    </div>
  </form>
  <script>
    (() => {
      const dims = ${dims};
      const f = document.getElementById('cropForm'), img = document.getElementById('cropImg'), box = document.getElementById('cropBox');
      const get = (k) => f.elements[k];
      function draw() {
        const file = get('screenshot').value, wrap = document.getElementById('cropPreview');
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
      f.addEventListener('input', draw); img.addEventListener('load', draw); draw();
    })();
  </script>`,
  );
}

export function registerDraftRoutes(app: Express, page: Page, wrap: Wrap): void {
  // ---- Drafts list -----------------------------------------------------------------
  app.get(
    '/',
    wrap(async (req, res) => {
      const weeks = [...new Set(listDrafts().map((d) => d.weekOf))];
      const weekOf = typeof req.query['week'] === 'string' ? req.query['week'] : weeks[0];
      const showAll = req.query['all'] === '1';
      const drafts = weekOf ? listDrafts({ weekOf, latestOnly: !showAll }) : [];
      const counts = weekOf ? listDrafts({ weekOf, latestOnly: true }).reduce<Record<string, number>>((a, d) => ((a[d.status] = (a[d.status] ?? 0) + 1), a), {}) : {};
      const runs = listRuns(3);
      const weekNav = weeks.length
        ? `<div class="row" style="margin-bottom:16px"><span class="eyebrow">Week</span>${weeks.map((w) => (w === weekOf ? `<b>${w}</b>` : `<a href="/?week=${w}">${w}</a>`)).join('<span class="muted">·</span>')}
           <span class="muted">·</span>${Object.entries(counts).map(([k, v]) => `${badge(k)} ${v}`).join(' ')}
           <span class="muted">·</span>${showAll ? `<a href="/?week=${weekOf}">current versions only</a>` : `<a href="/?week=${weekOf}&all=1">show all versions</a>`}</div>`
        : '';
      const cards = drafts
        .map((d) => {
          const c = JSON.parse(d.contentJson) as DraftContent;
          const img = renderUrl(d.renderSquare);
          return `<div class="card tight"><div class="row" style="justify-content:space-between"><b style="font-family:var(--display);font-size:16px">${DAY_NAMES[d.slot]}</b>${badge(d.status)}</div>
            <a href="/drafts/${d.id}" title="${esc(STATUS_HELP[d.status] ?? '')}">${img ? `<img src="${img}?v=${d.version}" alt="" style="margin:10px 0">` : '<p class="muted">not rendered</p>'}</a>
            <div class="muted">${esc(d.template)}${d.site ? ` · ${esc(d.site)}` : ''} · v${d.version} · $${d.costUsd.toFixed(3)}${(() => { const m = d.status === 'posted' || d.status === 'scheduled' ? metricsForDraft(d.id).filter((r) => r.status === 'sent') : []; if (!m.length) return ''; const e = m.reduce((a, r) => a + r.engagement, 0), i = m.reduce((a, r) => a + r.impressions, 0); return ` · <b>${Math.round(e)}</b> eng / ${Math.round(i)} imp`; })()}</div>
            <p style="margin:6px 0 0;font-size:14px">${esc(c.rationale)}</p>
            <div class="row" style="margin-top:10px;gap:8px">${d.status === 'approved' ? `<form method="post" action="/drafts/${d.id}/publish" class="inline" onsubmit="return confirm('${TEST_MODE ? 'TEST MODE: schedule this draft 60 days out on its default channels?' : 'LIVE: schedule this draft on its default channels?'}')"><input type="hidden" name="next" value="/?week=${d.weekOf}"><button class="primary small">${TEST_MODE ? 'Test-publish' : 'Publish'}</button></form>` : ''}<a class="btn secondary small" href="/drafts/${d.id}">${d.status === 'pending' ? 'Review' : 'Open'}</a></div></div>`;
        })
        .join('');
      const body =
        pageHead(
          'Drafts',
          'One ad per weekday. Each draft is Claude’s copy rendered through a fixed template; nothing reaches Buffer until you approve it here.',
          `${(counts['approved'] ?? 0) > 0 ? `<form method="post" action="/weekly/publish" class="inline" onsubmit="return confirm('${TEST_MODE ? 'TEST MODE: schedule all ' : 'LIVE: schedule all '}${counts['approved']} approved draft(s) on their default channels?')"><input type="hidden" name="weekOf" value="${weekOf}"><button class="primary">${TEST_MODE ? 'Test-publish' : 'Publish'} all approved (${counts['approved']})</button></form>` : ''}
           <form method="post" action="/weekly" class="row" style="gap:8px"><label class="hint" for="runWeek">Week of</label><input id="runWeek" type="date" name="weekOf" value="${esc(weekOf ?? nextWeekOf())}" title="Any day; snaps to that week’s Monday"><button class="${(counts['approved'] ?? 0) > 0 ? 'secondary' : 'primary'}">Run weekly</button></form>
           ${weekOf ? `<a class="btn secondary" href="/review?week=${weekOf}">Review mode</a><a class="btn secondary" href="/digest/${weekOf}" target="_blank">Preview digest</a><form method="post" action="/digest/${weekOf}/send" class="inline"><button class="secondary">Send digest</button></form><form method="post" action="/weekly/clear" class="inline" onsubmit="return confirm('Shelve every pending and approved draft for ${weekOf}? They go to the Library; the week is then free to regenerate.')"><input type="hidden" name="weekOf" value="${weekOf}"><button class="secondary">Clear week</button></form>` : ''}`,
        ) +
        steps(weekOf, counts) +
        (hasApiKey() ? '' : notice('warn', 'No <code>ANTHROPIC_API_KEY</code> in .env: the weekly run will stop at generation.')) +
        weekNav +
        (drafts.length ? `<div class="grid">${cards}</div>` : empty('No drafts yet', 'Plan the week, then run weekly. The run captures sites, writes five posts and renders them here.', '<a class="btn primary" href="/plan">Plan the week</a>')) +
        (runs.length
          ? section('Recent runs', '', `<table><tr><th>Week</th><th>Started</th><th>Drafts</th><th>Cost</th><th>Errors</th></tr>${runs.map((r) => `<tr><td>${r.weekOf}</td><td class="muted">${esc(fmt(r.startedAt))}</td><td>${r.draftsCreated}</td><td>$${r.costEstimateUsd.toFixed(3)}</td><td class="muted">${esc((JSON.parse(r.errors) as string[]).join('; ') || '—')}</td></tr>`).join('')}</table>`)
          : '');
      res.send(page('Drafts', body, '/'));
    }),
  );

  app.get('/digest/:weekOf', (req, res) => {
    res.send(buildDigest(String(req.params['weekOf'])).html);
  });
  app.post('/digest/:weekOf/send', (req, res) => {
    const weekOf = String(req.params['weekOf']);
    const job = startJob('digest', `Digest for ${weekOf}`, async (log) => {
      const r = await sendDigest(weekOf, { log });
      if (r.previewUrl) log(`open the preview: ${r.previewUrl}`);
      return r;
    });
    res.redirect(`/jobs/${job.id}?next=/?week=${weekOf}`);
  });

  app.post('/weekly', (req, res) => {
    const weekOf = mondayOf(typeof req.body?.['weekOf'] === 'string' && req.body['weekOf'] ? String(req.body['weekOf']) : nextWeekOf());
    const job = startJob('weekly', `Weekly run for ${weekOf}`, (log) => runWeekly({ weekOf, log }));
    res.redirect(`/jobs/${job.id}?next=/?week=${weekOf}`);
  });

  // ---- Draft detail -----------------------------------------------------------------
  const act = (fn: (id: string, body: Record<string, string>) => Draft) => (req: Request, res: Response) => {
    const id = String(req.params['id']);
    try {
      fn(id, (req.body ?? {}) as Record<string, string>);
      res.redirect(`/drafts/${id}`);
    } catch (err) {
      res.status(400).send(page('Draft', pageHead('Not done', esc((err as Error).message), `<a class="btn secondary" href="/drafts/${id}">Back</a>`), '/'));
    }
  };
  app.post('/drafts/:id/approve', act((id) => approve(id)));
  app.post('/drafts/:id/archive', (req, res) => {
    const id = String(req.params['id']);
    try {
      archive(id);
      res.redirect('/library');
    } catch (err) {
      res.status(400).send(page('Draft', pageHead('Not shelved', esc((err as Error).message), `<a class="btn secondary" href="/drafts/${id}">Back</a>`), '/'));
    }
  });
  app.post('/drafts/:id/caption-swap', (req, res) => {
    const d = getDraft(String(req.params['id']));
    const p = String((req.body as Record<string, string>)['platform'] ?? '') as keyof DraftContent['captions'];
    if (!d || !['instagram', 'facebook', 'linkedin', 'googlebusiness'].includes(p)) {
      res.status(404).send('unknown draft or platform');
      return;
    }
    const c = JSON.parse(d.contentJson) as DraftContent;
    if (c.alternates?.[p]) {
      const main = c.captions[p];
      c.captions[p] = c.alternates[p];
      c.alternates[p] = main;
      updateDraft(d.id, { contentJson: JSON.stringify(c) });
    }
    res.redirect(`/drafts/${d.id}`);
  });
  app.post('/drafts/:id/delete', (req, res) => {
    const id = String(req.params['id']);
    const d = getDraft(id);
    try {
      remove(id);
      res.redirect(d && d.weekOf !== 'library' ? `/?week=${d.weekOf}` : '/library');
    } catch (err) {
      res.status(400).send(page('Draft', pageHead('Not deleted', esc((err as Error).message), `<a class="btn secondary" href="/drafts/${id}">Back</a>`), '/'));
    }
  });
  app.post('/drafts/:id/regenerate', (req, res) => {
    const id = String(req.params['id']);
    const d = getDraft(id);
    if (!d) {
      res.status(404).send('unknown draft');
      return;
    }
    if (d.status === 'pending' || d.status === 'approved') archive(id);
    const job = startJob('weekly', `Regenerate ${DAY_NAMES[d.slot]} ${d.weekOf}`, (log) => runWeekly({ weekOf: d.weekOf, only: [d.slot], log, digest: false }));
    res.redirect(`/jobs/${job.id}?next=/?week=${d.weekOf}`);
  });
  app.post('/weekly/clear', (req, res) => {
    const weekOf = mondayOf(String((req.body as Record<string, string>)['weekOf'] || nextWeekOf()));
    clearWeek(weekOf);
    res.redirect(`/?week=${weekOf}`);
  });
  app.post('/drafts/:id/duplicate', (req, res) => {
    const id = String(req.params['id']);
    const b = req.body as Record<string, string>;
    const weekOf = mondayOf(b['weekOf'] || nextWeekOf());
    const slot = (SLOTS as string[]).includes(b['slot'] ?? '') ? (b['slot'] as Slot) : 'mon';
    const copy = duplicate(id, weekOf, slot);
    const job = startJob('render', `Duplicate to ${DAY_NAMES[slot]} ${weekOf}`, async (log) => {
      await renderDraftRow(copy);
      log(`created v${copy.version} on ${DAY_NAMES[slot]} ${weekOf}`);
    });
    res.redirect(`/jobs/${job.id}?next=/drafts/${copy.id}`);
  });
  app.post('/drafts/:id/captions', (req, res) => {
    const id = String(req.params['id']);
    const note = String((req.body as Record<string, string>)['note'] ?? '').trim();
    const job = startJob('captions', `New captions for ${id.slice(0, 8)}`, (log) => regenerateCaptions(id, note, { log }));
    res.redirect(`/jobs/${job.id}?next=/drafts/${id}`);
  });
  app.post(
    '/drafts/:id/text',
    wrap(async (req, res) => {
      const d = getDraft(String(req.params['id']));
      if (!d) {
        res.status(404).send('unknown draft');
        return;
      }
      const b = req.body as Record<string, string>;
      const brand = await loadBrand();
      const c = JSON.parse(d.contentJson) as DraftContent;
      const slots = (brand.templates[d.template]?.slots ?? []).filter((s) => s !== 'crop');
      const next: DraftContent = { ...c, slots: Object.fromEntries(slots.map((s) => [s, (b[`slot-${s}`] ?? c.slots[s] ?? '').trim()])), altText: (b['altText'] ?? '').trim() || c.altText, editedByHand: true };
      const m = d.site ? await readManifest(d.site) : null;
      const dims = Object.fromEntries((m?.shots ?? []).map((s) => [s.file, { width: s.width, height: s.height }]));
      const errors = validateContent(brand, next, dims, d.template).filter((e) => /slot|words|banned|accentWord/.test(e));
      if (errors.length) {
        res.status(400).send(page('Edit text', pageHead('Text not saved', esc(errors.join('; ')), `<a class="btn secondary" href="/drafts/${d.id}">Back</a>`), '/'));
        return;
      }
      const updated = updateDraft(d.id, { contentJson: JSON.stringify(next) });
      const job = startJob('render', `Re-render ${d.slot} ${d.weekOf}`, async (log) => {
        const r = await renderDraftRow(updated);
        log(`wrote ${path.basename(r.renderSquare!)} and ${path.basename(r.renderPortrait!)}`);
      });
      res.redirect(`/jobs/${job.id}?next=/drafts/${d.id}`);
    }),
  );
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

  app.get(
    '/drafts/:id',
    wrap(async (req, res) => {
      const d = getDraft(String(req.params['id']));
      if (!d) {
        res.status(404).send(page('Draft', pageHead('Unknown draft', ''), '/'));
        return;
      }
      const c = JSON.parse(d.contentJson) as DraftContent;
      const brand = await loadBrand();
      const versions = d.status === 'archived' ? [d] : listDrafts({ weekOf: d.weekOf }).filter((x) => x.slot === d.slot);
      const ctx = JSON.parse(d.generationContext) as { plan?: PlanDay; calls?: { costUsd: number }[] };
      const sq = renderUrl(d.renderSquare);
      const pt = renderUrl(d.renderPortrait);
      const canSwap = ['pending', 'approved', 'archived'].includes(d.status);
      const caption = (p: keyof DraftContent['captions'], note: string) => {
        const text = captionFor(c, p, brand);
        const fc = firstCommentFor(c, p, brand);
        const alt = c.alternates?.[p];
        return `<div class="card tight"><div class="row" style="justify-content:space-between"><b>${p}</b><span class="muted">${note}</span></div>
          <p style="white-space:pre-wrap;margin:6px 0">${esc(text)}</p>
          ${fc ? `<p class="muted" style="margin:0 0 6px;padding-left:10px;border-left:3px solid var(--lavender)"><span class="eyebrow" style="font-size:10px">first comment</span><br>${esc(fc)}</p>` : ''}
          ${alt ? `<details style="margin-top:6px"><summary>Option B</summary><p style="white-space:pre-wrap;margin:6px 0;color:var(--ash)">${esc(alt)}</p>${canSwap ? `<form method="post" action="/drafts/${d.id}/caption-swap" class="inline"><input type="hidden" name="platform" value="${p}"><button class="secondary small">Use option B</button></form>` : ''}</details>` : ''}</div>`;
      };
      const body =
        pageHead(
          `${d.status === 'archived' ? 'Shelved draft' : DAY_NAMES[d.slot]} ${badge(d.status)}`,
          `${d.status === 'archived' ? 'In the <a href="/library">Library</a>' : `Week of ${d.weekOf}`} · ${esc(d.template)} template${d.site ? ` · <a href="/sites/${esc(d.site)}">${esc(d.site)}</a>` : ''} · version ${d.version} · $${d.costUsd.toFixed(3)}${versions.length > 1 ? ` · versions: ${versions.map((v) => (v.id === d.id ? `<b>v${v.version}</b>` : `<a href="/drafts/${v.id}">v${v.version}</a>`)).join(' ')}` : ''}<br><span class="muted">${esc(STATUS_HELP[d.status] ?? '')}</span>`,
          `<form method="post" action="/drafts/${d.id}/rerender" class="inline"><button class="secondary">Re-render</button></form><a class="btn secondary" href="/?week=${d.weekOf}">All drafts</a>`,
          'Draft',
        ) +
        (d.feedback ? notice('info', `<b>Feedback that led to this version:</b> ${esc(d.feedback)}`) : '') +
        `<div class="card" style="margin-bottom:8px"><div class="row" style="justify-content:space-between;align-items:flex-start;gap:24px">
          <div style="flex:1 1 320px">${ctx.plan ? `<div class="eyebrow">Subject</div><p style="margin:2px 0 12px">${esc(ctx.plan.subject)}</p>` : ''}<div class="eyebrow">Why Claude wrote it this way</div><p style="margin:2px 0 0">${esc(c.rationale)}</p></div>
          <div class="row" style="flex:0 0 auto;align-items:flex-start">
            <div>${sq ? `<a href="${sq}" target="_blank"><img src="${sq}?v=${d.version}" alt="square" style="width:300px;border-radius:6px"></a>` : ''}<div class="muted" style="margin-top:4px">1080×1080 · Facebook, LinkedIn, Google</div></div>
            <div>${pt ? `<a href="${pt}" target="_blank"><img src="${pt}?v=${d.version}" alt="portrait" style="width:240px;border-radius:6px"></a>` : ''}<div class="muted" style="margin-top:4px">1080×1350 · Instagram</div></div>
          </div></div></div>` +
        (d.template === 'quote' ? notice('info', 'Quote template: the quote was checked against the Reviews page for a verbatim match (or against our testimonials screenshot if no reviews are on file).') : '') +
        (c.warnings?.length ? notice('warn', `<b>Looks familiar:</b> ${c.warnings.map((w) => esc(w)).join('; ')}. Revise if it is too close.`) : '') +
        (TEXT_HEAVY.has(d.template) && d.status === 'pending' ? `<p class="hint" style="margin:4px 0 12px">Mostly text on the image. Fine for organic posts; if you ever boost this one, Meta tends to limit reach on text-heavy images.</p>` : '') +
        actions(d, versions, brand) +
        metricsBlock(d) +
        utilities(d) +
        textEditor(d, c, brand) +
        section('Captions', 'Exactly what Buffer will post per channel. Hashtags and links go to a first comment where brand.json says so (shown boxed). Each has an Option B from Claude; Use option B swaps them.', `<div class="grid">${caption('instagram', 'portrait image')}${caption('facebook', 'square image')}${caption('linkedin', 'square image')}${caption('googlebusiness', 'square · no hashtags')}</div>`) +
        (await cropEditor(d, c)) +
        section('Under the hood', '', `<details><summary>Slot values and crop</summary><pre class="muted">${esc(JSON.stringify({ slots: c.slots, crop: c.crop }, null, 2))}</pre></details>
          <details><summary>Claude conversation (${ctx.calls?.length ?? 0} call(s), stored on the draft for replay)</summary><pre class="muted" style="max-height:500px;overflow:auto">${esc(JSON.stringify(JSON.parse(d.generationContext), null, 2))}</pre></details>`);
      res.send(page(`${DAY_NAMES[d.slot]} ${d.weekOf}`, body, '/'));
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
        res.status(400).send(page('Crop', pageHead('Crop not saved', esc(errors.join('; ')), `<a class="btn secondary" href="/drafts/${d.id}">Back</a>`), '/'));
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
    wrap(async (req, res) => {
      const requested = typeof req.query['week'] === 'string' && req.query['week'] ? req.query['week'] : nextWeekOf();
      let weekOf: string;
      try {
        weekOf = mondayOf(requested);
      } catch {
        weekOf = nextWeekOf();
      }
      const plan = await readPlan(weekOf);
      const sites = await siteSummaries();
      const planned = await listPlannedWeeks();
      const shift = (days: number) => {
        const d = new Date(`${weekOf}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() + days);
        return d.toISOString().slice(0, 10);
      };
      const drafted = listDrafts({ weekOf, latestOnly: true }).length;
      const row = (day: PlanDay) => {
        const ctx = dayContext(weekOf, day.slot);
        const weekend = day.slot === 'sat' || day.slot === 'sun';
        const off = day.template === 'none';
        return `<tr style="${off ? 'background:var(--marble)' : ''}"><td style="width:150px"><b>${DAY_NAMES[day.slot]}</b><div class="muted">${esc(ctx.date.slice(5))}</div>${ctx.holiday ? `<div style="margin-top:4px"><span class="badge" style="background:${ctx.holiday.theme ? 'var(--terracotta)' : 'var(--ash)'}">${esc(ctx.holiday.name)}</span></div>` : ctx.theme ? `<div class="hint" style="margin-top:4px">${esc(ctx.theme)} season</div>` : ''}</td>
        <td style="width:130px"><select name="template-${day.slot}">${TEMPLATES.map((t) => `<option value="${t}" ${t === day.template ? 'selected' : ''}>${t === 'none' ? 'no post' : t}</option>`).join('')}</select></td>
        <td style="width:260px"><select name="site-${day.slot}"><option value="">none</option>${sites.map((s) => `<option value="${esc(s.slug)}" ${s.slug === day.site ? 'selected' : ''}>${esc(s.name)}${s.kind === 'own' ? ' (ours)' : ''}${s.captured ? '' : ' (not captured)'}</option>`).join('')}</select></td>
        <td><input name="subject-${day.slot}" value="${esc(day.subject)}" style="width:100%" placeholder="${weekend && !ctx.holiday ? 'Weekend: no post unless you want one' : ''}">${day.reason ? `<div class="hint" style="margin-top:4px">${esc(day.reason)}</div>` : ctx.holiday ? `<div class="hint" style="margin-top:4px">${esc(ctx.holiday.note)}</div>` : ''}</td></tr>`;
      };
      const days: PlanDay[] = SLOTS.map((slot) => {
        const existing = plan?.days.find((d) => d.slot === slot);
        if (existing) return existing;
        const ctx = dayContext(weekOf, slot);
        const weekend = slot === 'sat' || slot === 'sun';
        return { slot, template: weekend && !ctx.holiday?.post ? 'none' : 'list', subject: '', site: null, reason: '' };
      });
      const body =
        pageHead(
          'Plan the week',
          'Pick a week, ask Claude for a template and subject per weekday, adjust anything, then save and run. Each week keeps its own plan.',
          `<form method="post" action="/plan/suggest" class="inline"><input type="hidden" name="weekOf" value="${esc(weekOf)}"><button class="primary">${plan ? 'Ask Claude again' : 'Ask Claude to plan'}</button></form>`,
        ) +
        `<form method="get" action="/plan" class="card tight row" id="weekPicker" style="margin-bottom:18px">
          <a class="btn secondary small" href="/plan?week=${shift(-7)}" title="previous week">&larr;</a>
          <label><b>Week of</b> <input type="date" name="week" value="${esc(weekOf)}"></label>
          <a class="btn secondary small" href="/plan?week=${shift(7)}" title="next week">&rarr;</a>
          <span class="hint">Any day snaps to its Monday.${drafted ? ` ${drafted} draft(s) already exist for this week.` : ''}</span>
          ${planned.length ? `<span class="hint" style="margin-left:auto">Planned: ${planned.slice(0, 8).map((w) => (w === weekOf ? `<b>${w}</b>` : `<a href="/plan?week=${w}">${w}</a>`)).join(' · ')}</span>` : ''}
        </form>
        <script>document.querySelector('#weekPicker input[type=date]').addEventListener('change', (e) => { if (e.target.value) location.href = '/plan?week=' + e.target.value; });</script>` +
        (plan ? notice('info', `Plan for ${esc(weekOf)}: <b>${esc(plan.source)}</b>, ${esc(fmt(plan.createdAt))}.`) : notice('warn', `No plan for ${esc(weekOf)} yet. Ask Claude, or fill the table by hand.${hasApiKey() ? '' : ' (No API key: a default rotation is used.)'}`)) +
        `<form method="post" action="/plan">
          <input type="hidden" name="weekOf" value="${esc(weekOf)}">
          <table><tr><th>Day</th><th>Template</th><th>Site</th><th>Subject</th></tr>${days.map(row).join('')}</table>
          <p class="hint">Saturday and Sunday are "no post" unless a holiday falls there; holiday days use the holiday greeting template. quote draws from the <a href="/reviews">Reviews</a> page; screenshot, detail, backdrop and mobile need a captured site; list at most once a week. Posts on or just before a themed holiday render in that season's accent colors.</p>
          <div class="row"><button class="secondary">Save plan</button><button name="then" value="run" class="primary">Save and run weekly</button></div>
        </form>`;
      res.send(page('Plan', body, '/plan'));
    }),
  );

  app.post('/plan/suggest', (req, res) => {
    const weekOf = mondayOf(String(req.body?.['weekOf'] || nextWeekOf()));
    const job = startJob('plan', `Plan ${weekOf}`, async (log) => {
      const plan = await planWeek(weekOf, log);
      await writePlan(plan);
      log(`saved: ${plan.days.map((d) => `${d.slot}=${d.template}${d.site ? `(${d.site})` : ''}`).join(' ')}`);
    });
    res.redirect(`/jobs/${job.id}?next=/plan?week=${weekOf}`);
  });

  app.post(
    '/plan',
    wrap(async (req, res) => {
      const b = req.body as Record<string, string>;
      const weekOf = mondayOf(b['weekOf'] || nextWeekOf());
      const prev = await readPlan(weekOf);
      const days: PlanDay[] = SLOTS.map((slot) => {
        const old = prev?.days.find((d) => d.slot === slot);
        const ctx = dayContext(weekOf, slot);
        const template = (TEMPLATES as readonly string[]).includes(b[`template-${slot}`] ?? '') ? (b[`template-${slot}`] as PlanDay['template']) : 'none';
        const subject = (b[`subject-${slot}`] ?? '').trim();
        return {
          slot,
          date: ctx.date,
          template,
          site: template === 'none' ? null : b[`site-${slot}`] || null,
          subject: template === 'none' ? '' : subject,
          reason: old && old.template === template && old.subject === subject ? old.reason : template === 'none' ? (old?.reason ?? '') : 'edited by reviewer',
          holiday: ctx.holiday?.name ?? null,
          theme: ctx.theme,
        };
      });
      const plan: Plan = { weekOf, createdAt: new Date().toISOString(), source: 'edited', days, claude: prev?.claude ?? null };
      await writePlan(plan);
      if (b['then'] === 'run') {
        const job = startJob('weekly', `Weekly run for ${weekOf}`, (log) => runWeekly({ weekOf, log }));
        res.redirect(`/jobs/${job.id}?next=/?week=${weekOf}`);
        return;
      }
      res.redirect(`/plan?week=${weekOf}`);
    }),
  );
}
