// cli.ts: one entrypoint. Day-to-day testing happens in the dashboard (`review`);
// the other commands exist for scheduled automation.
import { captureSite } from './capture.js';
import { startDashboard } from './dashboard.js';
import { runWeekly } from './weekly.js';
import { reviseDraft } from './revise.js';
import { publishDraft, deleteBufferPosts } from './publish.js';
import { syncMetrics } from './metrics.js';

const [cmd, ...args] = process.argv.slice(2);

const usage = `Usage:
  npm run review                 start the dashboard
  npm run capture -- <site>      capture one site recipe
  npm run weekly [-- YYYY-MM-DD] plan -> capture -> generate -> render
  npm run publish -- <draftId>   schedule one approved draft to Buffer
  npm run buffer:delete -- <postId...>   remove Buffer posts (the logged cleanup)
  npm run metrics                pull post performance from Buffer
  npm run revise -- <draftId> "feedback"   new version from feedback`;

switch (cmd) {
  case 'review':
    await startDashboard();
    break;
  case 'capture': {
    const slug = args[0];
    if (!slug) {
      console.error(usage);
      process.exit(1);
    }
    const m = await captureSite(slug);
    console.log(JSON.stringify(m, null, 2));
    break;
  }
  case 'weekly': {
    const r = await runWeekly(args[0] ? { weekOf: args[0] } : {});
    if (r.errors.length) process.exitCode = 1;
    break;
  }
  case 'revise': {
    const [id, feedback] = args;
    if (!id || !feedback) {
      console.error(usage);
      process.exit(1);
    }
    const next = await reviseDraft(id, feedback, { log: (l) => console.log(`[revise] ${l}`) });
    console.log(`v${next.version}: ${next.renderSquare}`);
    break;
  }
  case 'publish': {
    const id = args[0];
    if (!id) {
      console.error(usage);
      process.exit(1);
    }
    const r = await publishDraft(id);
    console.log(JSON.stringify({ postIds: r.postIds, scheduledAt: r.scheduledAt, deleteCommand: r.deleteCommand }, null, 2));
    break;
  }
  case 'buffer:delete': {
    if (!args.length) {
      console.error(usage);
      process.exit(1);
    }
    await deleteBufferPosts(args);
    break;
  }
  case 'metrics': {
    await syncMetrics({ log: (l) => console.log(`[metrics] ${l}`), minAgeHours: 0 });
    break;
  }
  default:
    console.error(usage);
    process.exit(cmd ? 1 : 0);
}
