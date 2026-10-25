// dashboard.ts: Express app on localhost:3000. Review console for drafts (M4) and the
// operator console for every manual step: template previews, site capture, weekly run,
// test publish. Plain HTML, no client framework.

import express, { type Request, type Response, type NextFunction } from 'express';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { DASHBOARD_PORT, FIXTURES_DIR, RENDERS_DIR, SCREENSHOTS_DIR, TEST_MODE } from './config.js';
import { captureSite, readManifest, type Manifest } from './capture.js';
import { listSites } from './sites.js';
import { renderDraft, type RenderInput } from './render.js';
import { getJob, recentJobs, startJob } from './jobs.js';
import { esc, jobView, layout } from './dashboard/html.js';

const page = (title: string, body: string, active: string) => layout(title, body, { testMode: TEST_MODE, active });
const wrap = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) =>
  fn(req, res).catch(next);

export function createApp(): express.Express {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use('/renders', express.static(RENDERS_DIR));
  app.use('/screenshots', express.static(SCREENSHOTS_DIR));

  // ---- Drafts (M4 fills this in) -------------------------------------------------
  app.get('/', (_req, res) => {
    res.send(
      page(
        'Drafts',
        `<h1>Drafts</h1><p class="muted">No drafts yet. Generation arrives in M3; approve / revise / reject in M4.</p>`,
        '/',
      ),
    );
  });

  // ---- Templates: fixture previews ------------------------------------------------
  app.get(
    '/templates',
    wrap(async (_req, res) => {
      const fixtures = (await readdir(FIXTURES_DIR)).filter((f) => f.endsWith('.json')).sort();
      let rendered: string[] = [];
      try {
        rendered = await readdir(RENDERS_DIR);
      } catch {
        // nothing rendered yet
      }
      const cards = await Promise.all(
        fixtures.map(async (f) => {
          const input = JSON.parse(await readFile(path.join(FIXTURES_DIR, f), 'utf8')) as RenderInput;
          const sq = `${input.id}-square.png`;
          const pt = `${input.id}-portrait.png`;
          const img = (file: string, label: string) =>
            rendered.includes(file)
              ? `<a href="/renders/${file}?t=${Date.now()}" target="_blank"><img src="/renders/${file}?t=${Date.now()}" alt="${esc(label)}"></a>`
              : `<p class="muted">${esc(label)}: not rendered yet</p>`;
          return `<div class="card"><b>${esc(input.id)}</b> <span class="muted">${esc(input.template)}</span>
            <div class="grid" style="grid-template-columns:1fr 1fr;margin-top:10px">${img(sq, 'square')}${img(pt, 'portrait')}</div>
            <details style="margin-top:8px"><summary class="muted">slots</summary><pre class="muted">${esc(JSON.stringify(input.slots, null, 2))}</pre></details></div>`;
        }),
      );
      res.send(
        page(
          'Templates',
          `<h1>Templates</h1>
          <div class="row"><form method="post" action="/templates/render"><button>Re-render all fixtures</button></form>
          <span class="muted">Renders templates/*.html from fixtures/*.json at 1080×1080 and 1080×1350.</span></div>
          <div class="grid" style="margin-top:18px">${cards.join('')}</div>`,
          '/templates',
        ),
      );
    }),
  );

  app.post(
    '/templates/render',
    wrap(async (_req, res) => {
      const job = startJob('render', 'Render fixtures', async (log) => {
        const files = (await readdir(FIXTURES_DIR)).filter((f) => f.endsWith('.json')).sort();
        const browser = await chromium.launch();
        try {
          for (const f of files) {
            const input = JSON.parse(await readFile(path.join(FIXTURES_DIR, f), 'utf8')) as RenderInput;
            input.screenshotDir ??= path.join(FIXTURES_DIR, 'screenshots');
            const r = await renderDraft(input, { browser });
            log(`${input.id}: ${path.basename(r.square)}, ${path.basename(r.portrait)}`);
          }
        } finally {
          await browser.close();
        }
      });
      res.redirect(`/jobs/${job.id}?next=/templates`);
    }),
  );

  // ---- Sites: capture ---------------------------------------------------------------
  app.get(
    '/sites',
    wrap(async (_req, res) => {
      const sites = await listSites();
      const rows = await Promise.all(
        sites.map(async (s) => {
          const m = await readManifest(s.slug);
          return `<tr><td><a href="/sites/${s.slug}"><b>${esc(s.name)}</b></a><br><span class="muted">${esc(s.url)}</span></td>
            <td>${s.permissionToName ? 'may name' : '<span class="muted">anonymous</span>'}</td>
            <td>${m ? `${m.shots.length} shots · ${esc(m.capturedAt.slice(0, 16).replace('T', ' '))}${m.warnings.length ? ` · <span class="status-error">${m.warnings.length} warning(s)</span>` : ''}` : '<span class="muted">never captured</span>'}</td>
            <td><form method="post" action="/sites/${s.slug}/capture"><button>Capture</button></form></td></tr>`;
        }),
      );
      res.send(
        page(
          'Sites',
          `<h1>Sites</h1><p class="muted">Recipes live in <code>sites/&lt;slug&gt;.json</code>. Capture takes desktop (1440) and mobile (390) shots of each section.</p>
          <table><tr><th>Site</th><th>Naming</th><th>Last capture</th><th></th></tr>${rows.join('')}</table>`,
          '/sites',
        ),
      );
    }),
  );

  app.get(
    '/sites/:slug',
    wrap(async (req, res) => {
      const slug = String(req.params['slug']);
      const m: Manifest | null = await readManifest(slug);
      const body = m
        ? `${m.warnings.map((w) => `<div class="warn">${esc(w)}</div>`).join('')}
           <div class="grid">${m.shots
             .map(
               (s) => `<div class="card"><a href="/screenshots/${slug}/${s.file}" target="_blank"><img src="/screenshots/${slug}/${s.file}" alt="${esc(s.section)} ${s.viewport}"></a>
               <div style="margin-top:8px"><b>${esc(s.section)}</b> <span class="muted">${s.viewport} · ${s.width}×${s.height}</span></div></div>`,
             )
             .join('')}</div>
           <details style="margin-top:18px"><summary class="muted">manifest.json</summary><pre class="muted">${esc(JSON.stringify(m, null, 2))}</pre></details>`
        : `<p class="muted">Not captured yet.</p>`;
      res.send(
        page(
          slug,
          `<h1>${esc(m?.name ?? slug)}</h1>
          <div class="row"><form method="post" action="/sites/${esc(slug)}/capture"><button>Capture now</button></form><a class="btn" href="/sites" style="background:#fff;color:var(--ink);border:1px solid var(--ash)">Back</a></div>
          <div style="margin-top:18px">${body}</div>`,
          '/sites',
        ),
      );
    }),
  );

  app.post('/sites/:slug/capture', (req, res) => {
    const slug = String(req.params['slug']);
    const job = startJob('capture', `Capture ${slug}`, (log) => captureSite(slug, { log }));
    res.redirect(`/jobs/${job.id}?next=/sites/${slug}`);
  });

  // ---- Jobs --------------------------------------------------------------------------
  app.get('/jobs', (_req, res) => {
    const rows = recentJobs()
      .map(
        (j) => `<tr><td><a href="/jobs/${j.id}">${esc(j.label)}</a></td><td class="status-${j.status}">${j.status}</td>
        <td class="muted">${esc(j.startedAt.slice(11, 19))}</td><td class="muted">${esc(j.error ?? '')}</td></tr>`,
      )
      .join('');
    res.send(page('Jobs', `<h1>Jobs</h1><table><tr><th>Job</th><th>Status</th><th>Started</th><th></th></tr>${rows || '<tr><td colspan="4" class="muted">No jobs this session.</td></tr>'}</table>`, '/jobs'));
  });

  app.get('/jobs/:id', (req, res) => {
    const job = getJob(String(req.params['id']));
    if (!job) {
      res.status(404).send(page('Job', '<p>Unknown job.</p>', '/jobs'));
      return;
    }
    const next = typeof req.query['next'] === 'string' ? req.query['next'] : '/jobs';
    res.send(page(job.label, `<h1>${esc(job.label)}</h1>${jobView(job.id, next)}`, '/jobs'));
  });

  app.get('/api/jobs/:id', (req, res) => {
    const job = getJob(String(req.params['id']));
    if (!job) {
      res.status(404).json({ error: 'unknown job' });
      return;
    }
    res.json(job);
  });

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).send(page('Error', `<h1>Error</h1><pre class="log">${esc(err.stack ?? err.message)}</pre>`, ''));
  });

  return app;
}

export function startDashboard(port = DASHBOARD_PORT): Promise<void> {
  return new Promise((resolve) => {
    createApp().listen(port, () => {
      console.log(`Dashboard: http://localhost:${port}  (${TEST_MODE ? 'TEST MODE' : 'LIVE'})`);
      resolve();
    });
  });
}
