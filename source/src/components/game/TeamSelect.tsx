'use client';

/**
 * APEX GP — Team & driver select. 10 constructors, 2 seats each; the car
 * livery and the tiny performance deltas follow the team.
 */

import { useState, type JSX } from 'react';
import { TEAMS } from '@/game/f1/Teams';
import { SaveData } from '@/game/persistence/SaveData';
import { formatMs } from '@/game/core/MathUtils';
import type { GameMode } from '@/game/core/Types';

const hex = (n: number): string => `#${n.toString(16).padStart(6, '0')}`;

function Bar({ value, color }: { value: number; color: string }): JSX.Element {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
      <div className="h-full rounded-full" style={{ width: `${value * 100}%`, background: color }} />
    </div>
  );
}

export function TeamSelect({ mode, teamId, driverIdx, onSelect, onBack, onNext }: {
  mode: GameMode;
  teamId: string;
  driverIdx: number;
  onSelect: (teamId: string, driverIdx: number) => void;
  onBack: () => void;
  onNext: () => void;
}): JSX.Element {
  const [local, setLocal] = useState({ teamId, driverIdx });
  const team = TEAMS.find(t => t.id === local.teamId) ?? TEAMS[0];
  const driver = team.drivers[local.driverIdx] ?? team.drivers[0];

  const pick = (t: string, idx: number): void => {
    setLocal({ teamId: t, driverIdx: idx });
    onSelect(t, idx);
  };

  return (
    <div className="absolute inset-0 overflow-y-auto bg-[linear-gradient(180deg,#0a0b10,#08080c_60%,#0a0b10)] text-white">
      <div className="mx-auto flex min-h-full w-full max-w-4xl flex-col px-6 py-6">
        <header className="flex items-center justify-between">
          <button onClick={onBack} className="rounded-lg bg-white/10 px-4 py-2 text-sm font-black text-white/80 hover:bg-white/20">← BACK</button>
          <h1 className="text-xl font-black uppercase italic tracking-widest">CHOOSE YOUR SEAT</h1>
          <div className="w-[110px]" />
        </header>

        <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {TEAMS.map(t => {
            const selected = t.id === local.teamId;
            return (
              <div
                key={t.id}
                className={`relative overflow-hidden rounded-xl border transition-all ${
                  selected ? 'border-white/60 bg-white/[0.07] shadow-[0_0_24px_rgba(255,255,255,0.08)]' : 'border-white/10 bg-white/[0.03] hover:border-white/25'
                }`}
              >
                <div className="flex items-stretch">
                  <div className="w-2.5 shrink-0" style={{ background: `linear-gradient(180deg, ${hex(t.color)}, ${hex(t.accent)})` }} />
                  <div className="flex-1 p-3.5">
                    <div className="flex items-baseline justify-between">
                      <span className="text-base font-black italic tracking-tight">{t.name}</span>
                      <span className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-[10px] font-bold text-white/60">{t.short}</span>
                    </div>
                    <div className="mt-2 grid grid-cols-2 gap-2">
                      {t.drivers.map((d, i) => (
                        <button
                          key={d.number}
                          onClick={() => pick(t.id, i)}
                          className={`rounded-lg border px-2 py-1.5 text-left transition ${
                            selected && local.driverIdx === i
                              ? 'border-white/70 bg-white/15'
                              : 'border-white/10 bg-black/30 hover:border-white/30'
                          }`}
                        >
                          <div className="font-mono text-[10px] font-bold text-white/40">#{d.number}</div>
                          <div className="text-xs font-bold">{d.name}</div>
                        </button>
                      ))}
                    </div>
                    <div className="mt-2.5 grid grid-cols-2 gap-3">
                      <div>
                        <div className="mb-1 text-[9px] font-black uppercase tracking-widest text-white/35">Power</div>
                        <Bar value={0.5 + t.powerDelta * 22} color={hex(t.color)} />
                      </div>
                      <div>
                        <div className="mb-1 text-[9px] font-black uppercase tracking-widest text-white/35">Aero</div>
                        <Bar value={0.5 + t.aeroDelta * 22} color={hex(t.accent)} />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="sticky bottom-0 mt-5 flex items-center justify-between gap-4 border-t border-white/10 bg-[#0a0b10]/95 py-4 backdrop-blur">
          <div className="text-sm">
            <span className="font-black italic text-lg">{driver.name}</span>
            <span className="ml-2 font-mono text-xs text-white/40">#{driver.number}</span>
            <div className="text-[11px] font-semibold text-white/40">{team.name}</div>
          </div>
          <button
            onClick={onNext}
            className="rounded-xl bg-gradient-to-r from-[#e10600] to-[#ff3b30] px-8 py-3 text-lg font-black italic tracking-wider shadow-lg transition hover:scale-[1.03] active:scale-95"
          >
            {mode === 'timetrial' ? 'CHOOSE CIRCUIT →' : 'CAR SETUP →'}
          </button>
        </div>
        <div className="pb-4 pt-1 text-center text-[10px] text-white/25">
          Records are saved per circuit —
          {formatMs(SaveData.getBestLap('velocita')) !== '--:--.---' ? ` best at Velocità: ${formatMs(SaveData.getBestLap('velocita')!)}` : ' none set yet'}
        </div>
      </div>
    </div>
  );
}
