// Runs before every test file: keep tests away from the real brand/reviews.json.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const file = path.join(mkdtempSync(path.join(tmpdir(), 'reviews-')), 'reviews.json');
writeFileSync(file, '[]');
process.env.REVIEWS_FILE = file;
