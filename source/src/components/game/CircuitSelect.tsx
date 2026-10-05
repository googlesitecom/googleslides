'use client';

/**
 * APEX GP — Circuit select: live SVG layouts generated from the control
 * points, records per circuit, lap count selector.
 */

import { useMemo, type JSX } from 'react';
import { CIRCUITS } from '@/game/f1/Circuits';
import { SaveData } from '@/game/persistence/SaveData';
import { formatMs } from '@/game/core/MathUtils';
import type { Weather } from '@/game/core/Types';

function CircuitSVG({ points, color }: { points: { x: number; z: number }[]; color: string }): JSX.Element {
  const d = useMemo(() => {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of points) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
    }
    const span = Math.max(maxX - minX, maxZ - minZ);
    const sc = 100 / span;
    const ox = (100 - (maxX - minX) * sc) / 2;
    const oz = (100 - (maxZ - minZ) * sc) / 2;
    const pt = (p: { x: number; z: number }): string =>
      `${((p.x - minX) * sc + ox).toFixed(1)},${((p.z - minZ) * sc + oz).toFixed(1)}`;
    return `M ${pt(points[0])} ` + points.slice(1).map(pt).join(' L ') + ' Z';
  }, [points]);

  return (
    <svg viewBox="-8 -8 116 116" className="h-full w-full">
      <path d={d} fill="none" stroke={color} strokeWidth={4.5} strokeLinejoin="round" strokeLinecap="round" />
      <path d={d} fill="none" stroke="rgba(255,255,255,0.25)" strokeWidth={1} strokeLinejoin="round" />
      {/* start tick */}
      <circle cx={0} cy={0} r={0} />
    </svg>
  );
}

const ENV_LABEL: Record<string, string> = {
  temperate: 'Speed temple · low wing',
  coast: 'Street circuit · walls & 90°',
  alpine: 'Mountain · elevation & hairpins',
  parkland: 'Royal parkland · high speed',
  highland: 'Highland · stadium bowl',
  prairie: 'Texas prairie · big skies',
};

const WEATHERS: { id: Weather; label: string; sub: string; dot: string }[] = [
  { id: 'clear', label: 'CLEAR', sub: 'Sun · dry', dot: '#ffd54a' },
  { id: 'sunset', label: 'SUNSET', sub: 'Golden hour', dot: '#ff8b3d' },
  { id: 'cloudy', label: 'CLOUDY', sub: 'Overcast', dot: '#b8c4d4' },
  { id: 'rain', label: 'RAIN', sub: 'Wet · low grip', dot: '#4a9fe8' },
  { id: 'night', label: 'NIGHT', sub: 'Floodlights', dot: '#6a5bff' },
];

export function CircuitSelect({ circuitId, laps, weather, onPick, onWeather, onBack, onNext }: {
  circuitId: string;
  laps: number;
  weather: Weather;
  onPick: (id: string, laps: number) => void;
  onWeather: (w: Weather) => void;
  onBack: () => void;
  onNext: () => void;
}): JSX.Element {
  const circuit = CIRCUITS.find(c => c.id === circuitId) ?? CIRCUITS[0];
  const best = SaveData.getBestLap(circuit.id);

  return (
    <div className="absolute inset-0 overflow-y-auto bg-[linear-gradient(180deg,#0a0b10,#08080c_60%,#0a0b10)] text-white">
      <div className="mx-auto flex min-h-full w-full max-w-4xl flex-col px-6 py-6">
        <header className="flex items-center justify-between">
          <button onClick={onBack} className="rounded-lg bg-white/10 px-4 py-2 text-sm font-black text-white/80 hover:bg-white/20">← BACK</button>
          <h1 className="text-xl font-black uppercase italic tracking-widest">CIRCUIT</h1>
          <div className="w-[110px]" />
        </header>

        <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
          {CIRCUITS.map(c => {
            const selected = c.id === circuit.id;
            return (
              <button
                key={c.id}
                onClick={() => onPick(c.id, laps)}
                className={`group overflow-hidden rounded-xl border p-4 text-left transition-all ${
                  selected ? 'border-white/60 bg-white/[0.07]' : 'border-white/10 bg-white/[0.03] hover:border-white/30'
                }`}
              >
                <div className="mx-auto h-32 w-32">
                  <CircuitSVG points={c.points} color={selected ? '#e10600' : '#8b93a5'} />
                </div>
                <div className="mt-2 text-sm font-black italic leading-tight">{c.name}</div>
                <div className="mt-0.5 font-mono text-[10px] font-bold text-white/40">{c.country} · {ENV_LABEL[c.env]}</div>
                <div className="mt-2 flex items-center justify-between text-[10px] font-bold">
                  <span className="rounded bg-white/10 px-1.5 py-0.5 text-white/60">{c.drsZones.length} DRS</span>
                  <span className="text-white/40">
                    {best && c.id === circuit.id ? `RECORD ${formatMs(best)}` : ''}
                  </span>
                </div>
              </button>
            );
          })}
        </div>

        {/* weather */}
        <div className="mt-6">
          <div className="mb-2 flex items-center gap-3">
            <span className="text-xs font-black uppercase tracking-widest text-white/40">Conditions</span>
            <span className="h-px flex-1 bg-white/10" />
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            {WEATHERS.map(w => {
              const selected = w.id === weather;
              return (
                <button
                  key={w.id}
                  onClick={() => onWeather(w.id)}
                  className={`flex items-center gap-3 rounded-xl border px-3.5 py-2.5 text-left transition-all ${
                    selected ? 'border-[#e10600] bg-[#e10600]/15' : 'border-white/10 bg-white/[0.03] hover:border-white/30'
                  }`}
                >
                  <span
                    className="h-6 w-6 shrink-0 rounded-full"
                    style={{
                      background: w.dot,
                      boxShadow: selected ? `0 0 12px ${w.dot}` : undefined,
                      opacity: selected ? 1 : 0.55,
                    }}
                  />
                  <span>
                    <span className={`block text-sm font-black tracking-wide ${selected ? 'text-white' : 'text-white/75'}`}>{w.label}</span>
                    <span className="block text-[10px] font-semibold text-white/40">{w.sub}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* laps */}
        <div className="mt-6 flex items-center gap-4">
          <span className="text-xs font-black uppercase tracking-widest text-white/40">Laps</span>
          <div className="flex gap-2">
            {[3, 5, 8, 12].map(n => (
              <button
                key={n}
                onClick={() => onPick(circuit.id, n)}
                className={`h-10 w-12 rounded-lg border text-sm font-black transition ${
                  laps === n ? 'border-[#e10600] bg-[#e10600] text-white' : 'border-white/15 bg-white/5 text-white/60 hover:border-white/40'
                }`}
              >
                {n}
              </button>
            ))}
          </div>
          <span className="text-[11px] text-white/30">~{Math.round(laps * 1.7)} min race</span>
        </div>

        <div className="mt-auto flex justify-end pb-4 pt-6">
          <button
            onClick={onNext}
            className="rounded-xl bg-gradient-to-r from-[#e10600] to-[#ff3b30] px-10 py-3 text-lg font-black italic tracking-wider shadow-lg transition hover:scale-[1.03] active:scale-95"
          >
            TO THE GRID →
          </button>
        </div>
      </div>
    </div>
  );
}
