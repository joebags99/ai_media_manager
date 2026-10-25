// workflow.ts: the draft state machine from pipeline-spec.workflow.transitions.
import { getDraft, updateDraft, type Draft, type DraftStatus } from './db.js';

const ALLOWED: Record<string, DraftStatus[]> = {
  pending: ['approved', 'revising', 'rejected', 'error'],
  revising: ['pending', 'error'],
  approved: ['scheduled', 'error'],
  scheduled: ['posted', 'error'],
  rejected: [],
  posted: [],
  error: [],
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
