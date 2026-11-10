#!/usr/bin/env node
// Prompt A/B on a saved run without a full re-run: re-paint some of its views with other options (and optionally
// paint roof-pass views on top of it), save every image to runs/<run>-ab/<tag>/ for a side-by-side look.
//   node scripts/prompt-test.mjs --run village-03 --level samples/village.glb --views 0,3,7 --tag new [--roofs 8]
//     [--variants '[{"name":"new","opts":{}}]']
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { falKey, launchBrowser, openApp, ROOT, startServer } from './browser.mjs';

const { values: a } = parseArgs({
  options: {
    run: { type: 'string' },
    level: { type: 'string', default: 'samples/village.glb' },
    views: { type: 'string', default: '' },
    variants: { type: 'string', default: '[{"name":"new","opts":{}}]' },
    roofs: { type: 'string', default: '0' },
    tag: { type: 'string', default: 'ab' },
    atlas: { type: 'string', default: '4096' },
    'view-size': { type: 'string', default: '1024' },
    dry: { type: 'boolean', default: false },
    fresh: { type: 'boolean', default: false },
    lighting: { type: 'string', default: 'outdoor' },
  },
});
if (!a.dry && !(await falKey())) {
  console.error('FAL_KEY is not set (export FAL_KEY=your-fal-key, or put FAL_KEY=... in .env.local)');
  process.exit(1);
}
const out = path.join(ROOT, 'runs', `${a.run}-ab`, a.tag);
fs.mkdirSync(out, { recursive: true });
const save = (file, dataUrl) => fs.writeFileSync(path.join(out, file), Buffer.from(dataUrl.split(',')[1], 'base64'));
const { server, url } = await startServer();
const browser = await launchBrowser();
const t0 = Date.now();
const log = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${s}`);
try {
  const page = await openApp(browser, url, { width: 1280, height: 800, onLog: log, onEvent: (e) => log(JSON.stringify(e)) });
  await page.evaluate(([lvl, atlas, viewSize, lighting]) => window.trompe.load(`/${lvl}`, { atlasSize: +atlas, viewSize: +viewSize, lighting }),
    [a.level, a.atlas, a['view-size'], a.lighting]);
  const res = await page.evaluate((o) => window.trompe.promptTest(o), {
    run: a.run, views: a.views ? a.views.split(',').map(Number) : [], variants: JSON.parse(a.variants), roofs: +a.roofs, dry: a.dry, fresh: a.fresh,
  });
  const meta = [];
  for (const r of res) {
    const base = r.variant ? `v${r.view}_${r.variant}${r.seed !== undefined ? `_s${r.seed}` : ''}` : `${r.view}`;
    for (const k of ['state', 'edit', 'gen', 'comp', 'before', 'after']) if (r[k]) { save(`${base}_${k}.jpg`, r[k]); delete r[k]; }
    meta.push({ file: base, ...r });
  }
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(meta, null, 1));
  log(`saved ${meta.length} results to ${path.relative(ROOT, out)}/`);
} finally {
  await browser.close();
  await server.close();
}
