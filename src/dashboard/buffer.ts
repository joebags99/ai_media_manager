// Dashboard routes for Buffer: connection check, publish, and test-post cleanup.
import type { Express, Request, Response, RequestHandler } from 'express';
import { bufferConfig, getAccount, listChannels } from '../buffer.js';
import { TEST_MODE } from '../config.js';
import { getDraft } from '../db.js';
import { startJob } from '../jobs.js';
import { deleteBufferPosts, publishDraft, specBuffer, PLATFORMS, type Platform } from '../publish.js';
import { esc } from './html.js';

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
      if (!token) status = '<div class="warn">BUFFER_ACCESS_TOKEN is not set.</div>';
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
              return `<tr><td>${esc(platform)}</td><td class="muted">${esc(id)}</td><td>${ch ? `${esc(ch.name)} <span class="muted">(${esc(ch.service)}${ch.isDisconnected ? ', DISCONNECTED' : ''})</span>` : '<span class="status-error">not found in this organization</span>'}</td></tr>`;
            })
            .join('');
          status = `<div class="card"><b>Connected</b> as ${esc(acct.email)} · timezone ${esc(acct.timezone ?? '?')} · organization ${org ? esc(org.name) : `<span class="status-error">${esc(spec.organizationId)} not found</span>`}
            <table style="margin-top:10px"><tr><th>Platform</th><th>Channel id (spec)</th><th>Buffer channel</th></tr>${rows}</table></div>`;
        } catch (err) {
          status = `<div class="warn"><b>Connection failed:</b> ${esc((err as Error).message)}<br><span class="muted">Check BUFFER_ACCESS_TOKEN, and BUFFER_API_URL if Buffer's endpoint differs from the default.</span></div>`;
        }
      }
      const body = `<h1>Buffer</h1>
        <p class="muted">Mode: <b>${TEST_MODE ? 'TEST (posts scheduled 60 days out, delete button shown)' : 'LIVE'}</b> · endpoint ${esc(process.env.BUFFER_API_URL?.trim() || 'https://api.buffer.com')}</p>
        ${status}
        <h2>Image hosting</h2>
        ${base ? `<p>Renders are published from <code>${esc(base)}/renders/…</code>. Buffer must be able to download from there. <a href="${esc(base)}/renders/" target="_blank">Open</a></p>` : '<div class="warn">PUBLIC_BASE_URL is not set. Buffer downloads images by URL, so run a tunnel to this dashboard (e.g. <code>cloudflared tunnel --url http://localhost:3000</code>) and put its https URL in .env as PUBLIC_BASE_URL.</div>'}`;
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
