/**
 * APEX GP — Shared types & data contracts (Formula 1 simulation).
 * Pure data: no Three.js imports here.
 */

// ---------------------------------------------------------------- sessions

export type GameMode = 'gp' | 'timetrial' | 'vs';
export type QualityLevel = 'low' | 'medium' | 'high';
export type AILevel = 'easy' | 'medium' | 'hard' | 'expert' | 'unreal';
export type RacePhase = 'loading' | 'grid' | 'formation' | 'lights' | 'racing' | 'finished';
/** selectable race conditions */
export type Weather = 'clear' | 'cloudy' | 'rain' | 'night' | 'sunset';

/** tyre compounds — slicks (soft/medium/hard) + wets (inter/wet) */
export type TireCompound = 'soft' | 'medium' | 'hard' | 'inter' | 'wet';

export interface CarSetup {
  /** aero level 1 (Monza trim) .. 5 (max downforce) */
  wing: number;
  /** front brake bias 0.50..0.62 (fraction of brake force to the front axle) */
  brakeBias: number;
  compound: TireCompound;
}

export interface F1Controls {
  throttle: number;      // 0..1
  brake: number;         // 0..1
  steer: number;         // -1..1 (positive = right)
  /** DRS request (only opens inside an enabled zone while eligible) */
  drs: boolean;
  shiftUp: boolean;      // edge signal
  shiftDown: boolean;    // edge signal
  lookBack: boolean;
}

// ---------------------------------------------------------------- teams

export interface TeamDef {
  id: string;
  name: string;
  short: string;          // 3-letter tag for the tower
  color: number;          // livery primary
  accent: number;         // livery secondary
  /** driver lineup */
  drivers: { name: string; number: number }[];
  /** car performance delta: engine power & aero efficiency (-0.02..+0.02) */
  powerDelta: number;
  aeroDelta: number;
}

// ---------------------------------------------------------------- circuits

/** Generic spline control point (shared track infrastructure). */
export interface TrackControlPoint {
  x: number; z: number; y?: number;
  bank?: number;      // radians, positive banks right side up
  width?: number;     // overrides road half-width
  jump?: boolean;     // road mesh gap + no ground support
  sharp?: number;     // curvature hint for the AI (0..1)
  tunnel?: boolean;
}

export interface CircuitPoint {
  x: number; z: number; y?: number;
  /** corner sharpness hint for the AI line (0..1) */
  sharp?: number;
  /** road half width override (meters) */
  width?: number;
  /** run-off type & extent beyond the kerb on the OUTSIDE of this corner */
  runoff?: 'asphalt' | 'gravel' | 'grass';
  runoffW?: number;
  /** v27: covered tunnel section (Monaco) — arch tube + portals + lights */
  tunnel?: boolean;
}

export interface DRSZone {
  /** detection point (progress 0..1) — must be within 1s of the car ahead */
  detect: number;
  /** activation point (progress 0..1) */
  start: number;
  /** end of the zone (progress 0..1) */
  end: number;
}

export interface CircuitDef {
  id: string;
  name: string;
  country: string;
  laps: number;
  points: CircuitPoint[];
  halfWidth: number;       // road half width, ~7m => 14m wide (2022 F1)
  sectors: [number, number]; // sector boundary progress values (S1/S2 end)
  drsZones: DRSZone[];
  /** ambient/environment look */
  env: 'temperate' | 'coast' | 'alpine' | 'parkland' | 'highland' | 'prairie';
  /** reference lap for the speed profile (m/s median) — telemetry hint */
  aiBasePace: number;
  /** v26 street circuit (Monaco): barriers hug the road — the grass verge
   *  band collapses to ~1.3 m so walls sit at the kerb, street style */
  street?: boolean;
  /** v26: sea placement for coast envs — [dx, dz] offset (m) from the track
   *  center toward the water (default: east side) */
  seaOffset?: [number, number];
}

// ---------------------------------------------------------------- race results

export interface RaceResultRow {
  carId: string;
  driverName: string;
  teamId: string;
  isPlayer: boolean;
  position: number;
  finishTimeMs: number | null;
  bestLapMs: number | null;
  /** online: nickname override */
  name?: string;
  /** gaps to the leader at the finish (seconds) */
  gapSec: number | null;
  penaltySec: number;
}

export interface AnnouncerLine {
  text: string;
  tone: 'info' | 'good' | 'bad' | 'hype';
  atMs: number;
}

// ---------------------------------------------------------------- session

export interface SessionConfig {
  mode: GameMode;
  circuitId: string;
  laps: number;
  aiCount: number;            // 0..19
  aiLevel: AILevel;
  /** the player's team & driver index */
  teamId: string;
  driverIdx: number;
  setup: CarSetup;
  /** race % of fuel load (time trial = minimal) */
  fuelLoad: number;
  /** transmission: auto (default) or manual gears */
  autoGears: boolean;
  /** race conditions (sky, lights, grip) */
  weather: Weather;
  /** online room race (mode 'vs'; engine builds peer puppets) */
  online?: OnlineSessionSpec;
}

export interface OnlineSessionSpec {
  grid: { id: string; name: string; teamId: string; color: number; bot?: boolean }[];
  localId: string;
  startAt: number;            // epoch-ms when lights-out should fire
  isHost?: boolean;
}
