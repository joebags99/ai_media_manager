// Dashboard routes for the library: shelved drafts kept for later, placed into any week/day.
import type { Express, Request, Response, RequestHandler } from 'express';
import path from 'node:path';
import { listLibrary, mondayOf, nextWeekOf, SLOTS, type Slot } from '../db.js';
import { place } from '../workflow.js';
import { renderDraftRow } from '../weekly.js';
import { startJob } from '../jobs.js';
import type { DraftContent } from '../validate.js';
import { empty, esc, pageHead } from './html.js';

type Page = (title: string, body: string, active: string) => string;
type Wrap = (fn: (req: Request, res: Response) => Promise<void>) => RequestHandler;

const DAY_NAMES: Record<Slot, string> = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };

/** Week + day picker used by Place and Duplicate. */
export function slotPicker(action: string, button: string, cls = 'secondary', weekOf?: string): string {
  return `<form method="post" action="${action}" class="row" style="gap:8px">
    <input type="date" name="weekOf" value="${esc(weekOf ?? nextWeekOf())}" title="Any day; snaps to that week’s Monday">
    <select name="slot">${SLOTS.map((s) => `<option value="${s}">${DAY_NAMES[s]}</option>`).join('')}</select>
    <button class="${cls} small">${button}</button></form>`;
}

export function registerLibraryRoutes(app: Express, page: Page, wrap: Wrap): void {
  app.get(
    '/library',
    wrap(async (_req, res) => {
      const drafts = listLibrary();
      const cards = drafts
        .map((d) => {
          const c = JSON.parse(d.contentJson) as DraftContent;
          const img = d.renderSquare ? `/renders/${path.basename(d.renderSquare)}` : null;
          return `<div class="card tight"><a href="/drafts/${d.id}">${img ? `<img src="${img}?v=${d.version}" alt="">` : ''}</a>
            <div class="muted" style="margin-top:8px">${esc(d.template)}${d.site ? ` · ${esc(d.site)}` : ''} · was ${esc(d.archivedStatus ?? 'pending')} · shelved ${esc(d.updatedAt.slice(0, 10))}</div>
            <p style="margin:6px 0 10px;font-size:14px">${esc(c.rationale)}</p>
            ${slotPicker(`/library/${d.id}/place`, 'Place', 'primary')}</div>`;
        })
        .join('');
      res.send(
        page(
          'Library',
          pageHead('Library', 'Finished drafts kept for later. Place one into any day of any week; whatever is in that day already is shelved here instead of lost. An approved draft comes back approved.') +
            (drafts.length ? `<div class="grid">${cards}</div>` : empty('Nothing shelved', 'On any pending or approved draft, use "Shelve for later" and it lands here.')),
          '/library',
        ),
      );
    }),
  );

  app.post(
    '/library/:id/place',
    wrap(async (req, res) => {
      const b = req.body as Record<string, string>;
      const weekOf = mondayOf(b['weekOf'] || nextWeekOf());
      const slot = (SLOTS as string[]).includes(b['slot'] ?? '') ? (b['slot'] as Slot) : 'mon';
      const { placed, displaced } = place(String(req.params['id']), weekOf, slot);
      const job = startJob('render', `Place draft on ${DAY_NAMES[slot]} ${weekOf}`, async (log) => {
        if (displaced) log(`shelved the ${displaced.template} draft that was on ${DAY_NAMES[slot]}`);
        await renderDraftRow(placed);
        log(`placed as v${placed.version}, status ${placed.status}`);
      });
      res.redirect(`/jobs/${job.id}?next=/drafts/${placed.id}`);
    }),
  );
}
