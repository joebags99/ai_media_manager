// Shared paths and environment. TEST_MODE defaults to true: nothing reaches a real
// posting date unless TEST_MODE=false is set explicitly.
import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const SCREENSHOTS_DIR = path.join(DATA_DIR, 'screenshots');
export const RENDERS_DIR = path.join(DATA_DIR, 'renders');
export const SITES_DIR = path.join(ROOT, 'sites');
export const FIXTURES_DIR = path.join(ROOT, 'fixtures');
export const DB_PATH = path.join(DATA_DIR, 'local.db');

export const TEST_MODE = process.env.TEST_MODE !== 'false';
export const DASHBOARD_PORT = Number(process.env.DASHBOARD_PORT ?? 3000);
export const COST_CEILING_USD = Number(process.env.COST_CEILING_USD ?? 2);
export const ORG_ID = 'daedabyte';
