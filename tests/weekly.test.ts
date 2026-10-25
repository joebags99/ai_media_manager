import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { useDb, listDrafts } from '../src/db.js';
import { runWeekly } from '../src/weekly.js';
import { captureSite } from '../src/capture.js';
import { writePlan, type Plan } from '../src/plan.js';
import type { Ask } from '../src/generate.js';
import type { JsonCall, JsonResult } from '../src/claude.js';

// A fake Claude that answers from the plan subject and the template in the system prompt.
const calls: JsonCall[] = [];
const fakeAsk: Ask = async <T,>(call: JsonCall) => {
  calls.push(call);
  const template = /TEMPLATE: (\w+)/.exec(call.system)![1]!;
  const user = call.messages[0]!;
  const text = typeof user.content === 'string' || !user.content ? String(user.content ?? '') : user.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
  const shot = /- ([\w-]+\.png): /.exec(text)?.[1] ?? null;
  const repair = call.messages.length > 1;
  const slots: Record<string, Record<string, string>> = {
    list: { line1: 'Slow.', line2: 'Dated.', line3: 'Hidden.', line4: 'Broken.', verdict: 'Yours should be none.' },
    stat: { number: '40%', claim: repair ? 'Average lift in inquiries.' : 'This claim is deliberately far too long to pass.', kicker: 'Start your project.' },
    screenshot: { headline: 'Built to load fast.', accentWord: 'fast' },
    quote: { quote: 'They rebuilt our site in three weeks.', name: 'Dana W.', business: 'Valley Tile & Stone' },
  };
  const data = {
    template,
    slots: slots[template],
    crop: { screenshot: template === 'screenshot' ? shot : null, region: null, treatment: 'framed' },
    captions: { instagram: 'Caption. Link in bio.', facebook: 'Caption. https://daedabyte.com', linkedin: 'Caption. https://daedabyte.com', googlebusiness: 'Caption.' },
    hashtags: { instagram: ['#Daedabyte', '#WebDesign', '#SmallBusiness', '#SEO', '#MtJackson'], facebook: ['#Daedabyte'], linkedin: ['#Daedabyte', '#WebDesign', '#SmallBusiness'] },
    rationale: 'Fake.',
  };
  return { data: data as T, request: { fake: true }, response: { id: 'msg_fake', usage: {} } as unknown as JsonResult<T>['response'], costUsd: 0.05, model: 'fake' };
};

beforeAll(async () => {
  useDb(path.join(await mkdtemp(path.join(tmpdir(), 'wk-')), 'test.db'));
  await captureSite('sample-local', { log: () => {} });
  await captureSite('sample-own', { log: () => {} });
  const plan: Plan = {
    weekOf: '2026-11-02',
    createdAt: new Date().toISOString(),
    source: 'edited',
    days: [
      { slot: 'mon', template: 'list', subject: 'Pain points', site: null, reason: 't' },
      { slot: 'tue', template: 'stat', subject: 'Inquiries', site: null, reason: 't' },
      { slot: 'wed', template: 'screenshot', subject: 'Recent work', site: 'sample-local', reason: 't' },
      { slot: 'thu', template: 'quote', subject: 'Testimonial', site: 'sample-own', reason: 't' },
      { slot: 'fri', template: 'list', subject: 'Checklist', site: null, reason: 't' },
    ],
  };
  await writePlan(plan);
});

describe('weekly run', () => {
  it('produces five pending drafts with renders, repairing one failed validation', async () => {
    const log: string[] = [];
    const r = await runWeekly({ weekOf: '2026-11-02', ask: fakeAsk, log: (l) => log.push(l) });
    expect(r.errors).toEqual([]);
    expect(r.created).toHaveLength(5);
    const drafts = listDrafts({ weekOf: '2026-11-02', latestOnly: true });
    expect(drafts.every((d) => d.status === 'pending' && d.renderSquare && d.renderPortrait)).toBe(true);
    // the stat draft needed a repair turn: two calls, the second carrying the validation errors
    expect(log.some((l) => /tue: attempt 1 failed validation/.test(l))).toBe(true);
    const statCtx = JSON.parse(drafts.find((d) => d.slot === 'tue')!.generationContext);
    expect(statCtx.calls).toHaveLength(2);
    expect(statCtx.messages[2].content).toMatch(/Fix these problems/);
    // screenshot draft stored image refs, not base64
    const shotCtx = JSON.parse(drafts.find((d) => d.slot === 'wed')!.generationContext);
    expect(JSON.stringify(shotCtx)).not.toMatch(/base64/);
    expect(JSON.stringify(shotCtx)).toMatch(/image_ref/);
    for (const d of drafts) expect((await readFile(d.renderSquare!)).length).toBeGreaterThan(1000);
    expect(r.costUsd).toBeCloseTo(0.3, 5);
  }, 120_000);

  it('skips slots that already have a draft on a second run', async () => {
    const r = await runWeekly({ weekOf: '2026-11-02', ask: fakeAsk, log: () => {} });
    expect(r.created).toHaveLength(0);
  }, 60_000);

  it('refuses a quote draft from a client site', async () => {
    const { generateContent } = await import('../src/generate.js');
    await expect(generateContent({ weekOf: '2026-11-02', day: { slot: 'thu', template: 'quote', subject: 'x', site: 'sample-local', reason: '' } }, { ask: fakeAsk })).rejects.toThrow(/own sites/);
  });

  it('stops at the cost ceiling', async () => {
    const r = await runWeekly({ weekOf: '2026-11-02', ask: fakeAsk, log: () => {}, force: true, costCeilingUsd: 0.12 });
    expect(r.errors.some((e) => /cost ceiling/.test(e))).toBe(true);
    expect(r.created.length).toBeLessThan(5);
  }, 60_000);
});
