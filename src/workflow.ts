// workflow.ts: the draft state machine from pipeline-spec.workflow.transitions.
import { currentDraft, deleteDraft, getDraft, insertDraft, listDrafts, maxVersion, updateDraft, LIBRARY_WEEK, type Draft, type DraftStatus, type Slot } from './db.js';

const ALLOWED: Record<string, DraftStatus[]> = {
  pending: ['approved', 'revising', 'rejected', 'error', 'archived'],
  revising: ['pending', 'error'],
  approved: ['scheduled', 'error', 'archived'],
  archived: ['pending', 'approved'],
  scheduled: ['posted', 'error'],
  rejected: [],
  posted: [],
  error: ['approved', 'pending', 'archived'],
};

export function canTransition(from: DraftStatus, to: DraftStatus): boolean {
  return ALLOWED[from]?.includes(to) ?? false;
}

export function transition(id: string, to: DraftStatus, patch: Partial<Draft> = {}): Draft {
  const d = getDraft(id);
  if (!d) throw new Error(`Unknown draft ${id}`);
  if (!canTransition(d.status, to)) throw new Error(`Draft is ${d.status}; cannot move to ${to}`);
  return updateDraft(id, { ...patch, status: to });
}

export const approve = (id: string): Draft => transition(id, 'approved');
export const reject = (id: string, reason?: string): Draft => transition(id, 'rejected', reason ? { feedback: reason } : {});

/** Shelve a draft into the library. Its week/slot are freed; its status is remembered. */
export function archive(id: string): Draft {
  const d = getDraft(id);
  if (!d) throw new Error(`Unknown draft ${id}`);
  return transition(id, 'archived', { archivedStatus: d.status, weekOf: LIBRARY_WEEK });
}

/** Put a library draft into a week/slot. A draft already there is shelved first. */
export function place(id: string, weekOf: string, slot: Slot): { placed: Draft; displaced: Draft | null } {
  const d = getDraft(id);
  if (!d) throw new Error(`Unknown draft ${id}`);
  if (d.status !== 'archived') throw new Error('Only a shelved draft can be placed');
  const version = maxVersion(weekOf, slot) + 1;
  const existing = currentDraft(weekOf, slot);
  const displaced = existing ? archive(existing.id) : null;
  const status: DraftStatus = d.archivedStatus === 'approved' ? 'approved' : 'pending';
  const placed = transition(id, status, { weekOf, slot, version, archivedStatus: null, scheduledAt: null, bufferPostIds: null });
  return { placed, displaced };
}

/** Copy a draft into a week/slot as a new pending draft (renders are re-made by the caller). */
export function duplicate(id: string, weekOf: string, slot: Slot): Draft {
  const d = getDraft(id);
  if (!d) throw new Error(`Unknown draft ${id}`);
  const ctx = JSON.parse(d.generationContext) as Record<string, unknown>;
  return insertDraft({
    weekOf,
    slot,
    site: d.site,
    template: d.template,
    version: maxVersion(weekOf, slot) + 1,
    contentJson: d.contentJson,
    generationContext: JSON.stringify({ ...ctx, duplicatedFrom: d.id }),
    costUsd: 0,
    status: 'pending',
  });
}

/** Delete for good. Never a draft that is in Buffer (scheduled/posted) or mid-revision. */
export function remove(id: string): void {
  const d = getDraft(id);
  if (!d) throw new Error(`Unknown draft ${id}`);
  if (['scheduled', 'posted', 'revising'].includes(d.status)) throw new Error(`Draft is ${d.status}; delete its Buffer posts first`);
  deleteDraft(id);
}

/** Shelve every current pending/approved draft of a week so the slots can be regenerated. */
export function clearWeek(weekOf: string): Draft[] {
  const out: Draft[] = [];
  for (const d of listDrafts({ weekOf, latestOnly: true })) {
    if (d.status === 'pending' || d.status === 'approved') out.push(archive(d.id));
  }
  return out;
}

/** Clear an error state. Drafts that still have posts in Buffer must delete them first. */
export function clearError(id: string): Draft {
  const d = getDraft(id);
  if (!d) throw new Error(`Unknown draft ${id}`);
  if (d.status !== 'error') return updateDraft(id, { errorMessage: null });
  if (d.bufferPostIds && Object.keys(JSON.parse(d.bufferPostIds) as Record<string, string>).length) throw new Error('Delete the Buffer posts on this draft first; then the error clears on its own');
  return transition(id, 'approved', { errorMessage: null, bufferPostIds: null, scheduledAt: null });
}
