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

describe('google import', () => {
  it('adds new 4+ star reviews, skips duplicates and short ones', async () => {
    const { importGoogleReviews, listReviews, removeReview } = await import('../src/reviews.js');
    const before = await listReviews();
    const payload = { displayName: { text: 'Daedabyte Web Solutions' }, reviews: [
      { name: 'r1', rating: 5, text: { text: 'Joe rebuilt our whole site and it finally loads fast on phones.' }, authorAttribution: { displayName: 'Pat Lee' }, publishTime: '2026-09-01T12:00:00Z' },
      { name: 'r2', rating: 3, text: { text: 'It was okay, took a while to get going but ended up fine.' }, authorAttribution: { displayName: 'Meh' } },
      { name: 'r3', rating: 5, text: { text: 'Great.' }, authorAttribution: { displayName: 'Short' } },
      { name: 'r4', rating: 5, text: { text: 'Joe rebuilt our whole site and it finally loads fast on phones.' }, authorAttribution: { displayName: 'Dup' } },
    ] };
    const fakeFetch = (async () => new Response(JSON.stringify(payload), { status: 200 })) as unknown as typeof fetch;
    const log: string[] = [];
    const r = await importGoogleReviews({ apiKey: 'k', placeId: 'p', fetch: fakeFetch }, (l) => log.push(l));
    try {
      expect(r.place).toBe('Daedabyte Web Solutions');
      expect(r.added.map((a) => a.name)).toEqual(['Pat Lee']);
      expect(r.added[0]!.date).toBe('2026-09-01');
      expect(r.skipped).toBe(3);
      const again = await importGoogleReviews({ apiKey: 'k', placeId: 'p', fetch: fakeFetch }, () => {});
      expect(again.added).toHaveLength(0);
    } finally {
      for (const a of (await listReviews()).filter((x) => !before.some((b) => b.id === x.id))) await removeReview(a.id);
    }
  });
});
