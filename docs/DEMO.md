# Partner demo walkthrough (M6)

Fifteen minutes, one laptop, two terminals. Everything is driven from the dashboard.

## Before the demo

1. `.env` has `ANTHROPIC_API_KEY`, `BUFFER_ACCESS_TOKEN`, `TEST_MODE=true`, and `PUBLIC_BASE_URL`
   set to a running tunnel (see below). Optional: `SMTP_URL` + `DIGEST_TO` for a real email;
   without them the digest is written to `data/digests/` and shown in the dashboard.
2. Terminal 1: `cloudflared tunnel --url http://localhost:3000`, copy the `https://…trycloudflare.com`
   URL into `.env` as `PUBLIC_BASE_URL`.
3. Terminal 2: `npm run review`. Open http://localhost:3000.
4. **Buffer** tab: green "Connected", four channels mapped. Click **Open** under Image hosting
   to show the renders are reachable from the internet.
5. **Sites** tab: at least one client site and the Daedabyte site captured within 7 days
   (click Capture if not).
6. Optional dry run the day before so there is a week of drafts to show if the live run is slow.

## The demo

1. **Plan** (2 min). Plan tab → *Ask Claude to plan*. Show the five rows: template, site,
   subject, reason. Change one subject by hand. *Save and run weekly*.
2. **Watch it work** (3–5 min). The job page streams: plan, captures skipped as fresh, each day
   generating (cost per call), renders. Point out the cost line at the end.
3. **Review** (3 min). Drafts tab: five cards. Open the screenshot post: both sizes, four captions,
   rationale, the Claude conversation at the bottom. Open a stat post to show the plain one.
4. **One revision** (2 min). On any pending draft, type feedback ("lead with the mobile view",
   "shorter Google caption") → *Send to Claude and re-render*. v2 appears; v1 stays linked.
5. **One approval and a post in Buffer** (3 min). Approve a draft → *Test-publish to Buffer*.
   Job log lists the post ids. Open Buffer's queue: four posts (or fewer per the channel
   checkboxes) 60 days out, correct image per platform, hashtags on Instagram and LinkedIn,
   none on Google. Back on the draft, *Delete test posts from Buffer* to clean up.
6. **Digest** (1 min). Drafts tab → *Preview digest* shows the email; *Send digest* sends it if
   SMTP is configured.

## Talking points

- Nothing posts without the approve click; `TEST_MODE` stays on until flipped on purpose.
- Every image is rendered from fixed templates, so the brand never drifts; Claude writes words
  and chooses crops, never pixels.
- Every Claude request and reply is stored on the draft; revisions continue the same
  conversation.
- Own site vs client sites: Daedabyte's site is written about in the first person; client
  sites appear as our work and are named only with permission.
- Cost: roughly $0.02–0.07 per draft at current prices; the weekly run stops at `COST_CEILING_USD`.

## What production changes

Lambda/Fargate runs `npm run weekly` on a schedule; renders go to S3 and `PUBLIC_BASE_URL`
becomes the bucket/CloudFront URL (no tunnel); drafts in DynamoDB or Postgres behind the same
repository interface; the dashboard behind Cognito; the digest through SES; `TEST_MODE=false`.
