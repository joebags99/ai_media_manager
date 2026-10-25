// cli.ts: one entrypoint. Day-to-day testing happens in the dashboard (`review`);
// the other commands exist for scheduled automation.
import { captureSite } from './capture.js';
import { startDashboard } from './dashboard.js';
import { runWeekly } from './weekly.js';

const [cmd, ...args] = process.argv.slice(2);

const usage = `Usage:
  npm run review                 start the dashboard
  npm run capture -- <site>      capture one site recipe
  npm run weekly [-- YYYY-MM-DD] plan -> capture -> generate -> render
  npm run publish -- <draftId>   (M5) publish one approved draft
  npm run revise -- <draftId> "feedback"   (M4)`;

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
  default:
    console.error(usage);
    process.exit(cmd ? 1 : 0);
}
