/**
 * VELOCITY GP v17 — PIT SYSTEM: the phase machine that drives pit stops.
 *
 * A pitting car is KINEMATIC: it follows the pit path (PitLane.ts) instead
 * of the physics step — no walls, no respawn, no AI, no stuck states. The
 * phases:
 *
 *   none → requested ("BOX BOX — PIT THIS LAP") → entry (blend off the
 *   racing line) → lane (80 km/h limiter) → stopped at the TEAM garage
 *   (tyres + fuel, progress bar + countdown, mechanics working) → exit
 *   (blend back onto the track just before the next corner).
 *
 * The player requests a stop with P (pit menu) or the HUD button; the AI
 * boxes on strategy (worn tyres / low fuel). Online: each owner simulates
 * its own stops and the positions stream as normal kart states.
 */

import * as THREE from 'three';
import { clamp } from '../core/MathUtils';
import { pitAt, type PitLaneData, type PitVisuals } from './PitLane';
import { TEAMS } from './Teams';
import type { F1Car } from './F1Car';
import type { TireCompound } from '../core/Types';

export type PitPhase = 'none' | 'requested' | 'entry' | 'lane' | 'stopped' | 'exit';

export interface PitCarState {
  phase: PitPhase;
  /** arc distance along the pit path */
  dist: number;
  /** current guided speed (m/s) */
  speed: number;
  /** stop service timer */
  stopT: number;
  stopDur: number;
  /** team garage index */
  garageIdx: number;
  /** compound fitted at the stop */
  compound: TireCompound;
  /** lap the box was requested on (one request per lap) */
  requestedLap: number;
}

export interface PitHudState {
  phase: PitPhase;
  menuOpen: boolean;
  stopProgress: number;      // 0..1 during the stop
  stopRemaining: number;     // seconds
  limiter: boolean;          // 80 km/h active
  compound: TireCompound;
}

export interface PitUpdateCtx {
  lapsTotal: number;
  /** kg of fuel one lap burns (average) */
  lapFuelKg: number;
  /** laps completed for a car (from the race manager) */
  lapOf: (car: F1Car) => number;
  onAnnounce: ((text: string, tone: 'info' | 'good' | 'hype' | 'bad') => void) | null;
}

const LIMIT_MS = 80 / 3.6;         // 22.2 m/s pit limiter
const STOP_TYRE_S = 2.4;           // tyre change
const STOP_FUEL_S = 0.9;           // fuel hose on top
const EXIT_SPEED = 19;             // release speed onto the track
const ENTRY_WINDOW_M = 26;         // how far ahead of the entry the handover grabs

export class PitSystem {
  readonly states = new Map<string, PitCarState>();
  /** player pit menu (HUD reads; Game toggles on the P key) */
  menuOpen = false;
  private pit: PitLaneData | null;
  private visuals: PitVisuals | null = null;
  private splineLength: number;
  private animT = 0;

  constructor(pit: PitLaneData | null, splineLength: number) {
    this.pit = pit;
    this.splineLength = splineLength;
  }

  attachVisuals(v: PitVisuals | null): void { this.visuals = v; }

  get available(): boolean { return !!this.pit; }

  private st(car: F1Car): PitCarState {
    let s = this.states.get(car.id);
    if (!s) {
      const g = Math.max(0, TEAM_INDEX(car.teamId));
      s = {
        phase: 'none', dist: 0, speed: 0, stopT: 0, stopDur: STOP_TYRE_S + STOP_FUEL_S,
        garageIdx: g, compound: 'medium', requestedLap: -1,
      };
      this.states.set(car.id, s);
    }
    return s;
  }
  hudState(carId: string): PitHudState {
    const s = this.states.get(carId);
    return {
      phase: s?.phase ?? 'none',
      menuOpen: this.menuOpen,
      stopProgress: s ? clamp(s.stopT / Math.max(0.01, s.stopDur), 0, 1) : 0,
      stopRemaining: s ? Math.max(0, s.stopDur - s.stopT) : 0,
      limiter: s?.phase === 'lane' || s?.phase === 'entry',
      compound: s?.compound ?? 'medium',
    };
  }

  /** Player/AI action: box at the end of this lap. */
  requestBox(car: F1Car, compound?: TireCompound, lap = -1): void {
    if (!this.pit) return;
    const s = this.st(car);
    if (s.phase !== 'none' && s.phase !== 'requested') return;
    s.phase = 'requested';
    s.requestedLap = lap;
    if (compound) s.compound = compound;
  }

  cancelBox(car: F1Car): void {
    const s = this.states.get(car.id);
    if (s && s.phase === 'requested') s.phase = 'none';
  }

  /**
   * AI strategy (v16): box on the PLANNED stop lap (tyre-adjusted, aggression-
   * biased — set by Game at session start) or reactively on worn tyres / thin
   * fuel. Compound picks are weather-aware: wet session → inter/wet, dry →
   * soft/medium/hard by laps remaining.
   */
  aiConsider(car: F1Car, lap: number, lapsTotal: number,
    ai?: { aggression?: number; planStopLap?: number; planSecondStop?: boolean }): void {
    if (!this.pit || lapsTotal < 3) return;
    const s = this.states.get(car.id);
    if (s && (s.phase !== 'none' || s.requestedLap >= 0)) return;
    if (lap < 1) return;

    const lapsLeft = Math.max(1, lapsTotal - lap);
    const pick = (): TireCompound => {
      if (car.wetSession) {
        // on the wrong rubber or heavy rain → full wets; crossover → inters
        return lapsLeft > 2 && Math.random() < 0.3 ? 'inter' : 'wet';
      }
      if (lapsLeft <= 2) return 'soft';
      if (lapsLeft <= 4) return Math.random() < 0.5 ? 'soft' : 'medium';
      return Math.random() < 0.25 ? 'hard' : 'medium';
    };

    // ---- planned strategic stop --------------------------------------------------
    const planned = ai?.planStopLap ?? -1;
    if (planned > 0 && lap === planned && car.progressS > 0.2 && car.progressS < 0.85) {
      this.requestBox(car, pick(), lap);
      if (ai) ai.planStopLap = -1;                      // one shot at the plan
      return;
    }
    // second stop (long races, aggressive drivers)
    const second = ai?.planSecondStop === true;
    if (second && lap === Math.max(2, Math.round(lapsTotal * 0.82)) && car.progressS > 0.2 && car.progressS < 0.85) {
      this.requestBox(car, pick(), lap);
      if (ai) ai.planSecondStop = false;
      return;
    }

    // ---- reactive: wear / fuel ------------------------------------------------------
    const wear = car.tireWear;
    const lapFuel = (car.fuel > 0 && lapsTotal > lap) ? car.fuel / Math.max(0.5, lapsTotal - lap) : 99;
    if (wear > 0.58 || lapFuel < 1.1) {
      this.requestBox(car, pick(), lap);
    }
  }

  /** Distance (m) from a wrapped main-s progress to the pit entry (ahead). */
  private metersToEntry(s: number): number {
    if (!this.pit) return Infinity;
    let d = this.pit.entryS - s;
    if (d < 0) d += 1;
    return d * this.splineLength;
  }

  /**
   * Advance every local (non-remote) car's pit state. Pitting cars are
   * posed kinematically here; Game skips their physics + AI + respawn.
   */
  update(dt: number, cars: F1Car[], ctx: PitUpdateCtx): void {
    this.animT += dt;
    if (!this.pit) return;
    const onAnnounce = ctx.onAnnounce;

    for (const car of cars) {
      if (car.remoteDriven) continue;
      const s = this.st(car);

      switch (s.phase) {
        case 'none':
          break;

        case 'requested': {
          // grab the car as it approaches the pit entry
          const toEntry = this.metersToEntry(car.progressS);
          if (toEntry <= ENTRY_WINDOW_M && toEntry > 0 && car.speed > 4 && !car.finished) {
            s.phase = 'entry';
            s.dist = 0;
            s.speed = Math.min(car.speed, 30);
            car.pitting = true;
            onAnnounce?.(car.isPlayer ? 'BOX BOX — PIT THIS LAP' : '', 'info');
          } else if (car.finished || s.requestedLap >= 0 && car.progressS > 0.5 && car.progressS < 0.9 && this.metersToEntry(car.progressS) > this.splineLength * 0.5) {
            // missed it (spun/finished) — stand down quietly
            if (car.finished) s.phase = 'none';
          }
          break;
        }

        case 'entry':
        case 'lane': {
          // guided motion along the path
          const limitOn = s.dist >= this.pit.limitDist;
          const target = limitOn ? LIMIT_MS : Math.max(12, s.speed - 14 * dt * 4);
          s.speed += clamp(target - s.speed, -26 * dt, 14 * dt);
          s.dist += s.speed * dt;
          const gDist = this.pit.garageDist[s.garageIdx];
          if (s.dist >= gDist) {
            s.dist = gDist;
            s.phase = 'stopped';
            s.stopT = 0;
            s.speed = 0;
          } else {
            s.phase = s.dist >= this.pit.blendInEnd ? 'lane' : 'entry';
          }
          this.place(car, s);
          break;
        }

        case 'stopped': {
          s.stopT += dt;
          this.place(car, s);
          if (s.stopT >= s.stopDur) {
            // service complete: fresh tyres + fuel for the rest of the race
            car.tireWear = 0;
            car.setup.compound = s.compound;
            const lapsLeft = Math.max(1, ctx.lapsTotal - ctx.lapOf(car));
            car.fuel = Math.min(105, Math.max(car.fuel, lapsLeft * ctx.lapFuelKg * 1.08));
            s.phase = 'exit';
            s.speed = 6;
            onAnnounce?.(car.isPlayer ? 'RELEASE — GO GO GO' : '', 'hype');
          }
          break;
        }

        case 'exit': {
          const limitOff = s.dist >= this.pit.blendOutStart;
          const target = limitOff ? EXIT_SPEED : LIMIT_MS;
          s.speed += clamp(target - s.speed, -20 * dt, 12 * dt);
          s.dist = Math.min(this.pit.length, s.dist + s.speed * dt);
          this.place(car, s);
          if (s.dist >= this.pit.length - 1.5) {
            // hand control back on the racing surface
            car.pitting = false;
            s.phase = 'none';
            s.requestedLap = -1;
            car.vLong = Math.max(14, s.speed);
            car.vLat = 0;
          }
          break;
        }
      }
    }

    // ---- garage crew animation ------------------------------------------------
    if (this.visuals) {
      const active = new Map<number, number>();   // garageIdx → activity 0..1
      for (const car of cars) {
        const s = this.states.get(car.id);
        if (s && (s.phase === 'stopped')) active.set(s.garageIdx, 1);
        else if (s && (s.phase === 'lane' || s.phase === 'exit') && Math.abs(s.dist - this.pit!.garageDist[s.garageIdx]) < 26) {
          active.set(s.garageIdx, 0.4);
        }
      }
      this.visuals.garages.forEach((g, i) => {
        const act = active.get(i) ?? 0;
        const t = this.animT;
        g.men.forEach((man, mi) => {
          // idle bob; working = crouch + fast arm swings
          const bob = Math.sin(t * 2.2 + mi * 2.1) * 0.02;
          man.position.y = bob - act * 0.08;
          const arms = man.children.filter(c => c.type === 'Group') as THREE.Group[];
          arms.forEach((arm, ai) => {
            const base = act > 0
              ? Math.sin(t * 14 + ai * 3.1 + mi * 1.7) * 1.15 - 0.35
              : -0.5 + Math.sin(t * 1.6 + ai) * 0.06;
            arm.rotation.x = base;
          });
        });
        // lollipop: sign down while the car is stopped, up on release
        const sign = g.lollipop.children[1];
        if (sign) {
          const down = active.get(i) === 1;
          const targetX = down ? 0.12 : -Math.PI / 2 + 0.1;
          sign.rotation.x += (targetX - sign.rotation.x) * Math.min(1, dt * 8);
        }
      });
    }
  }

  /** True when the car is currently under guided pit control. */
  isPitting(carId: string): boolean {
    const s = this.states.get(carId);
    return !!s && s.phase !== 'none' && s.phase !== 'requested';
  }

  /** Kinematic placement from the path sample. */
  private place(car: F1Car, s: PitCarState): void {
    if (!this.pit) return;
    const at = pitAt(this.pit, s.dist);
    car.pos.copy(at.pos);
    car.yaw = at.yaw;
    car.progressS = at.mainS;
    car.vLong = s.speed;
    car.vLat = 0;
    // keep the visual grounded (the straight is flat; use the path's own y)
    if (car.ginfo) car.pos.y = Math.max(car.ginfo.height, at.pos.y - 0.05);
  }

  reset(): void {
    this.states.clear();
    this.menuOpen = false;
  }
}

// team → garage index (stable order, TEAMS array)
function TEAM_INDEX(teamId: string): number {
  const i = TEAMS.findIndex(t => t.id === teamId);
  return i < 0 ? 0 : i;
}
