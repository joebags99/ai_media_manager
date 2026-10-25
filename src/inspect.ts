// inspect.ts: load a URL once and describe its large visible blocks so a capture recipe
// can be built from name + url alone. Claude picks and names the sections when an API
// key is present; otherwise a heuristic does it.

import { chromium, type Browser } from 'playwright';
import { askJson, hasApiKey } from './claude.js';
import type { SiteRecipe } from './sites.js';

export interface Candidate {
  i: number;
  selector: string;
  tag: string;
  id: string;
  classes: string;
  heading: string;
  text: string;
  top: number;
  width: number;
  height: number;
}

export interface Inspection {
  title: string;
  pageHeight: number;
  candidates: Candidate[];
  dismiss: string[];
}

export interface Suggestion {
  recipe: SiteRecipe;
  source: 'claude' | 'heuristic';
  notes: string;
  claude?: { request: unknown; response: unknown; costUsd: number };
}

const SECTION_NAMES = ['hero', 'services', 'about', 'work', 'testimonials', 'pricing', 'process', 'team', 'contact', 'cta', 'faq', 'footer'];

// Runs in the page. Returns up to 24 large visible blocks, top to bottom, each with a
// selector that is unique on the page.
const INSPECT_SCRIPT = String.raw`(() => {
  const vw = innerWidth;
  const isVisible = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > vw * 0.5 && r.height > 120;
  };
  const cssEscape = (s) => CSS.escape(s);
  const uniq = (sel) => document.querySelectorAll(sel).length === 1;
  const selectorFor = (el) => {
    if (el.id && uniq('#' + cssEscape(el.id))) return '#' + cssEscape(el.id);
    const tag = el.tagName.toLowerCase();
    const cls = [...el.classList].filter((c) => /^[a-zA-Z][\w-]*$/.test(c) && !/^(is-|js-|has-)/.test(c)).slice(0, 2);
    if (cls.length) {
      const s = tag + '.' + cls.map(cssEscape).join('.');
      if (uniq(s)) return s;
    }
    // Walk up until the path is unique.
    const parts = [];
    let cur = el;
    while (cur && cur !== document.body && parts.length < 5) {
      const t = cur.tagName.toLowerCase();
      const parent = cur.parentElement;
      const sib = parent ? [...parent.children].filter((c) => c.tagName === cur.tagName) : [cur];
      parts.unshift(sib.length > 1 ? t + ':nth-of-type(' + (sib.indexOf(cur) + 1) + ')' : t);
      const s = parts.join(' > ');
      if (uniq(s)) return s;
      if (uniq('body > ' + s)) return 'body > ' + s;
      cur = parent;
    }
    return parts.join(' > ');
  };
  const pool = [...document.querySelectorAll('header, nav, main, section, article, footer, aside, main > div, body > div, main > div > div, body > div > div, [class*="hero"], [class*="section"], [id*="hero"]')];
  const seen = new Set();
  const out = [];
  for (const el of pool) {
    if (seen.has(el) || !isVisible(el)) continue;
    // Skip wrappers that are just a single visible child of the same size.
    const r = el.getBoundingClientRect();
    const kids = [...el.children].filter(isVisible);
    if (kids.length === 1 && Math.abs(kids[0].getBoundingClientRect().height - r.height) < 40) continue;
    if (r.height > document.documentElement.scrollHeight * 0.85) continue; // the page itself
    seen.add(el);
    const h = el.querySelector('h1, h2, h3');
    out.push({
      i: out.length,
      selector: selectorFor(el),
      tag: el.tagName.toLowerCase(),
      id: el.id || '',
      classes: [...el.classList].slice(0, 4).join(' '),
      heading: h ? h.textContent.trim().replace(/\s+/g, ' ').slice(0, 80) : '',
      text: el.innerText.trim().replace(/\s+/g, ' ').slice(0, 160),
      top: Math.round(r.top + scrollY),
      width: Math.round(r.width),
      height: Math.round(r.height),
    });
  }
  out.sort((a, b) => a.top - b.top);
  out.forEach((c, i) => (c.i = i));

  const dismiss = [];
  for (const el of document.querySelectorAll('button, a, [role="button"]')) {
    const t = (el.textContent || '').trim();
    const box = el.closest('[class*="cookie"], [id*="cookie"], [class*="consent"], [id*="consent"], [class*="gdpr"], [class*="popup"], [class*="modal"], [class*="banner"]');
    if (box && /^(accept|accept all|agree|got it|ok|okay|close|dismiss|i agree|allow)/i.test(t)) {
      dismiss.push(selectorFor(el));
    }
  }
  return { title: document.title, pageHeight: document.documentElement.scrollHeight, candidates: out.slice(0, 24), dismiss: [...new Set(dismiss)].slice(0, 3) };
})()`;

export async function inspectSite(url: string, browser?: Browser): Promise<Inspection> {
  const b = browser ?? (await chromium.launch());
  try {
    const page = await b.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45_000 });
    await page.waitForTimeout(800);
    return (await page.evaluate(INSPECT_SCRIPT)) as Inspection;
  } finally {
    if (!browser) await b.close();
  }
}

const heuristicName = (c: Candidate, taken: Set<string>): string => {
  const t = `${c.id} ${c.classes} ${c.heading}`.toLowerCase();
  const order: [RegExp, string][] = [
    [/hero|banner|intro|masthead/, 'hero'],
    [/service|what we do|offer/, 'services'],
    [/testimonial|review|clients? say|quote/, 'testimonials'],
    [/portfolio|work|project|gallery|case/, 'work'],
    [/about|story|who we are/, 'about'],
    [/pricing|plans|packages/, 'pricing'],
    [/process|how it works|steps/, 'process'],
    [/team|people|staff/, 'team'],
    [/contact|get in touch|book|estimate|quote/, 'contact'],
    [/faq|question/, 'faq'],
  ];
  let name = order.find(([re]) => re.test(t))?.[1] ?? '';
  if (!name) name = taken.size === 0 ? 'hero' : `section-${c.i + 1}`;
  let n = name;
  for (let k = 2; taken.has(n); k++) n = `${name}-${k}`;
  return n;
};

function heuristicRecipe(ins: Inspection): SiteRecipe {
  const body = ins.candidates.filter((c) => !['header', 'nav', 'footer'].includes(c.tag) && !/nav|footer|cookie/i.test(c.classes + c.id));
  const picked = body.slice(0, 4);
  const taken = new Set<string>();
  const sections = picked.map((c) => {
    const name = heuristicName(c, taken);
    taken.add(name);
    return { name, selector: c.selector };
  });
  return { dismiss: ins.dismiss, waitFor: sections[0] ? [sections[0].selector] : [], settleMs: 800, sections };
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['sections', 'dismiss', 'notes'],
  properties: {
    sections: {
      type: 'array',
      minItems: 1,
      maxItems: 4,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['candidate', 'name'],
        properties: {
          candidate: { type: 'integer', description: 'index i of the candidate block' },
          name: { type: 'string', enum: SECTION_NAMES },
        },
      },
    },
    dismiss: { type: 'array', items: { type: 'string' }, description: 'selectors from the dismiss list worth clicking, usually all of them' },
    notes: { type: 'string', description: 'one sentence for the reviewer' },
  },
};

interface Pick {
  sections: { candidate: number; name: string }[];
  dismiss: string[];
  notes: string;
}

export async function suggestRecipe(site: { name: string; url: string; industry: string }, ins: Inspection, log: (s: string) => void): Promise<Suggestion> {
  if (ins.candidates.length === 0) throw new Error('No large visible blocks found on the page; add sections by hand');
  if (!hasApiKey()) {
    log('ANTHROPIC_API_KEY not set; using heuristic section names');
    return { recipe: heuristicRecipe(ins), source: 'heuristic', notes: 'Named by heuristic; review the selectors.' };
  }
  log(`asking Claude to pick sections from ${ins.candidates.length} candidates`);
  const result = await askJson<Pick>({
    system: `You help a web design agency pick which parts of a client's homepage to screenshot for social media ads. You receive a list of large visible blocks found on the page, top to bottom, and return the 2-4 most useful ones: the hero first, then the blocks that best show the client's services, work, or social proof. Skip navigation, footers, cookie banners, and near-duplicates. Name each one with the closest allowed name. Return only JSON.`,
    messages: [
      {
        role: 'user',
        content: `Site: ${site.name} (${site.industry || 'unknown industry'}) at ${site.url}\nPage title: ${ins.title}\nPage height: ${ins.pageHeight}px\n\nCandidate blocks:\n${JSON.stringify(ins.candidates, null, 1)}\n\nDismiss selector candidates (cookie/consent buttons): ${JSON.stringify(ins.dismiss)}`,
      },
    ],
    schema: SCHEMA,
    effort: 'low',
    maxTokens: 1024,
  });
  const byIndex = new Map(ins.candidates.map((c) => [c.i, c]));
  const taken = new Set<string>();
  const sections = result.data.sections
    .filter((s) => byIndex.has(s.candidate))
    .map((s) => {
      let name = s.name;
      for (let k = 2; taken.has(name); k++) name = `${s.name}-${k}`;
      taken.add(name);
      return { name, selector: byIndex.get(s.candidate)!.selector };
    });
  if (sections.length === 0) throw new Error('Claude picked no valid candidates');
  log(`Claude picked ${sections.map((s) => s.name).join(', ')} ($${result.costUsd.toFixed(4)})`);
  return {
    recipe: { dismiss: result.data.dismiss.filter((d) => ins.dismiss.includes(d)), waitFor: [sections[0]!.selector], settleMs: 800, sections },
    source: 'claude',
    notes: result.data.notes,
    claude: { request: result.request, response: result.response, costUsd: result.costUsd },
  };
}
