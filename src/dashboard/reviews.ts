// Dashboard route for the review list: paste client reviews (Google Business, the site,
// anywhere) so the quote template can draw from them.
import type { Express, Request, Response, RequestHandler } from 'express';
import { addReview, listReviews, removeReview, type Review } from '../reviews.js';
import { badge, empty, esc, notice, pageHead, section } from './html.js';

type Page = (title: string, body: string, active: string) => string;
type Wrap = (fn: (req: Request, res: Response) => Promise<void>) => RequestHandler;

export function registerReviewRoutes(app: Express, page: Page, wrap: Wrap): void {
  const form = (v: Partial<Review> = {}, error?: string) => `${error ? notice('bad', esc(error)) : ''}
    <form method="post" action="/reviews" class="card" style="max-width:760px">
      <div class="row" style="align-items:flex-start">
        <label class="field" style="flex:1 1 200px;margin:0"><b>Reviewer</b><input name="name" value="${esc(v.name ?? '')}" placeholder="Dana W." required></label>
        <label class="field" style="flex:1 1 220px;margin:0"><b>Their business</b><input name="business" value="${esc(v.business ?? '')}" placeholder="Valley Tile & Stone"></label>
        <label class="field" style="flex:0 0 150px;margin:0"><b>Source</b><select name="source"><option value="google" ${v.source === 'google' || !v.source ? 'selected' : ''}>Google Business</option><option value="site" ${v.source === 'site' ? 'selected' : ''}>Our website</option><option value="other" ${v.source === 'other' ? 'selected' : ''}>Other</option></select></label>
        <label class="field" style="flex:0 0 160px;margin:0"><b>Date</b><input type="date" name="date" value="${esc(v.date ?? '')}"></label>
      </div>
      <label class="field"><b>Review text, pasted exactly</b><textarea name="text" rows="4" required placeholder="Paste the whole review. Claude quotes a passage of it word for word.">${esc(v.text ?? '')}</textarea><span class="hint">Only reviews about Daedabyte. A client site’s own customer reviews do not belong here.</span></label>
      <button class="primary">Add review</button>
    </form>`;

  app.get(
    '/reviews',
    wrap(async (req, res) => {
      const reviews = await listReviews();
      const rows = reviews
        .map((r) => `<div class="card tight"><div class="row" style="justify-content:space-between"><b>${esc(r.name)}${r.business ? ` <span class="muted">· ${esc(r.business)}</span>` : ''}</b><span>${badge(r.source === 'google' ? 'approved' : 'pending', r.source === 'google' ? 'Google' : r.source === 'site' ? 'Website' : 'Other')}${r.date ? ` <span class="muted">${esc(r.date)}</span>` : ''}</span></div>
          <p style="margin:8px 0;font-style:italic">“${esc(r.text)}”</p>
          <form method="post" action="/reviews/${r.id}/delete" onsubmit="return confirm('Remove this review?')"><button class="danger small">Remove</button></form></div>`)
        .join('');
      const body =
        pageHead(
          'Reviews',
          'What clients have said about Daedabyte, pasted from Google Business or the website. The quote template picks one and copies a passage word for word; the validator rejects anything that is not a verbatim match.',
        ) +
        section('Add a review', 'Open your Google Business profile, copy a review, paste it here.', form({}, typeof req.query['error'] === 'string' ? req.query['error'] : undefined)) +
        section(`On file (${reviews.length})`, '', reviews.length ? `<div class="grid wide">${rows}</div>` : empty('No reviews yet', 'Until there is at least one, the quote template is unavailable (unless our own site has a captured testimonials section).'));
      res.send(page('Reviews', body, '/reviews'));
    }),
  );

  app.post(
    '/reviews',
    wrap(async (req, res) => {
      const b = req.body as Record<string, string>;
      try {
        await addReview({ name: b['name'] ?? '', business: b['business'] ?? '', text: b['text'] ?? '', source: (['google', 'site', 'other'].includes(b['source'] ?? '') ? b['source'] : 'other') as Review['source'], date: b['date'] || null });
        res.redirect('/reviews');
      } catch (err) {
        res.redirect(`/reviews?error=${encodeURIComponent((err as Error).message)}`);
      }
    }),
  );

  app.post(
    '/reviews/:id/delete',
    wrap(async (req, res) => {
      await removeReview(String(req.params['id']));
      res.redirect('/reviews');
    }),
  );
}
