/**
 * APEX GP — Grand prix race flow & rules.
 *
 *  - standing start behind a 5-red-light gantry (random hold before lights-out)
 *  - jump-start detection (+5s penalty)
 *  - 3 sectors per lap with purple/green timing, official fastest lap
 *  - DRS: detection points (must be within 1s of the car ahead), activation
 *    windows, closed on braking — eligibility flagged onto the cars
 *  - track limits: warnings for full off-track excursions, +5s at the 4th
 *  - live positions & gaps, blue flags for lapped traffic
 *  - classification with finish times / estimated gaps, points
 */

import type { RaceResultRow } from '../core/Types';
import { RACE } from '../core/Config';
import { Spline } from '../tracks/Spline';
import type { F1Car } from '../f1/F1Car';
import type { F1CircuitWorld } from '../f1/F1TrackBuilder';
import { TEAM_MAP } from '../f1/Teams';

export interface CarRaceState {
  lap: number;
  checkpoints: boolean[];
  totalM: number;
  lastS: number;
  lapStartMs: number;
  lapTimes: number[];
  bestLapMs: number | null;
  /** current sector times so far this lap */
  sectorMs: [number, number, number];
  /** best completed sectors */
  bestSectors: [number, number, number];
  currentSector: 0 | 1 | 2;
  finishMs: number | null;
  position: number;
  positionChangedAt: number;
  gapSec: number | null;
  penaltySec: number;
  trackLimitWarns: number;
  offTrackSince: number;
  /** DRS eligibility from the last detection point */
  drsEligibleZone: boolean;
  lastDrsS?: number;
}

export type RaceEventKind =
  | 'lights' | 'go' | 'lap' | 'lastlap' | 'fastestlap' | 'position'
  | 'finish' | 'blue' | 'penalty' | 'jumpstart' | 'tracklimit' | 'info';

export interface RaceEvent {
  kind: RaceEventKind;
  text: string;
  tone: 'info' | 'good' | 'bad' | 'hype';
  atMs: number;
}

export class F1RaceManager {
  readonly cars: F1Car[];
  readonly world: F1CircuitWorld;
  readonly laps: number;
  readonly states = new Map<string, CarRaceState>();
  onEvent: ((e: RaceEvent) => void) | null = null;
  onFinish: ((car: F1Car, pos: number) => void) | null = null;

  /** epoch-ms (performance clock domain) of LIGHTS OUT = race start */
  goAtMs: number;
  phase: 'grid' | 'lights' | 'racing' | 'finished' = 'grid';
  /** how many gantry pods are lit right now (0..5; 0 while racing) */
  litPods = 0;
  /** v17: online READY→GO handshake — true until the host's synchronized GO
   *  arrives (the field holds on the grid, no lights yet). */
  waitingForGo = false;

  fastestLapMs: number | null = null;
  fastestLapBy: string | null = null;
  raceStartClockMs = 0;

  private gridUntil: number;
  private lightsOnAt: number[] = [];
  private finishedCount = 0;
  private raceOverAt = 0;
  private results: RaceResultRow[] | null = null;
  private gridPos = new Map<string, { x: number; z: number }>();
  private lastEventAt = new Map<string, number>();
  private checkpointCount = RACE.checkpoints;

  constructor(cars: F1Car[], world: F1CircuitWorld, laps: number, startAtMs?: number,
              /** v17: hold on the grid until armStart() (online handshake) */
              holdUntilArmed?: boolean) {
    this.cars = cars;
    this.world = world;
    this.laps = laps;
    const now = performance.now();
    this.gridUntil = now + 1400;
    const lightsBegin = this.gridUntil;
    for (let i = 0; i < 5; i++) this.lightsOnAt.push(lightsBegin + i * RACE.lightStepMs);
    const hold = RACE.lightsOutHoldMinMs + Math.random() * (RACE.lightsOutHoldMaxMs - RACE.lightsOutHoldMinMs);
    this.goAtMs = startAtMs ?? (this.lightsOnAt[4] + hold);
    if (startAtMs != null) {
      // server-aligned start: recompute the light sequence backwards from GO
      const end = startAtMs - RACE.lightsOutHoldMinMs;
      for (let i = 0; i < 5; i++) this.lightsOnAt[i] = end - (4 - i) * RACE.lightStepMs;
      this.gridUntil = this.lightsOnAt[0] - 1400;
    }
    if (holdUntilArmed) {
      // v17 READY→GO: nobody moves until the host's synchronized race:go
      this.waitingForGo = true;
      this.gridUntil = Infinity;
      this.goAtMs = Infinity;
    }
    for (const c of cars) {
      this.states.set(c.id, {
        lap: 0, checkpoints: new Array(this.checkpointCount).fill(false),
        // covered race distance: cars start BEHIND the line, so the grid offset
        // is negative — pole ≈ -16 m, P20 ≈ -92 m. Accumulated continuously
        // from here (see update), so the order never scrambles at the line.
        totalM: -((1 - Spline.wrapS(c.progressS)) * this.world.spline.length),
        lastS: c.progressS, lapStartMs: 0,
        lapTimes: [], bestLapMs: null,
        sectorMs: [0, 0, 0], bestSectors: [Infinity, Infinity, Infinity],
        currentSector: 0,
        finishMs: null, position: c.rank, positionChangedAt: now,
        gapSec: null, penaltySec: 0, trackLimitWarns: 0, offTrackSince: 0,
        drsEligibleZone: false,
      });
      this.gridPos.set(c.id, { x: c.pos.x, z: c.pos.z });
    }
  }

  /** seconds of racing time elapsed (negative before lights out) */
  raceClockMs(nowMs: number): number { return nowMs - this.goAtMs; }

  /**
   * v17 READY→GO handshake: the host fired race:go with the synchronized
   * lights-out instant (epoch ms). Recompute the 5-light sequence backwards
   * from GO and release the grid. Idempotent + late-safe (if the message
   * arrives after the scheduled instant, lights go straight out).
   */
  armStart(startAtMs: number): void {
    if (!this.waitingForGo || this.phase !== 'grid') return;
    this.waitingForGo = false;
    const startAt = Math.max(performance.now() + 400, startAtMs);
    const end = startAt - RACE.lightsOutHoldMinMs;
    for (let i = 0; i < 5; i++) this.lightsOnAt[i] = end - (4 - i) * RACE.lightStepMs;
    this.gridUntil = this.lightsOnAt[0] - 1400;
    this.goAtMs = startAt;
  }

  update(dt: number, nowMs: number): void {
    // ---- start sequence -----------------------------------------------------
    if (this.phase === 'grid' || this.phase === 'lights') {
      if (nowMs < this.gridUntil) {
        this.phase = 'grid';
      } else {
        this.phase = 'lights';
        let lit = 0;
        for (let i = 0; i < 5; i++) if (nowMs >= this.lightsOnAt[i]) lit = i + 1;
        if (lit !== this.litPods) {
          this.litPods = lit;
          this.world.setStartLights(lit);
          this.onEvent?.({ kind: 'lights', text: `${lit}`, tone: 'info', atMs: nowMs });
        }
      }
      if (nowMs >= this.goAtMs) {
        this.phase = 'racing';
        this.litPods = 0;
        this.world.setStartLights(0);
        this.raceStartClockMs = nowMs;
        for (const st of this.states.values()) st.lapStartMs = nowMs;
        this.onEvent?.({ kind: 'go', text: 'LIGHTS OUT!', tone: 'hype', atMs: nowMs });
        // jump-start audit
        for (const c of this.cars) {
          const gp = this.gridPos.get(c.id)!;
          const moved = Math.hypot(c.pos.x - gp.x, c.pos.z - gp.z);
          if (moved > RACE.jumpStartTolerance) {
            const st = this.states.get(c.id)!;
            st.penaltySec += RACE.jumpStartPenaltySec;
            this.onEvent?.({
              kind: 'jumpstart',
              text: c.isPlayer ? `JUMP START: +${RACE.jumpStartPenaltySec}s` : `${c.driverName} — jump start`,
              tone: 'bad', atMs: nowMs,
            });
          }
        }
      }
      return;
    }

    const len = this.world.spline.length;
    const racing = this.phase === 'racing';
    const sectors = this.world.def.sectors;

    for (const car of this.cars) {
      const st = this.states.get(car.id)!;

      // ---- checkpoints & lap validation ------------------------------------
      // (also for finished cars: they keep rolling on the cool-down lap and
      // their totalM must stay true, or the AI traffic scan goes blind to them)
      const s = car.progressS;
      const prevS = st.lastS;
      const delta = Spline.wrapS(s - prevS);
      if (delta < 0.5 && !car.finished) {
        const sectorIdx = Math.floor(Spline.wrapS(s) * this.checkpointCount) % this.checkpointCount;
        let idx = Math.floor(Spline.wrapS(prevS) * this.checkpointCount) % this.checkpointCount;
        for (let guard = 0; guard < this.checkpointCount + 2; guard++) {
          st.checkpoints[idx] = true;
          if (idx === sectorIdx) break;
          idx = (idx + 1) % this.checkpointCount;
        }
      }
      // continuous race distance: accumulate the (small) per-step deltas both
      // ways. The old lap*len + wrapped*len formula collapsed from ~0.99·len
      // to ~0.001·len the first time each car crossed the line — the leader
      // dropped to LAST for the seconds between crossings, gaps went negative,
      // DRS detection misfired and the AI went blind to the car ahead.
      if (delta < 0.5) st.totalM += delta * len;
      else st.totalM -= (1 - delta) * len;
      st.lastS = s;

      if (car.finished) { this.updateDrs(car, st, len); continue; }

      // sector boundaries
      const wrapped = Spline.wrapS(s);
      const prevWrapped = Spline.wrapS(prevS);
      const crossed = (mark: number): boolean => {
        if (delta < 0 || delta > 0.5) return false;
        if (prevWrapped < mark && wrapped >= mark) return true;
        // wrap over s=0 handles the S3→S1 boundary via the lap crossing
        return false;
      };
      if (racing && nowMs > st.lapStartMs) {
        if (st.currentSector === 0 && crossed(sectors[0])) {
          st.sectorMs[0] = nowMs - st.lapStartMs;
          st.currentSector = 1;
        } else if (st.currentSector === 1 && crossed(sectors[1])) {
          st.sectorMs[1] = nowMs - st.lapStartMs - st.sectorMs[0];
          st.currentSector = 2;
        }
      }

      // lap crossing
      const crossedForward = prevWrapped > 0.8 && wrapped < 0.2 && delta < 0.5;
      // anti-glitch: a lap must take at least 25 s (projection flaps near the
      // line can never fabricate laps)
      const lapTimeSane = nowMs - st.lapStartMs > 25000;
      if (crossedForward && st.checkpoints.every(Boolean) && lapTimeSane) {
        st.lap += 1;
        car.lap = st.lap;        // keeps AI per-lap pace noise + HUD in sync
        st.checkpoints.fill(false);
        const lapMs = nowMs - st.lapStartMs;
        // close S3
        st.sectorMs[2] = lapMs - st.sectorMs[0] - st.sectorMs[1];
        for (let i = 0; i < 3; i++) {
          if (st.sectorMs[i] > 500 && st.sectorMs[i] < st.bestSectors[i]) st.bestSectors[i] = st.sectorMs[i];
        }
        st.lapStartMs = nowMs;
        st.lapTimes.push(lapMs);
        st.sectorMs = [0, 0, 0];
        st.currentSector = 0;
        if (st.bestLapMs == null || lapMs < st.bestLapMs) st.bestLapMs = lapMs;
        if (this.fastestLapMs == null || lapMs < this.fastestLapMs) {
          this.fastestLapMs = lapMs;
          this.fastestLapBy = car.driverName;
          if (st.lap >= 1) {
            this.onEvent?.({
              kind: 'fastestlap',
              text: `${car.isPlayer ? 'FASTEST LAP' : car.driverName + ' — fastest lap'}: ${fmt(lapMs)}!`,
              tone: car.isPlayer ? 'hype' : 'info', atMs: nowMs,
            });
          }
        }
        if (car.isPlayer) {
          this.onEvent?.({
            kind: 'lap',
            text: st.lap >= this.laps ? '' : `VUELTA ${st.lap + 1}/${this.laps}`,
            tone: 'info', atMs: nowMs,
          });
        }
        if (st.lap === this.laps - 1) {
          this.onEvent?.({ kind: 'lastlap', text: 'FINAL LAP!', tone: 'hype', atMs: nowMs });
        }
        if (st.lap >= this.laps) {
          car.finished = true;
          this.finishedCount++;
          st.finishMs = nowMs - this.goAtMs + st.penaltySec * 1000;
          this.onFinish?.(car, this.finishedCount);
          if (this.finishedCount === 1) {
            this.raceOverAt = nowMs + RACE.raceOverBaseMs;
            this.onEvent?.({
              kind: 'finish',
              text: car.isPlayer ? 'CHEQUERED FLAG — YOU WIN!' : `${car.driverName} wins`,
              tone: car.isPlayer ? 'hype' : 'info', atMs: nowMs,
            });
          }
        }
      }

      // ---- progress -----------------------------------------------------------------
      // (totalM is accumulated above — nothing to recompute here)

      // ---- track limits -----------------------------------------------------------------
      if (racing && (car.surface === 'grass' || car.surface === 'gravel') && Math.abs(car.vLong) > 8) {
        st.offTrackSince += dt;
        if (st.offTrackSince > 0.7) {
          st.offTrackSince = 0;
          st.trackLimitWarns++;
          if (car.isPlayer) {
            if (st.trackLimitWarns >= RACE.trackLimitWarnings) {
              st.penaltySec += RACE.trackLimitPenaltySec;
              this.emitPlayer(car, 'tracklimit', `TRACK LIMIT: +${RACE.trackLimitPenaltySec}s`, 'bad', nowMs, 1000);
            } else {
              this.emitPlayer(car, 'tracklimit',
                `TRACK LIMITS ${st.trackLimitWarns}/${RACE.trackLimitWarnings}`, 'bad', nowMs, 1200);
            }
          }
        }
      } else {
        st.offTrackSince = 0;
      }

      // ---- DRS ---------------------------------------------------------------------------
      this.updateDrs(car, st, len);

      // ---- blue flags -------------------------------------------------------------------------
      if (racing && car.isPlayer) {
        const leader = this.cars.reduce((a, b) =>
          (this.states.get(a.id)!.totalM >= this.states.get(b.id)!.totalM ? a : b));
        const leaderLapsAhead = this.states.get(leader.id)!.lap - st.lap;
        if (leaderLapsAhead >= 1 && leader !== car) {
          const d = (this.states.get(leader.id)!.totalM - st.totalM) % len;
          if (d < 30) this.emitPlayer(car, 'blue', 'BANDERA AZUL — deja pasar', 'info', nowMs, 4000);
        }
      }
    }

    // ---- positions & gaps ------------------------------------------------------------
    const order = [...this.cars].sort(cmpProgress(this.states));
    order.forEach((car, i) => {
      const st = this.states.get(car.id)!;
      const prev = car.rank;
      car.rank = i + 1;
      st.position = i + 1;
      if (i === 0) st.gapSec = 0;
      else {
        const lead = this.states.get(order[0].id)!;
        const mySpeed = Math.max(15, Math.abs(car.vLong));
        st.gapSec = (lead.totalM - st.totalM) / mySpeed + (st.penaltySec || 0);
      }
      if (racing && prev !== car.rank && car.isPlayer && nowMs - st.positionChangedAt > 1400) {
        st.positionChangedAt = nowMs;
        this.onEvent?.({
          kind: 'position', tone: car.rank < prev ? 'good' : 'bad',
          text: `P${car.rank}`, atMs: nowMs,
        });
      }
    });

    // ---- end conditions -------------------------------------------------------------------
    if (racing && this.finishedCount > 0) {
      const playerFinished = this.cars.some(c => c.isPlayer && c.finished);
      const allDone = this.finishedCount >= this.cars.length;
      if (allDone || nowMs >= this.raceOverAt || (playerFinished && nowMs - this.raceOverAt > -RACE.raceOverBaseMs + 12000)) {
        this.phase = 'finished';
        this.results = this.buildResults();
      }
    }
  }

  private updateDrs(car: F1Car, st: CarRaceState, len: number): void {
    const wrapped = Spline.wrapS(car.progressS);
    const zones = this.world.def.drsZones;
    let inZone = false;
    for (const z of zones) {
      // detection point crossing
      if (this.crossedMark(car, z.detect, st) && st.lap >= 1) {
        st.drsEligibleZone = this.withinOneSecond(car, st, len);
      }
      const inside = z.start < z.end
        ? (wrapped >= z.start && wrapped <= z.end)
        : (wrapped >= z.start || wrapped <= z.end);
      if (inside) inZone = true;
    }
    car.drsEligible = st.drsEligibleZone && inZone && st.lap >= 1 && !car.finished;
    if (!inZone) st.drsEligibleZone = false;   // eligibility expires with the zone
  }

  private crossedMark(car: F1Car, mark: number, st: CarRaceState): boolean {
    const s = Spline.wrapS(car.progressS);
    const prev = st.lastDrsS ?? s;
    st.lastDrsS = s;
    if (prev <= s) return prev < mark && s >= mark;
    // wrapped
    return mark > prev || mark <= s;
  }

  private withinOneSecond(car: F1Car, st: CarRaceState, len: number): boolean {
    let bestGap = Infinity;
    for (const other of this.cars) {
      if (other === car || other.finished) continue;
      const ost = this.states.get(other.id)!;
      let d = ost.totalM - st.totalM;
      if (d <= 0 || d > len) continue;
      const gap = d / Math.max(20, Math.abs(other.vLong));
      if (gap < bestGap) bestGap = gap;
    }
    return bestGap <= 1.0;
  }

  private emitPlayer(car: F1Car, kind: RaceEventKind, text: string, tone: RaceEvent['tone'], nowMs: number, cooldownMs: number): void {
    if (!car.isPlayer) return;
    const last = this.lastEventAt.get(kind) ?? -1e9;
    if (nowMs - last < cooldownMs) return;
    this.lastEventAt.set(kind, nowMs);
    this.onEvent?.({ kind, text, tone, atMs: nowMs });
  }

  private buildResults(): RaceResultRow[] {
    const order = [...this.cars].sort(cmpProgress(this.states));
    const leadFinish = this.states.get(order[0].id)!.finishMs;
    return order.map((car, i) => {
      const st = this.states.get(car.id)!;
      const gapSec = st.finishMs != null && leadFinish != null
        ? (st.finishMs - leadFinish) / 1000
        : st.gapSec;
      return {
        carId: car.id,
        driverName: car.driverName,
        teamId: car.teamId,
        isPlayer: car.isPlayer,
        position: i + 1,
        finishTimeMs: st.finishMs,
        bestLapMs: st.bestLapMs,
        gapSec,
        penaltySec: st.penaltySec,
      };
    });
  }

  getResults(): RaceResultRow[] {
    if (!this.results) this.results = this.buildResults();
    return this.results;
  }

  /** points earned (GP scoring). */
  pointsFor(position: number): number { return RACE.points[position - 1] ?? 0; }

  teamOf(car: F1Car): string { return TEAM_MAP[car.teamId]?.short ?? '—'; }
}

function cmpProgress(states: Map<string, CarRaceState>): (a: F1Car, b: F1Car) => number {
  return (a, b): number => {
    const sa = states.get(a.id)!;
    const sb = states.get(b.id)!;
    if (sa.finishMs != null && sb.finishMs != null) return sa.finishMs - sb.finishMs;
    if (sa.finishMs != null) return -1;
    if (sb.finishMs != null) return 1;
    return sb.totalM - sa.totalM;
  };
}

function fmt(ms: number): string {
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const t = Math.floor(ms % 1000);
  return `${m}:${s.toString().padStart(2, '0')}.${t.toString().padStart(3, '0')}`;
}
