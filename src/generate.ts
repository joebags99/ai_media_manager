// generate.ts: one Claude call per post. System prompt = brand.json (voice, colors,
// hashtags, platform rules) + the template's slot schema + the plan subject. User turn =
// up to 6 screenshots as images + a manifest describing each. Strict JSON back, validated
// against claudeContract.validation, one repair turn on failure, then a pending draft row.
//
// SDK usage checked against docs.claude.com on 2026-10-25 (see src/claude.ts).

import path from 'node:path';
import { askJson, imageBlock, type ContentBlock, type JsonCall, type JsonResult, type MessageParam } from './claude.js';
import { readManifest, siteDir, type Manifest } from './capture.js';
import { insertDraft, type Draft } from './db.js';
import type { PlanDay } from './plan.js';
import { loadBrand, type Brand } from './render.js';
import { loadSite, type Site } from './sites.js';
import { validateContent, HEADLINE_SLOTS, type DraftContent, type ShotDims } from './validate.js';

export type Ask = <T>(call: JsonCall) => Promise<JsonResult<T>>;

export const MAX_IMAGES = 6;

const RESPONSE_SCHEMA = (template: string, slots: string[]) => ({
  type: 'object',
  additionalProperties: false,
  required: ['template', 'slots', 'crop', 'captions', 'hashtags', 'rationale'],
  properties: {
    template: { type: 'string', enum: [template] },
    slots: {
      type: 'object',
      additionalProperties: false,
      required: slots,
      properties: Object.fromEntries(slots.map((s) => [s, { type: 'string' }])),
    },
    crop: {
      type: 'object',
      additionalProperties: false,
      required: ['screenshot', 'region', 'treatment'],
      properties: {
        screenshot: { type: ['string', 'null'], description: 'filename of one provided screenshot, or null' },
        region: { type: ['array', 'null'], items: { type: 'integer' }, description: '[x, y, w, h] in that screenshot\'s pixels, or null for the whole image' },
        treatment: { type: 'string', enum: ['framed', 'dimmed'] },
      },
    },
    captions: {
      type: 'object',
      additionalProperties: false,
      required: ['instagram', 'facebook', 'linkedin', 'googlebusiness'],
      properties: { instagram: { type: 'string' }, facebook: { type: 'string' }, linkedin: { type: 'string' }, googlebusiness: { type: 'string' } },
    },
    hashtags: {
      type: 'object',
      additionalProperties: false,
      required: ['instagram', 'facebook', 'linkedin'],
      properties: { instagram: { type: 'array', items: { type: 'string' } }, facebook: { type: 'array', items: { type: 'string' } }, linkedin: { type: 'array', items: { type: 'string' } } },
    },
    rationale: { type: 'string', description: 'one sentence shown to the reviewer' },
  },
});

const TEMPLATE_NOTES: Record<string, string> = {
  list: 'Four one-word lines (line1-line4), each a single word with a period, e.g. "Slow." Then a verdict of 3-5 words that resolves them. The four words are set in brand accent colors, the verdict in white.',
  stat: 'number: a short figure like "40%" or "24h" taken from the proof points. claim: 3-5 words in white. kicker: a short CTA or qualifier in orange caps. Set crop.treatment "dimmed" with a screenshot to put a dim site behind the number, or leave crop.screenshot null for a plain ink background.',
  quote: 'The testimonial is a client of OURS talking about OUR work, copied verbatim from the testimonials screenshot of our own site (under 30 words; trim to whole sentences, never invent or paraphrase). name: the reviewer\'s name exactly as shown (first name + initial is fine). business: their business as shown, or their industry if not shown.',
  screenshot: 'headline: 3-5 words, one of which is accentWord (copied exactly from the headline) and set in orange. crop: pick the screenshot and a region [x, y, w, h] showing the most convincing part of the site; "framed" puts it in a browser frame, "dimmed" uses it as a dim full-bleed background.',
};

export function buildSystemPrompt(brand: Brand, template: string): string {
  const b = brand as unknown as Record<string, unknown>;
  const voice = b['voice'] as { sentences: string; headlineWords: [number, number]; banned: string[]; ctas: string[]; proofPoints: string[] };
  const platforms = b['platforms'] as Record<string, { hashtags: [number, number]; link: string }>;
  const hashtags = b['hashtags'] as Record<string, string[]>;
  const slots = brand.templates[template]!.slots.filter((s) => s !== 'crop');
  return `You write social ads for ${brand.name}: "${b['tagline']}". Site: ${brand.site}. Contact: ${b['contact']}.

VOICE
- Sentences: ${voice.sentences}
- Headline length: ${voice.headlineWords[0]}-${voice.headlineWords[1]} words (applies to ${Object.entries(HEADLINE_SLOTS).map(([t, s]) => `${t}.${s}`).join(', ')}).
- Never use: ${voice.banned.map((w) => JSON.stringify(w)).join(', ')}. No exclamation marks anywhere, no emoji.
- CTAs to reuse: ${voice.ctas.join(' | ')}
- Proof points you may cite (never invent others): ${voice.proofPoints.join(' | ')}
- Plain, confident, specific. No hype, no "we're thrilled".

TEMPLATE: ${template}
Slots (all required, non-empty strings): ${slots.join(', ')}.
${TEMPLATE_NOTES[template]}

CAPTIONS
- instagram: 2-4 short sentences, ${platforms['instagram']!.hashtags[0]}-${platforms['instagram']!.hashtags[1]} hashtags listed separately in hashtags.instagram (not in the caption). Link goes in bio, so you may say "link in bio".
- facebook: 1-3 sentences, may include the URL inline, ${platforms['facebook']!.hashtags[0]}-${platforms['facebook']!.hashtags[1]} hashtags.
- linkedin: 2-4 sentences, slightly more professional, URL inline allowed, ${platforms['linkedin']!.hashtags[0]}-${platforms['linkedin']!.hashtags[1]} hashtags.
- googlebusiness: 1-2 sentences, NO hashtags, never say "link in bio" (there is a button).
Hashtags: always include ${hashtags['always']!.join(' ')}; add from region ${hashtags['region']!.join(' ')} and service ${hashtags['service']!.join(' ')} as fits. Each must start with # and contain only letters, digits, underscores.

SITES
- A site of kind "own" is the studio's own: write in the first person ("our site", "we build"), never call it a client, never attach client proof points to it.
- A client site with permissionToName=false must not be named anywhere; describe it by industry ("a local tile installer").
- Screenshots are provided as images with filenames. crop.screenshot must be one of those filenames; crop.region is in that image's pixels and must fit inside it.

CROPS (framed treatment)
- Use the full width of the screenshot: x = 0 and w = the image width, unless a narrower crop is clearly better.
- Choose y and h so every text block and image inside the region is whole: never cut through a headline, paragraph, button or photo. Leave 24-40px of breathing room above and below.
- Keep the region's aspect ratio between 4:3 and 2:1 so it fits the frame at a readable size; for a tall section, pick its most convincing part rather than squeezing all of it in.
- Prefer the hero or a section with a clear headline and one strong image.

EVERY POST IS ABOUT US
- Posts show what ${brand.name} does: our work (client sites as examples of our craft, in our words), our results (the proof points), our clients' words about us. Never make a post about what a client's customers think of the client.

Return only the JSON object.`;
}

export interface GenerateInput {
  weekOf: string;
  day: PlanDay;
  feedback?: string | null;
}

export interface GenerateOptions {
  ask?: Ask;
  log?: (s: string) => void;
}

export interface Generated {
  content: DraftContent;
  context: MessageParam[];
  calls: { request: unknown; response: unknown; costUsd: number }[];
  costUsd: number;
  site: Site | null;
}

/** Stored context keeps image blocks as {type:"image_ref", file} markers instead of base64. */
export type StoredBlock = { type: 'image_ref'; file: string } | ContentBlock;
export type StoredMessage = { role: MessageParam['role']; content: string | StoredBlock[] };

export function dehydrate(messages: MessageParam[]): StoredMessage[] {
  return messages.map((m) => ({
    role: m.role,
    content:
      typeof m.content === 'string' || !m.content
        ? String(m.content ?? '')
        : m.content.map((b, i, all) => {
            if (b.type !== 'image') return b;
            // The text block just before each image names its file ("Image: hero-desktop.png").
            const prev = all[i - 1];
            const file = prev && prev.type === 'text' ? /^Image: (.+)$/.exec(prev.text)?.[1] ?? '' : '';
            return { type: 'image_ref' as const, file };
          }),
  }));
}

export async function hydrate(messages: StoredMessage[], siteSlug: string | null): Promise<MessageParam[]> {
  return Promise.all(
    messages.map(async (m) => ({
      role: m.role,
      content:
        typeof m.content === 'string'
          ? m.content
          : await Promise.all(m.content.map(async (b) => (b.type === 'image_ref' ? await imageBlock(path.join(siteDir(siteSlug!), b.file)) : b))),
    })),
  ) as Promise<MessageParam[]>;
}

/** Choose up to MAX_IMAGES shots: desktop sections first, then the page tops. */
export function pickShots(m: Manifest, template: string): Manifest['shots'] {
  const sections = m.shots.filter((s) => s.section !== 'page');
  const pages = m.shots.filter((s) => s.section === 'page');
  const ordered = [
    ...sections.filter((s) => s.viewport === 'desktop' && (template !== 'quote' || s.section === 'testimonials')),
    ...sections.filter((s) => s.viewport === 'desktop'),
    ...pages.filter((s) => s.viewport === 'desktop'),
    ...pages.filter((s) => s.viewport === 'mobile'),
    ...sections.filter((s) => s.viewport === 'mobile'),
  ];
  const seen = new Set<string>();
  return ordered.filter((s) => (seen.has(s.file) ? false : (seen.add(s.file), true))).slice(0, MAX_IMAGES);
}

export async function generateContent(input: GenerateInput, opts: GenerateOptions = {}): Promise<Generated> {
  const ask = opts.ask ?? (askJson as Ask);
  const log = opts.log ?? (() => {});
  const brand = await loadBrand();
  const { day } = input;
  const template = day.template;
  const slots = brand.templates[template]!.slots.filter((s) => s !== 'crop');

  let site: Site | null = null;
  let manifest: Manifest | null = null;
  if (day.site) {
    site = await loadSite(day.site);
    manifest = await readManifest(day.site);
    if (!manifest) throw new Error(`Site "${day.site}" has no capture yet`);
  }
  if (template === 'quote') {
    if (!site || site.kind !== 'own') throw new Error('quote template needs one of our own sites (testimonials about us), not a client site');
    if (!manifest!.shots.some((s) => s.section === 'testimonials')) throw new Error(`quote template needs a captured "testimonials" section on ${site.slug}`);
  }
  const shots = manifest ? pickShots(manifest, template) : [];
  const dims: ShotDims = Object.fromEntries(shots.map((s) => [s.file, { width: s.width, height: s.height }]));

  const lines = [`Week of ${input.weekOf}, ${day.slot.toUpperCase()} post.`, `Subject: ${day.subject}`];
  if (site) {
    lines.push(`Site: ${site.kind === 'own' ? `OUR OWN site, ${site.name}` : site.permissionToName ? `client "${site.name}"` : `an anonymous client (${site.industry || 'small business'}; do not name them)`} (${site.industry}).`);
    lines.push(`Screenshots (filename: section, viewport, width x height):`);
    for (const s of shots) lines.push(`- ${s.file}: ${s.section}, ${s.viewport}, ${s.width}x${s.height}`);
  } else {
    lines.push('No site for this post; crop.screenshot must be null.');
  }
  if (input.feedback) lines.push(`\nReviewer feedback on the previous version (address it directly):\n${input.feedback}`);
  const content: ContentBlock[] = [{ type: 'text', text: lines.join('\n') }];
  for (const s of shots) {
    content.push({ type: 'text', text: `Image: ${s.file}` });
    content.push(await imageBlock(path.join(siteDir(day.site!), s.file)));
  }

  const system = buildSystemPrompt(brand, template);
  const messages: MessageParam[] = [{ role: 'user', content }];
  const schema = RESPONSE_SCHEMA(template, slots);
  const calls: Generated['calls'] = [];

  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = await ask<DraftContent>({ system, messages, schema, effort: 'medium', maxTokens: 4096 });
    calls.push({ request: r.request, response: r.response, costUsd: r.costUsd });
    const errors = validateContent(brand, r.data, dims, template);
    messages.push({ role: 'assistant', content: JSON.stringify(r.data) });
    if (errors.length === 0) {
      log(`${day.slot}: valid on attempt ${attempt} ($${r.costUsd.toFixed(4)})`);
      return { content: r.data, context: messages, calls, costUsd: calls.reduce((a, c) => a + c.costUsd, 0), site };
    }
    log(`${day.slot}: attempt ${attempt} failed validation: ${errors.join('; ')}`);
    if (attempt === 2) throw new Error(`Draft failed validation twice: ${errors.join('; ')}`);
    messages.push({ role: 'user', content: `Fix these problems and return the full JSON again:\n- ${errors.join('\n- ')}` });
  }
  throw new Error('unreachable');
}

/** Generate and store a pending draft (no render yet). */
export async function generateDraft(input: GenerateInput, opts: GenerateOptions = {}): Promise<{ draft: Draft; generated: Generated }> {
  const g = await generateContent(input, opts);
  const draft = insertDraft({
    weekOf: input.weekOf,
    slot: input.day.slot,
    site: input.day.site,
    template: input.day.template,
    contentJson: JSON.stringify(g.content),
    generationContext: JSON.stringify({ plan: input.day, messages: dehydrate(g.context), calls: g.calls }),
    costUsd: g.costUsd,
    feedback: input.feedback ?? null,
  });
  return { draft, generated: g };
}
