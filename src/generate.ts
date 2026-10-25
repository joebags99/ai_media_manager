// generate.ts: one Claude call per post. System prompt = brand.json (voice, colors,
// hashtags, platform rules) + the template's slot schema + the plan subject. User turn =
// up to 6 screenshots as images + a manifest describing each. Strict JSON back, validated
// against claudeContract.validation, one repair turn on failure, then a pending draft row.
//
// SDK usage checked against docs.claude.com on 2026-10-25 (see src/claude.ts).

import path from 'node:path';
import { askJson, imageBlock, type ContentBlock, type JsonCall, type JsonResult, type MessageParam } from './claude.js';
import { readManifest, siteDir, type Manifest } from './capture.js';
import { getDraft, insertDraft, recentDraftSummaries, updateDraft, type Draft } from './db.js';
import type { PlanDay } from './plan.js';
import { loadBrand, type Brand } from './render.js';
import { loadSite, type Site } from './sites.js';
import { validateContent, keyLine, similarity, HEADLINE_SLOTS, type DraftContent, type ShotDims } from './validate.js';
import { listReviews, type Review } from './reviews.js';

export type Ask = <T>(call: JsonCall) => Promise<JsonResult<T>>;

export const MAX_IMAGES = 6;

export const responseSchema = (template: string, slots: string[]) => ({
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
  contrast: 'leftLabel: 2-3 words naming the usual way ("Most websites", "The old site"). leftText: 3-6 words, the problem, plain. rightLabel: "Ours" or "With us". rightText: 3-6 words, the result, confident. No exaggeration.',
  detail: 'label: a short eyebrow naming what we are looking at, e.g. "Detail \u00b7 the booking flow" (name the client only if allowed). caption: 3-5 words on why this detail matters. crop: a TIGHT region on one element (a button, a form, a menu, a card), framed; region should be roughly 2:1 to 3:1 wide.',
  backdrop: 'line1, line2, line3: three short lines (2-4 words each) that read as one sentence top to bottom, e.g. "Three weeks." / "One cohesive site." / "Built for growth." crop: the hero or a full-page shot, treatment "dimmed", region may be null for the whole image.',
  mobile: 'headline: 3-5 words with accentWord (copied exactly) in orange. support: one sentence under 14 words about mobile. crop.screenshot MUST be a "-mobile.png" file; region null shows the top of the phone screen.',
  headline: 'headline: 3-5 words, one of which is accentWord (copied exactly from the headline) and set in orange. support: one plain sentence under 14 words that earns the headline.',
  question: 'question: a question the reader would ask themselves, under 12 words, ending in "?". answer: 2-4 words, confident, ending in a period.',
  tip: 'label: "Tip" plus a two-digit number, e.g. "Tip 03" (vary the number). tip: 3-5 words of practical advice. detail: one sentence under 18 words explaining why. Useful, no pitch.',
  holiday: 'This is a greeting card, nothing more. greeting: 2-3 words like "Happy Thanksgiving." or "Merry Christmas." line: one warm sentence under 16 words with a little Daedabyte flavor (small businesses, the valley, building things that last). No offer, no CTA, no proof points. Captions: one or two friendly sentences, same spirit; hashtags only the brand ones.',
  list: 'Four one-word lines (line1-line4), each a single word with a period, e.g. "Slow." Then a verdict of 3-5 words that resolves them. The four words are set in brand accent colors, the verdict in white.',
  stat: 'number: a short figure like "40%" or "24h" taken from the proof points. claim: 3-5 words in white. kicker: a short CTA or qualifier in orange caps. Set crop.treatment "dimmed" with a screenshot to put a dim site behind the number, or leave crop.screenshot null for a plain ink background.',
  quote: 'The quote is a client of OURS talking about OUR work. Pick ONE review from the REVIEWS list in the user message and copy a passage of it VERBATIM (under 30 words, whole sentences, no paraphrase, no stitching). name: the reviewer\'s name as given. business: their business as given. If no reviews are listed, use the testimonials screenshot the same way.',
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
    ...(template === 'mobile' ? [...pages.filter((s) => s.viewport === 'mobile'), ...sections.filter((s) => s.viewport === 'mobile')] : []),
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
  const template = day.template as Exclude<PlanDay['template'], 'none'>;
  if (day.template === 'none') throw new Error(`${day.slot} is planned as no post`);
  const slots = brand.templates[template]!.slots.filter((s) => s !== 'crop');

  let site: Site | null = null;
  let manifest: Manifest | null = null;
  if (day.site) {
    site = await loadSite(day.site);
    manifest = await readManifest(day.site);
    if (!manifest) throw new Error(`Site "${day.site}" has no capture yet`);
  }
  let reviews: Review[] = [];
  if (template === 'quote') {
    reviews = await listReviews();
    if (reviews.length === 0) {
      if (!site || site.kind !== 'own') throw new Error('quote template needs reviews on the Reviews page, or one of our own sites with a captured testimonials section');
      if (!manifest!.shots.some((s) => s.section === 'testimonials')) throw new Error(`quote template needs reviews on the Reviews page, or a captured "testimonials" section on ${site.slug}`);
    } else if (site && site.kind !== 'own') {
      throw new Error('quote template: leave the site empty or use our own site; client sites are never the source of quotes');
    }
  }
  if (['screenshot', 'detail', 'backdrop', 'mobile'].includes(template) && !site) throw new Error(`${template} template needs a captured site`);
  const shots = manifest ? pickShots(manifest, template) : [];
  const dims: ShotDims = Object.fromEntries(shots.map((s) => [s.file, { width: s.width, height: s.height }]));

  const lines = [`Week of ${input.weekOf}, ${day.slot.toUpperCase()} ${day.date ?? ''} post.`, `Subject: ${day.subject}`];
  if (day.holiday && template === 'holiday') lines.push(`Holiday: ${day.holiday}. A simple greeting in our voice; the image is rendered in seasonal colors.`);
  else if (day.holiday) lines.push(`Holiday: today is ${day.holiday}. One light acknowledgement in the captions at most; the post itself stays on its subject.`);
  else if (day.theme) lines.push(`Season: the image will be rendered in "${day.theme}" seasonal colors; the copy may nod to the season but need not.`);
  if (site) {
    lines.push(`Site: ${site.kind === 'own' ? `OUR OWN site, ${site.name}` : site.permissionToName ? `client "${site.name}"` : `an anonymous client (${site.industry || 'small business'}; do not name them)`} (${site.industry}).`);
    lines.push(`Screenshots (filename: section, viewport, width x height):`);
    for (const s of shots) lines.push(`- ${s.file}: ${s.section}, ${s.viewport}, ${s.width}x${s.height}`);
  } else {
    lines.push('No site for this post; crop.screenshot must be null.');
  }
  if (reviews.length) {
    lines.push('', 'REVIEWS (quote one verbatim):');
    for (const r of reviews) lines.push(`- ${r.name}${r.business ? `, ${r.business}` : ''} (${r.source}${r.date ? `, ${r.date}` : ''}): "${r.text}"`);
  }
  if (input.feedback) lines.push(`\nReviewer feedback on the previous version (address it directly):\n${input.feedback}`);
  const content: ContentBlock[] = [{ type: 'text', text: lines.join('\n') }];
  for (const s of shots) {
    content.push({ type: 'text', text: `Image: ${s.file}` });
    content.push(await imageBlock(path.join(siteDir(day.site!), s.file)));
  }

  const system = buildSystemPrompt(brand, template);
  const messages: MessageParam[] = [{ role: 'user', content }];
  const schema = responseSchema(template, slots);
  const calls: Generated['calls'] = [];

  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = await ask<DraftContent>({ system, messages, schema, effort: 'medium', maxTokens: 4096 });
    calls.push({ request: r.request, response: r.response, costUsd: r.costUsd });
    const errors = validateContent(brand, r.data, dims, template, reviews);
    messages.push({ role: 'assistant', content: JSON.stringify(r.data) });
    if (errors.length === 0) {
      log(`${day.slot}: valid on attempt ${attempt} ($${r.costUsd.toFixed(4)})`);
      const warnings = repeatWarnings(template, r.data.slots);
      for (const w of warnings) log(`${day.slot}: note: ${w}`);
      const altText = `${brand.name} ad: ${keyLine(template, r.data.slots)}`.slice(0, 200);
      return { content: { ...r.data, theme: day.theme ?? null, altText, warnings }, context: messages, calls, costUsd: calls.reduce((a, c) => a + c.costUsd, 0), site };
    }
    log(`${day.slot}: attempt ${attempt} failed validation: ${errors.join('; ')}`);
    if (attempt === 2) throw new Error(`Draft failed validation twice: ${errors.join('; ')}`);
    messages.push({ role: 'user', content: `Fix these problems and return the full JSON again:\n- ${errors.join('\n- ')}` });
  }
  throw new Error('unreachable');
}

/** Non-blocking notes when the new post reads like a recent one. */
export function repeatWarnings(template: string, slots: Record<string, string>, recent = recentDraftSummaries(40)): string[] {
  const line = keyLine(template, slots);
  const out: string[] = [];
  for (const r of recent) {
    if (!r.headline) continue;
    const sim = similarity(line, r.headline);
    if (sim >= 0.6) out.push(`reads like the ${r.template} post from ${r.weekOf} ${r.slot} ("${r.headline}")`);
  }
  return out.slice(0, 3);
}

const CAPTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['captions', 'hashtags'],
  properties: {
    captions: { type: 'object', additionalProperties: false, required: ['instagram', 'facebook', 'linkedin', 'googlebusiness'], properties: { instagram: { type: 'string' }, facebook: { type: 'string' }, linkedin: { type: 'string' }, googlebusiness: { type: 'string' } } },
    hashtags: { type: 'object', additionalProperties: false, required: ['instagram', 'facebook', 'linkedin'], properties: { instagram: { type: 'array', items: { type: 'string' } }, facebook: { type: 'array', items: { type: 'string' } }, linkedin: { type: 'array', items: { type: 'string' } } } },
  },
};

/** Rewrite only the captions and hashtags of an existing draft; the image copy stays. */
export async function regenerateCaptions(id: string, note = '', opts: GenerateOptions = {}): Promise<Draft> {
  const ask = opts.ask ?? (askJson as Ask);
  const log = opts.log ?? (() => {});
  const d = getDraft(id);
  if (!d) throw new Error(`Unknown draft ${id}`);
  const brand = await loadBrand();
  const c = JSON.parse(d.contentJson) as DraftContent;
  const ctx = JSON.parse(d.generationContext) as { plan?: PlanDay; calls?: unknown[] };
  const system = buildSystemPrompt(brand, d.template);
  const messages: MessageParam[] = [
    {
      role: 'user',
      content: `Write new captions and hashtags for this existing ${d.template} post. The image text is fixed:\n${JSON.stringify(c.slots, null, 1)}\n${ctx.plan?.subject ? `Subject: ${ctx.plan.subject}\n` : ''}${note ? `Reviewer note: ${note}\n` : 'Make them different from the current ones in angle and wording.\n'}Current captions (do not reuse):\n${JSON.stringify(c.captions, null, 1)}\nReturn only captions and hashtags.`,
    },
  ];
  const r = await ask<Pick<DraftContent, 'captions' | 'hashtags'>>({ system, messages, schema: CAPTION_SCHEMA, effort: 'low', maxTokens: 2048 });
  const next: DraftContent = { ...c, captions: r.data.captions, hashtags: r.data.hashtags };
  const errors = validateContent(brand, next, {}, d.template).filter((e) => /caption|hashtag/.test(e));
  if (errors.length) throw new Error(`New captions failed validation: ${errors.join('; ')}`);
  log(`captions rewritten ($${r.costUsd.toFixed(4)})`);
  const calls = [...(ctx.calls ?? []), { kind: 'captions', request: r.request, response: r.response, costUsd: r.costUsd }];
  return updateDraft(id, { contentJson: JSON.stringify(next), generationContext: JSON.stringify({ ...ctx, calls }), costUsd: d.costUsd + r.costUsd });
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
