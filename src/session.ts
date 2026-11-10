import * as THREE from 'three';
import { INDOOR, OUTDOOR, OVERCAST, type Lighting } from './core/clay';
import { Engine } from './core/engine';
import { exportGlb } from './core/export';
import { makePbr, type PbrOptions } from './core/pbr';
import { Gpu } from './core/gpu';
import { toBlob, urlToRGBA } from './core/image';
import { runPipeline, type PipelineEvent, type PipelineOptions, type RunRecord, type ViewRecord } from './core/pipeline';
import { DEFAULT_PLAN, plan as makePlan, samplePlayerPoints, type Plan, type PlanOptions } from './core/planner';
import { loadLevel, type Level } from './core/scene';
import { MODELS } from './providers/models';
import type { ViewSpec } from './core/views';
import { Viewer } from './core/viewer';

export const LIGHTING: Record<string, Lighting> = { outdoor: OUTDOOR, overcast: OVERCAST, indoor: INDOOR };

/** One loaded level with its engine and viewer: the object both the UI and the headless API drive. */
export class Session {
  readonly gpu: Gpu;
  level?: Level;
  engine?: Engine;
  viewer?: Viewer;
  plan?: Plan;
  record?: RunRecord;
  private abort?: AbortController;
  /** Uploads of finished views still on their way to disk (see `run`'s `saveAs`). */
  private saving: Promise<void> = Promise.resolve();

  constructor(readonly canvas: HTMLCanvasElement) {
    this.gpu = new Gpu(canvas);
  }

  async load(source: string | ArrayBuffer, name: string, lighting: Lighting = OUTDOOR, atlasSize = 4096, viewSize = 1024) {
    this.viewer?.dispose();
    this.engine?.atlas.dispose();
    this.level = await loadLevel(source, name);
    this.engine = new Engine(this.gpu, this.level, { lighting, atlasSize, viewSize });
    this.viewer = new Viewer(this.engine, this.canvas);
    this.plan = undefined;
    this.record = undefined;
    return { triangles: this.level.triangles, area: Math.round(this.level.surfaceArea) };
  }

  setLighting(l: Lighting) {
    if (!this.engine || !this.viewer) return;
    this.engine.clay.setLighting(l);
    this.viewer.syncLighting();
  }

  makePlan(opts: Partial<PlanOptions> = {}) {
    if (!this.engine) throw new Error('load a level first');
    this.plan = makePlan(this.gpu, this.engine.level, this.engine.views, opts);
    this.viewer!.showPlan(this.plan.points, this.plan.views);
    return this.plan;
  }

  /**
   * Paint the level. With `saveAs` (a run id) every view goes to disk under runs/<id>/ as soon as it's painted,
   * with a run.json that describes the run so far: a crash or a closed tab then loses nothing that was paid for,
   * and `--resume <id>` carries on from it. Saved views drop their images from memory (the composite is kept).
   */
  async run(opts: Partial<PipelineOptions>, onEvent: (e: PipelineEvent) => void, saveAs?: string) {
    if (!this.engine || !this.viewer) throw new Error('load a level first');
    this.abort = new AbortController();
    this.engine.atlas.reset();
    this.clearPbr();
    this.viewer.sky.reset();
    this.viewer.setMode('textured');
    const record = await runPipeline(this.engine, opts, this.during(onEvent, saveAs), this.abort.signal, this.plan);
    this.record = record;
    if (saveAs) await this.saveRun(saveAs);
    return record;
  }

  /** Extend the current run: plan views only where the texture is still missing or poor, paint them on top. */
  async topUp(opts: Partial<PipelineOptions>, onEvent: (e: PipelineEvent) => void, saveAs?: string) {
    if (!this.engine || !this.viewer || !this.record || !this.plan) throw new Error('load a run first');
    this.abort = new AbortController();
    const grid = opts.plan?.grid ?? 256;
    const existing = this.engine.atlas.cellQuality(grid);
    const plan = makePlan(this.gpu, this.engine.level, this.engine.views, { ...opts.plan, grid }, existing);
    const prior = this.record;
    this.clearPbr();   // the texture is about to change under the maps
    const record = await runPipeline(this.engine, opts, this.during(onEvent, saveAs, prior), this.abort.signal, plan,
      { views: prior.views, cost: prior.cost, seconds: prior.seconds, plan: this.plan });
    this.record = record;
    this.plan = record.plan;
    if (saveAs) await this.saveRun(saveAs);
    return record;
  }

  /** The pipeline's events, handled for the viewer and (with `saveAs`) written to disk as they come. */
  private during(onEvent: (e: PipelineEvent) => void, saveAs?: string, prior?: RunRecord) {
    let plan: Plan | undefined;
    let options: PipelineOptions | undefined;
    const done: ViewRecord[] = [];
    const t0 = performance.now();
    return (e: PipelineEvent) => {
      if (e.type === 'planned') {
        plan = e.plan;
        options = e.options;
        if (!prior) this.plan = e.plan;
        this.viewer!.showPlan(e.plan.points, e.plan.views);
      }
      if (e.type === 'view-done') this.addSky(e.view);
      if (e.type === 'done') this.viewer!.sky.finish();
      this.viewer!.dirty = true;
      onEvent(e);
      if (e.type === 'view-done' && saveAs && plan && options) {
        const view = e.view;
        done.push(view);
        // the run so far, as `loadRun` and a top-up would find it: earlier views first, then the ones painted now
        const soFar: RunRecord = prior
          ? { ...prior, options, views: [...prior.views, ...done], cost: prior.cost + e.cost,
              seconds: prior.seconds + (performance.now() - t0) / 1000 }
          : { level: this.engine!.level.name, options, plan, views: [...done], cost: e.cost, seconds: e.elapsed };
        this.saving = this.saving.then(async () => {
          await this.saveView(saveAs, view);
          await this.put(saveAs, 'run.json', JSON.stringify(this.meta(soFar, true), null, 1));
          view.clay = view.state = view.gen = new Uint8ClampedArray(0);
          view.edit = new Uint8Array(0);
        }).catch((err) => console.warn(`saving view ${view.index} failed: ${(err as Error).message}`));
      }
    };
  }

  private clearPbr() {
    if (!this.engine?.pbr) return;
    this.engine.pbr = undefined;
    this.viewer?.setPbr(undefined);
    if (this.record) this.record.pbr = undefined;
  }

  /**
   * Predict normal and roughness maps for the painted texture (one call to the material model per tile) and show
   * them in the lit display. They're exported with the .glb and saved with the run.
   */
  async makePbr(opts: Partial<PbrOptions> = {}, onProgress?: (done: number, total: number) => void) {
    if (!this.engine || !this.viewer) throw new Error('load a level first');
    this.abort = new AbortController();
    const maps = await makePbr(this.engine, opts, onProgress, this.abort.signal);
    this.engine.pbr = maps;
    this.viewer.setPbr(maps);
    if (this.record) this.record.pbr = { size: maps.size, tiles: maps.tiles, cost: maps.cost, seconds: maps.seconds };
    return maps;
  }

  stop() {
    this.abort?.abort();
  }

  /**
   * Where a walk starts: a player's eye position near `near` (default: what the orbit camera looks at). Uses the
   * plan's points when there is a plan, else samples the walkable floor the way the planner does.
   */
  walkStart(near?: THREE.Vector3): THREE.Vector3 {
    if (!this.engine || !this.viewer) throw new Error('load a level first');
    const pts = this.plan?.points.length ? this.plan.points : samplePlayerPoints(this.engine.level, DEFAULT_PLAN);
    const to = near ?? this.viewer.controls.target;
    if (!pts.length) return this.engine.level.bounds.getCenter(new THREE.Vector3()).setY(this.engine.level.bounds.max.y + 2);
    return pts.reduce((best, p) => (p.distanceToSquared(to) < best.distanceToSquared(to) ? p : best)).clone();
  }

  private addSky(v: { spec: ViewSpec; model: string; comp: Uint8ClampedArray }) {
    // only views whose model painted the whole frame: masked fills leave the clay sky as it was
    if (v.spec.kind === 'roof' || MODELS[v.model]?.mask) return;
    this.viewer!.sky.addView(v.spec, v.comp, this.engine!.geometryMask(v.spec), this.engine!.size);
  }

  /** Textured GLB of the level (unlit material with the baked texture). */
  async exportGlb(): Promise<ArrayBuffer> {
    if (!this.engine) throw new Error('nothing to export');
    return exportGlb(this.engine);
  }

  private async put(id: string, file: string, body: Blob | string) {
    const res = await fetch(`/api/runs/${encodeURIComponent(id)}/${file}`, { method: 'POST', body });
    if (!res.ok) throw new Error(`saving ${file} failed: ${res.status}`);
  }

  private meta(r: RunRecord, partial = false) {
    return {
      level: r.level, options: r.options, lighting: this.engine!.clay.lighting, cost: r.cost, seconds: r.seconds,
      ...(partial ? { partial: true } : {}), ...(r.pbr ? { pbr: r.pbr } : {}),
      plan: { points: r.plan.points.map((p) => p.toArray()), views: r.plan.views, waves: r.plan.waves, predicted: r.plan.predicted },
      views: r.views.map(({ clay: _c, state: _s, edit: _e, gen: _g, comp: _p, ...rest }) => rest),
    };
  }

  private async saveView(id: string, v: ViewRecord) {
    if (!v.state.length) return;   // already on disk: saved as it was painted, or loaded for a top-up
    const S = this.engine!.size;
    await this.put(id, `view_${v.index}_clay.jpg`, await toBlob(v.clay, S, S, 'image/jpeg', 0.92));
    await this.put(id, `view_${v.index}_state.jpg`, await toBlob(v.state, S, S, 'image/jpeg', 0.92));
    await this.put(id, `view_${v.index}_gen.jpg`, await toBlob(v.gen, S, S, 'image/jpeg', 0.92));
    await this.put(id, `view_${v.index}_comp.png`, await toBlob(v.comp, S, S, 'image/png'));
  }

  /** Save a run (metadata + every view's images + texture + maps + GLB) through the dev server. */
  async saveRun(id: string, onProgress?: (msg: string) => void) {
    const r = this.record;
    if (!r || !this.engine) throw new Error('no run to save');
    await this.saving;   // views written as they were painted
    for (const v of r.views) {
      if (!v.state.length) continue;
      onProgress?.(`view ${v.index}`);
      await this.saveView(id, v);
    }
    onProgress?.('texture');
    const { data, size } = this.engine.atlas.readBytes();
    await this.put(id, 'texture.png', await toBlob(data, size, size, 'image/png'));
    const sky = this.viewer!.sky;
    await this.put(id, 'sky.jpg', await toBlob(sky.data, sky.width, sky.height, 'image/jpeg', 0.92));
    const pbr = this.engine.pbr;
    if (pbr) {
      onProgress?.('normal and roughness maps');
      await this.put(id, 'normal.png', await toBlob(pbr.normal, pbr.size, pbr.size, 'image/png'));
      await this.put(id, 'orm.png', await toBlob(pbr.orm, pbr.size, pbr.size, 'image/png'));
    }
    onProgress?.('glb');
    await this.put(id, 'level_textured.glb', new Blob([await this.exportGlb()], { type: 'model/gltf-binary' }));
    await this.put(id, 'run.json', JSON.stringify(this.meta(r), null, 1));   // last: a run.json without `partial` is a whole run
  }

  /** Load a saved run and rebuild its texture (no model calls). Returns the view records without images. */
  async loadRun(id: string) {
    if (!this.engine || !this.viewer) throw new Error('load the level first');
    const meta = await (await fetch(`/runs/${id}/run.json`)).json();
    const S = this.engine.size;
    const views: ViewRecord[] = [];
    for (const v of meta.views) {
      const comp = await urlToRGBA(`/runs/${id}/view_${v.index}_comp.png`, S, S);
      views.push({ ...v, comp, clay: new Uint8ClampedArray(0), state: new Uint8ClampedArray(0),
        edit: new Uint8Array(0), gen: new Uint8ClampedArray(0) });
    }
    const points = (meta.plan.points as number[][]).map((p) => new THREE.Vector3(...p));
    this.plan = { ...meta.plan, points } as Plan;
    this.record = { level: meta.level, options: meta.options, plan: this.plan!, views, cost: meta.cost, seconds: meta.seconds,
      pbr: meta.pbr };
    this.engine.replay(views);
    this.viewer.sky.reset();
    for (const v of views) this.addSky(v);
    this.viewer.sky.finish();
    this.engine.pbr = undefined;
    if (meta.pbr) {
      const s = meta.pbr.size as number;
      this.engine.pbr = { ...meta.pbr, normal: await urlToRGBA(`/runs/${id}/normal.png`, s, s),
        orm: await urlToRGBA(`/runs/${id}/orm.png`, s, s) };
    }
    this.viewer.setPbr(this.engine.pbr);
    return meta;
  }
}

export { INDOOR, OUTDOOR };
