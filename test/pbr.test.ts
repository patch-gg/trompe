import { describe, expect, it } from 'vitest';
import { blendTile, detailMaps, medianMasked, pbrQuote, tileLayout, TILE_OVERLAP } from '../src/core/pbr';
import { mulberry32 } from '../src/core/planner';

describe('tileLayout', () => {
  it('sends a map that fits as one tile, untouched', () => {
    const l = tileLayout(2048);
    expect(l).toMatchObject({ n: 1, region: 2048, sent: 2048 });
    expect(l.tiles).toEqual([{ x: 0, y: 0, col: 0, row: 0 }]);
  });

  it('covers a 4K map with four overlapping tiles', () => {
    const l = tileLayout(4096);
    expect(l.n).toBe(2);
    expect(l.sent).toBe(2048);
    expect(l.tiles).toHaveLength(4);
    expect(l.tiles[0].x).toBe(0);
    expect(l.tiles[1].x + l.region).toBe(4096);                       // the last tile ends at the map's edge
    expect(l.region - l.tiles[1].x).toBeGreaterThanOrEqual(TILE_OVERLAP);   // and overlaps the first
  });

  it('covers an 8K map with sixteen', () => {
    const l = tileLayout(8192);
    expect(l.tiles).toHaveLength(16);
    for (let k = 1; k < l.n; k++) expect(l.tiles[k - 1].x + l.region - l.tiles[k].x).toBeGreaterThanOrEqual(TILE_OVERLAP);
    expect(l.tiles[l.n - 1].x + l.region).toBe(8192);
  });

  it('quotes by megapixels sent', () => {
    expect(pbrQuote(4096).cost).toBeCloseTo(4 * 2.048 * 2.048 * 0.01, 5);
    expect(pbrQuote(2048, 4096)).toMatchObject({ size: 2048, tiles: 1 });
  });
});

describe('blendTile', () => {
  it('fades a tile in over the strip it shares with its left neighbour', () => {
    const size = 8, region = 6, overlap = 4;
    const map = new Uint8ClampedArray(size * size * 4);
    const tile = (v: number) => new Uint8ClampedArray(region * region * 4).fill(v);
    blendTile(map, size, tile(100), region, { x: 0, y: 0, col: 0, row: 0 }, overlap);
    blendTile(map, size, tile(200), region, { x: 2, y: 0, col: 1, row: 0 }, overlap);
    const row = Array.from({ length: size }, (_, x) => map[4 * x]);
    expect(row.slice(0, 2)).toEqual([100, 100]);          // only the first tile
    expect(row.slice(6)).toEqual([200, 200]);             // only the second
    for (let x = 2; x < 6; x++) {                         // the shared strip rises from one to the other
      expect(row[x]).toBeGreaterThan(row[x - 1]);
      expect(row[x]).toBeLessThan(200);
    }
  });
});

describe('medianMasked', () => {
  it('matches a brute-force masked median', () => {
    const w = 23, h = 17, r = 3;
    const rnd = mulberry32(5);
    const src = Uint8Array.from({ length: w * h }, () => Math.floor(rnd() * 256));
    const mask = Uint8Array.from({ length: w * h }, () => (rnd() < 0.7 ? 1 : 0));
    const out = medianMasked(src, mask, w, h, r);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const vals: number[] = [];
        for (let yy = Math.max(0, y - r); yy <= Math.min(h - 1, y + r); yy++) {
          for (let xx = Math.max(0, x - r); xx <= Math.min(w - 1, x + r); xx++) if (mask[yy * w + xx]) vals.push(src[yy * w + xx]);
        }
        vals.sort((a, b) => a - b);
        expect(out[y * w + x]).toBe(vals.length ? vals[(vals.length - 1) >> 1] : src[y * w + x]);
      }
    }
  });
});

describe('detailMaps', () => {
  const size = 96;
  /** A prediction that leans as a whole (as the model leans each UV island) with one thin ridge on it. */
  function leaning() {
    const raw = new Uint8ClampedArray(size * size * 4);
    const mask = new Uint8Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = 4 * (y * size + x);
        const painted = x >= 8 && x < 88 && y >= 8 && y < 88;
        mask[y * size + x] = painted ? 1 : 0;
        raw[i] = 170; raw[i + 1] = 90; raw[i + 2] = 60; raw[i + 3] = 255;      // lean: x +0.33, y -0.3; glossy
        if (painted && x === 48) { raw[i] = 230; raw[i + 2] = 120; }           // the ridge: steeper and rougher
      }
    }
    return { raw, mask };
  }

  it('removes an island-wide lean and keeps thin relief', () => {
    const { raw, mask } = leaning();
    const { normal } = detailMaps(raw, mask, size);
    const at = (x: number, y: number) => 4 * (y * size + x);
    const flat = at(30, 48);
    expect(Math.abs(normal[flat] - 128)).toBeLessThanOrEqual(1);
    expect(Math.abs(normal[flat + 1] - 128)).toBeLessThanOrEqual(1);
    expect(normal[flat + 2]).toBeGreaterThanOrEqual(254);
    const ridge = at(48, 48);
    expect(normal[ridge]).toBeGreaterThan(128 + 50);       // 230 - 170 survives
    expect(Math.abs(normal[ridge + 1] - 128)).toBeLessThanOrEqual(1);
  });

  it('keeps roughness matte, varying only with the detail', () => {
    const { raw, mask } = leaning();
    const { orm } = detailMaps(raw, mask, size, { strength: 1, baseRoughness: 0.9, roughnessGain: 1 });
    const at = (x: number, y: number) => 4 * (y * size + x);
    expect(orm[at(30, 48) + 1]).toBe(Math.round(255 * 0.9));   // the model said 60/255: its level is ignored
    expect(orm[at(48, 48) + 1]).toBeGreaterThan(Math.round(255 * 0.9) + 20);
    expect(orm[at(30, 48)]).toBe(255);                         // no occlusion
    expect(orm[at(30, 48) + 2]).toBe(0);                       // not metal
  });

  it('leaves unpainted texels and island edges flat', () => {
    const { raw, mask } = leaning();
    for (let y = 8; y < 88; y++) raw[4 * (y * size + 8)] = 20;   // the bevel the model draws along an island's edge
    const { normal, orm } = detailMaps(raw, mask, size);
    for (const [x, y] of [[2, 2], [8, 48], [9, 30], [50, 4]]) {
      const i = 4 * (y * size + x);
      expect([normal[i], normal[i + 1], normal[i + 2]]).toEqual([128, 128, 255]);
      expect(orm[i + 1]).toBe(Math.round(255 * 0.88));
    }
  });
});
