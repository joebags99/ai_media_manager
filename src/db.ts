// db.ts: SQLite repository for drafts and runs (pipeline-spec dataModel). Every Claude
// request/response lives on the draft row (generationContext) so revisions can replay.
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR, DB_PATH, ORG_ID } from './config.js';

export type DraftStatus = 'pending' | 'revising' | 'approved' | 'scheduled' | 'rejected' | 'posted' | 'error' | 'archived';
/** weekOf value for drafts shelved in the library (not tied to a week). */
export const LIBRARY_WEEK = 'library';
export type Slot = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
/** Week of Monday through Sunday. Saturday and Sunday are normally empty unless a holiday falls there. */
export const SLOTS: Slot[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
export const SLOT_OFFSET: Record<Slot, number> = { mon: 0, tue: 1, wed: 2, thu: 3, fri: 4, sat: 5, sun: 6 };
export function slotDate(weekOf: string, slot: Slot): string {
  const d = new Date(`${weekOf}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + SLOT_OFFSET[slot]);
  return d.toISOString().slice(0, 10);
}

export interface Draft {
  id: string;
  orgId: string;
  weekOf: string;
  slot: Slot;
  site: string | null;
  template: string;
  version: number;
  contentJson: string;
  renderSquare: string | null;
  renderPortrait: string | null;
  status: DraftStatus;
  feedback: string | null;
  generationContext: string;
  bufferPostIds: string | null;
  scheduledAt: string | null;
  errorMessage: string | null;
  /** Status the draft had before it was shelved; restored when placed. */
  archivedStatus: DraftStatus | null;
  costUsd: number;
  createdAt: string;
  updatedAt: string;
}

export interface Run {
  id: string;
  weekOf: string;
  startedAt: string;
  finishedAt: string | null;
  draftsCreated: number;
  errors: string;
  costEstimateUsd: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS drafts (
  id TEXT PRIMARY KEY,
  orgId TEXT NOT NULL,
  weekOf TEXT NOT NULL,
  slot TEXT NOT NULL,
  site TEXT,
  template TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  contentJson TEXT NOT NULL,
  renderSquare TEXT,
  renderPortrait TEXT,
  status TEXT NOT NULL,
  feedback TEXT,
  generationContext TEXT NOT NULL,
  bufferPostIds TEXT,
  scheduledAt TEXT,
  errorMessage TEXT,
  costUsd REAL NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS drafts_week ON drafts(orgId, weekOf, slot, version);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  weekOf TEXT NOT NULL,
  startedAt TEXT NOT NULL,
  finishedAt TEXT,
  draftsCreated INTEGER NOT NULL DEFAULT 0,
  errors TEXT NOT NULL DEFAULT '[]',
  costEstimateUsd REAL NOT NULL DEFAULT 0
);`;

let db: Database.Database | undefined;

export function openDb(file = DB_PATH): Database.Database {
  if (db) return db;
  mkdirSync(path.dirname(file), { recursive: true });
  db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  // Additive migrations for columns added after the first release.
  const cols = new Set((db.prepare('PRAGMA table_info(drafts)').all() as { name: string }[]).map((c) => c.name));
  if (!cols.has('archivedStatus')) db.exec('ALTER TABLE drafts ADD COLUMN archivedStatus TEXT');
  return db;
}

/** For tests: point at a throwaway file. */
export function useDb(file: string): Database.Database {
  db?.close();
  db = undefined;
  return openDb(file);
}

const now = () => new Date().toISOString();

export type NewDraft = Pick<Draft, 'weekOf' | 'slot' | 'site' | 'template' | 'contentJson' | 'generationContext' | 'costUsd'> &
  Partial<Pick<Draft, 'status' | 'version' | 'renderSquare' | 'renderPortrait' | 'feedback' | 'bufferPostIds' | 'scheduledAt'>>;

export function insertDraft(d: NewDraft): Draft {
  const row: Draft = {
    id: randomUUID(),
    orgId: ORG_ID,
    version: 1,
    status: 'pending',
    renderSquare: null,
    renderPortrait: null,
    feedback: null,
    bufferPostIds: null,
    scheduledAt: null,
    errorMessage: null,
    archivedStatus: null,
    createdAt: now(),
    updatedAt: now(),
    ...d,
  };
  openDb()
    .prepare(
      `INSERT INTO drafts (id, orgId, weekOf, slot, site, template, version, contentJson, renderSquare, renderPortrait, status, feedback, generationContext, bufferPostIds, scheduledAt, errorMessage, archivedStatus, costUsd, createdAt, updatedAt)
       VALUES (@id, @orgId, @weekOf, @slot, @site, @template, @version, @contentJson, @renderSquare, @renderPortrait, @status, @feedback, @generationContext, @bufferPostIds, @scheduledAt, @errorMessage, @archivedStatus, @costUsd, @createdAt, @updatedAt)`,
    )
    .run(row);
  return row;
}

export function updateDraft(id: string, patch: Partial<Omit<Draft, 'id' | 'orgId' | 'createdAt'>>): Draft {
  const keys = Object.keys(patch) as (keyof typeof patch)[];
  if (keys.length === 0) return getDraft(id)!;
  const sets = [...keys.map((k) => `${k} = @${k}`), 'updatedAt = @updatedAt'].join(', ');
  openDb()
    .prepare(`UPDATE drafts SET ${sets} WHERE id = @id`)
    .run({ ...patch, id, updatedAt: now() });
  return getDraft(id)!;
}

/** Permanently remove a draft row (renders on disk are left alone). */
export function deleteDraft(id: string): void {
  openDb().prepare('DELETE FROM drafts WHERE id = ? AND orgId = ?').run(id, ORG_ID);
}

export function getDraft(id: string): Draft | undefined {
  return openDb().prepare('SELECT * FROM drafts WHERE id = ?').get(id) as Draft | undefined;
}

export function listDrafts(opts: { weekOf?: string; status?: DraftStatus | DraftStatus[]; latestOnly?: boolean } = {}): Draft[] {
  const where: string[] = ['orgId = @orgId'];
  const params: Record<string, unknown> = { orgId: ORG_ID };
  if (!opts.weekOf) where.push(`weekOf != '${LIBRARY_WEEK}'`);
  if (opts.weekOf) {
    where.push('weekOf = @weekOf');
    params['weekOf'] = opts.weekOf;
  }
  if (opts.status) {
    const list = Array.isArray(opts.status) ? opts.status : [opts.status];
    where.push(`status IN (${list.map((_, i) => `@s${i}`).join(',')})`);
    list.forEach((s, i) => (params[`s${i}`] = s));
  }
  if (opts.latestOnly) {
    // Shelved rows and superseded versions ('revising') never count as a slot's current draft.
    where.push("status NOT IN ('archived', 'revising') AND version = (SELECT MAX(version) FROM drafts d2 WHERE d2.orgId = drafts.orgId AND d2.weekOf = drafts.weekOf AND d2.slot = drafts.slot AND d2.status NOT IN ('archived', 'revising'))");
  }
  return openDb()
    .prepare(`SELECT * FROM drafts WHERE ${where.join(' AND ')} ORDER BY weekOf DESC, CASE slot WHEN 'mon' THEN 1 WHEN 'tue' THEN 2 WHEN 'wed' THEN 3 WHEN 'thu' THEN 4 WHEN 'fri' THEN 5 WHEN 'sat' THEN 6 ELSE 7 END, version DESC`)
    .all(params) as Draft[];
}

export function listLibrary(): Draft[] {
  return openDb().prepare('SELECT * FROM drafts WHERE orgId = ? AND status = ? ORDER BY updatedAt DESC').all(ORG_ID, 'archived') as Draft[];
}

/** Highest version in a week/slot (0 when empty). */
export function maxVersion(weekOf: string, slot: Slot): number {
  const r = openDb().prepare('SELECT MAX(version) AS v FROM drafts WHERE orgId = ? AND weekOf = ? AND slot = ?').get(ORG_ID, weekOf, slot) as { v: number | null };
  return r.v ?? 0;
}

/** The slot's current draft (latest version), if any and not shelved/rejected. */
export function currentDraft(weekOf: string, slot: Slot): Draft | undefined {
  return listDrafts({ weekOf, latestOnly: true }).find((d) => d.slot === slot && d.status !== 'rejected' && d.status !== 'archived');
}

export function recentDraftSummaries(limit = 20): { weekOf: string; slot: string; template: string; site: string | null; headline: string }[] {
  const rows = openDb()
    .prepare("SELECT weekOf, slot, template, site, contentJson FROM drafts WHERE orgId = ? AND status NOT IN ('rejected', 'archived', 'revising') ORDER BY createdAt DESC LIMIT ?")
    .all(ORG_ID, limit) as { weekOf: string; slot: string; template: string; site: string | null; contentJson: string }[];
  return rows.map((r) => {
    const c = JSON.parse(r.contentJson) as { slots?: Record<string, string> };
    const s = c.slots ?? {};
    return { weekOf: r.weekOf, slot: r.slot, template: r.template, site: r.site, headline: s['headline'] ?? s['claim'] ?? s['verdict'] ?? s['quote'] ?? '' };
  });
}

export function startRun(weekOf: string): Run {
  const run: Run = { id: randomUUID(), weekOf, startedAt: now(), finishedAt: null, draftsCreated: 0, errors: '[]', costEstimateUsd: 0 };
  openDb().prepare('INSERT INTO runs (id, weekOf, startedAt, finishedAt, draftsCreated, errors, costEstimateUsd) VALUES (@id, @weekOf, @startedAt, @finishedAt, @draftsCreated, @errors, @costEstimateUsd)').run(run);
  return run;
}

export function finishRun(id: string, patch: Pick<Run, 'draftsCreated' | 'errors' | 'costEstimateUsd'>): void {
  openDb().prepare('UPDATE runs SET finishedAt = @finishedAt, draftsCreated = @draftsCreated, errors = @errors, costEstimateUsd = @costEstimateUsd WHERE id = @id').run({ ...patch, id, finishedAt: now() });
}

export function listRuns(limit = 10): Run[] {
  return openDb().prepare('SELECT * FROM runs ORDER BY startedAt DESC LIMIT ?').all(limit) as Run[];
}

/** The Monday of the week containing an ISO date (any weekday snaps back to its Monday). */
export function mondayOf(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`Bad date "${isoDate}"`);
  const day = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - (day === 0 ? 6 : day - 1));
  return d.toISOString().slice(0, 10);
}

/** ISO date of the Monday on or after `from` (next week's Monday when from is a Monday already in progress). */
export function nextWeekOf(from = new Date()): string {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const day = d.getUTCDay(); // 0 Sun .. 6 Sat
  const add = day === 0 ? 1 : 8 - day;
  d.setUTCDate(d.getUTCDate() + add);
  return d.toISOString().slice(0, 10);
}
