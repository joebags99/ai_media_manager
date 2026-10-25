import { describe, it, expect } from 'vitest';
import { reviewForQuote, type Review } from '../src/reviews.js';
import { validateContent, type DraftContent } from '../src/validate.js';
import { loadBrand } from '../src/render.js';

const reviews: Review[] = [
  { id: '1', name: 'Dana Whitfield', business: 'Valley Tile & Stone', text: 'They rebuilt our site in three weeks. The phone has not stopped ringing since, and the booking form just works.', source: 'google', date: '2026-03-02', addedAt: '' },
  { id: '2', name: 'Sam Ortiz', business: 'Ortiz Bakery', text: 'Clear communication, fair price, and a site I can update myself.', source: 'site', date: null, addedAt: '' },
];
const base = (slots: Record<string, string>): DraftContent => ({ template: 'quote', slots, crop: { screenshot: null, region: null, treatment: 'framed' }, captions: { instagram: 'a', facebook: 'b', linkedin: 'c', googlebusiness: 'd' }, hashtags: { instagram: ['#Daedabyte', '#WebDesign', '#SmallBusiness', '#SEO', '#MtJackson'], facebook: [], linkedin: ['#Daedabyte', '#WebDesign', '#SmallBusiness'] }, rationale: 'r' });

describe('quotes from reviews', () => {
  it('matches a verbatim passage ignoring punctuation and curly quotes', () => {
    expect(reviewForQuote('The phone has not stopped ringing since', reviews)?.id).toBe('1');
    expect(reviewForQuote('“Clear communication, fair price”', reviews)?.id).toBe('2');
    expect(reviewForQuote('They rebuilt our site in two weeks', reviews)).toBeNull();
  });
  it('validation rejects paraphrases and wrong attribution', async () => {
    const brand = await loadBrand();
    expect(validateContent(brand, base({ quote: 'They rebuilt our site in three weeks. The phone has not stopped ringing since', name: 'Dana W.', business: 'Valley Tile & Stone' }), {}, 'quote', reviews)).toEqual([]);
    expect(validateContent(brand, base({ quote: 'They rebuilt the whole site fast and the phone rings constantly', name: 'Dana W.', business: 'x' }), {}, 'quote', reviews)).toContain('quote is not a verbatim passage of any review on file');
    expect(validateContent(brand, base({ quote: 'fair price, and a site I can update myself', name: 'Dana W.', business: 'x' }), {}, 'quote', reviews).join()).toMatch(/from Sam Ortiz/);
  });
  it('mobile needs a mobile shot and backdrop needs dimmed', async () => {
    const brand = await loadBrand();
    const dims = { 'hero-desktop.png': { width: 1440, height: 800 }, 'page-mobile.png': { width: 390, height: 844 } };
    const m = base({ headline: 'Made for phones.', accentWord: 'phones', support: 'x' });
    expect(validateContent(brand, { ...m, template: 'mobile', crop: { screenshot: 'hero-desktop.png', region: null, treatment: 'framed' } }, dims)).toContain('mobile template needs a -mobile.png screenshot');
    expect(validateContent(brand, { ...m, template: 'mobile', crop: { screenshot: 'page-mobile.png', region: null, treatment: 'framed' } }, dims)).toEqual([]);
    const b = base({ line1: 'Three weeks.', line2: 'One site.', line3: 'Built to last.' });
    expect(validateContent(brand, { ...b, template: 'backdrop', crop: { screenshot: 'hero-desktop.png', region: null, treatment: 'framed' } }, dims)).toContain('backdrop template needs crop.treatment "dimmed"');
  });
});
