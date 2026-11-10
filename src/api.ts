import * as THREE from 'three';
import { LIGHTING, type Session } from './session';
import { DEFAULT_PIPELINE, generateView, prepareView, promptText, type PipelineEvent, type PipelineOptions } from './core/pipeline';
import type { PbrOptions } from './core/pbr';
import type { PlanOptions } from './core/planner';
import { configureFal } from './providers/fal';
import { plan as makePlan, planStats } from './core/planner';
import { toDataUrl } from './core/image';
import { maskImage } from './core/composite';
import { Demo } from './demo';

/**
 * window.trompe: the same operations as the UI, for headless runs (scripts/texture.mjs) and the demo capture.
 * Progress is printed as `TROMPE {json}` console lines so the Node side can stream it.
 */
export function makeApi(session: Session) {
  const emit = (o: unknown) => console.log(`TROMPE ${JSON.stringify(o)}`);
  const forward = (e: PipelineEvent) => {
    if (e.type === 'planned') emit({ type: e.type, views: e.plan.views.length, waves: e.plan.waves.length,
      points: e.plan.points.length, predicted: e.plan.predicted[e.plan.predicted.length - 1] });
    else if (e.type === 'view-start') emit({ type: e.type, index: e.index, wave: e.wave, model: e.model });
    else if (e.type === 'view-done') emit({ type: e.type, index: e.view.index, model: e.view.model,
      unknown: +e.view.unknownFraction.toFixed(3), left: +(e.view.left ?? 0).toFixed(3), seconds: +e.view.seconds.toFixed(1), coverage: +e.view.coverage.toFixed(3),
      predicted: +e.view.predicted.toFixed(3), cost: +e.cost.toFixed(3), elapsed: +e.elapsed.toFixed(1) });
    else if (e.type === 'error') emit({ type: e.type, index: e.index, message: e.message });
    else if (e.type === 'done') emit({ type: e.type, views: e.record.views.length, cost: e.record.cost, seconds: e.record.seconds });
  };
  return {
    session,
    demo: new Demo(session),
    async load(url: string, opts: { lighting?: string; atlasSize?: number; viewSize?: number; name?: string } = {}) {
      const name = opts.name ?? url.split('/').pop()!.replace(/\.\w+$/, '');
      return session.load(url, name, LIGHTING[opts.lighting ?? 'outdoor'], opts.atlasSize ?? 4096, opts.viewSize ?? 1024);
    },
    plan(opts: Partial<PlanOptions> = {}) {
      const p = session.makePlan(opts);
      return { views: p.views.length, points: p.points.length, waves: p.waves.map((w) => w.length),
        predicted: p.predicted[p.predicted.length - 1], stats: { ...planStats } };
    },
    /** Paint the level. `saveAs`: write every view to runs/<saveAs>/ as it's painted, and the whole run at the end. */
    async run(opts: Partial<PipelineOptions>, falKey?: string, saveAs?: string) {
      configureFal(falKey);
      const record = await session.run(opts, forward, saveAs);
      return { views: record.views.length, cost: record.cost, seconds: record.seconds, coverage: record.views.at(-1)?.coverage ?? 0 };
    },
    /** Continue a loaded run where its texture is still missing or poor. */
    async topUp(opts: Partial<PipelineOptions>, falKey?: string, saveAs?: string) {
      configureFal(falKey);
      const record = await session.topUp(opts, forward, saveAs);
      return { views: record.views.length, cost: record.cost, seconds: record.seconds, coverage: record.views.at(-1)?.coverage ?? 0 };
    },
    /** Normal and roughness maps for the painted texture (one material-model call per tile). */
    async pbr(opts: Partial<PbrOptions> = {}, falKey?: string) {
      configureFal(falKey);
      const m = await session.makePbr(opts, (done, total) => emit({ type: 'pbr', done, total }));
      return { size: m.size, tiles: m.tiles, cost: m.cost, seconds: m.seconds };
    },
    /** Walk the level from the plan's point nearest `near` (or the first), for stills and tests; null to stop. */
    walk(o: { near?: [number, number, number]; yaw?: number } | null = {}) {
      const v = session.viewer!;
      if (!o) { v.stopWalk(); return null; }
      const w = v.startWalk(session.walkStart(o.near ? new THREE.Vector3(...o.near) : undefined), o.yaw ?? 0);
      return { feet: w.position.toArray(), onGround: w.onGround };
    },
    async save(id: string) {
      await session.saveRun(id, (msg) => emit({ type: 'save', msg }));
      return true;
    },
    /** Render the viewer from a camera and return a JPEG data URL (debugging and stills). */
    snapshot(o: { position: [number, number, number]; target: [number, number, number]; fov?: number; width?: number;
      height?: number; mode?: 'clay' | 'textured' | 'lit'; overlay?: boolean }) {
      const v = session.viewer!;
      const w = o.width ?? 1280, h = o.height ?? 720;
      v.resize(w, h);
      v.camera.fov = o.fov ?? 60;
      v.camera.position.set(...o.position);
      v.camera.lookAt(...o.target);
      v.camera.updateProjectionMatrix();
      v.setMode(o.mode ?? 'clay');
      v.overlay.visible = o.overlay ?? true;
      v.render(v.camera);
      return session.canvas.toDataURL('image/jpeg', 0.92);
    },
    bounds() {
      const b = session.level!.bounds;
      return { min: b.min.toArray(), max: b.max.toArray() };
    },
    /** Exercise every GPU pass without calling any model: paints views with their own clay renders. */
    async selfTest(views = 4) {
      const e = session.engine!;
      const p = session.makePlan({ maxViews: views });
      const out: number[] = [];
      for (const spec of p.views.slice(0, views)) {
        const { clay } = e.renderView(spec);
        e.paint(spec, clay);
        out.push(e.atlas.coverage());
      }
      session.viewer!.setMode('textured');
      session.viewer!.render();
      session.viewer!.setMode('clay');
      session.viewer!.render();
      const glb = await session.exportGlb();
      const first = e.renderView(p.views[0]);
      return { coverage: out, glbBytes: glb.byteLength, clay: toDataUrl(first.clay, e.size, e.size, 'image/jpeg', 0.9) };
    },
    /**
     * Prompt A/B without a full run: re-paint chosen views of a saved run (texture rebuilt up to just before each)
     * with other options, and optionally paint `roofs` roof-pass views on top of the finished run. Nothing is saved.
     */
    async promptTest(o: { run: string; views: number[]; variants: { name: string; opts: Partial<PipelineOptions>; seeds?: number[] }[];
      roofs?: number; roofOpts?: Partial<PipelineOptions>; dry?: boolean; fresh?: boolean; falKey?: string }) {
      configureFal(o.falKey);
      const e = session.engine!;
      const S = e.size;
      await session.loadRun(o.run);
      const steps = session.record!.views;
      const jpg = (a: Uint8ClampedArray) => toDataUrl(a, S, S, 'image/jpeg', 0.9);
      const out: Record<string, unknown>[] = [];
      for (const n of o.views) {
        const at = steps.findIndex((v) => v.index === n);
        if (at < 0) continue;
        e.replay(steps, o.fresh ? 0 : at);   // fresh: every view starts from bare clay, as a first view
        for (const v of o.variants) {
          const opts = { ...DEFAULT_PIPELINE, ...v.opts };
          for (const seed of v.seeds ?? [opts.seed + n]) {
            const p = prepareView(e, steps[at].spec, opts, o.fresh || at === 0);
            const t = { view: n, variant: v.name, seed, model: p.model.key, mode: p.prompt.mode, unknown: +p.unknownFraction.toFixed(3),
              prompt: promptText(p), state: jpg(p.state) };
            if (o.dry) { out.push({ ...t, edit: jpg(maskImage(p.edit)) }); continue; }
            try {
              const r = await generateView(p, S, seed, opts.feather);
              out.push({ ...t, gen: jpg(r.gen), comp: jpg(r.comp), expanded: r.expanded });
            } catch (err) {
              out.push({ ...t, error: String((err as Error)?.message ?? err) });
            }
            emit({ type: 'ab', view: n, variant: v.name, seed });
          }
        }
      }
      if (o.roofs) {
        e.replay(steps, o.fresh ? 0 : steps.length);
        const opts = { ...DEFAULT_PIPELINE, ...o.roofOpts };
        const p = makePlan(e.gpu, e.level, e.views, { maxViews: 0, roofs: o.roofs });
        const roofSpecs = p.views.filter((v) => v.kind === 'roof');
        const shots: string[] = [];
        const shoot = () => {
          const b = e.level.bounds;
          const c = b.getCenter(new THREE.Vector3());
          for (const [pos, fov] of [[[c.x + 20, b.max.y + 10, c.z + 24], 50], [[c.x + 6, b.max.y - 4, c.z + 10], 60]] as const) {
            shots.push(this.snapshot({ position: [...pos], target: [c.x - 4, 2, c.z - 6], fov, width: 1280, height: 800,
              mode: 'textured', overlay: false }));
          }
        };
        shoot();
        for (const spec of roofSpecs) {
          const pr = prepareView(e, spec, opts, false);
          const t = { view: `roof${spec.id}`, variant: 'roof', model: pr.model.key, mode: pr.prompt.mode, unknown: +pr.unknownFraction.toFixed(3),
            prompt: promptText(pr), state: jpg(pr.state), spec };
          if (pr.skip || o.dry) { out.push({ ...t, skipped: pr.skip, edit: jpg(maskImage(pr.edit)) }); continue; }
          try {
            const r = await generateView(pr, S, opts.seed + spec.id, opts.feather);
            e.paint(spec, r.comp);
            out.push({ ...t, gen: jpg(r.gen), comp: jpg(r.comp), expanded: r.expanded });
          } catch (err) {
            out.push({ ...t, error: String((err as Error)?.message ?? err) });
          }
          emit({ type: 'ab', view: `roof${spec.id}` });
        }
        shoot();
        out.push({ view: 'roofs', before: shots[0], after: shots[2], stats: { ...planStats } });
        out.push({ view: 'roofs-close', before: shots[1], after: shots[3] });
      }
      return out;
    },
    async loadRun(id: string) {
      const meta = await session.loadRun(id);
      session.viewer?.setMode('textured');
      return { views: meta.views.length, cost: meta.cost };
    },
  };
}
