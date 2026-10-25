import http from 'node:http';
import { runWeekly } from './src/weekly.js';
import { writePlan } from './src/plan.js';
import { captureSite } from './src/capture.js';
import { approve } from './src/workflow.js';
import { listDrafts } from './src/db.js';
import type { Ask } from './src/generate.js';
import { startDashboard } from './src/dashboard.js';
let n = 0;
http.createServer((req, res) => { let body = ''; req.on('data', (c) => (body += c)); req.on('end', () => {
  const { query, variables } = JSON.parse(body); let data: unknown = {};
  if (/account/.test(query)) data = { account: { id: 'a', email: 'jkonkle@daedabyte.com', timezone: 'America/Indiana/Indianapolis', organizations: [{ id: '6995da98b50c73bfc1a845f1', name: 'Daedabyte' }] } };
  else if (/channels/.test(query)) data = { channels: [['69977105d6f8d304f9300473','instagram','daedabyte'],['699770e9d6f8d304f930040b','linkedin','daedabyte-llc'],['69976f1ed6f8d304f92ffb30','googlebusiness','Daedabyte Web Solutions'],['69976ec0d6f8d304f92ff8e1','facebook','Daedabyte Web Solutions']].map(([id, service, name]) => ({ id, service, name, timezone: 'x', isDisconnected: false })) };
  else if (/createPost/.test(query)) data = { createPost: { __typename: 'PostActionSuccess', post: { id: ('post' + ++n).padEnd(24, '0'), status: 'scheduled', dueAt: variables.input.dueAt } } };
  else if (/deletePost/.test(query)) data = { deletePost: { __typename: 'DeletePostSuccess', id: variables.input.id } };
  res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data })); }); }).listen(3999);
process.env.BUFFER_ACCESS_TOKEN = 'fake'; process.env.BUFFER_API_URL = 'http://localhost:3999/'; process.env.PUBLIC_BASE_URL = 'https://example.test';
await captureSite('sample-local', { log: () => {} }); await captureSite('sample-own', { log: () => {} });
await writePlan({ weekOf: '2026-11-02', createdAt: new Date().toISOString(), source: 'claude', days: [
  { slot: 'mon', template: 'list', subject: 'Four things a dated website costs you', site: null, reason: 'Pain points open the week' },
  { slot: 'tue', template: 'stat', subject: '40% average inquiry increase', site: null, reason: 'Our strongest proof point' },
  { slot: 'wed', template: 'screenshot', subject: 'Recent work for a tile installer', site: 'sample-local', reason: 'Fresh capture, strong hero' },
  { slot: 'thu', template: 'quote', subject: 'A client testimonial about us', site: 'sample-own', reason: 'Our testimonials section is captured' },
  { slot: 'fri', template: 'list', subject: 'Questions to ask a web designer', site: null, reason: 'Checklist closes the week' } ] });
const fakeAsk: Ask = async <T,>(call: any) => {
  const template = /TEMPLATE: (\w+)/.exec(call.system)![1]!;
  const slots: any = { list: { line1: 'Slow.', line2: 'Dated.', line3: 'Hidden.', line4: 'Broken.', verdict: 'Yours should be none.' }, stat: { number: '40%', claim: 'Average lift in inquiries.', kicker: 'Start your project.' }, screenshot: { headline: 'Built to load fast.', accentWord: 'fast' }, quote: { quote: 'They rebuilt our site in three weeks. The phone has not stopped ringing.', name: 'Dana W.', business: 'Valley Tile & Stone' } };
  const data = { template, slots: slots[template], crop: { screenshot: template === 'screenshot' ? 'hero-desktop.png' : null, region: template === 'screenshot' ? [0, 0, 1440, 560] : null, treatment: 'framed' },
    captions: { instagram: 'Your site should work as hard as you do. Link in bio.', facebook: 'Your site should work as hard as you do. https://daedabyte.com', linkedin: 'A website is a sales tool. Ours are built to last. https://daedabyte.com', googlebusiness: 'Websites, built to last. Based in Mt Jackson.' },
    hashtags: { instagram: ['#Daedabyte','#WebDesign','#SmallBusiness','#SEO','#MtJackson'], facebook: ['#Daedabyte'], linkedin: ['#Daedabyte','#WebDesign','#SmallBusiness'] }, rationale: 'Leads with the ' + template + ' format so the single point lands fast on a small screen.' };
  return { data: data as T, request: { fake: true }, response: { id: 'msg_fake' } as any, costUsd: 0.05, model: 'fake' };
};
await runWeekly({ weekOf: '2026-11-02', ask: fakeAsk, log: () => {}, digest: false });
approve(listDrafts({ weekOf: '2026-11-02' }).find((d) => d.slot === 'tue')!.id);
console.log('ids', JSON.stringify(Object.fromEntries(listDrafts({ weekOf: '2026-11-02' }).map((d) => [d.slot, d.id]))));
await startDashboard(3464);
