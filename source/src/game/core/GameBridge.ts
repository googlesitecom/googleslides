/**
 * APEX GP — Engine → React bridge (useSyncExternalStore-compatible).
 * The engine publishes HUD/UI snapshots at controlled rates; React never
 * touches the render loop. The minimap is drawn by the engine onto a canvas.
 */

import type { RacePhase, RaceResultRow, TireCompound } from './Types';

export type UIScreen = 'menu' | 'team' | 'circuit' | 'setup' | 'online' | 'options' | 'race';

export interface AnnouncerBanner {
  id: number;
  text: string;
  tone: 'info' | 'good' | 'bad' | 'hype';
}

export interface TowerRow {
  pos: number;
  name: string;              // 3-letter tag
  teamColor: number;
  gapSec: number | null;
  isPlayer: boolean;
  drs: boolean;
  finished: boolean;
  penalty: number;
}

export interface Telemetry {
  speedKmh: number;
  gear: number;
  rpmN: number;              // 0..1
  drs: 'off' | 'ready' | 'open';
  ersPct: number;            // 0..1
  ersDeploying: boolean;
  fuelKg: number;
  fuelLapsLeft: number | null;
  tireWear: number;          // 0..1
  compound: TireCompound;
  latG: number;
  longG: number;
  lockup: boolean;
  throttle: number;
  brake: number;
  steer: number;
}

export interface TimingState {
  lapMs: number;             // current lap (live)
  lastLapMs: number | null;
  bestLapMs: number | null;  // personal best this race
  sessionFastestMs: number | null;
  sessionFastestBy: string | null;
  sectorMs: [number, number, number];        // current sectors completed so far
  bestSectorMs: [number, number, number] | null;
  currentSector: number;
}

export interface UIState {
  screen: UIScreen;
  phase: RacePhase;
  paused: boolean;
  /** start gantry: 0..5 pods lit; null = not in the start sequence */
  lights: number | null;
  position: number;
  totalCars: number;
  lap: number;
  laps: number;
  telemetry: Telemetry;
  timing: TimingState;
  tower: TowerRow[];
  flags: { blue: boolean; yellow: boolean; chequered: boolean };
  trackLimitWarns: number;
  announcer: AnnouncerBanner[];
  results: RaceResultRow[] | null;
  needsContinue: boolean;
  timeTrial: { lapMs: number; bestLapMs: number | null; bestTotalMs: number | null; totalMs: number } | null;
  online: boolean;
  /** v17 READY→GO handshake: holding on the grid for the synchronized GO */
  waitingDrivers: boolean;
  /** v17 pit stop state (player) — null when the circuit has no pit lane */
  pit: import('../f1/PitSystem').PitHudState | null;
  cameraName: string;
  /** v27 secret admin panel (K+L+Ñ): null = closed. Never hinted in UI. */
  admin: AdminPanelState | null;
  version: number;
}

/** v27: snapshot of the secret admin panel — toggles + context flags. */
export interface AdminPanelState {
  turbo: boolean;
  grip: boolean;
  noWear: boolean;
  slowBots: boolean;
  invuln: boolean;
  /** online session: "GANAR CARRERA" is disabled (server owns standings) */
  online: boolean;
}

const INITIAL: UIState = {
  screen: 'menu', phase: 'loading', paused: false, lights: null,
  position: 1, totalCars: 20, lap: 0, laps: 5,
  telemetry: {
    speedKmh: 0, gear: 1, rpmN: 0, drs: 'off', ersPct: 0, ersDeploying: false,
    fuelKg: 0, fuelLapsLeft: null, tireWear: 0, compound: 'medium',
    latG: 0, longG: 0, lockup: false, throttle: 0, brake: 0, steer: 0,
  },
  timing: {
    lapMs: 0, lastLapMs: null, bestLapMs: null, sessionFastestMs: null,
    sessionFastestBy: null, sectorMs: [0, 0, 0], bestSectorMs: null, currentSector: 0,
  },
  tower: [], flags: { blue: false, yellow: false, chequered: false }, trackLimitWarns: 0,
  announcer: [], results: null, needsContinue: false, timeTrial: null,
  online: false, waitingDrivers: false, pit: null, cameraName: 'CHASE', admin: null, version: 0,
};

export class GameBridge {
  private state: UIState = { ...INITIAL };
  private listeners = new Set<() => void>();

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): UIState => this.state;

  publish(patch: Partial<UIState>): void {
    this.state = { ...this.state, ...patch, version: this.state.version + 1 };
    for (const l of this.listeners) l();
  }

  pushAnnouncer(text: string, tone: AnnouncerBanner['tone']): void {
    if (!text) return;
    const banner: AnnouncerBanner = { id: Date.now() + Math.random(), text, tone };
    const announcer = [...this.state.announcer, banner].slice(-3);
    this.publish({ announcer });
    setTimeout(() => {
      this.publish({ announcer: this.state.announcer.filter(a => a.id !== banner.id) });
    }, 2400);
  }

  resetToMenu(): void {
    this.publish({ ...INITIAL, version: this.state.version + 1 });
  }
}
