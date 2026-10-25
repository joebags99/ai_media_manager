# daedabyte-ad-pipeline

One on-brand social ad per weekday: Claude plans the week and writes copy, fixed HTML templates
render the image, you review in a local dashboard, approved posts are scheduled to Buffer.

`pipeline-spec.json` and `brand/brand.json` are the source of truth. `docs/DEMO.md` is the walkthrough.

## Setup

```
npm install
npx playwright install chromium
cp .env.example .env     # fill in ANTHROPIC_API_KEY and BUFFER_ACCESS_TOKEN
npm run review           # dashboard on http://localhost:3000
```

Publishing needs `PUBLIC_BASE_URL`: Buffer fetches post images by URL, so the dashboard must be
reachable from the internet (`cloudflared tunnel --url http://localhost:3000` locally).

## Commands

| Command | Does |
|---|---|
| `npm run review` | start the dashboard (all day-to-day use) |
| `npm run weekly [-- YYYY-MM-DD]` | plan → capture → generate → render → digest (for automation) |
| `npm run capture -- <site>` | capture one site recipe |
| `npm run revise -- <draftId> "feedback"` | new version from feedback |
| `npm run publish -- <draftId>` | schedule one approved draft to Buffer |
| `npm run buffer:delete -- <postId...>` | remove Buffer posts (the logged cleanup) |
| `npm test` | vitest (no API keys needed; Claude and Buffer are faked) |

## Layout

```
brand/        brand.json, icon.svg, fonts, example ads
templates/    list / stat / quote / screenshot HTML, driven by brand.json CSS variables
fixtures/     hard-coded JSON used by the Templates page and tests
sites/        one capture recipe per site (edited from the dashboard)
src/          capture, inspect, plan, generate, validate, render, revise, workflow,
              publish, buffer, notify, weekly, db, claude, dashboard/
data/         local.db, screenshots/, renders/, calendar.json, digests/ (git-ignored)
```

`TEST_MODE` defaults to true: Buffer posts are scheduled 60 days out and a delete button is shown.
