// weekly.ts: the weekly run from pipeline-spec.workflow.weeklyRun.
//   plan (if none for the week) -> capture stale sites -> generate one draft per slot
//   -> render both sizes -> record the run. Aborts when projected cost passes the ceiling.
import { chromium } from 'playwright';
import path from 'node:path';
import { captureSite, isCaptureFresh, siteDir } from './capture.js';
import { COST_CEILING_USD } from './config.js';
import { finishRun, listDrafts, nextWeekOf, startRun, updateDraft, type Draft, type Slot } from './db.js';
import { generateDraft, type Ask } from './generate.js';
import { planWeek, readPlan, writePlan, type Plan } from './plan.js';
import { renderDraft, type TemplateName } from './render.js';
import type { DraftContent } from './validate.js';
import { sendDigest } from './notify.js';
import { syncMetrics } from './metrics.js';

export interface WeeklyOptions {
  weekOf?: string;
  ask?: Ask;
  log?: (s: string) => void;
  /** Regenerate slots that already have a draft this week. Default: skip them. */
  force?: boolean;
  costCeilingUsd?: number;
  /** Send the digest after the run. Default true. */
  digest?: boolean;
  /** Generate only these slots (others untouched). */
  only?: Slot[];
  /** Pull Buffer metrics before planning. Default true when a token is set. */
  metrics?: boolean;
}

export async function renderDraftRow(draft: Draft): Promise<Draft> {
  const content = JSON.parse(draft.contentJson) as DraftContent;
  const r = await renderDraft({
    id: draft.version > 1 ? `${draft.id}-v${draft.version}` : draft.id,
    template: draft.template as TemplateName,
    slots: content.slots,
    crop: content.crop,
    screenshotDir: draft.site ? siteDir(draft.site) : undefined,
    theme: content.theme ?? null,
  });
  return updateDraft(draft.id, { renderSquare: r.square, renderPortrait: r.portrait });
}

export async function ensurePlan(weekOf: string, log: (s: string) => void): Promise<Plan> {
  const existing = await readPlan(weekOf);
  if (existing) return existing;
  log(`planning week of ${weekOf}`);
  const plan = await planWeek(weekOf, log);
  await writePlan(plan);
  return plan;
}

export async function runWeekly(opts: WeeklyOptions = {}): Promise<{ weekOf: string; created: Draft[]; errors: string[]; costUsd: number }> {
  const log = opts.log ?? ((s: string) => console.log(`[weekly] ${s}`));
  const weekOf = opts.weekOf ?? nextWeekOf();
  const ceiling = opts.costCeilingUsd ?? COST_CEILING_USD;
  const run = startRun(weekOf);
  const created: Draft[] = [];
  const errors: string[] = [];
  let cost = 0;

  try {
    if (process.env.BUFFER_ACCESS_TOKEN?.trim() && opts.metrics !== false) {
      try {
        await syncMetrics({ log });
      } catch (err) {
        log(`metrics sync skipped: ${(err as Error).message}`);
      }
    }
    const plan = await ensurePlan(weekOf, log);
    cost += plan.claude?.costUsd ?? 0;

    const sites = [...new Set(plan.days.filter((d) => !opts.only || opts.only.includes(d.slot)).map((d) => d.site).filter((s): s is string => Boolean(s)))];
    for (const slug of sites) {
      if (await isCaptureFresh(slug)) {
        log(`${slug}: capture is fresh, skipping`);
        continue;
      }
      try {
        await captureSite(slug, { log: (l) => log(`${slug}: ${l}`) });
      } catch (err) {
        errors.push(`capture ${slug}: ${(err as Error).message}`);
        log(`capture ${slug} failed: ${(err as Error).message}`);
      }
    }

    const have = new Set(listDrafts({ weekOf, latestOnly: true }).filter((d) => d.status !== 'rejected').map((d) => d.slot));
    const browser = await chromium.launch();
    try {
      for (const day of plan.days) {
        if (day.template === 'none') continue;
        if (opts.only && !opts.only.includes(day.slot)) continue;
        if (have.has(day.slot) && !opts.force) {
          log(`${day.slot}: draft exists, skipping`);
          continue;
        }
        const perDraft = created.length ? cost / (created.length + 1) : 0.15;
        if (cost + perDraft > ceiling) {
          errors.push(`cost ceiling: spent $${cost.toFixed(2)}, ceiling $${ceiling.toFixed(2)}; stopped before ${day.slot}`);
          log(errors[errors.length - 1]!);
          break;
        }
        try {
          log(`${day.slot}: generating ${day.template}${day.site ? ` for ${day.site}` : ''}`);
          const { draft } = await generateDraft({ weekOf, day }, { ask: opts.ask, log });
          cost += draft.costUsd;
          const rendered = await renderDraftRow(draft);
          created.push(rendered);
          log(`${day.slot}: rendered ${path.basename(rendered.renderSquare!)}`);
        } catch (err) {
          const msg = (err as Error).message;
          errors.push(`${day.slot}: ${msg}`);
          log(`${day.slot}: failed: ${msg}`);
        }
      }
    } finally {
      await browser.close();
    }
  } finally {
    finishRun(run.id, { draftsCreated: created.length, errors: JSON.stringify(errors), costEstimateUsd: cost });
  }
  log(`done: ${created.length} draft(s), ${errors.length} error(s), $${cost.toFixed(3)}`);
  if (opts.digest !== false) {
    try {
      await sendDigest(weekOf, { log });
    } catch (err) {
      log(`digest failed: ${(err as Error).message}`);
    }
  }
  return { weekOf, created, errors, costUsd: cost };
}
