#!/usr/bin/env node
// Make normal and roughness maps for a saved run's texture and add them to the run (normal.png, orm.png, and the
// .glb re-exported with them). No view is repainted.
//   node scripts/pbr.mjs --level samples/village.glb --run village [--size 4096] [--atlas 8192] [--strength 1] [--quote]
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { falKey, launchBrowser, openApp, startServer } from './browser.mjs';

const { values: a } = parseArgs({
  options: {
    level: { type: 'string', default: 'samples/village.glb' },
    run: { type: 'string' },
    size: { type: 'string', default: '4096' },
    atlas: { type: 'string', default: '4096' },
    'view-size': { type: 'string', default: '1024' },
    strength: { type: 'string', default: '1' },
    quote: { type: 'boolean', default: false },
  },
});
if (!a.run) {
  console.error('which run? --run <id> (a folder under runs/)');
  process.exit(1);
}
if (a.quote) {
  // what the call would send at most: tiles of 2048 px, fal lists PATINA at $0.01 per megapixel
  const size = Math.min(+a.size, +a.atlas);
  const n = Math.max(1, Math.round(size / 2048)) ** 2;
  console.log(`${size} px maps: up to ${n} tile${n > 1 ? 's' : ''}, about $${(n * 2.048 * 2.048 * 0.01).toFixed(2)}`);
  process.exit(0);
}
if (!(await falKey())) {
  console.error('FAL_KEY is not set (export FAL_KEY=your-fal-key, or put FAL_KEY=... in .env.local)');
  process.exit(1);
}
const lighting = JSON.parse(fs.readFileSync(`runs/${a.run}/run.json`, 'utf8')).lighting?.name ?? 'outdoor';
const { server, url } = await startServer();
const browser = await launchBrowser();
const t0 = Date.now();
const log = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${s}`);
try {
  const page = await openApp(browser, url, {
    onLog: log,
    onEvent: (e) => log(e.type === 'pbr' ? `tile ${e.done}/${e.total}` : e.type === 'save' ? `saving ${e.msg}` : JSON.stringify(e)),
  });
  await page.evaluate(([lvl, l, atlas, viewSize]) => window.trompe.load(`/${lvl}`, { lighting: l, atlasSize: +atlas, viewSize: +viewSize }),
    [a.level, lighting, a.atlas, a['view-size']]);
  log(`run: ${JSON.stringify(await page.evaluate((r) => window.trompe.loadRun(r), a.run))}`);
  log(`maps: ${JSON.stringify(await page.evaluate((o) => window.trompe.pbr(o), { size: +a.size, strength: +a.strength }))}`);
  await page.evaluate((r) => window.trompe.save(r), a.run);
  log(`saved normal.png, orm.png and level_textured.glb to runs/${a.run}/`);
} finally {
  await browser.close();
  await server.close();
}
