import * as THREE from 'three';
import { byteTarget, floatTarget, passMaterial, type Gpu } from './gpu';
import type { Level } from './scene';

/**
 * The texture being painted, in UV space. Each texel stores sRGB colour and the quality it was captured at
 * (cos(view angle) / distance; 0 = not painted). Projection passes rasterise the level in UV space and pull
 * colour from a view's composited image wherever that view sees the texel better than what is stored.
 */
const UV_VERT = /* glsl */ `
out vec3 vWorld;
out vec3 vNormal;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
}`;

const PROJECT_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D prev;
uniform sampler2D gPos;
uniform sampler2D comp;
uniform mat4 viewProj;
uniform vec3 camPos;
uniform float ratio;
uniform vec2 texel;
uniform float edgeRadius;
in vec3 vWorld;
in vec3 vNormal;
layout(location = 0) out vec4 outColor;
void main() {
  vec4 old = texelFetch(prev, ivec2(gl_FragCoord.xy), 0);
  outColor = old;
  vec4 clip = viewProj * vec4(vWorld, 1.0);
  if (clip.w <= 0.0) return;
  vec3 ndc = clip.xyz / clip.w;
  if (abs(ndc.x) > 0.999 || abs(ndc.y) > 0.999) return;
  vec2 suv = ndc.xy * 0.5 + 0.5;
  vec3 toCam = camPos - vWorld;
  float dist = length(toCam);
  float cosv = dot(normalize(vNormal), toCam / dist);
  if (cosv < 0.08) return;
  vec4 g = texture(gPos, suv);
  bool sky = g.w <= 0.0;
  if (!sky && dist > g.w + 0.02 + 0.01 * dist) return;
  float q = cosv / max(dist, 0.5);
  // Near a silhouette the model's image is least trustworthy (slight misalignment paints the wrong side onto
  // the edge), so capture it at reduced quality: a view that sees it away from an edge will replace it.
  float edge = 0.0;
  for (int k = 0; k < 8; k++) {
    float a = 0.7853982 * float(k);
    vec4 n = texture(gPos, suv + vec2(cos(a), sin(a)) * edgeRadius * texel);
    if (n.w <= 0.0 || abs(n.w - g.w) > 0.04 * g.w) edge = 1.0;
  }
  q *= mix(1.0, 0.3, edge);
  if (old.a > 0.0 && old.a >= ratio * q) return;
  // comp is premultiplied: pixels a view must not project (alpha 0) drop out, also from the filtered edge
  vec4 c = texture(comp, vec2(suv.x, 1.0 - suv.y));
  if (c.a < 0.5) return;
  outColor = vec4(c.rgb / c.a, q);
}`;

const ISLAND_FRAG = /* glsl */ `
layout(location = 0) out vec4 outColor;
void main() { outColor = vec4(1.0); }`;

const COPY_FRAG = /* glsl */ `
uniform sampler2D src;
layout(location = 0) out vec4 outColor;
void main() { outColor = texelFetch(src, ivec2(gl_FragCoord.xy), 0); }`;

const DILATE_FRAG = /* glsl */ `
uniform sampler2D src;
uniform sampler2D islands;
layout(location = 0) out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 hi = textureSize(src, 0) - 1;
  vec4 c = texelFetch(src, p, 0);
  if (c.a > 0.0 || texelFetch(islands, p, 0).r > 0.5) { outColor = c; return; }
  vec4 acc = vec4(0.0);
  float n = 0.0;
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      vec4 s = texelFetch(src, clamp(p + ivec2(dx, dy), ivec2(0), hi), 0);
      if (s.a > 0.0) { acc += s; n += 1.0; }
    }
  }
  outColor = n > 0.0 ? acc / n : c;
}`;

const BYTES_FRAG = /* glsl */ `
uniform sampler2D src;
uniform vec3 fill;
uniform int cell;
uniform float keepAlpha;
layout(location = 0) out vec4 outColor;
void main() {
  // average the painted texels of each cell x cell block (cell 1: the texel itself)
  ivec2 base = ivec2(gl_FragCoord.xy) * cell;
  vec3 acc = vec3(0.0);
  float n = 0.0;
  for (int y = 0; y < cell; y++) for (int x = 0; x < cell; x++) {
    vec4 c = texelFetch(src, base + ivec2(x, y), 0);
    if (c.a > 0.0) { acc += c.rgb; n += 1.0; }
  }
  outColor = vec4(n > 0.0 ? acc / n : fill, keepAlpha > 0.5 && n == 0.0 ? 0.0 : 1.0);
}`;

const CELL_FRAG = /* glsl */ `
uniform sampler2D src;
uniform int cell;
layout(location = 0) out vec4 outColor;
void main() {
  ivec2 base = ivec2(gl_FragCoord.xy) * cell;
  float q = 0.0;
  for (int y = 0; y < cell; y++) for (int x = 0; x < cell; x++) q = max(q, texelFetch(src, base + ivec2(x, y), 0).a);
  outColor = vec4(q, 0.0, 0.0, 1.0);
}`;

const STATS_FRAG = /* glsl */ `
uniform sampler2D src;
uniform sampler2D islands;
uniform float step;
layout(location = 0) out vec4 outColor;
void main() {
  ivec2 p = ivec2((gl_FragCoord.xy - 0.5) * step + 0.5 * step);
  float island = texelFetch(islands, p, 0).r;
  float known = texelFetch(src, p, 0).a > 0.0 ? 1.0 : 0.0;
  outColor = vec4(island, known * island, 0.0, 1.0);
}`;

export class Atlas {
  private a: THREE.WebGLRenderTarget;
  private b: THREE.WebGLRenderTarget;
  /** Padded copy (UV gutters filled) used for display, state renders and export. */
  readonly display: THREE.WebGLRenderTarget;
  private readonly temp: THREE.WebGLRenderTarget;
  readonly islands: THREE.WebGLRenderTarget;
  private readonly uvScene = new THREE.Scene();
  private readonly uvMesh: THREE.Mesh;
  private readonly uvCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly projectMat: THREE.ShaderMaterial;
  private readonly islandMat: THREE.ShaderMaterial;
  private readonly copyMat = passMaterial(COPY_FRAG, { src: { value: null } });
  private readonly dilateMat = passMaterial(DILATE_FRAG, { src: { value: null }, islands: { value: null } });
  private readonly bytesMat = passMaterial(BYTES_FRAG, { src: { value: null }, fill: { value: new THREE.Vector3(0.5, 0.5, 0.5) },
    cell: { value: 1 }, keepAlpha: { value: 0 } });
  private readonly cellMat = passMaterial(CELL_FRAG, { src: { value: null }, cell: { value: 32 } });
  private readonly statsMat = passMaterial(STATS_FRAG, { src: { value: null }, islands: { value: null }, step: { value: 8 } });

  constructor(private readonly gpu: Gpu, level: Level, readonly size = 4096) {
    this.a = floatTarget(size, size, { half: true, linear: true });
    this.b = floatTarget(size, size, { half: true, linear: true });
    this.display = floatTarget(size, size, { half: true, linear: true });
    this.temp = floatTarget(size, size, { half: true, linear: true });
    this.islands = byteTarget(size, size, { linear: false });
    this.projectMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: UV_VERT, fragmentShader: PROJECT_FRAG, side: THREE.DoubleSide,
      depthTest: false, depthWrite: false,
      uniforms: { prev: { value: null }, gPos: { value: null }, comp: { value: null }, viewProj: { value: new THREE.Matrix4() },
        camPos: { value: new THREE.Vector3() }, ratio: { value: 0.4 }, texel: { value: new THREE.Vector2(1 / 1024, 1 / 1024) },
        edgeRadius: { value: 6 } },
    });
    this.islandMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: UV_VERT, fragmentShader: ISLAND_FRAG, side: THREE.DoubleSide,
      depthTest: false, depthWrite: false,
    });
    this.uvMesh = new THREE.Mesh(level.geometry, this.islandMat);
    this.uvMesh.frustumCulled = false;
    this.uvScene.add(this.uvMesh);
    this.gpu.draw(this.uvScene, this.uvCam, this.islands, 0x000000, 0);
    this.reset();
  }

  /** The padded texture to sample (rgb = sRGB colour, a = capture quality, 0 = unpainted). */
  get texture(): THREE.Texture {
    return this.display.texture;
  }

  reset() {
    for (const t of [this.a, this.b, this.display, this.temp]) this.gpu.draw(new THREE.Scene(), this.uvCam, t, 0x000000, 0);
  }

  /** Paint from one view: `gPos` is that view's position/distance buffer, `comp` its composited image. */
  project(camera: THREE.Camera, gPos: THREE.Texture, comp: THREE.Texture, ratio: number) {
    this.copyMat.uniforms.src.value = this.a.texture;
    this.gpu.pass(this.copyMat, this.b);
    const u = this.projectMat.uniforms;
    u.prev.value = this.a.texture;
    u.gPos.value = gPos;
    u.comp.value = comp;
    u.viewProj.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    u.camPos.value.setFromMatrixPosition(camera.matrixWorld);
    u.ratio.value = ratio;
    const img = gPos.image as { width: number; height: number };
    u.texel.value.set(1 / img.width, 1 / img.height);
    u.edgeRadius.value = (6 * img.width) / 1024;   // same angular band at any view size
    this.uvMesh.material = this.projectMat;
    this.gpu.draw(this.uvScene, this.uvCam, this.b, null);
    this.uvMesh.material = this.islandMat;
    [this.a, this.b] = [this.b, this.a];
    this.pad();
  }

  /** Fill UV gutters around islands so bilinear sampling never pulls in unpainted texels. */
  pad(iterations = 6) {
    this.copyMat.uniforms.src.value = this.a.texture;
    this.gpu.pass(this.copyMat, this.display);
    this.dilateMat.uniforms.islands.value = this.islands.texture;
    let src = this.display;
    let dst = this.temp;
    for (let i = 0; i < iterations; i++) {
      this.dilateMat.uniforms.src.value = src.texture;
      this.gpu.pass(this.dilateMat, dst);
      [src, dst] = [dst, src];
    }
    if (src !== this.display) {
      this.copyMat.uniforms.src.value = src.texture;
      this.gpu.pass(this.copyMat, this.display);
    }
  }

  /** Share of island texels painted so far (sampled every 8th texel). */
  coverage(): number {
    const n = Math.floor(this.size / 8);
    const rt = byteTarget(n, n, { linear: false });
    this.statsMat.uniforms.src.value = this.a.texture;
    this.statsMat.uniforms.islands.value = this.islands.texture;
    this.gpu.pass(this.statsMat, rt);
    const px = this.gpu.readU8(rt, 0, false);
    rt.dispose();
    let island = 0;
    let known = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i] > 127) island++;
      if (px[i + 1] > 127) known++;
    }
    return island ? known / island : 0;
  }

  /** Best capture quality per UV cell (grid x grid, row = v), for planning views that fill what's missing. */
  cellQuality(grid: number): Float32Array {
    const rt = floatTarget(grid, grid);
    this.cellMat.uniforms.src.value = this.a.texture;
    this.cellMat.uniforms.cell.value = Math.floor(this.size / grid);
    this.gpu.pass(this.cellMat, rt);
    const px = this.gpu.readF32(rt, 0, false);
    rt.dispose();
    const q = new Float32Array(grid * grid);
    for (let i = 0; i < q.length; i++) q[i] = px[4 * i];
    return q;
  }

  /**
   * RGBA8 export of the padded texture in glTF image order (first row = v 0). `size` (the texture's size divided by
   * a whole number) averages it down; with `alpha`, unpainted texels come back with alpha 0 instead of 255.
   */
  readBytes(fill: [number, number, number] = [0.5, 0.5, 0.5], size = this.size, alpha = false): { data: Uint8ClampedArray; size: number } {
    const cell = Math.max(1, Math.round(this.size / size));
    const n = Math.floor(this.size / cell);
    const rt = byteTarget(n, n, { linear: false });
    const u = this.bytesMat.uniforms;
    u.src.value = this.display.texture;
    u.fill.value.set(...fill);
    u.cell.value = cell;
    u.keepAlpha.value = alpha ? 1 : 0;
    this.gpu.pass(this.bytesMat, rt);
    const data = this.gpu.readU8(rt, 0, false);
    rt.dispose();
    return { data, size: n };
  }

  dispose() {
    for (const t of [this.a, this.b, this.display, this.temp, this.islands]) t.dispose();
  }
}
