'use client';

/**
 * APEX GP — In-race HUD, F1-TV broadcast style:
 *  - left: position tower (team colors, gaps, DRS badges)
 *  - top-right: circuit minimap (engine-drawn canvas) + timing panel
 *  - bottom-center: telemetry — gear, speed, RPM shift lights, DRS, ERS,
 *    fuel, tire compound & wear, pedal traces
 *  - center: the 5-pod start-light gantry, announcer banners, flags
 */

import { useEffect, useState, type JSX } from 'react';
import type { UIState } from '@/game/core/GameBridge';
import { formatMs } from '@/game/core/MathUtils';
import { AudioSys } from '@/game/core/AudioSystem';

const hex = (n: number): string => `#${n.toString(16).padStart(6, '0')}`;
const COMPOUND_COLOR: Record<string, string> = { soft: '#e10600', medium: '#ffd500', hard: '#f0f0f0', inter: '#43b02a', wet: '#0062ad' };

/** RPM shift-light strip: 5 green, 5 red, 5 blue (F1 wheel). */
function ShiftLights({ rpmN }: { rpmN: number }): JSX.Element {
  const leds = 15;
  const on = Math.floor(rpmN * leds * 1.04);
  return (
    <div className="flex gap-[3px]">
      {Array.from({ length: leds }).map((_, i) => {
        const lit = i < on;
        const color = i < 5 ? '#2ecc40' : i < 10 ? '#e10600' : '#3b6bff';
        return (
          <span
            key={i}
            className="h-2.5 w-2.5 rounded-[2px] transition-colors"
            style={{
              background: lit ? color : 'rgba(255,255,255,0.08)',
              boxShadow: lit ? `0 0 6px ${color}` : undefined,
            }}
          />
        );
      })}
    </div>
  );
}

/** Full-width RPM bar spanning the telemetry cluster — the F1-game signature:
 *  segmented LEDs that sweep green → red → blue and blink at the limiter. */
function RpmBar({ rpmN }: { rpmN: number }): JSX.Element {
  const segs = 32;
  const on = Math.floor(rpmN * segs * 1.02);
  const limiter = rpmN > 0.965;
  return (
    <div className={`flex h-[13px] w-full items-stretch gap-[2px] ${limiter ? 'animate-pulse' : ''}`}>
      {Array.from({ length: segs }).map((_, i) => {
        const lit = i < on;
        const color = i < 11 ? '#25d366' : i < 22 ? '#ffd500' : '#ff2d20';
        return (
          <span
            key={i}
            className="flex-1 rounded-[1px]"
            style={{
              background: lit ? color : 'rgba(255,255,255,0.07)',
              boxShadow: lit ? `0 0 5px ${color}aa` : undefined,
            }}
          />
        );
      })}
    </div>
  );
}

/** Angled F1-game panel corner (top-left / bottom-right cut). */
const ANGLE = { clipPath: 'polygon(14px 0, 100% 0, 100% calc(100% - 14px), calc(100% - 14px) 100%, 0 100%, 0 14px)' } as const;

function GapText({ gap }: { gap: number | null }): JSX.Element {
  if (gap == null) return <span className="text-emerald-400">LEADER</span>;
  if (gap >= 60) return <span className="text-white/35">+{Math.floor(gap / 60)}m</span>;
  return <span className="text-white/60">+{gap.toFixed(1)}</span>;
}

export function HUD({ state, minimapRef, onContinue, onPitRequest, onPitCancel, onPitClose }: {
  state: UIState;
  minimapRef: React.RefObject<HTMLCanvasElement | null>;
  onContinue: () => void;
  /** v17 pit menu actions (wired to Game by GameShell) */
  onPitRequest?: (compound: 'soft' | 'medium' | 'hard' | 'inter' | 'wet') => void;
  onPitCancel?: () => void;
  onPitClose?: () => void;
}): JSX.Element {
  const [muted, setMuted] = useState(AudioSys.musicMuted);
  useEffect(() => {
    const h = (e: KeyboardEvent): void => {
      if (e.code === 'KeyM') setMuted(AudioSys.toggleMusic());
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  const t = state.telemetry;
  const timing = state.timing;
  const racing = state.phase === 'racing';
  const lightsOn = state.lights != null;

  return (
    <div className="pointer-events-none absolute inset-0 select-none font-sans">
      {/* ================= position tower (left) ================= */}
      <div className="absolute left-3 top-3 flex flex-col overflow-hidden border border-white/10 bg-black/70 backdrop-blur-sm" style={ANGLE}>
        {/* lap counter header */}
        <div className="flex items-center justify-between gap-3 border-b border-white/10 bg-[#e10600] px-2.5 py-1.5">
          <span className="text-[11px] font-black uppercase tracking-wider text-white">
            LAP <span className="text-black/80">{Math.min(state.lap + 1, state.laps)}</span>/{state.laps}
          </span>
          {timing.sessionFastestMs != null && (
            <span className="font-mono text-[10px] font-bold text-white/90">
              FL {formatMs(timing.sessionFastestMs)}
            </span>
          )}
        </div>
        {state.tower.map(row => (
          <div
            key={row.pos}
            className={`flex items-center gap-1.5 px-2 py-[3px] text-[11px] font-bold leading-none ${
              row.isPlayer ? 'bg-white/15' : row.pos % 2 ? 'bg-white/[0.02]' : ''
            }`}
          >
            <span className="w-4 text-right font-mono text-white/50">{row.pos}</span>
            <span className="h-3.5 w-1 rounded-sm" style={{ background: hex(row.teamColor) }} />
            <span className={`w-9 font-black tracking-wide ${row.isPlayer ? 'text-white' : 'text-white/75'}`}>{row.name}</span>
            <span className="flex-1 text-right">
              {row.penalty > 0 ? (
                <span className="text-[10px] font-black text-rose-400">+{row.penalty}s</span>
              ) : row.finished ? (
                <span className="text-[10px] text-white/35">FIN</span>
              ) : (
                <GapText gap={row.gapSec} />
              )}
            </span>
            {row.drs && (
              <span className="rounded-sm bg-emerald-500 px-1 text-[8px] font-black text-black">DRS</span>
            )}
          </div>
        ))}
      </div>

      {/* ================= timing (top center) ================= */}
      {racing && (
        <div className="absolute left-1/2 top-3 flex -translate-x-1/2 items-stretch gap-px overflow-hidden rounded-lg border border-white/10 bg-black/65 backdrop-blur-sm">
          <div className="px-4 py-1.5 text-center">
            <div className="text-[9px] font-black uppercase tracking-widest text-white/35">Lap</div>
            <div className="font-mono text-lg font-bold leading-tight text-emerald-300">{formatMs(timing.lapMs)}</div>
          </div>
          <div className="w-px bg-white/10" />
          {[0, 1, 2].map(i => {
            const ms = timing.sectorMs[i];
            const done = ms > 0;
            const best = timing.bestSectorMs ? timing.bestSectorMs[i] : null;
            const isBest = done && best != null && isFinite(best) && ms <= best + 2;
            return (
              <div key={i} className="min-w-[52px] px-2 py-1.5 text-center">
                <div className="text-[9px] font-black uppercase tracking-widest text-white/35">S{i + 1}</div>
                <div className={`font-mono text-sm font-bold leading-tight ${
                  !done ? 'text-white/25' : isBest ? 'text-fuchsia-400' : 'text-emerald-400'
                }`}>
                  {done ? `${(ms / 1000).toFixed(3)}` : '—.———'}
                </div>
              </div>
            );
          })}
          <div className="w-px bg-white/10" />
          <div className="px-3 py-1.5 text-center">
            <div className="text-[9px] font-black uppercase tracking-widest text-white/35">Best</div>
            <div className="font-mono text-sm font-bold leading-tight text-white/80">
              {timing.lastLapMs ? formatMs(timing.lastLapMs) : '—:--.---'}
            </div>
          </div>
        </div>
      )}

      {/* ================= minimap + flags (top right) ================= */}
      <div className="absolute right-3 top-3 flex flex-col items-end gap-2">
        <canvas ref={minimapRef} width={186} height={148} className="rounded-lg border border-white/10 shadow-[0_8px_24px_rgba(0,0,0,0.45)]" />
        <div className="flex items-center gap-2">
          {state.flags.chequered && (
            <span className="rounded-md bg-white px-2 py-0.5 text-[10px] font-black text-black">🏁 FINISH</span>
          )}
          {state.flags.blue && (
            <span className="rounded-md bg-blue-600 px-2 py-0.5 text-[10px] font-black text-white">BLUE FLAG</span>
          )}
          {state.trackLimitWarns > 0 && (
            <span className={`rounded-md px-2 py-0.5 text-[10px] font-black ${state.trackLimitWarns >= 3 ? 'bg-rose-600 text-white' : 'bg-black/70 text-white/60'}`}>
              TRACK LIMITS {state.trackLimitWarns}/4
            </span>
          )}
          <button
            className="pointer-events-auto rounded-md bg-black/60 px-2 py-0.5 text-[10px] font-black text-white/50 backdrop-blur-sm transition hover:text-white"
            onClick={() => setMuted(AudioSys.toggleMusic())}
            title="Ambience (M)"
          >
            {muted ? '🔇' : '🔊'}
          </button>
        </div>
      </div>

      {/* ================= start lights ================= */}
      {lightsOn && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="flex flex-col items-center gap-6">
            <div className="flex gap-4 rounded-2xl border border-white/15 bg-black/80 px-8 py-5 shadow-[0_0_60px_rgba(0,0,0,0.8)]">
              {Array.from({ length: 5 }).map((_, i) => {
                const on = (state.lights ?? 0) > i;
                return (
                  <div key={i} className="flex flex-col gap-2">
                    {[0, 1].map(j => (
                      <span
                        key={j}
                        className="h-9 w-9 rounded-full transition-all duration-150"
                        style={{
                          background: on ? 'radial-gradient(circle at 35% 30%, #ff6a5a, #d50000 60%, #500000)' : 'radial-gradient(circle at 35% 30%, #2a0d0d, #1a0505)',
                          boxShadow: on ? '0 0 22px 4px rgba(255, 30, 20, 0.75)' : 'inset 0 2px 6px rgba(0,0,0,0.9)',
                        }}
                      />
                    ))}
                  </div>
                );
              })}
            </div>
            <div className="text-xs font-black uppercase tracking-[0.4em] text-white/40">
              {state.waitingDrivers
                ? 'WAITING FOR DRIVERS…'
                : state.phase === 'grid' ? 'ON THE GRID…' : 'WAIT FOR LIGHTS…'}
            </div>
            {state.waitingDrivers && (
              <div className="mt-1 animate-pulse text-[10px] font-bold uppercase tracking-[0.3em] text-[#ffd400]">
                the race starts when everyone is loaded
              </div>
            )}
          </div>
        </div>
      )}

      {/* ================= telemetry (bottom center) ================= */}
      {!lightsOn && (
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2">
          <div className="flex flex-col rounded-xl border border-white/10 bg-black/75 backdrop-blur-sm" style={ANGLE}>
            {/* the F1-game signature: full-width RPM sweep on top */}
            <div className="px-3 pt-2.5">
              <RpmBar rpmN={t.rpmN} />
            </div>
            <div className="flex items-end gap-4 px-5 pb-3 pt-2">
              {/* gear + speed */}
              <div className="flex items-end gap-3">
                <div className="text-center">
                  <div className="text-[9px] font-black uppercase tracking-widest text-white/35">Gear</div>
                  <div className={`font-mono text-6xl font-black leading-none ${t.rpmN > 0.94 ? 'text-[#ff3b30]' : 'text-white'}`}>
                    {t.gear}
                  </div>
                </div>
                <div className="mb-1 text-center">
                  <div className="text-[9px] font-black uppercase tracking-widest text-white/35">km/h</div>
                  <div className="font-mono text-3xl font-bold leading-none text-white/90">{t.speedKmh}</div>
                  <div className="mt-1 font-mono text-[10px] text-white/40">{Math.round(t.rpmN * 12200)} rpm</div>
                </div>
              </div>

              <div className="mb-1 flex flex-col items-center gap-1.5">
                <ShiftLights rpmN={t.rpmN} />
                {/* DRS + ERS */}
                <div className="flex items-center gap-2">
                  <span
                    className={`rounded px-2 py-0.5 text-[10px] font-black tracking-wider transition-all ${
                      t.drs === 'open' ? 'bg-emerald-500 text-black shadow-[0_0_12px_rgba(16,185,129,0.8)]'
                        : t.drs === 'ready' ? 'border border-emerald-500/70 text-emerald-400'
                          : 'bg-white/5 text-white/25'
                    }`}
                  >
                    DRS
                  </span>
                  <div className="flex items-center gap-1">
                    <span className="text-[9px] font-black uppercase tracking-widest text-white/35">ERS</span>
                    <div className="h-1.5 w-20 overflow-hidden rounded-full bg-white/10">
                      <div
                        className={`h-full rounded-full transition-all ${t.ersDeploying ? 'bg-amber-400' : 'bg-sky-400'}`}
                        style={{ width: `${t.ersPct * 100}%` }}
                      />
                    </div>
                  </div>
                </div>
                {/* pedals */}
                <div className="flex items-center gap-2">
                  <div className="flex h-4 flex-col justify-end gap-[2px]">
                    <div className="w-16 overflow-hidden rounded-sm bg-white/10">
                      <div className="h-1 bg-emerald-400 transition-none" style={{ width: `${t.throttle * 100}%` }} />
                    </div>
                    <div className="w-16 overflow-hidden rounded-sm bg-white/10">
                      <div className="h-1 bg-red-500 transition-none" style={{ width: `${t.brake * 100}%` }} />
                    </div>
                  </div>
                  <span className="font-mono text-[9px] text-white/35">
                    {t.latG > 0 ? '↗' : '↘'}{Math.abs(t.latG).toFixed(1)}G
                  </span>
                </div>
              </div>

              {/* right block: tires + fuel */}
              <div className="mb-1 flex items-center gap-4 border-l border-white/10 pl-4">
                <div className="text-center">
                  <div className="text-[9px] font-black uppercase tracking-widest text-white/35">Tire</div>
                  <div className="mx-auto mt-1 h-6 w-6 rounded-full border-[3px]" style={{ borderColor: COMPOUND_COLOR[t.compound] }} />
                  <div className="mx-auto mt-1 h-1 w-10 overflow-hidden rounded-full bg-white/10">
                    <div
                      className={`h-full rounded-full ${t.tireWear > 0.75 ? 'bg-rose-500' : t.tireWear > 0.45 ? 'bg-amber-400' : 'bg-emerald-400'}`}
                      style={{ width: `${(1 - t.tireWear) * 100}%` }}
                    />
                  </div>
                </div>
                <div className="text-center">
                  <div className="text-[9px] font-black uppercase tracking-widest text-white/35">Fuel</div>
                  <div className="font-mono text-xl font-bold leading-tight text-white/85">{t.fuelKg}<span className="text-[10px] text-white/40"> kg</span></div>
                  <div className="font-mono text-[10px] text-white/40">{t.fuelLapsLeft != null ? `${t.fuelLapsLeft} laps` : ''}</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ================= position badge (bottom left) ================= */}
      <div className="absolute bottom-3 left-3 flex items-center gap-2">
        <div className="overflow-hidden border border-white/10 bg-black/70 backdrop-blur-sm" style={ANGLE}>
          <div className="flex items-center">
            <span className={`px-3 py-1.5 font-mono text-3xl font-black leading-none ${state.position === 1 ? 'text-[#ffd500]' : 'text-white'}`}>
              P{state.position}
            </span>
            <span className="pr-3 text-[10px] font-bold text-white/35">/{state.totalCars}</span>
          </div>
        </div>
        <div className="border border-white/10 bg-black/60 px-2.5 py-1 text-[10px] font-black uppercase tracking-widest text-white/40 backdrop-blur-sm" style={ANGLE}>
          CAM <span className="text-white/75">{state.cameraName}</span>
        </div>
      </div>

      {/* ================= lockup warning ================= */}
      {t.lockup && racing && (
        <div className="absolute bottom-28 left-1/2 -translate-x-1/2 animate-pulse rounded-md bg-rose-600/90 px-4 py-1 text-xs font-black tracking-widest">
          WHEEL LOCKUP!
        </div>
      )}

      {/* ================= v17 PIT: status + strategy menu ================= */}
      {state.pit && state.pit.phase !== 'none' && (
        <div className="absolute bottom-32 left-1/2 -translate-x-1/2">
          {state.pit.phase === 'requested' && (
            <div className="animate-pulse rounded-xl border border-[#ffd400]/50 bg-black/80 px-6 py-2 text-center backdrop-blur">
              <div className="text-base font-black italic tracking-wider text-[#ffd400]">BOX BOX — PIT THIS LAP</div>
              <div className="text-[10px] font-bold uppercase tracking-widest text-white/45">P — cancel · stay out with P menu</div>
            </div>
          )}
          {(state.pit.phase === 'entry' || state.pit.phase === 'lane') && (
            <div className="rounded-xl border border-white/15 bg-black/80 px-6 py-2 text-center backdrop-blur">
              <div className="text-base font-black italic tracking-wider text-white">
                PIT LANE · 80 km/h {state.pit.limiter ? '' : ''}
              </div>
              <div className="text-[10px] font-bold uppercase tracking-widest text-white/45">
                {state.pit.phase === 'entry' ? 'entering the lane' : 'limiter on'}
              </div>
            </div>
          )}
          {state.pit.phase === 'stopped' && (
            <div className="rounded-xl border border-white/15 bg-black/85 px-6 py-3 text-center backdrop-blur">
              <div className="text-sm font-black italic tracking-widest text-white">TYRES + FUEL</div>
              <div className="mt-1.5 h-2.5 w-64 overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-[#e10600] to-[#ffd400] transition-[width] duration-100"
                  style={{ width: `${Math.round(state.pit.stopProgress * 100)}%` }}
                />
              </div>
              <div className="mt-1 font-mono text-lg font-black text-[#ffd400]">
                {state.pit.stopRemaining.toFixed(1)}s
              </div>
            </div>
          )}
          {state.pit.phase === 'exit' && (
            <div className="rounded-xl border border-emerald-400/40 bg-black/80 px-6 py-2 backdrop-blur">
              <div className="text-base font-black italic tracking-wider text-emerald-300">PIT EXIT</div>
            </div>
          )}
        </div>
      )}

      {/* pit strategy menu (P) */}
      {state.pit?.menuOpen && (
        <div className="pointer-events-auto absolute left-1/2 top-1/2 w-[340px] -translate-x-1/2 -translate-y-1/2">
          <div className="rounded-2xl border border-white/15 bg-black/90 p-5 backdrop-blur-md">
            <div className="flex items-center justify-between">
              <div className="text-sm font-black uppercase italic tracking-widest text-white">Pit strategy</div>
              <button
                onClick={onPitClose}
                className="rounded-lg bg-white/10 px-3 py-1 text-xs font-black text-white/70 hover:bg-white/20"
              >
                P · CLOSE
              </button>
            </div>
            <div className="mt-3 text-[11px] font-bold uppercase tracking-widest text-white/40">Tyres for the next stint</div>
            <div className="mt-2 grid grid-cols-5 gap-2">
              {(['soft', 'medium', 'hard', 'inter', 'wet'] as const).map(c => (
                <button
                  key={c}
                  onClick={() => onPitRequest?.(c)}
                  className="rounded-xl border-2 bg-black/60 py-2.5 text-xs font-black uppercase tracking-wider transition hover:scale-105 active:scale-95"
                  style={{
                    borderColor: COMPOUND_COLOR[c],
                    color: COMPOUND_COLOR[c],
                  }}
                >
                  {c}
                </button>
              ))}
            </div>
            <button
              onClick={() => onPitRequest?.(state.pit?.compound ?? 'medium')}
              className="mt-3 w-full rounded-xl bg-gradient-to-r from-[#e10600] to-[#ff3b30] py-2.5 text-sm font-black italic tracking-wider text-white transition hover:scale-[1.02] active:scale-95"
            >
              BOX THIS LAP
            </button>
            {state.pit.phase === 'requested' && (
              <button
                onClick={onPitCancel}
                className="mt-2 w-full rounded-xl border border-white/20 bg-black/50 py-2 text-xs font-black uppercase tracking-wider text-white/70 hover:border-white/50"
              >
                STAY OUT — CANCEL BOX
              </button>
            )}
            <div className="mt-3 flex justify-between text-[10px] font-bold uppercase tracking-widest text-white/35">
              <span>WEAR {(state.telemetry.tireWear * 100).toFixed(0)}%</span>
              <span>{state.telemetry.fuelKg.toFixed(0)} KG</span>
              <span>{state.telemetry.fuelLapsLeft != null ? `${state.telemetry.fuelLapsLeft.toFixed(1)} LAPS` : ''}</span>
            </div>
          </div>
        </div>
      )}

      {/* ================= announcer ================= */}
      <div className="absolute left-1/2 top-24 flex -translate-x-1/2 flex-col items-center gap-1.5">
        {state.announcer.map(a => (
          <div
            key={a.id}
            className={`rounded-md px-4 py-1 text-sm font-black tracking-wide shadow-lg backdrop-blur-sm ${
              a.tone === 'good' ? 'bg-emerald-500/90 text-black'
                : a.tone === 'bad' ? 'bg-rose-600/90 text-white'
                  : a.tone === 'hype' ? 'bg-[#e10600]/95 text-white' : 'bg-black/75 text-white'
            }`}
            style={{ animation: 'bannerIn 0.25s ease-out' }}
          >
            {a.text}
          </div>
        ))}
      </div>

      {/* ================= finished: prompt ================= */}
      {state.phase === 'finished' && !state.results && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="rounded-2xl border border-white/15 bg-black/80 px-10 py-6 text-center backdrop-blur">
            <div className="text-2xl font-black italic tracking-wider text-white">CHEQUERED FLAG</div>
            <button
              className="pointer-events-auto mt-4 rounded-xl bg-gradient-to-r from-[#e10600] to-[#ff3b30] px-8 py-2.5 text-sm font-black tracking-wider text-white transition hover:scale-105 active:scale-95"
              onClick={onContinue}
            >
              VIEW RESULTS
            </button>
          </div>
        </div>
      )}

      {/* ================= time trial panel ================= */}
      {state.timeTrial && (
        <div className="absolute bottom-3 right-3 rounded-lg border border-white/10 bg-black/70 px-4 py-2 text-right font-mono backdrop-blur-sm">
          <div className="text-[9px] font-sans font-black uppercase tracking-widest text-white/35">Time Trial</div>
          <div className="text-sm font-bold text-emerald-300">{formatMs(state.timeTrial.lapMs)}</div>
          <div className="text-[11px] text-white/50">BEST {formatMs(state.timeTrial.bestLapMs ?? 0)}</div>
          <div className="text-[11px] text-white/50">TOTAL {formatMs(state.timeTrial.totalMs)}</div>
        </div>
      )}

      <style jsx global>{`
        @keyframes bannerIn {
          from { transform: translateY(-10px) scale(0.94); opacity: 0; }
          to { transform: translateY(0) scale(1); opacity: 1; }
        }
      `}</style>
    </div>
  );
}
