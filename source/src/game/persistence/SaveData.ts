/**
 * APEX GP — localStorage persistence: records, ghosts, options, bindings.
 * Singleton with lazy load. (v10: F1 rebuild — records keyed by circuit.)
 */

import { GhostData } from '../race/Ghost';
import { Binding, DEFAULT_BINDINGS } from '../core/InputManager';
import type { QualityLevel } from '../core/Types';

export interface OptionsState {
  quality: QualityLevel;
  showSpeedometer: boolean;
  musicVolume: number;      // ambience bus
  sfxVolume: number;
}

interface SaveShape {
  v: number;
  bestLaps: Record<string, number>;                          // circuitId -> ms
  bestRaces: Record<string, { time: number; teamId: string }>;
  ghosts: Record<string, GhostData>;
  options: OptionsState;
  bindings: Binding[];
}

const KEY = 'apexgp_save_v1';

class SaveDataImpl {
  private data: SaveShape;

  constructor() {
    this.data = SaveDataImpl.load();
  }

  private static load(): SaveShape {
    try {
      const raw = typeof window !== 'undefined' ? window.localStorage.getItem(KEY) : null;
      if (raw) {
        const parsed = JSON.parse(raw) as SaveShape;
        if (parsed.v === 1) {
          parsed.bestLaps ??= {};
          parsed.bestRaces ??= {};
          parsed.ghosts ??= {};
          const defaults: OptionsState = { quality: 'high', showSpeedometer: true, musicVolume: 0.9, sfxVolume: 0.85 };
          parsed.options = { ...defaults, ...(parsed.options ?? {}) };
          parsed.bindings = parsed.bindings?.length ? parsed.bindings : DEFAULT_BINDINGS.map(b => ({ ...b }));
          return parsed;
        }
      }
    } catch { /* corrupted save — start fresh */ }
    return {
      v: 1, bestLaps: {}, bestRaces: {}, ghosts: {},
      options: { quality: 'high', showSpeedometer: true, musicVolume: 0.9, sfxVolume: 0.85 },
      bindings: DEFAULT_BINDINGS.map(b => ({ ...b })),
    };
  }

  private flush(): void {
    try {
      if (typeof window !== 'undefined') window.localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch { /* quota — ignore */ }
  }

  // -------- records
  getBestLap(circuitId: string): number | null { return this.data.bestLaps[circuitId] ?? null; }
  recordLap(circuitId: string, ms: number): boolean {
    if (this.data.bestLaps[circuitId] == null || ms < this.data.bestLaps[circuitId]) {
      this.data.bestLaps[circuitId] = ms;
      this.flush();
      return true;
    }
    return false;
  }
  getBestRace(circuitId: string): { time: number; teamId: string } | null {
    return this.data.bestRaces[circuitId] ?? null;
  }
  recordRace(circuitId: string, timeMs: number, teamId: string, ghost: GhostData | null): boolean {
    const prev = this.data.bestRaces[circuitId];
    const better = !prev || timeMs < prev.time;
    if (better) {
      this.data.bestRaces[circuitId] = { time: timeMs, teamId };
      if (ghost) this.data.ghosts[circuitId] = ghost;
      this.flush();
    }
    return better;
  }
  getGhost(circuitId: string): GhostData | null { return this.data.ghosts[circuitId] ?? null; }

  // -------- options
  get options(): OptionsState { return { ...this.data.options }; }
  setOptions(o: OptionsState): void { this.data.options = { ...o }; this.flush(); }

  get bindings(): Binding[] { return this.data.bindings.map(b => ({ ...b })); }
  setBindingsList(b: Binding[]): void { this.data.bindings = b.map(x => ({ ...x })); this.flush(); }
}

export const SaveData = new SaveDataImpl();
