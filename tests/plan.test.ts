import { describe, it, expect } from 'vitest';
import { planWeek, dayContext } from '../src/plan.js';
import { applyTheme, loadBrand, renderDraft } from '../src/render.js';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

describe('seven-day plan with holidays', () => {
  it('default plan: weekdays post, Saturday posts only because Halloween falls there, Sunday is empty', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const plan = await planWeek('2026-10-26', () => {});
    const by = Object.fromEntries(plan.days.map((d) => [d.slot, d]));
    expect(plan.days).toHaveLength(7);
    expect(by['sat']!.template).not.toBe('none');
    expect(by['sat']!.holiday).toBe('Halloween');
    expect(by['sat']!.theme).toBe('halloween');
    expect(by['sun']!.template).toBe('none');
    expect(by['mon']!.theme).toBe('halloween'); // run-up to Halloween
    expect(by['mon']!.holiday).toBeNull();
  });
  it('a sombre holiday on a weekday becomes no post', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const plan = await planWeek('2026-05-25', () => {}); // Memorial Day Monday
    expect(plan.days.find((d) => d.slot === 'mon')!.template).toBe('none');
    expect(dayContext('2026-06-29', 'sat').holiday?.name).toBe('Independence Day');
  });
});

describe('seasonal themes', () => {
  it('override accents only and leave ink/bone alone', async () => {
    const brand = await loadBrand();
    const h = applyTheme(brand, 'halloween');
    expect(h.colors['ink']).toBe(brand.colors['ink']);
    expect(h.colors['bone']).toBe(brand.colors['bone']);
    expect(h.colors['purple']).not.toBe(brand.colors['purple']);
    expect(h.accentOrder[1]).toBe('purple');
    expect(applyTheme(brand, 'nope')).toEqual(brand);
    expect(applyTheme(brand, null)).toEqual(brand);
  });
  it('renders a themed list ad', async () => {
    const outDir = await mkdtemp(path.join(tmpdir(), 'theme-'));
    const r = await renderDraft({ id: 't-halloween', template: 'list', theme: 'halloween', slots: { line1: 'Slow.', line2: 'Spooky.', line3: 'Hidden.', line4: 'Broken.', verdict: 'Scary sites lose customers.' } }, { outDir });
    expect((await readFile(r.square)).length).toBeGreaterThan(1000);
  }, 30_000);
});

describe('new templates', () => {
  it('holiday days get the holiday template and the default rotation uses list once', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const plan = await planWeek('2026-11-23', () => {}); // Thanksgiving week
    const by = Object.fromEntries(plan.days.map((d) => [d.slot, d]));
    expect(by['thu']!.template).toBe('holiday');
    expect(by['thu']!.theme).toBe('autumn');
    expect(by['sat']!.template).toBe('holiday'); // Small Business Saturday
    expect(plan.days.filter((d) => d.template === 'list').length).toBeLessThanOrEqual(1);
  });
  it('validation covers the new templates', async () => {
    const { validateContent } = await import('../src/validate.js');
    const brand = await loadBrand();
    const base = { crop: { screenshot: null, region: null, treatment: 'framed' as const }, captions: { instagram: 'a', facebook: 'b', linkedin: 'c', googlebusiness: 'd' }, hashtags: { instagram: ['#Daedabyte', '#WebDesign', '#SmallBusiness', '#SEO', '#MtJackson'], facebook: [], linkedin: ['#Daedabyte', '#WebDesign', '#SmallBusiness'] }, rationale: 'r' };
    expect(validateContent(brand, { ...base, template: 'headline', slots: { headline: 'Built to last.', accentWord: 'last', support: 'Still working in five years.' } }, {})).toEqual([]);
    expect(validateContent(brand, { ...base, template: 'headline', slots: { headline: 'Built to last.', accentWord: 'fast', support: 'x' } }, {})).toContain('accentWord does not appear in headline');
    expect(validateContent(brand, { ...base, template: 'tip', slots: { label: 'Tip 03', tip: 'This tip is far too long to pass the rule', detail: 'x' } }, {}).join()).toMatch(/tip\.tip has/);
    expect(validateContent(brand, { ...base, template: 'holiday', slots: { greeting: 'Happy Thanksgiving.', line: 'Thankful for every client.' } }, {})).toEqual([]);
    expect(validateContent(brand, { ...base, template: 'question', slots: { question: 'Does it load?', answer: 'Ours do.' } }, {})).toEqual([]);
  });
});
