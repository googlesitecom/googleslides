'use client';

/**
 * VELOCITY GP — The Formula 1 simulator.
 * Entry page: mounts the game shell client-side (WebGL cannot SSR).
 */

import type { JSX } from 'react';
import dynamic from 'next/dynamic';

const GameShell = dynamic(() => import('@/components/game/GameShell'), {
  ssr: false,
  loading: () => (
    <div className="flex h-screen w-screen flex-col items-center justify-center gap-4 bg-[#08080c]">
      <svg viewBox="0 0 64 64" className="h-16 w-16 drop-shadow-[0_0_18px_rgba(225,6,0,0.55)]">
        <path d="M14 10 L28 10 L38 40 L48 10 L62 10 L44 56 L32 56 Z" fill="#e10600" />
      </svg>
      <div className="text-5xl font-black italic tracking-tighter text-white">
        VELOCITY<span className="text-[#e10600]"> GP</span>
      </div>
      <div className="text-xs font-bold tracking-[0.5em] text-white/40">LOADING ENGINE…</div>
    </div>
  ),
});

export default function Home(): JSX.Element {
  return <GameShell />;
}
