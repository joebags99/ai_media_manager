import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { useDb, listDrafts, getDraft } from '../src/db.js';
import { captureSite } from '../src/capture.js';
import { generateDraft, type Ask } from '../src/generate.js';
import { reviseDraft } from '../src/revise.js';
import { approve, reject } from '../src/workflow.js';
import type { JsonCall, JsonResult } from '../src/claude.js';

const seen: JsonCall[] = [];
const fakeAsk: Ask = async <T,>(call: JsonCall) => {
  seen.push({ ...call, messages: [...call.messages] });
  const last = call.messages[call.messages.length - 1]!;
  const lastText = typeof last.content === 'string' ? last.content : '';
  const headline = /feedback/i.test(lastText) ? 'Built to last longer.' : 'Built to load fast.';
  const data = {
    template: 'screenshot',
    slots: { headline, accentWord: headline.split(' ')[2]!.replace('.', '') },
    crop: { screenshot: 'hero-desktop.png', region: null, treatment: 'framed' },
    captions: { instagram: 'A. Link in bio.', facebook: 'B. https://daedabyte.com', linkedin: 'C. https://daedabyte.com', googlebusiness: 'D.' },
    alternates: { instagram: 'A2. Link in bio.', facebook: 'B2.', linkedin: 'C2.', googlebusiness: 'D2.' },
    hashtags: { instagram: ['#Daedabyte', '#WebDesign', '#SmallBusiness', '#SEO', '#MtJackson'], facebook: ['#Daedabyte'], linkedin: ['#Daedabyte', '#WebDesign', '#SmallBusiness'] },
    rationale: 'Fake.',
  };
  return { data: data as T, request: { n: seen.length }, response: { id: `msg_${seen.length}` } as unknown as JsonResult<T>['response'], costUsd: 0.04, model: 'fake' };
};

beforeAll(async () => {
  useDb(path.join(await mkdtemp(path.join(tmpdir(), 'rv-')), 'test.db'));
  await captureSite('sample-local', { log: () => {} });
});

describe('M4 workflow', () => {
  it('revise replays the conversation with images and creates v2; v1 stays viewable', async () => {
    const { draft: v1 } = await generateDraft({ weekOf: '2026-11-09', day: { slot: 'mon', template: 'screenshot', subject: 'Work', site: 'sample-local', reason: '' } }, { ask: fakeAsk });
    const v2 = await reviseDraft(v1.id, 'Say longer, not fast.', { ask: fakeAsk, render: false });
    expect(v2.version).toBe(2);
    expect(v2.status).toBe('pending');
    expect(v2.feedback).toBe('Say longer, not fast.');
    expect(JSON.parse(v2.contentJson).slots.headline).toBe('Built to last longer.');
    // the replayed request carried the original user turn with real image bytes, the v1 answer, and the feedback
    const replay = seen[seen.length - 1]!;
    expect(replay.messages).toHaveLength(3);
    const first = replay.messages[0]!.content as { type: string }[];
    expect(first.some((b) => b.type === 'image')).toBe(true);
    expect(replay.messages[1]!.role).toBe('assistant');
    expect(String(replay.messages[2]!.content)).toMatch(/Say longer/);
    // stored context on v2 holds both calls and image refs, no base64
    const ctx = JSON.parse(v2.generationContext);
    expect(ctx.calls).toHaveLength(2);
    expect(JSON.stringify(ctx)).not.toMatch(/base64/);
    expect(getDraft(v1.id)!.status).toBe('revising');
    expect(listDrafts({ weekOf: '2026-11-09', latestOnly: true }).map((d) => d.version)).toEqual([2]);
    // old version cannot be revised again
    await expect(reviseDraft(v1.id, 'again', { ask: fakeAsk, render: false })).rejects.toThrow(/not the latest/);
  }, 60_000);

  it('approve and reject only move from pending, and a pending draft is never approved by accident', async () => {
    const { draft } = await generateDraft({ weekOf: '2026-11-09', day: { slot: 'tue', template: 'screenshot', subject: 'Work', site: 'sample-local', reason: '' } }, { ask: fakeAsk });
    expect(reject(draft.id, 'nope').status).toBe('rejected');
    expect(() => approve(draft.id)).toThrow(/rejected; cannot move to approved/);
    const { draft: d2 } = await generateDraft({ weekOf: '2026-11-09', day: { slot: 'wed', template: 'screenshot', subject: 'Work', site: 'sample-local', reason: '' } }, { ask: fakeAsk });
    expect(approve(d2.id).status).toBe('approved');
    expect(() => reject(d2.id)).toThrow(/approved; cannot move to rejected/);
  }, 60_000);

  it('a failed revision returns the draft to pending with the error recorded', async () => {
    const { draft } = await generateDraft({ weekOf: '2026-11-09', day: { slot: 'thu', template: 'screenshot', subject: 'Work', site: 'sample-local', reason: '' } }, { ask: fakeAsk });
    const boom: Ask = async () => { throw new Error('API down'); };
    await expect(reviseDraft(draft.id, 'x', { ask: boom })).rejects.toThrow('API down');
    const after = getDraft(draft.id)!;
    expect(after.status).toBe('pending');
    expect(after.errorMessage).toBe('API down');
  }, 60_000);
});
