/**
 * APEX KART — Closed Catmull-Rom spline with arc-length parameterization.
 * The single geometric authority of a track: road mesh generation, ground
 * height queries, kart progress/lateral projection, AI racing line,
 * checkpoints, minimap and respawn all derive from these samples.
 */

import * as THREE from 'three';
import { TrackControlPoint } from '../core/Types';

export interface SplineSample {
  pos: THREE.Vector3;      // road center
  tangent: THREE.Vector3;  // normalized forward
  right: THREE.Vector3;    // horizontal right vector (tangent x up)
  normal: THREE.Vector3;   // surface normal (banked)
  bank: number;            // radians
  halfWidth: number;       // road half width (meters)
  jump: boolean;           // no ground support / mesh gap
  tunnel: boolean;         // covered by an arched tunnel
  sharp: number;           // curvature hint 0..1
  s: number;               // progress 0..1
  dist: number;            // cumulative distance from start
}

export interface Projection {
  s: number;               // progress 0..1
  lateral: number;         // signed meters from center (+ = right)
  height: number;          // road surface height at that lateral
  index: number;           // sample index for caching
  tangent: THREE.Vector3;
  onJump: boolean;
  halfWidth: number;
}

export class Spline {
  readonly samples: SplineSample[] = [];
  readonly length: number;

  constructor(ctrl: TrackControlPoint[], private readonly sampleCount: number, defaultHalfWidth = 5) {
    // Catmull-Rom on closed loop: pad control list circularly.
    const n = ctrl.length;
    const getCtrl = (i: number): TrackControlPoint => ctrl[((i % n) + n) % n];

    let cum = 0;
    for (let i = 0; i < sampleCount; i++) {
      const t = i / sampleCount;
      // segment index and local t
      const ft = t * n;
      const seg = Math.floor(ft);
      const lt = ft - seg;

      const p0 = getCtrl(seg - 1);
      const p1 = getCtrl(seg);
      const p2 = getCtrl(seg + 1);
      const p3 = getCtrl(seg + 2);

      const pos = new THREE.Vector3(
        catmull(p0.x, p1.x, p2.x, p3.x, lt),
        catmull(p0.y ?? 0, p1.y ?? 0, p2.y ?? 0, p3.y ?? 0, lt),
        catmull(p0.z, p1.z, p2.z, p3.z, lt),
      );

      const tangent = this.tangentOf(p0, p1, p2, p3, lt);
      const right = new THREE.Vector3().crossVectors(tangent, THREE.Object3D.DEFAULT_UP)
        .crossVectors(THREE.Object3D.DEFAULT_UP, tangent).normalize();
      // simpler robust right: up × tangent flipped — compute directly:
      right.set(tangent.z, 0, -tangent.x).normalize();

      const bank = interp(p1.bank ?? 0, p2.bank ?? 0, lt);
      const halfWidth = interp(p1.width ?? 0, p2.width ?? 0, lt);
      // Jump semantics: a control-point pair BOTH flagged jump marks the gap
      // between them (and only that segment) as roadless. The engine bakes a
      // launch ramp into the ~20 m before the run, so gaps are FLOWN.
      const jump = !!(p1.jump && p2.jump);
      const tunnel = !!(p1.tunnel || p2.tunnel);
      const sharp = interp(p1.sharp ?? 0, p2.sharp ?? 0, lt);

      const normal = right.clone().applyAxisAngle(tangent, -bank).multiplyScalar(Math.sin(Math.PI / 2)).cross(tangent)
        .normalize();

      const sample: SplineSample = {
        pos, tangent, right, normal, bank,
        halfWidth: halfWidth > 0 ? halfWidth : defaultHalfWidth,
        jump, tunnel, sharp, s: t, dist: 0,
      };
      if (i > 0) cum += sample.pos.distanceTo(this.samples[i - 1].pos);
      sample.dist = cum;
      this.samples.push(sample);
    }
    // close the loop
    cum += this.samples[0].pos.distanceTo(this.samples[sampleCount - 1].pos);
    this.length = cum;
    // normalize s by real arc length
    for (const sm of this.samples) sm.s = sm.dist / this.length;
    // recompute curvature hint from geometry if not provided
    this.enrichCurvature();
  }

  /** numeric tangent via small delta of the catmull curve. */
  private tangentOf(p0: TrackControlPoint, p1: TrackControlPoint, p2: TrackControlPoint, p3: TrackControlPoint, lt: number): THREE.Vector3 {
    const a = new THREE.Vector3(
      catmull(p0.x, p1.x, p2.x, p3.x, Math.max(lt - 0.01, 0)),
      catmull(p0.y ?? 0, p1.y ?? 0, p2.y ?? 0, p3.y ?? 0, Math.max(lt - 0.01, 0)),
      catmull(p0.z, p1.z, p2.z, p3.z, Math.max(lt - 0.01, 0)),
    );
    const b = new THREE.Vector3(
      catmull(p0.x, p1.x, p2.x, p3.x, Math.min(lt + 0.01, 1)),
      catmull(p0.y ?? 0, p1.y ?? 0, p2.y ?? 0, p3.y ?? 0, Math.min(lt + 0.01, 1)),
      catmull(p0.z, p1.z, p2.z, p3.z, Math.min(lt + 0.01, 1)),
    );
    return b.sub(a).normalize();
  }

  /** Fill 'sharp' from actual turn rate so AI braking works even if unspecified. */
  private enrichCurvature(): void {
    for (let i = 0; i < this.samples.length; i++) {
      const a = this.samples[i];
      const b = this.samples[(i + 3) % this.samples.length];
      const cross = a.tangent.x * b.tangent.z - a.tangent.z * b.tangent.x; // sin of yaw delta
      const turn = Math.abs(Math.asin(Math.max(-1, Math.min(1, cross))));
      a.sharp = Math.max(a.sharp, Math.min(1, turn / 1.1));
    }
  }

  /** Wrap progress into [0,1). */
  static wrapS(s: number): number { const x = s % 1; return x < 0 ? x + 1 : x; }

  /** Sample index whose arc-length position is closest to progress s. */
  indexAtS(s: number): number {
    const target = Spline.wrapS(s) * this.length;
    const N = this.samples.length;
    let lo = 0, hi = N - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.samples[mid].dist < target) lo = mid + 1; else hi = mid;
    }
    return lo % N;
  }

  /** Sample at ARC-LENGTH progress s (linear interpolation between samples).
   *  CRITICAL: s is arc-length, NOT the curve parameter — the old parameter
   *  lookup misplaced every progress-authored feature (AI lookahead targets,
   *  pads, hazards, respawn anchors) by up to 13% of the track on circuits
   *  with non-uniform control spacing, putting AI targets BEHIND karts and
   *  locking whole grids in circle dances. */
  sampleAt(s: number): SplineSample {
    const ss = Spline.wrapS(s);
    const target = ss * this.length;
    const N = this.samples.length;
    let lo = 0, hi = N - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.samples[mid].dist < target) lo = mid + 1; else hi = mid;
    }
    const i = lo % N;
    const j = (i + 1) % N;
    const a = this.samples[i], b = this.samples[j];
    const span = Math.max(1e-6, b.dist - a.dist);
    const t = Math.min(1, Math.max(0, (target - a.dist) / span));
    return {
      pos: a.pos.clone().lerp(b.pos, t),
      tangent: a.tangent.clone().lerp(b.tangent, t).normalize(),
      right: a.right.clone().lerp(b.right, t).normalize(),
      normal: a.normal.clone().lerp(b.normal, t).normalize(),
      bank: a.bank + (b.bank - a.bank) * t,
      halfWidth: a.halfWidth + (b.halfWidth - a.halfWidth) * t,
      jump: a.jump || b.jump,
      tunnel: a.tunnel || b.tunnel,
      sharp: a.sharp + (b.sharp - a.sharp) * t,
      s: ss,
      dist: target,
    };
  }

  /**
   * Project a world position onto the spline.
   * `hint` is the kart's last sample index for O(±window) search, falling
   * back to a full scan when the kart is far off (respawns, teleports).
   */
  project(p: THREE.Vector3, hint = -1, window = 24): Projection {
    const N = this.samples.length;
    let best = -1, bestD = Infinity;

    if (hint >= 0) {
      // Continuity-aware hint search: candidates are penalized by their
      // index distance from the previous projection. Without this, a kart
      // flying between the two edges of a jump gap (~7 m apart) flip-flops
      // its progress every frame — the AI target swings 180 deg and bots
      // brake mid-flight and drop into the gap. With the bias, progress
      // freezes on the near edge during the flight and transitions ONCE,
      // cleanly, after touchdown.
      const spacing = this.length / N;
      let bestScore = Infinity;
      for (let k = -window; k <= window; k++) {
        const i = ((hint + k) % N + N) % N;
        const d = this.samples[i].pos.distanceToSquared(p);
        const idxDist = Math.min(Math.abs(k), N - Math.abs(k));
        const score = d + (idxDist * spacing * 0.35) ** 2;
        if (score < bestScore) { bestScore = score; best = i; bestD = d; }
      }
      // lost — full scan. 18 m: loose enough for offroad skirts & gap
      // flights, tight enough that a stale hint can NEVER strand the kart
      // on a far sample (which used to cause 40 m wall-clamp teleports).
      if (bestD > 18 * 18) { best = -1; bestD = Infinity; }
    }
    if (best < 0) {
      const stride = Math.max(1, Math.floor(N / 96));
      for (let i = 0; i < N; i += stride) {
        const d = this.samples[i].pos.distanceToSquared(p);
        if (d < bestD) { bestD = d; best = i; }
      }
      const c = best;
      for (let k = -stride; k <= stride; k++) {
        const i = ((c + k) % N + N) % N;
        const d = this.samples[i].pos.distanceToSquared(p);
        if (d < bestD) { bestD = d; best = i; }
      }
    }
    // NaN-proof: a degenerate query point (NaN position) loses every distance
    // comparison, leaving best = -1 — indexing samples[-1] used to crash the
    // whole frame. Fall back to sample 0 instead.
    if (best < 0 || !isFinite(bestD)) best = 0;

    const sm = this.samples[best];

    // ---- gap-aware extrapolation ------------------------------------------
    // A jump gap removes road samples between the lip and the landing, so a
    // nearest-sample search can freeze on the lip while the kart flies past
    // it. If the kart has moved into the gap span, interpolate progress
    // along the lip->landing chord: s advances smoothly through the flight,
    // onJump stays true (launch + void rules), and the AI target points at
    // the landing zone the whole way.
    if (!sm.jump) {
      const runStart = (best + 1) % N;
      if (this.samples[runStart].jump) {
        let runEnd = runStart;
        while (this.samples[runEnd].jump) runEnd = (runEnd + 1) % N;
        const lip = this.samples[runStart];
        const landing = this.samples[runEnd];
        const chord = landing.pos.clone().sub(lip.pos);
        const lenSq = Math.max(1e-6, chord.lengthSq());
        const rel0 = p.clone().sub(lip.pos);
        const t = rel0.dot(chord) / lenSq;
        // only for karts ABOVE the chord (flying over the gap). A kart that
        // fell INTO the gap is below it — it must NOT harvest the gap's
        // progress while dropping, or every fall becomes a free teleport.
        const aboveChord = rel0.y - chord.y * t > -1.5;
        if (aboveChord && t > 0.12 && t < 0.98) {
          let span = landing.s - lip.s;
          if (span < 0) span += 1;
          const right = new THREE.Vector3(chord.z, 0, -chord.x).normalize();
          const rel = p.clone().sub(lip.pos).addScaledVector(chord, -t);
          return {
            s: Spline.wrapS(lip.s + span * t),
            lateral: rel.dot(right),
            height: lip.pos.y + chord.y * t,
            index: best,
            tangent: lip.tangent.clone().lerp(landing.tangent, t).normalize(),
            onJump: true,
            halfWidth: lip.halfWidth + (landing.halfWidth - lip.halfWidth) * t,
          };
        }
      }
    }

    const toP = p.clone().sub(sm.pos);
    const lateral = toP.dot(sm.right);
    const height = sm.pos.y + lateral * Math.sin(sm.bank);
    return {
      s: sm.s, lateral, height, index: best,
      tangent: sm.tangent, onJump: sm.jump, halfWidth: sm.halfWidth,
    };
  }

  /** Position on the road at progress s and lateral offset. */
  roadPoint(s: number, lateral: number): THREE.Vector3 {
    const sm = this.sampleAt(s);
    return sm.pos.clone().addScaledVector(sm.right, lateral).add(
      new THREE.Vector3(0, lateral * Math.sin(sm.bank), 0),
    );
  }

  /** Flat 2D polyline for the minimap. */
  minimapPolyline(): { x: number; z: number }[] {
    return this.samples.map(sm => ({ x: sm.pos.x, z: sm.pos.z }));
  }
}

// ---------------------------------------------------------------- helpers

/**
 * Open polyline path used for track shortcuts.
 * Each sample maps back to a main-spline progress value so lap/position
 * tracking keeps working while a kart is inside the branch.
 */
export class OpenPath {
  readonly pts: { pos: THREE.Vector3; right: THREE.Vector3; mappedS: number; dist: number }[] = [];
  readonly length: number;
  readonly rough: number;

  constructor(points: THREE.Vector3[], fromS: number, toS: number, rough: number, steps = 48) {
    let cum = 0;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const pos = polylineAt(points, t);
      const nxt = polylineAt(points, Math.min(t + 0.02, 1));
      const prev = polylineAt(points, Math.max(t - 0.02, 0));
      const tan = nxt.sub(prev).normalize();
      const right = new THREE.Vector3(tan.z, 0, -tan.x).normalize();
      if (i > 0) cum += pos.distanceTo(this.pts[i - 1].pos);
      this.pts.push({ pos, right, mappedS: fromS + (toS - fromS) * t, dist: cum });
    }
    this.length = cum;
    this.rough = rough;
  }

  /** Nearest point with optional index hint. Returns null if far off. */
  project(p: THREE.Vector3, hint = -1): { index: number; lateral: number; mappedS: number } | null {
    let best = -1, bestD = Infinity;
    if (hint >= 0) {
      for (let k = -6; k <= 6; k++) {
        const i = Math.min(this.pts.length - 1, Math.max(0, hint + k));
        const d = this.pts[i].pos.distanceToSquared(p);
        if (d < bestD) { bestD = d; best = i; }
      }
      if (bestD > 30 * 30) best = -1;
    }
    if (best < 0) {
      for (let i = 0; i < this.pts.length; i++) {
        const d = this.pts[i].pos.distanceToSquared(p);
        if (d < bestD) { bestD = d; best = i; }
      }
    }
    if (best < 0) return null;
    const pt = this.pts[best];
    const lateral = p.clone().sub(pt.pos).dot(pt.right);
    return { index: best, lateral, mappedS: pt.mappedS };
  }
}

function polylineAt(pts: THREE.Vector3[], t: number): THREE.Vector3 {
  const f = t * (pts.length - 1);
  const i = Math.min(pts.length - 2, Math.floor(f));
  return pts[i].clone().lerp(pts[i + 1], f - i);
}

function catmull(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * (
    2 * p1 +
    (-p0 + p2) * t +
    (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
    (-p0 + 3 * p1 - 3 * p2 + p3) * t3
  );
}

const interp = (a: number, b: number, t: number) => a + (b - a) * t;
