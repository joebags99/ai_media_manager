import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { useDb, insertDraft, startRun, finishRun } from '../src/db.js';
import { buildDigest, sendDigest } from '../src/notify.js';

beforeAll(async () => {
  useDb(path.join(await mkdtemp(path.join(tmpdir(), 'nt-')), 'test.db'));
  const slots = ['mon', 'tue', 'wed', 'thu', 'fri'] as const;
  for (const slot of slots) {
    insertDraft({ weekOf: '2026-11-16', slot, site: slot === 'wed' ? 'sample-local' : null, template: 'list', costUsd: 0.06, generationContext: '{}', renderSquare: `/r/${slot}-square.png`, renderPortrait: `/r/${slot}-portrait.png`,
      contentJson: JSON.stringify({ rationale: `Why ${slot}.`, slots: {}, captions: {}, hashtags: {} }) });
  }
  const run = startRun('2026-11-16');
  finishRun(run.id, { draftsCreated: 5, errors: JSON.stringify(['capture x: timeout']), costEstimateUsd: 0.3 });
});

describe('digest', () => {
  it('lists every draft with a thumbnail and a review link, plus run errors', () => {
    const d = buildDigest('2026-11-16', 'https://ads.example');
    expect(d.subject).toBe('Daedabyte ads: 5 drafts for the week of 2026-11-16 (5 to review)');
    expect(d.html.match(/<img /g)).toHaveLength(5);
    expect(d.html).toContain('https://ads.example/renders/wed-square.png');
    expect(d.html).toContain('https://ads.example/?week=2026-11-16');
    expect(d.html).toContain('capture x: timeout');
    expect(d.text).toMatch(/Wednesday: list \(sample-local\) \[pending\] https:\/\/ads\.example\/drafts\//);
  });
  it('without SMTP_URL it writes the file and logs instead of sending', async () => {
    delete process.env.SMTP_URL;
    const log: string[] = [];
    const r = await sendDigest('2026-11-16', { log: (l) => log.push(l), base: 'https://ads.example' });
    expect(r.sent).toBe(false);
    expect((await readFile(r.file, 'utf8')).length).toBeGreaterThan(500);
    expect(log.some((l) => /SMTP_URL.*not set/.test(l))).toBe(true);
  });
});
