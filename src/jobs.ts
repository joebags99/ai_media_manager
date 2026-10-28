// In-process job runner for the dashboard: long tasks (capture, generate, render)
// run here and stream log lines the UI polls.
import { randomUUID } from 'node:crypto';

export type JobStatus = 'running' | 'done' | 'error';

export interface Job {
  id: string;
  kind: string;
  label: string;
  status: JobStatus;
  log: string[];
  startedAt: string;
  finishedAt?: string;
  error?: string;
  result?: unknown;
}

const jobs = new Map<string, Job>();

export function startJob<T>(kind: string, label: string, run: (log: (line: string) => void) => Promise<T>): Job {
  const job: Job = { id: randomUUID(), kind, label, status: 'running', log: [], startedAt: new Date().toISOString() };
  jobs.set(job.id, job);
  // Playwright errors carry ANSI color codes and a multi-line call log; keep the first line, plain.
  const clean = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '').split('\nCall log:')[0]!.trim();
  const log = (line: string) => job.log.push(`${new Date().toISOString().slice(11, 19)} ${clean(line)}`);
  run(log)
    .then((result) => {
      job.result = result;
      job.status = 'done';
    })
    .catch((err: unknown) => {
      job.error = clean(err instanceof Error ? err.message : String(err));
      log(`error: ${job.error}`);
      job.status = 'error';
    })
    .finally(() => {
      job.finishedAt = new Date().toISOString();
    });
  return job;
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

export function recentJobs(limit = 20): Job[] {
  return [...jobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit);
}
