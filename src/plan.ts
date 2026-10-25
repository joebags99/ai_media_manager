// plan.ts: Claude recommends the week: one template + subject (+ optional site) per
// weekday. Saved to data/calendar.json and editable in the dashboard before generation.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { askJson, hasApiKey } from './claude.js';
import { DATA_DIR } from './config.js';
import { readManifest, type Manifest } from './capture.js';
import { listSites, type Site } from './sites.js';
import { recentDraftSummaries, SLOTS, type Slot } from './db.js';
import { loadBrand, type Brand } from './render.js';

export const CALENDAR_PATH = path.join(DATA_DIR, 'calendar.json');

export interface PlanDay {
  slot: Slot;
  template: 'list' | 'stat' | 'quote' | 'screenshot';
  subject: string;
  site: string | null;
  reason: string;
}

export interface Plan {
  weekOf: string;
  createdAt: string;
  source: 'claude' | 'default' | 'edited';
  days: PlanDay[];
  claude?: { request: unknown; response: unknown; costUsd: number } | null;
}

export interface SiteSummary {
  slug: string;
  name: string;
  kind: Site['kind'];
  industry: string;
  permissionToName: boolean;
  captured: boolean;
  sections: string[];
}

export async function siteSummaries(): Promise<SiteSummary[]> {
  const sites = await listSites();
  return Promise.all(
    sites.map(async (s) => {
      const m: Manifest | null = await readManifest(s.slug);
      return {
        slug: s.slug,
        name: s.name,
        kind: s.kind,
        industry: s.industry,
        permissionToName: s.permissionToName,
        captured: Boolean(m),
        sections: m ? [...new Set(m.shots.map((x) => x.section))] : [],
      };
    }),
  );
}

export async function readPlan(): Promise<Plan | null> {
  try {
    return JSON.parse(await readFile(CALENDAR_PATH, 'utf8')) as Plan;
  } catch {
    return null;
  }
}

export async function writePlan(plan: Plan): Promise<void> {
  await writeFile(CALENDAR_PATH, JSON.stringify(plan, null, 2));
}

function defaultPlan(weekOf: string, brand: Brand, sites: SiteSummary[]): Plan {
  const voice = brand['voice'] as { proofPoints: string[]; ctas: string[] };
  const client = sites.find((s) => s.kind === 'client' && s.captured) ?? null;
  const own = sites.find((s) => s.kind === 'own' && s.captured) ?? null;
  const withQuote = sites.find((s) => s.captured && s.sections.includes('testimonials')) ?? null;
  const days: PlanDay[] = [
    { slot: 'mon', template: 'list', subject: 'Four things a dated website costs a small business', site: null, reason: 'default rotation' },
    { slot: 'tue', template: 'stat', subject: voice.proofPoints[2] ?? 'A proof point', site: null, reason: 'default rotation' },
    { slot: 'wed', template: client ? 'screenshot' : own ? 'screenshot' : 'list', subject: client ? `Recent work: ${client.name}` : own ? 'How we build' : 'What a fast site feels like', site: (client ?? own)?.slug ?? null, reason: 'default rotation' },
    withQuote
      ? { slot: 'thu', template: 'quote', subject: `A testimonial from ${withQuote.name}`, site: withQuote.slug, reason: 'testimonials section captured' }
      : { slot: 'thu', template: 'stat', subject: voice.proofPoints[3] ?? 'Reply time', site: null, reason: 'no testimonials captured' },
    { slot: 'fri', template: 'list', subject: 'What to ask before hiring a web designer', site: null, reason: 'default rotation' },
  ];
  return { weekOf, createdAt: new Date().toISOString(), source: 'default', days, claude: null };
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['days'],
  properties: {
    days: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['slot', 'template', 'subject', 'site', 'reason'],
        properties: {
          slot: { type: 'string', enum: SLOTS },
          template: { type: 'string', enum: ['list', 'stat', 'quote', 'screenshot'] },
          subject: { type: 'string', description: 'one sentence brief for the copywriter' },
          site: { type: ['string', 'null'], description: 'site slug the post is about, or null' },
          reason: { type: 'string', description: 'one short sentence for the reviewer' },
        },
      },
    },
  },
};

export async function planWeek(weekOf: string, log: (s: string) => void = () => {}): Promise<Plan> {
  const brand = await loadBrand();
  const sites = await siteSummaries();
  if (!hasApiKey()) {
    log('ANTHROPIC_API_KEY not set; using the default rotation');
    return defaultPlan(weekOf, brand, sites);
  }
  const recent = recentDraftSummaries(15);
  const voice = brand['voice'] as Record<string, unknown>;
  const system = `You plan a week of social ads for ${brand.name} (${brand['tagline']}), a small web design studio. Pick one template and a one-sentence subject for each weekday, Monday to Friday.

Templates:
- list: four punchy one-word lines plus a short verdict. Good for pain points, checklists, contrasts.
- stat: one big number, a 3-5 word claim, a kicker. Use the studio's real proof points only: ${JSON.stringify(voice['proofPoints'])}.
- quote: a client testimonial. ONLY allowed for a site whose captured sections include "testimonials"; the copywriter will quote it verbatim from the screenshot.
- screenshot: a headline with one accent word over a crop of a real site. Needs a captured site.

Rules: vary templates across the week (no template three times, no two in a row), spread sites out, prefer sites not used recently. Sites of kind "own" are the studio's own site: posts about them speak in the first person and never present them as a client or attach client proof points. Client sites with permissionToName=false must stay anonymous in the subject. Keep subjects concrete and specific to the site or proof point. Return only JSON.`;
  const user = `Week of ${weekOf}.\n\nSites:\n${JSON.stringify(sites, null, 1)}\n\nRecent posts (avoid repeating):\n${JSON.stringify(recent, null, 1)}`;
  const r = await askJson<{ days: PlanDay[] }>({ system, messages: [{ role: 'user', content: user }], schema: SCHEMA, effort: 'medium', maxTokens: 2048 });
  const bySlot = new Map(r.data.days.map((d) => [d.slot, d]));
  const fallback = defaultPlan(weekOf, brand, sites);
  const known = new Set(sites.map((s) => s.slug));
  const days = SLOTS.map((slot) => {
    const d = bySlot.get(slot) ?? fallback.days.find((x) => x.slot === slot)!;
    const site = d.site && known.has(d.site) ? d.site : null;
    const sum = site ? sites.find((s) => s.slug === site) : null;
    let template = d.template;
    if (template === 'quote' && !(sum && sum.sections.includes('testimonials'))) template = 'stat';
    if (template === 'screenshot' && !(sum && sum.captured)) template = 'list';
    return { ...d, slot, site, template };
  });
  log(`Claude planned: ${days.map((d) => `${d.slot}=${d.template}`).join(' ')} ($${r.costUsd.toFixed(4)})`);
  return { weekOf, createdAt: new Date().toISOString(), source: 'claude', days, claude: { request: r.request, response: r.response, costUsd: r.costUsd } };
}
