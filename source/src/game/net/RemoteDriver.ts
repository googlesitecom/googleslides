/**
 * APEX GP — Remote car puppeteer (v2.1 "silk", owner-timeline — carried over
 * from the kart era, the fix for "bots trabados").
 *
 * The owner streams at ~20 Hz and stamps every sample with its OWN clock
 * (`st.t`). This buffers the samples on that owner timeline and plays the
 * puppet back `delay` ms behind — which makes per-packet network delay
 * variations invisible:
 *
 *  - Clock offset: min-filtered(arrival - ownerStamp) — the fastest path on
 *    record, like NTP/RTT estimation. Spiky packets land LATE but their
 *    content slots in-order at its true time; nothing plays backward.
 *  - Adaptive delay: 2*sendInterval + 1.5*ownerGapDeviation, clamped
 *    110-250 ms — grows only when the OWNER's own cadence hiccups.
 *  - Cubic Hermite positions from the owner's velocity at both endpoints.
 *  - Velocity extrapolation (≤300 ms, eased) when the buffer runs dry.
 *  - Error-correction follower: applied pose damps toward the target at
 *    18/s; teleports > 8 m snap (respawn).
 *
 * Only touches presentation fields — the owner client stays the authority.
 */

import * as THREE from 'three';
import { F1Car } from '../f1/F1Car';
import { NetKartState, ST_DRS, ST_ERS, ST_SPIN } from './NetTypes';

const SEND_IV = 50;            // nominal inter-packet interval (20 Hz stream)
const BASE_DELAY = 110;        // min interpolation delay (ms, owner timeline)
const MAX_DELAY = 250;
const EXTRAP_MS = 300;         // velocity extrapolation horizon when dry
const EXTRAP_FADE = 0.35;      // ease-off toward the horizon (less overshoot)
const SNAP_D2 = 64;            // teleport threshold (8 m)^2
const FOLLOW_RATE = 18;        // applied -> target correction rate (1/s)
const MAX_AGE = 4000;          // freeze puppet if nothing arrives this long
const BUF_MAX = 48;

interface Frame {
  t: number;                   // OWNER clock stamp (playback timeline)
  at: number;                  // local arrival time (monotonic, staleness)
  p: THREE.Vector3;
  v: THREE.Vector3;            // owner velocity: fwd(yaw)*speed + vy
  ry: number;
  s: number;
  g: number;                   // gear
  drs: boolean;
  ers: boolean;
  spin: boolean;
  lap: number;
  prog: number;
  f: boolean;
}

export class RemoteDriver {
  readonly kart: F1Car;
  private buf: Frame[] = [];
  private gapDev = 8;          // EWMA of |owner-timeline gap - SEND_IV| (ms)
  private delay = BASE_DELAY;
  /** min-filtered clock offset: localArrival - ownerStamp */
  private offset = 0;
  private haveOffset = false;
  private lastT = -1;          // last owner stamp seen (gap tracking)
  private lastAt = 0;
  /** applied (visual) pose — the follower target is the interpolated pose */
  private appliedPos = new THREE.Vector3();
  private appliedYaw = 0;
  private haveApplied = false;

  constructor(kart: F1Car) {
    this.kart = kart;
  }

  push(st: NetKartState): void {
    this.pushAt(st, performance.now());
  }

  /** Deterministic variant: stamp the sample with a caller-supplied clock. */
  pushAt(st: NetKartState, atMs: number): void {
    const t = typeof st.t === 'number' ? st.t : atMs;   // fallback: arrival tl
    // min-filtered offset (fast down, creep up)
    const sample = atMs - t;
    if (!this.haveOffset) { this.offset = sample; this.haveOffset = true; }
    else if (sample < this.offset) this.offset = sample;
    else this.offset += (sample - this.offset) * 0.01;
    // owner cadence deviation → grow delay just enough (throttled host tab)
    if (this.lastT >= 0) {
      const gap = t - this.lastT;
      if (gap > 1 && gap < 400) {
        this.gapDev = Math.min(150, this.gapDev * 0.9 + Math.abs(gap - SEND_IV) * 0.1);
        this.delay = Math.min(MAX_DELAY, Math.max(BASE_DELAY, SEND_IV * 2 + this.gapDev * 1.5));
      }
    }
    this.lastT = t;
    const at = Math.max(atMs, this.lastAt + 1);   // strictly monotonic arrivals
    this.lastAt = at;

    const vy = typeof st.vy === 'number' ? st.vy : 0;
    const frame: Frame = {
      t, at,
      p: new THREE.Vector3(st.p[0], st.p[1], st.p[2]),
      v: new THREE.Vector3(Math.sin(st.ry) * st.s, vy, Math.cos(st.ry) * st.s),
      ry: st.ry, s: st.s, g: st.g ?? 1,
      drs: (st.st & ST_DRS) !== 0,
      ers: (st.st & ST_ERS) !== 0,
      spin: (st.st & ST_SPIN) !== 0,
      lap: st.lap, prog: st.prog, f: st.f === 1,
    };
    // keep the buffer ordered on the owner timeline
    let i = this.buf.length;
    while (i > 0 && this.buf[i - 1].t > t) i--;
    this.buf.splice(i, 0, frame);
    if (this.buf.length > BUF_MAX) this.buf.shift();
  }

  /** Called each fixed step; moves the puppet to the interpolated pose. */
  update(nowMs: number, dtStep = 1 / 60): void {
    if (!this.buf.length) return;
    const renderT = nowMs - this.offset - this.delay;

    let ai = -1;
    for (let i = this.buf.length - 1; i >= 0; i--) {
      if (this.buf[i].t <= renderT) { ai = i; break; }
    }
    const newest = this.buf[this.buf.length - 1];
    const stale = nowMs - newest.at > MAX_AGE;
    if (stale) return;   // keep last pose; owner likely disconnected mid-race

    const k = this.kart;
    const target = _tmpA;
    let dry = false;

    if (ai < 0) {
      // playback point before the oldest sample (grid formation): hold
      const f0 = this.buf[0];
      target.copy(f0.p);
      k.yaw = f0.ry;
      k.vLong = f0.s;
    } else if (ai < this.buf.length - 1) {
      // ---- normal: interpolate buf[ai] -> buf[ai+1] (cubic Hermite, C1) ---
      const a = this.buf[ai], b = this.buf[ai + 1];
      const span = Math.max(0.001, b.t - a.t);
      const t = Math.min(1, Math.max(0, (renderT - a.t) / span));
      const t2 = t * t, t3 = t2 * t;
      const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t;
      const h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
      const sec = span / 1000;
      target.set(
        h00 * a.p.x + h10 * a.v.x * sec + h01 * b.p.x + h11 * b.v.x * sec,
        h00 * a.p.y + h10 * a.v.y * sec + h01 * b.p.y + h11 * b.v.y * sec,
        h00 * a.p.z + h10 * a.v.z * sec + h01 * b.p.z + h11 * b.v.z * sec,
      );
      let dy = b.ry - a.ry;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      k.yaw = a.ry + dy * t;
      k.vLong = a.s + (b.s - a.s) * t;
    } else {
      // ---- dry: extrapolate with the owner's velocity, eased
      const b = newest;
      const over = Math.min(renderT - b.t, EXTRAP_MS);
      const ease = 1 - EXTRAP_FADE * (over / EXTRAP_MS);
      target.copy(b.p).addScaledVector(b.v, (over / 1000) * ease);
      k.yaw = b.ry;
      k.vLong = b.s;
      dry = true;
    }

    // bursty-channel learning
    const floor = Math.min(MAX_DELAY, Math.max(BASE_DELAY, SEND_IV * 2 + this.gapDev * 1.5));
    if (dry) this.delay = Math.min(MAX_DELAY, this.delay + Math.max(0, renderT - newest.t) * 0.02);
    else this.delay = Math.max(floor, this.delay - 0.8);

    // error-correction follower
    if (!this.haveApplied || this.appliedPos.distanceToSquared(target) > SNAP_D2) {
      this.appliedPos.copy(target);
      this.appliedYaw = k.yaw;
      this.haveApplied = true;
    } else {
      const f = 1 - Math.exp(-FOLLOW_RATE * dtStep);
      this.appliedPos.lerp(target, f);
      let dyaw = k.yaw - this.appliedYaw;
      while (dyaw > Math.PI) dyaw -= Math.PI * 2;
      while (dyaw < -Math.PI) dyaw += Math.PI * 2;
      this.appliedYaw += dyaw * f;
    }
    k.pos.copy(this.appliedPos);
    k.yaw = this.appliedYaw;

    // presentation fields for visuals/HUD
    k.gear = newest.g;
    k.drsOpen = newest.drs;
    k.drsEligible = newest.drs;
    k.ersDeploying = newest.ers;
    k.lap = newest.lap;
    k.progressS = newest.prog;
    k.finished = newest.f || k.finished;
    k.spinT = newest.spin ? Math.max(k.spinT, 0.12) : 0;
  }

  /** Initial teleport (before the race starts) so puppets grid up instantly. */
  snapToLatest(): void {
    const f = this.buf[this.buf.length - 1];
    if (!f) return;
    this.kart.pos.copy(f.p);
    this.kart.yaw = f.ry;
    this.kart.vLong = f.s;
    this.kart.progressS = f.prog;
    this.kart.lap = f.lap;
    this.appliedPos.copy(f.p);
    this.appliedYaw = f.ry;
    this.haveApplied = true;
  }

  /** QA/telemetry: buffer health at a glance (clock-independent fields). */
  get debug(): { buf: number; delay: number; gapDev: number; offset: number; lastT: number } {
    const last = this.buf.length ? this.buf[this.buf.length - 1] : null;
    return {
      buf: this.buf.length, delay: Math.round(this.delay), gapDev: Math.round(this.gapDev),
      offset: Math.round(this.offset), lastT: last ? Math.round(last.t) : -1,
    };
  }
}

const _tmpA = new THREE.Vector3();
