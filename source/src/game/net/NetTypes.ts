/**
 * APEX GP — Online play contracts (PeerJS client side).
 * The host client mirrors these shapes (host-authoritative rooms).
 */

export interface NetPlayerInfo {
  id: string;            // peer id (stable for the connection)
  name: string;
  teamId: string;
  color: number;         // livery hex
  /** CPU filler driven by the host (guests see it as a puppet) */
  bot?: boolean;
}

export interface NetRoomConfig {
  circuitId: string;        // circuit id, or 'random' (resolved by the host at start)
  laps: number;
  /** CPU fill: -1 = auto (grid of 20), else exact bot count 0..19 */
  bots?: number;
  /** CPU skill tier for the host's simulated fillers */
  botLevel?: 'easy' | 'medium' | 'hard' | 'expert' | 'unreal';
}

export interface NetRoomState {
  code: string;
  hostId: string;
  players: NetPlayerInfo[];
  config: NetRoomConfig;
  phase: 'lobby' | 'racing';
}

export interface NetRaceStart {
  grid: NetPlayerInfo[];       // grid order, index 0 = pole
  config: NetRoomConfig;
  startAt: number;             // epoch-ms when lights-out should fire
}

/**
 * Compact per-car state streamed at ~20 Hz (owner-clock stamped — see
 * RemoteDriver v2.1 for the owner-timeline interpolation contract).
 */
export interface NetKartState {
  t?: number;                  // OWNER clock stamp (ms) — puppet playback timeline
  p: [number, number, number]; // position
  ry: number;                  // yaw
  s: number;                   // signed speed (m/s)
  vy?: number;                 // vertical velocity (m/s)
  g?: number;                  // gear 1..8
  st: number;                  // bitflags: 1 spin, 2 drs open, 4 ers deploy, 8 lockup
  lap: number;                 // laps completed
  prog: number;                // spline progress 0..1
  f: 0 | 1;                    // finished
}

export type NetEvent =
  | { t: 'hit'; target: string }              // owner-authoritative contact spin
  | { t: 'camera'; mode: string };            // (future) spectate hints

export interface NetResultRow {
  id: string;
  name: string;
  teamId: string;
  color: number;
  timeMs: number | null;
  pos: number;
}

export const ST_SPIN = 1;
export const ST_DRS = 2;
export const ST_ERS = 4;
export const ST_LOCK = 8;
