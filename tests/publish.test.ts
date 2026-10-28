import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { useDb, insertDraft, getDraft, updateDraft } from '../src/db.js';
import { approve } from '../src/workflow.js';
import { publishDraft, deleteBufferPosts, scheduleFor, isoInZone, captionFor, TEST_OFFSET_DAYS } from '../src/publish.js';
import type { BufferConfig } from '../src/buffer.js';

const content = {
  template: 'stat',
  slots: { number: '40%', claim: 'Average lift in inquiries.', kicker: 'Start your project.' },
  crop: { screenshot: null, region: null, treatment: 'framed' },
  captions: { instagram: 'IG caption. Link in bio.', facebook: 'FB caption.', linkedin: 'LI caption.', googlebusiness: 'GB caption.' },
  hashtags: { instagram: ['#Daedabyte', '#WebDesign', '#SmallBusiness', '#SEO', '#MtJackson'], facebook: [], linkedin: ['#Daedabyte', '#WebDesign', '#SmallBusiness'] },
  rationale: 'r',
};

/** Records every GraphQL call and answers like Buffer would. */
function fakeBuffer() {
  const calls: { query: string; variables: Record<string, unknown> }[] = [];
  let n = 0;
  const cfg: BufferConfig = {
    token: 't',
    url: 'https://fake.buffer.test',
    fetch: (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };
      calls.push(body);
      let data: unknown;
      if (/createPost/.test(body.query)) data = { createPost: { __typename: 'PostActionSuccess', post: { id: `post${++n}`.padEnd(24, '0'), status: 'scheduled', dueAt: (body.variables['input'] as { dueAt: string }).dueAt } } };
      else if (/deletePost/.test(body.query)) data = { deletePost: { __typename: 'DeletePostSuccess', id: (body.variables['input'] as { id: string }).id } };
      else data = {};
      return new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch,
  };
  return { cfg, calls };
}

function newDraft(status: 'pending' | 'approved' = 'pending') {
  const d = insertDraft({ weekOf: '2026-11-02', slot: 'tue', site: null, template: 'stat', contentJson: JSON.stringify(content), generationContext: '{}', costUsd: 0, renderSquare: '/x/a-square.png', renderPortrait: '/x/a-portrait.png' });
  return status === 'approved' ? approve(d.id) : d;
}

beforeAll(async () => {
  useDb(path.join(await mkdtemp(path.join(tmpdir(), 'pub-')), 'test.db'));
  process.env.PUBLIC_BASE_URL = 'https://example.test';
});

describe('publish guardrails', () => {
  it('a pending draft cannot be published: no request reaches Buffer', async () => {
    const { cfg, calls } = fakeBuffer();
    const d = newDraft('pending');
    await expect(publishDraft(d.id, { cfg, log: () => {} })).rejects.toThrow(/only approved drafts/);
    expect(calls).toHaveLength(0);
    expect(getDraft(d.id)!.status).toBe('pending');
    expect(getDraft(d.id)!.bufferPostIds).toBeNull();
  });

  it('rejected, revising and scheduled drafts cannot be published either', async () => {
    const { cfg, calls } = fakeBuffer();
    for (const status of ['rejected', 'revising', 'scheduled', 'error'] as const) {
      const d = insertDraft({ weekOf: '2026-11-02', slot: 'mon', site: null, template: 'stat', contentJson: JSON.stringify(content), generationContext: '{}', costUsd: 0, status, renderSquare: '/x/s.png', renderPortrait: '/x/p.png' });
      await expect(publishDraft(d.id, { cfg, log: () => {} })).rejects.toThrow(/only approved/);
    }
    expect(calls).toHaveLength(0);
  });

  it('in test mode an approved draft is scheduled 60 days out on all four channels and the delete command is logged', async () => {
    const { cfg, calls } = fakeBuffer();
    const d = newDraft('approved');
    const now = new Date('2026-10-25T12:00:00Z');
    const log: string[] = [];
    const r = await publishDraft(d.id, { cfg, log: (l) => log.push(l), now, testMode: true });
    expect(calls).toHaveLength(4);
    const inputs = calls.map((c) => c.variables['input'] as { channelId: string; dueAt: string; mode: string; text: string; assets: { image: { url: string } }[]; metadata: Record<string, unknown> });
    expect(new Set(inputs.map((i) => i.channelId)).size).toBe(4);
    for (const i of inputs) {
      expect(i.mode).toBe('customScheduled');
      expect(new Date(i.dueAt).getTime() - now.getTime()).toBeGreaterThan((TEST_OFFSET_DAYS - 1) * 86_400_000);
      expect(i.assets[0]!.image.url).toMatch(/^https:\/\/example\.test\/renders\/a-(square|portrait)\.png$/);
    }
    const ig = inputs.find((i) => (i.metadata as { instagram?: unknown }).instagram)!;
    expect(ig.assets[0]!.image.url).toContain('portrait');
    expect((ig.metadata as { instagram: { firstComment: string } }).instagram.firstComment).toContain('#Daedabyte'); // hashtags ride in the first comment per brand.json
    const gb = inputs.find((i) => (i.metadata as { google?: unknown }).google)!;
    expect(gb.text).not.toMatch(/#/);
    const after = getDraft(d.id)!;
    expect(after.status).toBe('scheduled');
    expect(Object.keys(JSON.parse(after.bufferPostIds!))).toEqual(['instagram', 'facebook', 'linkedin', 'googlebusiness']);
    expect(r.deleteCommand).toMatch(/^npm run buffer:delete -- post1/);
    expect(log.some((l) => l.includes(r.deleteCommand))).toBe(true);

    // and the logged command removes them and returns the draft to approved
    await deleteBufferPosts(Object.values(r.postIds), { cfg, log: () => {}, draftId: d.id });
    expect(calls.filter((c) => /deletePost/.test(c.query))).toHaveLength(4);
    expect(getDraft(d.id)!.status).toBe('approved');
    expect(getDraft(d.id)!.bufferPostIds).toBeNull();
  });

  it('a channel failure records the ids that did get created and marks the draft error', async () => {
    const { cfg, calls } = fakeBuffer();
    const failing: BufferConfig = {
      ...cfg,
      fetch: (async (url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as { variables: { input: { channelId: string } } };
        if (body.variables.input.channelId === '699770e9d6f8d304f930040b') {
          return new Response(JSON.stringify({ data: { createPost: { __typename: 'InvalidInputError', message: 'bad linkedin' } } }), { status: 200 });
        }
        return cfg.fetch!(url, init);
      }) as typeof fetch,
    };
    const d = newDraft('approved');
    await expect(publishDraft(d.id, { cfg: failing, log: () => {}, testMode: true })).rejects.toThrow(/linkedin: createPost InvalidInputError: bad linkedin/);
    const after = getDraft(d.id)!;
    expect(after.status).toBe('error');
    expect(Object.keys(JSON.parse(after.bufferPostIds!))).toEqual(['instagram', 'facebook', 'googlebusiness']);
    expect(calls.length).toBe(3);
  });

  it('refuses to publish without a public base URL', async () => {
    const saved = process.env.PUBLIC_BASE_URL;
    delete process.env.PUBLIC_BASE_URL;
    try {
      const { cfg, calls } = fakeBuffer();
      const d = newDraft('approved');
      await expect(publishDraft(d.id, { cfg, log: () => {} })).rejects.toThrow(/PUBLIC_BASE_URL/);
      expect(calls).toHaveLength(0);
      updateDraft(d.id, { status: 'rejected' });
    } finally {
      process.env.PUBLIC_BASE_URL = saved;
    }
  });
});

describe('scheduling', () => {
  const tz = 'America/Indiana/Indianapolis';
  it('live mode posts at 10:00 local on the slot day, never sooner than 24h after approval', () => {
    const now = new Date('2026-10-25T12:00:00Z');
    expect(isoInZone(scheduleFor({ weekOf: '2026-11-02', slot: 'wed' }, tz, now, false), tz)).toBe('2026-11-04T10:00:00-05:00');
    const late = new Date('2026-11-04T20:00:00Z'); // approving after the slot has passed
    const when = scheduleFor({ weekOf: '2026-11-02', slot: 'wed' }, tz, late, false);
    expect(when.getTime()).toBe(late.getTime() + 24 * 3_600_000);
  });
  it('test mode is 60 days out regardless of the slot', () => {
    const now = new Date('2026-10-25T12:00:00Z');
    const when = scheduleFor({ weekOf: '2026-11-02', slot: 'mon' }, tz, now, true);
    expect(when.getTime() - now.getTime()).toBeGreaterThan(59 * 86_400_000);
  });
  it('captions carry hashtags except on google business', () => {
    expect(captionFor(content as never, 'linkedin')).toBe('LI caption.\n\n#Daedabyte #WebDesign #SmallBusiness');
    expect(captionFor(content as never, 'facebook')).toBe('FB caption.');
    expect(captionFor(content as never, 'googlebusiness')).toBe('GB caption.');
  });
});

describe('platform rules', () => {
  it('google business is off by default for quote/screenshot and after two posts in a week', async () => {
    const { defaultPlatforms } = await import('../src/publish.js');
    const { loadBrand } = await import('../src/render.js');
    const brand = await loadBrand();
    const quote = insertDraft({ weekOf: '2026-12-07', slot: 'mon', site: null, template: 'quote', contentJson: '{}', generationContext: '{}', costUsd: 0 });
    expect(defaultPlatforms(quote, brand).find((c) => c.platform === 'googlebusiness')!.on).toBe(false);
    const stat = insertDraft({ weekOf: '2026-12-07', slot: 'tue', site: null, template: 'stat', contentJson: '{}', generationContext: '{}', costUsd: 0 });
    expect(defaultPlatforms(stat, brand).every((c) => c.on)).toBe(true);
    for (const slot of ['wed', 'thu'] as const) {
      insertDraft({ weekOf: '2026-12-07', slot, site: null, template: 'list', contentJson: '{}', generationContext: '{}', costUsd: 0, status: 'scheduled', bufferPostIds: JSON.stringify({ googlebusiness: 'x' }) });
    }
    const choice = defaultPlatforms(stat, brand).find((c) => c.platform === 'googlebusiness')!;
    expect(choice.on).toBe(false);
    expect(choice.reason).toMatch(/already has 2/);
  });
});

describe('error recovery', () => {
  it('a publish that creates nothing keeps the draft approved with the message, so it can be retried', async () => {
    const { cfg } = fakeBuffer();
    const down: BufferConfig = { ...cfg, fetch: (async () => new Response('bad gateway', { status: 502 })) as typeof fetch };
    const d = newDraft('approved');
    await expect(publishDraft(d.id, { cfg: down, log: () => {}, testMode: true })).rejects.toThrow(/502/);
    const after = getDraft(d.id)!;
    expect(after.status).toBe('approved');
    expect(after.errorMessage).toMatch(/502/);
    expect(after.bufferPostIds).toBeNull();
    // and a later success clears the message
    const { cfg: ok } = fakeBuffer();
    await publishDraft(d.id, { cfg: ok, log: () => {}, testMode: true });
    expect(getDraft(d.id)!.status).toBe('scheduled');
    expect(getDraft(d.id)!.errorMessage).toBeNull();
  });
  it('a partial failure is an error until its Buffer posts are deleted, then approved again', async () => {
    const { clearError } = await import('../src/workflow.js');
    const { cfg } = fakeBuffer();
    const flaky: BufferConfig = {
      ...cfg,
      fetch: (async (url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as { query: string; variables: { input: { channelId?: string } } };
        if (/createPost/.test(body.query) && body.variables.input.channelId === '699770e9d6f8d304f930040b') return new Response(JSON.stringify({ data: { createPost: { __typename: 'InvalidInputError', message: 'nope' } } }), { status: 200 });
        return cfg.fetch!(url, init);
      }) as typeof fetch,
    };
    const d = newDraft('approved');
    await expect(publishDraft(d.id, { cfg: flaky, log: () => {}, testMode: true })).rejects.toThrow();
    expect(getDraft(d.id)!.status).toBe('error');
    expect(() => clearError(d.id)).toThrow(/Delete the Buffer posts/);
    const ids = Object.values(JSON.parse(getDraft(d.id)!.bufferPostIds!) as Record<string, string>);
    await deleteBufferPosts(ids, { cfg, log: () => {}, draftId: d.id });
    expect(getDraft(d.id)!.status).toBe('approved');
    expect(getDraft(d.id)!.errorMessage).toBeNull();
  });
  it('checkPublicBase reports a stale tunnel plainly', async () => {
    const { checkPublicBase } = await import('../src/publish.js');
    const bad = await checkPublicBase('/x/a-square.png', (async () => new Response('', { status: 404 })) as typeof fetch);
    expect(bad.ok).toBe(false);
    expect(bad.detail).toMatch(/HTTP 404/);
    const good = await checkPublicBase('/x/a-square.png', (async () => new Response('png', { status: 200, headers: { 'content-type': 'image/png' } })) as typeof fetch);
    expect(good.ok).toBe(true);
    const html = await checkPublicBase('/x/a-square.png', (async () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } })) as typeof fetch);
    expect(html.ok).toBe(false);
  });
});
