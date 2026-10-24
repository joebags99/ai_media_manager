import { describe, it, expect } from 'vitest';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ROOT, loadBrand, renderDraft, textSlots, type TemplateName } from '../src/render.js';

const TEMPLATES: TemplateName[] = ['list', 'stat', 'quote', 'screenshot'];

function pngSize(buf: Buffer): [number, number] {
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

describe('templates', () => {
  it.each(TEMPLATES)('%s.html has an element for every text slot in brand.json', async (t) => {
    const brand = await loadBrand();
    const html = await readFile(path.join(ROOT, 'templates', `${t}.html`), 'utf8');
    const found = new Set([...html.matchAll(/data-(?:accent-)?slot="([^"]+)"/g)].map((m) => m[1]));
    for (const slot of textSlots(brand, t)) expect(found, `slot ${slot}`).toContain(slot);
  });

  it.each(TEMPLATES)('%s.html takes colors only from brand CSS variables', async (t) => {
    const html = await readFile(path.join(ROOT, 'templates', `${t}.html`), 'utf8');
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});

describe('renderDraft', () => {
  it('rejects a draft with a missing slot', async () => {
    await expect(
      renderDraft({ id: 't-missing', template: 'stat', slots: { number: '40%', claim: 'A claim.' } }),
    ).rejects.toThrow(/kicker/);
  });

  it('rejects an accent word that is not in the headline', async () => {
    await expect(
      renderDraft({
        id: 't-accent',
        template: 'screenshot',
        slots: { headline: 'Built to last.', accentWord: 'fast' },
        crop: { screenshot: 'sample-desktop.png', region: null, treatment: 'framed' },
        screenshotDir: path.join(ROOT, 'fixtures', 'screenshots'),
      }),
    ).rejects.toThrow(/Accent word/);
  });

  it('writes square and portrait PNGs at the brand canvas sizes', async () => {
    const outDir = await mkdtemp(path.join(tmpdir(), 'render-'));
    const r = await renderDraft(
      {
        id: 't-list',
        template: 'list',
        slots: { line1: 'Slow.', line2: 'Dated.', line3: 'Hidden.', line4: 'Broken.', verdict: 'Fix all four.' },
      },
      { outDir },
    );
    expect(pngSize(await readFile(r.square))).toEqual([1080, 1080]);
    expect(pngSize(await readFile(r.portrait))).toEqual([1080, 1350]);
  }, 30_000);
});
