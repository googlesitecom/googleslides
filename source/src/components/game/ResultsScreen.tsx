'use client';

/**
 * APEX GP — Post-race classification (F1 TV style): full standings with
 * team colors, times/gaps, best laps and points.
 */

import type { JSX } from 'react';
import type { RaceResultRow } from '@/game/core/Types';
import { TEAM_MAP } from '@/game/f1/Teams';
import { RACE } from '@/game/core/Config';
import { formatMs } from '@/game/core/MathUtils';

const hex = (n: number): string => `#${n.toString(16).padStart(6, '0')}`;

export function ResultsScreen({ rows, mode, online, onContinue, onRetry, onMenu }: {
  rows: RaceResultRow[];
  mode: string;
  online: boolean;
  onContinue: () => void;
  onRetry: () => void;
  onMenu: () => void;
}): JSX.Element {
  const playerRow = rows.find(r => r.isPlayer);
  const podium = playerRow && playerRow.position <= 3;

  return (
    <div className="absolute inset-0 overflow-y-auto bg-[linear-gradient(180deg,rgba(8,9,14,0.92),rgba(6,7,10,0.97))] text-white backdrop-blur-sm">
      <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col px-6 py-8">
        {/* header */}
        <div className="flex items-center justify-between">
          <button onClick={onMenu} className="rounded-lg bg-white/10 px-4 py-2 text-sm font-black text-white/80 hover:bg-white/20">MENU</button>
          <h1 className="text-2xl font-black uppercase italic tracking-widest">
            {podium ? 'PODIUM!' : 'CLASSIFICATION'}
          </h1>
          <div className="w-[80px] text-right">
            {!online && (
              <button onClick={onRetry} className="rounded-lg bg-white/10 px-3 py-2 text-sm font-black text-white/80 hover:bg-white/20">↻</button>
            )}
          </div>
        </div>

        {playerRow && (
          <div className="mt-6 rounded-2xl border border-white/10 bg-white/[0.04] p-6 text-center">
            <div className="text-[11px] font-black uppercase tracking-[0.4em] text-white/40">Final position</div>
            <div className="mt-1 text-7xl font-black italic leading-none text-[#ffd500]">P{playerRow.position}</div>
            <div className="mt-2 text-lg font-black italic">
              {playerRow.driverName} <span className="text-white/40">· {TEAM_MAP[playerRow.teamId]?.name}</span>
            </div>
            {playerRow.bestLapMs != null && (
              <div className="mt-1 font-mono text-sm text-fuchsia-400">BEST LAP {formatMs(playerRow.bestLapMs)}</div>
            )}
            {playerRow.penaltySec > 0 && (
              <div className="mt-1 text-xs font-bold text-rose-400">INCLUDES +{playerRow.penaltySec}s PENALTY</div>
            )}
          </div>
        )}

        {/* classification table */}
        <div className="mt-5 overflow-hidden rounded-xl border border-white/10">
          <div className="grid grid-cols-[36px_1fr_110px_90px_44px] items-center gap-2 border-b border-white/10 bg-white/[0.06] px-3 py-2 text-[9px] font-black uppercase tracking-widest text-white/40">
            <span>POS</span><span>DRIVER</span><span>TEAM</span><span>TIME</span><span className="text-right">PTS</span>
          </div>
          {rows.map(r => (
            <div
              key={r.carId}
              className={`grid grid-cols-[36px_1fr_110px_90px_44px] items-center gap-2 px-3 py-1.5 text-xs font-bold ${
                r.isPlayer ? 'bg-white/15' : r.position % 2 ? 'bg-white/[0.02]' : ''
              }`}
            >
              <span className="font-mono text-white/50">{r.position}</span>
              <span className="flex items-center gap-2">
                <span className="h-3.5 w-1 rounded-sm" style={{ background: hex(TEAM_MAP[r.teamId]?.color ?? 0x888888) }} />
                {r.driverName}
                {r.isPlayer && <span className="rounded bg-white/20 px-1 text-[8px] font-black">YOU</span>}
              </span>
              <span className="text-white/45">{TEAM_MAP[r.teamId]?.short ?? '—'}</span>
              <span className="font-mono text-white/70">
                {r.finishTimeMs != null
                  ? (r.position === 1 ? formatMs(r.finishTimeMs) : `+${(((r.gapSec ?? (rows[0].finishTimeMs != null ? r.finishTimeMs - rows[0].finishTimeMs : 0)) / 1000)).toFixed(1)}s`)
                  : '—'}
              </span>
              <span className="text-right font-mono text-white/60">
                {mode === 'gp' ? (RACE.points[r.position - 1] ?? 0) : ''}
              </span>
            </div>
          ))}
        </div>

        <button
          onClick={onContinue}
          className="mx-auto mb-4 mt-6 w-full max-w-xs rounded-2xl bg-gradient-to-r from-[#e10600] to-[#ff3b30] py-3 text-lg font-black italic tracking-wider shadow-lg transition hover:scale-[1.02] active:scale-95"
        >
          {online ? 'BACK TO LOBBY' : 'CONTINUE'}
        </button>
      </div>
    </div>
  );
}
