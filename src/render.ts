// render.ts: fill templates/<template>.html with draft slot values, set CSS variables
// from brand/brand.json, and screenshot at 1080x1080 (square) and 1080x1350 (portrait).
//
// Usage:
//   npm run render:fixtures            renders every fixtures/*.json to data/renders/
//   import { renderDraft } from './render.js'

import { chromium, type Browser } from 'playwright';
import { readFile, readdir, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRAND_PATH = path.join(ROOT, 'brand', 'brand.json');
const FONTS_DIR = path.join(ROOT, 'brand', 'assets', 'fonts');
const ICON_PATH = path.join(ROOT, 'brand', 'assets', 'icon.svg');
const TEMPLATES_DIR = path.join(ROOT, 'templates');
const FIXTURES_DIR = path.join(ROOT, 'fixtures');
export const RENDERS_DIR = path.join(ROOT, 'data', 'renders');

export type TemplateName = 'list' | 'stat' | 'quote' | 'screenshot' | 'headline' | 'question' | 'tip' | 'holiday';
export type Format = 'square' | 'portrait';
export type Region = [number, number, number, number];

export interface Crop {
  screenshot: string | null;
  region: Region | null;
  treatment: 'framed' | 'dimmed';
}

export interface RenderInput {
  id: string;
  template: TemplateName;
  slots: Record<string, string>;
  crop?: Crop | null;
  /** Overrides the template's default background (e.g. "screenshotDim" for stat). */
  bg?: string;
  /** Directory that crop.screenshot is resolved against. */
  screenshotDir?: string;
  /** Seasonal theme name from brand.json "seasonal.themes" (e.g. "halloween"); accents only. */
  theme?: string | null;
}

export interface RenderResult {
  square: string;
  portrait: string;
}

interface FontSpec {
  family: string;
  weight: number;
  tracking?: string;
  transform?: string;
}

export interface Brand {
  name: string;
  site: string;
  colors: Record<string, string>;
  accentOrder: string[];
  fonts: Record<'display' | 'body' | 'eyebrow', FontSpec>;
  canvas: { square: [number, number]; portrait: [number, number]; paddingPct: number; rulePx: number; iconPct: number };
  templates: Record<string, { slots: string[]; align: string; bg: string }>;
  seasonal?: { themes: Record<string, { accentOrder?: string[]; colors?: Record<string, string> }> };
  [key: string]: unknown;
}

/** Brand with a seasonal theme's accent overrides applied. Unknown theme = brand as is. */
export function applyTheme(brand: Brand, theme: string | null | undefined): Brand {
  const t = theme ? brand.seasonal?.themes[theme] : undefined;
  if (!t) return brand;
  return { ...brand, colors: { ...brand.colors, ...(t.colors ?? {}) }, accentOrder: t.accentOrder ?? brand.accentOrder };
}

export async function loadBrand(): Promise<Brand> {
  return JSON.parse(await readFile(BRAND_PATH, 'utf8')) as Brand;
}

/** Slots that hold text. `crop` is structured data on the draft, not text. */
export function textSlots(brand: Brand, template: TemplateName): string[] {
  const def = brand.templates[template];
  if (!def) throw new Error(`Unknown template "${template}"; brand.json defines: ${Object.keys(brand.templates).join(', ')}`);
  return def.slots.filter((s) => s !== 'crop');
}

// Font files are named <family-kebab>-<subset>-<weight>-<normal|italic>.woff2 (Fontsource naming).
async function fontFaceCss(brand: Brand): Promise<string> {
  let files: string[] = [];
  try {
    files = (await readdir(FONTS_DIR)).filter((f) => /\.(woff2?|ttf|otf)$/.test(f));
  } catch {
    // handled below by the per-family warning
  }
  const families = [...new Set(Object.values(brand.fonts).map((f) => f.family))];
  const rules: string[] = [];
  for (const family of families) {
    const prefix = family.toLowerCase().replace(/\s+/g, '-');
    const matches = files.filter((f) => f.startsWith(prefix + '-'));
    if (matches.length === 0) {
      console.warn(`[render] No font files for "${family}" in brand/assets/fonts/; falling back to system sans-serif.`);
      continue;
    }
    for (const file of matches) {
      const m = /-(\d{3})-(normal|italic)\./.exec(file);
      const weight = m?.[1] ?? '400';
      const style = m?.[2] ?? 'normal';
      const ext = path.extname(file).slice(1);
      const format = ext === 'ttf' ? 'truetype' : ext === 'otf' ? 'opentype' : ext;
      const data = (await readFile(path.join(FONTS_DIR, file))).toString('base64');
      rules.push(
        `@font-face{font-family:"${family}";font-weight:${weight};font-style:${style};font-display:block;` +
          `src:url(data:font/${ext};base64,${data}) format("${format}");}`,
      );
    }
  }
  return rules.join('\n');
}

export function brandVarsCss(brand: Brand, width: number): string {
  const vars: string[] = [];
  for (const [name, hex] of Object.entries(brand.colors)) vars.push(`--color-${name}:${hex}`);
  brand.accentOrder.forEach((name, i) => vars.push(`--accent-${i + 1}:var(--color-${name})`));
  for (const [role, f] of Object.entries(brand.fonts)) {
    vars.push(`--font-${role}:"${f.family}",system-ui,sans-serif`);
    vars.push(`--font-${role}-weight:${f.weight}`);
    vars.push(`--font-${role}-tracking:${f.tracking ?? 'normal'}`);
    vars.push(`--font-${role}-transform:${f.transform ?? 'none'}`);
  }
  vars.push(`--pad:${Math.round((width * brand.canvas.paddingPct) / 100)}px`);
  vars.push(`--rule:${brand.canvas.rulePx}px`);
  vars.push(`--icon:${Math.round((width * brand.canvas.iconPct) / 100)}px`);
  return `:root{${vars.join(';')}}`;
}

const PLACEHOLDER_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect x="4" y="4" width="40" height="40" fill="none" stroke="currentColor" stroke-width="5"/></svg>';

async function loadIcon(): Promise<string> {
  try {
    return (await readFile(ICON_PATH, 'utf8')).replace(/<\?xml[^>]*\?>/, '').replace(/<!--[\s\S]*?-->/g, '').trim();
  } catch {
    console.warn('[render] brand/assets/icon.svg is missing; using a placeholder square.');
    return PLACEHOLDER_ICON;
  }
}

async function imageDataUri(file: string): Promise<string> {
  const ext = path.extname(file).slice(1).toLowerCase();
  const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'svg' ? 'image/svg+xml' : `image/${ext}`;
  return `data:${mime};base64,${(await readFile(file)).toString('base64')}`;
}

// Runs inside the page. Kept as a string so the TS toolchain can't inject helpers into it.
const PAGE_RUNTIME = String.raw`
window.__ad = {
  fill(p) {
    const root = document.documentElement;
    root.dataset.format = p.format;
    if (p.bg) root.dataset.bg = p.bg;
    if (p.treatment) root.dataset.treatment = p.treatment;

    const consumed = new Set();
    for (const el of document.querySelectorAll('[data-slot]')) {
      const name = el.dataset.slot;
      if (!(name in p.slots)) throw new Error('Missing slot "' + name + '"');
      consumed.add(name);
      const text = p.slots[name];
      const accentSlot = el.dataset.accentSlot;
      if (accentSlot) {
        consumed.add(accentSlot);
        const word = p.slots[accentSlot] || '';
        const i = word ? text.toLowerCase().indexOf(word.toLowerCase()) : -1;
        if (i < 0) throw new Error('Accent word "' + word + '" does not appear in slot "' + name + '"');
        const span = document.createElement('span');
        span.className = 'accent';
        span.textContent = text.slice(i, i + word.length);
        el.replaceChildren(document.createTextNode(text.slice(0, i)), span, document.createTextNode(text.slice(i + word.length)));
      } else {
        el.textContent = text;
      }
    }
    for (const el of document.querySelectorAll('[data-brand]')) el.textContent = p.brand[el.dataset.brand] ?? '';
    for (const el of document.querySelectorAll('[data-icon]')) el.innerHTML = p.icon;
    if (p.image) for (const img of document.querySelectorAll('[data-crop] img')) img.src = p.image;
    return [...consumed];
  },

  async ready() {
    await Promise.all([...document.fonts].map((f) => f.load().catch(() => {})));
    await document.fonts.ready;
    await Promise.all([...document.images].filter((i) => i.src).map((i) => i.decode().catch(() => {})));
  },

  // Shrink text until it fits. [data-fit-width=group] elements are single-line and share
  // one size per group; then every [data-fit-box] shrinks its [data-fit] children together
  // until nothing overflows vertically.
  fit() {
    const size = (el) => parseFloat(getComputedStyle(el).fontSize);
    const groups = new Map();
    for (const el of document.querySelectorAll('[data-fit-width]')) {
      const g = el.dataset.fitWidth;
      const ratio = Math.min(1, el.clientWidth / el.scrollWidth);
      groups.set(g, Math.min(groups.get(g) ?? Infinity, size(el) * ratio));
    }
    for (const el of document.querySelectorAll('[data-fit-width]')) {
      el.style.fontSize = Math.floor(Math.min(size(el), groups.get(el.dataset.fitWidth))) + 'px';
    }
    // Compare layout boxes, not scrollHeight: scrollHeight includes glyph ink overflow,
    // which never goes away on a box that is sized to its content.
    const overflows = (box) => {
      const b = box.getBoundingClientRect();
      return [...box.children].some((c) => {
        const r = c.getBoundingClientRect();
        return r.bottom > b.bottom + 1 || r.top < b.top - 1;
      });
    };
    const shrunk = [];
    for (const box of document.querySelectorAll('[data-fit-box]')) {
      let guard = 0;
      while (overflows(box) && guard++ < 60) {
        for (const el of box.querySelectorAll('[data-fit]')) el.style.fontSize = size(el) * 0.96 + 'px';
      }
      if (guard > 0) shrunk.push(box.className);
    }
    return shrunk;
  },

  // Place the crop region of the screenshot inside each [data-crop] element.
  // contain: shrink the frame to the region's aspect ratio inside [data-crop-area].
  // cover: fill the element, centered on the region.
  placeCrop(region) {
    for (const view of document.querySelectorAll('[data-crop]')) {
      if (view.getClientRects().length === 0) continue; // hidden by the current treatment
      const img = view.querySelector('img');
      if (!img || !img.naturalWidth) continue;
      const [x, y, w, h] = region || [0, 0, img.naturalWidth, img.naturalHeight];
      if (w <= 0 || h <= 0 || x < 0 || y < 0 || x + w > img.naturalWidth || y + h > img.naturalHeight) {
        throw new Error('Crop region [' + [x, y, w, h] + '] falls outside the ' + img.naturalWidth + 'x' + img.naturalHeight + ' screenshot');
      }
      let W, H;
      if (view.dataset.crop === 'contain') {
        const area = view.closest('[data-crop-area]');
        const frame = view.closest('[data-crop-frame]') || view;
        // Measure the frame's chrome (borders, toolbar) at a size larger than the toolbar's min width.
        view.style.width = '400px';
        view.style.height = '400px';
        const chromeW = frame.offsetWidth - 400;
        const chromeH = frame.offsetHeight - 400;
        const s = Math.min((area.clientWidth - chromeW) / w, (area.clientHeight - chromeH) / h);
        W = Math.floor(w * s);
        H = Math.floor(h * s);
        view.style.width = W + 'px';
        view.style.height = H + 'px';
      } else {
        W = view.clientWidth;
        H = view.clientHeight;
      }
      const s = view.dataset.crop === 'contain' ? W / w : Math.max(W / w, H / h);
      const ox = (W - w * s) / 2;
      const oy = (H - h * s) / 2;
      Object.assign(img.style, {
        position: 'absolute',
        maxWidth: 'none',
        width: img.naturalWidth * s + 'px',
        height: img.naturalHeight * s + 'px',
        left: ox - x * s + 'px',
        top: oy - y * s + 'px',
      });
    }
  },
};
`;

function validateInput(brand: Brand, input: RenderInput): void {
  for (const slot of textSlots(brand, input.template)) {
    const v = input.slots[slot];
    if (typeof v !== 'string' || v.trim() === '') throw new Error(`[${input.id}] slot "${slot}" is missing or empty`);
  }
  const needsShot = input.template === 'screenshot' || input.bg === 'screenshotDim';
  if (needsShot && !input.crop?.screenshot) throw new Error(`[${input.id}] template needs crop.screenshot`);
}

export interface RenderOptions {
  outDir?: string;
  browser?: Browser;
}

export async function renderDraft(input: RenderInput, opts: RenderOptions = {}): Promise<RenderResult> {
  const brand = applyTheme(await loadBrand(), input.theme);
  validateInput(brand, input);
  const outDir = opts.outDir ?? RENDERS_DIR;
  await mkdir(outDir, { recursive: true });

  const [templateHtml, fonts, icon] = await Promise.all([
    readFile(path.join(TEMPLATES_DIR, `${input.template}.html`), 'utf8'),
    fontFaceCss(brand),
    loadIcon(),
  ]);

  let image: string | undefined;
  if (input.crop?.screenshot) {
    const dir = input.screenshotDir ?? path.join(ROOT, 'data', 'screenshots');
    image = await imageDataUri(path.resolve(dir, input.crop.screenshot));
  }
  const bg = input.bg ?? (input.template === 'stat' && input.crop?.treatment === 'dimmed' ? 'screenshotDim' : undefined);

  const browser = opts.browser ?? (await chromium.launch());
  try {
    const result = {} as RenderResult;
    for (const format of ['square', 'portrait'] as const) {
      const [width, height] = brand.canvas[format];
      const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
      try {
        const html = templateHtml.replace(
          '</head>',
          `<style id="brand">\n${fonts}\n${brandVarsCss(brand, width)}\n</style>\n</head>`,
        );
        await page.setContent(html, { waitUntil: 'load' });
        await page.addScriptTag({ content: PAGE_RUNTIME });
        const payload = {
          format,
          bg,
          treatment: input.crop?.treatment,
          slots: input.slots,
          icon,
          image,
          brand: { name: brand.name, siteHost: new URL(brand.site).host, tagline: brand['tagline'], signoff: `From all of us at ${brand.name.split(' ')[0]}` },
        };
        const consumed = (await page.evaluate(`window.__ad.fill(${JSON.stringify(payload)})`)) as string[];
        const unused = textSlots(brand, input.template).filter((s) => !consumed.includes(s));
        if (unused.length) throw new Error(`templates/${input.template}.html has no element for slot(s): ${unused.join(', ')}`);

        await page.evaluate('window.__ad.ready()');
        for (const role of Object.values(brand.fonts)) {
          const ok = await page.evaluate(`document.fonts.check('${role.weight} 40px "${role.family}"')`);
          if (!ok) console.warn(`[render] font "${role.family}" ${role.weight} did not load; output uses a fallback.`);
        }
        const shrunk = (await page.evaluate('window.__ad.fit()')) as string[];
        if (shrunk.length) console.warn(`[render] ${input.id} ${format}: text shrunk to fit in .${shrunk.join(', .')}`);
        await page.evaluate(`window.__ad.placeCrop(${JSON.stringify(input.crop?.region ?? null)})`);

        const file = path.join(outDir, `${input.id}-${format}.png`);
        await page.screenshot({ path: file, type: 'png' });
        result[format] = file;
      } finally {
        await page.close();
      }
    }
    return result;
  } finally {
    if (!opts.browser) await browser.close();
  }
}

export async function renderFixtures(outDir = RENDERS_DIR): Promise<RenderResult[]> {
  const files = (await readdir(FIXTURES_DIR)).filter((f) => f.endsWith('.json')).sort();
  const browser = await chromium.launch();
  try {
    const out: RenderResult[] = [];
    for (const f of files) {
      const input = JSON.parse(await readFile(path.join(FIXTURES_DIR, f), 'utf8')) as RenderInput;
      input.screenshotDir ??= path.join(FIXTURES_DIR, 'screenshots');
      out.push(await renderDraft(input, { outDir, browser }));
    }
    return out;
  } finally {
    await browser.close();
  }
}

async function exists(p: string): Promise<boolean> {
  return access(p).then(
    () => true,
    () => false,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  if (args[0] === '--fixtures') {
    const results = await renderFixtures();
    for (const r of results) console.log(`${path.relative(ROOT, r.square)}\n${path.relative(ROOT, r.portrait)}`);
  } else if (args[0] && (await exists(args[0]))) {
    const input = JSON.parse(await readFile(args[0], 'utf8')) as RenderInput;
    const r = await renderDraft(input);
    console.log(`${path.relative(ROOT, r.square)}\n${path.relative(ROOT, r.portrait)}`);
  } else {
    console.error('Usage: tsx src/render.ts --fixtures | <draft.json>');
    process.exit(1);
  }
}
