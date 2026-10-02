'use client';

/**
 * APEX GP — React shell: owns the canvas + Game engine instance and the full
 * menu flow (menu → team → circuit → setup → race). Online races are launched
 * by NetClient's race:start hook. In-race: HUD, pause menu, results.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type JSX } from 'react';
import { Game } from '@/game/core/Game';
import { GameBridge } from '@/game/core/GameBridge';
import type { CarSetup, GameMode, SessionConfig, Weather } from '@/game/core/Types';
import { SaveData } from '@/game/persistence/SaveData';

import { MainMenu } from './MainMenu';
import { Intro } from './Intro';
import { TeamSelect } from './TeamSelect';
import { CircuitSelect } from './CircuitSelect';
import { SetupScreen } from './SetupScreen';
import { OptionsPanel } from './OptionsPanel';
import { PauseMenu } from './PauseMenu';
import { ResultsScreen } from './ResultsScreen';
import { HUD } from './HUD';
import { OnlineScreen } from './OnlineScreen';
import { NetClient } from '@/game/net/NetClient';

type MenuScreen = 'menu' | 'team' | 'circuit' | 'setup' | 'online' | 'options';

export default function GameShell(): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const minimapRef = useRef<HTMLCanvasElement>(null);
  const [bridge] = useState(() => new GameBridge());
  const gameRef = useRef<Game | null>(null);
  const [net] = useState(() => new NetClient());
  const [onlineActive, setOnlineActive] = useState(false);
  const [showIntro, setShowIntro] = useState(true);   // F1 motion-graphics intro

  const state = useSyncExternalStore(bridge.subscribe, bridge.getSnapshot);

  // ---- menu flow state --------------------------------------------------
  const [screen, setScreen] = useState<MenuScreen>('menu');
  const [mode, setMode] = useState<GameMode>('gp');
  const [teamId, setTeamId] = useState('falco');
  const [driverIdx, setDriverIdx] = useState(0);
  const [circuitId, setCircuitId] = useState('velocita');
  const [laps, setLaps] = useState(5);
  const [weather, setWeather] = useState<Weather>('clear');
  const [aiLevel, setAiLevel] = useState<SessionConfig['aiLevel']>('medium');
  const [setup, setSetupState] = useState<CarSetup>({ wing: 3, brakeBias: 0.56, compound: 'medium' });
  const [autoGears, setAutoGears] = useState(true);

  const setSetup = (patch: Partial<CarSetup> & { autoGears?: boolean }): void => {
    if (patch.autoGears !== undefined) setAutoGears(patch.autoGears);
    const { autoGears: _ag, ...rest } = patch;
    void _ag;
    setSetupState(s => ({ ...s, ...rest }));
  };

  // ---- engine lifecycle ----------------------------------------------------
  useEffect(() => {
    if (!canvasRef.current) return;
    const game = new Game(canvasRef.current, null, bridge);
    game.net = net;
    gameRef.current = game;
    game.input.setBindings(SaveData.bindings);
    return () => { game.dispose(); gameRef.current = null; };
  }, [bridge, net]);

  // attach the minimap canvas once the race HUD mounts
  useEffect(() => {
    if (state.screen === 'race' && minimapRef.current) {
      gameRef.current?.attachHudCanvases(minimapRef.current);
    }
  }, [state.screen]);

  // showcase car follows the chosen team
  useEffect(() => {
    const t = { falco: [0xd40000, 0xffd400] } as Record<string, [number, number]>;
    void t;
    import('@/game/f1/Teams').then(({ TEAM_MAP }) => {
      const team = TEAM_MAP[teamId];
      if (team) gameRef.current?.setMenuCar(team.color, team.accent);
    }).catch(() => { /* menu showcase is cosmetic */ });
  }, [teamId]);

  // ---- session launcher -------------------------------------------------------
  const startRace = useCallback((over: Partial<SessionConfig>): void => {
    const session: SessionConfig = {
      mode,
      circuitId,
      laps,
      aiCount: mode === 'timetrial' ? 0 : 19,
      aiLevel,
      teamId,
      driverIdx,
      setup,
      fuelLoad: 60,
      autoGears,
      weather,
      ...over,
    };
    gameRef.current?.startSession(session);
  }, [mode, circuitId, laps, aiLevel, teamId, driverIdx, setup, autoGears, weather]);

  // ---- online: room-driven session launch + lobby return ------------------------
  useEffect(() => {
    const onRaceStart = (start: import('@/game/net/NetTypes').NetRaceStart): void => {
      setOnlineActive(true);
      setMode('vs');
      startRace({
        mode: 'vs',
        circuitId: start.config.circuitId,
        laps: start.config.laps,
        aiLevel: start.config.botLevel ?? 'medium',
        aiCount: 0,
        weather: 'clear',
        online: {
          grid: start.grid,
          localId: net.myId,
          startAt: start.startAt,
          isHost: net.isHost,
        },
      });
    };
    const onLobby = (): void => {
      setOnlineActive(false);
      if (bridge.getSnapshot().screen === 'race') {
        gameRef.current?.quitToMenu();
        setScreen('online');
      }
    };
    const onKicked = (): void => {
      setOnlineActive(false);
      if (bridge.getSnapshot().screen === 'race') gameRef.current?.quitToMenu();
      setScreen('menu');
    };
    net.useHooks({ onRaceStart, onLobby, onKicked });
    return () => net.useHooks({ onRaceStart: null, onLobby: null, onKicked: null });
  }, [net, bridge, startRace]);

  useEffect(() => () => net.dispose(), [net]);

  // closing the tab must tear the room down explicitly
  useEffect(() => {
    const bye = (): void => { net.leaveRoom(); };
    window.addEventListener('beforeunload', bye);
    window.addEventListener('pagehide', bye);
    return () => {
      window.removeEventListener('beforeunload', bye);
      window.removeEventListener('pagehide', bye);
    };
  }, [net]);

  // ---- in-race actions -----------------------------------------------------------
  const backToMenu = useCallback((): void => {
    if (onlineActive) {
      setOnlineActive(false);
      net.leaveRoom();
    }
    gameRef.current?.quitToMenu();
    setScreen('menu');
  }, [net, onlineActive]);

  const inRace = state.screen === 'race';

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-black text-white">
      <canvas ref={canvasRef} className="absolute inset-0 block h-full w-full" />

      {/* ------------------------------ F1 intro ------------------------------ */}
      {showIntro && (
        <Intro onDone={() => setShowIntro(false)} />
      )}

      {/* ------------------------------ menus ------------------------------ */}
      {!inRace && (
        <>
          {screen === 'menu' && (
            <MainMenu
              onMode={m => { setMode(m); setScreen('team'); }}
              onOptions={() => setScreen('options')}
              onOnline={() => setScreen('online')}
            />
          )}
          {screen === 'team' && (
            <TeamSelect
              mode={mode}
              teamId={teamId}
              driverIdx={driverIdx}
              onSelect={(t, d) => { setTeamId(t); setDriverIdx(d); }}
              onBack={() => setScreen('menu')}
              onNext={() => {
                if (mode === 'timetrial') setScreen('circuit');
                else setScreen('setup');
              }}
            />
          )}
          {screen === 'setup' && (
            <SetupScreen
              mode={mode}
              setup={setup}
              autoGears={autoGears}
              onChange={setSetup}
              onBack={() => setScreen('team')}
              onNext={() => setScreen('circuit')}
            />
          )}
          {screen === 'circuit' && (
            <CircuitSelect
              circuitId={circuitId}
              laps={laps}
              weather={weather}
              onPick={(id, n) => { setCircuitId(id); setLaps(n); }}
              onWeather={setWeather}
              onBack={() => setScreen(mode === 'timetrial' ? 'team' : 'setup')}
              onNext={() => {
                startRace({});
              }}
            />
          )}
          {screen === 'online' && (
            <OnlineScreen
              net={net}
              teamId={teamId}
              driverIdx={driverIdx}
              onPickTeam={(t, d) => { setTeamId(t); setDriverIdx(d); }}
              onBack={() => setScreen('menu')}
            />
          )}
          {screen === 'options' && (
            <OptionsPanel
              onClose={() => setScreen('menu')}
              onBindingsChanged={b => gameRef.current?.input.setBindings(b)}
            />
          )}
        </>
      )}

      {/* ------------------------------ race UI ------------------------------ */}
      {inRace && (
        <>
          <HUD
            state={state}
            minimapRef={minimapRef}
            onContinue={() => gameRef.current?.forceResults()}
            onPitRequest={c => gameRef.current?.requestPit(c)}
            onPitCancel={() => gameRef.current?.cancelPit()}
            onPitClose={() => gameRef.current?.closePitMenu()}
          />
          {state.paused && !state.results && (
            <PauseMenu
              onResume={() => gameRef.current?.resume()}
              onRestart={onlineActive ? () => gameRef.current?.resume() : () => gameRef.current?.retrySession()}
              onQuit={backToMenu}
            />
          )}
          {state.results && state.needsContinue && (
            <ResultsScreen
              rows={state.results}
              mode={mode}
              online={onlineActive}
              onContinue={() => {
                if (onlineActive) { net.backToLobby(); return; }
                backToMenu();
              }}
              onRetry={() => gameRef.current?.retrySession()}
              onMenu={backToMenu}
            />
          )}
        </>
      )}

      {/* AI difficulty quick-set lives in the circuit screen footer */}
      {!inRace && screen === 'circuit' && (
        <div className="absolute bottom-3 left-6 z-20 flex items-center gap-2">
          <span className="text-[10px] font-black uppercase tracking-widest text-white/30">AI</span>
          {(['easy', 'medium', 'hard', 'expert', 'unreal'] as const).map(l => (
            <button
              key={l}
              onClick={() => setAiLevel(l)}
              className={`rounded-md px-2.5 py-1 text-[11px] font-black transition ${
                aiLevel === l
                  ? l === 'unreal'
                    ? 'bg-gradient-to-r from-[#7a00e0] to-[#e10600] text-white shadow-[0_0_14px_rgba(160,0,255,0.55)]'
                    : 'bg-[#e10600] text-white'
                  : 'bg-black/60 text-white/45 hover:text-white'
              }`}
            >
              {l.toUpperCase()}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
