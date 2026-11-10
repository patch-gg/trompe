import { runMaterial } from '../providers/fal';
import { MATERIAL_MODEL } from '../providers/models';
import type { Engine } from './engine';
import { bitmapToRGBA, toCanvas } from './image';

/**
 * Normal and roughness maps for the baked texture, so the engine's light picks out stonework, frames and shutters
 * instead of sliding over a flat photo. A material model (PATINA on fal) reads the texture in tiles and predicts a
 * normal and a roughness map for each; `detailMaps` then keeps only the fine detail.
 *
 * Why only the detail: the model sees a UV layout as a scene of tilted slabs, one per island, and leans each
 * island's normals over as a whole. A flat wall has no such lean in tangent space, so the local median is
 * subtracted (it follows the lean and ignores thin features) and what's left is the relief. Roughness gets the same
 * treatment around a matte base, because the model's absolute level can't be trusted either.
 */
export interface PbrOptions {
  /** Map size in px (the texture's size divided by a whole number; at most the texture's own). */
  size: number;
  seed: number;
  /** Scale of the relief in the normal map. */
  strength: number;
  /** Roughness of a surface the model sees no variation on, and how much of its variation to keep. */
  baseRoughness: number;
  roughnessGain: number;
  /** Tiles sent to the model at the same time. */
  parallel: number;
}

export const DEFAULT_PBR: PbrOptions = { size: 4096, seed: 7, strength: 1, baseRoughness: 0.88, roughnessGain: 0.9, parallel: 4 };

export interface PbrMaps {
  size: number;
  /** Tangent-space normal map, RGBA8 in glTF image order and glTF's convention (+Y up in the image). */
  normal: Uint8ClampedArray;
  /** glTF occlusion/roughness/metalness packing: R = 255 (no occlusion), G = roughness, B = 0 (not metal). */
  orm: Uint8ClampedArray;
  tiles: number;
  cost: number;
  seconds: number;
}

/** Largest image the material model takes, and how far neighbouring tiles overlap (px of the map). */
export const TILE_MAX = 2048;
export const TILE_OVERLAP = 192;

export interface TileLayout {
  /** Tiles per side. */
  n: number;
  /** Side of the square region of the map each tile covers; scaled down to `sent` px for the model. */
  region: number;
  sent: number;
  /** Top-left corner of each tile's region, row by row. */
  tiles: { x: number; y: number; col: number; row: number }[];
}

/** Square tiles covering a `size` px map, overlapping by `overlap` so their seams can be blended away. */
export function tileLayout(size: number, max = TILE_MAX, overlap = TILE_OVERLAP): TileLayout {
  const n = Math.max(1, Math.round(size / max));
  const region = n === 1 ? size : Math.ceil((size + (n - 1) * overlap) / n);
  const tiles: TileLayout['tiles'] = [];
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      const at = (k: number) => (n === 1 ? 0 : Math.round((k * (size - region)) / (n - 1)));
      tiles.push({ x: at(col), y: at(row), col, row });
    }
  }
  return { n, region, sent: Math.min(region, max), tiles };
}

/**
 * Lay one tile into the map. Tiles go in row by row; each fades in over the strip it shares with the tile to its
 * left and the one above, so no seam is left where two predictions meet.
 */
export function blendTile(map: Uint8ClampedArray, size: number, tile: Uint8ClampedArray, region: number,
  t: { x: number; y: number; col: number; row: number }, overlap: number) {
  for (let y = 0; y < region; y++) {
    const ay = t.row > 0 && y < overlap ? (y + 0.5) / overlap : 1;
    for (let x = 0; x < region; x++) {
      const a = ay * (t.col > 0 && x < overlap ? (x + 0.5) / overlap : 1);
      const i = 4 * ((t.y + y) * size + t.x + x), j = 4 * (y * region + x);
      for (let c = 0; c < 3; c++) map[i + c] = map[i + c] + (tile[j + c] - map[i + c]) * a;
      map[i + 3] = 255;
    }
  }
}

/**
 * Median of the masked values in a (2r+1)² window around each pixel (Huang's sliding histogram, so the window
 * size costs nothing). Pixels with no masked neighbour keep their own value.
 */
export function medianMasked(src: Uint8Array, mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const out = new Uint8Array(w * h);
  const hist = new Int32Array(256);
  const coarse = new Int32Array(16);
  for (let y = 0; y < h; y++) {
    hist.fill(0);
    coarse.fill(0);
    let count = 0;
    const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r);
    const column = (x: number, sign: number) => {
      for (let yy = y0; yy <= y1; yy++) {
        const i = yy * w + x;
        if (!mask[i]) continue;
        hist[src[i]] += sign;
        coarse[src[i] >> 4] += sign;
        count += sign;
      }
    };
    for (let x = 0; x <= Math.min(w - 1, r); x++) column(x, 1);
    for (let x = 0; x < w; x++) {
      if (x > 0) {
        if (x + r < w) column(x + r, 1);
        if (x - r - 1 >= 0) column(x - r - 1, -1);
      }
      if (!count) { out[y * w + x] = src[y * w + x]; continue; }
      const target = (count + 1) >> 1;
      let acc = 0, c = 0;
      while (acc + coarse[c] < target) acc += coarse[c++];
      let v = c << 4;
      while (acc + hist[v] < target) acc += hist[v++];
      out[y * w + x] = v;
    }
  }
  return out;
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Turn the model's raw prediction into the maps to ship.
 * @param raw RGBA per texel: R, G = the predicted normal's x, y (0-255); B = predicted roughness
 * @param mask 1 where the texture is painted
 */
export function detailMaps(raw: Uint8ClampedArray, mask: Uint8Array, size: number,
  o: Pick<PbrOptions, 'strength' | 'baseRoughness' | 'roughnessGain'> = DEFAULT_PBR): { normal: Uint8ClampedArray; orm: Uint8ClampedArray } {
  // 1. A coarse copy (about 1024 px a side): each cell is the mean of its painted texels.
  const f = Math.max(1, Math.round(size / 1024));
  const lw = Math.ceil(size / f);
  const lo = [new Uint8Array(lw * lw), new Uint8Array(lw * lw), new Uint8Array(lw * lw)];
  const some = new Uint8Array(lw * lw), all = new Uint8Array(lw * lw);
  for (let ly = 0; ly < lw; ly++) {
    for (let lx = 0; lx < lw; lx++) {
      let n = 0, cells = 0, s0 = 0, s1 = 0, s2 = 0;
      for (let y = ly * f; y < Math.min(size, (ly + 1) * f); y++) {
        for (let x = lx * f; x < Math.min(size, (lx + 1) * f); x++) {
          cells++;
          if (!mask[y * size + x]) continue;
          const i = 4 * (y * size + x);
          s0 += raw[i]; s1 += raw[i + 1]; s2 += raw[i + 2];
          n++;
        }
      }
      const k = ly * lw + lx;
      if (n) { lo[0][k] = Math.round(s0 / n); lo[1][k] = Math.round(s1 / n); lo[2][k] = Math.round(s2 / n); some[k] = 1; }
      all[k] = n === cells ? 1 : 0;
    }
  }
  // 2. The lean of each island: a 9-cell median follows it right up to the island's edge and ignores thin relief.
  const med = lo.map((c) => medianMasked(c, some, lw, lw, 4));
  // 3. Trust: none near unpainted texels or where the lean jumps (two islands packed side by side), since the
  //    model draws a bevel along every island's edge; full inside.
  let trust = new Float32Array(lw * lw);
  for (let y = 0; y < lw; y++) {
    for (let x = 0; x < lw; x++) {
      const k = y * lw + x;
      let t = all[k] ? 1 : 0;
      for (let dy = -2; dy <= 2 && t > 0; dy++) {
        for (let dx = -2; dx <= 2 && t > 0; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= lw || yy >= lw) continue;   // the map's border is not an island's edge
          const j = yy * lw + xx;
          if (!all[j]) { t = 0; break; }
          if (Math.abs(dx) > 1 || Math.abs(dy) > 1) continue;
          const jump = Math.max(Math.abs(med[0][k] - med[0][j]), Math.abs(med[1][k] - med[1][j])) / 127.5;
          t = Math.min(t, 1 - smoothstep(0.06, 0.16, jump));
        }
      }
      trust[k] = t;
    }
  }
  for (const [dxs, dys] of [[1, 0], [0, 1]]) {   // soften: 3-cell box blur, one axis at a time
    const next = new Float32Array(lw * lw);
    for (let y = 0; y < lw; y++) {
      for (let x = 0; x < lw; x++) {
        let s = 0;
        for (let d = -1; d <= 1; d++) {
          const xx = Math.min(lw - 1, Math.max(0, x + d * dxs)), yy = Math.min(lw - 1, Math.max(0, y + d * dys));
          s += trust[yy * lw + xx];
        }
        next[y * lw + x] = s / 3;
      }
    }
    trust = next;
  }
  // 4. Full size: prediction minus the (bilinearly enlarged) lean, scaled by trust.
  const normal = new Uint8ClampedArray(size * size * 4);
  const orm = new Uint8ClampedArray(size * size * 4);
  const base = Math.round(255 * o.baseRoughness);
  for (let y = 0; y < size; y++) {
    const fy = Math.min(lw - 1, Math.max(0, (y + 0.5) / f - 0.5));
    const y0 = Math.floor(fy), y1 = Math.min(lw - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < size; x++) {
      const p = y * size + x, i = 4 * p;
      normal[i] = normal[i + 1] = 128; normal[i + 2] = normal[i + 3] = 255;
      orm[i] = 255; orm[i + 1] = base; orm[i + 2] = 0; orm[i + 3] = 255;
      if (!mask[p]) continue;
      const fx = Math.min(lw - 1, Math.max(0, (x + 0.5) / f - 0.5));
      const x0 = Math.floor(fx), x1 = Math.min(lw - 1, x0 + 1), tx = fx - x0;
      const a = y0 * lw + x0, b = y0 * lw + x1, c = y1 * lw + x0, d = y1 * lw + x1;
      const wa = (1 - tx) * (1 - ty), wb = tx * (1 - ty), wc = (1 - tx) * ty, wd = tx * ty;
      const t = trust[a] * wa + trust[b] * wb + trust[c] * wc + trust[d] * wd;
      if (t <= 0) continue;
      const lean = (m: Uint8Array) => m[a] * wa + m[b] * wb + m[c] * wc + m[d] * wd;
      let nx = ((raw[i] - lean(med[0])) / 127.5) * t * o.strength;
      let ny = ((raw[i + 1] - lean(med[1])) / 127.5) * t * o.strength;
      const len = Math.hypot(nx, ny);
      if (len > 0.85) { nx *= 0.85 / len; ny *= 0.85 / len; }
      normal[i] = 127.5 + 127.5 * nx;
      normal[i + 1] = 127.5 + 127.5 * ny;
      normal[i + 2] = 127.5 + 127.5 * Math.sqrt(1 - nx * nx - ny * ny);
      orm[i + 1] = Math.min(255, Math.max(64, base + o.roughnessGain * t * (raw[i + 2] - lean(med[2]))));
    }
  }
  return { normal, orm };
}

/** What `makePbr` would send: tiles with something painted on them, and fal's listed price for those. */
export function pbrQuote(textureSize: number, size = DEFAULT_PBR.size) {
  const s = Math.min(size, textureSize);
  const l = tileLayout(s);
  const megapixels = (l.tiles.length * l.sent * l.sent) / 1e6;
  return { size: s, tiles: l.tiles.length, cost: megapixels * MATERIAL_MODEL.price };
}

/** Predict normal and roughness maps for the engine's current texture. Calls the material model once per tile. */
export async function makePbr(engine: Engine, opts: Partial<PbrOptions> = {}, onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal): Promise<PbrMaps> {
  const o = { ...DEFAULT_PBR, ...opts };
  const t0 = performance.now();
  const { data, size } = engine.atlas.readBytes([0.5, 0.5, 0.5], Math.min(o.size, engine.atlas.size), true);
  const mask = new Uint8Array(size * size);
  for (let p = 0; p < mask.length; p++) { mask[p] = data[4 * p + 3] ? 1 : 0; data[4 * p + 3] = 255; }
  const source = toCanvas(data, size, size);
  const layout = tileLayout(size);
  const { region, sent } = layout;
  // tiles with nothing painted on them aren't worth a call
  const todo = layout.tiles.filter((t) => {
    for (let y = t.y; y < t.y + region; y += 4) for (let x = t.x; x < t.x + region; x += 4) if (mask[y * size + x]) return true;
    return false;
  });
  if (!todo.length) throw new Error('nothing is painted yet: texture the level first');
  const results = new Map<(typeof todo)[number], Uint8ClampedArray>();
  let next = 0, done = 0;
  onProgress?.(0, todo.length);
  const worker = async () => {
    while (next < todo.length) {
      const t = todo[next++];
      const c = document.createElement('canvas');
      c.width = c.height = sent;
      const ctx = c.getContext('2d')!;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(source, t.x, t.y, region, region, 0, 0, sent, sent);
      const r = await runMaterial(c.toDataURL('image/jpeg', 0.95), ['normal', 'roughness'], o.seed, signal);
      const nrm = bitmapToRGBA(r.maps.normal, region, region);
      const rgh = bitmapToRGBA(r.maps.roughness, region, region);
      for (let i = 0; i < nrm.length; i += 4) nrm[i + 2] = rgh[i];   // pack: normal x, y + roughness
      results.set(t, nrm);
      onProgress?.(++done, todo.length);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(o.parallel, todo.length)) }, worker));
  const raw = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < raw.length; i += 4) { raw[i] = raw[i + 1] = 128; raw[i + 2] = 255 * o.baseRoughness; raw[i + 3] = 255; }
  for (const t of todo) blendTile(raw, size, results.get(t)!, region, t, layout.n > 1 ? TILE_OVERLAP : 0);
  const maps = detailMaps(raw, mask, size, o);
  return { size, ...maps, tiles: todo.length, cost: (todo.length * sent * sent * MATERIAL_MODEL.price) / 1e6,
    seconds: (performance.now() - t0) / 1000 };
}
