// Site recipes: sites/<slug>.json describes how to capture one client site.
import { readFile, readdir, writeFile } from 'node:fs/promises';
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

export type SiteKind = 'own' | 'client';

export interface Site {
  slug: string;
  name: string;
  url: string;
  industry: string;
  /** own = Daedabyte's own site(s): first-person copy, never presented as a client. */
  kind: SiteKind;
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
  const site = { kind: 'client' as SiteKind, ...(JSON.parse(raw) as Omit<Site, 'slug' | 'kind'> & { kind?: SiteKind }), slug };
  if (site.kind === 'own') site.permissionToName = true;
  // Local fixture sites use file:// URLs relative to the repo.
  site.url = site.url.replace('__ROOT__', ROOT);
  if (!site.url || !site.recipe?.sections?.length) throw new Error(`sites/${slug}.json needs url and recipe.sections`);
  return site;
}

export async function listSites(): Promise<Site[]> {
  const files = (await readdir(SITES_DIR)).filter((f) => f.endsWith('.json')).sort();
  return Promise.all(files.map((f) => loadSite(f.replace(/\.json$/, ''))));
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

/** Validate and write sites/<slug>.json. Returns the saved site. */
export async function saveSite(input: Omit<Site, 'slug' | 'kind'> & { slug?: string; kind?: SiteKind }): Promise<Site> {
  const slug = input.slug?.trim() || slugify(input.name);
  if (!/^[a-z0-9-]+$/.test(slug)) throw new Error(`Bad site slug "${slug}"`);
  if (!input.name?.trim()) throw new Error('Site needs a name');
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    throw new Error(`"${input.url}" is not a valid URL`);
  }
  if (!['http:', 'https:', 'file:'].includes(url.protocol)) throw new Error('URL must be http(s)');
  const sections = (input.recipe?.sections ?? []).filter((s) => s.name?.trim() && s.selector?.trim());
  if (sections.length === 0) throw new Error('Add at least one section (name + CSS selector)');
  for (const s of sections) {
    if (!/^[a-z0-9-]+$/.test(s.name)) throw new Error(`Section name "${s.name}" must be lowercase letters, digits, dashes`);
  }
  const site: Site = {
    slug,
    name: input.name.trim(),
    url: input.url.trim(),
    industry: (input.industry ?? '').trim(),
    kind: input.kind === 'own' ? 'own' : 'client',
    permissionToName: input.kind === 'own' ? true : Boolean(input.permissionToName),
    recipe: {
      dismiss: (input.recipe.dismiss ?? []).map((s) => s.trim()).filter(Boolean),
      waitFor: (input.recipe.waitFor ?? []).map((s) => s.trim()).filter(Boolean),
      settleMs: input.recipe.settleMs ?? 800,
      sections,
    },
  };
  const { slug: _slug, ...body } = site;
  await writeFile(path.join(SITES_DIR, `${slug}.json`), JSON.stringify(body, null, 2) + '\n');
  return site;
}
