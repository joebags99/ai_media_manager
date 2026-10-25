// revise.ts: replay the original generate messages plus the reviewer feedback as a
// follow-up turn, validate, store as a new draft version (previous kept), re-render.
import { askJson } from './claude.js';
import { getDraft, insertDraft, listDrafts, updateDraft, type Draft } from './db.js';
import { buildSystemPrompt, dehydrate, hydrate, responseSchema, type Ask, type StoredMessage } from './generate.js';
import type { PlanDay } from './plan.js';
import { loadBrand } from './render.js';
import { readManifest } from './capture.js';
import { validateContent, type DraftContent, type ShotDims } from './validate.js';
import { transition } from './workflow.js';
import { listReviews } from './reviews.js';
import { renderDraftRow } from './weekly.js';

interface StoredContext {
  plan: PlanDay;
  messages: StoredMessage[];
  calls: { request: unknown; response: unknown; costUsd: number }[];
}

export interface ReviseOptions {
  ask?: Ask;
  log?: (s: string) => void;
  render?: boolean;
}

export async function reviseDraft(id: string, feedback: string, opts: ReviseOptions = {}): Promise<Draft> {
  const ask = opts.ask ?? (askJson as Ask);
  const log = opts.log ?? (() => {});
  const text = feedback.trim();
  if (!text) throw new Error('Feedback is empty');
  const prev = getDraft(id);
  if (!prev) throw new Error(`Unknown draft ${id}`);
  const latest = listDrafts({ weekOf: prev.weekOf, latestOnly: true }).find((d) => d.slot === prev.slot);
  if (latest && latest.id !== prev.id) throw new Error(`v${prev.version} is not the latest version; revise v${latest.version} instead`);

  transition(prev.id, 'revising');
  try {
    const brand = await loadBrand();
    const ctx = JSON.parse(prev.generationContext) as StoredContext;
    const template = prev.template;
    const slots = brand.templates[template]!.slots.filter((s) => s !== 'crop');
    const system = buildSystemPrompt(brand, template);
    const schema = responseSchema(template, slots);

    let dims: ShotDims = {};
    if (prev.site) {
      const m = await readManifest(prev.site);
      dims = Object.fromEntries((m?.shots ?? []).map((s) => [s.file, { width: s.width, height: s.height }]));
    }

    const reviews = template === 'quote' ? await listReviews() : [];
    const messages = await hydrate(ctx.messages, prev.site);
    messages.push({ role: 'user', content: `Reviewer feedback on your last version (v${prev.version}). Apply it and return the full JSON again, keeping everything else that worked:\n${text}` });
    const calls = [...ctx.calls];

    let content: DraftContent | null = null;
    for (let attempt = 1; attempt <= 2 && !content; attempt++) {
      const r = await ask<DraftContent>({ system, messages, schema, effort: 'medium', maxTokens: 4096 });
      calls.push({ request: r.request, response: r.response, costUsd: r.costUsd });
      messages.push({ role: 'assistant', content: JSON.stringify(r.data) });
      const errors = validateContent(brand, r.data, dims, template, reviews);
      if (errors.length === 0) {
        content = r.data;
        log(`v${prev.version + 1}: valid on attempt ${attempt} ($${r.costUsd.toFixed(4)})`);
      } else {
        log(`v${prev.version + 1}: attempt ${attempt} failed validation: ${errors.join('; ')}`);
        if (attempt === 2) throw new Error(`Revision failed validation twice: ${errors.join('; ')}`);
        messages.push({ role: 'user', content: `Fix these problems and return the full JSON again:\n- ${errors.join('\n- ')}` });
      }
    }

    const cost = calls.slice(ctx.calls.length).reduce((a, c) => a + c.costUsd, 0);
    const next = insertDraft({
      weekOf: prev.weekOf,
      slot: prev.slot,
      site: prev.site,
      template,
      version: prev.version + 1,
      contentJson: JSON.stringify({ ...content, theme: (JSON.parse(prev.contentJson) as DraftContent).theme ?? null }),
      generationContext: JSON.stringify({ plan: ctx.plan, messages: dehydrate(messages), calls }),
      costUsd: cost,
      feedback: text,
    });
    // The old version stays 'revising': it has been superseded but remains viewable.
    return opts.render === false ? next : await renderDraftRow(next);
  } catch (err) {
    updateDraft(prev.id, { status: 'pending', errorMessage: (err as Error).message });
    throw err;
  }
}
