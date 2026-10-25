// Plain HTML helpers for the dashboard: the brand design layer and a few components.
// No templating library; every page is a string. Colors and fonts follow brand/brand.json.

export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const NAV: [string, string, string][] = [
  ['/', 'Drafts', 'Review, revise, approve, publish'],
  ['/plan', 'Plan', 'Pick templates and subjects for a week'],
  ['/library', 'Library', 'Shelved drafts for last-minute swaps'],
  ['/sites', 'Sites', 'Client and own sites to screenshot'],
  ['/reviews', 'Reviews', 'Client reviews the quote template draws from'],
  ['/templates', 'Templates', 'The four fixed ad layouts'],
  ['/buffer', 'Buffer', 'Connection and channels'],
  ['/jobs', 'Jobs', 'Everything that ran this session'],
];

export const CSS = `
@font-face { font-family: "Inter Tight"; font-weight: 700; src: url(/brand/fonts/inter-tight-latin-700-normal.woff2) format("woff2"); font-display: swap; }
@font-face { font-family: "Hanken Grotesk"; font-weight: 400; src: url(/brand/fonts/hanken-grotesk-latin-400-normal.woff2) format("woff2"); font-display: swap; }
@font-face { font-family: "Hanken Grotesk"; font-weight: 400; font-style: italic; src: url(/brand/fonts/hanken-grotesk-latin-400-italic.woff2) format("woff2"); font-display: swap; }
@font-face { font-family: "Hanken Grotesk"; font-weight: 600; src: url(/brand/fonts/hanken-grotesk-latin-600-normal.woff2) format("woff2"); font-display: swap; }
:root {
  --ink:#15131A; --ink-soft:#1C1A21; --bone:#F1EFE8; --marble:#F5F5F0; --terracotta:#FC7645; --purple:#A678D1;
  --ash:#5B5960; --lavender:#C3BFCB; --aegean:#1D8A99; --gold:#C3B86A; --line:#DEDAE3; --ok:#2E7D32; --bad:#B4332B;
  --display:"Inter Tight", system-ui, sans-serif; --body:"Hanken Grotesk", system-ui, sans-serif;
}
* { box-sizing:border-box; }
html { background:var(--bone); }
body { margin:0; font:15px/1.5 var(--body); color:var(--ink); -webkit-font-smoothing:antialiased; }
a { color:var(--aegean); }
h1, h2, h3 { font-family:var(--display); font-weight:700; letter-spacing:-0.025em; margin:0; }
h1 { font-size:30px; line-height:1.1; } h2 { font-size:19px; margin-top:34px; margin-bottom:10px; } h3 { font-size:16px; }
code { font-size:13px; background:var(--marble); padding:1px 5px; border-radius:4px; border:1px solid var(--line); }
pre { font-size:12.5px; line-height:1.45; }

/* top bar */
.top { background:var(--ink); color:var(--bone); }
.top .in { max-width:1200px; margin:0 auto; padding:0 28px; display:flex; align-items:stretch; gap:6px; height:58px; }
.brand { display:flex; align-items:center; gap:10px; margin-right:18px; color:#fff; text-decoration:none; font-family:var(--display); font-weight:700; letter-spacing:-0.02em; font-size:16px; }
.brand svg, .brand img { width:26px; height:26px; }
.top nav { display:flex; gap:2px; }
.top nav a { display:flex; align-items:center; padding:0 12px; color:var(--lavender); text-decoration:none; font-weight:600; font-size:14px; border-bottom:3px solid transparent; border-top:3px solid transparent; }
.top nav a:hover { color:#fff; } .top nav a.active { color:#fff; border-bottom-color:var(--terracotta); }
.mode { margin-left:auto; align-self:center; font-size:11px; letter-spacing:.14em; text-transform:uppercase; font-weight:600; padding:5px 11px; border-radius:99px; background:var(--gold); color:var(--ink); }
.mode.live { background:var(--terracotta); color:#fff; }

main { max-width:1200px; margin:0 auto; padding:30px 28px 60px; }
.page-head { display:flex; align-items:flex-end; justify-content:space-between; gap:24px; flex-wrap:wrap; margin-bottom:22px; }
.page-head .lead { color:var(--ash); margin:6px 0 0; max-width:62ch; }
.page-head .actions { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
.eyebrow { font-size:11px; letter-spacing:.16em; text-transform:uppercase; font-weight:600; color:var(--ash); }

/* controls */
button, .btn { font:600 14px var(--body); background:var(--ink); color:#fff; border:1px solid var(--ink); padding:9px 15px; border-radius:7px; cursor:pointer; text-decoration:none; display:inline-flex; align-items:center; gap:8px; line-height:1.2; white-space:nowrap; }
button:hover, .btn:hover { background:var(--ink-soft); }
.btn.primary, button.primary { background:var(--terracotta); border-color:var(--terracotta); color:#fff; }
.btn.primary:hover, button.primary:hover { filter:brightness(.95); }
.btn.secondary, button.secondary { background:#fff; color:var(--ink); border-color:var(--lavender); }
.btn.secondary:hover, button.secondary:hover { background:var(--marble); border-color:var(--ash); }
.btn.ok, button.ok { background:var(--ok); border-color:var(--ok); color:#fff; }
.btn.danger, button.danger { background:#fff; color:var(--bad); border-color:var(--bad); }
.btn.danger:hover, button.danger:hover { background:#FBECEA; }
.btn.small, button.small { padding:6px 11px; font-size:13px; }
input[type=text], input[type=url], input[type=number], input[type=date], input:not([type]), select, textarea { font:14px var(--body); color:var(--ink); background:#fff; border:1px solid var(--lavender); border-radius:7px; padding:8px 10px; }
input:focus, select:focus, textarea:focus { outline:2px solid var(--aegean); outline-offset:1px; border-color:var(--aegean); }
label b { font-weight:600; }
form.inline { display:inline; }
.row { display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
.field { display:block; margin:14px 0; } .field > b { display:block; margin-bottom:5px; } .field input:not([type=radio]):not([type=checkbox]), .field select, .field textarea { width:100%; }
.field input[type=radio], .field input[type=checkbox] { width:auto; margin-right:6px; }
.hint { color:var(--ash); font-size:13px; }
.muted { color:var(--ash); font-size:13px; }

/* surfaces */
.card { background:#fff; border:1px solid var(--line); border-radius:12px; padding:18px; }
.card.tight { padding:14px; }
.card img { width:100%; height:auto; display:block; border-radius:6px; background:#ddd; }
.grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(250px, 1fr)); gap:18px; }
.grid.wide { grid-template-columns:repeat(auto-fill, minmax(320px, 1fr)); }
table { border-collapse:collapse; width:100%; background:#fff; border:1px solid var(--line); border-radius:12px; overflow:hidden; }
th { text-align:left; font-size:11px; letter-spacing:.14em; text-transform:uppercase; color:var(--ash); font-weight:600; padding:12px 14px; border-bottom:1px solid var(--line); background:var(--marble); }
td { padding:12px 14px; border-bottom:1px solid var(--line); vertical-align:top; }
tr:last-child td { border-bottom:0; }
.notice { border-radius:10px; padding:12px 16px; margin:12px 0; border:1px solid var(--line); background:#fff; }
.notice.warn { border-color:#F4C9B4; background:#FFF4EE; }
.notice.ok { border-color:#BFE0C3; background:#F0F8F1; }
.notice.bad { border-color:#F1C1BC; background:#FBECEA; }
.notice.info { border-color:#BFE1E5; background:#EEF8F9; }
.badge { display:inline-block; padding:2px 10px; border-radius:99px; font-size:11.5px; font-weight:600; letter-spacing:.04em; text-transform:uppercase; color:#fff; background:var(--ash); }
.badge.pending { background:var(--aegean); } .badge.revising { background:var(--purple); } .badge.approved { background:var(--ok); }
.badge.scheduled { background:var(--ok); } .badge.posted { background:var(--ok); } .badge.rejected { background:var(--ash); } .badge.error { background:var(--bad); }
.badge.own { background:var(--gold); color:var(--ink); }
.status-running { color:var(--aegean); } .status-done { color:var(--ok); } .status-error { color:var(--bad); }
pre.log { background:var(--ink); color:var(--bone); padding:16px; border-radius:10px; max-height:460px; overflow:auto; white-space:pre-wrap; margin:0; }
details summary { cursor:pointer; color:var(--ash); font-size:13px; }
.empty { text-align:center; padding:48px 20px; color:var(--ash); border:1px dashed var(--lavender); border-radius:12px; background:transparent; }
.empty b { color:var(--ink); font-family:var(--display); font-size:18px; display:block; margin-bottom:6px; }

/* workflow strip */
.steps { display:grid; grid-template-columns:repeat(4, 1fr); gap:10px; margin:0 0 26px; }
.step { background:#fff; border:1px solid var(--line); border-radius:12px; padding:14px 16px; text-decoration:none; color:var(--ink); display:block; }
.step:hover { border-color:var(--ash); }
.step .n { font-family:var(--display); font-weight:700; color:var(--terracotta); font-size:12px; letter-spacing:.1em; }
.step b { display:block; font-family:var(--display); font-size:16px; margin:2px 0 3px; }
.step span { color:var(--ash); font-size:13px; }
@media (max-width: 800px) { .steps { grid-template-columns:1fr 1fr; } main { padding:20px 16px 40px; } .top .in { padding:0 16px; } }
`;

export interface LayoutOpts {
  testMode: boolean;
  active?: string;
  /** Inline SVG of the brand mark, if available. */
  icon?: string;
}

export function layout(title: string, body: string, opts: LayoutOpts): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${esc(title)} · Daedabyte ads</title>
<style>${CSS}</style></head>
<body>
<div class="top"><div class="in">
  <a class="brand" href="/">${opts.icon ?? ''}Daedabyte ads</a>
  <nav>${NAV.map(([href, label, help]) => `<a href="${href}" class="${opts.active === href ? 'active' : ''}" title="${esc(help)}">${label}</a>`).join('')}</nav>
  <span class="mode ${opts.testMode ? '' : 'live'}" title="${opts.testMode ? 'TEST_MODE=true: Buffer posts are scheduled 60 days out and can be deleted from here' : 'TEST_MODE=false: approved posts are scheduled for real'}">${opts.testMode ? 'Test mode' : 'Live'}</span>
</div></div>
<main>${body}</main></body></html>`;
}

/** Title, one-line explanation, and the page's primary actions on the right. */
export function pageHead(title: string, lead: string, actions = '', eyebrow = ''): string {
  return `<div class="page-head"><div>${eyebrow ? `<div class="eyebrow">${esc(eyebrow)}</div>` : ''}<h1>${title}</h1>${lead ? `<p class="lead">${lead}</p>` : ''}</div>${actions ? `<div class="actions">${actions}</div>` : ''}</div>`;
}

export function section(title: string, help: string, body: string): string {
  return `<h2>${esc(title)}</h2>${help ? `<p class="hint" style="margin:-4px 0 12px">${help}</p>` : ''}${body}`;
}

export function notice(kind: 'warn' | 'ok' | 'bad' | 'info', html: string): string {
  return `<div class="notice ${kind}">${html}</div>`;
}

export function badge(status: string, label = status): string {
  return `<span class="badge ${esc(status)}">${esc(label)}</span>`;
}

export function empty(title: string, text: string, action = ''): string {
  return `<div class="empty"><b>${esc(title)}</b>${text}${action ? `<div style="margin-top:14px">${action}</div>` : ''}</div>`;
}

/** Poll a job and show its log; redirects to `next` when it finishes. */
export function jobView(jobId: string, next: string): string {
  return `<pre class="log" id="log">starting…</pre>
<p class="muted" id="state" style="margin-top:10px">running…</p>
<script>
  const next = ${JSON.stringify(next)};
  async function tick() {
    const r = await fetch('/api/jobs/${jobId}'); const j = await r.json();
    document.getElementById('log').textContent = j.log.join('\\n') || 'starting…';
    const s = document.getElementById('state');
    s.textContent = j.status === 'running' ? 'running…' : j.status === 'done' ? 'done, going back…' : 'failed: ' + (j.error || '');
    s.className = 'muted status-' + j.status;
    if (j.status === 'running') setTimeout(tick, 800);
    else if (j.status === 'done') setTimeout(() => location.href = next, 700);
  }
  tick();
</script>`;
}
