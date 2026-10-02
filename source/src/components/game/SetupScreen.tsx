'use client';

/**
 * APEX GP — Car setup: aero level, brake bias, tire compound, gearbox mode.
 * Every choice feeds the real physics model (cda/cla, brake split, mu).
 */

import type { JSX } from 'react';
import type { CarSetup, GameMode } from '@/game/core/Types';

const WING_LABEL = ['', 'MONZA — top speed', 'LOW — fast circuit', 'MEDIUM — balanced', 'HIGH — cornering load', 'MAX — technical circuit'];
const COMPOUNDS: { id: CarSetup['compound']; name: string; color: string; sub: string }[] = [
  { id: 'soft', name: 'SOFT', color: '#e10600', sub: 'red sidewall — max grip, wears fast. DRY only.' },
  { id: 'medium', name: 'MEDIUM', color: '#ffd500', sub: 'yellow sidewall — the balanced slick. DRY only.' },
  { id: 'hard', name: 'HARD', color: '#f0f0f0', sub: 'white sidewall — less grip, longest life. DRY only.' },
  { id: 'inter', name: 'INTER', color: '#43b02a', sub: 'green sidewall — damp track crossover. Aquaplanes far less than slicks.' },
  { id: 'wet', name: 'WET', color: '#0062ad', sub: 'blue sidewall — heavy rain. Full grip in standing water, overheats if it dries.' },
];

export function SetupScreen({ mode, setup, autoGears, onChange, onBack, onNext }: {
  mode: GameMode;
  setup: CarSetup;
  autoGears: boolean;
  onChange: (patch: Partial<CarSetup> & { autoGears?: boolean }) => void;
  onBack: () => void;
  onNext: () => void;
}): JSX.Element {
  return (
    <div className="absolute inset-0 overflow-y-auto bg-[linear-gradient(180deg,#0a0b10,#08080c_60%,#0a0b10)] text-white">
      <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col px-6 py-6">
        <header className="flex items-center justify-between">
          <button onClick={onBack} className="rounded-lg bg-white/10 px-4 py-2 text-sm font-black text-white/80 hover:bg-white/20">← BACK</button>
          <h1 className="text-xl font-black uppercase italic tracking-widest">SETUP</h1>
          <div className="w-[110px]" />
        </header>

        {/* wing */}
        <section className="mt-5 rounded-2xl border border-white/10 bg-white/[0.03] p-5">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-black uppercase tracking-widest text-white/60">Aero level</h2>
            <span className="font-mono text-xs text-white/40">level {setup.wing}</span>
          </div>
          <div className="mt-3 grid grid-cols-5 gap-2">
            {[1, 2, 3, 4, 5].map(w => (
              <button
                key={w}
                onClick={() => onChange({ wing: w })}
                className={`h-12 rounded-lg border text-sm font-black transition ${
                  setup.wing === w ? 'border-[#e10600] bg-[#e10600]' : 'border-white/15 bg-white/5 text-white/50 hover:border-white/40'
                }`}
              >
                {w}
              </button>
            ))}
          </div>
          <div className="mt-2 flex items-center justify-between text-[10px] font-bold uppercase tracking-widest text-white/35">
            <span>− drag · + top speed</span>
            <span className="text-white/60">{WING_LABEL[setup.wing]}</span>
            <span>+ load · + corner grip</span>
          </div>
        </section>

        {/* brake bias */}
        <section className="mt-4 rounded-2xl border border-white/10 bg-white/[0.03] p-5">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-black uppercase tracking-widest text-white/60">Brake bias</h2>
            <span className="font-mono text-xs text-white/40">{Math.round(setup.brakeBias * 100)}% front</span>
          </div>
          <input
            type="range" min={50} max={62} step={1}
            value={Math.round(setup.brakeBias * 100)}
            onChange={e => onChange({ brakeBias: parseInt(e.target.value, 10) / 100 })}
            className="mt-3 h-2 w-full cursor-pointer accent-[#e10600]"
          />
          <div className="mt-1 flex justify-between text-[10px] font-bold uppercase tracking-widest text-white/35">
            <span>50 — rear (rotation)</span>
            <span>62 — front (stable)</span>
          </div>
        </section>

        {/* compound + gearbox */}
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
            <h2 className="text-sm font-black uppercase tracking-widest text-white/60">Tires</h2>
            <div className="mt-3 flex gap-2">
              {COMPOUNDS.map(c => (
                <button
                  key={c.id}
                  onClick={() => onChange({ compound: c.id })}
                  className={`flex-1 rounded-xl border-2 p-2 text-center transition ${
                    setup.compound === c.id ? 'bg-white/10' : 'border-transparent bg-black/30 hover:bg-white/5'
                  }`}
                  style={setup.compound === c.id ? { borderColor: c.color } : undefined}
                >
                  <div className="mx-auto h-3 w-3 rounded-full border-2" style={{ borderColor: c.color, background: setup.compound === c.id ? c.color : 'transparent' }} />
                  <div className="mt-1.5 text-xs font-black">{c.name}</div>
                </button>
              ))}
            </div>
            <div className="mt-2 text-[10px] font-semibold text-white/35">{COMPOUNDS.find(c => c.id === setup.compound)?.sub}</div>
          </section>

          <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
            <h2 className="text-sm font-black uppercase tracking-widest text-white/60">Gearbox</h2>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <button
                onClick={() => onChange({ autoGears: true })}
                className={`h-14 rounded-xl border text-sm font-black transition ${autoGears ? 'border-[#e10600] bg-[#e10600]' : 'border-white/15 bg-white/5 text-white/50 hover:border-white/40'}`}
              >
                AUTOMATIC
              </button>
              <button
                onClick={() => onChange({ autoGears: false })}
                className={`h-14 rounded-xl border text-sm font-black transition ${!autoGears ? 'border-[#e10600] bg-[#e10600]' : 'border-white/15 bg-white/5 text-white/50 hover:border-white/40'}`}
              >
                MANUAL <span className="text-[10px] font-bold opacity-70">(X / Z)</span>
              </button>
            </div>
            <div className="mt-2 text-[10px] font-semibold text-white/35">ERS deploys automatically at full throttle</div>
          </section>
        </div>

        <div className="mt-auto flex items-center justify-between pb-4 pt-6">
          <div className="text-[11px] leading-relaxed text-white/35">
            {mode === 'timetrial'
              ? 'Time trial: minimum fuel, no rivals, your ghost rides with you.'
              : 'Rivals adapt wing and compound to every circuit — no cheats, just physics.'}
          </div>
          <button
            onClick={onNext}
            className="shrink-0 rounded-xl bg-gradient-to-r from-[#e10600] to-[#ff3b30] px-10 py-3 text-lg font-black italic tracking-wider shadow-lg transition hover:scale-[1.03] active:scale-95"
          >
            CHOOSE CIRCUIT →
          </button>
        </div>
      </div>
    </div>
  );
}
