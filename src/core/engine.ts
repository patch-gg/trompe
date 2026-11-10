import * as THREE from 'three';
import { Atlas } from './atlas';
import { ClayRenderer, OUTDOOR, type Lighting } from './clay';
import { Gpu } from './gpu';
import type { PbrMaps } from './pbr';
import type { Level } from './scene';
import { makeCamera, ViewRenderer, type ViewSpec } from './views';

export interface EngineOptions {
  viewSize: number;   // px, square views sent to the models
  atlasSize: number;  // px, the baked texture
  lighting: Lighting;
  qualityRatio: number;
}

export const DEFAULT_ENGINE: EngineOptions = { viewSize: 1024, atlasSize: 4096, lighting: OUTDOOR, qualityRatio: 0.4 };

/** Owns the GPU resources for one level: clay renders, view buffers and the texture being painted. */
export class Engine {
  readonly clay: ClayRenderer;
  readonly views: ViewRenderer;
  readonly atlas: Atlas;
  readonly options: EngineOptions;
  /** Normal and roughness maps predicted for the current texture (core/pbr.ts); unset until they're made. */
  pbr?: PbrMaps;
  private readonly clayTarget: THREE.WebGLRenderTarget;
  private readonly compTexture: THREE.DataTexture;

  constructor(readonly gpu: Gpu, readonly level: Level, opts: Partial<EngineOptions> = {}) {
    this.options = { ...DEFAULT_ENGINE, ...opts };
    const s = this.options.viewSize;
    this.clay = new ClayRenderer(gpu, level, this.options.lighting, s);
    this.views = new ViewRenderer(gpu, level, s);
    this.atlas = new Atlas(gpu, level, this.options.atlasSize);
    this.clayTarget = this.clay.makeTarget(s);
    this.compTexture = new THREE.DataTexture(new Uint8Array(s * s * 4), s, s, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.compTexture.minFilter = THREE.LinearFilter;
    this.compTexture.magFilter = THREE.LinearFilter;
    this.compTexture.generateMipmaps = false;
  }

  get size() {
    return this.options.viewSize;
  }

  /** Clay render, geometry buffers and the state image for one view, against the current texture. */
  renderView(spec: ViewSpec, ratio = this.options.qualityRatio) {
    const camera = makeCamera(spec);
    this.views.renderGeometry(camera);
    const g = this.views.geometryTarget.textures;
    this.clay.render(camera, this.clayTarget, { pos: g[0], nrm: g[1] });
    const { state, mask } = this.views.renderState(this.clayTarget.texture, this.atlas.texture, ratio);
    return { camera, state, mask, clay: this.gpu.readU8(this.clayTarget) };
  }

  /** World position and normal (a = part label + 1, 0 = sky) per pixel of the last rendered view, top-down. */
  readGeometry() {
    const t = this.views.geometryTarget;
    return { pos: this.gpu.readF32(t, 0), nrm: this.gpu.readF32(t, 1) };
  }

  /** Project a composited image (top-down RGBA, view size) into the texture from `spec`'s camera. */
  paint(spec: ViewSpec, comp: Uint8ClampedArray) {
    const camera = makeCamera(spec);
    this.views.renderGeometry(camera);
    (this.compTexture.image.data as Uint8Array).set(comp);
    this.compTexture.needsUpdate = true;
    this.atlas.project(camera, this.views.geometryTarget.textures[0], this.compTexture, this.options.qualityRatio);
  }

  /** 1 where a view's pixels show level geometry (0 = sky), top-down. */
  geometryMask(spec: ViewSpec): Uint8Array {
    this.views.renderGeometry(makeCamera(spec));
    const px = this.gpu.readF32(this.views.geometryTarget, 1);
    const m = new Uint8Array(px.length / 4);
    for (let i = 0; i < m.length; i++) m[i] = px[4 * i + 3] > 0.5 ? 1 : 0;
    return m;
  }

  /** Rebuild the texture from recorded composites (no model calls). */
  replay(steps: { spec: ViewSpec; comp: Uint8ClampedArray }[], upTo = steps.length) {
    this.atlas.reset();
    for (let i = 0; i < upTo; i++) this.paint(steps[i].spec, steps[i].comp);
  }
}
