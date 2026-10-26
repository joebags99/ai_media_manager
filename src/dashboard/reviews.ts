// Dashboard route for the review list: paste client reviews (Google Business, the site,
// anywhere) so the quote template can draw from them.
import type { Express, Request, Response, RequestHandler } from 'express';
import { addReview, listReviews, removeReview, findPlaceId, googleConfig, importGoogleReviews, type Review } from '../reviews.js';
import { startJob } from '../jobs.js';
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

  const googleBlock = (found?: string) => {
    const key = Boolean(process.env.GOOGLE_PLACES_API_KEY?.trim());
    const placeId = process.env.GOOGLE_PLACE_ID?.trim() || '';
    if (!key) return notice('info', '<b>GOOGLE_PLACES_API_KEY</b> is not set. In Google Cloud Console: create a project, enable <i>Places API (New)</i>, create an API key, and put it in .env as GOOGLE_PLACES_API_KEY. Then set GOOGLE_PLACE_ID (find it below).');
    if (!placeId) return `${notice('warn', '<b>GOOGLE_PLACE_ID</b> is not set. Search for the business, copy the id into .env as GOOGLE_PLACE_ID, restart.')}
      <form method="post" action="/reviews/find-place" class="row"><input name="query" placeholder="Daedabyte Web Solutions, Mt Jackson VA" style="min-width:360px" required><button class="secondary">Find Place ID</button></form>
      ${found ? `<pre class="muted" style="margin-top:10px">${esc(found)}</pre>` : ''}`;
    return `<form method="post" action="/reviews/import" class="row"><button class="primary">Import from Google</button><span class="hint">Place ID <code>${esc(placeId)}</code></span></form>`;
  };

  app.post('/reviews/import', (_req, res) => {
    const job = startJob('reviews', 'Import Google reviews', async (log) => {
      const r = await importGoogleReviews(googleConfig(), log);
      log(`${r.added.length} added, ${r.skipped} skipped`);
      return r.added.length;
    });
    res.redirect(`/jobs/${job.id}?next=/reviews`);
  });

  app.post(
    '/reviews/find-place',
    wrap(async (req, res) => {
      const q = String((req.body as Record<string, string>)['query'] ?? '').trim();
      try {
        const key = process.env.GOOGLE_PLACES_API_KEY?.trim() ?? '';
        const hits = await findPlaceId(key, q);
        const text = hits.length
          ? hits.map((h) => `${h.id}\n  ${h.name} \u2014 ${h.address}`).join('\n')
          : 'No places found. If the Business Profile is a service-area business (no public street address), Google does not include it in the Places API and there is no Place ID to find; use the Business Profile API route instead, or paste reviews by hand below.';
        res.redirect(`/reviews?found=${encodeURIComponent(text)}`);
      } catch (err) {
        res.redirect(`/reviews?found=${encodeURIComponent((err as Error).message)}`);
      }
    }),
  );

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
        section('Import from Google', 'Pulls the reviews Google exposes for your Business Profile (up to five, Google picks which) through the Places API. Already-imported ones are skipped; reviews under 4 stars are left out.', googleBlock(typeof req.query['found'] === 'string' ? req.query['found'] : undefined)) +
        section('Add a review by hand', 'For anything Google does not return, or reviews from elsewhere: copy it, paste it here.', form({}, typeof req.query['error'] === 'string' ? req.query['error'] : undefined)) +
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
