import { describe, it, expect } from 'vitest';
import { captionFor, firstCommentFor, buildPostInput, placement } from '../src/publish.js';
import { loadBrand } from '../src/render.js';
import { validateContent, type DraftContent } from '../src/validate.js';

const c: DraftContent = {
  template: 'stat',
  slots: { number: '40%', claim: 'Average lift in inquiries.', kicker: 'Start your project.' },
  crop: { screenshot: null, region: null, treatment: 'framed' },
  captions: { instagram: 'More calls, less chasing. Link in bio.', facebook: 'More calls. https://daedabyte.com/contact', linkedin: 'A site that earns inquiries: https://daedabyte.com/work. Ask us how.', googlebusiness: 'More calls, built to last.' },
  alternates: { instagram: 'Alt IG. Link in bio.', facebook: 'Alt FB.', linkedin: 'Alt LI.', googlebusiness: 'Alt GB.' },
  hashtags: { instagram: ['#Daedabyte', '#WebDesign', '#SmallBusiness', '#SEO', '#MtJackson'], facebook: ['#Daedabyte'], linkedin: ['#Daedabyte', '#WebDesign', '#SmallBusiness'] },
  rationale: 'r',
};

describe('caption placement', () => {
  it('reads brand.json: instagram hashtags and linkedin links go to the first comment', async () => {
    const brand = await loadBrand();
    expect(placement(brand, 'instagram').hashtagsIn).toBe('firstComment');
    expect(placement(brand, 'linkedin').linkIn).toBe('firstComment');
    expect(placement(brand, 'facebook').hashtagsIn).toBe('caption');
    expect(captionFor(c, 'instagram', brand)).toBe('More calls, less chasing. Link in bio.');
    expect(firstCommentFor(c, 'instagram', brand)).toBe('#Daedabyte #WebDesign #SmallBusiness #SEO #MtJackson');
    expect(captionFor(c, 'linkedin', brand)).toBe('A site that earns inquiries. Ask us how.\n\n#Daedabyte #WebDesign #SmallBusiness');
    expect(firstCommentFor(c, 'linkedin', brand)).toBe('https://daedabyte.com/work');
    expect(captionFor(c, 'facebook', brand)).toBe('More calls. https://daedabyte.com/contact\n\n#Daedabyte');
    expect(firstCommentFor(c, 'facebook', brand)).toBe('');
    expect(firstCommentFor(c, 'googlebusiness', brand)).toBe('');
  });
  it('a linkedin caption with no link gets the site in the first comment', async () => {
    const brand = await loadBrand();
    const noLink = { ...c, captions: { ...c.captions, linkedin: 'No link here.' } };
    expect(firstCommentFor(noLink, 'linkedin', brand)).toBe('https://daedabyte.com');
  });
  it('the Buffer payload carries the first comment in platform metadata', async () => {
    const brand = await loadBrand();
    const draft = { renderSquare: '/r/s.png', renderPortrait: '/r/p.png' } as never;
    const ig = buildPostInput(draft, c, 'instagram', '69977105d6f8d304f9300473', '2026-12-01T10:00:00-05:00', 'https://x', brand);
    expect((ig.metadata as { instagram: { firstComment: string } }).instagram.firstComment).toContain('#Daedabyte');
    expect(ig.text).not.toContain('#');
    const gb = buildPostInput(draft, c, 'googlebusiness', '69976f1ed6f8d304f92ffb30', '2026-12-01T10:00:00-05:00', 'https://x', brand);
    expect(JSON.stringify(gb.metadata)).not.toContain('firstComment');
  });
});

describe('alternates', () => {
  it('are validated like captions and must differ from the main one', async () => {
    const brand = await loadBrand();
    expect(validateContent(brand, c, {})).toEqual([]);
    const bad = { ...c, alternates: { ...c.alternates!, googlebusiness: 'Link in bio #no', instagram: c.captions.instagram } };
    const errs = validateContent(brand, bad, {}).join('\n');
    expect(errs).toMatch(/alternate googlebusiness caption contains a hashtag/);
    expect(errs).toMatch(/alternate caption for instagram is identical/);
  });
});
