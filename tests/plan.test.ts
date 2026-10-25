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
