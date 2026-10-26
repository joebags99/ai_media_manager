import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { useDb, insertDraft, getDraft, listDrafts, listLibrary, currentDraft, recentDraftSummaries } from '../src/db.js';
import { approve, archive, place, duplicate } from '../src/workflow.js';
import { repeatWarnings, regenerateCaptions, type Ask } from '../src/generate.js';
import { similarity } from '../src/validate.js';
import { altTextFor } from '../src/publish.js';
import { loadBrand } from '../src/render.js';
import type { JsonCall, JsonResult } from '../src/claude.js';

const content = (headline: string) => JSON.stringify({ template: 'headline', slots: { headline, accentWord: headline.split(' ')[0], support: 'x' }, crop: { screenshot: null, region: null, treatment: 'framed' }, captions: { instagram: 'a', facebook: 'b', linkedin: 'c', googlebusiness: 'd' }, hashtags: { instagram: ['#Daedabyte', '#WebDesign', '#SmallBusiness', '#SEO', '#MtJackson'], facebook: [], linkedin: ['#Daedabyte', '#WebDesign', '#SmallBusiness'] }, rationale: 'r' });
const mk = (weekOf: string, slot: 'mon' | 'tue', headline: string) => insertDraft({ weekOf, slot, site: null, template: 'headline', contentJson: content(headline), generationContext: '{"calls":[]}', costUsd: 0, renderSquare: '/r/a.png', renderPortrait: '/r/b.png' });

beforeAll(async () => {
  useDb(path.join(await mkdtemp(path.join(tmpdir(), 'lib-')), 'test.db'));
});

describe('library', () => {
  it('shelves an approved draft, places it into a day, and shelves what was there', () => {
    const a = approve(mk('2026-11-02', 'mon', 'Built to last.').id);
    const shelved = archive(a.id);
    expect(shelved.status).toBe('archived');
    expect(shelved.archivedStatus).toBe('approved');
    expect(listDrafts({ weekOf: '2026-11-02', latestOnly: true })).toHaveLength(0);
    expect(listLibrary().map((d) => d.id)).toEqual([a.id]);

    const b = mk('2026-11-09', 'tue', 'Made for phones.');
    const { placed, displaced } = place(a.id, '2026-11-09', 'tue');
    expect(placed.status).toBe('approved'); // came back as it left
    expect(placed.weekOf).toBe('2026-11-09');
    expect(placed.version).toBe(2);
    expect(displaced?.id).toBe(b.id);
    expect(getDraft(b.id)!.status).toBe('archived');
    expect(currentDraft('2026-11-09', 'tue')!.id).toBe(a.id);
    expect(listLibrary().map((d) => d.id)).toEqual([b.id]);
  });
  it('duplicates into another day as a new pending draft', () => {
    const src = mk('2026-11-16', 'mon', 'Fast by default.');
    const copy = duplicate(src.id, '2026-11-23', 'tue');
    expect(copy.id).not.toBe(src.id);
    expect(copy.status).toBe('pending');
    expect(copy.weekOf).toBe('2026-11-23');
    expect(JSON.parse(copy.generationContext).duplicatedFrom).toBe(src.id);
  });
});

describe('guardrails', () => {
  it('flags a headline that reads like a recent post', () => {
    expect(similarity('Built to last.', 'Websites built to last')).toBeGreaterThanOrEqual(0.6);
    expect(similarity('Built to last.', 'Made for phones.')).toBe(0);
    const recent = recentDraftSummaries(40);
    expect(recent.some((r) => r.headline === 'Built to last.')).toBe(true);
    const w = repeatWarnings('headline', { headline: 'Websites built to last', accentWord: 'last', support: 'x' }, recent);
    expect(w.length).toBeGreaterThan(0);
    expect(w[0]).toMatch(/reads like the headline post/);
    expect(repeatWarnings('headline', { headline: 'Open on Sunday.', accentWord: 'Sunday', support: 'x' }, recent)).toEqual([]);
  });
  it('alt text prefers the edited value', async () => {
    const brand = await loadBrand();
    const c = JSON.parse(content('Built to last.'));
    expect(altTextFor(c, brand)).toBe('Daedabyte Web Solutions ad: Built to last.');
    expect(altTextFor({ ...c, altText: 'Orange text on black: built to last' }, brand)).toBe('Orange text on black: built to last');
  });
  it('regenerates captions only, keeping the slots and logging the call', async () => {
    const d = mk('2026-12-07', 'mon', 'Call us first.');
    const fake: Ask = async <T,>(call: JsonCall) => {
      expect(String(call.messages[0]!.content)).toMatch(/Call us first/);
      return { data: { captions: { instagram: 'New IG. Link in bio.', facebook: 'New FB.', linkedin: 'New LI.', googlebusiness: 'New GB.' }, hashtags: { instagram: ['#Daedabyte', '#WebDesign', '#SmallBusiness', '#SEO', '#MtJackson'], facebook: [], linkedin: ['#Daedabyte', '#WebDesign', '#SmallBusiness'] } } as T, request: {}, response: {} as JsonResult<T>['response'], costUsd: 0.01, model: 'fake' };
    };
    const u = await regenerateCaptions(d.id, 'punchier', { ask: fake });
    const c = JSON.parse(u.contentJson);
    expect(c.captions.facebook).toBe('New FB.');
    expect(c.slots.headline).toBe('Call us first.');
    expect(JSON.parse(u.generationContext).calls).toHaveLength(1);
    expect(u.costUsd).toBeCloseTo(0.01);
  });
});

describe('making room', () => {
  it('shelving v2 does not resurrect the superseded v1', async () => {
    const v1 = mk('2027-01-04', 'mon', 'First take.');
    const { updateDraft } = await import('../src/db.js');
    updateDraft(v1.id, { status: 'revising' });
    const v2 = insertDraft({ weekOf: '2027-01-04', slot: 'mon', site: null, template: 'headline', contentJson: content('Second take.'), generationContext: '{}', costUsd: 0, version: 2 });
    expect(currentDraft('2027-01-04', 'mon')!.id).toBe(v2.id);
    archive(v2.id);
    expect(currentDraft('2027-01-04', 'mon')).toBeUndefined();
    expect(listDrafts({ weekOf: '2027-01-04', latestOnly: true })).toHaveLength(0);
  });
  it('delete refuses scheduled drafts and clear-week shelves the rest', async () => {
    const { remove, clearWeek } = await import('../src/workflow.js');
    const { updateDraft } = await import('../src/db.js');
    const a = mk('2027-01-11', 'mon', 'Keep me in Buffer.');
    updateDraft(a.id, { status: 'scheduled' });
    expect(() => remove(a.id)).toThrow(/scheduled/);
    const b = approve(mk('2027-01-11', 'tue', 'Clear me.').id);
    const shelved = clearWeek('2027-01-11');
    expect(shelved.map((d) => d.id)).toEqual([b.id]);
    expect(getDraft(b.id)!.status).toBe('archived');
    expect(getDraft(a.id)!.status).toBe('scheduled');
    remove(b.id);
    expect(getDraft(b.id)).toBeUndefined();
  });
});
