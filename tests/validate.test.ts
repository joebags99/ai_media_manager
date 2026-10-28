import { describe, it, expect } from 'vitest';
import { loadBrand } from '../src/render.js';
import { validateContent, type DraftContent } from '../src/validate.js';

const base = (over: Partial<DraftContent> = {}): DraftContent => ({
  template: 'stat',
  slots: { number: '40%', claim: 'Average lift in inquiries.', kicker: 'Start your project.' },
  crop: { screenshot: null, region: null, treatment: 'framed' },
  captions: { instagram: 'A.', facebook: 'B.', linkedin: 'C.', googlebusiness: 'D.' },
  hashtags: { instagram: ['#Daedabyte', '#WebDesign', '#SmallBusiness', '#SEO', '#MtJackson'], facebook: [], linkedin: ['#Daedabyte', '#WebDesign', '#SEO'] },
  rationale: 'Because.',
  ...over,
});

describe('validateContent', () => {
  it('accepts a valid stat draft', async () => {
    expect(validateContent(await loadBrand(), base(), {})).toEqual([]);
  });
  it('flags the spec rules', async () => {
    const brand = await loadBrand();
    const errs = validateContent(
      brand,
      base({
        slots: { number: '40%', claim: 'This claim is far too long for the rule!', kicker: 'Unlock growth 🚀' },
        captions: { instagram: 'x', facebook: 'x', linkedin: 'x', googlebusiness: 'Link in bio #tag' },
        hashtags: { instagram: ['#one'], facebook: ['#a', '#b', '#c', '#d'], linkedin: ['bad tag', '#ok', '#ok2'] },
        crop: { screenshot: 'hero-desktop.png', region: [0, 0, 2000, 100], treatment: 'dimmed' },
      }),
      { 'hero-desktop.png': { width: 1440, height: 800 } },
      'list',
    );
    const text = errs.join('\n');
    for (const needle of ['plan said "list"', '9 words', 'banned "!"', 'banned "unlock"', 'banned "🚀"', 'instagram has 1 hashtags', 'facebook has 4', 'malformed', 'googlebusiness caption contains a hashtag', 'link in bio', 'falls outside']) {
      expect(text, needle).toContain(needle);
    }
  });
  it('requires a screenshot for the screenshot template and the accent word in the headline', async () => {
    const brand = await loadBrand();
    const errs = validateContent(brand, base({ template: 'screenshot', slots: { headline: 'Built to last.', accentWord: 'fast' } }), {});
    expect(errs).toContain('screenshot needs crop.screenshot');
    expect(errs).toContain('accentWord does not appear in headline');
  });
});
