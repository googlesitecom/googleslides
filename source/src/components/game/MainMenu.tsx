'use client';

/**
 * VELOCITY GP — Main menu. F1-broadcast aesthetic: carbon black, signal red,
 * sharp angled panels, live speed-streak motion. The 3D car showcase renders
 * behind (engine-owned); this layer stays crisp glass + carbon.
 */

import type { JSX } from 'react';

const MODES: { id: 'gp' | 'timetrial'; title: string; sub: string; accent: string }[] = [
  { id: 'gp', title: 'GRAND PRIX', sub: 'Full race vs 19 rivals · pit stops · 5 circuits', accent: 'from-red-600 to-red-500' },
  { id: 'timetrial', title: 'TIME TRIAL', sub: 'Perfect lap · ghost car · no traffic', accent: 'from-purple-500 to-fuchsia-500' },
];

/** The speed-mark logo (V carved from racing lines). */
export function VgpMark({ className = '' }: { className?: string }): JSX.Element {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true">
      <defs>
        <linearGradient id="vgpMenuRed" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ff2d20" />
          <stop offset="0.55" stopColor="#e10600" />
          <stop offset="1" stopColor="#8f0400" />
        </linearGradient>
      </defs>
      <path d="M14 10 L28 10 L38 40 L48 10 L62 10 L44 56 L32 56 Z" fill="url(#vgpMenuRed)" />
      <path d="M0 16 L10 16 L13 24 L3 24 Z" fill="#e10600" opacity="0.85" />
      <path d="M0 32 L7 32 L10 40 L1 40 Z" fill="#e10600" opacity="0.65" />
      <path d="M0 48 L5 48 L8 56 L0 56 Z" fill="#e10600" opacity="0.45" />
    </svg>
  );
}

export function MainMenu({ onMode, onOnline, onOptions }: {
  onMode: (m: 'gp' | 'timetrial') => void;
  onOnline: () => void;
  onOptions: () => void;
}): JSX.Element {
  return (
    <div className="absolute inset-0 flex flex-col text-white">
      {/* carbon backdrop, showcase visible on the right */}
      <div className="absolute inset-0 bg-[linear-gradient(105deg,rgba(6,7,10,0.96)_0%,rgba(8,9,14,0.88)_42%,rgba(8,9,14,0.25)_75%,rgba(8,9,14,0.45)_100%)]" />
      <div className="absolute left-0 top-0 h-full w-[6px] bg-gradient-to-b from-[#e10600] via-[#ff3b30] to-[#7a0300]" />

      {/* ambient speed streaks (slow, subtle — the menu breathes) */}
      <style>{`
        @keyframes vgpMenuStreak { 0% { transform: translateX(-40vw) skewX(-24deg); opacity: 0; } 12% { opacity: 0.5; } 88% { opacity: 0.4; } 100% { transform: translateX(120vw) skewX(-24deg); opacity: 0; } }
      `}</style>
      {Array.from({ length: 5 }, (_, i) => (
        <span
          key={i}
          className="pointer-events-none absolute h-[2px] rounded-full"
          style={{
            top: `${16 + i * 17}%`,
            width: `${24 + i * 9}vw`,
            background: 'linear-gradient(90deg, transparent, rgba(225,6,0,0.75), transparent)',
            animation: `vgpMenuStreak ${7 + i * 2.1}s linear ${i * 1.7}s infinite`,
          }}
        />
      ))}

      <div className="relative z-10 flex h-full w-full max-w-2xl flex-col justify-center gap-8 px-10 py-8 sm:px-16">
        {/* title */}
        <div>
          <div className="flex items-center gap-3">
            <VgpMark className="h-10 w-10 drop-shadow-[0_0_14px_rgba(225,6,0,0.5)]" />
            <span className="text-[11px] font-black uppercase tracking-[0.5em] text-white/45">World Championship</span>
          </div>
          <h1 className="mt-2 text-6xl font-black italic leading-[0.95] tracking-tighter sm:text-7xl">
            VELOCITY<span className="text-[#e10600]"> GP</span>
          </h1>
          <p className="mt-2 text-sm font-bold uppercase tracking-[0.28em] text-white/40">
            Formula Racing Simulator
          </p>
        </div>

        {/* modes */}
        <div className="flex flex-col gap-3">
          {MODES.map(m => (
            <button
              key={m.id}
              onClick={() => onMode(m.id)}
              className="group relative overflow-hidden rounded-xl border border-white/10 bg-white/[0.04] px-6 py-4 text-left backdrop-blur-sm transition-all hover:border-white/30 hover:bg-white/[0.08] active:scale-[0.985]"
            >
              <span className={`absolute inset-y-0 left-0 w-1.5 bg-gradient-to-b ${m.accent} transition-all group-hover:w-2.5`} />
              <div className="pl-4">
                <div className="text-2xl font-black italic tracking-tight">{m.title}</div>
                <div className="text-xs font-semibold tracking-wide text-white/40">{m.sub}</div>
              </div>
              <span className="absolute right-5 top-1/2 -translate-y-1/2 text-xl text-white/20 transition group-hover:translate-x-1 group-hover:text-white/60">→</span>
            </button>
          ))}

          <button
            onClick={onOnline}
            className="group relative overflow-hidden rounded-xl border border-white/10 bg-white/[0.04] px-6 py-4 text-left backdrop-blur-sm transition-all hover:border-white/30 hover:bg-white/[0.08] active:scale-[0.985]"
          >
            <span className="absolute inset-y-0 left-0 w-1.5 bg-gradient-to-b from-emerald-500 to-teal-500 transition-all group-hover:w-2.5" />
            <div className="pl-4">
              <div className="text-2xl font-black italic tracking-tight">MULTIPLAYER</div>
              <div className="text-xs font-semibold tracking-wide text-white/40">Peer-to-peer · room code · authoritative host</div>
            </div>
            <span className="absolute right-5 top-1/2 -translate-y-1/2 text-xl text-white/20 transition group-hover:translate-x-1 group-hover:text-white/60">→</span>
          </button>

          <button
            onClick={onOptions}
            className="mt-1 self-start rounded-lg px-4 py-2 text-sm font-black uppercase tracking-widest text-white/50 transition hover:bg-white/10 hover:text-white"
          >
            Options ⚙
          </button>
        </div>

        {/* controls */}
        <div className="mt-2 grid grid-cols-2 gap-x-8 gap-y-1 text-[11px] font-semibold text-white/35 sm:grid-cols-3">
          <span><b className="text-white/70">W/↑</b> throttle</span>
          <span><b className="text-white/70">S/↓</b> brake</span>
          <span><b className="text-white/70">A/D</b> steering</span>
          <span><b className="text-white/70">X/Z</b> gears (manual)</span>
          <span><b className="text-white/70">E</b> DRS</span>
          <span><b className="text-white/70">C</b> camera · <b className="text-white/70">Q</b> look back</span>
        </div>
      </div>

      {/* version footer */}
      <div className="absolute bottom-3 right-5 z-10 text-[10px] font-bold uppercase tracking-[0.3em] text-white/20">
        Velocity GP · v12
      </div>
    </div>
  );
}
