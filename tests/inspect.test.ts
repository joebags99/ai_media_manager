import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspectSite, suggestRecipe } from '../src/inspect.js';
import { ROOT } from '../src/config.js';

describe('inspect', () => {
  it('finds the fixture site blocks and builds a heuristic recipe without an API key', async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const url = pathToFileURL(path.join(ROOT, 'fixtures', 'screenshots', 'sample-site.html')).href;
      const ins = await inspectSite(url);
      expect(ins.candidates.length).toBeGreaterThanOrEqual(2);
      expect(ins.candidates.map((c) => c.selector)).toContain('section.hero');
      const log: string[] = [];
      const sug = await suggestRecipe({ name: 'Fixture', url, industry: 'tile' }, ins, (l) => log.push(l));
      expect(sug.source).toBe('heuristic');
      expect(sug.recipe.sections[0]).toEqual({ name: 'hero', selector: 'section.hero' });
    } finally {
      if (saved) process.env.ANTHROPIC_API_KEY = saved;
    }
  }, 60_000);
});
