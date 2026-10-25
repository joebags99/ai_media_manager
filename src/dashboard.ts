// dashboard.ts: Express app on localhost:3000. Review console for drafts (M4) and the
// operator console for every manual step: template previews, site capture, weekly run,
// test publish. Plain HTML, no client framework.

import express, { type Request, type Response, type NextFunction } from 'express';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { DASHBOARD_PORT, FIXTURES_DIR, RENDERS_DIR, SCREENSHOTS_DIR, TEST_MODE } from './config.js';
import { captureSite, readManifest, type Manifest } from './capture.js';
import { listSites, loadSite, saveSite, slugify, type Site, type SiteKind } from './sites.js';
import { inspectSite, suggestRecipe } from './inspect.js';
import { hasApiKey } from './claude.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { siteDir } from './capture.js';
import { renderDraft, type RenderInput } from './render.js';
import { getJob, recentJobs, startJob } from './jobs.js';
import { esc, jobView, layout } from './dashboard/html.js';
import { registerDraftRoutes } from './dashboard/drafts.js';
import { registerBufferRoutes } from './dashboard/buffer.js';

const page = (title: string, body: string, active: string) => layout(title, body, { testMode: TEST_MODE, active });
const wrap = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) =>
  fn(req, res).catch(next);

export function createApp(): express.Express {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  // Buffer fetches post images from PUBLIC_BASE_URL/renders/<file>; the index exists so
  // the tunnel can be checked from a browser.
  app.get(
    '/renders/',
    wrap(async (_req, res) => {
      let files: string[] = [];
      try {
        files = (await readdir(RENDERS_DIR)).filter((f) => f.endsWith('.png')).sort();
      } catch {
        // nothing rendered yet
      }
      res.send(page('Renders', `<h1>Renders</h1><p class="muted">${files.length} file(s). Buffer downloads post images from here.</p><ul>${files.map((f) => `<li><a href="/renders/${esc(f)}">${esc(f)}</a></li>`).join('')}</ul>`, ''));
    }),
  );
  app.use('/renders', express.static(RENDERS_DIR));
  app.use('/screenshots', express.static(SCREENSHOTS_DIR));

  registerDraftRoutes(app, page, wrap);
  registerBufferRoutes(app, page, wrap);

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
            <td>${s.kind === 'own' ? '<span class="badge" style="margin:0">OURS</span>' : s.permissionToName ? 'client · may name' : '<span class="muted">client · anonymous</span>'}</td>
            <td>${m ? `${m.shots.length} shots · ${esc(m.capturedAt.slice(0, 16).replace('T', ' '))}${m.warnings.length ? ` · <span class="status-error">${m.warnings.length} warning(s)</span>` : ''}` : '<span class="muted">never captured</span>'}</td>
            <td><form method="post" action="/sites/${s.slug}/capture"><button>Capture</button></form></td></tr>`;
        }),
      );
      res.send(
        page(
          'Sites',
          `<h1>Sites</h1>
          <div class="row"><a class="btn" href="/sites/new">Add a site</a><span class="muted">Recipes are saved to <code>sites/&lt;slug&gt;.json</code>. Capture takes desktop (1440) and mobile (390) shots of each section.</span></div>
          <table><tr><th>Site</th><th>Kind</th><th>Last capture</th><th></th></tr>${rows.join('')}</table>`,
          '/sites',
        ),
      );
    }),
  );

  // ---- Sites: add / edit ------------------------------------------------------------
  const siteForm = (site: Partial<Site>, error?: string) => {
    const r = site.recipe ?? { sections: [] };
    const sections = [...r.sections, ...Array.from({ length: Math.max(0, 4 - r.sections.length) }, () => ({ name: '', selector: '' }))];
    const field = (label: string, name: string, value: string, hint = '', type = 'text') =>
      `<label style="display:block;margin:12px 0"><b>${label}</b><br><input type="${type}" name="${name}" value="${esc(value)}" style="width:100%;padding:8px;font:inherit">${hint ? `<span class="muted">${hint}</span>` : ''}</label>`;
    return `<h1>${site.slug ? `Edit ${esc(site.name)}` : 'Add a site'}</h1>
    ${error ? `<div class="warn">${esc(error)}</div>` : ''}
    <form method="post" class="card" style="max-width:760px">
      ${site.slug ? `<input type="hidden" name="slug" value="${esc(site.slug)}">` : ''}
      ${field('Name', 'name', site.name ?? '', 'Shown in the dashboard; the file slug is derived from it.')}
      ${field('URL', 'url', site.url ?? 'https://', '', 'url')}
      ${field('Industry', 'industry', site.industry ?? '', 'One or two words, e.g. "tile installation". Claude uses it for context.')}
      <fieldset style="border:0;padding:0;margin:12px 0"><b>Whose site is this?</b><br>
        <label><input type="radio" name="kind" value="client" ${site.kind !== 'own' ? 'checked' : ''}> A client's site</label> &nbsp;
        <label><input type="radio" name="kind" value="own" ${site.kind === 'own' ? 'checked' : ''}> Ours (Daedabyte)</label>
        <br><span class="muted">Our own sites are written about in the first person and never presented as a client or used for client proof points.</span></fieldset>
      <label style="display:block;margin:12px 0"><input type="checkbox" name="permissionToName" ${site.permissionToName ? 'checked' : ''}> <b>Client has agreed to be named in posts</b><br><span class="muted">Unchecked: copy stays anonymous ("a local tile installer"). Ignored for our own sites.</span></label>
      <h2>Sections to capture</h2>
      <p class="muted">Name + CSS selector. The first <em>visible</em> match is screenshotted at desktop and mobile. The top of the page is always captured too.</p>
      <table>${sections
        .map(
          (sec, i) => `<tr><td style="width:30%"><input name="sectionName" value="${esc(sec.name)}" placeholder="hero" style="width:100%;padding:6px;font:inherit"></td>
          <td><input name="sectionSelector" value="${esc(sec.selector)}" placeholder="main section:first-of-type" style="width:100%;padding:6px;font:inherit"></td></tr>`,
        )
        .join('')}</table>
      <h2>Advanced</h2>
      ${field('Dismiss selectors', 'dismiss', (r.dismiss ?? []).join(', '), 'Comma-separated. Clicked if visible (cookie banners, popups).')}
      ${field('Wait for selectors', 'waitFor', (r.waitFor ?? []).join(', '), 'Comma-separated. Capture waits until these exist.')}
      ${field('Settle time (ms)', 'settleMs', String(r.settleMs ?? 800), 'Pause after load for animations.', 'number')}
      <div class="row" style="margin-top:18px"><button>Save</button><a class="btn secondary" href="${site.slug ? `/sites/${site.slug}` : '/sites'}">Cancel</a></div>
    </form>`;
  };

  const siteFromForm = (b: Record<string, unknown>): Omit<Site, 'slug'> & { slug?: string } => {
    const list = (v: unknown): string[] => (Array.isArray(v) ? v : [v]).map((x) => String(x ?? ''));
    const names = list(b['sectionName']);
    const selectors = list(b['sectionSelector']);
    const csv = (v: unknown) => String(v ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    return {
      slug: typeof b['slug'] === 'string' ? b['slug'] : undefined,
      name: String(b['name'] ?? ''),
      url: String(b['url'] ?? ''),
      industry: String(b['industry'] ?? ''),
      kind: (b['kind'] === 'own' ? 'own' : 'client') as SiteKind,
      permissionToName: b['permissionToName'] === 'on',
      recipe: {
        dismiss: csv(b['dismiss']),
        waitFor: csv(b['waitFor']),
        settleMs: Number(b['settleMs'] ?? 800) || 800,
        sections: names.map((name, i) => ({ name: name.trim(), selector: (selectors[i] ?? '').trim() })),
      },
    };
  };

  const quickForm = (v: { name?: string; url?: string; industry?: string; kind?: string; permissionToName?: boolean }, error?: string) => `<h1>Add a site</h1>
    ${error ? `<div class="warn">${esc(error)}</div>` : ''}
    <form method="post" class="card" style="max-width:640px">
      <label style="display:block;margin:12px 0"><b>Name</b><br><input name="name" value="${esc(v.name ?? '')}" required style="width:100%;padding:8px;font:inherit"></label>
      <label style="display:block;margin:12px 0"><b>URL</b><br><input type="url" name="url" value="${esc(v.url ?? 'https://')}" required style="width:100%;padding:8px;font:inherit"></label>
      <label style="display:block;margin:12px 0"><b>Industry</b><br><input name="industry" value="${esc(v.industry ?? '')}" placeholder="tile installation" style="width:100%;padding:8px;font:inherit"></label>
<fieldset style="border:0;padding:0;margin:12px 0"><b>Whose site is this?</b><br>
        <label><input type="radio" name="kind" value="client" ${v.kind !== 'own' ? 'checked' : ''}> A client's site</label> &nbsp;
        <label><input type="radio" name="kind" value="own" ${v.kind === 'own' ? 'checked' : ''}> Ours (Daedabyte)</label>
        <br><span class="muted">Our own sites are written about in the first person and never presented as a client or used for client proof points.</span></fieldset>
      <label style="display:block;margin:12px 0"><input type="checkbox" name="permissionToName" ${v.permissionToName ? 'checked' : ''}> <b>Client has agreed to be named in posts</b> <span class="muted">(ignored for our own sites)</span></label>
      <p class="muted">On save, the page is loaded once and its main sections are picked ${hasApiKey() ? 'by Claude' : 'by a heuristic (no ANTHROPIC_API_KEY set)'}. You can adjust the result afterwards with Edit recipe.</p>
      <div class="row"><button>Save and analyze</button><a class="btn secondary" href="/sites">Cancel</a><a class="muted" href="/sites/new/manual">Set up the recipe by hand instead</a></div>
    </form>`;

  app.get('/sites/new', (_req, res) => {
    res.send(page('Add a site', quickForm({}), '/sites'));
  });

  app.post(
    '/sites/new',
    wrap(async (req, res) => {
      const b = req.body as Record<string, unknown>;
      const v = { name: String(b['name'] ?? '').trim(), url: String(b['url'] ?? '').trim(), industry: String(b['industry'] ?? '').trim(), kind: (b['kind'] === 'own' ? 'own' : 'client') as SiteKind, permissionToName: b['permissionToName'] === 'on' };
      const slug = slugify(v.name);
      if (!v.name || !slug) {
        res.status(400).send(page('Add a site', quickForm(v, 'Site needs a name'), '/sites'));
        return;
      }
      try {
        new URL(v.url);
      } catch {
        res.status(400).send(page('Add a site', quickForm(v, `"${v.url}" is not a valid URL`), '/sites'));
        return;
      }
      const job = startJob('analyze', `Analyze ${v.name}`, async (log) => {
        log(`loading ${v.url}`);
        const ins = await inspectSite(v.url);
        log(`found ${ins.candidates.length} candidate blocks${ins.dismiss.length ? `, ${ins.dismiss.length} dismiss button(s)` : ''}`);
        const sug = await suggestRecipe(v, ins, log);
        const site = await saveSite({ ...v, slug, recipe: sug.recipe });
        await mkdir(siteDir(slug), { recursive: true });
        await writeFile(path.join(siteDir(slug), 'recipe-suggestion.json'), JSON.stringify({ at: new Date().toISOString(), source: sug.source, notes: sug.notes, inspection: ins, claude: sug.claude ?? null }, null, 2));
        log(`saved sites/${slug}.json with ${sug.recipe.sections.length} section(s): ${sug.recipe.sections.map((s) => s.name).join(', ')}`);
        return site;
      });
      res.redirect(`/jobs/${job.id}?next=/sites/${slug}?suggested=1`);
    }),
  );

  app.get('/sites/new/manual', (_req, res) => {
    res.send(page('Add a site', siteForm({}), '/sites'));
  });

  app.post(
    '/sites/new/manual',
    wrap(async (req, res) => {
      const input = siteFromForm(req.body as Record<string, unknown>);
      try {
        const site = await saveSite(input);
        res.redirect(`/sites/${site.slug}`);
      } catch (err) {
        res.status(400).send(page('Add a site', siteForm(input, (err as Error).message), '/sites'));
      }
    }),
  );

  app.get(
    '/sites/:slug/edit',
    wrap(async (req, res) => {
      const site = await loadSite(String(req.params['slug']));
      res.send(page(`Edit ${site.name}`, siteForm(site), '/sites'));
    }),
  );

  app.post(
    '/sites/:slug/edit',
    wrap(async (req, res) => {
      const slug = String(req.params['slug']);
      const input = { ...siteFromForm(req.body as Record<string, unknown>), slug };
      try {
        await saveSite(input);
        res.redirect(`/sites/${slug}`);
      } catch (err) {
        res.status(400).send(page('Edit site', siteForm({ ...input, slug }, (err as Error).message), '/sites'));
      }
    }),
  );

  app.get(
    '/sites/:slug',
    wrap(async (req, res) => {
      const slug = String(req.params['slug']);
      const m: Manifest | null = await readManifest(slug);
      const suggested = req.query['suggested'] === '1';
      let suggestion: { source: string; notes: string } | null = null;
      try {
        suggestion = JSON.parse(await readFile(path.join(siteDir(slug), 'recipe-suggestion.json'), 'utf8')) as { source: string; notes: string };
      } catch {
        // none
      }
      const site = await loadSite(slug);
      const banner = suggested && suggestion
        ? `<div class="warn">Recipe suggested by <b>${esc(suggestion.source)}</b>: ${esc(suggestion.notes)}<br><span class="muted">Sections: ${site.recipe.sections.map((x) => `<code>${esc(x.name)}</code> = <code>${esc(x.selector)}</code>`).join(' · ')}</span><br>Hit <b>Capture now</b> to check it, or <a href="/sites/${esc(slug)}/edit">Edit recipe</a>.</div>`
        : '';
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
          `<h1>${esc(site.name)} ${site.kind === 'own' ? '<span class="badge">OURS</span>' : ''}</h1>
          <div class="row"><form method="post" action="/sites/${esc(slug)}/capture"><button>Capture now</button></form><a class="btn secondary" href="/sites/${esc(slug)}/edit">Edit recipe</a><a class="btn secondary" href="/sites">Back</a></div>
          <div style="margin-top:18px">${banner}${body}</div>`,
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
