/**
 * VELOCITY GP — Peer-to-peer online rooms (WebRTC via PeerJS).
 *
 * No backend: rooms run HOST-AUTHORITATIVE in the host's browser — the room
 * code IS the host's peer id (`apexgp-<CODE>`). Guests connect straight to
 * it; the host relays race traffic (star topology) and aggregates standings.
 *
 * v17 "READY SET GO" netcode (carried from the kart v10 field-proven stack):
 *  - TURN REMOVED: OpenRelay (openrelay.metered.ca) is discontinued — its
 *    dead servers only delayed ICE. STUN Google x2 + Cloudflare, verified
 *    with real binding. Symmetric-NAT pairs now fail FAST with a clear
 *    message instead of hanging 14 s.
 *  - PREWARM: the signaling peer opens while the user types their nick on
 *    the Online screen — joining reuses the same peer (no broker handshake
 *    on the critical path).
 *  - READY HANDSHAKE: race:start carries startAt=0 ("prepare, hold on the
 *    grid"); every client builds its session (the F1 world build takes
 *    seconds) and reports race:ready; when all connected racers are ready
 *    the host fires race:go with a synchronized startAt — nobody races
 *    alone during somebody else's loading screen.
 *  - onProgress: human-readable connection steps for the UI.
 *  - 5 s heartbeat with ghost-player detection, signaling auto-reconnect,
 *    fail-fast joins.
 */

import Peer, { type DataConnection } from 'peerjs';
import {
  NetEvent, NetKartState, NetPlayerInfo, NetRaceStart, NetResultRow, NetRoomConfig, NetRoomState,
} from './NetTypes';
import { CIRCUITS } from '../f1/Circuits';
import { TEAMS, TEAM_MAP } from '../f1/Teams';

export type NetStatus = 'idle' | 'connecting' | 'connected' | 'error';

const MAX_PLAYERS = 8;            // human slots
const FIELD_SIZE = 20;            // total grid: humans + CPU fill
const RACE_OVER_TIMEOUT_MS = 30000;
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const PING_MS = 5000;               // heartbeat cadence
const HOST_STALE_LOBBY_MS = 25000;  // host drops a silent guest in the lobby
const HOST_STALE_RACE_MS = 35000;   // ...during a race (states flow at 20 Hz)
const GUEST_STALE_MS = 30000;       // guest gives up on a silent host

// Public ICE: Google + Cloudflare STUN. (v17: OpenRelay TURN removed — the
// service is dead and its unreachable servers only added seconds to every
// ICE gathering. Cross-network pairs that need relay now fail fast with a
// clear message; direct connections are unaffected.)
const PEER_OPTS = {
  debug: 0 as const,
  config: {
    iceCandidatePoolSize: 4,
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
    ],
  },
};

interface JoinAck { ok: boolean; error?: string; room?: NetRoomState; youId?: string }

/** Wire message guest -> host */
type GuestMsg =
  | { t: 'room:join'; rid: number; name: string; teamId: string; color: number }
  | { t: 'room:leave' }
  | { t: 'room:update'; patch: { name?: string; teamId?: string; color?: number } }
  | { t: 'room:config'; patch: Partial<NetRoomConfig> }
  | { t: 'room:start' }
  | { t: 'room:lobby' }
  | { t: 'race:ready' }
  | { t: 'state'; st: NetKartState }
  | { t: 'ev'; ev: NetEvent }
  | { t: 'race:finish'; timeMs: number }
  | { t: 'pong' };

/** Wire message host -> guest */
type HostMsg =
  | { t: 'ack'; rid: number; payload: JoinAck }
  | { t: 'room:state'; room: NetRoomState }
  | { t: 'room:kicked'; reason: string }
  | { t: 'race:start'; start: NetRaceStart }
  | { t: 'race:go'; startAt: number }
  | { t: 'race:over'; rows: NetResultRow[] }
  | { t: 'room:lobby' }
  | { t: 'peer:state'; id: string; st: NetKartState }
  | { t: 'bots'; rows: [string, NetKartState][] }   // host CPU fill, batched: 1 msg/tick
  | { t: 'peer:ev'; id: string; ev: NetEvent }
  | { t: 'peer:left'; id: string }
  | { t: 'ping'; ts: number };

// ---------------------------------------------------------------- host model

/** CPU roster: drivers from every team (2 per constructor). */
const BOT_DRIVER_POOL: { teamId: string; name: string }[] = TEAMS.flatMap(t =>
  t.drivers.map(d => ({ teamId: t.id, name: d.name })));

interface HostedRoom {
  code: string;
  hostId: string;
  players: Map<string, { id: string; name: string; teamId: string; color: number }>;
  config: NetRoomConfig;
  phase: 'lobby' | 'racing';
  grid: string[];
  /** full race roster (humans + bots) for results & finish accounting */
  roster: NetPlayerInfo[];
  finish: { id: string; timeMs: number }[];
  firstFinishAt: number;
  lastProgress: Map<string, number>;
  overTimer: ReturnType<typeof setTimeout> | null;
  heartbeat: ReturnType<typeof setInterval> | null;
  lastSeen: Map<string, number>;
  /** v17 ready handshake: guests still building their session */
  awaitingReady: Set<string>;
  hostReady: boolean;
  goTimer: ReturnType<typeof setTimeout> | null;
  goFired: boolean;
}

function validName(name: unknown): string {
  const s = typeof name === 'string' ? name.trim().slice(0, 14) : '';
  return s || 'Piloto';
}
function validTeam(teamId: unknown): string {
  const s = typeof teamId === 'string' ? teamId : '';
  return TEAM_MAP[s] ? s : 'falco';
}
function validColor(color: unknown): number {
  const n = typeof color === 'number' ? color : parseInt(String(color), 10);
  return Number.isFinite(n) ? (n >>> 0) : 0xe03030;
}

// ============================================================================ client

export class NetClient {
  status: NetStatus = 'idle';
  myId = '';
  room: NetRoomState | null = null;
  lastError = '';

  // ---- lifecycle callbacks (lobby UI) --------------------------------------
  onStatus: ((s: NetStatus, err?: string) => void) | null = null;
  onRoomState: ((room: NetRoomState | null) => void) | null = null;
  onKicked: ((reason: string) => void) | null = null;
  onRaceStart: ((start: NetRaceStart) => void) | null = null;
  /** v17: synchronized GO — epoch ms of lights-out for every client */
  onRaceGo: ((startAt: number) => void) | null = null;
  onRaceOver: ((rows: NetResultRow[]) => void) | null = null;
  onLobby: (() => void) | null = null;
  /** v17: human-readable step while connecting ("Buscando la sala…") */
  onProgress: ((step: string) => void) | null = null;

  // ---- in-race relays (engine hooks) ----------------------------------------
  onPeerState: ((id: string, st: NetKartState) => void) | null = null;
  onPeerEvent: ((id: string, ev: NetEvent) => void) | null = null;
  onPeerLeft: ((id: string) => void) | null = null;

  // ---- transport -------------------------------------------------------------
  private peer: Peer | null = null;
  /** guest mode: the single connection to the host */
  private hostConn: DataConnection | null = null;
  /** host mode: connections by player id */
  private conns = new Map<string, DataConnection>();
  /** host mode: the authoritative room */
  private hostRoom: HostedRoom | null = null;
  /** pending request/ack pairs (guest side) */
  private pendingAcks = new Map<number, (a: JoinAck) => void>();
  private ridSeq = 1;
  /** one-shot waiter for 'peer-unavailable' during a join connect */
  private unavailableWaiter: (() => void) | null = null;
  /** guest: last time ANY host message arrived (heartbeat watchdog) */
  private lastHostMsgAt = 0;
  private staleTimer: ReturnType<typeof setInterval> | null = null;
  /** v17: guest signaling peer pre-opened on the Online screen */
  private prewarmPromise: Promise<Peer | null> | null = null;

  // ---------------------------------------------------------------- helpers

  private setStatus(s: NetStatus, err?: string): void {
    this.status = s;
    if (err) this.lastError = err;
    this.onStatus?.(s, err);
  }

  private makeCode(): string {
    let code = '';
    for (let i = 0; i < 4; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    return code;
  }

  private friendlyError(err: Error & { type?: string }): string {
    switch (err.type) {
      case 'browser-incompatible': return 'Tu navegador no soporta WebRTC';
      case 'network': case 'server-error': case 'socket-error': case 'socket-closed':
        return 'Sin conexión con el servicio de salas — revisa tu red e inténtalo de nuevo';
      case 'webrtc': return 'No se pudo abrir la conexión WebRTC';
      default: return err.message || 'Error de red';
    }
  }

  /** Post-open peer errors: route without killing the room. */
  private onPeerError(err: Error & { type?: string }): void {
    switch (err.type) {
      case 'peer-unavailable': {
        const w = this.unavailableWaiter;
        this.unavailableWaiter = null;
        w?.();
        return;
      }
      case 'network': case 'server-error': case 'socket-error': case 'socket-closed': {
        // signaling link hiccup: live data channels survive it; re-register
        if (this.peer && !this.peer.destroyed && this.peer.disconnected) {
          try { this.peer.reconnect(); } catch { /* offline — next event retries */ }
        }
        return;
      }
      default:
        // informational (ICE chatter etc.) — keep the session alive
        break;
    }
  }

  /** Create the Peer object (id = room id for hosts, random for guests). */
  private openPeer(id?: string): Promise<Peer> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const peer = id !== undefined ? new Peer(id, PEER_OPTS) : new Peer(PEER_OPTS);
      const to = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('No se pudo conectar con el servicio de salas (tiempo agotado)'));
        try { peer.destroy(); } catch { /* */ }
      }, 15000);
      peer.on('open', () => {
        if (settled) { try { peer.destroy(); } catch { /* */ } return; }
        settled = true;
        clearTimeout(to);
        this.peer = peer;
        this.myId = peer.id;
        // transparent signaling recovery (data channels stay up meanwhile)
        peer.on('disconnected', () => {
          if (this.peer === peer && !peer.destroyed) {
            try { peer.reconnect(); } catch { /* */ }
          }
        });
        peer.on('error', (err: Error & { type?: string }) => this.onPeerError(err));
        this.setStatus('connected');
        resolve(peer);
      });
      peer.on('error', (err: Error & { type?: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(to);
        reject(new Error(err.type === 'unavailable-id'
          ? 'Ese código ya existe — prueba de nuevo'
          : this.friendlyError(err)));
        try { peer.destroy(); } catch { /* */ }
      });
    });
  }

  /**
   * React-friendly hook installer (same contract as the socket.io version).
   */
  useHooks(hooks: {
    onStatus?: ((s: NetStatus, err?: string) => void) | null;
    onRoomState?: ((room: NetRoomState | null) => void) | null;
    onRaceStart?: ((start: NetRaceStart) => void) | null;
    onRaceGo?: ((startAt: number) => void) | null;
    onLobby?: (() => void) | null;
    onKicked?: ((reason: string) => void) | null;
    onPeerState?: ((id: string, st: NetKartState) => void) | null;
    onPeerEvent?: ((id: string, ev: NetEvent) => void) | null;
    onPeerLeft?: ((id: string) => void) | null;
    onRaceOver?: ((rows: NetResultRow[]) => void) | null;
    onProgress?: ((step: string) => void) | null;
  }): void {
    if (hooks.onStatus !== undefined) this.onStatus = hooks.onStatus;
    if (hooks.onRoomState !== undefined) this.onRoomState = hooks.onRoomState;
    if (hooks.onRaceStart !== undefined) this.onRaceStart = hooks.onRaceStart;
    if (hooks.onRaceGo !== undefined) this.onRaceGo = hooks.onRaceGo;
    if (hooks.onLobby !== undefined) this.onLobby = hooks.onLobby;
    if (hooks.onKicked !== undefined) this.onKicked = hooks.onKicked;
    if (hooks.onPeerState !== undefined) this.onPeerState = hooks.onPeerState;
    if (hooks.onPeerEvent !== undefined) this.onPeerEvent = hooks.onPeerEvent;
    if (hooks.onPeerLeft !== undefined) this.onPeerLeft = hooks.onPeerLeft;
    if (hooks.onRaceOver !== undefined) this.onRaceOver = hooks.onRaceOver;
    if (hooks.onProgress !== undefined) this.onProgress = hooks.onProgress;
  }

  /** v17: open the guest signaling peer NOW (while the user types a nick) so
   *  the later join skips the broker handshake. No-op for hosts/in-room. */
  prewarm(): void {
    if (this.peer || this.hostRoom || this.prewarmPromise || this.status === 'error') return;
    this.onProgress?.('Conectando con el servicio de salas…');
    this.prewarmPromise = this.openPeer().catch(() => {
      // broker hiccup — cleared so the next attempt (join) retries fresh
      this.prewarmPromise = null;
      return null;
    });
  }

  // ================================================================ HOST SIDE

  async createRoom(name: string, teamId: string, color: number): Promise<NetRoomState | null> {
    this.teardown();
    this.setStatus('connecting');
    // retry a couple of codes if one is taken on the broker
    for (let attempt = 0; attempt < 3; attempt++) {
      const code = this.makeCode();
      try {
        this.onProgress?.(attempt === 0
          ? 'Registrando sala en el servicio…'
          : 'Código ocupado, probando otro…');
        const peer = await this.openPeer(`apexgp-${code}`);
        const room: HostedRoom = {
          code,
          hostId: peer.id,
          players: new Map(),
          config: {
            circuitId: 'velocita', laps: 5,
            bots: -1, botLevel: 'medium',
          },
          phase: 'lobby',
          grid: [],
          roster: [],
          finish: [],
          firstFinishAt: 0,
          lastProgress: new Map(),
          overTimer: null,
          heartbeat: null,
          lastSeen: new Map(),
          awaitingReady: new Set(),
          hostReady: false,
          goTimer: null,
          goFired: false,
        };
        room.players.set(peer.id, { id: peer.id, name: validName(name), teamId: validTeam(teamId), color: validColor(color) });
        this.hostRoom = room;
        peer.on('connection', (conn) => this.hostOnConnection(conn));
        // heartbeat: NAT keepalive in the silent lobby + ghost detection
        room.heartbeat = setInterval(() => this.hostHeartbeat(room), PING_MS);
        this.room = this.publicRoom(room);
        this.onRoomState?.(this.room);
        return this.room;
      } catch (e) {
        const err = e as Error;
        this.lastError = err.message;
        if (attempt === 2) {
          this.setStatus('error', err.message);
          return null;
        }
      }
    }
    return null;
  }

  private hostOnConnection(conn: DataConnection): void {
    // wait for the join handshake before admitting the peer
    conn.on('data', (raw: unknown) => {
      const msg = raw as GuestMsg;
      if (!msg || typeof msg !== 'object') return;
      if (msg.t === 'room:join') {
        const room = this.hostRoom;
        if (!room) { conn.close(); return; }
        room.lastSeen.set(conn.peer, Date.now());
        if (room.phase === 'racing') {
          this.hostSend(conn, { t: 'ack', rid: msg.rid, payload: { ok: false, error: 'Carrera en curso' } });
          setTimeout(() => conn.close(), 250);
          return;
        }
        if (room.players.size >= MAX_PLAYERS) {
          this.hostSend(conn, { t: 'ack', rid: msg.rid, payload: { ok: false, error: 'Sala llena' } });
          setTimeout(() => conn.close(), 250);
          return;
        }
        // one connection per player
        if (this.conns.has(conn.peer)) { this.conns.get(conn.peer)!.close(); this.conns.delete(conn.peer); }
        this.conns.set(conn.peer, conn);
        room.players.set(conn.peer, {
          id: conn.peer,
          name: validName(msg.name),
          teamId: validTeam(msg.teamId),
          color: validColor(msg.color),
        });
        this.hostSend(conn, { t: 'ack', rid: msg.rid, payload: { ok: true, room: this.publicRoom(room), youId: conn.peer } });
        this.hostWireGuest(conn, room);
        this.hostBroadcastRoom(room);
        return;
      }
      // any other message before joining is ignored
    });
    conn.on('close', () => this.hostDropPlayer(conn.peer));
    conn.on('error', () => this.hostDropPlayer(conn.peer));
  }

  /** Post-join wiring: route steady-state messages. */
  private hostWireGuest(conn: DataConnection, room: HostedRoom): void {
    conn.on('data', (raw: unknown) => {
      const msg = raw as GuestMsg;
      if (!room || !msg || typeof msg !== 'object') return;
      const pid = conn.peer;
      room.lastSeen.set(pid, Date.now());   // any traffic = alive
      switch (msg.t) {
        case 'room:leave': {
          try { conn.close(); } catch { /* */ }
          this.hostDropPlayer(pid);
          return;
        }
        case 'room:update': {
          const p = room.players.get(pid);
          if (!p) return;
          if (msg.patch?.teamId !== undefined) p.teamId = validTeam(msg.patch.teamId);
          if (msg.patch?.color !== undefined) p.color = validColor(msg.patch.color);
          if (msg.patch?.name !== undefined) p.name = validName(msg.patch.name);
          this.hostBroadcastRoom(room);
          return;
        }
        case 'room:config': {
          if (room.hostId !== pid || room.phase !== 'lobby') return;
          this.hostApplyConfig(room, msg.patch);
          return;
        }
        case 'room:start': {
          if (room.hostId !== pid) return;
          this.hostStartRace(room);
          return;
        }
        case 'room:lobby': {
          if (room.hostId !== pid) return;
          this.hostResetToLobby(room, true);
          return;
        }
        case 'race:ready': {
          // v17 ready handshake: this guest finished building its session
          if (room.phase !== 'racing' || room.goFired) return;
          room.awaitingReady.delete(pid);
          this.hostMaybeFireGo(room);
          return;
        }
        case 'state': {
          if (room.phase !== 'racing') return;
          if (typeof msg.st?.prog === 'number') room.lastProgress.set(pid, msg.st.prog);
          if (msg.st?.f === 1) this.hostMaybeEndRace(room);
          this.hostBroadcast(room, { t: 'peer:state', id: pid, st: msg.st }, pid);
          // host also races: feed its own RemoteDriver
          this.onPeerState?.(pid, msg.st);
          return;
        }
        case 'ev': {
          if (room.phase !== 'racing') return;
          this.hostBroadcast(room, { t: 'peer:ev', id: pid, ev: msg.ev }, pid);
          this.onPeerEvent?.(pid, msg.ev);
          return;
        }
        case 'race:finish': {
          if (room.phase !== 'racing') return;
          if (room.finish.some(f => f.id === pid)) return;
          room.finish.push({ id: pid, timeMs: Math.max(0, Math.round(Number(msg.timeMs) || 0)) });
          if (room.firstFinishAt === 0) room.firstFinishAt = Date.now();
          this.hostMaybeEndRace(room);
          return;
        }
        case 'pong':
          return;   // lastSeen already touched above
      }
    });
  }

  /** Ping everyone; drop peers that went silent (crashed tab / dead network). */
  private hostHeartbeat(room: HostedRoom): void {
    if (this.hostRoom !== room) return;
    const now = Date.now();
    const staleAfter = room.phase === 'racing' ? HOST_STALE_RACE_MS : HOST_STALE_LOBBY_MS;
    for (const [pid, conn] of this.conns) {
      const seen = room.lastSeen.get(pid) ?? now;
      if (now - seen > staleAfter) {
        try { conn.close(); } catch { /* */ }
        this.hostDropPlayer(pid);
        continue;
      }
      this.hostSend(conn, { t: 'ping', ts: now });
    }
  }

  private hostDropPlayer(pid: string): void {
    const room = this.hostRoom;
    if (!room) return;
    const conn = this.conns.get(pid);
    if (conn) { this.conns.delete(pid); }
    room.lastSeen.delete(pid);
    if (!room.players.has(pid)) return;
    room.players.delete(pid);
    room.lastProgress.delete(pid);
    if (room.players.size === 0) {
      // everyone left (incl. us via dispose) — room dies silently
      return;
    }
    if (room.phase === 'racing') {
      this.hostBroadcast(room, { t: 'peer:left', id: pid });
      this.onPeerLeft?.(pid);
      // v17: a dropped racer no longer blocks the synchronized GO
      room.awaitingReady?.delete(pid);
      this.hostMaybeFireGo(room);
      this.hostMaybeEndRace(room);
    }
    this.hostBroadcastRoom(room);
  }

  private hostApplyConfig(room: HostedRoom, patch: Partial<NetRoomConfig>): void {
    if (typeof patch?.circuitId === 'string' && (CIRCUITS.some(c => c.id === patch.circuitId) || patch.circuitId === 'random')) {
      room.config.circuitId = patch.circuitId;
    }
    if (patch?.laps !== undefined) room.config.laps = Math.min(12, Math.max(1, Math.round(Number(patch.laps) || 5)));
    if (patch?.bots !== undefined) {
      const b = Math.round(Number(patch.bots));
      room.config.bots = b === -1 ? -1 : Math.min(19, Math.max(0, b));
    }
    if (patch?.botLevel === 'easy' || patch?.botLevel === 'medium' || patch?.botLevel === 'hard' || patch?.botLevel === 'expert' || patch?.botLevel === 'unreal') {
      room.config.botLevel = patch.botLevel;
    }
    this.hostBroadcastRoom(room);
  }

  private hostStartRace(room: HostedRoom): void {
    if (room.players.size < 1) return;
    room.grid = [...room.players.keys()];
    room.phase = 'racing';
    room.finish = [];
    room.firstFinishAt = 0;
    room.lastProgress.clear();

    // ---- host custom race settings ------------------------------------------
    // Sorpresa: the host picked 'random' → draw a circuit NOW so every client
    // gets the same resolved id in race:start.
    const raceConfig: NetRoomConfig = { ...room.config };
    if (raceConfig.circuitId === 'random') {
      const ids = CIRCUITS.map(c => c.id);
      raceConfig.circuitId = ids[Math.floor(Math.random() * ids.length)];
    }

    // ---- CPU FILL: empty grid slots become F1 drivers --------------------------
    const humans = room.grid.map(id => room.players.get(id)!);
    const autoBots = Math.max(0, FIELD_SIZE - humans.length);
    const wantBots = room.config.bots ?? -1;
    const botCount = wantBots === -1 ? autoBots : Math.min(wantBots, autoBots);
    const humanTeams = new Set(humans.map(h => h.teamId));
    const pool = BOT_DRIVER_POOL.filter(b => !humanTeams.has(b.teamId));
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const bots: NetPlayerInfo[] = [];
    for (let i = 0; i < botCount; i++) {
      const pick = pool.length ? pool[i % pool.length] : BOT_DRIVER_POOL[i % BOT_DRIVER_POOL.length];
      bots.push({
        id: `bot-${i}`,
        name: pick.name,
        teamId: pick.teamId,
        color: TEAM_MAP[pick.teamId]?.color ?? 0x808090,
        bot: true,
      });
    }
    // pole = humans (host first), bots fill the back of the grid
    const grid = [...humans, ...bots];
    room.roster = grid;

    // v17 READY HANDSHAKE: startAt = 0 tells every client "prepare, hold on
    // the grid". Each one builds its session (the F1 world build takes
    // seconds on slow devices) and reports race:ready; when all connected
    // racers are ready the host fires race:go with a synchronized startAt —
    // nobody races alone during other players' loading screens anymore.
    const start: NetRaceStart = { grid, config: raceConfig, startAt: 0 };
    this.hostBroadcast(room, { t: 'race:start', start });
    this.onRaceStart?.(start);          // host builds its session too
    room.awaitingReady = new Set([...room.players.keys()].filter(id => id !== room.hostId));
    room.hostReady = false;
    room.goFired = false;
    if (room.goTimer) clearTimeout(room.goTimer);
    // failsafe: a guest that never reports ready (crashed tab, dead link)
    // must not freeze the race forever
    room.goTimer = setTimeout(() => {
      if (this.hostRoom === room) this.hostFireGo(room);
    }, 22000);
    this.hostBroadcastRoom(room);
  }

  /** v17: every connected racer is ready → synchronized GO for everyone. */
  private hostMaybeFireGo(room: HostedRoom): void {
    if (room.phase !== 'racing' || room.goFired) return;
    if (room.awaitingReady.size > 0 || !room.hostReady) return;
    this.hostFireGo(room);
  }

  private hostFireGo(room: HostedRoom): void {
    if (room.goFired || room.phase !== 'racing') return;
    room.goFired = true;
    if (room.goTimer) { clearTimeout(room.goTimer); room.goTimer = null; }
    const startAt = Date.now() + 4800;   // 5 red lights, then out — everywhere at once
    this.hostBroadcast(room, { t: 'race:go', startAt });
    this.onRaceGo?.(startAt);            // host races too
  }

  private hostMaybeEndRace(room: HostedRoom): void {
    if (room.phase !== 'racing') return;
    // racers this session expects: every roster member still connected
    // (bots never disconnect; dropped humans are removed from `players`)
    const botsAlive = room.roster.filter(r => r.bot).length;
    const humansAlive = room.players.size;
    const activeRacers = humansAlive + botsAlive;
    const allFinished = activeRacers > 0 && room.finish.length >= activeRacers;
    const timedOut = room.firstFinishAt > 0 && Date.now() - room.firstFinishAt > RACE_OVER_TIMEOUT_MS;
    if (!allFinished && !timedOut) return;
    this.hostEndRace(room);
  }

  private hostEndRace(room: HostedRoom): void {
    room.phase = 'lobby';
    if (room.goTimer) { clearTimeout(room.goTimer); room.goTimer = null; }
    const finishers = [...room.finish].sort((a, b) => a.timeMs - b.timeMs);
    const rest = room.roster.map(r => r.id)
      .filter(id => !room.finish.some(f => f.id === id))
      .sort((a, b) => (room.lastProgress.get(b) ?? 0) - (room.lastProgress.get(a) ?? 0));
    const order = [...finishers.map(f => f.id), ...rest];
    const rows: NetResultRow[] = order.map((id, i) => {
      const p = room.roster.find(r => r.id === id);
      const f = room.finish.find(x => x.id === id);
      return {
        id,
        name: p?.name ?? '???',
        teamId: p?.teamId ?? 'falco',
        color: p?.color ?? 0xd40000,
        timeMs: f ? f.timeMs : null,
        pos: i + 1,
      };
    });
    this.hostBroadcast(room, { t: 'race:over', rows });
    this.onRaceOver?.(rows);            // host races too
    this.hostBroadcastRoom(room);
    // safety: everyone back to the lobby even if the host never clicks continue
    if (room.overTimer) clearTimeout(room.overTimer);
    room.overTimer = setTimeout(() => {
      if (this.hostRoom === room) this.hostResetToLobby(room, true);
    }, 25000);
  }

  private hostResetToLobby(room: HostedRoom, notify: boolean): void {
    room.phase = 'lobby';
    if (room.goTimer) { clearTimeout(room.goTimer); room.goTimer = null; }
    room.finish = [];
    room.firstFinishAt = 0;
    room.lastProgress.clear();
    if (room.overTimer) { clearTimeout(room.overTimer); room.overTimer = null; }
    if (notify) {
      this.hostBroadcast(room, { t: 'room:lobby' });
      this.onLobby?.();
    }
    this.hostBroadcastRoom(room);
  }

  private publicRoom(room: HostedRoom): NetRoomState {
    return {
      code: room.code,
      hostId: room.hostId,
      players: [...room.players.values()],
      config: room.config,
      phase: room.phase,
    };
  }

  private hostBroadcastRoom(room: HostedRoom): void {
    const snap = this.publicRoom(room);
    this.room = snap;
    this.onRoomState?.(snap);           // host UI
    for (const c of this.conns.values()) this.hostSend(c, { t: 'room:state', room: snap });
  }

  private hostBroadcast(room: HostedRoom, msg: HostMsg, except?: string): void {
    for (const [pid, c] of this.conns) {
      if (pid === except) continue;
      this.hostSend(c, msg);
    }
  }

  private hostSend(conn: DataConnection, msg: HostMsg): void {
    if (conn.open) { try { conn.send(msg); } catch { /* closing */ } }
  }

  // ================================================================ GUEST SIDE

  async joinRoom(code: string, name: string, teamId: string, color: number): Promise<NetRoomState | null> {
    // v17: reuse the peer prewarmed on the Online screen (the broker
    // handshake ran while the user typed) — protect it from teardown()
    const prewarmed = this.prewarmPromise;
    this.prewarmPromise = null;
    const keep = prewarmed && this.peer && this.peer.open && !this.peer.destroyed && !this.peer.disconnected
      ? this.peer : null;
    if (keep) this.peer = null;
    this.teardown();
    this.setStatus('connecting');
    const roomCode = code.toUpperCase().trim();
    try {
      // tolerate a transient broker hiccup on the signaling connect
      let peer: Peer | null = keep;
      if (peer) {
        this.peer = peer;
        this.myId = peer.id;
        this.setStatus('connected');
      } else {
        for (let attempt = 0; attempt < 2; attempt++) {
          this.onProgress?.(attempt === 0
            ? 'Conectando con el servicio de salas…'
            : 'Reintentando conexión…');
          try { peer = await this.openPeer(); break; }
          catch (e) {
            if (attempt === 1) throw e;
          }
        }
      }
      if (!peer) throw new Error('No se pudo conectar con el servicio de salas');

      this.onProgress?.('Buscando la sala ' + roomCode + '…');
      const conn = peer.connect(`apexgp-${roomCode}`, { reliable: true });
      // fail-fast guards: missing room id, ICE failure, channel death —
      // each rejects in seconds with the RIGHT message instead of a 14 s hang
      await new Promise<void>((resolve, reject) => {
        let done = false;
        const finish = (fn: () => void): void => {
          if (done) return;
          done = true;
          clearTimeout(to);
          this.unavailableWaiter = null;
          fn();
        };
        const to = setTimeout(() => finish(() => reject(new Error('La sala no respondió — ¿código correcto?'))), 14000);
        this.unavailableWaiter = () => finish(() => reject(new Error('Sala no encontrada')));
        conn.on('open', () => finish(resolve));
        conn.on('error', (err: Error & { type?: string }) => {
          // peerjs raises NegotiationFailed when ICE gives up (no direct
          // path) — a very different problem from "wrong code"
          finish(() => reject(new Error(err.type === 'negotiation-failed' || err.type === 'webrtc'
            ? 'No se pudo abrir la conexión P2P — prueba de nuevo o cambia de red'
            : 'No se pudo conectar con la sala')));
        });
        conn.on('close', () => finish(() => reject(new Error('La sala se cerró'))));
      });

      this.hostConn = conn;
      // route messages BEFORE the handshake: the ack arrives on this listener
      conn.on('data', (raw: unknown) => this.guestOnData(raw));
      conn.on('close', () => {
        // host went away — the room dies with them
        if (this.hostConn === conn) {
          this.room = null;
          this.onRoomState?.(null);
          this.onKicked?.('El anfitrión cerró la sala');
          this.setStatus('error', 'El anfitrión cerró la sala');
          this.teardown();
        }
      });

      this.onProgress?.('Entrando en la sala…');
      const ack: JoinAck = await new Promise((resolve) => {
        const rid = this.ridSeq++;
        const to = setTimeout(() => { this.pendingAcks.delete(rid); resolve({ ok: false, error: 'Sin respuesta del anfitrión' }); }, 12000);
        this.pendingAcks.set(rid, (a) => { clearTimeout(to); this.pendingAcks.delete(rid); resolve(a); });
        conn.send({ t: 'room:join', rid, name, teamId, color } satisfies GuestMsg);
      });

      if (!ack.ok || !ack.room) {
        this.lastError = ack.error ?? 'Sala no encontrada';
        this.setStatus('error', this.lastError);
        this.teardown();
        return null;
      }

      this.room = ack.room;
      this.onRoomState?.(ack.room);
      this.startStaleWatch();
      return ack.room;
    } catch (e) {
      const err = e as Error;
      this.lastError = err.message || 'No se pudo conectar';
      this.setStatus('error', this.lastError);
      this.teardown();
      return null;
    }
  }

  /** Guest watchdog: silent host for 30 s (pings + traffic) = room is dead. */
  private startStaleWatch(): void {
    this.stopStaleWatch();
    this.lastHostMsgAt = Date.now();
    this.staleTimer = setInterval(() => {
      if (!this.hostConn || !this.room) return;
      if (!this.hostConn.open || Date.now() - this.lastHostMsgAt > GUEST_STALE_MS) {
        this.room = null;
        this.onRoomState?.(null);
        this.onKicked?.('Lost connection to host');
        this.setStatus('error', 'Lost connection to host');
        this.teardown();
      }
    }, PING_MS);
  }

  private stopStaleWatch(): void {
    if (this.staleTimer) { clearInterval(this.staleTimer); this.staleTimer = null; }
  }

  private guestOnData(raw: unknown): void {
    const msg = raw as HostMsg;
    if (!msg || typeof msg !== 'object') return;
    this.lastHostMsgAt = Date.now();
    switch (msg.t) {
      case 'ack': {
        const res = this.pendingAcks.get(msg.rid);
        if (res) res(msg.payload);
        return;
      }
      case 'room:state':
        this.room = msg.room;
        this.onRoomState?.(msg.room);
        return;
      case 'room:kicked':
        this.room = null;
        this.teardown();
        this.onKicked?.(msg.reason);
        return;
      case 'race:start':
        this.onRaceStart?.(msg.start);
        return;
      case 'race:go':
        // v17: synchronized GO — every client counts down to the same instant
        this.onRaceGo?.(msg.startAt);
        return;
      case 'race:over':
        this.onRaceOver?.(msg.rows);
        return;
      case 'room:lobby':
        this.onLobby?.();
        return;
      case 'peer:state':
        this.onPeerState?.(msg.id, msg.st);
        return;
      case 'bots': {
        // v9: the host streams its whole CPU roster in ONE message per tick
        // (11 separate messages per guest per tick arrived as a burst and
        // jittered the puppets). Same sink as human peer states.
        if (Array.isArray(msg.rows)) {
          for (const r of msg.rows) this.onPeerState?.(r[0], r[1]);
        }
        return;
      }
      case 'peer:ev':
        this.onPeerEvent?.(msg.id, msg.ev);
        return;
      case 'peer:left':
        this.onPeerLeft?.(msg.id);
        return;
      case 'ping':
        this.guestSend({ t: 'pong' });
        return;
    }
  }

  private guestSend(msg: GuestMsg): void {
    if (this.hostConn?.open) { try { this.hostConn.send(msg); } catch { /* closing */ } }
  }

  // ================================================================ PUBLIC API

  leaveRoom(): void {
    // tell everyone we're off, then drop the transport
    if (this.hostRoom) {
      for (const c of this.conns.values()) {
        this.hostSend(c, { t: 'room:kicked', reason: 'Host left' });
      }
      this.conns.clear();
    } else {
      this.guestSend({ t: 'room:leave' });
    }
    this.room = null;
    this.teardown();
    this.setStatus('idle');
  }

  updatePlayer(patch: { teamId?: string; color?: number; name?: string }): void {
    if (this.hostRoom) {
      const p = this.hostRoom.players.get(this.myId);
      if (p) {
        if (patch.teamId !== undefined) p.teamId = validTeam(patch.teamId);
        if (patch.color !== undefined) p.color = validColor(patch.color);
        if (patch.name !== undefined) p.name = validName(patch.name);
        this.hostBroadcastRoom(this.hostRoom);
      }
      return;
    }
    this.guestSend({ t: 'room:update', patch });
  }

  setConfig(patch: Partial<NetRoomConfig>): void {
    if (this.hostRoom) {
      if (this.hostRoom.phase === 'lobby') this.hostApplyConfig(this.hostRoom, patch);
      return;
    }
    this.guestSend({ t: 'room:config', patch });
  }

  startRace(): void {
    if (this.hostRoom) { this.hostStartRace(this.hostRoom); return; }
    this.guestSend({ t: 'room:start' });
  }

  /**
   * v17 READY HANDSHAKE: the local session finished building — the host marks
   * itself ready (fires GO once every guest is ready too); guests tell the
   * host. Call this exactly once per race, after the world is ready.
   */
  raceReady(): void {
    const room = this.hostRoom;
    if (room) {
      if (!room.hostReady) {
        room.hostReady = true;
        this.hostMaybeFireGo(room);
      }
      return;
    }
    this.guestSend({ t: 'race:ready' });
  }

  backToLobby(): void {
    if (this.hostRoom) { this.hostResetToLobby(this.hostRoom, true); return; }
    this.guestSend({ t: 'room:lobby' });
  }

  // ---- in-race traffic ---------------------------------------------------------

  /** Host mode? (the room lives in this browser) */
  get isHost(): boolean { return !!this.hostRoom; }

  sendState(st: NetKartState): void {
    if (this.hostRoom) {
      // host's own kart: relay to guests + run race bookkeeping locally
      const room = this.hostRoom;
      if (room.phase === 'racing') {
        if (typeof st.prog === 'number') room.lastProgress.set(this.myId, st.prog);
        if (st.f === 1) this.hostMaybeEndRace(room);
        this.hostBroadcast(room, { t: 'peer:state', id: this.myId, st });
      }
      return;
    }
    this.guestSend({ t: 'state', st });
  }

  /**
   * HOST: stream every CPU filler's state to every guest in ONE batched
   * message per tick (ids "bot-N") + race bookkeeping for the finish
   * ordering. v9: was one DataChannel message per bot — 11 bursts/tick.
   */
  sendBotStates(rows: Array<[string, NetKartState]>): void {
    const room = this.hostRoom;
    if (!room || room.phase !== 'racing' || !rows.length) return;
    for (const [id, st] of rows) {
      if (typeof st.prog === 'number') room.lastProgress.set(id, st.prog);
      if (st.f === 1) this.hostMaybeEndRace(room);
    }
    this.hostBroadcast(room, { t: 'bots', rows });
  }

  /**
   * HOST: report a finish for a kart this browser is authoritative for
   * (its own driver already uses finishRace; bots come through here).
   */
  finishRaceFor(id: string, timeMs: number): void {
    const room = this.hostRoom;
    if (!room || room.phase !== 'racing') return;
    if (room.finish.some(f => f.id === id)) return;
    room.finish.push({ id, timeMs: Math.max(0, Math.round(timeMs)) });
    if (room.firstFinishAt === 0) room.firstFinishAt = Date.now();
    this.hostMaybeEndRace(room);
  }

  sendEvent(ev: NetEvent): void {
    if (this.hostRoom) {
      if (this.hostRoom.phase === 'racing') {
        this.hostBroadcast(this.hostRoom, { t: 'peer:ev', id: this.myId, ev });
      }
      return;
    }
    this.guestSend({ t: 'ev', ev });
  }

  /**
   * HOST: same as sendEvent but attributes the event to a specific kart
   * (a CPU filler this client simulates). Without this, every bot item
   * spawns from the HOST's kart on the guests — a very visible bug.
   * (No local onPeerEvent: the host sim already ran the item itself.)
   */
  sendEventFor(actorId: string, ev: NetEvent): void {
    const room = this.hostRoom;
    if (!room || room.phase !== 'racing') return;
    this.hostBroadcast(room, { t: 'peer:ev', id: actorId, ev });
  }

  finishRace(timeMs: number): void {
    if (this.hostRoom) {
      const room = this.hostRoom;
      if (room.phase === 'racing' && !room.finish.some(f => f.id === this.myId)) {
        room.finish.push({ id: this.myId, timeMs: Math.max(0, Math.round(timeMs)) });
        if (room.firstFinishAt === 0) room.firstFinishAt = Date.now();
        this.hostMaybeEndRace(room);
      }
      return;
    }
    this.guestSend({ t: 'race:finish', timeMs });
  }

  // ---------------------------------------------------------------- teardown

  private teardown(): void {
    this.stopStaleWatch();
    this.unavailableWaiter = null;
    for (const c of this.conns.values()) { try { c.close(); } catch { /* */ } }
    this.conns.clear();
    if (this.hostRoom?.heartbeat) { clearInterval(this.hostRoom.heartbeat); this.hostRoom.heartbeat = null; }
    if (this.hostRoom?.overTimer) clearTimeout(this.hostRoom.overTimer);
    if (this.hostRoom?.goTimer) clearTimeout(this.hostRoom.goTimer);
    this.hostRoom = null;
    if (this.hostConn) { try { this.hostConn.close(); } catch { /* */ } this.hostConn = null; }
    // v17: an in-flight prewarm must never come back from the dead
    const pw = this.prewarmPromise;
    this.prewarmPromise = null;
    if (pw) pw.then(p => { try { p?.destroy(); } catch { /* */ } }).catch(() => { /* */ });
    if (this.peer) { try { this.peer.destroy(); } catch { /* */ } this.peer = null; }
    this.pendingAcks.clear();
  }

  dispose(): void {
    this.onPeerState = null;
    this.onPeerEvent = null;
    this.onRaceStart = null;
    this.onRaceGo = null;
    this.onRaceOver = null;
    this.onLobby = null;
    this.onRoomState = null;
    this.onKicked = null;
    this.onProgress = null;
    this.teardown();
    this.room = null;
    this.myId = '';
    this.setStatus('idle');
  }
}
