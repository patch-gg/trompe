#!/usr/bin/env node
// Texture a level headlessly and save the run to runs/<id>/.
//   FAL_KEY=... node scripts/texture.mjs --level samples/courtyard.glb --id courtyard --views 24 \
//     [--lighting overcast|outdoor|indoor] [--style "..."] [--first flux3-klein] [--fill fibo2] [--aerial 8] [--roofs 24] [--holes 12] [--plan-only]
//     [--pbr [--pbr-size 4096]]   also make normal and roughness maps for the finished texture
// Every view is written to runs/<id>/ as it's painted, so a run that dies can be picked up with --resume <id>.
import { parseArgs } from 'node:util';
import { falKey, launchBrowser, openApp, startServer } from './browser.mjs';

const { values: a } = parseArgs({
  options: {
    level: { type: 'string', default: 'samples/courtyard.glb' },
    id: { type: 'string' },
    lighting: { type: 'string' },
    style: { type: 'string' },
    'roof-style': { type: 'string' },
    first: { type: 'string', default: 'flux3-klein' },
    fill: { type: 'string', default: 'fibo2' },
    views: { type: 'string', default: '36' },
    spacing: { type: 'string', default: '4' },
    aerial: { type: 'string', default: '0' },
    roofs: { type: 'string', default: '0' },
    holes: { type: 'string', default: '0' },
    parallel: { type: 'string', default: '1' },
    atlas: { type: 'string', default: '4096' },
    'view-size': { type: 'string', default: '1024' },
    'plan-only': { type: 'boolean', default: false },
    resume: { type: 'string' },
    pbr: { type: 'boolean', default: false },
    'pbr-size': { type: 'string', default: '4096' },
  },
});
if (!a['plan-only'] && !(await falKey())) {
  console.error('FAL_KEY is not set (export FAL_KEY=your-fal-key, or put FAL_KEY=... in .env.local)');
  process.exit(1);
}
const id = a.resume ?? a.id ?? `${a.level.split('/').pop().replace(/\.\w+$/, '')}-${Date.now().toString(36)}`;
// a top-up paints in the light the run was painted in (runs from before overcast painting were sunny)
if (!a.lighting && a.resume) {
  const fs = await import('node:fs');
  const saved = JSON.parse(fs.readFileSync(`runs/${a.resume}/run.json`, 'utf8'));
  a.lighting = saved.lighting?.name ?? 'outdoor';
}
a.lighting ??= 'overcast';
const { server, url } = await startServer();
const browser = await launchBrowser();
const t0 = Date.now();
const log = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${s}`);
try {
  const page = await openApp(browser, url, {
    onLog: log,
    onEvent: (e) => {
      if (e.type === 'view-done') log(`view ${String(e.index).padStart(2)} ${e.model.padEnd(12)} ${e.seconds}s unknown ${(100 * e.unknown).toFixed(0)}% → painted ${(100 * e.coverage).toFixed(1)}% · $${e.cost.toFixed(2)}`);
      else if (e.type === 'save') log(`saving ${e.msg}`);
      else if (e.type === 'pbr') log(`maps: tile ${e.done}/${e.total}`);
      else log(JSON.stringify(e));
    },
  });
  const info = await page.evaluate(([lvl, lighting, atlas, viewSize]) => window.trompe.load(`/${lvl}`, { lighting, atlasSize: +atlas, viewSize: +viewSize }),
    [a.level, a.lighting, a.atlas, a['view-size']]);
  log(`level: ${JSON.stringify(info)}`);
  const planOpts = { maxViews: +a.views, spacing: +a.spacing, aerial: +a.aerial, roofs: +a.roofs, holes: +a.holes, maxParallel: +a.parallel };
  const opts = { firstModel: a.first, fillModel: a.fill, plan: planOpts, ...(a.style ? { style: a.style } : {}),
  ...(a['roof-style'] ? { roofStyle: a['roof-style'] } : {}) };
  if (a.resume) {
    log(`resuming ${JSON.stringify(await page.evaluate((r) => window.trompe.loadRun(r), a.resume))}`);
    // keep the run's look unless told otherwise
    const fs = await import('node:fs');
    const saved = JSON.parse(fs.readFileSync(`runs/${a.resume}/run.json`, 'utf8')).options;
    opts.style ??= saved.style;
    if (saved.roofStyle) opts.roofStyle ??= saved.roofStyle;
  } else {
    const plan = await page.evaluate((o) => window.trompe.plan(o), planOpts);
    log(`plan: ${JSON.stringify(plan)}`);
  }
  if (!a['plan-only']) {
    const res = await page.evaluate((o) => (o.resume ? window.trompe.topUp(o.opts, undefined, o.id) : window.trompe.run(o.opts, undefined, o.id)),
      { resume: !!a.resume, opts, id });
    log(`run: ${JSON.stringify(res)}`);
    if (a.pbr) {
      log(`maps: ${JSON.stringify(await page.evaluate((size) => window.trompe.pbr({ size }), +a['pbr-size']))}`);
      await page.evaluate((runId) => window.trompe.save(runId), id);
    }
    log(`saved to runs/${id}/`);
  }
} finally {
  await browser.close();
  await server.close();
}
