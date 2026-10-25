import { describe, it, expect } from 'vitest';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { captureSite, isCaptureFresh, siteDir } from '../src/capture.js';
import { loadSite } from '../src/sites.js';
import { ROOT } from '../src/config.js';

describe('capture', () => {
  it('rejects a slug with no recipe', async () => {
    await expect(loadSite('nope')).rejects.toThrow(/sites\/nope\.json/);
  });

  it('captures the local fixture site at both viewports and writes a manifest', async () => {
    const log: string[] = [];
    const m = await captureSite('sample-local', { log: (l) => log.push(l) });
    expect(m.warnings).toEqual([]);
    const names = m.shots.map((s) => `${s.section}-${s.viewport}`).sort();
    expect(names).toEqual(['hero-desktop', 'hero-mobile', 'page-desktop', 'page-mobile', 'services-desktop', 'services-mobile']);
    for (const s of m.shots) expect((await stat(path.join(siteDir('sample-local'), s.file))).size).toBeGreaterThan(1000);
    const onDisk = JSON.parse(await readFile(path.join(siteDir('sample-local'), 'manifest.json'), 'utf8'));
    expect(onDisk.capturedAt).toBe(m.capturedAt);
    expect(await isCaptureFresh('sample-local')).toBe(true);
    expect(await isCaptureFresh('sample-local', 0)).toBe(false);
  }, 60_000);
});

describe('capture resilience', () => {
  it('skips hidden matches and records missing sections as warnings', async () => {
    const m = await captureSite('sample-hidden', { log: () => {} });
    const hero = m.shots.find((s) => s.section === 'hero' && s.viewport === 'desktop');
    expect(hero?.height).toBe(300);
    expect(m.warnings.some((w) => w.includes('"missing"'))).toBe(true);
  }, 60_000);
});

describe('saveSite', () => {
  it('writes a recipe file and rejects bad input', async () => {
    const { saveSite, loadSite, slugify } = await import('../src/sites.js');
    const { rm } = await import('node:fs/promises');
    expect(slugify('Valley Tile & Stone!')).toBe('valley-tile-stone');
    const site = await saveSite({
      name: 'Test Save Site',
      url: 'https://example.test/',
      industry: 'testing',
      permissionToName: false,
      recipe: { dismiss: [' .cookie '], sections: [{ name: 'hero', selector: 'main' }, { name: '', selector: '' }] },
    });
    expect(site.slug).toBe('test-save-site');
    const back = await loadSite('test-save-site');
    expect(back.recipe.sections).toEqual([{ name: 'hero', selector: 'main' }]);
    expect(back.recipe.dismiss).toEqual(['.cookie']);
    await rm(path.join(ROOT, 'sites', 'test-save-site.json'));
    await expect(saveSite({ name: 'x', url: 'nope', industry: '', permissionToName: false, recipe: { sections: [{ name: 'a', selector: 'b' }] } })).rejects.toThrow(/valid URL/);
    await expect(saveSite({ name: 'x', url: 'https://a.b/', industry: '', permissionToName: false, recipe: { sections: [] } })).rejects.toThrow(/at least one section/);
  });
});

describe('site kind', () => {
  it('defaults to client, and own sites always may be named', async () => {
    const own = await loadSite('daedabyte');
    expect(own.kind).toBe('own');
    expect(own.permissionToName).toBe(true);
    const client = await loadSite('sample-local');
    expect(client.kind).toBe('client');
  });
});
