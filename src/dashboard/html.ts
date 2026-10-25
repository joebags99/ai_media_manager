// Plain HTML helpers for the dashboard. No templating library; every page is a string.

export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const NAV = [
  ['/', 'Drafts'],
  ['/templates', 'Templates'],
  ['/sites', 'Sites'],
  ['/jobs', 'Jobs'],
];

export function layout(title: string, body: string, opts: { testMode: boolean; active?: string }): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${esc(title)} · Daedabyte ads</title>
<style>
  :root { --ink:#15131A; --bone:#F1EFE8; --terracotta:#FC7645; --ash:#5B5960; --lavender:#C3BFCB; --aegean:#1D8A99; --gold:#C3B86A; --purple:#A678D1; }
  * { box-sizing:border-box; }
  body { margin:0; font:15px/1.5 system-ui, sans-serif; background:var(--bone); color:var(--ink); }
  header { display:flex; align-items:center; gap:24px; padding:14px 28px; background:var(--ink); color:var(--bone); }
  header b { letter-spacing:.08em; text-transform:uppercase; font-size:13px; }
  header a { color:var(--lavender); text-decoration:none; } header a.active { color:#fff; border-bottom:2px solid var(--terracotta); }
  .badge { margin-left:auto; font-size:12px; padding:3px 10px; border-radius:99px; background:var(--gold); color:var(--ink); font-weight:600; }
  .badge.live { background:var(--terracotta); color:#fff; }
  main { max-width:1200px; margin:0 auto; padding:28px; }
  h1 { font-size:24px; margin:0 0 18px; } h2 { font-size:17px; margin:28px 0 10px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(260px, 1fr)); gap:18px; }
  .card { background:#fff; border:1px solid var(--lavender); border-radius:8px; padding:14px; }
  .card img { width:100%; height:auto; display:block; border-radius:4px; background:#ddd; }
  .muted { color:var(--ash); font-size:13px; }
  button, .btn { font:inherit; background:var(--ink); color:#fff; border:0; padding:8px 14px; border-radius:6px; cursor:pointer; text-decoration:none; display:inline-block; }
  button.secondary, .btn.secondary { background:#fff; color:var(--ink); border:1px solid var(--ash); }
  button.danger { background:#B4332B; }
  form.inline { display:inline; }
  pre.log { background:var(--ink); color:var(--bone); padding:14px; border-radius:8px; font-size:12px; max-height:420px; overflow:auto; white-space:pre-wrap; }
  table { border-collapse:collapse; width:100%; } td, th { text-align:left; padding:8px 10px; border-bottom:1px solid var(--lavender); vertical-align:top; }
  .status-running { color:var(--aegean); } .status-done { color:#2e7d32; } .status-error { color:#B4332B; }
  .warn { background:#fff4e5; border-left:4px solid var(--terracotta); padding:8px 12px; margin:10px 0; }
  .row { display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
</style></head>
<body><header><b>Daedabyte ads</b>
${NAV.map(([href, label]) => `<a href="${href}" class="${opts.active === href ? 'active' : ''}">${label}</a>`).join('')}
<span class="badge ${opts.testMode ? '' : 'live'}">${opts.testMode ? 'TEST MODE' : 'LIVE'}</span></header>
<main>${body}</main></body></html>`;
}

/** Poll a job and show its log; redirects to `next` when it finishes. */
export function jobView(jobId: string, next: string): string {
  return `<pre class="log" id="log">starting…</pre>
<p class="muted" id="state">running</p>
<script>
  const next = ${JSON.stringify(next)};
  async function tick() {
    const r = await fetch('/api/jobs/${jobId}'); const j = await r.json();
    document.getElementById('log').textContent = j.log.join('\\n') || 'starting…';
    document.getElementById('state').textContent = j.status + (j.error ? ': ' + j.error : '');
    if (j.status === 'running') setTimeout(tick, 800);
    else if (j.status === 'done') setTimeout(() => location.href = next, 600);
  }
  tick();
</script>`;
}
