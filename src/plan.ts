// plan.ts: Claude recommends the week: one template + subject (+ optional site) per
// weekday. Saved to data/calendar.json and editable in the dashboard before generation.
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { askJson, hasApiKey } from './claude.js';
import { DATA_DIR } from './config.js';
import { readManifest, type Manifest } from './capture.js';
import { listSites, type Site } from './sites.js';
import { recentDraftSummaries, slotDate, SLOTS, type Slot } from './db.js';
import { holidayOn, seasonFor, type Holiday } from './holidays.js';
import { loadBrand, type Brand } from './render.js';

// One plan per week: data/calendar/<weekOf>.json (the older single data/calendar.json is
// still read as a fallback for the week it names).
export const CALENDAR_DIR = path.join(DATA_DIR, 'calendar');
const LEGACY_PATH = path.join(DATA_DIR, 'calendar.json');
export const planPath = (weekOf: string) => path.join(CALENDAR_DIR, `${weekOf}.json`);

export type PlanTemplate = 'list' | 'stat' | 'quote' | 'screenshot' | 'none';

export interface PlanDay {
  slot: Slot;
  date?: string;
  /** "none" = no post that day (weekends by default). */
  template: PlanTemplate;
  subject: string;
  site: string | null;
  reason: string;
  /** Holiday falling on this date, if any. */
  holiday?: string | null;
  /** Seasonal theme to render with, from the holiday or the run-up to one. */
  theme?: string | null;
}

export function dayContext(weekOf: string, slot: Slot): { date: string; holiday: Holiday | null; theme: string | null } {
  const date = slotDate(weekOf, slot);
  const holiday = holidayOn(date);
  return { date, holiday, theme: holiday?.theme ?? seasonFor(date) };
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

export async function readPlan(weekOf: string): Promise<Plan | null> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekOf)) return null;
  try {
    return JSON.parse(await readFile(planPath(weekOf), 'utf8')) as Plan;
  } catch {
    try {
      const legacy = JSON.parse(await readFile(LEGACY_PATH, 'utf8')) as Plan;
      return legacy.weekOf === weekOf ? legacy : null;
    } catch {
      return null;
    }
  }
}

export async function listPlannedWeeks(): Promise<string[]> {
  try {
    return (await readdir(CALENDAR_DIR)).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map((f) => f.slice(0, 10)).sort().reverse();
  } catch {
    return [];
  }
}

export async function writePlan(plan: Plan): Promise<void> {
  await mkdir(CALENDAR_DIR, { recursive: true });
  await writeFile(planPath(plan.weekOf), JSON.stringify(plan, null, 2));
}

function defaultPlan(weekOf: string, brand: Brand, sites: SiteSummary[]): Plan {
  const voice = brand['voice'] as { proofPoints: string[]; ctas: string[] };
  const client = sites.find((s) => s.kind === 'client' && s.captured) ?? null;
  const own = sites.find((s) => s.kind === 'own' && s.captured) ?? null;
  const withQuote = sites.find((s) => s.kind === 'own' && s.captured && s.sections.includes('testimonials')) ?? null;
  const base: Record<Slot, Omit<PlanDay, 'slot' | 'date' | 'holiday' | 'theme'>> = {
    mon: { template: 'list', subject: 'Four things a dated website costs a small business', site: null, reason: 'default rotation' },
    tue: { template: 'stat', subject: voice.proofPoints[2] ?? 'A proof point', site: null, reason: 'default rotation' },
    wed: { template: client || own ? 'screenshot' : 'list', subject: client ? `Recent work: ${client.name}` : own ? 'How we build' : 'What a fast site feels like', site: (client ?? own)?.slug ?? null, reason: 'default rotation' },
    thu: withQuote ? { template: 'quote', subject: 'A client testimonial about us', site: withQuote.slug, reason: 'our testimonials section is captured' } : { template: 'stat', subject: voice.proofPoints[3] ?? 'Reply time', site: null, reason: 'no testimonials captured' },
    fri: { template: 'list', subject: 'What to ask before hiring a web designer', site: null, reason: 'default rotation' },
    sat: { template: 'none', subject: '', site: null, reason: 'weekend' },
    sun: { template: 'none', subject: '', site: null, reason: 'weekend' },
  };
  const days: PlanDay[] = SLOTS.map((slot) => {
    const ctx = dayContext(weekOf, slot);
    const d = { slot, ...base[slot], date: ctx.date, holiday: ctx.holiday?.name ?? null, theme: ctx.theme };
    if (ctx.holiday) {
      if (ctx.holiday.post && d.template === 'none') return { ...d, template: 'list', subject: `${ctx.holiday.name}: ${ctx.holiday.note}`, reason: `${ctx.holiday.name} falls on this day` };
      if (!ctx.holiday.post && d.template !== 'none') return { ...d, template: 'none', subject: '', site: null, reason: `${ctx.holiday.name}: no post (${ctx.holiday.note})` };
      return { ...d, subject: `${ctx.holiday.name}: ${d.subject}`, reason: `${ctx.holiday.name}` };
    }
    return d;
  });
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
          template: { type: 'string', enum: ['list', 'stat', 'quote', 'screenshot', 'none'], description: '"none" = no post that day' },
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
  const week = SLOTS.map((slot) => ({ slot, ...dayContext(weekOf, slot) }));
  const holidayLines = week.filter((d) => d.holiday).map((d) => `- ${d.slot} ${d.date}: ${d.holiday!.name}. ${d.holiday!.note}${d.holiday!.post ? '' : ' (no post)'}`);
  const seasonal = week.find((d) => d.theme && !d.holiday)?.theme ?? null;
  const system = `You plan a week of social ads for ${brand.name} (${brand['tagline']}), a small web design studio. The week runs Monday to Sunday. Pick one template and a one-sentence subject for each weekday, Monday to Friday. Saturday and Sunday are "none" (no post) unless a holiday worth posting on falls there.

Templates:
- list: four punchy one-word lines plus a short verdict. Good for pain points, checklists, contrasts.
- stat: one big number, a 3-5 word claim, a kicker. Use the studio's real proof points only: ${JSON.stringify(voice['proofPoints'])}.
- quote: a testimonial ABOUT THE STUDIO from one of its own clients. ONLY allowed with a site of kind "own" whose captured sections include "testimonials" (that is where the studio's client reviews live). Never use a client site's reviews: those are the client's customers talking about the client, not about us.
- screenshot: a headline with one accent word over a crop of a real site. Needs a captured site.

Every post is about what the studio does: its work (client sites as examples of our craft), its results (proof points), its clients' words about it. Never make a post about what a client's customers think of the client.
Holidays this week:
${holidayLines.length ? holidayLines.join('\n') : '- none'}
A day marked "(no post)" must be template "none". A holiday worth posting on gets a post that acknowledges it naturally in the subject (the copy will be rendered in that holiday's seasonal colors); keep it on-brand, no sales pitch on sombre days.${seasonal ? ` The week is in the run-up to a ${seasonal} theme; subjects may nod to the season.` : ''}
Rules: vary templates across the week (no template three times, no two in a row), spread sites out, prefer sites not used recently. Sites of kind "own" are the studio's own site: posts about them speak in the first person and never present them as a client or attach client proof points. Client sites with permissionToName=false must stay anonymous in the subject. Keep subjects concrete and specific to the site or proof point. Return only JSON.`;
  const user = `Week of ${weekOf}.\n\nSites:\n${JSON.stringify(sites, null, 1)}\n\nRecent posts (avoid repeating):\n${JSON.stringify(recent, null, 1)}`;
  const r = await askJson<{ days: PlanDay[] }>({ system, messages: [{ role: 'user', content: user }], schema: SCHEMA, effort: 'medium', maxTokens: 2048 });
  const bySlot = new Map(r.data.days.map((d) => [d.slot, d]));
  const fallback = defaultPlan(weekOf, brand, sites);
  const known = new Set(sites.map((s) => s.slug));
  const days: PlanDay[] = SLOTS.map((slot) => {
    const fb = fallback.days.find((x) => x.slot === slot)!;
    const d = bySlot.get(slot);
    const ctx = dayContext(weekOf, slot);
    if (!d) return fb;
    const site = d.site && known.has(d.site) ? d.site : null;
    const sum = site ? sites.find((s) => s.slug === site) : null;
    let template: PlanTemplate = d.template;
    if (ctx.holiday && !ctx.holiday.post) template = 'none';
    if (template === 'quote' && !(sum && sum.kind === 'own' && sum.sections.includes('testimonials'))) template = 'stat';
    if (template === 'screenshot' && !(sum && sum.captured)) template = 'list';
    return { slot, date: ctx.date, template, subject: template === 'none' ? '' : d.subject, site: template === 'none' ? null : site, reason: d.reason, holiday: ctx.holiday?.name ?? null, theme: ctx.theme };
  });
  log(`Claude planned: ${days.filter((d) => d.template !== 'none').map((d) => `${d.slot}=${d.template}`).join(' ')} ($${r.costUsd.toFixed(4)})`);
  return { weekOf, createdAt: new Date().toISOString(), source: 'claude', days, claude: { request: r.request, response: r.response, costUsd: r.costUsd } };
}
