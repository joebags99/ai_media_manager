// Dashboard routes for Buffer: connection check, publish, and test-post cleanup.
import type { Express, Request, Response, RequestHandler } from 'express';
import { bufferConfig, getAccount, listChannels } from '../buffer.js';
import { TEST_MODE } from '../config.js';
import { getDraft, listDrafts, mondayOf, nextWeekOf } from '../db.js';
import { startJob } from '../jobs.js';
import { deleteBufferPosts, publishDraft, specBuffer, checkPublicBase, PLATFORMS, type Platform } from '../publish.js';
import { esc, notice, pageHead, section } from './html.js';

type Page = (title: string, body: string, active: string) => string;
type Wrap = (fn: (req: Request, res: Response) => Promise<void>) => RequestHandler;

export function registerBufferRoutes(app: Express, page: Page, wrap: Wrap): void {
  app.get(
    '/buffer',
    wrap(async (_req, res) => {
      const spec = await specBuffer();
      const base = process.env.PUBLIC_BASE_URL?.trim() || '';
      const token = Boolean(process.env.BUFFER_ACCESS_TOKEN?.trim());
      let status = '';
      if (!token) status = notice('bad', '<b>BUFFER_ACCESS_TOKEN</b> is not set in .env. Create one at publish.buffer.com/settings/api.');
      else {
        try {
          const cfg = bufferConfig();
          const acct = await getAccount(cfg);
          const org = acct.organizations.find((o) => o.id === spec.organizationId);
          const channels = await listChannels(cfg, spec.organizationId);
          const byId = new Map(channels.map((c) => [c.id, c]));
          const rows = Object.entries(spec.channels)
            .map(([platform, id]) => {
              const ch = byId.get(id);
              return `<tr><td>${esc(platform)}</td><td>${ch ? `${esc(ch.name)} <span class="muted">(${esc(ch.service)}${ch.isDisconnected ? ', <span class="status-error">disconnected</span>' : ''})</span>` : '<span class="status-error">not found in this organization</span>'}</td><td class="muted">${esc(id)}</td></tr>`;
            })
            .join('');
          status =
            notice('ok', `<b>Connected</b> as ${esc(acct.email)} · timezone ${esc(acct.timezone ?? '?')} · organization ${org ? esc(org.name) : `<span class="status-error">${esc(spec.organizationId)} not found</span>`}`) +
            `<table><tr><th>Platform</th><th>Buffer channel</th><th>Channel id (from the spec)</th></tr>${rows}</table>`;
        } catch (err) {
          status = notice('bad', `<b>Connection failed:</b> ${esc((err as Error).message)}<br><span class="hint">Check BUFFER_ACCESS_TOKEN, and BUFFER_API_URL if Buffer’s endpoint differs from the default.</span>`);
        }
      }
      const body =
        pageHead(
          'Buffer',
          `Approved drafts are scheduled here, one post per channel. ${TEST_MODE ? '<b>Test mode</b>: posts land 60 days out and each draft has a delete button.' : '<b>Live</b>: posts are scheduled for real.'} Endpoint <code>${esc(process.env.BUFFER_API_URL?.trim() || 'https://api.buffer.com')}</code>.`,
        ) +
        section('Connection', 'The token in .env, the organization, and the four channel ids from pipeline-spec.json.', status) +
        section(
          'Image hosting',
          'Buffer has no upload endpoint; it downloads each post image from a public URL. The dashboard serves renders at PUBLIC_BASE_URL/renders/…, so that URL must reach this machine from the internet.',
          base
            ? await (async () => {
                const sample = listDrafts().find((d) => d.renderSquare)?.renderSquare ?? null;
                const r = await checkPublicBase(sample);
                return r.ok
                  ? notice('ok', `<b>Reachable.</b> ${esc(r.detail)} Renders are served from <code>${esc(base)}/renders/…</code>. <a href="${esc(r.url)}" target="_blank">Open</a>`)
                  : notice('bad', `<b>Not reachable from outside:</b> ${esc(r.detail)}<br><code>${esc(r.url)}</code><br><span class="hint">Publishing will fail until this is green. Buffer downloads images from this URL.</span>`);
              })()
            : notice('warn', '<b>PUBLIC_BASE_URL</b> is not set. Locally: run <code>cloudflared tunnel --url http://localhost:3000</code>, copy the https URL it prints into .env as PUBLIC_BASE_URL, and restart the dashboard. The URL changes each time the tunnel restarts.'),
        );
      res.send(page('Buffer', body, '/buffer'));
    }),
  );

  app.post('/drafts/:id/publish', (req, res) => {
    const d = getDraft(String(req.params['id']));
    if (!d) {
      res.status(404).send('unknown draft');
      return;
    }
    const b = (req.body ?? {}) as Record<string, string | string[]>;
    const raw = b['platforms'];
    const chosen = (Array.isArray(raw) ? raw : raw ? [raw] : []).filter((p): p is Platform => (PLATFORMS as string[]).includes(p));
    const next = typeof b['next'] === 'string' && b['next'].startsWith('/') ? b['next'] : `/drafts/${d.id}`;
    const job = startJob('publish', `Publish ${d.slot} ${d.weekOf}`, async (log) => {
      const r = await publishDraft(d.id, { log, platforms: chosen.length ? chosen : undefined });
      return r.postIds;
    });
    res.redirect(`/jobs/${job.id}?next=${encodeURIComponent(next)}`);
  });

  // Every approved draft of a week, in order, default channels each; keeps going past a failure.
  app.post('/weekly/publish', (req, res) => {
    const weekOf = mondayOf(String((req.body as Record<string, string>)['weekOf'] || nextWeekOf()));
    const approved = listDrafts({ weekOf, status: 'approved', latestOnly: true });
    const job = startJob('publish', `Publish ${approved.length} approved for ${weekOf}`, async (log) => {
      let ok = 0;
      const failed: string[] = [];
      for (const d of approved) {
        log(`--- ${d.slot}`);
        try {
          await publishDraft(d.id, { log });
          ok++;
        } catch (err) {
          failed.push(`${d.slot}: ${(err as Error).message}`);
          log(`${d.slot}: failed: ${(err as Error).message}`);
        }
      }
      log(`done: ${ok} scheduled${failed.length ? `, ${failed.length} failed` : ''}`);
      if (failed.length) throw new Error(failed.join('; '));
      return ok;
    });
    res.redirect(`/jobs/${job.id}?next=${encodeURIComponent(`/?week=${weekOf}`)}`);
  });

  app.post('/drafts/:id/unpublish', (req, res) => {
    const d = getDraft(String(req.params['id']));
    if (!d?.bufferPostIds) {
      res.status(404).send('no Buffer posts on this draft');
      return;
    }
    const ids = Object.values(JSON.parse(d.bufferPostIds) as Record<string, string>);
    const job = startJob('buffer-delete', `Delete Buffer posts for ${d.slot} ${d.weekOf}`, (log) => deleteBufferPosts(ids, { log, draftId: d.id }));
    res.redirect(`/jobs/${job.id}?next=/drafts/${d.id}`);
  });
}
