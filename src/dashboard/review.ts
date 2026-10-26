// Review mode: one draft at a time for a week, keyboard driven.
//   A approve · R reject · S shelve · F feedback box · J/K or ←/→ previous/next · Enter in the box sends the revision
import type { Express, Request, Response, RequestHandler } from 'express';
import path from 'node:path';
import { listDrafts, nextWeekOf, mondayOf, type Draft, type Slot } from '../db.js';
import { approve, reject, archive } from '../workflow.js';
import { reviseDraft } from '../revise.js';
import { startJob } from '../jobs.js';
import type { DraftContent } from '../validate.js';
import { badge, empty, esc, pageHead } from './html.js';

type Page = (title: string, body: string, active: string) => string;
type Wrap = (fn: (req: Request, res: Response) => Promise<void>) => RequestHandler;
const DAY_NAMES: Record<Slot, string> = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };

function queue(weekOf: string): Draft[] {
  return listDrafts({ weekOf, latestOnly: true }).filter((d) => d.status === 'pending' || d.status === 'approved');
}

export function registerReviewModeRoutes(app: Express, page: Page, wrap: Wrap): void {
  app.get(
    '/review',
    wrap(async (req, res) => {
      const weekOf = mondayOf(typeof req.query['week'] === 'string' && req.query['week'] ? req.query['week'] : nextWeekOf());
      const all = queue(weekOf);
      const pending = all.filter((d) => d.status === 'pending');
      const requested = typeof req.query['d'] === 'string' ? req.query['d'] : null;
      const d = (requested && all.find((x) => x.id === requested)) ?? pending[0] ?? null;
      const back = `<a class="btn secondary" href="/?week=${weekOf}">All drafts</a>`;
      if (!d) {
        res.send(page('Review', pageHead('Review mode', `Week of ${weekOf}`, back) + empty('Nothing left to review', all.length ? `${all.length} approved. Head to a draft to publish, or to the Buffer tab.` : 'No pending drafts this week.'), '/'));
        return;
      }
      const idx = all.findIndex((x) => x.id === d.id);
      const prev = all[idx - 1] ?? null;
      const next = all[idx + 1] ?? null;
      const c = JSON.parse(d.contentJson) as DraftContent;
      const ctx = JSON.parse(d.generationContext) as { plan?: { subject?: string } };
      const sq = d.renderSquare ? `/renders/${path.basename(d.renderSquare)}?v=${d.version}` : '';
      const pt = d.renderPortrait ? `/renders/${path.basename(d.renderPortrait)}?v=${d.version}` : '';
      const nav = (x: Draft | null, label: string) => (x ? `<a class="btn secondary small" href="/review?week=${weekOf}&d=${x.id}">${label}</a>` : `<span class="btn secondary small" style="opacity:.4">${label}</span>`);
      const dots = all.map((x) => `<a href="/review?week=${weekOf}&d=${x.id}" title="${DAY_NAMES[x.slot]} · ${x.status}" style="display:inline-block;width:12px;height:12px;border-radius:50%;margin:0 3px;background:${x.id === d.id ? 'var(--terracotta)' : x.status === 'approved' ? 'var(--ok)' : 'var(--lavender)'}"></a>`).join('');
      const captions = (['instagram', 'facebook', 'linkedin', 'googlebusiness'] as const).map((p) => `<div><b style="font-size:13px">${p}</b><p style="margin:2px 0 8px;font-size:14px;white-space:pre-wrap">${esc(c.captions[p])}${p !== 'googlebusiness' && c.hashtags[p]?.length ? `<span class="muted"> ${esc(c.hashtags[p].join(' '))}</span>` : ''}</p></div>`).join('');
      const body =
        pageHead(
          `${DAY_NAMES[d.slot]} ${badge(d.status)}`,
          `Week of ${weekOf} · ${idx + 1} of ${all.length} · ${pending.length} pending · ${esc(d.template)}${d.site ? ` · ${esc(d.site)}` : ''} · v${d.version}`,
          `${nav(prev, '← Prev')}${nav(next, 'Next →')}${back}`,
          'Review mode',
        ) +
        `<div style="text-align:center;margin:-10px 0 16px">${dots}</div>
        <div class="row" style="align-items:flex-start;gap:20px;flex-wrap:nowrap">
          <div style="flex:0 0 auto"><img src="${sq}" alt="" style="width:420px;border-radius:8px;display:block"><img src="${pt}" alt="" style="width:140px;border-radius:6px;display:block;margin-top:8px"></div>
          <div style="flex:1 1 0;min-width:0">
            <div class="card tight" style="margin-bottom:12px">${ctx.plan?.subject ? `<div class="eyebrow">Subject</div><p style="margin:2px 0 10px">${esc(ctx.plan.subject)}</p>` : ''}<div class="eyebrow">Rationale</div><p style="margin:2px 0 0">${esc(c.rationale)}</p>${c.warnings?.length ? `<p class="hint" style="color:var(--bad);margin:8px 0 0">Looks familiar: ${esc(c.warnings.join('; '))}</p>` : ''}</div>
            <div class="card tight" style="margin-bottom:12px">${captions}</div>
            <div class="card tight">
              <div class="row">
                ${d.status === 'pending' ? `<form method="post" action="/review/${d.id}/approve" class="inline" id="fA"><input type="hidden" name="week" value="${weekOf}"><button class="ok">Approve <kbd>A</kbd></button></form>
                <form method="post" action="/review/${d.id}/reject" class="inline" id="fR"><input type="hidden" name="week" value="${weekOf}"><button class="danger">Reject <kbd>R</kbd></button></form>` : `<span class="hint">Approved.</span>`}
                <form method="post" action="/review/${d.id}/archive" class="inline" id="fS"><input type="hidden" name="week" value="${weekOf}"><button class="secondary">Shelve <kbd>S</kbd></button></form>
                <a class="btn secondary" href="/drafts/${d.id}">Full page</a>
              </div>
              ${d.status === 'pending' ? `<form method="post" action="/review/${d.id}/revise" id="fF" style="margin-top:12px"><input type="hidden" name="week" value="${weekOf}"><textarea name="feedback" id="feedback" rows="2" placeholder="Feedback for Claude, then Enter  (F to focus)" style="width:100%"></textarea></form>` : ''}
              ${pending.length > 1 ? `<form method="post" action="/review/approve-all" style="margin-top:12px" onsubmit="return confirm('Approve all ${pending.length} pending drafts for this week?')"><input type="hidden" name="week" value="${weekOf}"><button class="secondary small">Approve all ${pending.length} pending</button></form>` : ''}
            </div>
            <p class="hint" style="margin-top:10px"><kbd>A</kbd> approve · <kbd>R</kbd> reject · <kbd>S</kbd> shelve · <kbd>F</kbd> feedback · <kbd>←</kbd> <kbd>→</kbd> or <kbd>J</kbd> <kbd>K</kbd> move</p>
          </div>
        </div>
        <style>kbd { font: 11px var(--body); background: rgba(255,255,255,.18); border: 1px solid rgba(255,255,255,.35); border-radius: 4px; padding: 1px 5px; margin-left: 6px; } .secondary kbd, .hint kbd { background: var(--marble); border-color: var(--lavender); color: var(--ink); }</style>
        <script>
          (() => {
            const fb = document.getElementById('feedback');
            const go = (id) => { const f = document.getElementById(id); if (f) f.submit(); };
            document.addEventListener('keydown', (e) => {
              if (e.target === fb) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (fb.value.trim()) go('fF'); } if (e.key === 'Escape') fb.blur(); return; }
              if (e.metaKey || e.ctrlKey || e.altKey) return;
              const k = e.key.toLowerCase();
              if (k === 'a') go('fA'); else if (k === 'r') { if (confirm('Reject this draft?')) go('fR'); } else if (k === 's') go('fS');
              else if (k === 'f' && fb) { e.preventDefault(); fb.focus(); }
              else if (k === 'arrowright' || k === 'k') { ${next ? `location.href = '/review?week=${weekOf}&d=${next.id}';` : ''} }
              else if (k === 'arrowleft' || k === 'j') { ${prev ? `location.href = '/review?week=${weekOf}&d=${prev.id}';` : ''} }
            });
          })();
        </script>`;
      res.send(page(`Review ${DAY_NAMES[d.slot]}`, body, '/'));
    }),
  );

  const after = (req: Request, id: string): string => {
    const weekOf = String((req.body as Record<string, string>)['week'] ?? nextWeekOf());
    const all = queue(weekOf);
    const idx = all.findIndex((x) => x.id === id);
    const nextPending = [...all.slice(idx + 1), ...all.slice(0, idx)].find((x) => x.status === 'pending');
    return `/review?week=${weekOf}${nextPending ? `&d=${nextPending.id}` : ''}`;
  };
  const act = (fn: (id: string) => unknown) => (req: Request, res: Response) => {
    const id = String(req.params['id']);
    const to = after(req, id);
    try {
      fn(id);
      res.redirect(to);
    } catch (err) {
      res.status(400).send(page('Review', pageHead('Not done', esc((err as Error).message), `<a class="btn secondary" href="${to}">Continue</a>`), '/'));
    }
  };
  app.post('/review/:id/approve', act((id) => approve(id)));
  app.post('/review/:id/reject', act((id) => reject(id)));
  app.post('/review/:id/archive', act((id) => archive(id)));
  app.post('/review/:id/revise', (req, res) => {
    const id = String(req.params['id']);
    const weekOf = String((req.body as Record<string, string>)['week'] ?? nextWeekOf());
    const feedback = String((req.body as Record<string, string>)['feedback'] ?? '').trim();
    if (!feedback) {
      res.redirect(`/review?week=${weekOf}&d=${id}`);
      return;
    }
    const job = startJob('revise', `Revise ${id.slice(0, 8)}`, async (log) => {
      const next = await reviseDraft(id, feedback, { log });
      log(`created v${next.version}`);
    });
    res.redirect(`/jobs/${job.id}?next=/review?week=${weekOf}`);
  });
  app.post('/review/approve-all', (req, res) => {
    const weekOf = String((req.body as Record<string, string>)['week'] ?? nextWeekOf());
    for (const d of queue(weekOf)) if (d.status === 'pending') approve(d.id);
    res.redirect(`/?week=${weekOf}`);
  });
}
