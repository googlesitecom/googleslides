/**
 * APEX GP — Game orchestrator (Formula 1 simulation).
 *
 * Owns the renderer (ACES + PMREM environment + soft shadows — no bloom,
 * the realism lesson from v9), the fixed-step 120 Hz simulation, the session
 * lifecycle (grand prix / time trial / online), the AI grid, PeerJS online
 * (host-authoritative, 20 Hz batched streams, RemoteDriver puppets) and the
 * HUD publishing. React only talks through the GameBridge.
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';

import type { TireCompound, F1Controls, RaceResultRow, SessionConfig } from './Types';
import { PHYS, VIDEO } from './Config';
import { InputManager } from './InputManager';
import { GameBridge } from './GameBridge';
import { SaveData } from '../persistence/SaveData';
import { F1Car, NEUTRAL_CONTROLS, type F1StepWorld } from '../f1/F1Car';
import { F1Visual } from '../f1/F1Visual';
import { F1Assets } from '../f1/F1Assets';
import { F1CircuitWorld } from '../f1/F1TrackBuilder';
import {
  resolveWeather, makeSkyDomeV2, makeCloudLayer, makeRainSystem,
  type WeatherStyle, type CloudLayer, type RainSystem,
} from '../f1/Weather';
import { CIRCUITS, CIRCUIT_MAP } from '../f1/Circuits';
import { TEAMS, TEAM_MAP, teamAero, teamPower } from '../f1/Teams';
import { F1AIDriver } from '../f1/F1AI';
import { PitSystem, type PitHudState } from '../f1/PitSystem';
import { F1RaceManager } from '../race/F1RaceManager';
import { GhostPlayer, GhostRecorder } from '../race/Ghost';
import { ParticleSystem } from '../fx/ParticleSystem';
import { CameraController } from '../fx/CameraController';
import { clamp } from './MathUtils';
import { AudioSys } from './AudioSystem';
import { NetClient } from '../net/NetClient';
import { RemoteDriver } from '../net/RemoteDriver';
import type { NetKartState, NetResultRow } from '../net/NetTypes';
import { ST_DRS, ST_ERS, ST_LOCK, ST_SPIN } from '../net/NetTypes';

/** Final color grade (runs on the FINAL sRGB image, after tone mapping —
 *  like a broadcast LUT): filmic contrast + saturation + crushed blacks +
 *  subtle teal-shadow/warm-highlight split-tone + vignette. (v25: the speed
 *  blur is RETIRED — see the note in speedBlur.) */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    strength: { value: 0.32 },      // vignette
    saturation: { value: 1.22 },
    contrast: { value: 1.13 },
    lift: { value: 0.0 },
    speedWarp: { value: 0 },         // 0..1 speed blur intensity
  },
  vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float strength;      // vignette
    uniform float saturation;
    uniform float contrast;
    uniform float lift;
    uniform float speedWarp;
    varying vec2 vUv;

    // radial speed blur — RETIRED in v25. Two rounds of tuning (v23 0.06 full
    // periphery, v24 0.024 far periphery) and the verdict was the same both
    // times: at 300+ km/h players read ANY radial smear as "the image went
    // blurry" ("super blur y pixeleado de la nada cuando vas rapido"). The
    // speed sensation now comes from FOV stretch + camera rumble — sharp at
    // every speed. The plumbing stays for QA introspection; speedWarp is
    // pinned to 0 and the early return makes it a no-op.
    vec3 speedBlur(vec2 uv) {
      if (speedWarp < 0.003) return texture2D(tDiffuse, uv).rgb;
      vec2 dir = uv - vec2(0.5);
      float dist = length(dir);
      float amt = speedWarp * 0.024 * smoothstep(0.30, 0.92, dist);
      vec3 sum = vec3(0.0);
      float wsum = 0.0;
      for (int i = 0; i < 6; i++) {
        float t = float(i) / 5.0;
        float w = 1.0 - t * 0.55;
        vec2 off = uv - dir * amt * t;
        // chromatic fringe grows with the blur amount
        float ca = amt * 0.15 * t;
        sum.r += texture2D(tDiffuse, off + dir * ca * 0.15).r * w;
        sum.g += texture2D(tDiffuse, off).g * w;
        sum.b += texture2D(tDiffuse, off - dir * ca * 0.15).b * w;
        wsum += w;
      }
      return sum / wsum;
    }

    void main() {
      vec3 c = speedBlur(vUv);
      // crushed blacks (F1 TV look: shadows go DEEP, not milky)
      c = max(c - 0.012, vec3(0.0));
      // contrast around mid-grey
      c = (c - 0.5) * contrast + 0.5;
      // saturation (luminance-preserving)
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(l), c, saturation);
      // split-tone: cool the shadows toward teal, warm the highlights
      float shade = 1.0 - smoothstep(0.0, 0.55, l);
      float warm = smoothstep(0.45, 1.0, l);
      c.r += warm * 0.012 - shade * 0.008;
      c.b += shade * 0.02 - warm * 0.006;
      c.g += shade * 0.004;
      // vignette
      float d = distance(vUv, vec2(0.5));
      c *= 1.0 - smoothstep(0.42, 0.95, d) * strength;
      gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
    }`,
};

const CAM_NAMES: Record<string, string> = {
  chase: 'CHASE', cockpit: 'COCKPIT', tv: 'TV', nose: 'NOSE',
};

/** Screen-space crepuscular rays (GPU Gems 3 radial march toward the sun,
 *  computed on the HDR buffer BEFORE tone mapping so ACES compresses them
 *  like real light). Occluders (trees, stands, gantry, roof lines) carve the
 *  shafts naturally, and only genuinely bright HDR pixels (sun disc + halo)
 *  feed the accumulation — restrained shafts, "realistic, NOT exaggerated". */
const GodRayShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    sunPos: { value: new THREE.Vector2(0.5, 0.5) },
    intensity: { value: 0.0 },
    sunTint: { value: new THREE.Color(1.0, 0.9, 0.74) },
  },
  vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform vec2 sunPos; uniform float intensity; uniform vec3 sunTint;
    varying vec2 vUv;
    float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
    void main() {
      vec4 base = texture2D(tDiffuse, vUv);
      if (intensity < 0.004) { gl_FragColor = base; return; }
      // march from this pixel toward the sun, accumulating ONLY bright light
      // (v22: 32 steps — same accumulation, cheaper march)
      const int STEPS = 32;
      vec2 delta = (vUv - sunPos) * 0.92 / float(STEPS);
      vec2 coord = vUv;
      float illum = 1.0;
      vec3 acc = vec3(0.0);
      for (int i = 0; i < STEPS; i++) {
        coord -= delta;
        vec3 s = texture2D(tDiffuse, clamp(coord, vec2(0.0), vec2(1.0))).rgb;
        // HDR sun disc / halo feeds the rays; sunlit asphalt does not
        float bright = smoothstep(0.92, 2.6, luma(s));
        acc += s * bright * illum;
        illum *= 0.97;
      }
      acc /= float(STEPS);
      // fade near the screen border (edge-clamp artifacts)
      vec2 e = min(vUv, 1.0 - vUv);
      float edge = smoothstep(0.0, 0.14, min(e.x, e.y));
      gl_FragColor = vec4(base.rgb + acc * sunTint * (intensity * edge * 3.8), base.a);
    }`,
};

export class Game {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private composer: EffectComposer;
  private grade: ShaderPass;
  private godrays: ShaderPass;
  private fxaa: ShaderPass;
  private sun: THREE.DirectionalLight;
  private fill: THREE.DirectionalLight;   // sky-bounce fill, opposite the sun
  private hemi: THREE.HemisphereLight;
  private ambient: THREE.AmbientLight;

  readonly camera: CameraController;
  readonly input = new InputManager();
  readonly bridge: GameBridge;
  private particles = new ParticleSystem();

  private world: F1CircuitWorld | null = null;
  private cars: F1Car[] = [];
  private visuals = new Map<string, F1Visual>();
  private aiDrivers = new Map<string, F1AIDriver>();
  private race: F1RaceManager | null = null;
  private ghostRecorder: GhostRecorder | null = null;
  private ghostPlayer: GhostPlayer | null = null;
  private sky: THREE.Mesh | null = null;
  private weatherStyle: WeatherStyle | null = null;
  private clouds: CloudLayer | null = null;
  private rain: RainSystem | null = null;
  private lastCamPos = new THREE.Vector3();
  private rainCamVel = new THREE.Vector3();
  private nightSpots: THREE.SpotLight[] = [];
  private nightFills: THREE.PointLight[] = [];

  private session: SessionConfig | null = null;
  private phase: 'idle' | 'grid' | 'lights' | 'racing' | 'finished' = 'idle';
  private paused = false;
  private rafId = 0;
  private lastFrame = 0;
  private accumulator = 0;
  private elapsed = 0;

  net: NetClient | null = null;
  qaControls: F1Controls | null = null;
  /** QA/demo: drive the player with the AI racing line (also used by TV cam demos) */
  qaAuto = false;
  private playerAutoDriver: F1AIDriver | null = null;
  /** v17: pit stop coordinator */
  private pits: PitSystem | null = null;
  private remoteDrivers = new Map<string, RemoteDriver>();
  private netNameTags = new Map<string, THREE.Sprite>();
  private netTick = 0;
  private netBotIds = new Set<string>();

  private minimapCtx: CanvasRenderingContext2D | null = null;
  private minimapBounds: { minX: number; minZ: number; scale: number } | null = null;
  private hudPublishAt = 0;
  private towerPublishAt = 0;
  private playerFinishAtMs = 0;
  private resultPublished = false;
  private lastControls = new Map<string, F1Controls>();
  private prevGear = 1;
  private prevLockup = false;

  // menu 3D showcase
  private menuGroup: THREE.Group | null = null;
  private menuVisual: F1Visual | null = null;
  private menuColors: { color: number; accent: number } = { color: 0xd40000, accent: 0xffd400 };
  private startingSession = false;

  // ---- v27 secrets: U+I+O airstrike + K+L+Ñ admin panel ------------------
  /** live airstrike (plane + falling bomb); null = none airborne */
  private strike: AirstrikeState | null = null;
  /** epoch-ms: next allowed airstrike (9 s cooldown) */
  private strikeCooldownUntil = 0;
  /** admin panel toggle states (drives the React panel via the bridge) */
  private admin = { turbo: false, grip: false, noWear: false, slowBots: false, invuln: false };

  private fps = 0;
  private fpsFrames = 0;
  private fpsAt = 0;
  private framesRendered = 0;

  constructor(canvas: HTMLCanvasElement, minimapCanvas: HTMLCanvasElement | null, bridge: GameBridge) {
    this.bridge = bridge;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;   // r186: PCF + radius = soft realistic

    this.camera = new CameraController(canvas.clientWidth / Math.max(1, canvas.clientHeight));
    this.sun = new THREE.DirectionalLight(0xffffff, 3.4);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);             // ULTRA: crisp contact shadows
    const sc = this.sun.shadow.camera as THREE.OrthographicCamera;
    // v21 "shadows on EVERYTHING": ±100 m — the Foro Sol roof, far stand rows
    // and distant tree lines all cast onto the road. 4096/200 m = 20 px/m
    // keeps contact shadows crisp with PCF+radius; far penumbras go soft
    // exactly like real distance shadows.
    sc.left = -100; sc.right = 100; sc.top = 100; sc.bottom = -100; sc.near = 5; sc.far = 520;
    sc.updateProjectionMatrix();
    this.sun.shadow.normalBias = 0.045;
    this.sun.shadow.bias = -0.00028;
    this.sun.shadow.radius = 2.6;             // v21: crisper contact penumbra
    // SKY BOUNCE: a shadowless cool fill from the anti-solar side — lifts the
    // shadowed flanks of cars/walls just like real atmospheric scatter
    this.fill = new THREE.DirectionalLight(0xbcd8ff, 0.55);
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x445533, 1.4);
    this.ambient = new THREE.AmbientLight(0x8899bb, 0.25);
    this.scene.add(this.sun, this.sun.target, this.fill, this.fill.target, this.hemi, this.ambient);

    // POST STACK — clean & photoreal (user request: NO fake bloom — a real
    //  sun with real shadows instead):
    //  MSAA render target → SUN RAYS on the HDR image → ACES tonemap/sRGB
    //  (OutputPass) → BROADCAST GRADE on the final image (contrast,
    //  split-tone, vignette, speed blur) → FXAA. Grading AFTER tone mapping
    //  is what a real TV LUT does; the rays run BEFORE it so they behave like
    //  physical light the camera then compresses.
    //  v22 PERF: the march is 32 steps (was 48) — visually identical radial
    //  accumulation, a third cheaper on the fill rate.
    const msaaRT = new THREE.WebGLRenderTarget(1, 1, {
      samples: 4, type: THREE.HalfFloatType,
    });
    this.composer = new EffectComposer(this.renderer, msaaRT);
    this.composer.addPass(new RenderPass(this.scene, this.camera.camera));
    this.godrays = new ShaderPass(GodRayShader);
    this.godrays.enabled = false;          // enabled per-frame when the sun is in view
    this.composer.addPass(this.godrays);
    const outputPass = new OutputPass();
    this.composer.addPass(outputPass);
    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.grade);
    // FXAA on the final sRGB image: catches the sub-pixel shimmer MSAA misses
    // (thin fence wires, distant kerbs) — the last polish before the screen
    this.fxaa = new ShaderPass(FXAAShader);
    this.composer.addPass(this.fxaa);

    this.scene.add(this.particles.points);

    if (minimapCanvas) this.minimapCtx = minimapCanvas.getContext('2d');
    this.input.attach();

    // hidden-tab keep-alive (host freezes = every guest freezes)
    document.addEventListener('visibilitychange', this.onVisibility);

    AudioSys.init({ music: SaveData.options.musicVolume, sfx: SaveData.options.sfxVolume });
    this.applyQuality();   // graphics locked at ULTRA
    this.buildMenuShowcase(0xd40000, 0xffd400);
    // real F1 assets (GLB car + photo textures) load in the background —
    // when ready, hot-swap the procedural showroom car for the GLB chassis
    // and pre-bake every team livery so session start pays zero texture cost
    F1Assets.load().then(() => {
      for (const t of TEAMS) F1Assets.getLivery(t.color);
      if (this.menuVisual) this.setMenuCar(this.menuColors.color, this.menuColors.accent);
    });
    window.addEventListener('resize', this.onResize);
    this.onResize();
    this.lastFrame = performance.now();
    this.rafId = requestAnimationFrame(this.loop);

    (window as unknown as Record<string, unknown>).__apex = {
      version: 'velocitygp-v30.0',
      game: (): unknown => this,
      scene: (): unknown => this.scene,
      start: (over: Partial<SessionConfig>): void => {
        this.startSession({
          mode: 'gp',
          circuitId: 'velocita',
          laps: 5,
          aiCount: 9,
          aiLevel: 'medium',
          teamId: 'falco',
          driverIdx: 0,
          setup: { wing: 3, brakeBias: 0.56, compound: 'medium' },
          fuelLoad: 60,
          autoGears: true,
          weather: 'clear',
          ...over,
        });
      },
      auto: (on: boolean): boolean => { this.qaAuto = !!on && !!this.session; return this.qaAuto; },
      step: (seconds: number): number => this.qaStep(seconds),
      unfreeze: (): boolean => { this.qaFrozen = false; this.qaClockMs = null; this.accumulator = 0; this.lastFrame = performance.now(); return this.qaFrozen; },
      ctrl: (c: Partial<F1Controls> | null): string => {
        if (c == null) { this.qaControls = null; return 'real-input'; }
        this.qaControls = { ...NEUTRAL_CONTROLS, ...c };
        return 'qa-ctrl';
      },
      tp: (s: number, speed = 40): string => this.qaTeleport(s, speed),
      state: (): unknown => this.qaState(),
      race: (): unknown => this.race,
      /** v17: pit system probe (geometry + per-car states + hud) */
      pits: (): unknown => ({
        available: !!this.pits?.available,
        menuOpen: !!this.pits?.menuOpen,
        hud: this.pits?.hudState('player') ?? null,
        world: this.world?.pit
          ? {
              side: this.world.pit.side,
              wallLat: Math.round(this.world.pit.wallLat * 10) / 10,
              laneLat: Math.round(this.world.pit.laneLat * 10) / 10,
              laneHalf: this.world.pit.laneHalf,
              length: Math.round(this.world.pit.length),
              entryS: Math.round(this.world.pit.entryS * 1000) / 1000,
              exitS: Math.round(this.world.pit.exitS * 1000) / 1000,
              limitDist: Math.round(this.world.pit.limitDist),
              garages: this.world.pit.garageDist.map(d => Math.round(d)),
            }
          : null,
        states: this.pits ? [...this.pits.states.entries()].map(([id, s]) => ({
          id, phase: s.phase, dist: Math.round(s.dist), speed: Math.round(s.speed * 10) / 10,
          garageIdx: s.garageIdx, compound: s.compound,
        })) : [],
      }),
      /** v17: request a player pit stop (QA) */
      pit: (compound = 'medium'): string => {
        const player = this.cars[0];
        if (!player || !this.pits?.available) return 'no-pit-lane';
        this.pits.requestBox(player, compound as 'soft' | 'medium' | 'hard');
        return 'requested';
      },
      cars: (): unknown => this.cars.map(c => ({
        id: c.id, pitting: c.pitting, pos: [Math.round(c.pos.x), Math.round(c.pos.z)],
        s: Math.round(c.progressS * 1000) / 1000, speed: Math.round(c.speed * 10) / 10,
        wear: Math.round(c.tireWear * 100) / 100, lap: this.race?.states.get(c.id)?.lap ?? 0,
      })),
      cams: (): unknown => ({ mode: this.camera.mode }),
      /** QA: position the camera anywhere and freeze it there */
      setCam: (x: number, y: number, z: number, lx: number, ly: number, lz: number): string => {
        this.qaCamOverride = true;
        const cam = this.camera.camera;
        cam.up.set(0, 1, 0);
        cam.position.set(x, y, z);
        cam.lookAt(lx, ly, lz);
        return 'frozen';
      },
      freeCam: (): string => { this.qaCamOverride = false; return 'live'; },
      fps: (): number => this.fps,
      /** v22: perf probe — dynamic resolution state + draw stats */
      perf: (): unknown => ({
        fps: this.fps,
        resScale: Math.round(this.resScale * 1000) / 1000,
        pixelRatio: this.renderer.getPixelRatio(),
        calls: this.renderer.info.render.calls,
        triangles: this.renderer.info.render.triangles,
        geometries: this.renderer.info.memory.geometries,
        shadowHalfRate: this.resScale < 0.85,
      }),
      /** v22: force the dynamic resolution (1 = full) — QA hook */
      setRes: (s: number): number => {
        this.resScale = clamp(s, 0.5, 1);
        this.applyResolution();
        return this.resScale;
      },
      audio: (): Record<string, unknown> => AudioSys.debugState,
      /** v27 QA: trigger the secret airstrike (U+I+O equivalent) */
      strike: (): void => this.triggerAirstrike(),
      /** v27 QA: live airstrike state */
      strikeState: (): unknown => {
        const s = this.strike;
        if (!s) return { airborne: false };
        return {
          airborne: true, released: s.released,
          plane: [Math.round(s.plane.position.x), Math.round(s.plane.position.y), Math.round(s.plane.position.z)],
          bomb: s.bomb ? [Math.round(s.bomb.position.x), Math.round(s.bomb.position.y), Math.round(s.bomb.position.z)] : null,
          aim: [Math.round(s.aim.x), Math.round(s.aim.z)],
          target: s.target ? { id: s.target.id, rank: s.target.rank, damage: Math.round(s.target.damage * 100) / 100 } : null,
        };
      },
      /** v27 QA: admin cheats (panel equivalent) */
      admin: (action: string): unknown => {
        if (action === 'state') {
          return { ...this.admin, open: this.bridge.getSnapshot().admin != null, boostT: Math.round((this.cars[0]?.boostT ?? 0) * 10) / 10 };
        }
        this.adminExec(action);
        return { ...this.admin, open: this.bridge.getSnapshot().admin != null };
      },
      /** v27 QA: per-car damage probe */
      damage: (): unknown => this.cars.map(c => ({
        id: c.id, rank: c.rank, damage: Math.round(c.damage * 100) / 100,
        speed: Math.round(c.speed * 10) / 10, boostT: Math.round(c.boostT * 10) / 10,
      })),
    };
  }

  // ============================================================ lifecycle

  private onResize = (): void => {
    const canvas = this.renderer.domElement;
    const parent = canvas.parentElement;
    this.viewW = parent?.clientWidth ?? window.innerWidth;
    this.viewH = parent?.clientHeight ?? window.innerHeight;
    this.applyResolution();
    this.camera.resize(this.viewW / Math.max(1, this.viewH));
  };

  private viewW = 1;
  private viewH = 1;
  /** v22/v25 DYNAMIC RESOLUTION: fraction of the device pixel ratio actually
   *  rendered (0.80–1.0). The frame-time governor nudges it every ~0.8 s so
   *  weak GPUs drop internal resolution instead of frames. v25: the floor
   *  was 0.55 with 0.10 steps — on the way down the image went "pixeleado de
   *  la nada" (a 10% res drop in one jump is plainly visible at 300 km/h).
   *  Now it never goes below 0.80 and moves in 5% steps: still buys back
   *  frame rate on weak GPUs, but the upscale stays clean. */
  private resScale = 1;
  private perfAccum = 0;
  private perfChecks = 0;
  private perfWarmup = 0;

  /** (Re)apply the current resolution scale to renderer + composer + FXAA. */
  private applyResolution(): void {
    const pr = Math.min(window.devicePixelRatio, 2) * this.resScale;
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(this.viewW, this.viewH, false);
    this.composer.setPixelRatio(pr);
    this.composer.setSize(this.viewW, this.viewH);
    // FXAA only where it earns its keep: on dense screens (DPR ≥ 1.5) the
    // pixel density + MSAA already smooth the image — skip the extra pass
    this.fxaa.enabled = pr < 1.5;
    this.fxaa.uniforms.resolution.value.set(1 / (this.viewW * pr), 1 / (this.viewH * pr));
    // v22 PERF: when the governor has pulled resolution down hard, refresh
    // the 4K shadow map every OTHER frame instead of every frame — car
    // shadows lag one frame (invisible) and the shadow pass costs halves
    this.renderer.shadowMap.autoUpdate = this.resScale >= 0.85;
    if (this.resScale >= 0.85) this.renderer.shadowMap.needsUpdate = true;
  }

  /** v22 frame-time governor: called once per rendered frame with the raw
   *  frame delta. Down-scale after ~6 consecutive slow frames, up-scale
   *  gently when there is headroom (hysteresis: down at <50 fps, up at ≥58).
   *  Never adapts while hidden/paused (the RAF clock lies there). */
  private governPerformance(dtFrame: number): void {
    if (this.paused || this.qaFrozen || document.hidden) return;
    this.perfWarmup += dtFrame;
    if (this.perfWarmup < 2.5) return;           // let the session settle first
    this.perfAccum += dtFrame;
    this.perfChecks++;
    if (this.perfChecks < 48) return;
    const avgDt = this.perfAccum / this.perfChecks;
    this.perfAccum = 0;
    this.perfChecks = 0;
    const fps = 1 / Math.max(1e-4, avgDt);
    // v25: gentle governor — 5% steps, floor 0.80. The old 0.55 floor / 0.10
    // steps produced visible pixelation jumps the moment the frame got heavy
    // at speed ("pixeleado de la nada"). Recovery is only slightly faster
    // than the drop so it never oscillates.
    if (fps < 50 && this.resScale > 0.80) {
      this.resScale = Math.max(0.80, this.resScale - 0.05);
      this.applyResolution();
    } else if (fps >= 58 && this.resScale < 1) {
      this.resScale = Math.min(1, this.resScale + 0.04);
      this.applyResolution();
    }
  }

  applyQuality(_q?: 'low' | 'medium' | 'high'): void {
    // GRAPHICS ARE LOCKED AT ULTRA — the highest tier is always applied:
    // full device pixel ratio (capped 2, scaled by the v22 governor), 4096
    // shadow maps, full decor/crowd.
    void _q;
    this.resScale = 1;
    this.applyResolution();
    this.renderer.shadowMap.enabled = true;
    this.sun.castShadow = true;
  }

  attachHudCanvases(minimap: HTMLCanvasElement): void {
    this.minimapCtx = minimap.getContext('2d');
  }

  // ============================================================ session

  async startSession(cfg: SessionConfig): Promise<void> {
    if (this.startingSession) return;
    this.startingSession = true;
    try {
      // real assets (GLB chassis + photo track textures) — resolves instantly once cached
      await F1Assets.load();
      this.startSessionNow(cfg);
    } finally {
      this.startingSession = false;
    }
  }

  private startSessionNow(cfg: SessionConfig): void {
    this.disposeSession();
    this.hideMenu();
    AudioSys.musicStop(0.5);       // race = engine sounds only, no music
    this.session = cfg;
    this.resultPublished = false;
    this.playerFinishAtMs = 0;
    this.prevGear = 1;
    this.qaFrozen = false;          // fresh session → real-time clock until QA steps
    this.qaClockMs = null;
    // v22: fresh performance governor per session (full res until it proves
    // otherwise — never inherit a low scale from the previous track)
    this.resScale = 1;
    this.perfWarmup = 0;
    this.perfAccum = 0;
    this.perfChecks = 0;
    this.applyResolution();

    const q = VIDEO.quality.high;   // ULTRA locked — full decor + crowd
    const def = CIRCUIT_MAP[cfg.circuitId] ?? CIRCUITS[0];
    this.world = new F1CircuitWorld(def, q.decor, q.crowd, cfg.weather);
    this.scene.add(this.world.group);
    this.minimapBounds = null;

    // ---- environment: weather-layered sky v2, fog, lights, PMREM ----------------
    const wstyle = resolveWeather(this.world.style, cfg.weather);
    this.weatherStyle = wstyle;
    // v21: wind strength drives tree sway / flag waves (clear breeze → gale)
    this.world.windU.uWind.value = wstyle.wind;
    this.scene.fog = new THREE.Fog(wstyle.fog, wstyle.fogNear, wstyle.fogFar);
    this.sky = makeSkyDomeV2(wstyle, cfg.weather);
    this.scene.add(this.sky);
    this.sun.color.setHex(wstyle.sunColor);
    this.sun.intensity = wstyle.sunIntensity;
    // sky-bounce fill per condition: clear = directional cool bounce,
    // overcast = flat wrap, night = faint blue moonlight scatter,
    // v22 sunset = warm golden-hour bounce from the low sun's side
    const rainy = cfg.weather === 'rain' || cfg.weather === 'cloudy';
    this.fill.color.setHex(cfg.weather === 'night' ? 0x33405e
      : cfg.weather === 'sunset' ? 0xffc79b
        : rainy ? 0xaebacc : 0xbcd8ff);
    // v21: clear-sky bounce trimmed (0.55→0.42) — shadows read deeper and the
    // directional sun owns the image (the "ultra realistic" broadcast look)
    this.fill.intensity = cfg.weather === 'night' ? 0.28
      : cfg.weather === 'sunset' ? 0.5
        : rainy ? 0.7 : 0.42;
    this.hemi.color.setHex(wstyle.hemiSky);
    this.hemi.groundColor.setHex(wstyle.hemiGround);
    this.hemi.intensity = wstyle.hemiIntensity;
    this.ambient.intensity = wstyle.ambient;
    this.renderer.toneMappingExposure = wstyle.exposure;
    this.grade.uniforms.strength.value =
      cfg.weather === 'night' ? 0.5 : cfg.weather === 'rain' ? 0.42
        : cfg.weather === 'sunset' ? 0.4 : 0.36;
    this.bakeEnvironment(wstyle, cfg.weather);

    // drifting clouds (all conditions except deep night)
    if (wstyle.clouds > 0) {
      const c = this.world.spline.samples[0].pos;
      this.clouds = makeCloudLayer(wstyle, c.x, c.z);
      this.scene.add(this.clouds.group);
    }
    // rain field + rooster-tail spray (v16: streak quads + ground splashes +
    // spray behind EVERY car + animated wet-road ripples)
    if (cfg.weather === 'rain') {
      this.rain = makeRainSystem();
      this.scene.add(this.rain.group);
      if (this.world.wetRoadMat) this.rain.wetRoads.push(this.world.wetRoadMat);
    }
    // night race: follow spotlights (stadium look on the player)
    if (wstyle.night) this.setupNightRig();

    // ---- cars -----------------------------------------------------------------
    const playerTeam = TEAM_MAP[cfg.teamId] ?? TEAMS[0];
    const playerDriver = playerTeam.drivers[cfg.driverIdx] ?? playerTeam.drivers[0];
    const lapFuel = this.world.spline.length * PHYS.fuelPerMeter * 1.45;
    const fuelKg = cfg.mode === 'timetrial' ? Math.min(20, lapFuel) : Math.max(18, Math.min(105, lapFuel * cfg.laps * 1.04));

    const player = new F1Car({
      id: 'player', isPlayer: true,
      teamId: playerTeam.id, driverName: playerDriver.name, driverNumber: playerDriver.number,
      setup: cfg.setup, fuelKg, autoGears: cfg.autoGears, seed: 1,
    });
    player.assistLevel = 1;
    player.arcade = true;        // ARCADE handling: grip-capped, cannot spin
    this.cars.push(player);
    this.playerAutoDriver = new F1AIDriver(player, cfg.aiLevel, 42);
    // v25: the QA/demo autopilot proxies a GOOD human — machinery back-solved
    // from a 0.97 demand (grip ≈0.95, power ≈0.98) driving the player's
    // guidance line. Training disabled (mCeil = base) so the proxy is stable.
    this.playerAutoDriver.tunePace(0.97);

    if (cfg.online) {
      // online: peer puppets + host-simulated CPU fill
      const isHost = !!cfg.online.isHost;
      let botIdx = 0;
      for (const g of cfg.online.grid) {
        if (g.id === cfg.online.localId) continue;
        const team = TEAM_MAP[g.teamId] ?? TEAMS[botIdx % TEAMS.length];
        const driver = team.drivers[botIdx % 2];
        if (g.bot) {
          if (isHost) {
            const car = new F1Car({
              id: g.id, isPlayer: false, teamId: team.id,
              driverName: g.name || driver.name, driverNumber: driver.number,
              setup: { ...cfg.setup, compound: pickCompound(botIdx, cfg.weather) }, fuelKg, isBot: true, seed: botIdx * 1013 + 7,
            });
            car.autoGears = true;
            // v23 PARITY: bots run the SAME arcade machinery as the player —
            // grip-capped kinematic handling (1.32× gripBoost + aeroLat).
            // The sim (Pacejka) model physically could NOT hold the honest
            // speed profile, which capped every bot ~15-24% under the player.
            car.arcade = true;
            this.cars.push(car);
            // v22: each bot gets one of the 8 personal line VARIANTS — nobody
            // races the player's guidance line anymore
            this.aiDrivers.set(car.id, new F1AIDriver(car, cfg.aiLevel, botIdx * 1013 + 7,
              this.world.aiLines[botIdx % this.world.aiLines.length]));
            // v26: street circuits (Monaco) run corners tighter than anywhere
            // else — a touch more stability assist keeps the sim bots on the
            // road through the R18-35 m flicks without slowing them down.
            if (this.world.def.street) car.assistLevel = 0.78;
            this.netBotIds.add(g.id);
          } else {
            const car = new F1Car({
              id: g.id, isPlayer: false, teamId: team.id,
              driverName: g.name || driver.name, driverNumber: driver.number,
              setup: cfg.setup, fuelKg, isBot: true, seed: botIdx * 1013 + 7,
            });
            car.remoteDriven = true;
            this.cars.push(car);
            this.remoteDrivers.set(g.id, new RemoteDriver(car));
          }
          botIdx++;
        } else {
          const car = new F1Car({
            id: `net-${g.id}`, isPlayer: false, teamId: team.id,
            driverName: g.name, driverNumber: driver.number,
            setup: cfg.setup, fuelKg, seed: botIdx * 31 + 3,
          });
          car.remoteDriven = true;
          this.cars.push(car);
          this.remoteDrivers.set(g.id, new RemoteDriver(car));
        }
      }
    } else {
      // offline grid: drivers from every team except the player's seat
      const pool = TEAMS.flatMap(t =>
        t.drivers.map(d => ({ teamId: t.id, name: d.name, number: d.number }))
          .filter(d => !(t.id === playerTeam.id && d.name === playerDriver.name)));
      // strongest cars first (power+aero) — a believable grid
      pool.sort((a, b) =>
        (teamPower(b.teamId) + teamAero(b.teamId)) - (teamPower(a.teamId) + teamAero(a.teamId)));
      const aiCount = cfg.mode === 'timetrial' ? 0 : Math.min(cfg.aiCount, pool.length);
      for (let i = 0; i < aiCount; i++) {
        const d = pool[i];
        const car = new F1Car({
          id: `ai${i}-${d.teamId}`, isPlayer: false, teamId: d.teamId,
          driverName: d.name, driverNumber: d.number,
          setup: { wing: aiWingFor(def.env), brakeBias: 0.55, compound: pickCompound(i, cfg.weather) },
          fuelKg, isBot: true, seed: (i + 1) * 1013 + 7,
        });
        car.autoGears = true;
        // v23 PARITY: same arcade machinery as the player (see online branch)
        car.arcade = true;
        this.cars.push(car);
        // v22: personal line variant per bot — every driver traces its own
        // trajectory (margin/swing/bias differ), so the field spreads out
        // naturally instead of queueing on one identical line
        this.aiDrivers.set(car.id, new F1AIDriver(car, cfg.aiLevel, (i + 1) * 1013 + 7,
          this.world.aiLines[(i + 1) % this.world.aiLines.length]));
        if (this.world.def.street) car.assistLevel = 0.78;
      }
    }

    // v16 AI PIT STRATEGY: every bot plans its stop lap up front — the stop
    // lands just past half distance (tyre-adjusted, aggression-biased), with
    // a chance of a second stop in longer races. Mid-race compound picks are
    // weather-aware (see PitSystem.aiConsider).
    if (cfg.mode !== 'timetrial') {
      for (const ai of this.aiDrivers.values()) {
        if (cfg.laps <= 3) { ai.planStopLap = -1; ai.planSecondStop = false; continue; }
        const rng = Math.random;
        let stopLap = Math.round(
          0.52 * cfg.laps
          + (ai.car.setup.compound === 'soft' ? -0.6 : 0.8 * (ai.car.setup.compound === 'hard' ? 1 : 0))
          + (rng() - 0.5) * 1.6
          + (0.5 - ai.aggression) * 1.2);
        ai.planStopLap = Math.max(2, Math.min(cfg.laps - 1, stopLap));
        ai.planSecondStop = cfg.laps >= 8 && rng() < 0.22 + 0.18 * ai.aggression;
      }
    }

    // ---- grid placement ------------------------------------------------------------
    const grid = this.world.gridSlots;
    const order = [...this.cars];
    if (cfg.online) {
      const byId = new Map(this.cars.map(c => [c.id, c] as const));
      order.length = 0;
      for (const g of cfg.online!.grid) {
        const car = byId.get(g.id === cfg.online!.localId ? 'player' : (g.bot ? g.id : `net-${g.id}`));
        if (car) order.push(car);
      }
      for (const c of this.cars) if (!order.includes(c)) order.push(c);
    } else {
      // player starts mid-pack — a race, not a parade
      const ai = order.filter(c => !c.isPlayer);
      const mid = Math.max(0, Math.floor(ai.length / 2));
      order.length = 0;
      order.push(...ai.slice(0, mid), player, ...ai.slice(mid));
    }
    order.forEach((car, i) => {
      const slot = grid[i % grid.length];
      car.placeAt(slot.pos.clone().add(new THREE.Vector3(0, 0.06, 0)), slot.yaw);
      car.progressS = slot.s;        // real grid progress (behind the line) for race state init
      car.rank = i + 1;              // grid order = starting order (tower correct pre-race)
      car.lap = 0;
      car.finished = false;
    });

    // weather grip: rain scales every car's friction envelope (AI line already
    // accounts for it via the builder's rainLineMu)
    for (const car of this.cars) car.wetGripScale = this.world.weatherGrip;

    // ---- visuals ----------------------------------------------------------------------
    for (const car of this.cars) {
      const team = TEAM_MAP[car.teamId] ?? TEAMS[0];
      const visual = new F1Visual(team.color, team.accent, car.driverNumber, car.setup.compound);
      this.visuals.set(car.id, visual);
      this.scene.add(visual.group);
    }
    if (cfg.online) {
      for (const g of cfg.online.grid) {
        if (g.id === cfg.online.localId || g.bot) continue;
        this.attachNameTag(`net-${g.id}`, g.name);
      }
    }

    // ---- race flow ----------------------------------------------------------------------
    // v17 READY→GO: online races hold on the grid until every client has
    // built its session and the host fires the synchronized race:go.
    this.race = new F1RaceManager(this.cars, this.world, cfg.laps, undefined, !!cfg.online);
    this.race.onEvent = (e) => this.onRaceEvent(e);
    this.race.onFinish = (car, pos) => this.onCarFinish(car, pos);

    // v17 PIT SYSTEM: pit lane + guided stops (per-circuit adaptive geometry)
    this.pits = new PitSystem(this.world.pit, this.world.spline.length);
    this.pits.attachVisuals(this.world.pitVisuals);

    if (cfg.mode === 'timetrial') {
      this.ghostRecorder = new GhostRecorder(cfg.circuitId, cfg.teamId);
      const ghostData = SaveData.getGhost(cfg.circuitId);
      if (ghostData) {
        const gt = TEAM_MAP[ghostData.teamId] ?? TEAMS[0];
        this.ghostPlayer = new GhostPlayer(ghostData, this.scene, gt.color, gt.accent, 'medium');
      }
    }

    // ---- go! ------------------------------------------------------------------------------
    this.phase = 'grid';
    this.camera.mode = 'chase';
    this.camera.buildTvCams(this.world.spline);
    this.camera.snapBehind(player);

    if (cfg.online && this.net) {
      this.net.onPeerState = (id, st) => { this.remoteDrivers.get(id)?.push(st); };
      this.net.onPeerEvent = (id, ev) => this.handleNetEvent(id, ev);
      this.net.onPeerLeft = (id) => {
        const d = this.remoteDrivers.get(id);
        if (d) d.kart.finished = true;
      };
      this.net.onRaceOver = (rows) => this.onNetRaceOver(rows);
      // v17 READY→GO: the host's synchronized GO releases our grid hold
      this.net.onRaceGo = (startAtEpoch) => {
        this.race?.armStart(performance.now() + Math.max(400, startAtEpoch - Date.now()));
      };
    }

    this.bridge.publish({
      screen: 'race', phase: 'grid', paused: false, lights: 0,
      results: null, needsContinue: false,
      position: player.rank, totalCars: this.cars.length, lap: 0, laps: cfg.laps,
      announcer: [], online: !!cfg.online,
      waitingDrivers: !!cfg.online,
      pit: this.pits?.hudState('player') ?? null,
      timeTrial: cfg.mode === 'timetrial' ? {
        lapMs: 0, bestLapMs: SaveData.getBestLap(cfg.circuitId),
        bestTotalMs: SaveData.getBestRace(cfg.circuitId)?.time ?? null, totalMs: 0,
      } : null,
    });

    // v17 READY→GO: our world is built — tell the host we're ready. When
    // every connected racer has reported (or the 22 s failsafe fires) the
    // host broadcasts the synchronized GO and our grid hold releases.
    if (cfg.online && this.net) this.net.raceReady();
  }

  // ============================================================ main loop

  /** QA fast-forward mode: RAF simulation frozen, qaStep owns a persistent
   *  monotonic clock (each step used to re-anchor to performance.now(), so
   *  timing rules like the 25 s lap guard could never pass mid-fast-forward). */
  qaFrozen = false;
  private qaClockMs: number | null = null;

  private loop = (now: number): void => {
    this.rafId = requestAnimationFrame(this.loop);
    const dtFrame = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    this.fpsFrames++;
    if (now - this.fpsAt > 500) {
      this.fps = Math.round(this.fpsFrames * 1000 / (now - this.fpsAt));
      this.fpsFrames = 0;
      this.fpsAt = now;
    }
    if (this.phase === 'idle' || !this.world) {
      this.updateMenuShowcase(dtFrame);
      this.updateGodRays();
      this.composer.render();
      this.framesRendered++;
      return;
    }

    // v22: frame-time governor (in-session only — the menu never adapts)
    this.governPerformance(dtFrame);

    this.input.poll();
    if (this.input.cameraPressed) {
      this.camera.cycleMode();
      this.bridge.publish({ cameraName: CAM_NAMES[this.camera.mode] ?? this.camera.mode });
    }
    // v17: P toggles the pit-strategy menu (only while racing, not paused)
    if (this.input.pitPressed && this.phase === 'racing' && !this.paused && this.pits?.available) {
      this.pits.menuOpen = !this.pits.menuOpen;
      this.bridge.publish({ pit: this.pits.hudState('player') });
    }
    if (this.input.pausePressed && this.phase !== 'finished' && !this.resultPublished) {
      this.togglePause();
    }
    // v27 SECRET (no UI trace): U+I+O — a jet crosses and bombs the race
    // leader, wrecking the car. If the player is P1, the player eats it.
    if (this.input.airstrikePressed && this.phase === 'racing' && !this.paused) {
      this.triggerAirstrike();
    }
    // v27 SECRET (no UI trace): K+L+Ñ — admin/cheat panel.
    if (this.input.adminPressed && !this.paused) {
      this.toggleAdmin();
    }

    if (!this.paused && !this.qaFrozen) {
      this.accumulator += dtFrame;
      let steps = 0;
      while (this.accumulator >= PHYS.fixedDt && steps < PHYS.maxSubSteps * 2) {
        this.fixedStep(PHYS.fixedDt, now);
        this.accumulator -= PHYS.fixedDt;
        steps++;
      }
      if (steps >= PHYS.maxSubSteps * 2) this.accumulator = 0;
      this.elapsed += dtFrame;
      this.world.update(this.elapsed, dtFrame);
      this.clouds?.update(dtFrame);
      if (this.rain) {
        // camera velocity → wind shear on the streaks; every car → spray
        this.rainCamVel.copy(this.camera.camera.position).sub(this.lastCamPos).divideScalar(Math.max(1e-4, dtFrame));
        this.lastCamPos.copy(this.camera.camera.position);
        this.rain.update(dtFrame, this.camera.camera.position, this.rainCamVel, this.cars);
      }
      this.updateNightRig();
      this.particles.update(dtFrame);
      this.updateVisuals(dtFrame);
      this.updateCamera(dtFrame);
      // sky dome rides the camera: a fixed dome at the origin warps its
      // gradient once the player roams hundreds of metres from s=0 — this
      // keeps the zenith overhead and the haze band glued to the horizon
      if (this.sky) this.sky.position.copy(this.camera.camera.position);
    } else if (this.world) {
      // frozen (QA): keep visuals/camera alive for screenshots
      this.world.update(this.elapsed, 0);
      this.updateVisuals(0);
      this.updateCamera(dtFrame);
      if (this.sky) this.sky.position.copy(this.camera.camera.position);
    }
    this.drawMinimap();
    this.publishHud(now);
    // v25: SPEED WARP RETIRED — the uniform stays 0 forever (the shader
    // early-returns; see GradeShader). Radial blur at 300 km/h read as
    // "blurry" twice, so sharpness wins: speed feel comes from the FOV
    // stretch + rumble only.
    this.updateGodRays();
    this.composer.render();
    this.framesRendered++;
  };

  // ============================================================ v27 secrets

  /**
   * U+I+O — THE AIRSTRIKE (secret, zero UI trace): a strike jet overtakes
   * the field ALONG the racing line and drops one bomb on the current race
   * leader. The hit is brutal: −62% power, −38% grip, +55% drag, fire +
   * black smoke, a blast spin — the wreck only heals in the pits (or via
   * the admin panel). If the player happens to be P1, the player eats it.
   * v30: flight model ported from the parallel-session v29 (spline-accurate
   * aim, along-track approach, fat readable bomb, whistle trail) — merged
   * WITHOUT its announcer banner (the feature must stay secret).
   * Cooldown 9 s.
   */
  private triggerAirstrike(): void {
    if (!this.world || this.phase !== 'racing') return;
    const now = performance.now();
    if (now < this.strikeCooldownUntil || this.strike) return;
    // leader by live race order (rank is maintained by the race manager)
    const field = this.cars.filter(c => !c.pitting && !c.finished);
    const leader = (field.length ? field : this.cars)
      .reduce((a, b) => (a.rank <= b.rank ? a : b));
    if (!leader) return;
    this.strikeCooldownUntil = now + 9000;

    // v30 aim: ALONG THE SPLINE (the car follows the road — a straight-line
    // guess misses on every curve). Plane covers (430 − 105·fallT) + fall.
    const spline = this.world.spline;
    const leadS = ((leader.progressS % 1) + 1) % 1;
    const aimS = ((leadS + (Math.min(75, leader.speed) * 3.1) / spline.length) % 1 + 1) % 1;
    const aimPt = spline.roadPoint(aimS, 0);
    const aim = new THREE.Vector3(aimPt.x, Math.max(0.35, aimPt.y), aimPt.z);
    // flight line: overtake along the track, same direction, +closure —
    // the bomb releases ALIGNED with the car's line
    const tan = spline.sampleAt(aimS).tangent;
    const dir = new THREE.Vector3(tan.x, 0, tan.z).normalize();

    const plane = buildStrikeJet();
    plane.position.copy(aim).addScaledVector(dir, -430);
    plane.position.y = 92;
    this.scene.add(plane);

    this.strike = {
      plane, dir, speed: 105, tFall: Math.sqrt((2 * 92) / 24), aim, target: leader,
      bomb: null, bombVel: new THREE.Vector3(),
      released: false, trailT: 0,
      light: null, boomT: 0,
    };
  }

  /** advance plane flight, bomb ballistics (leader-chasing) and detonation */
  private updateAirstrike(dt: number): void {
    const s = this.strike;
    if (!s) return;

    // the bomb chases the CURRENT leader — if the lead changes mid-flight
    // the weapon follows the new P1 ("bombardea al primer lugar", live)
    const field = this.cars.filter(c => !c.pitting && !c.finished);
    if (field.length) {
      s.target = field.reduce((a, b) => (a.rank <= b.rank ? a : b));
    }

    // ---- jet: straight line over the racing line, engine shimmer trail ----
    s.plane.position.addScaledVector(s.dir, s.speed * dt);
    s.plane.rotation.y = Math.atan2(s.dir.x, s.dir.z);
    s.trailT -= dt;
    if (s.trailT <= 0) {
      s.trailT = 0.09;
      const tail = s.plane.position.clone().addScaledVector(s.dir, -8);
      this.particles.damageSmoke(tail);   // soft gray contrail puff, rising
    }

    // ---- release gate: exact ballistic lead along the flight line ----
    if (!s.released) {
      // refresh the aim from the leader's LIVE position on the spline (the
      // launch-time guess drifts when the leader brakes or fights)
      const tgt = s.target;
      if (tgt && !tgt.finished && this.world) {
        const fallT2 = Math.sqrt((2 * Math.max(6, s.plane.position.y)) / 24);
        const sNow = ((tgt.progressS % 1) + 1) % 1;
        const aimS2 = ((sNow + (Math.min(75, tgt.speed) * (fallT2 + 0.22)) / this.world.spline.length) % 1 + 1) % 1;
        const p2 = this.world.spline.roadPoint(aimS2, 0);
        s.aim.set(p2.x, Math.max(0.35, p2.y), p2.z);
      }
      const toAim = s.aim.clone().sub(s.plane.position);
      toAim.y = 0;
      const fallT = Math.sqrt((2 * Math.max(6, s.plane.position.y)) / 24);
      if (toAim.dot(s.dir) <= 0 || toAim.length() <= s.speed * fallT * 0.98) {
        s.released = true;
        s.bomb = buildStrikeBomb();
        s.bomb.position.copy(s.plane.position);
        this.scene.add(s.bomb);
        s.bombVel.copy(s.dir).multiplyScalar(s.speed * 0.985);
      }
    } else if (s.bomb) {
      // terminal guidance: steer toward the leader's LIVE position (~1.2 m/s
      // per s of course change — lands the drama where the car really is)
      const tgt = s.target;
      if (tgt && !tgt.finished) {
        const toT = tgt.pos.clone().sub(s.bomb.position);
        toT.y = 0;
        const hSpeed = Math.hypot(s.bombVel.x, s.bombVel.z);
        if (toT.length() > 8 && hSpeed > 1) {
          const cur = new THREE.Vector3(s.bombVel.x, 0, s.bombVel.z);
          const desired = toT.normalize().multiplyScalar(hSpeed);
          const maxTurn = 1.2 * dt;
          const delta = desired.sub(cur);
          if (delta.length() > maxTurn * hSpeed) delta.setLength(maxTurn * hSpeed);
          s.bombVel.x += delta.x;
          s.bombVel.z += delta.z;
        }
      }
      s.bombVel.y -= 24 * dt;               // game gravity — snappy fall
      s.bomb.position.addScaledVector(s.bombVel, dt);
      s.bomb.lookAt(s.bomb.position.clone().add(s.bombVel));
      // whistle smoke trail — makes the fall readable from any camera
      if (Math.random() < 0.75) this.particles.damageSmoke(s.bomb.position);
      if (s.bomb.position.y <= 0.5) {
        this.detonate(s.bomb.position.clone().setY(Math.max(0.4, s.aim.y)), s.target);
        this.scene.remove(s.bomb);
        disposeGroup(s.bomb);
        s.bomb = null;
      }
    }

    // ---- explosion flash light ----
    if (s.light) {
      s.boomT -= dt;
      s.light.intensity = Math.max(0, s.boomT / 0.6) * 900;
      if (s.boomT <= 0) {
        this.scene.remove(s.light);
        s.light.dispose();
        s.light = null;
      }
    }

    // ---- cleanup: jet 600 m past the aim, nothing left in the air ----
    const past = s.plane.position.clone().sub(s.aim).setY(0).dot(s.dir);
    if (past > 600 && !s.bomb && !s.light) this.clearAirstrike();
  }

  private clearAirstrike(): void {
    const s = this.strike;
    if (!s) return;
    this.scene.remove(s.plane);
    disposeGroup(s.plane);
    if (s.bomb) { this.scene.remove(s.bomb); disposeGroup(s.bomb); }
    if (s.light) { this.scene.remove(s.light); s.light.dispose(); }
    this.strike = null;
  }

  /** the bomb landed: FX + severe damage to the leader, splash damage nearby */
  private detonate(pos: THREE.Vector3, target: F1Car | null): void {
    this.particles.bombBurst(pos);
    AudioSys.playImpact(1.5);

    // orange flash light on the ground
    const light = new THREE.PointLight(0xffa040, 900, 240, 1.8);
    light.position.copy(pos).add(new THREE.Vector3(0, 7, 0));
    this.scene.add(light);
    if (this.strike) { this.strike.light = light; this.strike.boomT = 0.6; }

    // damage: the current P1 (or the chased target) gets the full wreck +
    // blast spin; anyone within 22 m of the blast eats splash damage
    const field = this.cars.filter(c => !c.pitting && !c.finished);
    const leader = target ?? (field.length ? field : this.cars)
      .reduce((a, b) => (a.rank <= b.rank ? a : b));
    for (const car of this.cars) {
      if (car.pitting) continue;
      const d = car.pos.distanceTo(pos);
      const isLeader = car === leader;
      const before = car.damage;
      if (isLeader) car.applyDamage(0.85);
      else if (d < 22) car.applyDamage(0.15 + 0.5 * (1 - d / 22));
      if (car.damage > before) {
        // blast flings the car + a shower of debris from the bodywork
        const away = car.pos.clone().sub(pos).setY(0);
        if (away.lengthSq() < 0.04) away.set(1, 0, 0);
        away.normalize().multiplyScalar(isLeader ? 10 : 6 * (1 - d / 24));
        applyWorldImpulse(car, away.x, away.z);
        car.spinOut(isLeader ? 0.9 : 0.65);
        this.particles.sparkBurst(car.pos.clone().add(new THREE.Vector3(0, 0.5, 0)), 1.7);
      }
    }
    // camera shake for anyone close (the player feels it)
    const player = this.cars[0];
    const dp = player ? player.pos.distanceTo(pos) : 999;
    if (dp < 150) this.camera.kick(clamp(1.25 - dp / 150, 0.2, 1.15));
  }

  // ---- v27 admin panel (K+L+Ñ) --------------------------------------------------

  private toggleAdmin(): void {
    if (this.phase === 'idle') return;
    const open = !(this.bridge.getSnapshot().admin != null);
    this.publishAdmin(open);
  }

  private publishAdmin(open: boolean): void {
    this.bridge.publish({
      admin: open ? { ...this.admin, online: !!this.session?.online } : null,
    });
  }

  /** the React panel calls this with a cheat id */
  adminExec(action: string): void {
    const player = this.cars[0];
    switch (action) {
      case 'boost':
        if (player) { player.boostT = 3.0; this.particles.trickBurst(player.pos); }
        break;
      case 'turbo':
        this.admin.turbo = !this.admin.turbo;
        if (player) player.cheatTurbo = this.admin.turbo;
        break;
      case 'grip':
        this.admin.grip = !this.admin.grip;
        if (player) player.paceMul = this.admin.grip ? 1.45 : 1;
        break;
      case 'nowear':
        this.admin.noWear = !this.admin.noWear;
        if (player) player.cheatNoWear = this.admin.noWear;
        break;
      case 'invuln':
        this.admin.invuln = !this.admin.invuln;
        if (player) player.invulnerable = this.admin.invuln;
        break;
      case 'slowbots':
        this.admin.slowBots = !this.admin.slowBots;
        F1AIDriver.cheatDemand = this.admin.slowBots ? 0.62 : 1;
        break;
      case 'repair':
        for (const c of this.cars) c.repair();
        if (player) this.particles.puff(player.pos, [0.6, 1.0, 0.7]);
        break;
      case 'spinbots':
        for (const c of this.cars) {
          if (!c.isPlayer && !c.remoteDriven) c.spinOut(1.25);
        }
        break;
      case 'win':
        this.adminWinRace();
        break;
      case 'close':
        this.publishAdmin(false);
        return;
    }
    this.publishAdmin(true);
  }

  /** force the classification: the player wins here and now (offline only) */
  private adminWinRace(): void {
    if (this.session?.online) return;              // server owns standings
    if (!this.race || this.resultPublished || this.phase === 'idle') return;
    const nowMs = performance.now();
    for (const car of this.cars) {
      const st = this.race.states.get(car.id);
      if (!st) continue;
      car.finished = true;
      if (car.isPlayer) st.finishMs = nowMs - 40;  // first across the line
    }
    this.playerFinishAtMs = nowMs;
    this.finishRace();
  }

  // ============================================================ sun rays

  private sunWorld = new THREE.Vector3();
  private sunProj = new THREE.Vector3();
  private camDir = new THREE.Vector3();

  /** Drive the crepuscular-ray pass: screen position of the sun + a restrained
   *  intensity curve (fades as the sun leaves frame, scaled by weather —
   *  strong under a clear sky, a whisper under overcast, moon-glow at night). */
  private updateGodRays(): void {
    const u = this.godrays.uniforms;
    const style = this.weatherStyle;
    const weather = this.session?.weather;
    if (!style || !weather) { this.godrays.enabled = false; return; }
    const cam = this.camera.camera;
    const dir = this.sunWorld.set(style.sunDir[0], style.sunDir[1], style.sunDir[2]).normalize();
    cam.getWorldDirection(this.camDir);
    if (this.camDir.dot(dir) < 0.12) { this.godrays.enabled = false; return; }  // sun behind/side
    this.sunProj.copy(cam.position).addScaledVector(dir, 2400).project(cam);
    const r = Math.hypot(this.sunProj.x, this.sunProj.y);
    // in-frame = full strength; fades to nothing once well outside the frame
    const frame = Math.max(0, Math.min(1, (1.75 - r) / 0.7));
    if (frame <= 0.01) { this.godrays.enabled = false; return; }
    const base = weather === 'clear' ? 0.6 : weather === 'night' ? 0.17
      : weather === 'cloudy' ? 0.12 : weather === 'sunset' ? 0.55 : 0.06;
    (u.sunPos.value as THREE.Vector2).set((this.sunProj.x + 1) / 2, (this.sunProj.y + 1) / 2);
    u.intensity.value = base * frame;
    this.godrays.enabled = true;
  }

  private get stepWorld(): F1StepWorld {
    return this.world as unknown as F1StepWorld;
  }

  private hiddenTimer: ReturnType<typeof setInterval> | null = null;
  private lastHiddenTick = 0;
  private onVisibility = (): void => {
    if (typeof document === 'undefined') return;
    if (document.hidden) {
      AudioSys.engineOff();
      if (this.phase === 'idle' || this.paused || this.qaFrozen || this.hiddenTimer) return;
      this.lastHiddenTick = performance.now();
      this.hiddenTimer = setInterval(() => {
        const now = performance.now();
        const dt = Math.min(0.25, (now - this.lastHiddenTick) / 1000);
        this.lastHiddenTick = now;
        if (this.paused || this.phase === 'idle' || !this.world) return;
        this.accumulator += dt;
        let steps = 0;
        while (this.accumulator >= PHYS.fixedDt && steps < 16) {
          this.fixedStep(PHYS.fixedDt, now);
          this.accumulator -= PHYS.fixedDt;
          steps++;
        }
        this.elapsed += dt;
      }, 33);
    } else if (this.hiddenTimer) {
      clearInterval(this.hiddenTimer);
      this.hiddenTimer = null;
      this.lastFrame = performance.now();
    }
  };

  // ============================================================ simulation

  private fixedStep(dt: number, nowMs: number): void {
    const player = this.cars[0];
    const cfg = this.session!;
    this.race?.update(dt, nowMs);
    this.updateAirstrike(dt);

    // v17 PIT SYSTEM: advance guided stops before anything else — pitting
    // cars are posed here and skipped by physics/AI/respawn below
    if (this.pits && this.world) {
      const lapFuel = this.world.spline.length * PHYS.fuelPerMeter * 1.45;
      this.pits.update(dt, this.cars, {
        lapsTotal: cfg.laps,
        lapFuelKg: lapFuel,
        lapOf: (car) => this.race?.states.get(car.id)?.lap ?? 0,
        onAnnounce: (text, tone) => { if (text) this.bridge.pushAnnouncer(text, tone); },
      });
    }

    // phase sync (grid → lights → racing → finished)
    if (this.race) {
      const rp = this.race.phase;
      if (rp !== 'finished' && this.phase !== 'finished') this.phase = rp as typeof this.phase;
      if (rp === 'finished' && !this.resultPublished) this.finishRace();
    }
    const racing = this.phase === 'racing';

    // pre-step positions — input for the collision CCD sweep (anti-tunneling)
    for (const car of this.cars) this.prevPos.set(car.id, { x: car.pos.x, z: car.pos.z });

    // AI shared context (also drives the QA autopilot player)
    const totalM = new Map<string, number>();
    for (const c of this.cars) totalM.set(c.id, this.race?.states.get(c.id)?.totalM ?? c.progressS * (this.world?.spline.length ?? 1));
    const aiCtx = this.world ? {
      spline: this.world.spline,
      line: this.world.racingLine,
      cars: this.cars,
      totalM,
      level: cfg.aiLevel,
      racing,
      time: this.elapsed,
    } : null;

    for (const car of this.cars) {
      if (car.remoteDriven) continue;   // puppet — posed by RemoteDriver below

      // v17: a pitting car is under guided kinematic control — no physics,
      // no AI, no respawn. The PitSystem poses it every frame.
      if (car.pitting && this.pits) continue;

      // v17/v18: AI pit strategy — planned stop lap (v16) or worn tyres /
      // thin fuel; compound picks are weather-aware
      if (racing && !car.isPlayer && !car.finished) {
        const st = this.race?.states.get(car.id);
        if (st) this.pits?.aiConsider(car, st.lap, cfg.laps, this.aiDrivers.get(car.id) ?? undefined);
      }

      let controls: F1Controls;
      if (car.isPlayer) {
        if (this.qaAuto && racing && !car.finished && aiCtx && this.playerAutoDriver) {
          // v23: the autopilot drives the ARCADE car like the human does —
          // the old sim switch left it physically unable to hold the new
          // honest profile (it understeered wide everywhere).
          car.arcade = true;
          car.assistLevel = 1;
          controls = this.playerAutoDriver.update(dt, aiCtx);
        } else {
          if (!car.arcade) car.arcade = true;   // the human drives ARCADE
          controls = this.qaControls ?? this.input.readControls();
          if (car.finished) {
            // cool-down lap at cruise pace
            controls = { ...controls, throttle: 0.35, brake: 0, drs: false, lookBack: controls.lookBack };
          }
        }
      } else {
        const driver = this.aiDrivers.get(car.id);
        if (!driver || !racing || car.finished) {
          if (car.finished && this.world) {
            // finished AI cruise slowly to a stop off-line
            const look = this.world.spline.roadPoint((car.progressS + 10 / this.world.spline.length) % 1, 0);
            const desired = Math.atan2(look.x - car.pos.x, look.z - car.pos.z);
            let dy = desired - car.yaw;
            while (dy > Math.PI) dy -= Math.PI * 2;
            while (dy < -Math.PI) dy += Math.PI * 2;
            controls = { ...NEUTRAL_CONTROLS, throttle: car.speed > 14 ? 0 : 0.25, brake: car.speed > 16 ? 0.6 : 0, steer: clamp(-dy * 2, -1, 1) };
          } else {
            controls = NEUTRAL_CONTROLS;
          }
        } else if (aiCtx) {
          controls = driver.update(dt, aiCtx);
        } else {
          controls = NEUTRAL_CONTROLS;
        }
      }

      // DRS open request (braking closes it inside the physics)
      if (controls.drs && car.drsEligible && !car.drsOpen && car.speed > 30) car.drsOpen = true;

      this.lastControls.set(car.id, controls);
      car.step(dt, this.stepWorld, this.cars, controls, racing || car.finished);

      // stuck off-track recovery (beached cars rejoin at the centerline)
      if (car.requestRespawn && this.world) {
        const s = ((car.progressS % 1) + 1) % 1;
        const sm = this.world.spline.sampleAt(s);
        car.placeAt(this.world.spline.roadPoint(s, 0), Math.atan2(sm.tangent.x, sm.tangent.z));
        car.requestRespawn = false;
      }
    }

    // online: advance puppets BEFORE collisions so contacts see the fresh pose
    if (cfg.online) {
      for (const d of this.remoteDrivers.values()) d.update(nowMs, dt);
    }

    // slipstream + dirty air for locally-simulated cars
    this.aeroContext();

    // CAR-CAR CONTACT IS OFF (player request): the player ghosts through the
    // field arcade-style. But the AI racecraft was tuned WITH physical
    // separation — without anything, packs merge into single points and
    // mutually block each other's obstacle logic (the alpino hairpin jam).
    // Fix: a gentle AI-only repulsion — pure position nudge, no impulses,
    // no spins. The player is never touched; online puppets are posed by
    // their owners and also never touched.
    this.softSeparation();

    // online: stream own state
    if (cfg.online) {
      this.netTick++;
      if (this.net && this.netTick % 3 === 0) {
        this.net.sendState(this.buildNetState(player, nowMs));
      }
      if (this.net && cfg.online.isHost && this.netBotIds.size && this.netTick % 3 === 1) {
        const rows: Array<[string, NetKartState]> = [];
        for (const id of this.netBotIds) {
          const k = this.cars.find(x => x.id === id);
          if (k) rows.push([id, this.buildNetState(k, nowMs)]);
        }
        if (rows.length) this.net.sendBotStates(rows);
      }
    }

    // ghost record / replay
    if (racing && !player.finished && this.ghostRecorder) {
      this.ghostRecorder.record(dt, player.pos, player.yaw);
    }
    if (this.ghostPlayer && this.race) {
      this.ghostPlayer.update(Math.max(0, (nowMs - this.race.goAtMs) / 1000), this.elapsed);
    }

    // results timeout after the player finishes
    if (this.playerFinishAtMs > 0 && nowMs - this.playerFinishAtMs > 9000 && !this.resultPublished) {
      this.finishRace();
    }
  }

  /** Slipstream tow + dirty air for every locally simulated car.
   *  v22 PERF: no per-frame allocations — the old car.forward() call churned
   *  a Vector3 per car per frame at 120 Hz for the whole field. */
  private aeroContext(): void {
    for (const car of this.cars) {
      if (car.remoteDriven) { car.slipstreamCut = 0; car.dirtyAir = 0; continue; }
      car.slipstreamCut = 0;
      car.dirtyAir = 0;
      const fx = Math.sin(car.yaw), fz = Math.cos(car.yaw);
      for (const other of this.cars) {
        if (other === car || other.finished) continue;
        const dx = other.pos.x - car.pos.x;
        const dz = other.pos.z - car.pos.z;
        const d = Math.hypot(dx, dz);
        if (d > PHYS.slipstreamRange || d < 2) continue;
        const dot = (dx * fx + dz * fz) / d;
        if (dot > PHYS.slipstreamCone && Math.abs(other.vLong) > 12) {
          const t = 1 - d / PHYS.slipstreamRange;
          car.slipstreamCut = Math.max(car.slipstreamCut, PHYS.slipstreamDragCut[0] * Math.pow(t, 0.7));
          if (d < 12) car.dirtyAir = Math.max(car.dirtyAir, PHYS.dirtyAirLose * (1 - d / 12));
        }
      }
    }
  }

  /** previous-step positions — CCD sweep input for car-car collisions */
  private prevPos = new Map<string, { x: number; z: number }>();

  /**
   * Car-car contact: 2D oriented boxes (SAT) — one 5.4×2.0 m rectangle per
   * car, exactly the visual footprint. The old 4-circle probe only registered
   * contact within 0.85 m of the circle centres — half the true range, with
   * geometric holes between the circles — so at speed you threaded straight
   * through cars. SAT gives the true contact normal + depth; a midpoint sweep
   * guard catches pairs that cross the whole shell in one 120 Hz step.
   */
  /** AI-only personal space: gentle repulsion between locally-simulated AI
   *  cars so packs never merge into a single point (which deadlocks their
   *  obstacle logic — the alpino hairpin jam). Pure position nudge along the
   *  separation axis — no impulse, no velocity change, no spins. The player
   *  and online puppets are exempt (ghosts, by design). */
  private softSeparation(): void {
    const MIN_D = 3.0;              // target center-to-center spacing (m)
    for (let i = 0; i < this.cars.length; i++) {
      const a = this.cars[i];
      if (a.isPlayer || a.remoteDriven || a.finished) continue;
      for (let j = i + 1; j < this.cars.length; j++) {
        const b = this.cars[j];
        if (b.isPlayer || b.remoteDriven || b.finished) continue;
        const dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z;
        const d2 = dx * dx + dz * dz;
        if (d2 > MIN_D * MIN_D || d2 < 1e-6) continue;
        const d = Math.sqrt(d2);
        // eases out with distance; ≈2.7 m/s of drift at full overlap — enough
        // to keep spacing, too weak to feel like a collision response
        const push = (MIN_D - d) * 0.9 * PHYS.fixedDt;
        const nx = dx / d, nz = dz / d;
        a.pos.x -= nx * push * 0.5; a.pos.z -= nz * push * 0.5;
        b.pos.x += nx * push * 0.5; b.pos.z += nz * push * 0.5;
      }
    }
  }

  private carCollisions(): void {
    const HL = PHYS.carLength / 2;   // 2.7 m
    const HW = PHYS.carWidth / 2;    // 1.0 m
    for (let i = 0; i < this.cars.length; i++) {
      const a = this.cars[i];
      for (let j = i + 1; j < this.cars.length; j++) {
        const b = this.cars[j];
        // cheap reject (11 m — beyond any contact reach incl. the sweep)
        const dx0 = b.pos.x - a.pos.x, dz0 = b.pos.z - a.pos.z;
        if (dx0 * dx0 + dz0 * dz0 > 121) continue;

        // ---- SAT contact test (+ one-step midpoint sweep vs tunneling) ----
        let hit = obbContact(a.pos.x, a.pos.z, a.yaw, b.pos.x, b.pos.z, b.yaw, HL, HW);
        if (!hit) {
          const pa = this.prevPos.get(a.id), pb = this.prevPos.get(b.id);
          if (pa && pb) {
            const mvx = (b.pos.x - pb.x) - (a.pos.x - pa.x);
            const mvz = (b.pos.z - pb.z) - (a.pos.z - pa.z);
            if (mvx * mvx + mvz * mvz > (PHYS.carWidth * 0.8) ** 2) {
              hit = obbContact(
                (a.pos.x + pa.x) / 2, (a.pos.z + pa.z) / 2, a.yaw,
                (b.pos.x + pb.x) / 2, (b.pos.z + pb.z) / 2, b.yaw, HL, HW);
            }
          }
        }
        if (!hit) continue;

        const { nx, nz, depth } = hit;    // normal points a → b
        const immA = a.remoteDriven, immB = b.remoteDriven;
        const invA = immA ? 0 : 1 / a.mass;
        const invB = immB ? 0 : 1 / b.mass;
        const invSum = invA + invB;
        if (invSum <= 0) continue;

        // ---- positional separation (inverse-mass split; puppets immovable) ----
        if (!immA) { a.pos.x -= nx * depth * (invA / invSum); a.pos.z -= nz * depth * (invA / invSum); }
        if (!immB) { b.pos.x += nx * depth * (invB / invSum); b.pos.z += nz * depth * (invB / invSum); }

        // ---- impulse along the normal (only while closing) ----
        const va = a.velocity, vb = b.velocity;
        const rel = (va.x - vb.x) * nx + (va.z - vb.z) * nz;   // + = closing
        if (rel > 0.05) {
          const jImp = (1 + PHYS.contactRestitution) * rel / invSum;   // kg·m/s
          if (!immA) applyWorldImpulse(a, -nx * jImp * invA, -nz * jImp * invA);
          if (!immB) applyWorldImpulse(b, nx * jImp * invB, nz * jImp * invB);

          // contact point ≈ midway between the centres — classify the hit
          const cx = (a.pos.x + b.pos.x) / 2, cz = (a.pos.z + b.pos.z) / 2;
          const fa = a.forward(), fb = b.forward();
          const raX = Math.cos(a.yaw), raZ = -Math.sin(a.yaw);
          const rbX = Math.cos(b.yaw), rbZ = -Math.sin(b.yaw);
          const axd = cx - a.pos.x, azd = cz - a.pos.z;
          const bxd = cx - b.pos.x, bzd = cz - b.pos.z;
          const longA = axd * fa.x + azd * fa.z, latA = axd * raX + azd * raZ;
          const longB = bxd * fb.x + bzd * fb.z, latB = bxd * rbX + bzd * rbZ;
          const aFront = longA > 0.7, bFront = longB > 0.7;
          const sideContact = Math.abs(latA) > 1.05 || Math.abs(latB) > 1.05;

          if (!sideContact && aFront && !bFront) {
            this.rearEnd(a, b, rel, latB);              // A's nose into B's tail
          } else if (!sideContact && bFront && !aFront) {
            this.rearEnd(b, a, rel, latA);              // B's nose into A's tail
          } else if (!sideContact && aFront && bFront) {
            // nose-to-nose: both lose
            if (!immA) { a.vLong *= 0.78; a.yawRate += (Math.random() - 0.5) * 0.6; }
            if (!immB) { b.vLong *= 0.78; b.yawRate += (Math.random() - 0.5) * 0.6; }
          } else {
            // side-by-side rub: mutual push (already separated) + yaw disturb + scrub
            if (!immA) { a.yawRate -= Math.sign(latA || 1) * Math.min(0.5, rel * 0.05); a.vLong *= 0.988; }
            if (!immB) { b.yawRate -= Math.sign(latB || 1) * Math.min(0.5, rel * 0.05); b.vLong *= 0.988; }
          }

          // fx
          if ((a.isPlayer || b.isPlayer) && rel > 3) {
            this.camera.kick(Math.min(1, rel / 16));
            this.particles.sparkBurst(new THREE.Vector3(cx, a.pos.y + 0.4, cz), Math.min(1.2, rel / 12));
            if (rel > 8) AudioSys.playImpact(rel / 16);
          }
        }
      }
    }
  }

  /**
   * Nose-to-tail consequence: attacker never gets it for free, victim answers
   * with a spin on hard contact (and the owner is told online) or a wiggle on
   * a light tap. `latVictim` = contact offset in the victim's frame.
   */
  private rearEnd(attacker: F1Car, victim: F1Car, rel: number, latVictim: number): void {
    const side = Math.sign(latVictim || 1);
    if (rel > PHYS.contactSpinClosing) {
      if (victim.spinFromContact(rel / 20)) this.netHitFrom(attacker, victim);
      if (!attacker.remoteDriven) { attacker.vLong *= 0.86; attacker.yawRate += side * 0.35; }
    } else if (rel > PHYS.contactWobble) {
      victim.yawRate -= side * Math.min(0.6, rel * 0.06);   // a wiggle, not a spin
      if (!attacker.remoteDriven) attacker.vLong *= 0.93;
      if (!victim.remoteDriven) victim.vLong *= 0.97;
    }
  }

  // ============================================================ race events

  private onRaceEvent(e: import('../race/F1RaceManager').RaceEvent): void {
    switch (e.kind) {
      case 'lights':
        this.bridge.publish({ lights: parseInt(e.text, 10) });
        AudioSys.playLightsBeep(parseInt(e.text, 10));
        break;
      case 'go':
        this.bridge.publish({ lights: null, phase: 'racing' });
        AudioSys.playLightsBeep(0);
        AudioSys.crowdSwell(0.8);
        break;
      case 'lastlap':
        this.bridge.pushAnnouncer('FINAL LAP!', 'hype');
        break;
      case 'fastestlap':
        this.bridge.pushAnnouncer(e.text, 'hype');
        AudioSys.playBeep(1180, 0.16, 'triangle', 0.16);
        break;
      case 'finish':
        this.bridge.pushAnnouncer(e.text, e.tone);
        AudioSys.crowdSwell(1);
        break;
      case 'blue':
        this.bridge.pushAnnouncer(e.text, 'info');
        break;
      case 'jumpstart':
      case 'penalty':
      case 'tracklimit':
        this.bridge.pushAnnouncer(e.text, 'bad');
        AudioSys.playBeep(240, 0.2, 'square', 0.18);
        break;
      case 'position':
        this.bridge.pushAnnouncer(e.text, e.tone);
        AudioSys.playBeep(e.tone === 'good' ? 880 : 440, 0.08, 'triangle', 0.12);
        break;
      case 'lap':
        if (e.text) this.bridge.pushAnnouncer(e.text, 'info');
        break;
    }
  }

  private onCarFinish(car: F1Car, pos: number): void {
    if (car.isPlayer) {
      this.playerFinishAtMs = performance.now();
      this.particles.confettiBurst(car.pos.clone().add(new THREE.Vector3(0, 3, 0)));
      this.bridge.pushAnnouncer(pos === 1 ? 'VICTORY!' : `CHEQUERED FLAG — P${pos}`, pos <= 3 ? 'hype' : 'info');
      this.bridge.publish({ flags: { blue: false, yellow: false, chequered: true } });
      // online: report my time (server aggregates)
      if (this.session?.online && this.net && this.race) {
        const st = this.race.states.get(car.id);
        this.net.finishRace(st?.finishMs ?? performance.now());
      }
    } else if (this.session?.online && this.net && this.race && this.session.online.isHost) {
      const st = this.race.states.get(car.id);
      if (this.netBotIds.has(car.id)) this.net.finishRaceFor(car.id, st?.finishMs ?? performance.now());
    }
  }

  private finishRace(): void {
    if (!this.race || this.resultPublished) return;
    const cfg = this.session!;
    if (cfg.online) {
      // server owns the standings (race:over); stop scoring locally
      this.phase = 'finished';
      this.resultPublished = true;
      return;
    }
    this.resultPublished = true;
    this.phase = 'finished';
    const rows = this.race.getResults();
    if (cfg.mode === 'timetrial') {
      const playerRow = rows.find(r => r.isPlayer)!;
      if (playerRow.finishTimeMs != null) {
        const ghost = this.ghostRecorder?.finish(playerRow.finishTimeMs) ?? null;
        const better = SaveData.recordRace(cfg.circuitId, playerRow.finishTimeMs, cfg.teamId, ghost);
        this.bridge.pushAnnouncer(better ? 'NEW RECORD!' : 'Session complete', better ? 'hype' : 'info');
      }
    }
    this.bridge.publish({
      phase: 'finished', results: rows, needsContinue: true,
      lights: null,
    });
  }

  private onNetRaceOver(rows: NetResultRow[]): void {
    const cfg = this.session;
    if (!cfg?.online) return;
    this.phase = 'finished';
    this.resultPublished = true;
    const resultRows: RaceResultRow[] = rows.map(r => {
      const isMe = r.id === cfg.online!.localId;
      return {
        carId: isMe ? 'player' : (r.id.startsWith('bot-') ? r.id : `net-${r.id}`),
        driverName: r.name,
        teamId: r.teamId,
        isPlayer: isMe,
        position: r.pos,
        finishTimeMs: r.timeMs,
        bestLapMs: null,
        gapSec: null,
        penaltySec: 0,
      };
    });
    this.bridge.publish({ results: resultRows, needsContinue: true, phase: 'finished' });
  }

  // ============================================================ online plumbing

  private isNetAuthority(car: F1Car): boolean {
    if (!this.session?.online) return false;
    if (car.isPlayer) return true;
    return !!this.session.online.isHost && this.netBotIds.has(car.id);
  }

  private netHitFrom(attacker: F1Car, victim: F1Car): void {
    if (!this.session?.online || !this.net || !victim.remoteDriven) return;
    if (!this.isNetAuthority(attacker)) return;
    const targetId = victim.id.startsWith('net-') ? victim.id.slice(4) : victim.id;
    this.net.sendEvent({ t: 'hit', target: targetId });
  }

  private buildNetState(k: F1Car, nowMs: number): NetKartState {
    let st = 0;
    if (k.spinT > 0) st |= ST_SPIN;
    if (k.drsOpen) st |= ST_DRS;
    if (k.ersDeploying) st |= ST_ERS;
    if (k.lockupFront > 0.4) st |= ST_LOCK;
    const rs = this.race?.states.get(k.id);
    return {
      t: Math.round(nowMs),
      p: [Math.round(k.pos.x * 50) / 50, Math.round(k.pos.y * 50) / 50, Math.round(k.pos.z * 50) / 50],
      ry: Math.round(k.yaw * 100) / 100,
      s: Math.round(k.vLong * 10) / 10,
      vy: 0,
      g: k.gear,
      st,
      lap: rs?.lap ?? k.lap,
      prog: Math.round(k.progressS * 10000) / 10000,
      f: k.finished ? 1 : 0,
    };
  }

  private handleNetEvent(peerId: string, ev: import('../net/NetTypes').NetEvent): void {
    if (!this.session?.online) return;
    switch (ev.t) {
      case 'hit': {
        const player = this.cars[0];
        if (ev.target === this.session.online.localId) {
          if (player.spinT <= 0) {
            player.spinFromContact(1);
            this.camera.kick(0.9);
            AudioSys.playImpact(0.9);
          }
          break;
        }
        const victim = this.cars.find(c => c.id === ev.target || c.id === `net-${ev.target}`);
        if (victim) {
          if (victim.remoteDriven) {
            if (victim.spinT <= 0) victim.spinFromContact(1);
          } else if (this.isNetAuthority(victim) && victim.spinT <= 0 && !victim.finished) {
            victim.spinFromContact(1);
            this.particles.sparkBurst(victim.pos, 0.8);
          }
        }
        break;
      }
      case 'camera':
        break;
    }
    void peerId;
  }

  private attachNameTag(carId: string, name: string): void {
    const canvas = document.createElement('canvas');
    canvas.width = 256; canvas.height = 64;
    const ctx = canvas.getContext('2d')!;
    ctx.font = 'bold 30px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 7; ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.strokeText(name, 128, 34);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(name, 128, 34);
    const tex = new THREE.CanvasTexture(canvas);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
    sprite.scale.set(2.6, 0.65, 1);
    sprite.renderOrder = 999;
    this.scene.add(sprite);
    this.netNameTags.set(carId, sprite);
  }

  // ============================================================ camera & visuals

  /** QA: freeze the camera at an arbitrary pose (god views for pit QA) */
  qaCamOverride = false;

  private updateCamera(dt: number): void {
    const player = this.cars[0];
    if (!player) return;
    if (this.qaCamOverride) return;   // hold the pose the probe set
    const lookBack = !!(this.lastControls.get(player.id)?.lookBack) && !player.finished;
    this.camera.update(dt, player, this.world?.spline ?? null, lookBack);
    // shadow frustum follows the player (v22: scratch vectors — this ran two
    // Vector3 allocations per rendered frame since v21)
    const dir = this.weatherStyle?.sunDir ?? this.world?.style.sunDir ?? [0.6, 0.5, 0.3];
    this.sun.target.position.copy(player.pos);
    this.sun.position.copy(player.pos).add(
      this.scratchA.set(dir[0] * 90, dir[1] * 110, dir[2] * 90));
    // sky bounce rides the anti-solar side (its own soft shadowless wash)
    this.fill.target.position.copy(player.pos);
    this.fill.position.copy(player.pos).add(
      this.scratchA.set(-dir[0] * 110, 60, -dir[2] * 110));
  }

  /** v22 PERF: shared scratch vectors for the per-frame hot paths */
  private scratchA = new THREE.Vector3();
  private scratchB = new THREE.Vector3();

  private updateVisuals(dt: number): void {
    const player = this.cars[0];
    for (const car of this.cars) {
      const v = this.visuals.get(car.id);
      if (!v) continue;
      v.group.visible = true;
      v.setGhost(car.finished && this.phase === 'finished');
      // pit stop compound change → recolour the tyre stripes
      if (v.compound !== car.setup.compound) v.setCompound(car.setup.compound);
      // rear rain light: blinking LED in rain (and night)
      v.setRainLight(this.session?.weather === 'rain' || this.session?.weather === 'night', this.elapsed);
      v.group.position.copy(car.pos);
      v.group.rotation.y = car.yaw;
      const controls = this.lastControls.get(car.id) ?? NEUTRAL_CONTROLS;
      v.update(dt, {
        steer: car.isPlayer ? car.steerAngleVis : controls.steer,
        speed: car.speed,
        drsOpen: car.drsOpen,
        brakeGlow: car.brakeGlow,
        slip: Math.max(car.slipRear, car.wheelSpin * 0.8),
        wheelSpin: car.wheelSpin,
      });

      // ---- particles ---------------------------------------------------------
      // v22 PERF: scratch vector — was a clone + new Vector3 per car per frame
      const fx = Math.sin(car.yaw), fz = Math.cos(car.yaw);
      const rear = this.scratchB.set(
        car.pos.x - fx * 1.6, car.pos.y + 0.3, car.pos.z - fz * 1.6);
      if (car.slipRear > 0.35 && car.speed > 14) {
        if (Math.random() < 0.5) this.particles.offroadDust(rear);
      }
      // v27: wrecked cars (airstrike) trail black smoke + fire; boosting
      // cars (admin BOOST) spit rocket flames from the rear
      if (car.damage > 0.55) {
        this.particles.damageSmoke(car.pos);
        if (Math.random() < 0.5) this.particles.damageFire(rear);
      } else if (car.damage > 0.22 && Math.random() < 0.45) {
        this.particles.damageSmoke(car.pos);
      }
      if (car.boostT > 0 && Math.random() < 0.8) {
        this.particles.boostFlame(rear);
      }
      if (car.wheelSpin > 0.5 && car.speed < 30 && car.isPlayer) {
        if (Math.random() < 0.4) this.particles.offroadDust(rear);
      }
      if (car.offTrack && car.speed > 10 && Math.random() < 0.5) this.particles.offroadDust(car.pos);
      if (car.slipstreamCut > 0.15) {
        this.particles.slipstreamStreak(
          car.pos, this.scratchA.set(-fx, 0, -fz), car.slipstreamCut, car.slipstreamCut > 0.3);
      }
      if (car.wallHit > 0.3) {
        this.particles.sparkBurst(car.pos.clone().add(new THREE.Vector3(0, 0.4, 0)), car.wallHit);
        if (car.isPlayer) {
          this.camera.kick(car.wallHit * 0.8);
          AudioSys.playImpact(car.wallHit);
        }
        car.wallHit = 0;
      }

      // name tags
      const tag = this.netNameTags.get(car.id);
      if (tag) tag.position.set(car.pos.x, car.pos.y + 1.5, car.pos.z);
    }

    // ---- player audio --------------------------------------------------------------
    if (player) {
      const controls = this.lastControls.get(player.id) ?? NEUTRAL_CONTROLS;
      const rpmN = clamp((player.rpm - PHYS.idleRpm) / (PHYS.maxRpm - PHYS.idleRpm), 0, 1);
      AudioSys.engine(
        rpmN, controls.throttle, player.speed,
        Math.max(player.slipRear, player.lockupFront),
        player.ginfo?.onKerb ?? false,
        player.offTrack,
        player.ersDeploying,
        player.shiftTimer > 0,
      );
      if (player.gear !== this.prevGear) {
        AudioSys.playShift(player.gear > this.prevGear, rpmN);
        this.prevGear = player.gear;
      }
      const locking = player.lockupFront > 0.5;
      if (locking && !this.prevLockup) AudioSys.playSqueal(1);
      this.prevLockup = locking;
    }
  }

  // ============================================================ HUD publishing

  private publishHud(now: number): void {
    const player = this.cars[0];
    if (!player || !this.race) return;
    const cfg = this.session!;

    if (now >= this.hudPublishAt) {
      this.hudPublishAt = now + 100;
      const st = this.race.states.get(player.id)!;
      const controls = this.lastControls.get(player.id) ?? NEUTRAL_CONTROLS;
      const rpmN = clamp((player.rpm - PHYS.idleRpm) / (PHYS.maxRpm - PHYS.idleRpm), 0, 1);
      const lapFuel = (this.world?.spline.length ?? 4000) * PHYS.fuelPerMeter * 1.45;
      const bestSectors: [number, number, number] | null = st.bestSectors.some(s => isFinite(s))
        ? [st.bestSectors[0], st.bestSectors[1], st.bestSectors[2]]
        : null;
      this.bridge.publish({
        phase: this.phase === 'lights' ? 'lights' : this.phase === 'grid' ? 'grid' : this.phase === 'racing' ? 'racing' : 'finished',
        position: player.rank,
        totalCars: this.cars.length,
        lap: Math.min(st.lap, cfg.laps - 1),
        lights: this.race.phase === 'grid' || this.race.phase === 'lights' ? this.race.litPods : null,
        waitingDrivers: this.race.waitingForGo,
        pit: this.pits?.hudState('player') ?? null,
        trackLimitWarns: st.trackLimitWarns,
        telemetry: {
          speedKmh: Math.round(player.speedKmh),
          gear: player.gear,
          rpmN,
          drs: player.drsOpen ? 'open' : player.drsEligible ? 'ready' : 'off',
          ersPct: player.ersPct,
          ersDeploying: player.ersDeploying,
          fuelKg: Math.round(player.fuel * 10) / 10,
          fuelLapsLeft: lapFuel > 0 ? Math.round((player.fuel / lapFuel) * 10) / 10 : null,
          tireWear: player.tireWear,
          compound: player.compound,
          latG: Math.round(player.latG * 100) / 100,
          longG: Math.round(player.longG * 100) / 100,
          lockup: player.lockupFront > 0.4,
          throttle: controls.throttle,
          brake: controls.brake,
          steer: player.steerAngleVis,
        },
        timing: {
          lapMs: this.race.phase === 'racing' && !player.finished ? now - st.lapStartMs : (st.lapTimes.length ? st.lapTimes[st.lapTimes.length - 1] : 0),
          lastLapMs: st.lapTimes.length ? st.lapTimes[st.lapTimes.length - 1] : null,
          bestLapMs: st.bestLapMs,
          sessionFastestMs: this.race.fastestLapMs,
          sessionFastestBy: this.race.fastestLapBy,
          sectorMs: [...st.sectorMs] as [number, number, number],
          bestSectorMs: bestSectors,
          currentSector: st.currentSector,
        },
        timeTrial: cfg.mode === 'timetrial' ? {
          lapMs: this.race.phase === 'racing' && !player.finished ? now - st.lapStartMs : 0,
          bestLapMs: st.bestLapMs ?? SaveData.getBestLap(cfg.circuitId),
          bestTotalMs: SaveData.getBestRace(cfg.circuitId)?.time ?? null,
          totalMs: player.finished ? (st.finishMs ?? 0) : Math.max(0, now - this.race.goAtMs),
        } : null,
      });
    }

    // position tower at ~4 Hz
    if (now >= this.towerPublishAt) {
      this.towerPublishAt = now + 250;
      const order = [...this.cars].sort((a, b) => a.rank - b.rank);
      this.bridge.publish({
        tower: order.slice(0, 20).map(car => {
          const team = TEAM_MAP[car.teamId];
          const st = this.race!.states.get(car.id)!;
          return {
            pos: car.rank,
            name: driverTag(car.driverName),
            teamColor: team?.color ?? 0x888888,
            gapSec: car.isPlayer ? null : st.gapSec,
            isPlayer: car.isPlayer,
            drs: car.drsOpen,
            finished: car.finished,
            penalty: st.penaltySec,
          };
        }),
      });
    }
  }

  // ============================================================ minimap

  private minimapAt = 0;

  private drawMinimap(): void {
    const ctx = this.minimapCtx;
    if (!ctx || !this.world) return;
    // v22 PERF: 15 Hz is plenty for a radar dot — the 60 Hz full redraw was
    // pure 2D-canvas cost on the main thread every frame
    const now = performance.now();
    if (now - this.minimapAt < 66) return;
    this.minimapAt = now;
    const W = ctx.canvas.width, H = ctx.canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(6, 8, 14, 0.62)';
    ctx.beginPath();
    ctx.roundRect(0, 0, W, H, 12);
    ctx.fill();

    const poly = this.world.minimap;
    if (!this.minimapBounds) {
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const p of poly) {
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
      }
      const pad = 12;
      const scale = Math.min((W - pad * 2) / (maxX - minX), (H - pad * 2) / (maxZ - minZ));
      this.minimapBounds = { minX, minZ, scale };
    }
    const { minX, minZ, scale } = this.minimapBounds;
    let spanX = 0, spanZ = 0;
    for (const p of poly) { spanX = Math.max(spanX, p.x - minX); spanZ = Math.max(spanZ, p.z - minZ); }
    const ox = (W - spanX * scale) / 2, oz = (H - spanZ * scale) / 2;
    const mapX = (x: number): number => (x - minX) * scale + ox;
    const mapZ = (z: number): number => (z - minZ) * scale + oz;

    ctx.beginPath();
    ctx.moveTo(mapX(poly[0].x), mapZ(poly[0].z));
    for (const p of poly) ctx.lineTo(mapX(p.x), mapZ(p.z));
    ctx.closePath();
    ctx.lineWidth = 5;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(235, 238, 246, 0.8)';
    ctx.stroke();

    // start line tick
    const f = poly[0], f2 = poly[2];
    ctx.beginPath();
    ctx.moveTo(mapX(f.x) - (mapZ(f2.z) - mapZ(f.z)) * 0.07, mapZ(f.z) + (mapX(f2.x) - mapX(f.x)) * 0.07);
    ctx.lineTo(mapX(f.x) + (mapZ(f2.z) - mapZ(f.z)) * 0.07, mapZ(f.z) - (mapX(f2.x) - mapX(f.x)) * 0.07);
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#ffe94a';
    ctx.stroke();

    for (const car of this.cars) {
      const team = TEAM_MAP[car.teamId];
      const col = car.isPlayer ? '#ffe94a' : '#' + (team?.color ?? 0x888888).toString(16).padStart(6, '0');
      ctx.beginPath();
      ctx.arc(mapX(car.pos.x), mapZ(car.pos.z), car.isPlayer ? 5.5 : 3.4, 0, Math.PI * 2);
      ctx.fillStyle = col;
      ctx.fill();
      if (car.isPlayer) { ctx.lineWidth = 2; ctx.strokeStyle = '#fff'; ctx.stroke(); }
    }
  }

  // ============================================================ environment

  private pmrem: THREE.PMREMGenerator | null = null;
  private envRT: THREE.WebGLRenderTarget | null = null;

  /** Bake the actual weather sky (v2 shader + sun/moon) into a PMREM
   *  environment map — the PBR paint & wet asphalt reflect the real sky. */
  private bakeEnvironment(style: WeatherStyle, weather: import('../core/Types').Weather): void {
    if (!this.pmrem) this.pmrem = new THREE.PMREMGenerator(this.renderer);
    const envScene = new THREE.Scene();
    const sky = makeSkyDomeV2(style, weather);
    sky.scale.setScalar(0.1);
    envScene.add(sky);
    // sun / moon brightness for reflections (clear sun is HOT, overcast is
    // soft, rain keeps a bright overcast so the WET asphalt has something
    // meaty to mirror; v22 sunset keeps a hot LOW sun for those long warm
    // reflections on the paintwork)
    const sunPower = weather === 'clear' ? 12 : weather === 'night' ? 3.2
      : weather === 'cloudy' ? 4.5 : weather === 'sunset' ? 11 : 5.2;
    const sun = new THREE.Mesh(
      new THREE.SphereGeometry(5, 8, 8),
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(style.sunColor).multiplyScalar(sunPower),
        fog: false,
      }),
    );
    sun.position.set(style.sunDir[0] * 40, style.sunDir[1] * 40, style.sunDir[2] * 40);
    envScene.add(sun);
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(85, 24),
      new THREE.MeshBasicMaterial({ color: style.hemiGround, fog: false }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -3;
    envScene.add(ground);

    if (this.envRT) this.envRT.dispose();
    this.envRT = this.pmrem.fromScene(envScene, 0.06, 0.1, 200);
    this.scene.environment = this.envRT.texture;
    // wet asphalt drinks reflections; night keeps a subtle cool ambience;
    // clear skies keep IBL LOW so the directional sun + its shadows own the
    // image; v22 sunset gets a warm mid IBL (the sky IS the light source)
    this.scene.environmentIntensity = weather === 'rain' ? 1.2
      : weather === 'night' ? 0.85 : weather === 'sunset' ? 0.55 : 0.45;

    sky.geometry.dispose();
    (sky.material as THREE.Material).dispose();
    sun.geometry.dispose();
    (sun.material as THREE.Material).dispose();
    ground.geometry.dispose();
    (ground.material as THREE.Material).dispose();
  }

  // ============================================================ night rig

  /** Night races: two follow spotlights + static fill points at the masts. */
  private setupNightRig(): void {
    // follow spots — they travel with the player like a TV super-motion rig
    for (let i = 0; i < 2; i++) {
      const s = new THREE.SpotLight(
        i === 0 ? 0xdfe8ff : 0xcfe0ff,
        i === 0 ? 2.6 : 1.7,
        190, 0.62, 0.55, 1.1,
      );
      s.castShadow = false;               // the moon/sun dir light owns shadows
      this.scene.add(s, s.target);
      this.nightSpots.push(s);
    }
    // a few static mast fills spread around the circuit (grid + pit glow)
    const heads = this.world?.floodHeads ?? [];
    const n = Math.min(6, heads.length);
    for (let i = 0; i < n; i++) {
      const h = heads[Math.floor(i * heads.length / n)];
      const s = new THREE.PointLight(0xbfd2ff, 40, 120, 1.6);
      s.position.copy(h);
      this.scene.add(s);
      this.nightFills.push(s);
    }
    this.updateNightRig();
  }

  /** Keep the follow spots above/ahead of the player. */
  private updateNightRig(): void {
    if (!this.nightSpots.length) return;
    const player = this.cars[0];
    if (!player) return;
    const fwd = player.forward();
    this.nightSpots[0].position.set(
      player.pos.x + fwd.x * 14 - 6, 26, player.pos.z + fwd.z * 14 - 6);
    this.nightSpots[0].target.position.copy(player.pos);
    if (this.nightSpots[1]) {
      this.nightSpots[1].position.set(
        player.pos.x - fwd.x * 16 + 8, 22, player.pos.z - fwd.z * 16 + 8);
      this.nightSpots[1].target.position.copy(player.pos);
    }
  }

  // ============================================================ menu showcase

  private buildMenuShowcase(teamColor: number, accent: number): void {
    this.menuGroup = new THREE.Group();
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(9, 48),
      new THREE.MeshStandardMaterial({ color: 0x0c0d12, roughness: 0.25, metalness: 0.6 }),
    );
    floor.rotation.x = -Math.PI / 2;
    this.menuGroup.add(floor);
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(5.2, 0.05, 8, 64),
      new THREE.MeshStandardMaterial({ color: accent, emissive: accent, emissiveIntensity: 1.6, roughness: 0.4 }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.02;
    this.menuGroup.add(ring);
    this.menuVisual = new F1Visual(teamColor, accent, 1, 'medium');
    this.menuVisual.group.position.y = 0.02;
    this.menuGroup.add(this.menuVisual.group);
    this.scene.add(this.menuGroup);

    // showroom rig
    this.scene.fog = null;
    this.sun.position.set(6, 10, 4);
    this.sun.color.setHex(0xf4f6ff);
    this.sun.intensity = 2.6;
    this.hemi.color.setHex(0x99a8cc);
    this.hemi.groundColor.setHex(0x14161c);
    this.hemi.intensity = 1.4;
    this.ambient.intensity = 0.5;
    this.renderer.toneMappingExposure = 1.05;
  }

  setMenuCar(teamColor: number, accent: number): void {
    this.menuColors = { color: teamColor, accent };
    if (!this.menuVisual) return;
    this.menuVisual.dispose();
    this.menuVisual = new F1Visual(teamColor, accent, 1, 'medium');
    this.menuVisual.group.position.y = 0.02;
    this.menuGroup?.add(this.menuVisual.group);
  }

  private showcaseT = 0;
  private updateMenuShowcase(dt: number): void {
    this.showcaseT += dt;
    if (this.menuVisual) {
      this.menuVisual.group.rotation.y = this.showcaseT * 0.45;
      this.menuVisual.update(dt, { steer: Math.sin(this.showcaseT * 0.7) * 0.3, speed: 0, drsOpen: false, brakeGlow: 0, slip: 0, wheelSpin: 0 });
    }
    const cam = this.camera.camera;
    const a = this.showcaseT * 0.12;
    cam.position.set(Math.cos(a) * 10.5, 2.6, Math.sin(a) * 10.5);
    cam.fov = 42;
    cam.updateProjectionMatrix();
    cam.lookAt(0, 0.55, 0);
  }

  // ============================================================ flow control

  togglePause(): void {
    this.paused = !this.paused;
    if (this.paused) AudioSys.engineOff();
    this.bridge.publish({ paused: this.paused });
  }

  resume(): void {
    if (this.paused) { this.paused = false; this.bridge.publish({ paused: false }); }
  }

  forceResults(): void {
    if (this.resultPublished) return;
    if (this.race) {
      // fast-forward: everyone still running gets classified by progress
      this.finishRace();
    }
  }

  quitToMenu(): void {
    this.disposeSession();
    this.qaFrozen = false;
    this.qaClockMs = null;
    this.phase = 'idle';
    this.showMenu();
    this.bridge.resetToMenu();
    AudioSys.musicStart();         // back to the menu anthem
  }

  retrySession(): void {
    if (this.session) this.startSession(this.session);
  }

  continueFlow(): void {
    this.quitToMenu();
  }

  private showMenu(): void {
    if (this.menuGroup) this.menuGroup.visible = true;
    this.scene.fog = null;
    if (this.sky) { this.scene.remove(this.sky); this.sky = null; }
    // showroom rig
    this.sun.position.set(6, 10, 4);
    this.sun.color.setHex(0xf4f6ff);
    this.sun.intensity = 2.6;
    this.hemi.color.setHex(0x99a8cc);
    this.hemi.groundColor.setHex(0x14161c);
    this.hemi.intensity = 1.4;
    this.ambient.intensity = 0.5;
    this.renderer.toneMappingExposure = 1.05;
    this.scene.environment = null;
    this.grade.uniforms.speedWarp.value = 0;
  }

  private hideMenu(): void {
    if (this.menuGroup) this.menuGroup.visible = false;
  }

  // ============================================================ QA helpers

  qaStep(seconds: number): number {
    if (this.phase === 'idle' || !this.world) return 0;
    this.qaFrozen = true;                       // RAF stops simulating — we own the clock
    if (this.qaClockMs == null) this.qaClockMs = performance.now();
    const steps = Math.min(40000, Math.round(seconds / PHYS.fixedDt));
    let now = this.qaClockMs;
    for (let i = 0; i < steps; i++) {
      now += PHYS.fixedDt * 1000;
      this.fixedStep(PHYS.fixedDt, now);
    }
    this.qaClockMs = now;
    this.elapsed += steps * PHYS.fixedDt;
    this.world.update(this.elapsed, PHYS.fixedDt);
    return steps;
  }

  private qaTeleport(s: number, speed: number): string {
    if (!this.world || !this.cars[0]) return 'no-world';
    const sp = this.world.spline;
    const sm = sp.sampleAt(((s % 1) + 1) % 1);
    this.cars[0].placeAt(sp.roadPoint(((s % 1) + 1) % 1, 0), Math.atan2(sm.tangent.x, sm.tangent.z));
    this.cars[0].vLong = speed;
    return 'tp';
  }

  private qaState(): unknown {
    const r = this.race;
    return {
      phase: this.phase,
      fps: this.fps,
      frames: this.framesRendered,
      weather: this.session?.weather ?? null,
      wetGrip: this.world?.weatherGrip ?? 1,
      pixelRatio: this.renderer.getPixelRatio(),
      clouds: !!this.clouds,
      rain: !!this.rain,
      nightSpots: this.nightSpots.length,
      cars: this.cars.map(c => ({
        id: c.id, team: c.teamId, name: c.driverName,
        pos: c.pos.toArray().map(v => +v.toFixed(1)),
        yaw: +c.yaw.toFixed(2), speed: +c.speed.toFixed(1), kmh: Math.round(c.speedKmh),
        gear: c.gear, rpm: Math.round(c.rpm), drs: c.drsOpen, drsElig: c.drsEligible,
        ers: +c.ersPct.toFixed(2), fuel: +c.fuel.toFixed(1), wear: +c.tireWear.toFixed(2),
        lap: r?.states.get(c.id)?.lap ?? c.lap, rank: c.rank, finished: c.finished,
        surface: c.surface, off: c.offTrack, spin: +(c.spinT || 0).toFixed(2),
        latG: +c.latG.toFixed(2), longG: +c.longG.toFixed(2),
        vLong: +c.vLong.toFixed(1), vLat: +c.vLat.toFixed(2), yawRate: +c.yawRate.toFixed(3),
        slipstream: +c.slipstreamCut.toFixed(2), dirty: +c.dirtyAir.toFixed(2),
        ai: this.aiDrivers.get(c.id) ? 'yes' : null,
        ctrl: this.lastControls.get(c.id) ?? null,
      })),
      race: r ? {
        phase: r.phase, litPods: r.litPods, goAt: r.goAtMs,
        fastest: r.fastestLapMs ? { ms: r.fastestLapMs, by: r.fastestLapBy } : null,
        states: [...r.states.entries()].map(([id, st]) => ({
          id, lap: st.lap, totalM: Math.round(st.totalM), pos: st.position,
          best: st.bestLapMs, gap: st.gapSec == null ? null : +st.gapSec.toFixed(1),
          warns: st.trackLimitWarns, pen: st.penaltySec,
        })),
      } : null,
      online: this.session?.online ? {
        bots: [...this.netBotIds], remotes: [...this.remoteDrivers.keys()],
        host: this.session.online.isHost,
      } : null,
    };
  }

  // ============================================================ teardown

  // ============================================================ v17 pit API (HUD)

  /** HUD: player confirmed a stop with the chosen compound. */
  requestPit(compound: TireCompound): void {
    const player = this.cars[0];
    if (!player || !this.pits?.available) return;
    this.pits.requestBox(player, compound);
    this.pits.menuOpen = false;
    this.bridge.publish({ pit: this.pits.hudState('player') });
  }

  /** HUD: cancel a pending box request. */
  cancelPit(): void {
    const player = this.cars[0];
    if (!player || !this.pits) return;
    this.pits.cancelBox(player);
    this.pits.menuOpen = false;
    this.bridge.publish({ pit: this.pits.hudState('player') });
  }

  /** HUD: close the pit menu without action. */
  closePitMenu(): void {
    if (!this.pits) return;
    this.pits.menuOpen = false;
    this.bridge.publish({ pit: this.pits.hudState('player') });
  }

  private disposeSession(): void {
    if (this.world) {
      this.scene.remove(this.world.group);
      this.world.dispose();
      this.world = null;
    }
    if (this.sky) { this.scene.remove(this.sky); this.sky = null; }
    if (this.clouds) { this.scene.remove(this.clouds.group); this.clouds = null; }
    if (this.rain) { this.scene.remove(this.rain.group); this.rain.dispose(); this.rain = null; }
    for (const s of this.nightSpots) this.scene.remove(s, s.target);
    this.nightSpots = [];
    for (const s of this.nightFills) this.scene.remove(s);
    this.nightFills = [];
    this.weatherStyle = null;
    this.grade.uniforms.strength.value = 0.32;
    this.grade.uniforms.speedWarp.value = 0;
    for (const v of this.visuals.values()) {
      this.scene.remove(v.group);
      v.dispose();
    }
    this.visuals.clear();
    if (this.ghostPlayer) { this.ghostPlayer.dispose(); this.ghostPlayer = null; }
    this.ghostRecorder = null;
    this.race = null;
    this.cars = [];
    this.aiDrivers.clear();
    this.lastControls.clear();
    this.remoteDrivers.clear();
    this.netBotIds.clear();
    this.prevPos.clear();
    for (const tag of this.netNameTags.values()) {
      this.scene.remove(tag);
      (tag.material as THREE.SpriteMaterial).map?.dispose();
      tag.material.dispose();
    }
    this.netNameTags.clear();
    this.pits?.reset();
    this.pits = null;
    // v27: drop any live airstrike + close the admin panel, reset cheats
    this.clearAirstrike();
    this.strikeCooldownUntil = 0;
    this.admin = { turbo: false, grip: false, noWear: false, slowBots: false, invuln: false };
    F1AIDriver.cheatDemand = 1;
    if (this.bridge.getSnapshot().admin != null) this.publishAdmin(false);
    if (this.net) {
      this.net.onPeerState = null;
      this.net.onPeerEvent = null;
      this.net.onPeerLeft = null;
      this.net.onRaceOver = null;
      this.net.onRaceGo = null;
    }
    this.minimapBounds = null;
    this.paused = false;
    this.accumulator = 0;
    AudioSys.engineOff();
  }

  dispose(): void {
    cancelAnimationFrame(this.rafId);
    window.removeEventListener('resize', this.onResize);
    document.removeEventListener('visibilitychange', this.onVisibility);
    if (this.hiddenTimer) { clearInterval(this.hiddenTimer); this.hiddenTimer = null; }
    AudioSys.engineOff();
    this.input.detach();
    this.disposeSession();
    this.renderer.dispose();
  }
}

// ============================================================ helpers

/** v27 secret airstrike state (see Game.triggerAirstrike). */
interface AirstrikeState {
  /** the strike jet, flying a straight line over the aim */
  plane: THREE.Group;
  /** unit horizontal flight direction */
  dir: THREE.Vector3;
  /** horizontal speed (m/s) */
  speed: number;
  /** ballistic fall time from release altitude (s) */
  tFall: number;
  /** live impact point (lerps toward the chased leader) */
  aim: THREE.Vector3;
  /** the car being bombed — re-evaluated every step to the CURRENT P1 */
  target: F1Car | null;
  /** the falling bomb; null before release / after impact */
  bomb: THREE.Group | null;
  bombVel: THREE.Vector3;
  released: boolean;
  trailT: number;
  /** explosion flash light while hot */
  light: THREE.PointLight | null;
  boomT: number;
}

/** low-poly strike jet (v27 airstrike; v30 proportions from the parallel
 *  session's v29 — bigger and more readable against the sky): 20 m attack
 *  jet, dark strike-grey, glass canopy, fat wing. */
function buildStrikeJet(): THREE.Group {
  const g = new THREE.Group();
  const skin = new THREE.MeshStandardMaterial({ color: 0x39404a, roughness: 0.55, metalness: 0.6 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x23272e, roughness: 0.6, metalness: 0.5 });
  const fus = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 1.35, 16.5, 10), skin);
  fus.rotation.x = Math.PI / 2;
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.75, 3.4, 10), skin);
  nose.rotation.x = -Math.PI / 2;
  nose.position.z = 9.9;
  const wing = new THREE.Mesh(new THREE.BoxGeometry(13.5, 0.32, 3.4), skin);
  wing.position.set(0, 0.15, 1.1);
  const tailW = new THREE.Mesh(new THREE.BoxGeometry(6.2, 0.26, 1.7), skin);
  tailW.position.set(0, 0.3, -7.6);
  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.26, 3.1, 2.6), dark);
  fin.position.set(0, 1.9, -7.4);
  const canopy = new THREE.Mesh(
    new THREE.SphereGeometry(0.62, 10, 8),
    new THREE.MeshStandardMaterial({
      color: 0x9fd8ff, roughness: 0.15, metalness: 0.2,
      emissive: 0x1a3548, emissiveIntensity: 0.4,
    }));
  canopy.scale.set(1, 0.75, 2.4);
  canopy.position.set(0, 0.72, 4.4);
  const glow = new THREE.Mesh(
    new THREE.SphereGeometry(0.6, 8, 8),
    new THREE.MeshBasicMaterial({ color: 0xff9440 }));
  glow.position.set(0, 0, -8.6);
  g.add(fus, nose, wing, tailW, fin, canopy, glow);
  return g;
}

/** the bomb (v30, v29 style): a fat, readable game bomb — dark capsule,
 *  red seeker tip, cross fin. Not a realistic 0.4 m slug. */
function buildStrikeBomb(): THREE.Group {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0x2e333a, roughness: 0.5, metalness: 0.7 });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.95, 3.2, 4, 10), mat);
  body.rotation.x = Math.PI / 2;
  g.add(body);
  const fin = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.09, 1.6), mat);
  fin.position.z = -2.2;
  g.add(fin);
  const tip = new THREE.Mesh(
    new THREE.ConeGeometry(0.5, 1.2, 8),
    new THREE.MeshStandardMaterial({ color: 0xd8482a, roughness: 0.4 }));
  tip.rotation.x = -Math.PI / 2;
  tip.position.z = 2.8;
  g.add(tip);
  return g;
}

/** dispose every geometry/material under a procedural group (jet, bomb). */
function disposeGroup(g: THREE.Group): void {
  g.traverse(o => {
    const m = o as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach(x => x.dispose());
    else if (mat) mat.dispose();
  });
}

/** Apply a world-frame impulse to a car's body-frame velocity. */
function applyWorldImpulse(car: F1Car, ix: number, iz: number): void {
  const fwd = car.forward();
  const rightX = Math.cos(car.yaw), rightZ = -Math.sin(car.yaw);
  car.vLong += ix * fwd.x + iz * fwd.z;
  car.vLat += ix * rightX + iz * rightZ;
}

/**
 * 2D oriented-box overlap (SAT). Returns the minimum-translation axis from A
 * to B (unit normal + depth), or null when separated. hl/hw = half extents.
 */
function obbContact(ax: number, az: number, ayaw: number,
  bx: number, bz: number, byaw: number,
  hl: number, hw: number): { nx: number; nz: number; depth: number } | null {
  const aux = Math.sin(ayaw), auz = Math.cos(ayaw);   // A forward
  const arx = Math.cos(ayaw), arz = -Math.sin(ayaw);  // A right
  const bux = Math.sin(byaw), buz = Math.cos(byaw);   // B forward
  const brx = Math.cos(byaw), brz = -Math.sin(byaw);  // B right
  const dx = bx - ax, dz = bz - az;
  let nx = 0, nz = 0, depth = Infinity;
  const test = (ux: number, uz: number): boolean => {
    const ra = hl * Math.abs(ux * aux + uz * auz) + hw * Math.abs(ux * arx + uz * arz);
    const rb = hl * Math.abs(ux * bux + uz * buz) + hw * Math.abs(ux * brx + uz * brz);
    const d = dx * ux + dz * uz;
    const o = ra + rb - Math.abs(d);
    if (o <= 0) return false;
    if (o < depth) {
      depth = o;
      const sgn = d >= 0 ? 1 : -1;
      nx = ux * sgn; nz = uz * sgn;
    }
    return true;
  };
  if (!test(aux, auz)) return null;
  if (!test(arx, arz)) return null;
  if (!test(bux, buz)) return null;
  if (!test(brx, brz)) return null;
  return { nx, nz, depth };
}

/** 3-letter driver tag for the tower (e.g. "L. Ferrand" → FER). */
function driverTag(name: string): string {
  const parts = name.trim().split(/\s+/);
  const last = parts[parts.length - 1] ?? name;
  return last.slice(0, 3).toUpperCase() || 'DRV';
}

/** Sky gradient dome (menu backdrop — sessions use the weather sky v2). */
function makeSkyDome(top: number, bottom: number): THREE.Mesh {
  const geo = new THREE.SphereGeometry(900, 24, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      top: { value: new THREE.Color(top) },
      bottom: { value: new THREE.Color(bottom) },
    },
    vertexShader: `varying vec3 vPos; void main() { vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `
      uniform vec3 top; uniform vec3 bottom; varying vec3 vPos;
      void main() {
        float h = clamp(vPos.y / 900.0 * 0.5 + 0.5, 0.0, 1.0);
        vec3 c = mix(bottom, top, pow(h, 0.62));
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  const m = new THREE.Mesh(geo, mat);
  m.frustumCulled = false;
  return m;
}

/** AI wing heuristics per circuit character. */
function aiWingFor(env: string): number {
  if (env === 'temperate' || env === 'parkland') return 2;   // speed circuits: low downforce
  if (env === 'highland') return 3;                          // mixed: medium
  if (env === 'coast') return 4;         // street: max grip
  return 3;                              // alpine: balanced
}

function pickCompound(i: number, weather?: string): TireCompound {
  // v16: if it's raining at the start, the field starts on wet rubber
  if (weather === 'rain') return i % 4 === 0 ? 'inter' : 'wet';
  return i % 3 === 0 ? 'medium' : i % 3 === 1 ? 'soft' : 'medium';
}
