import { MODELS, prompts, type EditModel, type PromptContext } from '../providers/models';
import { runEdit } from '../providers/fal';
import { colorCorrect, dilate, editMask, featherComposite, fraction, keepOnly, maskImage, masksFromState, paintedFromState, untouched,
  type ViewMasks } from './composite';
import type { Engine } from './engine';
import { bitmapToRGBA, toDataUrl } from './image';
import { DEFAULT_PLAN, holeViews, plan as makePlan, type Plan, type PlanOptions } from './planner';
import { classifyView, describeView } from './semantics';
import { makeCamera, ViewRenderer, type ViewSpec } from './views';

export interface PipelineOptions {
  /** The look, as materials only: anything named here (a fountain, a stall) gets painted onto walls. */
  style: string;
  /** Roof material for the roof passes. */
  roofStyle: string;
  firstModel: string;
  fillModel: string;
  /** Views with more than this share of unpainted geometry use the first-view model. */
  mostlyNew: number;
  feather: number;
  seed: number;
  plan: Partial<PlanOptions>;
}

export const DEFAULT_PIPELINE: PipelineOptions = {
  style: 'a Mediterranean hill village: weathered limestone and ochre plaster walls, wooden doors and shutters, worn cobblestone paving',
  roofStyle: 'old terracotta clay roof tiles: curved Mediterranean tiles in neat rows running down the slope, weathered and slightly uneven, with patches of lichen',
  firstModel: 'flux3-klein', fillModel: 'fibo2', mostlyNew: 0.75, feather: 10, seed: 7, plan: {},
};

export interface ViewRecord {
  index: number;
  wave: number;
  spec: ViewSpec;
  model: string;
  first: boolean;
  unknownFraction: number;
  /** The prompt text sent with this view. */
  prompt?: string;
  /** Share of the area to paint that the model handed back unpainted (left out of the projection). */
  left?: number;
  seconds: number;
  price: number;
  /** top-down RGBA at view size */
  clay: Uint8ClampedArray;
  state: Uint8ClampedArray;
  edit: Uint8Array;
  gen: Uint8ClampedArray;
  comp: Uint8ClampedArray;
  coverage: number;   // painted share of the texture after this view
  predicted: number;  // planner's share of reachable surface captured after this view
}

export interface RunRecord {
  level: string;
  options: PipelineOptions;
  plan: Plan;
  views: ViewRecord[];
  /** What the image models cost (the PBR maps, when made, are counted in `pbr`). */
  cost: number;
  seconds: number;
  /** Normal and roughness maps made for this run's texture (core/pbr.ts). */
  pbr?: { size: number; tiles: number; cost: number; seconds: number };
}

export type PipelineEvent =
  | { type: 'planned'; plan: Plan; options: PipelineOptions }
  | { type: 'view-start'; index: number; wave: number; model: string; state: Uint8ClampedArray }
  | { type: 'view-done'; view: ViewRecord; cost: number; elapsed: number }
  | { type: 'error'; index: number; message: string }
  | { type: 'done'; record: RunRecord };

async function withRetry<T>(fn: (attempt: number) => Promise<T>, tries = 2): Promise<T> {
  let last: unknown;
  for (let a = 0; a < tries; a++) {
    try {
      return await fn(a);
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

/** One view rendered against the current texture, with what to ask the model for. */
export interface PreparedView {
  spec: ViewSpec;
  clay: Uint8ClampedArray;
  state: Uint8ClampedArray;
  /** Masks the model's answer is composited with (roof passes leave unpainted non-roof pixels out of them). */
  masks: ViewMasks;
  /** 1 wherever the view shows the level, whatever the pass. */
  geometry: Uint8Array;
  edit: Uint8Array;
  /** Only these pixels are projected (roof and hole passes); everything when undefined. */
  keep?: Uint8Array;
  unknownFraction: number;
  isFirst: boolean;
  skip: boolean;
  model: EditModel;
  prompt: PromptContext;
}

/**
 * @param roofsByPass the run has roof passes: other views leave unpainted roofs alone (from the street the models
 *   see them at a graze and paint them as walls or sky, and a roof pass rarely sees them enough better to replace it)
 */
export function prepareView(engine: Engine, spec: ViewSpec, o: PipelineOptions, startOfRun: boolean,
  roofsByPass = false): PreparedView {
  const first = MODELS[o.firstModel], fill = MODELS[o.fillModel];
  if (!first || !fill) throw new Error(`unknown model ${!first ? o.firstModel : o.fillModel}`);
  const S = engine.size;
  // hole views keep everything painted, however poor, so the model sees it as it is
  const { state, mask, clay } = engine.renderView(spec, spec.kind === 'fill' ? 0 : undefined);
  const { pos, nrm } = engine.readGeometry();
  const labels = engine.level.labels;
  const cls = classifyView(nrm, pos, labels, engine.level.bounds.min.y);
  let masks = masksFromState(mask);
  const geometry = masks.geometry;
  const roofPass = spec.kind === 'roof';
  const fillPass = spec.kind === 'fill';
  let keep: Uint8Array | undefined;
  if (roofPass) {
    // Paint roofs only. Unpainted walls and ground in view are left out entirely (not targets, not references).
    keep = cls.roof;
    masks = { geometry: masks.geometry.map((g, i) => g & (masks.known[i] | cls.roof[i])), known: masks.known };
  } else if (fillPass) {
    // Paint only what nothing has painted yet; everything else in view is reference, however poor.
    const painted = paintedFromState(mask);
    masks = { geometry: masks.geometry, known: masks.geometry.map((g, i) => g & painted[i]) };
    keep = dilate(masks.geometry.map((g, i) => g & (1 - painted[i])), S, S, 2);
  } else if (roofsByPass) {
    // Roofs wait for their own passes: unpainted roofs are neither targets nor references here.
    masks = { geometry: masks.geometry.map((g, i) => g & (masks.known[i] | (1 - cls.roof[i]))), known: masks.known };
    keep = geometry.map((g, i) => g & (1 - cls.roof[i]));
  }
  const unknown = masks.geometry.map((g, i) => (g && !masks.known[i] ? 1 : 0));
  const unknownFraction = fraction(unknown, roofPass ? cls.roof : masks.geometry);   // over what this pass may paint
  const isFirst = !roofPass && !fillPass && (startOfRun || unknownFraction > 0.97);
  // nearly everything in view is already good: no model call (the hole pass picks its views by what's missing)
  const skip = fillPass ? unknownFraction === 0 : !isFirst && unknownFraction < 0.03;
  const model = roofPass || fillPass ? fill : isFirst || unknownFraction > o.mostlyNew ? first : fill;
  const edit = editMask(masks, S, S, Math.round(3 * S / 1024));
  const desc = describeView(cls, labels, S, isFirst ? undefined : edit);
  const prompt: PromptContext = { look: o.style, roofLook: o.roofStyle, parts: desc.parts,
    mode: roofPass ? 'roof' : isFirst ? 'first' : 'fill', floor: desc.floorShare > 0.5, overcast: !!engine.clay.lighting.overcast };
  return { spec, clay, state, masks, geometry, edit, keep, unknownFraction, isFirst, skip, model, prompt };
}

export const promptText = (p: Pick<PreparedView, 'model' | 'prompt'>) =>
  p.model.key === 'flux3-klein' ? prompts.caption(p.prompt) : prompts.instruction(p.prompt);

/** Ask the model for one prepared view and composite its answer next to the known texture. */
export async function generateView(p: PreparedView, size: number, seed: number, feather: number, signal?: AbortSignal) {
  const r = await runEdit(p.model, {
    imageUrl: toDataUrl(p.state, size, size, 'image/jpeg', 0.95),
    maskUrl: p.model.mask ? toDataUrl(maskImage(p.edit, p.model.mask === 'black'), size, size) : undefined,
    prompt: p.prompt, seed, size,
  }, signal);
  const gen = bitmapToRGBA(r.image, size, size);
  const k = size / 1024;   // pixel radii below are tuned at 1024 px views
  const corrected = colorCorrect(p.state, gen, p.masks, size, size, { band: 6 * k, blur: Math.round(8 * k), falloff: 120 * k });
  let comp = featherComposite(p.state, corrected, p.masks, size, size, feather * k);
  // Whatever the model left as gray clay stays unpainted, so a later view (or the hole pass) gets another go at it.
  const unknown = p.masks.geometry.map((g, i) => (g && !p.masks.known[i] ? 1 : 0));
  const leftOver = untouched(p.state, gen, unknown, size, size);
  let nLeft = 0, nUnknown = 0;
  for (let i = 0; i < unknown.length; i++) { nLeft += leftOver[i]; nUnknown += unknown[i]; }
  const keep = nLeft ? (p.keep ?? p.geometry).map((v, i) => v & (1 - leftOver[i])) : p.keep;
  if (keep) comp = keepOnly(comp, keep, p.geometry);
  return { gen, comp, seconds: r.seconds, expanded: r.expanded, left: nUnknown ? nLeft / nUnknown : 0 };
}

/**
 * The most a planned run can cost, and roughly how long it takes. Which model paints a view is only known once the
 * views before it are painted (mostly-unpainted views go to the first-view model), so every view after the first
 * is counted at the dearer of the two; roof and hole views always use the fill model. About 10 s a wave.
 */
export function quote(plan: Pick<Plan, 'views' | 'waves'>, o: { firstModel: string; fillModel: string; holes?: number }) {
  const first = MODELS[o.firstModel]?.price ?? 0, fill = MODELS[o.fillModel]?.price ?? 0;
  const holes = o.holes ?? 0;
  let cost = holes * fill;
  plan.views.forEach((v, i) => { cost += i === 0 ? first : v.kind === 'roof' || v.kind === 'fill' ? fill : Math.max(first, fill); });
  return { views: plan.views.length + holes, cost, seconds: 10 * (plan.waves.length + holes) };
}

/** A run being extended (top-up): its views stay as they are and new views continue its numbering. */
export interface Continuation { views: ViewRecord[]; cost: number; seconds: number; plan: Plan }

export async function runPipeline(engine: Engine, opts: Partial<PipelineOptions>, onEvent: (e: PipelineEvent) => void,
  signal?: AbortSignal, existingPlan?: Plan, cont?: Continuation): Promise<RunRecord> {
  const o: PipelineOptions = { ...DEFAULT_PIPELINE, ...opts, plan: { ...DEFAULT_PIPELINE.plan, ...opts.plan } };
  const t0 = performance.now();
  const plan = existingPlan ?? makePlan(engine.gpu, engine.level, engine.views, o.plan);
  onEvent({ type: 'planned', plan, options: o });
  const S = engine.size;
  const views: ViewRecord[] = [];
  let cost = 0;
  const roofsByPass = (o.plan.roofs ?? 0) > 0 || !!cont?.views.some((v) => v.spec.kind === 'roof');
  const indexBase = cont ? Math.max(-1, ...cont.views.map((v) => v.index)) + 1 : 0;
  const waveBase = cont ? Math.max(-1, ...cont.views.map((v) => v.wave)) + 1 : 0;
  for (let w = 0; w < plan.waves.length; w++) {
    if (signal?.aborted) break;
    const prepared = plan.waves[w].map((vi) => {
      const p = { vi, ...prepareView(engine, { ...plan.views[vi], id: indexBase + vi }, o, vi === 0 && !cont, roofsByPass) };
      if (!p.skip) onEvent({ type: 'view-start', index: indexBase + vi, wave: waveBase + w, model: p.model.key, state: p.state });
      return p;
    });
    const todo = prepared.filter((p) => !p.skip);
    const results = await Promise.all(todo.map((p) => withRetry((attempt) =>
      generateView(p, S, o.seed + 1000 * attempt + indexBase + p.vi, o.feather, signal))
      .then((r) => ({ ok: true as const, r }), (e) => ({ ok: false as const, e }))));
    for (let k = 0; k < todo.length; k++) {
      const p = todo[k];
      const res = results[k];
      if (!res.ok) {
        onEvent({ type: 'error', index: indexBase + p.vi, message: String((res.e as Error)?.message ?? res.e) });
        continue;
      }
      engine.paint(p.spec, res.r.comp);
      cost += p.model.price;
      const view: ViewRecord = {
        index: indexBase + p.vi, wave: waveBase + w, spec: p.spec, model: p.model.key, first: p.isFirst, unknownFraction: p.unknownFraction,
        prompt: promptText(p), left: res.r.left, seconds: res.r.seconds, price: p.model.price, clay: p.clay, state: p.state, edit: p.edit,
        gen: res.r.gen, comp: res.r.comp, coverage: engine.atlas.coverage(), predicted: plan.predicted[p.vi],
      };
      views.push(view);
      onEvent({ type: 'view-done', view, cost, elapsed: (performance.now() - t0) / 1000 });
    }
  }
  // Hole pass: texels nothing painted (ground behind props, tops of props) from views that actually see them.
  const holeBudget = o.plan.holes ?? DEFAULT_PLAN.holes;
  if (holeBudget > 0 && !signal?.aborted) {
    const cands = holeViews(engine.level, { ...DEFAULT_PLAN, ...o.plan }, plan.points);
    const probe = new ViewRenderer(engine.gpu, engine.level, 128);
    const used = new Set<number>();
    for (let n = 0; n < holeBudget && !signal?.aborted; n++) {
      let best = -1, bestPx = 0;
      cands.forEach((c, k) => {
        if (used.has(k)) return;
        probe.renderGeometry(makeCamera(c));
        const { mask } = probe.renderState(engine.atlas.texture, engine.atlas.texture, engine.options.qualityRatio);
        let px = 0;
        for (let i = 0; i < mask.length; i += 4) if (mask[i] > 127 && mask[i + 2] < 128) px++;
        if (px > bestPx) { bestPx = px; best = k; }
      });
      if (best < 0 || bestPx < 0.004 * 128 * 128) break;   // under ~65 of 16k probe pixels: not worth a call
      used.add(best);
      const vi = plan.views.length;
      plan.views.push({ ...cands[best], id: vi });
      plan.waves.push([vi]);
      plan.viewCells.push({ cells: new Int32Array(0), q: new Float32Array(0) });
      plan.predicted.push(plan.predicted[plan.predicted.length - 1] ?? 0);
      const p = prepareView(engine, { ...cands[best], id: indexBase + vi }, o, false);
      if (p.skip) continue;
      const wave = waveBase + plan.waves.length - 1;
      onEvent({ type: 'view-start', index: indexBase + vi, wave, model: p.model.key, state: p.state });
      try {
        const r = await withRetry((attempt) => generateView(p, S, o.seed + 1000 * attempt + indexBase + vi, o.feather, signal));
        engine.paint(p.spec, r.comp);
        cost += p.model.price;
        const view: ViewRecord = {
          index: indexBase + vi, wave, spec: p.spec, model: p.model.key, first: false, unknownFraction: p.unknownFraction,
          prompt: promptText(p), left: r.left, seconds: r.seconds, price: p.model.price, clay: p.clay, state: p.state, edit: p.edit,
          gen: r.gen, comp: r.comp, coverage: engine.atlas.coverage(), predicted: plan.predicted[vi],
        };
        views.push(view);
        onEvent({ type: 'view-done', view, cost, elapsed: (performance.now() - t0) / 1000 });
      } catch (e) {
        onEvent({ type: 'error', index: indexBase + vi, message: String((e as Error)?.message ?? e) });
      }
    }
    probe.geometryTarget.dispose();
    probe.stateTarget.dispose();
  }
  const seconds = (performance.now() - t0) / 1000;
  const record: RunRecord = cont
    ? { level: engine.level.name, options: o, views: [...cont.views, ...views], cost: cont.cost + cost, seconds: cont.seconds + seconds,
        plan: { ...plan, points: plan.points, views: [...cont.plan.views, ...plan.views.map((v, i) => ({ ...v, id: indexBase + i }))],
          waves: [...cont.plan.waves, ...plan.waves.map((wv) => wv.map((vi) => vi + cont.plan.views.length))],
          viewCells: [...cont.plan.viewCells ?? [], ...plan.viewCells], predicted: [...cont.plan.predicted, ...plan.predicted] } }
    : { level: engine.level.name, options: o, plan, views, cost, seconds };
  onEvent({ type: 'done', record });
  return record;
}
