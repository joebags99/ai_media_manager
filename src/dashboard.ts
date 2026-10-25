// dashboard.ts: Express app on localhost:3000. Review console for drafts and the operator
// console for every manual step: planning, site capture, template previews, the weekly run,
// publishing. Plain HTML, no client framework. Routes for drafts/plan live in
// dashboard/drafts.ts, Buffer in dashboard/buffer.ts, shared design in dashboard/html.ts.

import express, { type Request, type Response, type NextFunction } from 'express';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { DASHBOARD_PORT, FIXTURES_DIR, RENDERS_DIR, ROOT, SCREENSHOTS_DIR, TEST_MODE } from './config.js';
import { captureSite, readManifest, siteDir, type Manifest } from './capture.js';
import { listSites, loadSite, saveSite, slugify, type Site, type SiteKind } from './sites.js';
import { inspectSite, suggestRecipe } from './inspect.js';
import { hasApiKey } from './claude.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { renderDraft, type RenderInput } from './render.js';
import { getJob, recentJobs, startJob } from './jobs.js';
import { badge, empty, esc, jobView, layout, notice, pageHead, section } from './dashboard/html.js';
import { registerDraftRoutes } from './dashboard/drafts.js';
import { registerBufferRoutes } from './dashboard/buffer.js';

let iconSvg = '';
async function loadIcon(): Promise<string> {
  if (iconSvg) return iconSvg;
  try {
    iconSvg = (await readFile(path.join(ROOT, 'brand', 'assets', 'icon.svg'), 'utf8')).replace(/<\?xml[^>]*\?>/, '').replace(/<!--[\s\S]*?-->/g, '').trim();
  } catch {
    iconSvg = '';
  }
  return iconSvg;
}

const page = (title: string, body: string, active: string) => layout(title, body, { testMode: TEST_MODE, active, icon: iconSvg });
const wrap = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

const TEMPLATE_HELP: Record<string, string> = {
  list: 'Four accent-colored words and a white verdict. Pain points, checklists, contrasts.',
  stat: 'A gold number, a 3–5 word claim, an orange kicker. Proof points only.',
  quote: 'A client of ours, quoted verbatim from our own testimonials section.',
  screenshot: 'A headline with one orange word over a crop of a site we built.',
};

export function createApp(): express.Express {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use('/brand', express.static(path.join(ROOT, 'brand', 'assets')));
  app.use('/screenshots', express.static(SCREENSHOTS_DIR));
  app.use((_req, _res, next) => {
    loadIcon().then(() => next(), next);
  });

  // Buffer fetches post images from PUBLIC_BASE_URL/renders/<file>; the index exists so the
  // tunnel can be checked from a browser.
  app.get(
    '/renders/',
    wrap(async (_req, res) => {
      let files: string[] = [];
      try {
        files = (await readdir(RENDERS_DIR)).filter((f) => f.endsWith('.png')).sort();
      } catch {
        // nothing rendered yet
      }
      res.send(page('Renders', pageHead('Renders', `${files.length} file(s). Buffer downloads post images from here.`) + `<ul>${files.map((f) => `<li><a href="/renders/${esc(f)}">${esc(f)}</a></li>`).join('')}</ul>`, ''));
    }),
  );
  app.use('/renders', express.static(RENDERS_DIR));

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
      const v = Date.now();
      const cards = await Promise.all(
        fixtures.map(async (f) => {
          const input = JSON.parse(await readFile(path.join(FIXTURES_DIR, f), 'utf8')) as RenderInput;
          const img = (file: string, label: string) =>
            rendered.includes(file)
              ? `<a href="/renders/${file}?t=${v}" target="_blank" title="${esc(label)}"><img src="/renders/${file}?t=${v}" alt="${esc(label)}"></a>`
              : `<div class="muted" style="padding:30px 0;text-align:center">${esc(label)}: not rendered yet</div>`;
          return `<div class="card tight"><div class="row" style="justify-content:space-between"><b style="font-family:var(--display)">${esc(input.template)}</b><span class="muted">${esc(input.id)}</span></div>
            <p class="hint" style="margin:4px 0 10px">${esc(TEMPLATE_HELP[input.template] ?? '')}</p>
            <div class="grid" style="grid-template-columns:1fr 1fr;gap:10px">${img(`${input.id}-square.png`, '1080×1080')}${img(`${input.id}-portrait.png`, '1080×1350')}</div>
            <details style="margin-top:10px"><summary>fixture text</summary><pre class="muted">${esc(JSON.stringify(input.slots, null, 2))}</pre></details></div>`;
        }),
      );
      res.send(
        page(
          'Templates',
          pageHead(
            'Templates',
            'The four fixed layouts every ad is rendered from. Colors, fonts and spacing come from <code>brand/brand.json</code>; Claude only fills the words. Edit <code>templates/*.html</code>, then re-render to check.',
            `<form method="post" action="/templates/render"><button class="secondary">Re-render fixtures</button></form>`,
          ) + `<div class="grid wide">${cards.join('')}</div>`,
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

  // ---- Sites -----------------------------------------------------------------------
  const kindCell = (s: Site) => (s.kind === 'own' ? badge('own', 'Ours') : s.permissionToName ? '<span>Client · may be named</span>' : '<span class="muted">Client · anonymous</span>');

  app.get(
    '/sites',
    wrap(async (req, res) => {
      const showFixtures = req.query['all'] === '1';
      const all = await listSites();
      const fixtures = all.filter((s) => s.url.startsWith('file://'));
      const sites = showFixtures ? all : all.filter((s) => !s.url.startsWith('file://'));
      const rows = await Promise.all(
        sites.map(async (s) => {
          const m = await readManifest(s.slug);
          const age = m ? Math.round((Date.now() - Date.parse(m.capturedAt)) / 86_400_000) : null;
          const capture = m
            ? `${m.shots.length} shots · ${age === 0 ? 'today' : `${age} day(s) ago`}${age !== null && age > 7 ? ' <span class="muted">(stale, re-captured on next run)</span>' : ''}${m.warnings.length ? ` · <span class="status-error">${m.warnings.length} warning(s)</span>` : ''}`
            : '<span class="muted">never captured</span>';
          return `<tr><td><a href="/sites/${s.slug}" style="color:var(--ink);font-weight:600;text-decoration:none">${esc(s.name)}</a><br><span class="muted">${esc(s.url)}</span></td>
            <td>${kindCell(s)}</td><td>${capture}</td>
            <td style="text-align:right"><form method="post" action="/sites/${s.slug}/capture" class="inline"><button class="secondary small">Capture</button></form></td></tr>`;
        }),
      );
      const body =
        pageHead(
          'Sites',
          'Each site has a recipe: which sections to screenshot at desktop (1440) and mobile (390). Screenshots feed the screenshot and stat templates and let Claude see the work. Captures older than 7 days are refreshed by the weekly run.',
          `<a class="btn primary" href="/sites/new">Add a site</a>`,
        ) +
        (sites.length
          ? `<table><tr><th>Site</th><th>Kind</th><th>Last capture</th><th></th></tr>${rows.join('')}</table>`
          : empty('No sites yet', 'Add your own site first, then client sites you have built.', '<a class="btn primary" href="/sites/new">Add a site</a>')) +
        (fixtures.length ? `<p class="hint" style="margin-top:12px">${showFixtures ? `<a href="/sites">Hide</a> the ${fixtures.length} local test fixture(s) used by the test suite.` : `<a href="/sites?all=1">Show</a> the ${fixtures.length} local test fixture(s) used by the test suite.`}</p>` : '');
      res.send(page('Sites', body, '/sites'));
    }),
  );

  const fullForm = (site: Partial<Site>, error?: string) => {
    const r = site.recipe ?? { sections: [] };
    const sections = [...r.sections, ...Array.from({ length: Math.max(0, 4 - r.sections.length) }, () => ({ name: '', selector: '' }))];
    const field = (label: string, name: string, value: string, hint = '', type = 'text') =>
      `<label class="field"><b>${label}</b><input type="${type}" name="${name}" value="${esc(value)}">${hint ? `<span class="hint">${hint}</span>` : ''}</label>`;
    return (
      pageHead(site.slug ? `Edit ${esc(site.name ?? site.slug)}` : 'Add a site by hand', 'Name the sections and give a CSS selector for each. The first visible match is screenshotted at both widths; the top of the page is always captured too.') +
      (error ? notice('bad', esc(error)) : '') +
      `<form method="post" class="card" style="max-width:800px">
      ${site.slug ? `<input type="hidden" name="slug" value="${esc(site.slug)}">` : ''}
      ${field('Name', 'name', site.name ?? '', 'Shown in the dashboard; the file name is derived from it.')}
      ${field('URL', 'url', site.url ?? 'https://', '', 'url')}
      ${field('Industry', 'industry', site.industry ?? '', 'One or two words, e.g. "tile installation". Claude uses it for context.')}
      ${kindRadio(site.kind)}
      <label class="field"><input type="checkbox" name="permissionToName" ${site.permissionToName ? 'checked' : ''}> <b style="display:inline">Client has agreed to be named in posts</b><br><span class="hint">Unchecked: copy stays anonymous ("a local tile installer"). Ignored for our own sites.</span></label>
      <h3 style="margin-top:22px">Sections to capture</h3>
      <table style="margin-top:8px">${sections.map((sec) => `<tr><td style="width:30%"><input name="sectionName" value="${esc(sec.name)}" placeholder="hero" style="width:100%"></td><td><input name="sectionSelector" value="${esc(sec.selector)}" placeholder="main section:first-of-type" style="width:100%"></td></tr>`).join('')}</table>
      <h3 style="margin-top:22px">Advanced</h3>
      ${field('Dismiss selectors', 'dismiss', (r.dismiss ?? []).join(', '), 'Comma-separated. Clicked if visible (cookie banners, popups).')}
      ${field('Wait for selectors', 'waitFor', (r.waitFor ?? []).join(', '), 'Comma-separated. Capture waits until these exist.')}
      ${field('Settle time (ms)', 'settleMs', String(r.settleMs ?? 800), 'Pause after load for animations.', 'number')}
      <div class="row" style="margin-top:18px"><button class="primary">Save</button><a class="btn secondary" href="${site.slug ? `/sites/${site.slug}` : '/sites'}">Cancel</a></div>
    </form>`
    );
  };

  const kindRadio = (kind?: string) => `<fieldset class="field" style="border:0;padding:0"><b>Whose site is this?</b>
    <label style="margin-right:16px"><input type="radio" name="kind" value="client" ${kind !== 'own' ? 'checked' : ''}> A client's site</label>
    <label><input type="radio" name="kind" value="own" ${kind === 'own' ? 'checked' : ''}> Ours (Daedabyte)</label>
    <span class="hint" style="display:block">Our own sites are written about in the first person and never presented as a client. Our testimonials section is the only source for quote posts.</span></fieldset>`;

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

  const quickForm = (v: { name?: string; url?: string; industry?: string; kind?: string; permissionToName?: boolean }, error?: string) =>
    pageHead('Add a site', `Name, URL and industry are enough. On save the page is loaded once and its main sections are picked ${hasApiKey() ? 'by Claude' : 'by a heuristic (no ANTHROPIC_API_KEY set)'}. You can adjust the result afterwards.`) +
    (error ? notice('bad', esc(error)) : '') +
    `<form method="post" class="card" style="max-width:640px">
      <label class="field"><b>Name</b><input name="name" value="${esc(v.name ?? '')}" required></label>
      <label class="field"><b>URL</b><input type="url" name="url" value="${esc(v.url ?? 'https://')}" required></label>
      <label class="field"><b>Industry</b><input name="industry" value="${esc(v.industry ?? '')}" placeholder="tile installation"></label>
      ${kindRadio(v.kind)}
      <label class="field"><input type="checkbox" name="permissionToName" ${v.permissionToName ? 'checked' : ''}> <b style="display:inline">Client has agreed to be named in posts</b> <span class="hint">(ignored for our own sites)</span></label>
      <div class="row" style="margin-top:6px"><button class="primary">Save and analyze</button><a class="btn secondary" href="/sites">Cancel</a><a class="hint" href="/sites/new/manual">Set up the recipe by hand instead</a></div>
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
    res.send(page('Add a site', fullForm({}), '/sites'));
  });

  app.post(
    '/sites/new/manual',
    wrap(async (req, res) => {
      const input = siteFromForm(req.body as Record<string, unknown>);
      try {
        const site = await saveSite(input);
        res.redirect(`/sites/${site.slug}`);
      } catch (err) {
        res.status(400).send(page('Add a site', fullForm(input, (err as Error).message), '/sites'));
      }
    }),
  );

  app.get(
    '/sites/:slug/edit',
    wrap(async (req, res) => {
      const site = await loadSite(String(req.params['slug']));
      res.send(page(`Edit ${site.name}`, fullForm(site), '/sites'));
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
        res.status(400).send(page('Edit site', fullForm({ ...input, slug }, (err as Error).message), '/sites'));
      }
    }),
  );

  app.get(
    '/sites/:slug',
    wrap(async (req, res) => {
      const slug = String(req.params['slug']);
      const site = await loadSite(slug);
      const m: Manifest | null = await readManifest(slug);
      const suggested = req.query['suggested'] === '1';
      let suggestion: { source: string; notes: string } | null = null;
      try {
        suggestion = JSON.parse(await readFile(path.join(siteDir(slug), 'recipe-suggestion.json'), 'utf8')) as { source: string; notes: string };
      } catch {
        // none
      }
      const banner = suggested && suggestion ? notice('info', `Recipe suggested by <b>${esc(suggestion.source)}</b>: ${esc(suggestion.notes)}<br><span class="muted">${site.recipe.sections.map((x) => `<code>${esc(x.name)}</code> = <code>${esc(x.selector)}</code>`).join(' · ')}</span><br>Press <b>Capture now</b> to check it, or <a href="/sites/${esc(slug)}/edit">edit the recipe</a>.`) : '';
      const shots = m
        ? `${m.warnings.map((w) => notice('warn', esc(w))).join('')}
           <div class="grid">${m.shots.map((s) => `<div class="card tight"><a href="/screenshots/${slug}/${s.file}" target="_blank"><img src="/screenshots/${slug}/${s.file}" alt="${esc(s.section)} ${s.viewport}"></a><div style="margin-top:8px"><b>${esc(s.section)}</b> <span class="muted">${s.viewport} · ${s.width}×${s.height}</span></div></div>`).join('')}</div>
           <details style="margin-top:18px"><summary>manifest.json</summary><pre class="muted">${esc(JSON.stringify(m, null, 2))}</pre></details>`
        : empty('Not captured yet', 'Capture takes the recipe sections at desktop and mobile widths.', `<form method="post" action="/sites/${esc(slug)}/capture"><button class="primary">Capture now</button></form>`);
      const body =
        pageHead(
          `${esc(site.name)} ${site.kind === 'own' ? badge('own', 'Ours') : ''}`,
          `${esc(site.url)} · ${esc(site.industry || 'no industry set')} · ${site.kind === 'own' ? 'our own site' : site.permissionToName ? 'client, may be named' : 'client, kept anonymous'}${m ? ` · captured ${esc(m.capturedAt.slice(0, 16).replace('T', ' '))}` : ''}`,
          `<form method="post" action="/sites/${esc(slug)}/capture" class="inline"><button class="primary">Capture now</button></form><a class="btn secondary" href="/sites/${esc(slug)}/edit">Edit recipe</a><a class="btn secondary" href="/sites">All sites</a>`,
          'Site',
        ) +
        banner +
        section('Screenshots', m ? `${m.shots.length} shots. These are what Claude sees and what the screenshot template crops from.` : '', shots);
      res.send(page(site.name, body, '/sites'));
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
      .map((j) => `<tr><td><a href="/jobs/${j.id}">${esc(j.label)}</a></td><td class="status-${j.status}">${j.status}</td><td class="muted">${esc(j.startedAt.slice(11, 19))}</td><td class="muted">${esc(j.error ?? '')}</td></tr>`)
      .join('');
    res.send(page('Jobs', pageHead('Jobs', 'Everything that ran since the dashboard started: captures, plans, generation, renders, publishes. Logs are kept in memory until restart.') + (rows ? `<table><tr><th>Job</th><th>Status</th><th>Started</th><th>Error</th></tr>${rows}</table>` : empty('Nothing has run yet', 'Jobs appear here as you capture, plan, generate and publish.')), '/jobs'));
  });

  app.get('/jobs/:id', (req, res) => {
    const job = getJob(String(req.params['id']));
    if (!job) {
      res.status(404).send(page('Job', pageHead('Unknown job', ''), '/jobs'));
      return;
    }
    const next = typeof req.query['next'] === 'string' ? req.query['next'] : '/jobs';
    res.send(page(job.label, pageHead(esc(job.label), 'Live log. You will be sent back automatically when it finishes.', `<a class="btn secondary" href="${esc(next)}">Back</a>`, 'Running') + jobView(job.id, next), '/jobs'));
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
    res.status(500).send(page('Error', pageHead('Something broke', 'The error below is from the server. The job log, if any, has more.') + `<pre class="log">${esc(err.stack ?? err.message)}</pre>`, ''));
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
