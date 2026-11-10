import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MeshBVH } from 'three-mesh-bvh';
import { describe, expect, it } from 'vitest';
import { Walker } from '../src/core/walk';

/** A 40 m floor with a wall at x = 5, a 0.4 m kerb at z = -5 and a 1.2 m crate at z = 5. */
function world() {
  const floor = new THREE.PlaneGeometry(40, 40).rotateX(-Math.PI / 2);
  const box = (w: number, h: number, d: number, x: number, z: number) => new THREE.BoxGeometry(w, h, d).translate(x, h / 2, z);
  const g = mergeGeometries([floor, box(0.2, 3, 40, 5, 0), box(8, 0.4, 2, 0, -5), box(8, 1.2, 2, 0, 5)].map((p) => p.toNonIndexed()))!;
  g.computeBoundingBox();
  return { bvh: new MeshBVH(g), bounds: g.boundingBox! };
}

function walk(w: Walker, seconds: number, input: Partial<Walker['input']> = {}) {
  Object.assign(w.input, { forward: 0, right: 0, run: false, jump: false }, input);
  for (let t = 0; t < seconds; t += 1 / 60) w.step(1 / 60);
}

describe('Walker', () => {
  it('drops onto the floor and stays there', () => {
    const { bvh, bounds } = world();
    const w = new Walker(bvh, bounds);
    w.place(new THREE.Vector3(-8, 1.5, 0));
    walk(w, 1);
    expect(w.position.y).toBeCloseTo(0, 3);
    expect(w.onGround).toBe(true);
  });

  it('walks forward along its yaw at walking speed', () => {
    const { bvh, bounds } = world();
    const w = new Walker(bvh, bounds);
    w.place(new THREE.Vector3(-8, 0, 0), Math.PI / 2);   // yaw 90°: looking down -X
    walk(w, 2, { forward: 1 });
    expect(w.position.x).toBeLessThan(-8 - 0.8 * 2 * w.options.speed);
    expect(Math.abs(w.position.z)).toBeLessThan(1e-3);
  });

  it('is stopped by a wall and slides along it', () => {
    const { bvh, bounds } = world();
    const w = new Walker(bvh, bounds);
    w.place(new THREE.Vector3(2, 0, 0), -Math.PI / 4);   // heading +X and -Z, into the wall at x = 5
    walk(w, 3, { forward: 1, run: true });
    expect(w.position.x).toBeLessThanOrEqual(4.9 - w.options.radius + 1e-3);
    expect(w.position.x).toBeGreaterThan(4.3);
    expect(w.position.z).toBeLessThan(-3);
  });

  it('climbs a kerb but not a crate', () => {
    const { bvh, bounds } = world();
    const up = new Walker(bvh, bounds);
    up.place(new THREE.Vector3(0, 0, -2));               // yaw 0 looks down -Z, at the 0.4 m kerb
    walk(up, 1, { forward: 1 });
    expect(up.position.z).toBeLessThan(-4.2);
    expect(up.position.y).toBeCloseTo(0.4, 2);
    const blocked = new Walker(bvh, bounds);
    blocked.place(new THREE.Vector3(0, 0, 2), Math.PI);  // looking down +Z, at the 1.2 m crate
    walk(blocked, 2, { forward: 1 });
    expect(blocked.position.z).toBeLessThan(4 - blocked.options.radius + 1e-3);
    expect(blocked.position.y).toBeCloseTo(0, 3);
  });

  it('jumps and lands', () => {
    const { bvh, bounds } = world();
    const w = new Walker(bvh, bounds);
    w.place(new THREE.Vector3(-8, 0, 0));
    walk(w, 0.25, { jump: true });
    expect(w.position.y).toBeGreaterThan(0.5);
    walk(w, 1.5);
    expect(w.position.y).toBeCloseTo(0, 3);
    expect(w.onGround).toBe(true);
  });

  it('respawns after walking off the level', () => {
    const { bvh, bounds } = world();
    const w = new Walker(bvh, bounds);
    w.place(new THREE.Vector3(-19, 0, 0), Math.PI / 2);
    let lowest = 0, respawned = false;
    w.input.forward = 1;
    for (let t = 0; t < 4 && !respawned; t += 1 / 60) {
      w.step(1 / 60);
      lowest = Math.min(lowest, w.position.y);
      respawned = lowest < -20 && w.position.y > -1;
    }
    expect(respawned).toBe(true);
    expect(w.position.distanceTo(new THREE.Vector3(-19, 0, 0))).toBeLessThan(0.5);
  });
});
