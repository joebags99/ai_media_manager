// Site recipes: sites/<slug>.json describes how to capture one client site.
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { ROOT, SITES_DIR } from './config.js';

export interface SiteSection {
  name: string;
  selector: string;
}

export interface SiteRecipe {
  /** CSS selectors to click if present (cookie banners, popups). */
  dismiss?: string[];
  /** CSS selectors that must be present before capturing. */
  waitFor?: string[];
  /** Extra settle time after load, in ms. */
  settleMs?: number;
  sections: SiteSection[];
}

export interface Site {
  slug: string;
  name: string;
  url: string;
  industry: string;
  permissionToName: boolean;
  recipe: SiteRecipe;
}

export async function loadSite(slug: string): Promise<Site> {
  if (!/^[a-z0-9-]+$/.test(slug)) throw new Error(`Bad site slug "${slug}"`);
  let raw: string;
  try {
    raw = await readFile(path.join(SITES_DIR, `${slug}.json`), 'utf8');
  } catch {
    throw new Error(`No recipe at sites/${slug}.json`);
  }
  const site = { slug, ...(JSON.parse(raw) as Omit<Site, 'slug'>) };
  // Local fixture sites use file:// URLs relative to the repo.
  site.url = site.url.replace('__ROOT__', ROOT);
  if (!site.url || !site.recipe?.sections?.length) throw new Error(`sites/${slug}.json needs url and recipe.sections`);
  return site;
}

export async function listSites(): Promise<Site[]> {
  const files = (await readdir(SITES_DIR)).filter((f) => f.endsWith('.json')).sort();
  return Promise.all(files.map((f) => loadSite(f.replace(/\.json$/, ''))));
}
