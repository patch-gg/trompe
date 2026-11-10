import * as THREE from 'three';
import type { MeshBVH } from 'three-mesh-bvh';

/**
 * Walking the level in first person, to judge the texture from where a player stands (the views the planner paints
 * from). The body is a capsule that slides along walls; the feet follow the floor by a ray, so stairs and kerbs up
 * to `stepHeight` are climbed and anything higher blocks, the same rule the planner uses for "a player can walk here".
 */
export interface WalkOptions {
  eyeHeight: number;
  height: number;
  radius: number;
  /** Highest step the feet climb without jumping (m). */
  stepHeight: number;
  speed: number;      // m/s
  runSpeed: number;
  jumpSpeed: number;
  gravity: number;
}

export const DEFAULT_WALK: WalkOptions = { eyeHeight: 1.65, height: 1.8, radius: 0.3, stepHeight: 0.55, speed: 4.2, runSpeed: 8,
  jumpSpeed: 5.2, gravity: 18 };

export interface WalkInput { forward: number; right: number; run: boolean; jump: boolean }

const UP = new THREE.Vector3(0, 1, 0);

export class Walker {
  /** Feet position. */
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  /** Radians. Yaw 0 looks down -Z and pitch is up from the horizon, as in a ViewSpec. */
  yaw = 0;
  pitch = 0;
  onGround = false;
  readonly input: WalkInput = { forward: 0, right: 0, run: false, jump: false };
  readonly options: WalkOptions;
  private readonly spawn = new THREE.Vector3();
  private readonly segment = new THREE.Line3();
  private readonly box = new THREE.Box3();
  private readonly ray = new THREE.Ray();
  private readonly a = new THREE.Vector3();
  private readonly b = new THREE.Vector3();
  private readonly onTri = new THREE.Vector3();
  private readonly onSeg = new THREE.Vector3();

  constructor(private readonly bvh: MeshBVH, private readonly bounds: THREE.Box3, opts: Partial<WalkOptions> = {}) {
    this.options = { ...DEFAULT_WALK, ...opts };
  }

  /** Stand at `feet` (dropped onto the floor below it when there is one) looking along `yaw`. */
  place(feet: THREE.Vector3, yaw = this.yaw, pitch = 0) {
    this.position.copy(feet);
    const floor = this.floorBelow(2);
    if (floor !== null) this.position.y = floor;
    this.spawn.copy(this.position);
    this.velocity.set(0, 0, 0);
    this.yaw = yaw;
    this.pitch = pitch;
    this.onGround = floor !== null;
  }

  look(dYaw: number, dPitch: number) {
    this.yaw -= dYaw;
    this.pitch = THREE.MathUtils.clamp(this.pitch - dPitch, -1.45, 1.45);
  }

  get eye(): THREE.Vector3 {
    return new THREE.Vector3(this.position.x, this.position.y + this.options.eyeHeight, this.position.z);
  }

  applyTo(camera: THREE.PerspectiveCamera) {
    camera.position.copy(this.position);
    camera.position.y += this.options.eyeHeight;
    camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
    camera.updateMatrixWorld();
  }

  /** Advance by `dt` seconds (clamped and sub-stepped, so a slow frame can't tunnel through a wall). */
  step(dt: number) {
    const total = Math.min(Math.max(dt, 0), 0.1);
    const n = Math.max(1, Math.ceil(total / 0.012));
    for (let i = 0; i < n; i++) this.substep(total / n);
    if (this.position.y < this.bounds.min.y - 30) {   // walked off the level: back to where the walk started
      this.position.copy(this.spawn);
      this.velocity.set(0, 0, 0);
    }
  }

  private substep(dt: number) {
    const o = this.options;
    const { forward, right, run, jump } = this.input;
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    let wx = -sin * forward + cos * right;
    let wz = -cos * forward - sin * right;
    const len = Math.hypot(wx, wz);
    const speed = run ? o.runSpeed : o.speed;
    if (len > 1e-6) { wx *= speed / Math.max(1, len); wz *= speed / Math.max(1, len); }
    const k = Math.min(1, (this.onGround ? 14 : 3) * dt);   // quick on the ground, a little steering in the air
    this.velocity.x += (wx - this.velocity.x) * k;
    this.velocity.z += (wz - this.velocity.z) * k;
    if (this.onGround && jump) { this.velocity.y = o.jumpSpeed; this.onGround = false; }
    if (!this.onGround) this.velocity.y -= o.gravity * dt;
    this.position.addScaledVector(this.velocity, dt);
    this.collide();
    this.ground(dt);
  }

  /** Push the body capsule (from step height up to the head) out of anything it overlaps. */
  private collide() {
    const o = this.options;
    const seg = this.segment;
    seg.start.copy(this.position).setY(this.position.y + o.stepHeight + o.radius);
    seg.end.copy(this.position).setY(this.position.y + Math.max(o.height - o.radius, o.stepHeight + o.radius + 0.01));
    const before = this.a.copy(seg.start);
    this.box.makeEmpty().expandByPoint(seg.start).expandByPoint(seg.end).expandByScalar(o.radius);
    const { onTri, onSeg } = this;
    this.bvh.shapecast({
      intersectsBounds: (box) => box.intersectsBox(this.box),
      intersectsTriangle: (tri) => {
        const d = tri.closestPointToSegment(seg, onTri, onSeg);
        if (d < o.radius) {
          const push = onSeg.sub(onTri);
          if (push.lengthSq() < 1e-12) tri.getNormal(push); else push.normalize();
          seg.start.addScaledVector(push, o.radius - d);
          seg.end.addScaledVector(push, o.radius - d);
        }
        return false;
      },
    });
    const delta = this.b.subVectors(seg.start, before);
    const moved = delta.length();
    if (moved < 1e-6) return;
    this.position.add(delta);
    delta.divideScalar(moved);
    const into = this.velocity.dot(delta);
    if (into < 0) this.velocity.addScaledVector(delta, -into);   // slide: drop the part of the velocity going in
  }

  /** Height of the floor under the feet within reach, or null. */
  private floorBelow(drop: number): number | null {
    const o = this.options;
    this.ray.origin.copy(this.position).setY(this.position.y + o.stepHeight);
    this.ray.direction.set(0, -1, 0);
    const hit = this.bvh.raycastFirst(this.ray, THREE.DoubleSide);
    if (!hit || hit.distance > o.stepHeight + drop) return null;
    if (hit.face && Math.abs(hit.face.normal.dot(UP)) < 0.3) return null;   // a wall's edge, not a floor
    return hit.point.y;
  }

  private ground(dt: number) {
    if (this.velocity.y > 0) { this.onGround = false; return; }   // on the way up from a jump
    // on the ground, stay glued to it down slopes and stairs; in the air, land only when the feet reach it
    const floor = this.floorBelow(this.onGround ? 0.35 : 0);
    if (floor === null) { this.onGround = false; return; }
    const y = this.position.y;
    this.position.y = floor > y ? y + (floor - y) * Math.min(1, 16 * dt) : floor;   // rise smoothly up a step
    this.velocity.y = 0;
    this.onGround = true;
  }
}

const KEYS: Record<string, [keyof WalkInput, number]> = {
  KeyW: ['forward', 1], ArrowUp: ['forward', 1], KeyS: ['forward', -1], ArrowDown: ['forward', -1],
  KeyD: ['right', 1], ArrowRight: ['right', 1], KeyA: ['right', -1], ArrowLeft: ['right', -1],
};

/**
 * Keyboard and mouse for a Walker. Click the view to capture the mouse (pointer lock); where that isn't available,
 * dragging looks around. Releasing the mouse (Esc) calls `onExit`.
 */
export class WalkControls {
  private readonly down = new Set<string>();
  private dragging = false;
  private locked = false;
  private readonly off: (() => void)[] = [];

  constructor(private readonly walker: Walker, private readonly dom: HTMLElement, private readonly onExit: () => void) {
    const on = <T extends EventTarget>(t: T, type: string, fn: (e: never) => void, opts?: AddEventListenerOptions) => {
      t.addEventListener(type, fn as EventListener, opts);
      this.off.push(() => t.removeEventListener(type, fn as EventListener, opts));
    };
    const typing = (e: Event) => e.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    on(window, 'keydown', (e: KeyboardEvent) => {
      if (typing(e) || e.metaKey || e.ctrlKey) return;
      if (e.code === 'Escape') { this.onExit(); return; }
      if (e.code in KEYS || e.code === 'Space' || e.code.startsWith('Shift')) e.preventDefault();
      this.down.add(e.code);
      this.sync();
    });
    on(window, 'keyup', (e: KeyboardEvent) => { this.down.delete(e.code); this.sync(); });
    on(window, 'blur', () => { this.down.clear(); this.sync(); });
    on(dom, 'mousedown', () => {
      this.dragging = true;
      if (!this.locked) void Promise.resolve(dom.requestPointerLock?.()).catch(() => { /* drag-look instead */ });
    });
    on(window, 'mouseup', () => (this.dragging = false));
    on(window, 'mousemove', (e: MouseEvent) => {
      if (this.locked || this.dragging) walker.look(e.movementX * 0.0023, e.movementY * 0.0023);
    });
    on(document, 'pointerlockchange', () => {
      const was = this.locked;
      this.locked = document.pointerLockElement === dom;
      if (was && !this.locked) this.onExit();
    });
  }

  private sync() {
    const i = this.walker.input;
    i.forward = i.right = 0;
    for (const code of this.down) {
      const k = KEYS[code];
      if (k) (i[k[0]] as number) += k[1];
    }
    i.forward = Math.sign(i.forward);
    i.right = Math.sign(i.right);
    i.run = this.down.has('ShiftLeft') || this.down.has('ShiftRight');
    i.jump = this.down.has('Space');
  }

  dispose() {
    for (const f of this.off) f();
    this.off.length = 0;
    this.down.clear();
    this.sync();
    if (document.pointerLockElement === this.dom) document.exitPointerLock();
  }
}
