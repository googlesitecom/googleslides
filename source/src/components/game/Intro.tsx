'use client';

/**
 * VELOCITY GP — F1-style motion-graphics intro.
 *
 * Gate (click unlocks audio) → five red start lights → lights-out flash →
 * speed-streak wipe → logo slam → tagline → menu. Every beat is CSS
 * keyframes; the light beeps come from the game AudioSys.
 */

import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { AudioSys } from '@/game/core/AudioSystem';

type Phase = 'gate' | 'lights' | 'slam' | 'tag' | 'out';

const LIGHT_MS = 620;      // per light
const LIGHTS_N = 5;
const T_LIGHTS_OUT = LIGHT_MS * LIGHTS_N + 700;   // the random-feeling hold
const T_SLAM = T_LIGHTS_OUT + 150;
const T_TAG = T_SLAM + 1500;
const T_OUT = T_TAG + 2600;
const T_AUTO = T_OUT + 3200;

export function Intro({ onDone }: { onDone: () => void }): JSX.Element {
  const [phase, setPhase] = useState<Phase>('gate');
  const [lit, setLit] = useState(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const finished = useRef(false);

  const finish = useCallback((): void => {
    if (finished.current) return;
    finished.current = true;
    for (const t of timers.current) clearTimeout(t);
    timers.current = [];
    onDone();
  }, [onDone]);

  // the sequence (started by the gate click)
  const begin = useCallback((): void => {
    if (phase !== 'gate') return;
    AudioSys.unlock();
    AudioSys.musicStart();          // the anthem, full volume, from the first beat
    setPhase('lights');
    for (let i = 1; i <= LIGHTS_N; i++) {
      timers.current.push(setTimeout(() => {
        setLit(i);
        AudioSys.playLightsBeep(i);
      }, i * LIGHT_MS));
    }
    timers.current.push(setTimeout(() => {
      setLit(0);                    // lights out!
      AudioSys.playLightsBeep(0);
      AudioSys.playBeep(1760, 0.5, 'sawtooth', 0.10);
    }, T_LIGHTS_OUT));
    timers.current.push(setTimeout(() => setPhase('slam'), T_SLAM));
    timers.current.push(setTimeout(() => setPhase('tag'), T_TAG));
    timers.current.push(setTimeout(() => setPhase('out'), T_OUT));
    timers.current.push(setTimeout(finish, T_AUTO));
  }, [phase, finish]);

  // skip / advance on any click after the gate
  const advance = useCallback((): void => {
    if (phase === 'gate') { begin(); return; }
    if (phase === 'out' || phase === 'tag') finish();
  }, [phase, begin, finish]);

  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') finish();
      else if (phase === 'gate' || phase === 'out') begin();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [phase, begin, finish]);

  // QA/automation escape hatches: a global skip handle + auto-dismiss the
  // moment a session starts (online race:start can land while the intro plays)
  useEffect(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__vgpIntro = { skip: (): void => finish() };
    const poll = setInterval(() => {
      try {
        const apex = w.__apex as { state?: () => { phase?: string } } | undefined;
        const st = apex?.state?.();
        if (st?.phase && st.phase !== 'idle') finish();
      } catch { /* engine still booting */ }
    }, 300);
    return () => {
      clearInterval(poll);
      delete w.__vgpIntro;
    };
  }, [finish]);

  useEffect(() => () => { for (const t of timers.current) clearTimeout(t); }, []);

  const streaks = Array.from({ length: 14 }, (_, i) => i);

  return (
    <div
      className="absolute inset-0 z-50 select-none overflow-hidden bg-black"
      onClick={advance}
      role="presentation"
    >
      <style>{`
        @keyframes vgpFlash { 0% { opacity: 0; } 12% { opacity: 1; } 100% { opacity: 0; } }
        @keyframes vgpStreak {
          0% { transform: translateX(-130vw) skewX(-24deg); }
          100% { transform: translateX(130vw) skewX(-24deg); }
        }
        @keyframes vgpSlamL {
          0% { transform: translateX(-60vw) skewX(-18deg); opacity: 0; filter: blur(14px); }
          55% { opacity: 1; filter: blur(0); }
          72% { transform: translateX(1.2vw) skewX(-12deg); }
          86% { transform: translateX(-0.5vw) skewX(-12deg); }
          100% { transform: translateX(0) skewX(-12deg); opacity: 1; filter: blur(0); }
        }
        @keyframes vgpSlamR {
          0% { transform: translateX(60vw) skewX(-18deg); opacity: 0; filter: blur(14px); }
          55% { opacity: 1; filter: blur(0); }
          72% { transform: translateX(-1.2vw) skewX(-12deg); }
          86% { transform: translateX(0.5vw) skewX(-12deg); }
          100% { transform: translateX(0) skewX(-12deg); opacity: 1; filter: blur(0); }
        }
        @keyframes vgpTag {
          0% { letter-spacing: 1.6em; opacity: 0; }
          100% { letter-spacing: 0.42em; opacity: 1; }
        }
        @keyframes vgpLine { 0% { transform: scaleX(0); } 100% { transform: scaleX(1); } }
        @keyframes vgpPulse { 0%, 100% { opacity: 0.25; } 50% { opacity: 1; } }
        @keyframes vgpLightOn { 0% { opacity: 0.15; } 100% { opacity: 1; } }
      `}</style>

      {/* ---------------- gate: click to start ---------------- */}
      {phase === 'gate' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-8">
          <svg viewBox="0 0 64 64" className="h-20 w-20 drop-shadow-[0_0_18px_rgba(225,6,0,0.55)]">
            <path d="M14 10 L28 10 L38 40 L48 10 L62 10 L44 56 L32 56 Z" fill="#e10600"/>
          </svg>
          <div className="text-center">
            <div className="text-5xl font-black italic tracking-tighter text-white sm:text-7xl">
              VELOCITY <span className="text-[#e10600]">GP</span>
            </div>
            <div className="mt-3 text-[11px] font-bold uppercase tracking-[0.5em] text-white/40">
              Formula Racing Simulator
            </div>
          </div>
          <div className="mt-10 animate-[vgpPulse_1.6s_ease-in-out_infinite] text-sm font-black uppercase tracking-[0.4em] text-white/70">
            Click to start
          </div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.3em] text-white/25">
            Sound on — engine &amp; music
          </div>
        </div>
      )}

      {/* ---------------- start-light gantry ---------------- */}
      {phase === 'lights' && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="flex gap-3 rounded-2xl border border-white/10 bg-black/80 px-8 py-7 shadow-[0_0_60px_rgba(0,0,0,0.9)]">
            {Array.from({ length: LIGHTS_N }, (_, i) => (
              <span
                key={i}
                className="h-16 w-16 rounded-full border-2 sm:h-20 sm:w-20"
                style={{
                  background: lit > i
                    ? 'radial-gradient(circle at 38% 32%, #ff6a5e 0%, #e10600 46%, #7a0300 100%)'
                    : 'radial-gradient(circle at 38% 32%, #23262e 0%, #101218 60%, #07080b 100%)',
                  borderColor: lit > i ? 'rgba(255,80,60,0.85)' : 'rgba(255,255,255,0.08)',
                  boxShadow: lit > i ? '0 0 42px 8px rgba(225,6,0,0.75)' : 'none',
                  transition: 'background 90ms, box-shadow 90ms',
                }}
              />
            ))}
          </div>
        </div>
      )}

      {/* lights-out white flash */}
      {phase === 'slam' && (
        <div className="pointer-events-none absolute inset-0 bg-white" style={{ animation: 'vgpFlash 620ms ease-out forwards' }} />
      )}

      {/* ---------------- speed-streak wipe + logo slam ---------------- */}
      {phase !== 'gate' && phase !== 'lights' && (
        <>
          {streaks.map(i => (
            <span
              key={i}
              className="pointer-events-none absolute h-[2.5vh] min-h-[14px] rounded-full"
              style={{
                top: `${(i * 7.3 + 2) % 100}%`,
                width: `${18 + (i % 5) * 13}vw`,
                background: i % 3 === 0
                  ? 'linear-gradient(90deg, transparent, #ffffff, transparent)'
                  : i % 3 === 1
                    ? 'linear-gradient(90deg, transparent, #e10600, transparent)'
                    : 'linear-gradient(90deg, transparent, rgba(255,255,255,0.35), transparent)',
                opacity: phase === 'slam' ? 0.85 : 0,
                animation: `vgpStreak ${0.55 + (i % 4) * 0.13}s cubic-bezier(.2,.6,.3,1) ${i * 0.035}s ${phase === 'slam' ? 1 : 0} both`,
                transition: 'opacity 700ms',
              }}
            />
          ))}

          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <div className="flex items-end justify-center">
              <span
                className="text-[15vw] font-black italic leading-[0.9] tracking-tighter text-white sm:text-[11vw]"
                style={{ animation: 'vgpSlamL 900ms cubic-bezier(.16,.9,.26,1) both', textShadow: '0 0 60px rgba(225,6,0,0.35)' }}
              >
                VELOCITY
              </span>
              <span
                className="text-[15vw] font-black italic leading-[0.9] tracking-tighter text-[#e10600] sm:text-[11vw]"
                style={{ animation: 'vgpSlamR 900ms cubic-bezier(.16,.9,.26,1) 90ms both', textShadow: '0 0 60px rgba(225,6,0,0.5)' }}
              >
                GP
              </span>
            </div>

            {(phase === 'tag' || phase === 'out') && (
              <div className="mt-6 flex flex-col items-center gap-4">
                <div
                  className="h-[3px] w-[42vw] max-w-xl origin-center bg-gradient-to-r from-transparent via-[#e10600] to-transparent"
                  style={{ animation: 'vgpLine 700ms ease-out both' }}
                />
                <div
                  className="text-[11px] font-bold uppercase text-white/70 sm:text-sm"
                  style={{ animation: 'vgpTag 1100ms cubic-bezier(.2,.7,.3,1) both' }}
                >
                  Formula Racing Simulator
                </div>
              </div>
            )}

            {phase === 'out' && (
              <div
                className="mt-14 animate-[vgpPulse_1.5s_ease-in-out_infinite] text-xs font-black uppercase tracking-[0.45em] text-white/60"
              >
                Click to continue
              </div>
            )}
          </div>
        </>
      )}

      {/* skip */}
      {phase !== 'gate' && (
        <button
          onClick={(e) => { e.stopPropagation(); finish(); }}
          className="absolute bottom-5 right-6 z-10 rounded-md border border-white/15 px-4 py-1.5 text-[11px] font-bold uppercase tracking-[0.3em] text-white/45 transition hover:border-white/40 hover:text-white"
        >
          Skip ▸
        </button>
      )}
    </div>
  );
}
