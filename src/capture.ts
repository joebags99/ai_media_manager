// capture.ts: load a site recipe, dismiss banners, wait for selectors, and capture
// desktop (1440px) and mobile (390px) PNGs for each named section.
// Output: data/screenshots/<slug>/<section>-<viewport>.png + manifest.json

import { chromium, type Browser, type Page } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SCREENSHOTS_DIR } from './config.js';
import { loadSite, type Site } from './sites.js';

export const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
} as const;
export type Viewport = keyof typeof VIEWPORTS;

export interface Shot {
  section: string;
  viewport: Viewport;
  file: string; // relative to the site's screenshot dir
  width: number;
  height: number;
}

export interface Manifest {
  slug: string;
  name: string;
  url: string;
  permissionToName: boolean;
  capturedAt: string;
  shots: Shot[];
  warnings: string[];
}

export interface CaptureOptions {
  browser?: Browser;
  log?: (line: string) => void;
}

export function siteDir(slug: string): string {
  return path.join(SCREENSHOTS_DIR, slug);
}

export async function readManifest(slug: string): Promise<Manifest | null> {
  try {
    return JSON.parse(await readFile(path.join(siteDir(slug), 'manifest.json'), 'utf8')) as Manifest;
  } catch {
    return null;
  }
}

/** True when a capture exists and is younger than maxAgeDays (weekly run skips those). */
export async function isCaptureFresh(slug: string, maxAgeDays = 7): Promise<boolean> {
  const m = await readManifest(slug);
  if (!m) return false;
  return Date.now() - Date.parse(m.capturedAt) < maxAgeDays * 86_400_000;
}

async function dismissBanners(page: Page, selectors: string[], log: (s: string) => void): Promise<void> {
  for (const sel of selectors) {
    const el = page.locator(sel).first();
    try {
      if (await el.isVisible({ timeout: 1500 })) {
        await el.click({ timeout: 2000 });
        log(`dismissed ${sel}`);
        await page.waitForTimeout(300);
      }
    } catch {
      // not present or not clickable; fine
    }
  }
}

async function captureViewport(page: Page, site: Site, viewport: Viewport, dir: string, log: (s: string) => void, warnings: string[]): Promise<Shot[]> {
  await page.setViewportSize(VIEWPORTS[viewport]);
  await page.goto(site.url, { waitUntil: 'networkidle', timeout: 45_000 });
  await dismissBanners(page, site.recipe.dismiss ?? [], log);
  for (const sel of site.recipe.waitFor ?? []) {
    await page.waitForSelector(sel, { timeout: 15_000 });
  }
  // Scroll the page once so lazy images load, then return to the top.
  await page.evaluate(`(async () => {
    const h = document.documentElement.scrollHeight;
    for (let y = 0; y < h; y += 700) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 80)); }
    window.scrollTo(0, 0);
  })()`);
  await page.waitForTimeout(site.recipe.settleMs ?? 500);

  const shots: Shot[] = [];
  for (const section of site.recipe.sections) {
    const file = `${section.name}-${viewport}.png`;
    const out = path.join(dir, file);
    const loc = page.locator(section.selector).first();
    if ((await loc.count()) === 0) {
      warnings.push(`${viewport}: selector for "${section.name}" not found (${section.selector})`);
      log(`warn: ${section.name} not found at ${viewport}`);
      continue;
    }
    await loc.scrollIntoViewIfNeeded();
    const box = await loc.boundingBox();
    if (!box || box.width < 10 || box.height < 10) {
      warnings.push(`${viewport}: "${section.name}" has no visible box`);
      continue;
    }
    await loc.screenshot({ path: out, type: 'png', animations: 'disabled' });
    shots.push({ section: section.name, viewport, file, width: Math.round(box.width), height: Math.round(box.height) });
    log(`captured ${file} (${Math.round(box.width)}x${Math.round(box.height)})`);
  }
  // Always keep a full-viewport shot of the top of the page too.
  const topFile = `page-${viewport}.png`;
  await page.evaluate('window.scrollTo(0, 0)');
  await page.screenshot({ path: path.join(dir, topFile), type: 'png', animations: 'disabled' });
  shots.push({ section: 'page', viewport, file: topFile, ...VIEWPORTS[viewport] });
  return shots;
}

export async function captureSite(slug: string, opts: CaptureOptions = {}): Promise<Manifest> {
  const log = opts.log ?? ((s: string) => console.log(`[capture:${slug}] ${s}`));
  const site = await loadSite(slug);
  const dir = siteDir(slug);
  await mkdir(dir, { recursive: true });
  log(`loading ${site.url}`);

  const browser = opts.browser ?? (await chromium.launch());
  const warnings: string[] = [];
  try {
    const context = await browser.newContext({ deviceScaleFactor: 1, reducedMotion: 'reduce' });
    const page = await context.newPage();
    try {
      const shots: Shot[] = [];
      for (const viewport of Object.keys(VIEWPORTS) as Viewport[]) {
        shots.push(...(await captureViewport(page, site, viewport, dir, log, warnings)));
      }
      const manifest: Manifest = {
        slug,
        name: site.name,
        url: site.url,
        permissionToName: site.permissionToName,
        capturedAt: new Date().toISOString(),
        shots,
        warnings,
      };
      await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
      log(`wrote manifest with ${shots.length} shots${warnings.length ? `, ${warnings.length} warning(s)` : ''}`);
      return manifest;
    } finally {
      await context.close();
    }
  } finally {
    if (!opts.browser) await browser.close();
  }
}
