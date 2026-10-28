// Calendar: a month grid of what is planned, drafted, scheduled and posted, with holidays.
import type { Express, Request, Response, RequestHandler } from 'express';
import path from 'node:path';
import { listDrafts, mondayOf, slotDate, SLOTS, type Draft, type Slot } from '../db.js';
import { readPlan, type PlanDay } from '../plan.js';
import { holidayOn } from '../holidays.js';
import { metricsForDraft } from '../metrics.js';
import { badge, esc, pageHead } from './html.js';

type Page = (title: string, body: string, active: string) => string;
type Wrap = (fn: (req: Request, res: Response) => Promise<void>) => RequestHandler;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function shiftMonth(ym: string, n: number): string {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

export function registerCalendarRoutes(app: Express, page: Page, wrap: Wrap): void {
  app.get(
    '/calendar',
    wrap(async (req, res) => {
      const today = new Date().toISOString().slice(0, 10);
      const ym = typeof req.query['month'] === 'string' && /^\d{4}-\d{2}$/.test(req.query['month']) ? req.query['month'] : today.slice(0, 7);
      const [y, m] = ym.split('-').map(Number) as [number, number];
      const first = `${ym}-01`;
      const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
      const last = `${ym}-${String(lastDay).padStart(2, '0')}`;
      const startWeek = mondayOf(first);
      const weeks: string[] = [];
      for (let w = startWeek; w <= last; w = slotDate(w, 'sun') < last ? mondayOf(new Date(Date.parse(slotDate(w, 'sun')) + 86_400_000).toISOString().slice(0, 10)) : '9999') weeks.push(w);

      // Drafts and plans for every week shown.
      const byDate = new Map<string, { draft: Draft | null; plan: PlanDay | null }>();
      for (const w of weeks) {
        const plan = await readPlan(w);
        const current = listDrafts({ weekOf: w, latestOnly: true });
        for (const slot of SLOTS) {
          const date = slotDate(w, slot);
          byDate.set(date, { draft: current.find((d) => d.slot === slot && d.status !== 'rejected') ?? null, plan: plan?.days.find((d) => d.slot === slot) ?? null });
        }
      }

      const cell = (date: string, slot: Slot) => {
        const inMonth = date.startsWith(ym);
        const { draft, plan } = byDate.get(date) ?? { draft: null, plan: null };
        const h = holidayOn(date);
        const weekOf = mondayOf(date);
        let main = '';
        if (draft) {
          const img = draft.renderSquare ? `/renders/${path.basename(draft.renderSquare)}?v=${draft.version}` : '';
          const sent = draft.status === 'posted' || draft.status === 'scheduled' ? metricsForDraft(draft.id).filter((r) => r.status === 'sent') : [];
          const eng = sent.reduce((a, r) => a + r.engagement, 0);
          main = `<a href="/drafts/${draft.id}" style="display:block;text-decoration:none;color:var(--ink)">${img ? `<img src="${img}" alt="" style="width:100%;border-radius:4px;display:block">` : ''}
            <div style="margin-top:4px;font-size:12px">${badge(draft.status)}${sent.length ? ` <b>${Math.round(eng)}</b> eng` : ''}</div>
            <div class="muted" style="font-size:11.5px">${esc(draft.template)}${draft.site ? ` · ${esc(draft.site)}` : ''}</div></a>`;
        } else if (plan && plan.template !== 'none') {
          main = `<a href="/plan?week=${weekOf}" style="display:block;text-decoration:none;color:var(--ink);border:1px dashed var(--lavender);border-radius:6px;padding:8px;font-size:12px"><b>${esc(plan.template)}</b> planned<br><span class="muted">${esc(plan.subject.slice(0, 48))}${plan.subject.length > 48 ? '…' : ''}</span></a>`;
        } else if (plan && plan.template === 'none') {
          main = `<div class="muted" style="font-size:11.5px">no post</div>`;
        } else if (slot !== 'sat' && slot !== 'sun' && date >= today) {
          main = `<a href="/plan?week=${weekOf}" class="muted" style="font-size:11.5px">not planned</a>`;
        }
        return `<td style="vertical-align:top;height:132px;width:14.28%;padding:8px;${inMonth ? '' : 'background:var(--marble);opacity:.65;'}${date === today ? 'box-shadow:inset 0 0 0 2px var(--terracotta);' : ''}">
          <div class="row" style="justify-content:space-between;margin-bottom:6px"><b style="font-family:var(--display)">${Number(date.slice(8))}</b>${h ? `<span class="badge" style="background:${h.theme ? 'var(--terracotta)' : 'var(--ash)'};font-size:10px" title="${esc(h.note)}">${esc(h.name)}</span>` : ''}</div>${main}</td>`;
      };

      const rows = weeks
        .map((w) => {
          const drafts = listDrafts({ weekOf: w, latestOnly: true }).filter((d) => d.status !== 'rejected');
          const counts = drafts.reduce<Record<string, number>>((a, d) => ((a[d.status] = (a[d.status] ?? 0) + 1), a), {});
          const summary = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ');
          return `<tr>${SLOTS.map((slot) => cell(slotDate(w, slot), slot)).join('')}</tr>
            <tr><td colspan="7" style="padding:4px 10px;background:var(--marble);font-size:12px" class="muted">Week of ${w}: ${summary || 'nothing yet'} · <a href="/?week=${w}">drafts</a> · <a href="/plan?week=${w}">plan</a> · <a href="/review?week=${w}">review</a></td></tr>`;
        })
        .join('');

      const body =
        pageHead(
          `${MONTHS[m - 1]} ${y}`,
          'Everything planned, drafted, scheduled and posted, with US holidays. Click a day to open its draft or plan.',
          `<a class="btn secondary" href="/calendar?month=${shiftMonth(ym, -1)}">←</a><a class="btn secondary" href="/calendar">Today</a><a class="btn secondary" href="/calendar?month=${shiftMonth(ym, 1)}">→</a>`,
          'Calendar',
        ) +
        `<table style="table-layout:fixed"><tr>${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => `<th>${d}</th>`).join('')}</tr>${rows}</table>
        <p class="hint" style="margin-top:12px">${badge('pending')} waiting for review · ${badge('approved')} ready to publish · ${badge('scheduled')} in Buffer · ${badge('posted')} live · dashed = planned, not generated · orange tag = themed holiday</p>`;
      res.send(page('Calendar', body, '/calendar'));
    }),
  );
}
