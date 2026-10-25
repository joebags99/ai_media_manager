// Dashboard routes for Buffer: connection check, publish, and test-post cleanup.
import type { Express, Request, Response, RequestHandler } from 'express';
import { bufferConfig, getAccount, listChannels } from '../buffer.js';
import { TEST_MODE } from '../config.js';
import { getDraft } from '../db.js';
import { startJob } from '../jobs.js';
import { deleteBufferPosts, publishDraft, specBuffer, PLATFORMS, type Platform } from '../publish.js';
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
            ? notice('ok', `Renders are published from <code>${esc(base)}/renders/…</code>. <a href="${esc(base)}/renders/" target="_blank">Open the public listing</a> to confirm it loads from outside.`)
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
    const job = startJob('publish', `Publish ${d.slot} ${d.weekOf}`, async (log) => {
      const r = await publishDraft(d.id, { log, platforms: chosen.length ? chosen : undefined });
      return r.postIds;
    });
    res.redirect(`/jobs/${job.id}?next=/drafts/${d.id}`);
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
