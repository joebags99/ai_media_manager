// notify.ts: after a weekly run, one digest with thumbnails and a link to the dashboard.
// Local: written to data/digests/<weekOf>.html and logged; SMTP_URL set: sent with
// nodemailer (an Ethereal inbox works for testing). Prod: SES via the same transport.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import nodemailer from 'nodemailer';
import { DASHBOARD_PORT, DATA_DIR } from './config.js';
import { listDrafts, listRuns, type Draft } from './db.js';
import { esc } from './dashboard/html.js';
import type { DraftContent } from './validate.js';

export const DIGESTS_DIR = path.join(DATA_DIR, 'digests');
const DAY: Record<string, string> = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday' };

export function dashboardBase(): string {
  return process.env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, '') || `http://localhost:${DASHBOARD_PORT}`;
}

export interface Digest {
  weekOf: string;
  subject: string;
  html: string;
  text: string;
  drafts: Draft[];
}

export function buildDigest(weekOf: string, base = dashboardBase()): Digest {
  const drafts = listDrafts({ weekOf, latestOnly: true });
  const run = listRuns(20).find((r) => r.weekOf === weekOf);
  const pending = drafts.filter((d) => d.status === 'pending').length;
  const errors = run ? (JSON.parse(run.errors) as string[]) : [];
  const cost = drafts.reduce((a, d) => a + d.costUsd, 0);
  const subject = `Daedabyte ads: ${drafts.length} draft${drafts.length === 1 ? '' : 's'} for the week of ${weekOf}${pending ? ` (${pending} to review)` : ''}`;

  const card = (d: Draft) => {
    const c = JSON.parse(d.contentJson) as DraftContent;
    const img = d.renderSquare ? `${base}/renders/${path.basename(d.renderSquare)}` : '';
    const link = `${base}/drafts/${d.id}`;
    return `<td valign="top" style="padding:8px;width:200px">
      <a href="${link}">${img ? `<img src="${img}" width="184" height="184" alt="" style="display:block;border-radius:6px">` : ''}</a>
      <p style="margin:8px 0 2px;font:600 14px system-ui,sans-serif">${esc(DAY[d.slot] ?? d.slot)} · <span style="font-weight:400;color:#5B5960">${esc(d.template)}${d.site ? ` · ${esc(d.site)}` : ''}</span></p>
      <p style="margin:0;font:13px/1.4 system-ui,sans-serif;color:#15131A">${esc(c.rationale)}</p>
      <p style="margin:6px 0 0;font:12px system-ui,sans-serif"><a href="${link}" style="color:#1D8A99">${d.status === 'pending' ? 'Review' : esc(d.status)}</a></p></td>`;
  };
  const rows: string[] = [];
  for (let i = 0; i < drafts.length; i += 3) rows.push(`<tr>${drafts.slice(i, i + 3).map(card).join('')}</tr>`);

  const html = `<!doctype html><html><body style="margin:0;background:#F1EFE8;padding:24px;font-family:system-ui,sans-serif;color:#15131A">
  <table cellpadding="0" cellspacing="0" style="max-width:640px;margin:0 auto;background:#fff;border-radius:8px;padding:20px">
    <tr><td colspan="3" style="padding:8px"><h1 style="margin:0 0 4px;font-size:20px">Week of ${esc(weekOf)}</h1>
      <p style="margin:0;color:#5B5960;font-size:14px">${drafts.length} draft(s), ${pending} waiting for review · generation cost $${cost.toFixed(2)}${errors.length ? ` · <span style="color:#B4332B">${errors.length} error(s)</span>` : ''}</p>
      <p style="margin:12px 0 0"><a href="${base}/?week=${esc(weekOf)}" style="display:inline-block;background:#15131A;color:#fff;text-decoration:none;padding:10px 16px;border-radius:6px;font-size:14px">Open the dashboard</a></p></td></tr>
    ${rows.join('')}
    ${errors.length ? `<tr><td colspan="3" style="padding:8px;font-size:13px;color:#B4332B">${errors.map((e) => esc(e)).join('<br>')}</td></tr>` : ''}
  </table></body></html>`;
  const text = [subject, '', ...drafts.map((d) => `${DAY[d.slot] ?? d.slot}: ${d.template}${d.site ? ` (${d.site})` : ''} [${d.status}] ${base}/drafts/${d.id}`), '', `Dashboard: ${base}/?week=${weekOf}`, ...(errors.length ? ['', 'Errors:', ...errors] : [])].join('\n');
  return { weekOf, subject, html, text, drafts };
}

export interface SendResult {
  file: string;
  sent: boolean;
  to: string | null;
  previewUrl: string | null;
}

export async function sendDigest(weekOf: string, opts: { log?: (s: string) => void; base?: string } = {}): Promise<SendResult> {
  const log = opts.log ?? ((s: string) => console.log(`[notify] ${s}`));
  const digest = buildDigest(weekOf, opts.base);
  await mkdir(DIGESTS_DIR, { recursive: true });
  const file = path.join(DIGESTS_DIR, `${weekOf}.html`);
  await writeFile(file, digest.html);
  log(`digest written to ${path.relative(process.cwd(), file)}`);

  const smtp = process.env.SMTP_URL?.trim();
  const to = process.env.DIGEST_TO?.trim() || null;
  if (!smtp || !to) {
    log(`SMTP_URL${to ? '' : ' or DIGEST_TO'} not set; digest logged only:\n${digest.text}`);
    return { file, sent: false, to, previewUrl: null };
  }
  const transport = nodemailer.createTransport(smtp);
  const info = await transport.sendMail({ from: process.env.DIGEST_FROM?.trim() || to, to, subject: digest.subject, text: digest.text, html: digest.html });
  const previewUrl = (nodemailer.getTestMessageUrl(info) as string | false) || null;
  log(`sent to ${to}${previewUrl ? ` (preview: ${previewUrl})` : ''}`);
  return { file, sent: true, to, previewUrl };
}
