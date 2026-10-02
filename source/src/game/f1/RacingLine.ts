/**
 * APEX GP — Racing line & speed profile (quasi-static method).
 *
 * Line: iterative centerline smoothing with track-edge clamping — converges
 * to the classic clip-the-apex / open-the-exit trajectory.
 *
 * v23 PARITY: the speed profile is computed with the grip model the cars
 * ACTUALLY run — the arcade handling (PHYS.arcade.gripBoost + aeroLat). The
 * old profile used the raw sim formula (mu·g·0.92 / (κ−c)) while the player
 * cornered on 1.32× boosted grip: every bot target was 15-24% under what
 * the player could do, so the field got dropped out of every corner no
 * matter its speedMul. Now:
 *   v²·(κ − aeroLat) = 9.81·μ·gripBoost·drivability
 * with the braking/traction passes calibrated to the real pedal caps.
 *
 * v22: the line accepts a STYLE (margin / maxSwing / bias / iterations).
 * The shared `racingLine` is the player's guidance line (tidy, bounded
 * swing); the AI drivers each get their OWN variant from
 * computeRacingLineVariants() so no two bots trace the same trajectory.
 */

import { Spline } from '../tracks/Spline';
import { PHYS } from '../core/Config';

export interface F1RacingLine {
  /** lateral offset from the centerline per sample (m, + = right) */
  lat: Float32Array;
  /** physical maximum speed per sample (m/s) */
  vTarget: Float32Array;
  /** local curvature of the line (1/m) */
  curv: Float32Array;
  count: number;
}

export interface LineStyle {
  /** meters kept from the track edge */
  margin: number;
  /** hard cap on |lateral| — a real racing line swings a bounded amount,
   *  even on a 22 m-wide track (anti-"snake" clamp) */
  maxSwing: number;
  /** global lateral preference (m): drivers that favour one side of center */
  bias: number;
  /** shortening iterations (fewer = keeps more of its own character) */
  iterations: number;
}

export function computeRacingLine(spline: Spline, opts: {
  mu: number;              // tire friction coefficient
  cla: number;             // downforce area
  powerW: number;          // engine watts
  mass: number;            // kg incl. fuel
  margin: number;          // meters kept from the track edge
  /** v22 style knobs (defaults = the tidy player line) */
  maxSwing?: number;
  bias?: number;
  iterations?: number;
  /** v23 PARITY: arcade flat-grip multiplier (PHYS.arcade.gripBoost).
   *  Default 1 = legacy sim profile (only QA harnesses use it). */
  gripBoost?: number;
  /** v23: arcade aero lateral coefficient (PHYS.arcade.aeroLat, m/s² per v²).
   *  Default = the sim-model c coefficient. */
  aeroLat?: number;
  /** v23: fraction of the grip limit the profile targets (player guidance
   *  0.90 = honest advice; AI variants 0.95 = committed race pace). */
  drivability?: number;
}): F1RacingLine {
  const N = spline.samples.length;

  // ---- 1. line: world-space iterative shortening with edge clamping ---------
  // Each pass pulls every point toward the midpoint of its neighbors (true
  // curve-shortening — it has real shrink pressure, unlike averaging the
  // lateral offsets whose all-zero centerline is a fixed point), then clamps
  // back inside the track edges. Corners get cut naturally.
  const lat = new Float32Array(N);
  const maxSwing = opts.maxSwing ?? 5.8;
  const bias = opts.bias ?? 0;
  const ITER = opts.iterations ?? 300;
  {
    const pts: { x: number; z: number }[] = spline.samples.map(sm => ({ x: sm.pos.x, z: sm.pos.z }));
    const mid: { x: number; z: number }[] = pts.map(() => ({ x: 0, z: 0 }));
    for (let it = 0; it < ITER; it++) {
      for (let i = 0; i < N; i++) {
        const a = pts[(i - 1 + N) % N], b = pts[(i + 1) % N];
        mid[i].x = (a.x + b.x) / 2;
        mid[i].z = (a.z + b.z) / 2;
      }
      for (let i = 0; i < N; i++) {
        const sm = spline.samples[i];
        const dx = mid[i].x - sm.pos.x;
        const dz = mid[i].z - sm.pos.z;
        let l = dx * sm.right.x + dz * sm.right.z;
        // v22: bounded swing + personal bias — the line stays inside
        // min(edge − margin, maxSwing) of the centerline on each side
        const lim = Math.min(Math.max(0.5, sm.halfWidth - opts.margin), maxSwing);
        const lo = Math.max(-lim, bias - lim), hi = Math.min(lim, bias + lim);
        if (l > hi) l = hi;
        if (l < lo) l = lo;
        pts[i].x = sm.pos.x + sm.right.x * l;
        pts[i].z = sm.pos.z + sm.right.z * l;
      }
    }
    for (let i = 0; i < N; i++) {
      const sm = spline.samples[i];
      lat[i] = (pts[i].x - sm.pos.x) * sm.right.x + (pts[i].z - sm.pos.z) * sm.right.z;
    }
  }

  // ---- 2. curvature of the resulting line (1/m) --------------------------------
  const curv = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const i0 = (i - 1 + N) % N, i2 = (i + 1) % N;
    const p0 = linePoint(spline, lat, i0);
    const p1 = linePoint(spline, lat, i);
    const p2 = linePoint(spline, lat, i2);
    const a = Math.atan2(p2.x - p1.x, p2.z - p1.z);
    const b = Math.atan2(p1.x - p0.x, p1.z - p0.z);
    let d = a - b;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    const ds = Math.max(0.5, (Math.hypot(p0.x - p1.x, p0.z - p1.z) + Math.hypot(p1.x - p2.x, p1.z - p2.z)) / 2);
    curv[i] = Math.abs(d) / ds;
  }
  // light smoothing of curvature (killer noise on straight-ish sections)
  const curvS = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    let acc = 0;
    for (let k = -2; k <= 2; k++) acc += curv[(i + k + N) % N];
    curvS[i] = acc / 5;
  }
  // KINK CLAMP: the shortening pass can snap the line across a hairpin apex
  // (lat +lim → −lim in a couple of samples), producing a fake sub-1 m-radius
  // kink → a ~4 m/s pocket in the profile → the whole field crawls through a
  // hairpin and bunches. No F1 car follows a radius under ~6 m: clamp.
  const KINK_MAX = 0.16;             // 1/m → 6.25 m minimum radius
  for (let i = 0; i < N; i++) if (curvS[i] > KINK_MAX) curvS[i] = KINK_MAX;

  // ---- 3. lateral speed limit (v23: the ARCADE grip model) -------------------------
  // The cars run grip-capped kinematic handling: v²·κ ≤ 9.81·μ·gripBoost +
  // aeroLat·v². The profile solves the equality so the targets are the REAL
  // limits of the machinery, not a theoretical sim the player doesn't drive.
  const mu = opts.mu;
  const boost = opts.gripBoost ?? 1;
  const aeroLat = opts.aeroLat
    ?? mu * 0.5 * PHYS.airDensity * opts.cla / opts.mass;   // legacy sim c
  const drv = opts.drivability ?? 0.92;
  const vTarget = new Float32Array(N);
  // v24 "A MÁXIMA CUANDO SE PUEDA": a corner is FLAT when the car can hold it
  // at its terminal velocity (~92 m/s / 331 km/h, drag-limited with paceMul
  // ~1.1). The old fixed cutoff (κ ≤ aeroLat·1.02 → radius > 136 m) left
  // genuinely-flat corners (R 96-136 m) lifted in the profile — every bot
  // eased where an F1 car is pinned. κ_flat = aeroLat + grip/92².
  const kFlat = aeroLat + (mu * 9.81 * boost * drv) / (92 * 92);
  for (let i = 0; i < N; i++) {
    const k = curvS[i];
    if (k <= kFlat) vTarget[i] = 200;   // flat at terminal speed — pin it
    else vTarget[i] = Math.sqrt((mu * 9.81 * boost * drv) / (k - aeroLat));
    // a race car never TARGETS below strong-hairpin pace — crawl pockets
    // (profile artifacts, kink leftovers) jam the whole field
    if (vTarget[i] < 11) vTarget[i] = 11;
  }

  // ---- 4. backward braking pass ---------------------------------------------------------
  // v24: real decel of the pedal model as MEASURED on the arcade car — the
  // smart brake controller (front ABS 0.94 + rear 0.84 with longitudinal
  // load transfer feeding the fronts) delivers ≈0.86 of the theoretical
  // tire cap, BUT the pedal itself tops at PHYS.brakeForce (46 kN): at high
  // speed a high-pace car has more grip than pedal, so the achievable decel
  // is min(tire cap, pedal). The v23 0.78 discount braked everyone ~9%
  // early, every zone, every lap — that alone was ~0.4 s/lap gifted to the
  // player.
  const ds = spline.length / N;
  const brakeA = (v: number): number =>
    Math.min(
      mu * (9.81 + 0.5 * PHYS.airDensity * opts.cla * v * v / opts.mass) * 0.86,
      PHYS.brakeForce * 0.97 / opts.mass);
  for (let pass = 0; pass < 3; pass++) {
    for (let ii = N; ii > 0; ii--) {
      const i = (ii - 1) % N;
      const nx = (i + 1) % N;
      const vNext = vTarget[nx];
      const a = brakeA(Math.max(vTarget[i], vNext));
      const vAllow = Math.sqrt(vNext * vNext + 2 * a * ds);
      if (vTarget[i] > vAllow) vTarget[i] = vAllow;
    }
  }

  // ---- 5. forward traction pass ------------------------------------------------------------
  // v24: the arcade TC reality — gripR·latRoom·0.97 on the rear axle under
  // static load ≈ 0.52·μ·g at low speed (the 0.55 cap was ~7% over what the
  // car delivers out of hairpins, so the profile assumed exits the bot
  // physically couldn't perform and the rollout lagged every corner).
  const accelA = (v: number): number => {
    const drag = 0.5 * PHYS.airDensity * 1.42 * v * v;
    const tractionCap = mu * 9.81 * 0.52;
    const engineA = opts.powerW / Math.max(v, 12) / opts.mass;
    return Math.min(tractionCap, engineA) - drag / opts.mass;
  };
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 1; i <= N; i++) {
      const idx = i % N;
      const pv = vTarget[(idx - 1 + N) % N];
      const a = Math.max(0.8, accelA(pv));
      const vAllow = Math.sqrt(pv * pv + 2 * a * ds);
      if (vTarget[idx] > vAllow) vTarget[idx] = vAllow;
    }
  }

  return { lat, vTarget, curv: curvS, count: N };
}

function linePoint(spline: Spline, lat: Float32Array, i: number): Pt {
  const sm = spline.samples[i];
  return { x: sm.pos.x + sm.right.x * lat[i], y: sm.pos.y, z: sm.pos.z + sm.right.z * lat[i] };
}
interface Pt { x: number; y: number; z: number; }

// ============================================================ v22 line variants

/**
 * EIGHT distinct driving styles — the AI grid samples these so every bot
 * traces its OWN racing line (the user's brief: "the line is for the player;
 * the bots must each be different"). Styles range from a wide-attack
 * everything-on-the-limit line to a tidy economical one, with personal
 * side-biases and different smoothing depths. Each variant gets its own
 * speed profile recomputed from ITS curvature, so the trajectories AND the
 * corner speeds genuinely differ.
 * v24: per-style COMMIT — attack lines target 101% of the grip limit
 * (they live on the kerbs, scrub is their style), economical lines 97%
 * (they preserve tires, slower mid-corner but cleaner exits). Combined with
 * the widened paceRange this is what makes the field look like twenty
 * individuals instead of a train.
 */
const LINE_VARIANTS: (LineStyle & { drv: number })[] = [
  { margin: 0.9, maxSwing: 7.2, bias:  0.0, iterations: 340, drv: 1.01 },  // wide attack — on the limit
  { margin: 1.3, maxSwing: 6.8, bias:  0.5, iterations: 300, drv: 1.0 },
  { margin: 1.7, maxSwing: 6.3, bias: -0.5, iterations: 265, drv: 0.99 },
  { margin: 2.1, maxSwing: 5.6, bias:  0.0, iterations: 230, drv: 0.97 },  // tidy & economical
  { margin: 1.1, maxSwing: 7.0, bias: -0.7, iterations: 320, drv: 1.0 },   // left-side hugger
  { margin: 1.6, maxSwing: 6.5, bias:  0.7, iterations: 285, drv: 0.98 },  // right-side hugger
  { margin: 1.9, maxSwing: 6.0, bias:  0.3, iterations: 250, drv: 0.985 },
  { margin: 1.4, maxSwing: 6.9, bias: -0.3, iterations: 310, drv: 1.005 },
];

export function computeRacingLineVariants(spline: Spline, base: {
  mu: number; cla: number; powerW: number; mass: number;
  gripBoost?: number; aeroLat?: number;
}): F1RacingLine[] {
  // v24: variants target the FULL real arcade limit (drv 0.97–1.01 by style);
  // per-driver speedMul (0.86 easy → 1.20 expert) then places each bot from
  // "learners" to "super drivers" — and the machinery (paceMul = speedMul)
  // always holds the targets because grip scales with the same multiplier.
  return LINE_VARIANTS.map(style =>
    computeRacingLine(spline, {
      ...base, ...style, drivability: style.drv,
    }));
}
