/**
 * APEX GP — The grid: 10 fictional constructors (2 drivers each, 20 cars).
 * Performance deltas are subtle: the best car is worth ~0.15s/lap, like 2022.
 */

import type { TeamDef } from '../core/Types';

export const TEAMS: TeamDef[] = [
  {
    id: 'falco', name: 'Scuderia Falco', short: 'FAL', color: 0xd40000, accent: 0xffd400,
    drivers: [{ name: 'L. Ferrand', number: 16 }, { name: 'C. Salvi', number: 55 }],
    powerDelta: 0.008, aeroDelta: 0.006,
  },
  {
    id: 'meridian', name: 'Meridian GP', short: 'MER', color: 0x00d2be, accent: 0x0a1622,
    drivers: [{ name: 'H. Rossel', number: 44 }, { name: 'G. Rüss', number: 63 }],
    powerDelta: 0.004, aeroDelta: 0.010,
  },
  {
    id: 'bullseye', name: 'Bullseye Racing', short: 'BUL', color: 0x1e2a55, accent: 0xd40000,
    drivers: [{ name: 'M. Verstra', number: 1 }, { name: 'S. Peredo', number: 11 }],
    powerDelta: 0.012, aeroDelta: 0.004,
  },
  {
    id: 'aurum', name: 'Aurum F1 Team', short: 'AUR', color: 0xff7a00, accent: 0x101010,
    drivers: [{ name: 'L. Norrington', number: 4 }, { name: 'O. Piñar', number: 81 }],
    powerDelta: 0.002, aeroDelta: 0.000,
  },
  {
    id: 'nova', name: 'Nova Racing', short: 'NOV', color: 0x2244ff, accent: 0xffffff,
    drivers: [{ name: 'G. Zhàu', number: 24 }, { name: 'Y. Tsunai', number: 22 }],
    powerDelta: 0.003, aeroDelta: -0.002,
  },
  {
    id: 'titan', name: 'Titan Grand Prix', short: 'TIT', color: 0x52d6c8, accent: 0x1b2b3a,
    drivers: [{ name: 'F. Alcaide', number: 14 }, { name: 'E. Oscon', number: 31 }],
    powerDelta: -0.002, aeroDelta: 0.004,
  },
  {
    id: 'vortex', name: 'Vortex AMR', short: 'VOR', color: 0x00665e, accent: 0xc7e300,
    drivers: [{ name: 'S. Vettore', number: 5 }, { name: 'L. Strowl', number: 18 }],
    powerDelta: 0.000, aeroDelta: -0.004,
  },
  {
    id: 'sakura', name: 'Sakura RT', short: 'SAK', color: 0xf0f0f0, accent: 0xff2d78,
    drivers: [{ name: 'R. Saki', number: 10 }, { name: 'P. Gastón', number: 27 }],
    powerDelta: -0.001, aeroDelta: 0.001,
  },
  {
    id: 'condor', name: 'Cóndor Motorsport', short: 'CON', color: 0x6692ff, accent: 0xffffff,
    drivers: [{ name: 'V. Borro', number: 20 }, { name: 'K. Magsen', number: 77 }],
    powerDelta: 0.001, aeroDelta: -0.005,
  },
  {
    id: 'inferno', name: 'Inferno Squadra', short: 'INF', color: 0x2b2130, accent: 0xb8002e,
    drivers: [{ name: 'D. Ricco', number: 3 }, { name: 'A. Giovan', number: 15 }],
    powerDelta: -0.003, aeroDelta: -0.001,
  },
];

export const TEAM_MAP: Record<string, TeamDef> = Object.fromEntries(TEAMS.map(t => [t.id, t]));

/** Car livery performance blended for a team. */
export function teamPower(teamId: string): number {
  return TEAM_MAP[teamId]?.powerDelta ?? 0;
}
export function teamAero(teamId: string): number {
  return TEAM_MAP[teamId]?.aeroDelta ?? 0;
}
