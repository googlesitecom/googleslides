/**
 * APEX GP — Broadcast-grade camera package.
 *  chase   — smooth rear follow, speed FOV, G-roll
 *  cockpit — helmet cam inside the halo (with head G-cues)
 *  nose    — onboard nose cam
 *  tv      — trackside camera chain, auto-switching with distance zoom
 */

import * as THREE from 'three';
import { CAMERA } from '../core/Config';
import { clamp, damp, lerp } from '../core/MathUtils';
import type { F1Car } from '../f1/F1Car';
import type { Spline } from '../tracks/Spline';

export type CamMode = 'chase' | 'cockpit' | 'tv' | 'nose';

interface TVCam { pos: THREE.Vector3; idx: number; }

export class CameraController {
  readonly camera: THREE.PerspectiveCamera;
  mode: CamMode = 'chase';
  private pos = new THREE.Vector3(0, 30, 30);
  private look = new THREE.Vector3();
  private shake = 0;
  private roll = 0;
  private tvCams: TVCam[] = [];
  private activeTv = -1;
  private tvFov = 34;

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(CAMERA.chaseFov, aspect, 0.25, 1400);
    this.camera.position.copy(this.pos);
  }

  kick(strength: number): void { this.shake = Math.max(this.shake, strength); }
  resize(aspect: number): void { this.camera.aspect = aspect; this.camera.updateProjectionMatrix(); }

  cycleMode(): CamMode {
    const order: CamMode[] = ['chase', 'cockpit', 'tv', 'nose'];
    this.mode = order[(order.indexOf(this.mode) + 1) % order.length];
    this.activeTv = -1;
    return this.mode;
  }

  /** Build the TV camera chain along the circuit. */
  buildTvCams(spline: Spline): void {
    this.tvCams = [];
    const N = spline.samples.length;
    const step = Math.max(18, Math.floor(N / 16));
    for (let i = 0; i < N; i += step) {
      const sm = spline.samples[i];
      const side = i % 2 === 0 ? 1 : -1;
      const lat = side * (sm.halfWidth + 16 + (i % 3) * 6);
      this.tvCams.push({
        pos: new THREE.Vector3(
          sm.pos.x + sm.right.x * lat,
          sm.pos.y + 5.5 + (i % 4) * 1.8,
          sm.pos.z + sm.right.z * lat),
        idx: i,
      });
    }
  }

  snapBehind(car: F1Car): void {
    const fwd = car.forward();
    this.pos.copy(car.pos).addScaledVector(fwd, -CAMERA.chaseDist).add(new THREE.Vector3(0, CAMERA.chaseHeight, 0));
    this.look.copy(car.pos);
    this.roll = 0;
    this.camera.position.copy(this.pos);
    this.camera.lookAt(this.look);
  }

  update(dt: number, car: F1Car, spline: Spline | null, lookBack: boolean): void {
    switch (this.mode) {
      case 'cockpit': this.cockpit(dt, car); break;
      case 'nose': this.nose(dt, car); break;
      case 'tv': this.tv(dt, car, spline); break;
      default: this.chase(dt, car, lookBack);
    }
    this.shake = Math.max(0, this.shake - dt * 2.4);
  }

  // ------------------------------------------------------------------ chase

  private chase(dt: number, car: F1Car, lookBack: boolean): void {
    const fwd = car.forward();
    const back = lookBack ? fwd.clone().negate() : fwd;
    const speedT = Math.min(1, car.speed / 90);
    // tow: camera pulls back a touch with speed
    const dist = CAMERA.chaseDist * (1 + speedT * 0.16);
    const desired = car.pos.clone()
      .addScaledVector(back, -dist)
      .add(new THREE.Vector3(0, CAMERA.chaseHeight * (1 - speedT * 0.14), 0));
    // never under the tarmac
    desired.y = Math.max(desired.y, car.pos.y + 1.1);
    this.pos.copy(dampV3(this.pos, desired, CAMERA.chaseLerp, dt));
    // look target: ahead of the car + PEEK INTO THE CORNER (steer-biased) —
    // the F1-game trick that makes chase cams feel intentional, not lazy
    const right = new THREE.Vector3(Math.cos(car.yaw), 0, -Math.sin(car.yaw));
    const peek = car.steerAngleVis * -CAMERA.chaseLookAhead * (lookBack ? -1 : 1);
    const ahead = car.pos.clone()
      .addScaledVector(fwd, (lookBack ? -10 : 9) + speedT * 4)
      .addScaledVector(right, peek)
      .add(new THREE.Vector3(0, 0.85, 0));
    this.look.copy(dampV3(this.look, ahead, CAMERA.chaseLookLerp, dt));

    const targetFov = CAMERA.chaseFov + speedT * CAMERA.chaseFovSpeed;
    this.apply(targetFov, dt);
    // subtle high-speed rumble floor (constant, tiny — sells 300 km/h)
    this.shake = Math.max(this.shake, speedT * speedT * CAMERA.chaseSpeedShake);
    // lateral-G roll (banked feel, subtle)
    const rollTarget = clamp(-car.latG * 0.016, -0.045, 0.045);
    this.roll = damp(this.roll, rollTarget, 4, dt);
    this.finish(this.roll);
  }

  // ------------------------------------------------------------------ cockpit

  private cockpit(dt: number, car: F1Car): void {
    // T-CAM — the classic F1 broadcast onboard: eye ABOVE the rollhoop and
    // BEHIND the driver (the airbox top sits ≈ y0.95 at z−0.4; the helmet is
    // at y0.62/z0.02). The old helmet-level eye (y0.7/z0.16) sat INSIDE the
    // cockpit opening: chassis meshes + halo clipping through the near plane
    // = "can't see the track, all jammed". Up here the whole circuit is in
    // view over the nose, halo + front wing in the foreground — like the
    // onboard shots in the photo.
    const off = new THREE.Vector3(0, 1.18, -0.52);
    const world = off.clone().applyAxisAngle(UPV, car.yaw).add(car.pos);
    this.pos.copy(world);
    // chassis-mounted cam: much gentler head cues than a neck — a whisper
    // of lateral pull + counter-roll, never enough to feel loose
    const latPull = clamp(-car.latG * 0.010, -0.05, 0.05);
    const right = new THREE.Vector3(Math.cos(car.yaw), 0, -Math.sin(car.yaw));
    this.pos.addScaledVector(right, latPull);
    // look down the road: far ahead + slightly down = the track fills the
    // frame instead of the sky
    const ahead = car.pos.clone()
      .addScaledVector(car.forward(), 20)
      .add(new THREE.Vector3(0, 0.32, 0))
      .addScaledVector(right, latPull * 5 + car.steerAngleVis * -1.3);
    this.look.copy(dampV3(this.look, ahead, 20, dt));
    this.apply(CAMERA.cockpitFov, dt);
    this.roll = damp(this.roll, clamp(car.latG * 0.012, -0.045, 0.045), 4.5, dt);
    this.finish(this.roll);
  }

  // ------------------------------------------------------------------ nose

  private nose(dt: number, car: F1Car): void {
    const off = new THREE.Vector3(0, 0.52, 1.9);
    this.pos.copy(off.applyAxisAngle(UPV, car.yaw).add(car.pos));
    const ahead = car.pos.clone().addScaledVector(car.forward(), 16);
    this.look.copy(dampV3(this.look, ahead, 24, dt));
    this.apply(CAMERA.noseFov, dt);
    this.finish(0);
  }

  // ------------------------------------------------------------------ tv

  private tv(dt: number, car: F1Car, spline: Spline | null): void {
    if (!spline || !this.tvCams.length) { this.chase(dt, car, false); return; }
    // active camera = the chain camera closest AHEAD of the car (switches as
    // the car passes each one — exactly how a TV director cuts corner to corner)
    const idx = spline.indexAtS(car.progressS);
    const N = spline.samples.length;
    let best = this.activeTv >= 0 ? this.activeTv : 0;
    let bestScore = Infinity;
    for (let i = 0; i < this.tvCams.length; i++) {
      const ahead = (this.tvCams[i].idx - idx + N) % N;
      if (ahead > N * 0.5) continue;   // behind the car — skip
      if (ahead < bestScore) { bestScore = ahead; best = i; }
    }
    this.activeTv = best;
    const cam = this.tvCams[best];
    this.pos.copy(cam.pos);
    this.look.copy(dampV3(this.look, car.pos.clone().add(new THREE.Vector3(0, 0.7, 0)), 14, dt));
    const d = this.pos.distanceTo(this.look);
    this.tvFov = damp(this.tvFov, clamp(46 - d * 0.42, 20, 46), 3, dt);
    this.apply(this.tvFov, dt);
    this.finish(0);
  }

  // ------------------------------------------------------------------ shared

  private apply(targetFov: number, dt: number): void {
    this.camera.fov = lerp(this.camera.fov, targetFov, 1 - Math.exp(-5 * dt));
    this.camera.updateProjectionMatrix();
    const s = this.shake * 0.22;
    this.camera.position.copy(this.pos).add(new THREE.Vector3(
      (Math.random() - 0.5) * s, (Math.random() - 0.5) * s, (Math.random() - 0.5) * s));
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.look);
  }

  private finish(roll: number): void {
    if (Math.abs(roll) > 0.0004) this.camera.rotateZ(roll);
  }
}

const UPV = new THREE.Vector3(0, 1, 0);
const dampV3 = (a: THREE.Vector3, b: THREE.Vector3, lambda: number, dt: number): THREE.Vector3 =>
  new THREE.Vector3(damp(a.x, b.x, lambda, dt), damp(a.y, b.y, lambda, dt), damp(a.z, b.z, lambda, dt));
