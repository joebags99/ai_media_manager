import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { useDb, insertDraft, updateDraft, listDrafts, getDraft, nextWeekOf, startRun, finishRun, listRuns } from '../src/db.js';

beforeAll(async () => {
  useDb(path.join(await mkdtemp(path.join(tmpdir(), 'db-')), 'test.db'));
});

describe('db', () => {
  it('inserts, updates and lists drafts with latestOnly', () => {
    const a = insertDraft({ weekOf: '2026-11-02', slot: 'mon', site: null, template: 'list', contentJson: '{}', generationContext: '[]', costUsd: 0.01 });
    expect(getDraft(a.id)?.status).toBe('pending');
    insertDraft({ weekOf: '2026-11-02', slot: 'mon', site: null, template: 'list', contentJson: '{}', generationContext: '[]', costUsd: 0.01, version: 2 });
    updateDraft(a.id, { status: 'rejected', feedback: 'no' });
    expect(getDraft(a.id)?.feedback).toBe('no');
    expect(listDrafts({ weekOf: '2026-11-02' })).toHaveLength(2);
    const latest = listDrafts({ weekOf: '2026-11-02', latestOnly: true });
    expect(latest).toHaveLength(1);
    expect(latest[0]?.version).toBe(2);
  });
  it('tracks runs', () => {
    const r = startRun('2026-11-02');
    finishRun(r.id, { draftsCreated: 5, errors: '[]', costEstimateUsd: 0.4 });
    expect(listRuns()[0]?.draftsCreated).toBe(5);
  });
  it('computes next Monday', () => {
    expect(nextWeekOf(new Date('2026-10-25T12:00:00Z'))).toBe('2026-10-26'); // Sunday -> tomorrow
    expect(nextWeekOf(new Date('2026-10-26T12:00:00Z'))).toBe('2026-11-02'); // Monday -> next Monday
    expect(nextWeekOf(new Date('2026-10-28T12:00:00Z'))).toBe('2026-11-02'); // Wednesday
  });
});
