'use client';

/**
 * APEX GP — Online multiplayer (PeerJS): nickname → create/join room by code
 * → lobby (pick team, host configures the race) → the host starts and every
 * client launches the same session via race:start.
 */

import { useEffect, useState, type JSX } from 'react';
import { TEAMS, TEAM_MAP } from '@/game/f1/Teams';
import { CIRCUITS } from '@/game/f1/Circuits';
import type { NetClient } from '@/game/net/NetClient';
import type { NetRoomState } from '@/game/net/NetTypes';

const hex = (n: number): string => `#${n.toString(16).padStart(6, '0')}`;

export function OnlineScreen({ net, teamId, driverIdx, onPickTeam, onBack }: {
  net: NetClient;
  teamId: string;
  driverIdx: number;
  onPickTeam: (teamId: string, driverIdx: number) => void;
  onBack: () => void;
}): JSX.Element {
  const [nickname, setNickname] = useState(() => localStorage.getItem('apexNick') ?? '');
  const [room, setRoom] = useState<NetRoomState | null>(net.room);
  const [joinCode, setJoinCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState('');
  const [teamOpen, setTeamOpen] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/immutability -- engine callback subscription
    net.onStatus = (s, err) => {
      setBusy(s === 'connecting');
      if (s === 'error') { setError(err ?? 'Error de red'); setProgress(''); }
    };
    // eslint-disable-next-line react-hooks/immutability -- engine callback subscription
    net.onRoomState = r => { setRoom(r); setProgress(''); };
    // v17: readable connection steps under the buttons
    net.onProgress = step => setProgress(step);
    // v17 PREWARM: open the signaling peer while the user types the nick —
    // the join then reuses it and skips the broker handshake entirely
    net.prewarm();
    return () => {
      net.onStatus = null;
      net.onRoomState = null;
      net.onProgress = null;
    };
  }, [net]);

  const team = TEAM_MAP[teamId] ?? TEAMS[0];
  const driver = team.drivers[driverIdx] ?? team.drivers[0];
  const isHost = !!room && room.hostId === net.myId;

  const ensureName = (): string => {
    const n = nickname.trim().slice(0, 14) || 'Piloto';
    localStorage.setItem('apexNick', n);
    return n;
  };

  const create = async (): Promise<void> => {
    setError('');
    setBusy(true);
    const r = await net.createRoom(ensureName(), teamId, team.color);
    setBusy(false);
    if (r) setRoom(r); else setError(net.lastError || 'Could not create the room');
  };

  const join = async (): Promise<void> => {
    if (joinCode.trim().length < 3) { setError('Enter the room code'); return; }
    setError('');
    setBusy(true);
    const r = await net.joinRoom(joinCode.trim().toUpperCase(), ensureName(), teamId, team.color);
    setBusy(false);
    if (r) setRoom(r); else setError(net.lastError || 'Could not join');
  };

  const leave = (): void => {
    net.leaveRoom();
    setRoom(null);
  };

  // ---------------------------------------------------------------- lobby view
  if (room) {
    const cfg = room.config;
    const humans = room.players.length;
    return (
      <div className="absolute inset-0 overflow-y-auto bg-[linear-gradient(180deg,#0a0b10,#08080c)] text-white">
        <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col px-6 py-6">
          <header className="flex items-center justify-between">
            <button onClick={leave} className="rounded-lg bg-white/10 px-4 py-2 text-sm font-black text-white/80 hover:bg-white/20">← SALIR</button>
            <h1 className="text-xl font-black uppercase italic tracking-widest">ROOM</h1>
            <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-2 font-mono text-lg font-black tracking-[0.3em] text-emerald-300">
              {room.code}
            </div>
          </header>

          {/* players */}
          <section className="mt-5 rounded-2xl border border-white/10 bg-white/[0.03] p-4">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-sm font-black uppercase tracking-widest text-white/50">Parrilla ({humans} humano{humans !== 1 ? 's' : ''})</h2>
              <button
                onClick={() => setTeamOpen(o => !o)}
                className="flex items-center gap-2 rounded-lg border border-white/20 bg-black/40 px-3 py-1.5 text-xs font-black hover:border-white/50"
              >
                <span className="h-3 w-3 rounded-sm" style={{ background: hex(team.color) }} />
                {driver.name}
                <span className="text-white/40">cambiar</span>
              </button>
            </div>
            <div className="flex flex-col gap-1.5">
              {room.players.map(p => {
                const pt = TEAM_MAP[p.teamId];
                const me = p.id === net.myId;
                return (
                  <div key={p.id} className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-bold ${me ? 'bg-white/15' : 'bg-white/[0.04]'}`}>
                    <span className="h-4 w-1.5 rounded-sm" style={{ background: hex(pt?.color ?? p.color) }} />
                    <span>{p.name}{me && <span className="ml-2 rounded bg-white/25 px-1 text-[9px] font-black">YOU</span>}</span>
                    <span className="text-white/40">{pt?.short ?? '—'}</span>
                    {room.hostId === p.id && <span className="ml-auto rounded bg-amber-400/90 px-1.5 text-[9px] font-black text-black">HOST</span>}
                  </div>
                );
              })}
            </div>
            {teamOpen && (
              <div className="mt-3 grid grid-cols-2 gap-1.5 sm:grid-cols-5">
                {TEAMS.map(t => (
                  <button
                    key={t.id}
                    onClick={() => { onPickTeam(t.id, 0); net.updatePlayer({ teamId: t.id, color: t.color }); setTeamOpen(false); }}
                    className={`rounded-lg border px-2 py-1.5 text-left text-[11px] font-black transition ${
                      t.id === teamId ? 'border-white/70 bg-white/10' : 'border-white/10 bg-black/30 hover:border-white/40'
                    }`}
                  >
                    <span className="mr-1.5 inline-block h-2.5 w-1 rounded-sm align-middle" style={{ background: hex(t.color) }} />
                    {t.short}
                  </button>
                ))}
              </div>
            )}
          </section>

          {/* config (host) */}
          <section className="mt-4 rounded-2xl border border-white/10 bg-white/[0.03] p-4">
            <h2 className="text-sm font-black uppercase tracking-widest text-white/50">Race setup</h2>
            {isHost ? (
              <div className="mt-3 flex flex-col gap-4">
                <div>
                  <div className="mb-1.5 text-[10px] font-black uppercase tracking-widest text-white/35">Circuit</div>
                  <div className="flex flex-wrap gap-2">
                    {[...CIRCUITS.map(c => ({ id: c.id, name: c.name })), { id: 'random', name: '🎲 SORPRESA' }].map(c => (
                      <button
                        key={c.id}
                        onClick={() => net.setConfig({ circuitId: c.id })}
                        className={`rounded-lg px-3 py-1.5 text-xs font-black transition ${
                          cfg.circuitId === c.id ? 'bg-[#e10600] text-white' : 'bg-white/10 text-white/60 hover:bg-white/20'
                        }`}
                      >
                        {c.name}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                  <div>
                    <div className="mb-1.5 text-[10px] font-black uppercase tracking-widest text-white/35">Laps</div>
                    <div className="flex gap-1.5">
                      {[3, 5, 8].map(n => (
                        <button key={n} onClick={() => net.setConfig({ laps: n })}
                          className={`h-9 w-10 rounded-lg text-xs font-black transition ${cfg.laps === n ? 'bg-[#e10600]' : 'bg-white/10 text-white/60 hover:bg-white/20'}`}>
                          {n}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <div className="mb-1.5 text-[10px] font-black uppercase tracking-widest text-white/35">Bots CPU</div>
                    <div className="flex gap-1.5">
                      {[-1, 0, 9, 19].map(n => (
                        <button key={n} onClick={() => net.setConfig({ bots: n })}
                          className={`h-9 w-11 rounded-lg text-xs font-black transition ${cfg.bots === n ? 'bg-[#e10600]' : 'bg-white/10 text-white/60 hover:bg-white/20'}`}>
                          {n === -1 ? 'AUTO' : n}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <div className="mb-1.5 text-[10px] font-black uppercase tracking-widest text-white/35">Nivel IA</div>
                    <div className="flex gap-1.5">
                      {(['easy', 'medium', 'hard', 'expert', 'unreal'] as const).map(l => (
                        <button key={l} onClick={() => net.setConfig({ botLevel: l })}
                          className={`h-9 rounded-lg px-2 text-[10px] font-black transition ${
                            cfg.botLevel === l
                              ? l === 'unreal'
                                ? 'bg-gradient-to-r from-[#7a00e0] to-[#e10600]'
                                : 'bg-[#e10600]'
                              : 'bg-white/10 text-white/60 hover:bg-white/20'}`}>
                          {l === 'easy' ? 'EASY' : l === 'medium' ? 'MED' : l === 'hard' ? 'HARD' : l === 'expert' ? 'EXP' : 'UNR'}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
                <button
                  onClick={() => net.startRace()}
                  className="rounded-xl bg-gradient-to-r from-[#e10600] to-[#ff3b30] py-3 text-lg font-black italic tracking-wider shadow-lg transition hover:scale-[1.01] active:scale-95"
                >
                  START RACE!
                </button>
              </div>
            ) : (
              <div className="mt-3 grid grid-cols-3 gap-3 text-center">
                <div className="rounded-lg bg-black/40 p-3">
                  <div className="text-[10px] font-black uppercase tracking-widest text-white/35">Circuit</div>
                  <div className="mt-1 text-sm font-black">
                    {cfg.circuitId === 'random' ? '🎲 SORPRESA' : CIRCUITS.find(c => c.id === cfg.circuitId)?.name ?? cfg.circuitId}
                  </div>
                </div>
                <div className="rounded-lg bg-black/40 p-3">
                  <div className="text-[10px] font-black uppercase tracking-widest text-white/35">Laps</div>
                  <div className="mt-1 text-sm font-black">{cfg.laps}</div>
                </div>
                <div className="rounded-lg bg-black/40 p-3">
                  <div className="text-[10px] font-black uppercase tracking-widest text-white/35">Bots / Level</div>
                  <div className="mt-1 text-sm font-black">{cfg.bots === -1 ? 'AUTO' : cfg.bots} · {cfg.botLevel ?? 'medium'}</div>
                </div>
                <div className="col-span-3 text-center text-[11px] font-bold text-white/35">
                  Waiting for the host to start… (you can still change teams)
                </div>
              </div>
            )}
          </section>

          <div className="mt-4 text-center text-[11px] leading-relaxed text-white/30">
            Direct P2P over WebRTC (PeerJS) — no servers. The grid fills with CPU drivers
            simulated by the host. Room code: share it to play together.
          </div>
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------- join/create view
  return (
    <div className="absolute inset-0 overflow-y-auto bg-[linear-gradient(105deg,rgba(6,7,10,0.97)_0%,rgba(8,9,14,0.9)_45%,rgba(8,9,14,0.4)_100%)] text-white">
      <div className="mx-auto flex min-h-full w-full max-w-lg flex-col justify-center gap-5 px-6 py-10">
        <header className="flex items-center justify-between">
          <button onClick={onBack} className="rounded-lg bg-white/10 px-4 py-2 text-sm font-black text-white/80 hover:bg-white/20">← BACK</button>
          <h1 className="text-xl font-black uppercase italic tracking-widest">MULTIPLAYER</h1>
          <div className="w-[100px]" />
        </header>

        {/* nickname */}
        <section className="rounded-2xl border border-white/10 bg-white/[0.04] p-5">
          <label className="text-[10px] font-black uppercase tracking-widest text-white/40">Tu nombre de piloto</label>
          <input
            value={nickname}
            onChange={e => setNickname(e.target.value.slice(0, 14))}
            placeholder="Ej. A. Senna"
            className="mt-2 w-full rounded-xl border border-white/15 bg-black/50 px-4 py-3 text-lg font-bold italic outline-none transition focus:border-[#e10600]"
          />
          <div className="mt-3 flex items-center gap-3">
            <span className="text-[10px] font-black uppercase tracking-widest text-white/40">Team</span>
            <span className="flex items-center gap-2 rounded-lg bg-black/40 px-3 py-1.5 text-sm font-black">
              <span className="h-4 w-1.5 rounded-sm" style={{ background: hex(team.color) }} />
              {team.short} · {driver.name}
            </span>
            <span className="text-[11px] text-white/35">(change it in the lobby)</span>
          </div>
        </section>

        {/* create */}
        <section className="rounded-2xl border border-white/10 bg-white/[0.04] p-5">
          <h2 className="text-sm font-black uppercase tracking-widest text-white/50">Create room</h2>
          <p className="mt-1 text-xs text-white/40">You will be the host: you configure the race and simulate the CPU bots.</p>
          <button
            onClick={create}
            disabled={busy}
            className="mt-3 w-full rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 py-3 text-base font-black italic tracking-wider text-black shadow-lg transition hover:scale-[1.01] active:scale-95 disabled:opacity-40"
          >
            {busy ? 'CONNECTING…' : 'CREATE PRIVATE ROOM'}
          </button>
        </section>

        {/* join */}
        <section className="rounded-2xl border border-white/10 bg-white/[0.04] p-5">
          <h2 className="text-sm font-black uppercase tracking-widest text-white/50">Join with code</h2>
          <div className="mt-3 flex gap-2">
            <input
              value={joinCode}
              onChange={e => setJoinCode(e.target.value.toUpperCase().slice(0, 6))}
              placeholder="ABCD"
              className="w-full rounded-xl border border-white/15 bg-black/50 px-4 py-3 text-center font-mono text-2xl font-black tracking-[0.4em] outline-none transition focus:border-[#e10600]"
            />
            <button
              onClick={join}
              disabled={busy}
              className="shrink-0 rounded-xl bg-gradient-to-r from-[#e10600] to-[#ff3b30] px-6 text-base font-black italic tracking-wider shadow-lg transition hover:scale-[1.02] active:scale-95 disabled:opacity-40"
            >
              {busy ? '…' : 'ENTRAR'}
            </button>
          </div>
        </section>

        {error && (
          <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-center text-sm font-bold text-rose-300">
            {error}
          </div>
        )}
        {progress && !error && (
          <div className="flex items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-4 py-2.5 text-xs font-bold tracking-wide text-white/60">
            <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-white/30 border-t-[#e10600]" />
            {progress}
          </div>
        )}
      </div>
    </div>
  );
}
