'use client';

/**
 * VELOCITY GP — v27 SECRET ADMIN PANEL (K+L+Ñ).
 *
 * Never referenced by any menu, never hinted in the UI — the combo is the
 * only way in. Cheat grid: BOOST (win-me-the-race thrust), engine/grip/
 * wear toggles, repair, spin the field, slow bots, instant win.
 */

import type { JSX } from 'react';
import type { AdminPanelState } from '@/game/core/GameBridge';

interface Props {
  state: AdminPanelState;
  onAction: (action: string) => void;
}

function Toggle({ label, hint, on, onClick }: { label: string; hint: string; on: boolean; onClick: () => void }): JSX.Element {
  return (
    <button
      onClick={onClick}
      className={`group flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-left transition ${
        on
          ? 'border-[#e10600] bg-[#e10600]/20 shadow-[0_0_10px_rgba(225,6,0,0.35)]'
          : 'border-white/10 bg-white/5 hover:border-white/25 hover:bg-white/10'
      }`}
    >
      <span className="flex flex-col">
        <span className="text-[12px] font-black uppercase tracking-wider text-white">{label}</span>
        <span className="text-[10px] font-medium text-white/40">{hint}</span>
      </span>
      <span
        className={`h-4 w-8 shrink-0 rounded-full border transition ${
          on ? 'border-[#ff5a4d] bg-[#e10600]' : 'border-white/20 bg-black/50'
        } relative`}
      >
        <span
          className={`absolute top-[1px] h-[12px] w-[12px] rounded-full bg-white transition-all ${
            on ? 'left-[17px]' : 'left-[2px] opacity-50'
          }`}
        />
      </span>
    </button>
  );
}

function Action({ label, hint, tone, onClick }: { label: string; hint: string; tone: 'orange' | 'red' | 'green'; onClick: () => void }): JSX.Element {
  const tones = {
    orange: 'border-[#ff9440]/40 bg-[#ff9440]/10 hover:bg-[#ff9440]/25 text-[#ffb26b]',
    red: 'border-[#e10600]/50 bg-[#e10600]/15 hover:bg-[#e10600]/30 text-[#ff8a80]',
    green: 'border-[#3ddc84]/40 bg-[#3ddc84]/10 hover:bg-[#3ddc84]/25 text-[#7cf2ab]',
  } as const;
  return (
    <button
      onClick={onClick}
      className={`flex flex-col items-start rounded-md border px-3 py-2 text-left transition ${tones[tone]}`}
    >
      <span className="text-[12px] font-black uppercase tracking-wider">{label}</span>
      <span className="text-[10px] font-medium opacity-60">{hint}</span>
    </button>
  );
}

export function AdminPanel({ state, onAction }: Props): JSX.Element {
  return (
    <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center">
      <div className="pointer-events-auto w-[560px] max-w-[92vw] rounded-xl border border-white/15 bg-[#0b0d11]/95 p-4 shadow-[0_24px_80px_rgba(0,0,0,0.7)] backdrop-blur-md">
        {/* header */}
        <div className="mb-3 flex items-center justify-between border-b border-white/10 pb-2">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 animate-pulse rounded-full bg-[#e10600]" />
            <span className="text-[13px] font-black uppercase tracking-[0.2em] text-white">Panel de Admin</span>
            <span className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-[9px] font-bold text-white/50">v27</span>
          </div>
          <button
            onClick={() => onAction('close')}
            className="rounded-md border border-white/15 px-2 py-1 text-[10px] font-black uppercase tracking-widest text-white/60 transition hover:border-white/40 hover:text-white"
          >
            Cerrar ✕
          </button>
        </div>

        {/* the win button — big, first */}
        <button
          onClick={() => onAction('boost')}
          className="mb-3 w-full rounded-lg border border-[#ff9440]/60 bg-gradient-to-r from-[#ff6a00]/30 via-[#e10600]/25 to-[#ff6a00]/30 px-4 py-3 text-center transition hover:from-[#ff6a00]/50 hover:via-[#e10600]/45 hover:to-[#ff6a00]/50"
        >
          <span className="block text-[16px] font-black uppercase tracking-[0.25em] text-[#ffc59b] drop-shadow-[0_0_12px_rgba(255,120,40,0.6)]">
            ⚡ Boost ⚡
          </span>
          <span className="block text-[10px] font-semibold uppercase tracking-wider text-white/45">
            +1.480 CV durante 3 s — púlsalo en cada recta y ganas
          </span>
        </button>

        {/* toggles */}
        <div className="mb-3 grid grid-cols-2 gap-2">
          <Toggle label="Turbo Motor" hint="potencia ×1.5 · menos drag" on={state.turbo} onClick={() => onAction('turbo')} />
          <Toggle label="Agarre Turbo" hint="agarre ×1.45 — pegado al asfalto" on={state.grip} onClick={() => onAction('grip')} />
          <Toggle label="Sin Desgaste" hint="neumáticos y gasolina congelados" on={state.noWear} onClick={() => onAction('nowear')} />
          <Toggle label="Bots Lentos" hint="la IA frena pronto y curva suave" on={state.slowBots} onClick={() => onAction('slowbots')} />
          <Toggle label="Invencible" hint="bombas y golpes no dañan tu coche" on={state.invuln} onClick={() => onAction('invuln')} />
          <Action label="Reparar Coche" hint="borra todo el daño" tone="green" onClick={() => onAction('repair')} />
        </div>

        {/* chaos row */}
        <div className="grid grid-cols-2 gap-2">
          <Action label="Trompo General" hint="toda la IA patina ahora" tone="red" onClick={() => onAction('spinbots')} />
          <Action
            label={state.online ? 'Ganar (offline)' : 'Ganar Carrera'}
            hint={state.online ? 'no disponible online' : 'bandera a cuadros — teclas tú P1'}
            tone="orange"
            onClick={() => onAction('win')}
          />
        </div>

        <div className="mt-3 border-t border-white/10 pt-2 text-center font-mono text-[9px] uppercase tracking-[0.3em] text-white/25">
          k + l + ñ abre y cierra
        </div>
      </div>
    </div>
  );
}
