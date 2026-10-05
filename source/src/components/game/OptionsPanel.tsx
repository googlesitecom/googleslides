'use client';

/**
 * APEX GP — Options: graphics are LOCKED at ULTRA (always the highest tier),
 * plus HUD toggles, audio levels and full control remapping with live key
 * capture (keyboard).
 */

import { useEffect, useState, type JSX } from 'react';
import { Action, Binding } from '@/game/core/InputManager';
import { SaveData } from '@/game/persistence/SaveData';
import { AudioSys } from '@/game/core/AudioSystem';

const ACTION_LABEL: Record<Action, string> = {
  accelerate: 'Throttle',
  brake: 'Brake',
  steerLeft: 'Steer left',
  steerRight: 'Steer right',
  shiftUp: 'Shift up',
  shiftDown: 'Shift down',
  drs: 'DRS',
  lookBack: 'Look back',
  camera: 'Change camera',
  pit: 'Pit strategy',
  pause: 'Pause',
};

const KEY_LABEL: Record<string, string> = {
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  Space: 'SPACE', ShiftLeft: 'L-SHIFT', ShiftRight: 'R-SHIFT',
  Enter: 'ENTER', Escape: 'ESC', ControlLeft: 'L-CTRL', ControlRight: 'R-CTRL',
  Tab: 'TAB', Backspace: 'BACKSPACE',
};

export function prettyKey(code: string): string {
  if (KEY_LABEL[code]) return KEY_LABEL[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  return code;
}

export function OptionsPanel({ onBindingsChanged, onClose, embedded }: {
  onBindingsChanged?: (b: Binding[]) => void;
  onClose: () => void;
  embedded?: boolean;
}): JSX.Element {
  const [showSpeedo, setShowSpeedo] = useState(SaveData.options.showSpeedometer);
  const [musicVol, setMusicVol] = useState(SaveData.options.musicVolume);
  const [sfxVol, setSfxVol] = useState(SaveData.options.sfxVolume);
  const [bindings, setBindings] = useState<Binding[]>(SaveData.bindings);
  const [capturing, setCapturing] = useState<{ action: Action; index: number } | null>(null);

  // key capture for remapping
  useEffect(() => {
    if (!capturing) return;
    const handler = (e: KeyboardEvent): void => {
      e.preventDefault();
      if (e.code !== 'Escape') {
        const next = bindings.map((b, idx) =>
          idx === capturing.index ? { ...b, code: e.code, label: prettyKey(e.code) } : b);
        setBindings(next);
        SaveData.setBindingsList(next);
        onBindingsChanged?.(next);
      }
      setCapturing(null);
    };
    window.addEventListener('keydown', handler, { once: true, capture: true });
    return () => window.removeEventListener('keydown', handler, { capture: true });
  }, [capturing, bindings, onBindingsChanged]);

  const saveSpeedo = (v: boolean): void => {
    setShowSpeedo(v);
    SaveData.setOptions({ ...SaveData.options, showSpeedometer: v });
  };

  const saveMusic = (v: number): void => {
    setMusicVol(v);
    AudioSys.setMusicVolume(v);
    SaveData.setOptions({ ...SaveData.options, musicVolume: v });
  };

  const saveSfx = (v: number): void => {
    setSfxVol(v);
    AudioSys.setSfxVolume(v);
    SaveData.setOptions({ ...SaveData.options, sfxVolume: v });
  };

  const resetBindings = (): void => {
    const fresh = bindings.map(b => ({ ...b }));
    setBindings(fresh);
    SaveData.setBindingsList(fresh);
    onBindingsChanged?.(fresh);
  };

  const body = (
    <div className={`flex w-full flex-col gap-5 overflow-y-auto ${embedded ? 'max-h-[70vh]' : 'min-h-full'} px-1 py-1`}>
      {/* video — locked at ULTRA */}
      <section className="rounded-2xl border border-white/10 bg-black/40 p-4">
        <h2 className="mb-3 text-sm font-black uppercase tracking-widest text-white/50">Video</h2>
        <div className="flex items-center gap-3 rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-3">
          <span className="inline-block h-2.5 w-2.5 rounded-full bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.9)]" />
          <div>
            <div className="text-sm font-black tracking-wide text-amber-300">ULTRA — LOCKED</div>
            <div className="text-[11px] font-semibold text-white/45">
              Full-resolution rendering, 4K soft shadows, PBR reflections &amp; weather lighting are always on.
            </div>
          </div>
        </div>
        <label className="mt-4 flex cursor-pointer items-center gap-3 text-sm font-bold text-white/80">
          <input type="checkbox" checked={showSpeedo} onChange={e => saveSpeedo(e.target.checked)} className="h-4 w-4 accent-amber-400" />
          Show telemetry (HUD)
        </label>
      </section>

      {/* audio */}
      <section className="rounded-2xl border border-white/10 bg-black/40 p-4">
        <h2 className="mb-3 text-sm font-black uppercase tracking-widest text-white/50">Audio</h2>
        <label className="flex items-center gap-3 text-sm font-bold text-white/80">
          <span className="w-28 shrink-0">Ambience</span>
          <input
            type="range" min={0} max={1} step={0.05} value={musicVol}
            onChange={e => saveMusic(parseFloat(e.target.value))}
            className="h-2 w-full cursor-pointer accent-amber-400"
          />
          <span className="w-10 text-right font-mono text-xs text-amber-300">{Math.round(musicVol * 100)}</span>
        </label>
        <label className="mt-3 flex items-center gap-3 text-sm font-bold text-white/80">
          <span className="w-28 shrink-0">Effects</span>
          <input
            type="range" min={0} max={1} step={0.05} value={sfxVol}
            onChange={e => saveSfx(parseFloat(e.target.value))}
            className="h-2 w-full cursor-pointer accent-amber-400"
          />
          <span className="w-10 text-right font-mono text-xs text-amber-300">{Math.round(sfxVol * 100)}</span>
        </label>
        <div className="mt-2 text-[11px] text-white/40">Music starts with your first click of the session (browser policy).</div>
      </section>

      {/* controls */}
      <section className="rounded-2xl border border-white/10 bg-black/40 p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-black uppercase tracking-widest text-white/50">Controls (keyboard)</h2>
          <button onClick={resetBindings} className="rounded-lg bg-white/10 px-3 py-1 text-xs font-black text-white/70 hover:bg-white/20">
            RESET
          </button>
        </div>
        <div className="grid gap-1.5 sm:grid-cols-2">
          {bindings.map((b, i) => (
            <button
              key={`${b.action}-${i}`}
              onClick={() => setCapturing({ action: b.action, index: i })}
              className={`flex items-center justify-between rounded-xl border px-3 py-2 text-sm font-bold transition ${
                capturing?.index === i
                  ? 'animate-pulse border-amber-400 bg-amber-400/20 text-amber-300'
                  : 'border-white/10 bg-white/5 text-white/80 hover:border-white/25'
              }`}
            >
              <span>{ACTION_LABEL[b.action]}</span>
              <span className="rounded-lg bg-black/50 px-2 py-0.5 font-mono text-xs text-amber-300">
                {capturing?.index === i ? 'PRESS A KEY…' : prettyKey(b.code)}
              </span>
            </button>
          ))}
        </div>
        <div className="mt-3 text-[11px] leading-relaxed text-white/40">
          Gamepads configure themselves: left stick steers, right trigger throttles, left trigger brakes.
          ESC cancels a remapping.
        </div>
      </section>
    </div>
  );

  if (embedded) return body;

  return (
    <div className="absolute inset-0 overflow-y-auto bg-gradient-to-b from-[#141a2c] via-[#0d0a18] to-black">
      <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col gap-5 px-6 py-8">
        <header className="flex w-full items-center justify-between">
          <button onClick={onClose} className="rounded-xl bg-white/10 px-4 py-2 text-sm font-black text-white/80 hover:bg-white/20">← BACK</button>
          <h1 className="text-2xl font-black tracking-wide text-white">OPTIONS</h1>
          <div className="w-[104px]" />
        </header>
        {body}
        <button
          onClick={onClose}
          className="mx-auto mb-4 w-full max-w-xs rounded-2xl bg-gradient-to-r from-amber-400 to-orange-500 py-3 text-lg font-black tracking-wider text-black shadow-lg transition hover:scale-[1.02] active:scale-95"
        >
          SAVE AND BACK
        </button>
      </div>
    </div>
  );
}
