import { describe, it, expect } from 'vitest';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { captureSite, isCaptureFresh, siteDir } from '../src/capture.js';
import { loadSite } from '../src/sites.js';

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
