/**
 * APEX GP — Time-trial ghost recorder & replayer (F1 edition).
 * Records the player transform at 20 Hz; replays with linear interpolation
 * on a translucent F1 car.
 */

import * as THREE from 'three';
import { F1Visual } from '../f1/F1Visual';
import type { TireCompound } from '../core/Types';

const HZ = 20;

export interface GhostData {
  trackId: string;
  teamId: string;
  totalTimeMs: number;
  t: number[];   // seconds since GO
  x: number[];
  y: number[];
  z: number[];
  yaw: number[];
}

export class GhostRecorder {
  private t: number[] = [];
  private x: number[] = [];
  private y: number[] = [];
  private z: number[] = [];
  private yaw: number[] = [];
  private acc = 0;
  readonly trackId: string;
  readonly teamId: string;

  constructor(trackId: string, teamId: string) {
    this.trackId = trackId;
    this.teamId = teamId;
  }

  record(dt: number, pos: THREE.Vector3, yaw: number): void {
    this.acc += dt;
    if (this.acc >= 1 / HZ) {
      this.acc = 0;
      this.t.push(+(this.t.length === 0 ? 0 : this.t[this.t.length - 1] + 1 / HZ).toFixed(3));
      this.x.push(+pos.x.toFixed(2));
      this.y.push(+pos.y.toFixed(2));
      this.z.push(+pos.z.toFixed(2));
      this.yaw.push(+yaw.toFixed(3));
    }
  }

  finish(totalTimeMs: number): GhostData {
    return { trackId: this.trackId, teamId: this.teamId, totalTimeMs, t: this.t, x: this.x, y: this.y, z: this.z, yaw: this.yaw };
  }
}

export class GhostPlayer {
  readonly data: GhostData;
  readonly visual: F1Visual;
  private idx = 0;
  playing = false;

  constructor(data: GhostData, parent: THREE.Object3D, teamColor: number, teamAccent: number, compound: TireCompound) {
    this.data = data;
    this.visual = new F1Visual(teamColor, teamAccent, 1, compound);
    this.visual.setGhost(true);
    parent.add(this.visual.group);
    this.visual.group.visible = false;
  }

  start(): void { this.playing = true; this.idx = 0; this.visual.group.visible = true; }

  /** raceTimeSec: seconds since lights out. */
  update(raceTimeSec: number, t: number): void {
    if (!this.playing) return;
    const d = this.data;
    while (this.idx < d.t.length - 1 && d.t[this.idx + 1] < raceTimeSec) this.idx++;
    if (this.idx >= d.t.length - 1) { this.playing = false; this.visual.group.visible = false; return; }
    const t0 = d.t[this.idx], t1 = d.t[this.idx + 1];
    const f = t1 > t0 ? Math.min(1, (raceTimeSec - t0) / (t1 - t0)) : 1;
    this.visual.group.position.set(
      d.x[this.idx] + (d.x[this.idx + 1] - d.x[this.idx]) * f,
      d.y[this.idx] + (d.y[this.idx + 1] - d.y[this.idx]) * f,
      d.z[this.idx] + (d.z[this.idx + 1] - d.z[this.idx]) * f,
    );
    let dy = d.yaw[this.idx + 1] - d.yaw[this.idx];
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    this.visual.group.rotation.y = d.yaw[this.idx] + dy * f;
    this.visual.update(1 / 60, { steer: 0, speed: 60, drsOpen: false, brakeGlow: 0, slip: 0, wheelSpin: 0 });
    void t;
  }

  dispose(): void {
    this.visual.dispose();
  }
}
