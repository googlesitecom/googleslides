/**
 * APEX GP — Circuit world builder.
 *
 * From the circuit control points, builds:
 *  - the asphalt ribbon (per-sample half width) with white edge lines
 *  - red/white kerbs on corner insides/outsides (curvature-detected)
 *  - run-off areas (asphalt / gravel traps) on corner outsides
 *  - grass skirt with anti-fold clamping (parallel sections never overlap)
 *  - barrier walls at the run-off edge (physics clamp + visuals)
 *  - grid boxes, checkered line, sector lines, DRS boards, brake markers
 *  - pit building, grandstands, marshal posts, trees & env backdrop
 *  - start-light gantry (RaceManager drives setStartLights)
 *
 * groundQuery() is the single source of truth for the physics.
 */

import * as THREE from 'three';
import type { CircuitDef, CircuitPoint, Weather } from '../core/Types';
import { Spline } from '../tracks/Spline';
import { clamp } from '../core/MathUtils';
import { computeRacingLine, computeRacingLineVariants, type F1RacingLine } from './RacingLine';
import type { F1Car, F1GroundInfo, Surface } from './F1Car';
import { PHYS, WEATHER } from '../core/Config';
import { rippleNormalPair } from './Weather';
import { F1Assets } from './F1Assets';
import { buildPitLaneData, buildPitVisuals, type PitLaneData, type PitVisuals } from './PitLane';
import {
  asphaltTexture, asphaltRoughness, asphaltRoughnessWet, kerbTexture, runoffTexture,
  grassTexture, gravelTexture, crowdTexture, boardTexture, checkerTexture, foliageTexture,
} from './Textures';

export const SAMPLES = 480;
const KERB_W = 1.9;
const STRAIGHT_GRASS = 6;       // grass before the wall on straights
const WALL_INSET = 0.4;
const FOLD_ARC_M = 75;          // arc-distance beyond which ribbons can fold
const WALL_THICK_CONC = 0.62;   // visual barrier thickness (solid boxes)
const WALL_THICK_TIRE = 0.55;
/** effective car half-width against walls */
const WALL_CAR_R = 1.02;

export interface F1EnvStyle {
  skyTop: number; skyBottom: number; haze: number;
  sunColor: number; sunIntensity: number; sunDir: [number, number, number];
  hemiSky: number; hemiGround: number; hemiIntensity: number;
  fog: number; fogNear: number; fogFar: number;
  exposure: number;
}

export const ENV_STYLES: Record<CircuitDef['env'], F1EnvStyle> = {
  temperate: {
    skyTop: 0x416fb8, skyBottom: 0xdccba6, haze: 0xe8d9b8,
    sunColor: 0xffd9a0, sunIntensity: 4.3, sunDir: [0.62, 0.42, 0.28],
    hemiSky: 0xbcd0f0, hemiGround: 0x4a5238, hemiIntensity: 0.58,
    fog: 0xd4d2c8, fogNear: 300, fogFar: 1550, exposure: 1.06,
  },
  coast: {
    skyTop: 0x2c62c4, skyBottom: 0xcfe8f4, haze: 0xdceef8,
    sunColor: 0xfff2d8, sunIntensity: 4.5, sunDir: [0.5, 0.62, 0.35],
    hemiSky: 0xcfe2f6, hemiGround: 0x8a8f7a, hemiIntensity: 0.62,
    fog: 0xd8e9f2, fogNear: 350, fogFar: 1650, exposure: 1.04,
  },
  alpine: {
    skyTop: 0x3560bd, skyBottom: 0xe6ecf4, haze: 0xe9f0f8,
    sunColor: 0xfff4e0, sunIntensity: 4.1, sunDir: [0.55, 0.5, -0.3],
    hemiSky: 0xd6e4f6, hemiGround: 0x50604a, hemiIntensity: 0.66,
    fog: 0xe2ecf6, fogNear: 280, fogFar: 1500, exposure: 1.04,
  },
  // Monza: royal parkland — warm haze under tall green walls of trees
  parkland: {
    skyTop: 0x3a63c2, skyBottom: 0xe8dcbe, haze: 0xeadfc0,
    sunColor: 0xffdda0, sunIntensity: 4.4, sunDir: [0.6, 0.45, 0.25],
    hemiSky: 0xc4d4ee, hemiGround: 0x46553a, hemiIntensity: 0.6,
    fog: 0xdfdccd, fogNear: 300, fogFar: 1600, exposure: 1.06,
  },
  // México City: thin highland air — crisp light, dust haze, dry grass.
  // v21: sun lower (~39°) and warmer — long directional shadows, visible
  // (restrained) crepuscular rays; deeper contrast (sun up, sky bounce down).
  highland: {
    skyTop: 0x2f5cc0, skyBottom: 0xf0e3c6, haze: 0xe9d8b4,
    sunColor: 0xffdca6, sunIntensity: 4.8, sunDir: [0.56, 0.46, -0.3],
    hemiSky: 0xcfe0f4, hemiGround: 0x6e6a4e, hemiIntensity: 0.5,
    fog: 0xe4e0d2, fogNear: 320, fogFar: 1650, exposure: 1.03,
  },
  // v26 Texas / COTA: wide prairie sky — warm southern light, big horizon,
  // dry-green grass with brown patches. Slightly warmer + hazier than
  // highland, sun a touch higher (October Austin late afternoon).
  prairie: {
    skyTop: 0x3a67c8, skyBottom: 0xf2e2bd, haze: 0xecd9b2,
    sunColor: 0xffd894, sunIntensity: 4.9, sunDir: [0.58, 0.5, 0.26],
    hemiSky: 0xd4e2f4, hemiGround: 0x77714f, hemiIntensity: 0.52,
    fog: 0xe8dfc8, fogNear: 340, fogFar: 1700, exposure: 1.05,
  },
};

export interface GridSlot { pos: THREE.Vector3; yaw: number; s: number; }

export class F1CircuitWorld {
  readonly def: CircuitDef;
  readonly style: F1EnvStyle;
  readonly spline: Spline;
  readonly group = new THREE.Group();
  readonly minimap: { x: number; z: number }[];
  readonly gridSlots: GridSlot[] = [];
  readonly racingLine: F1RacingLine;
  /** v22: the 8 personal line variants the AI grid samples from — every bot
   *  races its own trajectory; the shared racingLine stays the player's
   *  guidance line (and the ideal-lap reference) */
  readonly aiLines: F1RacingLine[] = [];
  /** v17 pit lane (null when the circuit has no room for one) */
  pit: PitLaneData | null = null;
  pitVisuals: PitVisuals | null = null;
  readonly spawnPoints: THREE.Vector3[] = [];
  /** selected weather ('clear' default — retro-compatible) */
  readonly weather: Weather;
  /** grip scale from weather (rain) — Game applies it to every car */
  readonly weatherGrip: number;
  /** wet road material (rain only) — the rain system animates its ripples */
  wetRoadMat: THREE.MeshPhysicalMaterial | null = null;
  /** night race: floodlight mast head positions (Game drives spotlights) */
  readonly floodHeads: THREE.Vector3[] = [];

  // per-sample world facts
  private kerbL: Uint8Array;
  private kerbR: Uint8Array;
  private runoffType: Surface[];          // 'runoff' (asphalt) | 'gravel' | 'grass'
  private runoffEff: Float32Array;        // effective width (fold-clamped)
  private runoffSide: Int8Array;          // +1 right outside, -1 left outside
  private wallL: Float32Array;
  private wallR: Float32Array;
  private curvature: Float32Array;        // signed: + = left turn (yaw+)
  private ctrlRunoff: (CircuitPoint | undefined)[];
  /** samples of OTHER track sections closer than 95 m (facing walls) */
  private neighbors: number[][] = [];

  private disposables: (THREE.BufferGeometry | THREE.Material | THREE.Texture)[] = [];
  private lightPods: THREE.Mesh[] = [];
  private crowdMats: THREE.MeshBasicMaterial[] = [];
  private assistGroup: THREE.Group | null = null;
  /** v21 shared wind uniforms — foliage sway, flag wave, crowd-flash clock */
  readonly windU = { uTime: { value: 0 }, uWind: { value: 1 } };
  /** v21 crowd camera-flash sample points (stands + stadium tiers) */
  private flashPts: number[] = [];

  constructor(def: CircuitDef, decorScale: number, crowdScale: number, weather: Weather = 'clear') {
    this.def = def;
    this.style = ENV_STYLES[def.env];
    this.weather = weather;
    this.weatherGrip = weather === 'rain' ? WEATHER.rainGrip : 1;
    this.spline = new Spline(def.points, SAMPLES, def.halfWidth);
    this.minimap = this.spline.minimapPolyline();
    const N = SAMPLES;

    // control-point runoff per sample (via the original Catmull segment mapping)
    const nCtrl = def.points.length;
    this.ctrlRunoff = def.points.map(p => p);
    this.runoffType = new Array(N).fill('grass');
    this.runoffEff = new Float32Array(N);
    this.runoffSide = new Int8Array(N);
    for (let i = 0; i < N; i++) {
      const t = i / N;
      const seg = Math.min(nCtrl - 1, Math.floor(t * nCtrl));
      const lt = t * nCtrl - seg;
      const a = def.points[seg], b = def.points[(seg + 1) % nCtrl];
      const wA = a.runoffW ?? 0, wB = b.runoffW ?? 0;
      const w = wA + (wB - wA) * lt;
      const type = lt < 0.5 ? (a.runoff ?? 'grass') : (b.runoff ?? 'grass');
      this.runoffEff[i] = w;
      this.runoffType[i] = type === 'asphalt' ? 'runoff' : type === 'gravel' ? 'gravel' : 'grass';
    }

    // signed curvature per sample
    this.curvature = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const a = this.spline.samples[i];
      const b = this.spline.samples[(i + 4) % N];
      const cross = a.tangent.x * b.tangent.z - a.tangent.z * b.tangent.x;
      const turn = Math.asin(clamp(-cross, -1, 1));       // + = yaw+ = left
      this.curvature[i] = turn / Math.max(1, this.spline.length / N * 4);
    }
    // v17: the pit builder needs the UNSMOOTHED curvature (the 7-tap box
    // filter smears corner curvature ~20 m into the straight and shortens
    // the flat window below the pit minimums on street circuits)
    const rawCurvature = this.curvature.slice() as Float32Array;
    // smooth curvature
    const curvS = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      let acc = 0;
      for (let k = -3; k <= 3; k++) acc += this.curvature[(i + k + N) % N];
      curvS[i] = acc / 7;
    }
    this.curvature = curvS;

    // kerb masks: |curv| above threshold, dilated ±10 samples
    this.kerbL = new Uint8Array(N);
    this.kerbR = new Uint8Array(N);
    const KERB_K = 0.0042;
    for (let i = 0; i < N; i++) {
      if (Math.abs(this.curvature[i]) > KERB_K) {
        for (let k = -10; k <= 10; k++) {
          const j = (i + k + N) % N;
          this.kerbL[j] = 1;
          this.kerbR[j] = 1;
        }
      }
    }
    // runoff side: outside of the corner
    for (let i = 0; i < N; i++) {
      this.runoffSide[i] = this.curvature[i] > 0 ? 1 : -1;   // left turn → outside is right
    }

    // anti-fold: min distance to a non-neighbor ribbon section
    const minD = new Float32Array(N).fill(Infinity);
    const spacing = this.spline.length / N;
    for (let i = 0; i < N; i++) {
      const pi = this.spline.samples[i].pos;
      for (let j = i + 1; j < N; j++) {
        const arc = Math.min(j - i, N - (j - i)) * spacing;
        if (arc < FOLD_ARC_M) continue;
        const d = pi.distanceTo(this.spline.samples[j].pos);
        if (d < minD[i]) minD[i] = d;
        if (d < minD[j]) minD[j] = d;
      }
    }

    // neighbor sections within 95 m — their facing walls must also collide
    // (the OLD single-projection clamp only tested the wall of the section
    // you projected onto: at seams between facing sections you slipped
    // straight through into the infield — "too easy to cross the barriers")
    for (let i = 0; i < N; i++) {
      const list: number[] = [];
      const pi = this.spline.samples[i].pos;
      for (let j = 0; j < N; j++) {
        const arc = Math.min(Math.abs(j - i), N - Math.abs(j - i)) * spacing;
        if (arc < FOLD_ARC_M) continue;
        if (pi.distanceTo(this.spline.samples[j].pos) < 95) list.push(j);
      }
      this.neighbors.push(list);
    }

    // effective widths + wall positions
    this.wallL = new Float32Array(N);
    this.wallR = new Float32Array(N);
    // v26 STREET circuits (Monaco): the verge collapses to 0.9 m — barriers
    // sit right at the kerb, street-racing style. Everything else keeps the
    // standard 6 m grass band before the wall.
    const vergeBand = def.street ? 0.9 : STRAIGHT_GRASS;
    const kerbBand = def.street ? 1.0 : KERB_W;
    for (let i = 0; i < N; i++) {
      const hw = this.spline.samples[i].halfWidth;
      const foldRoom = isFinite(minD[i]) ? minD[i] / 2 - hw - 2 : 40;
      this.runoffEff[i] = clamp(this.runoffEff[i], 0, Math.max(2, Math.min(foldRoom, 34)));
      const side = this.runoffSide[i];
      const runoff = this.runoffEff[i] > 1.5 ? this.runoffEff[i] : vergeBand;
      // walls: runoff edge on the outside, verge band on the inside of corners
      const wallRt = hw + kerbBand + (side > 0 ? runoff : vergeBand) + WALL_INSET;
      const wallLf = hw + kerbBand + (side < 0 ? runoff : vergeBand) + WALL_INSET;
      this.wallR[i] = Math.min(wallRt, hw + Math.max(3, foldRoom) - 1);
      this.wallL[i] = -Math.min(wallLf, hw + Math.max(3, foldRoom) - 1);
    }

    // ---- v17 PIT LANE: compute the complex + reshape the walls around it ---
    // The circuit's own barrier (1.15 m, red/white cap) BECOMES the pit wall
    // along the main straight — physics and visuals are the same wall, so
    // there are no invisible walls. At the entry/exit blends the wall bends
    // out to the lane's far edge: that gap is how cars reach the lane.
    this.pit = buildPitLaneData(this.spline, rawCurvature, spacing,
      (x, z, m, f, t) => this.clearOfTrackPub(x, z, m, f, t));
    if (this.pit) {
      const pit = this.pit;
      const openLat = pit.laneLat + pit.laneHalf + 1.6;
      const N2 = SAMPLES;
      const span = ((pit.exitIdx - pit.entryIdx) % N2 + N2) % N2;
      for (let k = 0; k <= span; k++) {
        const i = (pit.entryIdx + k) % N2;
        const arc = k * spacing;
        const blendZone = arc < 22 || arc > span * spacing - 22;
        const wallAbs = blendZone ? openLat : pit.wallLat + 0.4;
        if (pit.side < 0) this.wallL[i] = -wallAbs;
        else this.wallR[i] = wallAbs;
      }
    }

    // ---- grid slots (needed by buildLinesAndGrid) ------------------------------
    this.gridSlots.push(...this.computeGridSlots());
    for (const g of this.gridSlots) this.spawnPoints.push(g.pos.clone());

    // ---- build all the meshes ------------------------------------------------
    this.buildRoad();
    this.buildKerbs();
    this.buildRunoffs();
    this.buildGrass();
    this.buildWalls();
    this.buildTunnels();
    this.buildLinesAndGrid();
    this.buildStartLights();
    this.buildBoards();
    this.buildEnv(decorScale, crowdScale);
    // v18: Foro Sol stadium bowl on the México hairpin (highland env only);
    // v26: also COTA — the T12-T15 stadium complex gets the same bowl
    if (def.env === 'highland' || def.env === 'prairie') this.buildStadium();
    // v17: pit complex (concrete lane, catch fence, garages, gantries) —
    // replaces the old solitary pit building when the circuit has room
    if (this.pit) {
      this.pitVisuals = buildPitVisuals(this.pit, s => this.spline.sampleAt(s), this.spline.length, this.weather);
      this.group.add(this.pitVisuals.group);
      this.disposables.push(...this.pitVisuals.disposables);
    }
    this.buildBackdrop();
    // v21: waving flags (start line + around the circuit) + crowd flashes
    this.buildFlags();
    if (this.flashPts.length) this.buildCrowdFlashes(this.flashPts);

    // ---- racing line ------------------------------------------------------------
    // v23 PARITY: the profile uses the ARCADE grip model (gripBoost 1.32 +
    // aeroLat 0.0072·v²) — the same physics the cars actually run. The old
    // sim-formula profile was 15-24% under the player's real corner speeds,
    // so the whole field got dropped out of every corner.
    // Wet weather: the AI profile must match the physics grip or the bots
    // fly off the road in the rain.
    // v22: the player's guidance line is TIDY — bounded swing (≤6.4 m off
    // center) so on the wide 22 m tracks it reads as a racing line instead
    // of the exaggerated ±9.6 m snake the old margin-only clamp produced.
    const lineBase = {
      mu: 1.92 * (weather === 'rain' ? WEATHER.rainLineMu : 1),
      cla: PHYS.claBase, powerW: PHYS.icePower * 0.98,
      mass: PHYS.chassisMass + 60,
      gripBoost: PHYS.arcade.gripBoost,
      aeroLat: PHYS.arcade.aeroLat,
    };
    // v23: the guidance line advises 90% of the limit — honest racing
    // advice (brake a touch early, ride the apex), and a committed human
    // can always beat it, which is exactly how a driving aid should feel.
    this.racingLine = computeRacingLine(this.spline, {
      ...lineBase, margin: 1.9, maxSwing: 6.4, bias: 0, iterations: 300,
      drivability: 0.90,
    });
    // v22: personal variants for the AI field (computed once per session;
    // v23: they target 95% of the REAL limit — race pace, not theory)
    this.aiLines = computeRacingLineVariants(this.spline, lineBase);
    this.buildAssistLine();
    this.buildFloodlights();
  }

  // ================================================================ v18 FORO SOL

  /**
   * Stadium bowl around the tightest hairpin (México's Foro Sol): three
   * stepped tiers of crowd stands wrapping ~260° of the corner, a roof ring
   * on columns, a FORO SOL fascia on the main stand and light clusters that
   * glow at night. The gaps at the arc ends are the entry/exit gates.
   */
  private buildStadium(): void {
    const N = SAMPLES;
    // ---- find the tightest sustained hairpin ---------------------------------
    let bestI = -1, bestScore = 0;
    for (let i = 0; i < N; i++) {
      // window score: |curvature| summed over 6 samples (a hairpin is a
      // sustained arc, not a chicane blip)
      let acc = 0;
      for (let k = 0; k < 6; k++) acc += Math.abs(this.curvature[(i + k) % N]);
      if (acc > bestScore) { bestScore = acc; bestI = i; }
    }
    if (bestI < 0 || bestScore < 0.05) return;    // no real hairpin → skip
    const apex = this.spline.sampleAt(((bestI + 3) / N));
    const turnDir = Math.sign(this.curvature[bestI]) || 1;   // + = left turn
    // stadium center = the hairpin ARC CENTER (outside the corner)
    const outside = turnDir > 0 ? -1 : 1;
    const hairpinR = 1 / Math.max(0.004, Math.abs(this.curvature[bestI]));
    const C = new THREE.Vector3(
      apex.pos.x + apex.right.x * outside * hairpinR,
      apex.pos.y,
      apex.pos.z + apex.right.z * outside * hairpinR);
    const ringR = hairpinR + 20;
    // the arc's open side (where the entry/exit legs run) faces AWAY from
    // the apex — that's where the gates go
    const apexDir = Math.atan2(apex.pos.x - C.x, apex.pos.z - C.z);
    const gateDir = apexDir + Math.PI;

    // ---- materials --------------------------------------------------------------
    const standMat = new THREE.MeshStandardMaterial({ color: 0x8f9aa8, roughness: 0.82, metalness: 0.08 });
    const tierMat = new THREE.MeshStandardMaterial({ color: 0x2a3542, roughness: 0.75 });
    const roofMat = new THREE.MeshStandardMaterial({ color: 0xd8dde4, roughness: 0.5, metalness: 0.35 });
    const colMat = new THREE.MeshStandardMaterial({ color: 0x4a5563, roughness: 0.55, metalness: 0.5 });
    const fasciaMat = new THREE.MeshStandardMaterial({
      color: 0x0d6e4f, roughness: 0.6, emissive: 0x0d6e4f, emissiveIntensity: this.weather === 'night' ? 0.55 : 0.12,
    });
    this.disposables.push(standMat, tierMat, roofMat, colMat, fasciaMat);

    // crowd texture: speckled colour noise reads as a packed crowd from afar
    const crowdTex = (() => {
      const cv = document.createElement('canvas');
      cv.width = 128; cv.height = 64;
      const ctx = cv.getContext('2d')!;
      ctx.fillStyle = '#23282f';
      ctx.fillRect(0, 0, 128, 64);
      const cols = ['#c94f4f', '#d8c24a', '#4f7dc9', '#e0e0e0', '#4fae6e', '#c97b4f', '#8a8f98'];
      for (let i = 0; i < 1400; i++) {
        ctx.fillStyle = cols[(Math.random() * cols.length) | 0];
        ctx.globalAlpha = 0.55 + Math.random() * 0.45;
        ctx.fillRect(Math.random() * 128, Math.random() * 64, 1.6, 2.2);
      }
      const t = new THREE.CanvasTexture(cv);
      t.colorSpace = THREE.SRGBColorSpace;
      return t;
    })();
    this.disposables.push(crowdTex);
    const crowdMat = new THREE.MeshBasicMaterial({ map: crowdTex });
    this.disposables.push(crowdMat);

    // ---- stand ring --------------------------------------------------------------
    const SEG = 30;                       // segments around ~260°
    const span = (260 * Math.PI) / 180;
    const startA = apexDir - span / 2;    // wrap the OUTSIDE of the U
    const stands = new THREE.Group();
    stands.name = 'foroSol';
    // v22 PERF: the whole bowl bakes into 5 InstancedMeshes — it used to be
    // ~230 meshes EACH carrying its own BoxGeometry (90 tier boxes, 30 crowd
    // planes, 30 roofs, 30 columns), and the shadow pass drew every one.
    const tierGeo = new THREE.BoxGeometry(15.4, 2.6, 4.2);
    const crowdGeo = new THREE.PlaneGeometry(15.0, 2.0);
    const roofGeo = new THREE.BoxGeometry(16.4, 0.5, 13.5);
    const colGeo = new THREE.CylinderGeometry(0.28, 0.34, 10.6, 8);
    this.disposables.push(tierGeo, crowdGeo, roofGeo, colGeo);
    const baseM: THREE.Matrix4[] = [];    // tier 0 — grey stand front
    const tierM: THREE.Matrix4[] = [];    // tiers 1-2 — dark bowl
    const crowdM: THREE.Matrix4[] = [];
    const roofM: THREE.Matrix4[] = [];
    const colM: THREE.Matrix4[] = [];
    {
      const yAxis = new THREE.Vector3(0, 1, 0);
      const xAxis = new THREE.Vector3(1, 0, 0);
      const q = new THREE.Quaternion();
      const qYaw = new THREE.Quaternion();
      const qTilt = new THREE.Quaternion();
      const sv = new THREE.Vector3(1, 1, 1);
      const pv = new THREE.Vector3();
      for (let sIdx = 0; sIdx < SEG; sIdx++) {
        const a = startA + (sIdx / (SEG - 1)) * span;
        const px = C.x + Math.sin(a) * ringR, pz = C.z + Math.cos(a) * ringR;
        if (!this.clearOfTrack(px, pz, 12)) continue;   // never clip the track
        const yaw = a + Math.PI / 2;                    // face the field
        // local (lx,ly,lz) → world under the segment transform
        const put = (arr: THREE.Matrix4[], lx: number, ly: number, lz: number,
                     tiltX = 0): void => {
          const cy = Math.cos(yaw), sy = Math.sin(yaw);
          pv.set(px + lx * cy + lz * sy, C.y + ly, pz - lx * sy + lz * cy);
          qYaw.setFromAxisAngle(yAxis, yaw);
          if (tiltX) {
            qTilt.setFromAxisAngle(xAxis, tiltX);
            q.multiplyQuaternions(qYaw, qTilt);
          } else q.copy(qYaw);
          arr.push(new THREE.Matrix4().compose(pv, q, sv));
        };
        // three stepped tiers (each 4.2 m deep, rising 2.6 m)
        for (let t = 0; t < 3; t++) {
          put(t === 0 ? baseM : tierM, 0, 1.3 + t * 2.6, (t + 0.5) * 4.2);
          // crowd strip on the tier face
          put(crowdM, 0, 1.35 + t * 2.6, (t + 0.5) * 4.2 - 2.12);
          // v21: camera-flash sparkle points on this tier face (world coords)
          for (let f = 0; f < 3; f++) {
            const lx = (Math.random() - 0.5) * 13.5;
            const ly = 1.5 + t * 2.6 + (Math.random() - 0.5) * 1.4;
            const lz = (t + 0.5) * 4.2 - 2.3;
            const cy = Math.cos(yaw), sy = Math.sin(yaw);
            this.flashPts.push(px + lx * cy + lz * sy, C.y + ly, pz - lx * sy + lz * cy);
          }
        }
        // roof + columns (every other segment)
        put(roofM, 0, 11.2, 6.4, -0.08);
        if (sIdx % 2 === 0) {
          for (const cx of [-7.4, 7.4]) {
            put(colM, cx, 5.3, 11.4);   // v21: roof forest of shadows
          }
        }
      }
    }
    // bake the bowl (5 draw calls + shadows; the crowd strips don't cast)
    const bakeBowl = (geo: THREE.BufferGeometry, mat: THREE.Material,
                      mats: THREE.Matrix4[], shadow: boolean): void => {
      if (!mats.length) return;
      const im = new THREE.InstancedMesh(geo, mat, mats.length);
      for (let i = 0; i < mats.length; i++) im.setMatrixAt(i, mats[i]);
      im.instanceMatrix.needsUpdate = true;
      im.castShadow = shadow;
      stands.add(im);
    };
    bakeBowl(tierGeo, standMat, baseM, true);
    bakeBowl(tierGeo, tierMat, tierM, true);
    bakeBowl(crowdGeo, crowdMat, crowdM, false);
    bakeBowl(roofGeo, roofMat, roofM, true);
    bakeBowl(colGeo, colMat, colM, true);
    // FORO SOL fascia over the main (middle) stand
    {
      const a = startA + span / 2;
      const px = C.x + Math.sin(a) * (ringR + 12), pz = C.z + Math.cos(a) * (ringR + 12);
      if (this.clearOfTrack(px, pz, 12)) {
        const bannerTex = (() => {
          const cv = document.createElement('canvas');
          cv.width = 512; cv.height = 64;
          const ctx = cv.getContext('2d')!;
          ctx.fillStyle = '#0d6e4f';
          ctx.fillRect(0, 0, 512, 64);
          ctx.fillStyle = '#ffffff';
          ctx.font = '900 40px "Arial Black", Arial, sans-serif';
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText('F O R O   S O L', 256, 34);
          const t = new THREE.CanvasTexture(cv);
          t.colorSpace = THREE.SRGBColorSpace;
          return t;
        })();
        this.disposables.push(bannerTex);
        const bMat = new THREE.MeshBasicMaterial({ map: bannerTex });
        this.disposables.push(bMat);
        const bGeo = new THREE.PlaneGeometry(30, 3.6);
        this.disposables.push(bGeo);
        const banner = new THREE.Mesh(bGeo, bMat);
        banner.position.set(px, C.y + 9.6, pz);
        banner.rotation.y = a + Math.PI;              // face the field
        stands.add(banner);
        void fasciaMat;                               // (kept for future trim)
      }
    }
    // light clusters that read at night
    if (this.weather === 'night') {
      const lMat = new THREE.MeshBasicMaterial({ color: 0xfff2cc });
      this.disposables.push(lMat);
      for (let sIdx = 1; sIdx < SEG; sIdx += 3) {
        const a = startA + (sIdx / (SEG - 1)) * span;
        const px = C.x + Math.sin(a) * (ringR + 9), pz = C.z + Math.cos(a) * (ringR + 9);
        const lGeo = new THREE.BoxGeometry(3.4, 0.5, 0.7);
        this.disposables.push(lGeo);
        const lamp = new THREE.Mesh(lGeo, lMat);
        lamp.position.set(px, C.y + 12.4, pz);
        lamp.rotation.y = a + Math.PI;
        stands.add(lamp);
      }
    }
    this.group.add(stands);
  }

  // ------------------------------------------------------------------ meshes
  private ribbon(latA: (i: number) => number, latB: (i: number) => number,
    yOff: number, mat: THREE.Material, vScale: number, mask?: (i: number) => boolean): THREE.Mesh {
    const N = SAMPLES;
    const pos: number[] = [], uv: number[] = [], idx: number[] = [];
    const usable: boolean[] = [];
    for (let i = 0; i < N; i++) usable[i] = !mask || mask(i);
    // segment i connects sample i → i+1; include if either end usable
    for (let i = 0; i < N; i++) {
      if (!usable[i] && !usable[(i + 1) % N]) continue;
      const a = this.spline.samples[i];
      const b = this.spline.samples[(i + 1) % N];
      const la = latA(i), lb = latB(i);
      const la2 = latA((i + 1) % N), lb2 = latB((i + 1) % N);
      const base = pos.length / 3;
      pos.push(
        a.pos.x + a.right.x * la, a.pos.y + yOff, a.pos.z + a.right.z * la,
        a.pos.x + a.right.x * lb, a.pos.y + yOff, a.pos.z + a.right.z * lb,
        b.pos.x + b.right.x * la2, b.pos.y + yOff, b.pos.z + b.right.z * la2,
        b.pos.x + b.right.x * lb2, b.pos.y + yOff, b.pos.z + b.right.z * lb2,
      );
      const v0 = i * vScale;
      uv.push(0, v0, 1, v0, 0, v0 + vScale, 1, v0 + vScale);
      idx.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    this.disposables.push(geo);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    this.group.add(mesh);
    return mesh;
  }

  /** Real photo texture (shared, never disposed here) or procedural fallback. */
  private roadPhoto(): THREE.Texture | null { return F1Assets.textures?.road ?? null; }

  private buildRoad(): void {
    const photo = this.roadPhoto();
    const tex = photo ?? asphaltTexture();
    const wet = this.weather === 'rain';
    const rough = wet ? asphaltRoughnessWet() : asphaltRoughness();
    // WET ROAD v18 (v16 values): dielectric water film — near-zero metalness
    // (water mirrors the sky bright), LOW roughness, STRONG env reflections
    // and a full CLEARCOAT with ANIMATED RIPPLE NORMAL MAPS (dual maps
    // scrolled + alternated by the rain system every frame — living water).
    // The wet roughness map carries mirror PUDDLES so the sky visibly patches
    // on the road even under a flat overcast env.
    const [rippleA] = wet ? rippleNormalPair() : [null];
    const mat = wet
      ? new THREE.MeshPhysicalMaterial({
          map: tex, roughnessMap: rough, roughness: 0.15, metalness: 0.02,
          bumpMap: tex, bumpScale: 0.02,
          envMapIntensity: 2.6, side: THREE.DoubleSide,
          clearcoat: 1.0, clearcoatRoughness: 0.06,
          ...(rippleA ? {
            clearcoatNormalMap: rippleA,
            clearcoatNormalScale: new THREE.Vector2(0.4, 0.4),
          } : {}),
          // LIFTED: the photo asphalt is dark (mean 88/255) — without a >1
          // multiplier the albedo lands ≈0.04 linear = near-black, the road
          // swallows every shadow. 1.1× ≈ sunlit wet tarmac.
          color: photo ? new THREE.Color(1.10, 1.11, 1.15) : 0x6a6c74,
        })
      : new THREE.MeshStandardMaterial({
          map: tex, roughnessMap: rough, roughness: 0.85, metalness: 0.04,
          bumpMap: tex, bumpScale: 0.045,   // micro-relief: aggregate & patches
          envMapIntensity: 0.75, side: THREE.DoubleSide,
          // BRIGHT SUNLIT ASPHALT: photo mean 88/255 × old 0xb4b6ba tint gave
          // albedo 0.044 linear — nearly black, shadows invisible on it.
          // >1 multiplier → albedo ≈0.15: mid-grey tarmac with DEEP readable
          // sun shadows (the user's "realistic sun, everything with shadows")
          color: photo ? new THREE.Color(1.24, 1.24, 1.28) : 0xffffff,
        });
    this.disposables.push(mat, rough);
    if (!photo) this.disposables.push(tex);
    if (wet) this.wetRoadMat = mat as THREE.MeshPhysicalMaterial;
    // v21: crisp asphalt at grazing angles (the long straight ahead of you)
    tex.anisotropy = 8; tex.needsUpdate = true;
    this.ribbon(
      i => -this.spline.samples[i].halfWidth,
      i => this.spline.samples[i].halfWidth,
      0.0, mat, this.spline.length / SAMPLES / 11);
    // white edge lines (wider — thick, readable track limits)
    const lineMat = new THREE.MeshStandardMaterial({ color: 0xf4f4f6, roughness: 0.7 });
    this.disposables.push(lineMat);
    for (const side of [-1, 1]) {
      this.ribbon(
        i => side * (this.spline.samples[i].halfWidth - 0.62),
        i => side * (this.spline.samples[i].halfWidth - 0.12),
        0.015, lineMat, this.spline.length / SAMPLES / 8);
    }
  }

  private buildKerbs(): void {
    const photo = F1Assets.textures?.kerb ?? null;
    const tex = photo ?? kerbTexture();
    tex.anisotropy = 8; tex.needsUpdate = true;   // v21: kerbs crisp at distance
    const wet = this.weather === 'rain';
    const mat = new THREE.MeshStandardMaterial({
      map: tex, roughness: wet ? 0.3 : 0.55, metalness: wet ? 0.1 : 0.05,
      envMapIntensity: wet ? 1.6 : 0.7, side: THREE.DoubleSide,
    });
    this.disposables.push(mat);
    if (!photo) this.disposables.push(tex);
    for (const side of [-1, 1]) {
      const mask = side < 0 ? (i: number) => !!this.kerbL[i] : (i: number) => !!this.kerbR[i];
      // v27 STREET: slimmer kerbs — the wall comes right to the kerb edge
      const kw = this.def.street ? 1.0 : KERB_W;
      this.ribbon(
        i => side * this.spline.samples[i].halfWidth,
        i => side * (this.spline.samples[i].halfWidth + kw),
        0.055, mat, this.spline.length / SAMPLES / 1.9, mask);
    }
  }

  private buildRunoffs(): void {
    const asphaltTex = runoffTexture();
    const gravelTex = gravelTexture();
    const wet = this.weather === 'rain';
    const asphaltMat = new THREE.MeshStandardMaterial({
      map: asphaltTex, roughness: wet ? 0.4 : 0.9, metalness: 0.02, envMapIntensity: wet ? 1.2 : 0.5,
      side: THREE.DoubleSide,
    });
    const gravelMat = new THREE.MeshStandardMaterial({ map: gravelTex, roughness: 1.0, metalness: 0, side: THREE.DoubleSide });
    this.disposables.push(asphaltMat, gravelMat, asphaltTex, gravelTex);
    for (const side of [-1, 1]) {
      const mask = (i: number): boolean => {
        const onThisSide = this.runoffSide[i] === side && this.runoffEff[i] > 1.5;
        return onThisSide;
      };
      const asphaltMask = (i: number): boolean => mask(i) && this.runoffType[i] === 'runoff';
      const gravelMask = (i: number): boolean => mask(i) && this.runoffType[i] === 'gravel';
      const from = (i: number): number =>
        side * (this.spline.samples[i].halfWidth + KERB_W);
      const to = (i: number): number =>
        side * (this.spline.samples[i].halfWidth + KERB_W + this.runoffEff[i]);
      // layered ABOVE the grass skirt that now runs underneath everything
      this.ribbon(from, to, -0.012, asphaltMat, this.spline.length / SAMPLES / 12, asphaltMask);
      this.ribbon(from, to, -0.022, gravelMat, this.spline.length / SAMPLES / 9, gravelMask);
    }
  }

  private buildGrass(): void {
    const photo = F1Assets.textures?.grass ?? null;
    const tex = photo ?? grassTexture();
    tex.anisotropy = 8; tex.needsUpdate = true;   // v21: verge detail at grazing angles
    const wet = this.weather === 'rain';
    const mat = new THREE.MeshStandardMaterial({
      map: tex, roughness: 1.0, side: THREE.DoubleSide,
      // LIFTED grass: photo mean 74/255 ≈ 0.07 linear albedo — too dark for
      // sunlit turf. 1.32× ≈ 0.12: fresh green that still takes tree shadows
      color: wet ? new THREE.Color(1.12, 1.18, 1.10) : new THREE.Color(1.32, 1.32, 1.26),
    });
    this.disposables.push(mat);
    if (!photo) this.disposables.push(tex);
    // VERGE FIX: the skirt now runs continuously from the KERB EDGE all the
    // way past the wall — before, it only started AT the wall, leaving a hole
    // between kerb and barrier where you saw the distant ground plane 0.6 m
    // below ("the grass beside the track sits lower"). Also only 3-5 cm
    // below the asphalt instead of a 14 cm cliff.
    for (const side of [-1, 1]) {
      const arr = side < 0 ? this.wallL : this.wallR;
      const y = side < 0 ? -0.05 : -0.035;   // sides differ slightly → no coplanar z-fight
      this.ribbon(
        i => side * (this.spline.samples[i].halfWidth + KERB_W - 0.1),
        i => side < 0
          ? Math.min(arr[i] - 26, -(this.spline.samples[i].halfWidth + KERB_W))
          : Math.max(arr[i] + 26, this.spline.samples[i].halfWidth + KERB_W),
        y, mat, this.spline.length / SAMPLES / 17);
    }
    // distant ground plane (own texture instance — repeat differs)
    const planeTex = photo ? photo.clone() : grassTexture();
    planeTex.repeat.set(200, 200);
    planeTex.needsUpdate = true;
    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(2600, 2600),
      new THREE.MeshStandardMaterial({ map: planeTex, roughness: 1.0, color: new THREE.Color(1.32, 1.32, 1.26) }),
    );
    this.disposables.push(plane.geometry, plane.material as THREE.Material, planeTex);
    plane.rotation.x = -Math.PI / 2;
    plane.receiveShadow = true;           // tree & structure shadows land on the ground
    let minY = Infinity;
    for (const sm of this.spline.samples) minY = Math.min(minY, sm.pos.y);
    plane.position.y = minY - 0.6;
    this.group.add(plane);
  }

  private buildWalls(): void {
    // SOLID THICK BARRIERS: extruded box strips (inner + outer + top faces)
    // instead of a thin plane. The physics matches with true segment
    // collision (wallConstrain) so nothing passes through — even at seams
    // between facing track sections.
    const concrete = new THREE.MeshStandardMaterial({ color: 0xd6d8dc, roughness: 0.78 });
    const tire = new THREE.MeshStandardMaterial({ color: 0x1c1c20, roughness: 0.95 });
    const capRed = new THREE.MeshStandardMaterial({ color: 0xc03028, roughness: 0.7 });
    const capWhite = new THREE.MeshStandardMaterial({ color: 0xeceef0, roughness: 0.7 });
    this.disposables.push(concrete, tire, capRed, capWhite);
    const N = SAMPLES;

    /** push a vertical quad (ax,ay,az)-(bx,by,bz)-(cx,cy,cz)-(dx,dy,dz) */
    const quad = (pos: number[], idx: number[], a: number[], b: number[], c: number[], d: number[]): void => {
      const base = pos.length / 3;
      pos.push(...a, ...b, ...c, ...d);
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };

    const build = (arr: Float32Array, side: 1 | -1): void => {
      // bucket geometries: body / red caps / white caps
      const buckets: Record<string, { pos: number[]; idx: number[] }> = {
        conc: { pos: [], idx: [] }, capR: { pos: [], idx: [] }, capW: { pos: [], idx: [] },
        tire: { pos: [], idx: [] },
      };
      for (let i = 0; i < N; i++) {
        const isTire = this.runoffType[i] === 'gravel' && this.runoffSide[i] === side;
        const a = this.spline.samples[i];
        const b = this.spline.samples[(i + 1) % N];
        const la = arr[i], lb = arr[(i + 1) % N];
        const thick = (isTire ? WALL_THICK_TIRE : WALL_THICK_CONC) * side;
        // inner (track-side) & outer faces
        const iax = a.pos.x + a.right.x * la, iaz = a.pos.z + a.right.z * la;
        const oax = a.pos.x + a.right.x * (la + thick), oaz = a.pos.z + a.right.z * (la + thick);
        const ibx = b.pos.x + b.right.x * lb, ibz = b.pos.z + b.right.z * lb;
        const obx = b.pos.x + b.right.x * (lb + thick), obz = b.pos.z + b.right.z * (lb + thick);
        const ay = a.pos.y - 0.12, by = b.pos.y - 0.12;   // sink the base below the grass
        const h = isTire ? 0.95 : 1.15;
        const bucket = isTire ? buckets.tire : buckets.conc;
        // inner face
        quad(bucket.pos, bucket.idx,
          [iax, ay, iaz], [ibx, by, ibz], [ibx, by + h, ibz], [iax, ay + h, iaz]);
        // outer face
        quad(bucket.pos, bucket.idx,
          [oax, ay, oaz], [obx, by, obz], [obx, by + h, obz], [oax, ay + h, oaz]);
        // top face
        quad(bucket.pos, bucket.idx,
          [iax, ay + h, iaz], [ibx, by + h, ibz], [obx, by + h, obz], [oax, ay + h, oaz]);
        // concrete: striped cap rail on top (red/white every 6 segments)
        if (!isTire) {
          const cap = i % 12 < 6 ? buckets.capR : buckets.capW;
          const ch = 0.16;
          quad(cap.pos, cap.idx,
            [iax, ay + h, iaz], [ibx, by + h, ibz], [ibx, by + h + ch, ibz], [iax, ay + h + ch, iaz]);
        }
      }
      const mats: Record<string, THREE.Material> = { conc: concrete, capR: capRed, capW: capWhite, tire };
      for (const [key, bk] of Object.entries(buckets)) {
        if (!bk.pos.length) continue;
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(bk.pos, 3));
        geo.setIndex(bk.idx);
        geo.computeVertexNormals();
        this.disposables.push(geo);
        const mesh = new THREE.Mesh(geo, mats[key]);
        mesh.material.side = THREE.DoubleSide;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        this.group.add(mesh);
      }
    };
    build(this.wallR, 1);
    build(this.wallL, -1);
  }

  // ================================================================ v27 TUNNEL

  /**
   * v27: arched tunnel over every `tunnel` run (Monaco's signature).
   * Concrete arch tube + entrance/exit portals + ceiling light strips.
   * The arch springs OUTSIDE the circuit walls so the barriers stay the
   * physics boundary — the tunnel is purely visual above the road.
   */
  private buildTunnels(): void {
    const sp = this.spline;
    const N = SAMPLES;
    let any = false;
    for (let i = 0; i < N; i++) if (sp.samples[i].tunnel) { any = true; break; }
    if (!any) return;

    const night = this.weather === 'night';
    const wallMat = new THREE.MeshStandardMaterial({
      color: 0x8f939b, roughness: 0.9, metalness: 0.05, side: THREE.DoubleSide,
    });
    const ribMat = new THREE.MeshStandardMaterial({ color: 0x2e323c, roughness: 0.7 });
    const lightMat = new THREE.MeshBasicMaterial({ color: 0xfff2c8 });
    this.disposables.push(wallMat, ribMat, lightMat);

    // runs of consecutive tunnel samples (wrap-aware)
    const runs: { start: number; end: number }[] = [];
    for (let i = 0; i < N; i++) {
      if (!sp.samples[i].tunnel) continue;
      if (!sp.samples[(i - 1 + N) % N].tunnel) {
        let end = i;
        while (sp.samples[(end + 1) % N].tunnel && end < i + N) end = (end + 1) % N;
        runs.push({ start: i, end });
      }
    }

    const vertAt = (i: number, lat: number, h: number): THREE.Vector3 => {
      const sm = sp.samples[i];
      return new THREE.Vector3(
        sm.pos.x + sm.right.x * lat, sm.pos.y + h, sm.pos.z + sm.right.z * lat);
    };

    // arch profile — springs outside the walls (street verge ~ hw+3.6)
    const profile = (hw: number): [number, number][] => [
      [-(hw + 4.6), -0.5],
      [-(hw + 4.6), 2.6],
      [-(hw + 2.6), 4.6],
      [-(hw * 0.4), 6.0],
      [0, 6.7],
      [hw * 0.4, 6.0],
      [hw + 2.6, 4.6],
      [hw + 4.6, 2.6],
      [hw + 4.6, -0.5],
    ];

    for (const run of runs) {
      const len = (run.end - run.start + N) % N;
      const pos: number[] = [], uv: number[] = [], idx: number[] = [];
      for (let k = 0; k <= len + 1; k++) {
        const i = (run.start + k) % N;
        const j = (i + 1) % N;
        const prof = profile(sp.samples[i].halfWidth);
        const profN = profile(sp.samples[j].halfWidth);
        const base = pos.length / 3;
        for (let p = 0; p < prof.length; p++) {
          const a = vertAt(i, prof[p][0], prof[p][1]);
          const b = vertAt(j, profN[p][0], profN[p][1]);
          pos.push(a.x, a.y, a.z);
          uv.push(p / (prof.length - 1) * 3, sp.samples[i].dist / 9);
          pos.push(b.x, b.y, b.z);
          uv.push(p / (prof.length - 1) * 3,
            (j <= i ? sp.length : sp.samples[j].dist) / 9);
        }
        for (let p = 0; p < prof.length - 1; p++) {
          const v0 = base + p * 2, v1 = base + p * 2 + 1;
          const v2 = base + (p + 1) * 2, v3 = base + (p + 1) * 2 + 1;
          idx.push(v0, v1, v2, v1, v3, v2);
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      this.disposables.push(geo);
      const tube = new THREE.Mesh(geo, wallMat);
      tube.receiveShadow = true;
      this.group.add(tube);

      // portals (entrance + exit facades)
      for (const at of [run.start, (run.end + 1) % N]) {
        const sm = sp.sampleAt(sp.samples[at].s);
        for (const side of [-1, 1] as const) {
          const pillar = new THREE.Mesh(new THREE.BoxGeometry(1.5, 7.6, 1.5), ribMat);
          this.disposables.push(pillar.geometry);
          pillar.position.copy(sm.pos).addScaledVector(sm.right, side * (sm.halfWidth + 4.1));
          pillar.position.y += 3.5;
          pillar.castShadow = true;
          this.group.add(pillar);
        }
        const beam = new THREE.Mesh(
          new THREE.BoxGeometry((sm.halfWidth + 4.9) * 2, 1.7, 1.5), ribMat);
        this.disposables.push(beam.geometry);
        beam.position.copy(sm.pos).add(new THREE.Vector3(0, 6.9, 0));
        beam.rotation.y = -Math.atan2(sm.tangent.z, sm.tangent.x) + Math.PI / 2;
        beam.castShadow = true;
        this.group.add(beam);
      }

      // ceiling light strips every 5 samples
      const stripGeo = new THREE.BoxGeometry(2.4, 0.14, 0.5);
      this.disposables.push(stripGeo);
      for (let k = 2; k <= len; k += 5) {
        const sm = sp.samples[(run.start + k) % N];
        const strip = new THREE.Mesh(stripGeo, lightMat);
        strip.position.copy(sm.pos).add(new THREE.Vector3(0, 6.25, 0));
        strip.rotation.y = -Math.atan2(sm.tangent.z, sm.tangent.x) + Math.PI / 2;
        this.group.add(strip);
      }
      void night;
    }
  }

  /** Flat painted quad across the road at progress s. */
  private paintQuad(s: number, mat: THREE.Material, length = 1.4): void {
    const sm = this.spline.sampleAt(s);
    const geo = new THREE.PlaneGeometry(sm.halfWidth * 2, length);
    this.disposables.push(geo);
    const m = new THREE.Mesh(geo, mat);
    m.position.set(sm.pos.x, sm.pos.y + 0.025, sm.pos.z);
    m.rotation.set(-Math.PI / 2, 0, 0);
    m.rotateZ(-Math.atan2(sm.tangent.x, sm.tangent.z));
    this.group.add(m);
  }

  private buildLinesAndGrid(): void {
    const checker = checkerTexture();
    checker.repeat.set(8, 2);
    const checkerMat = new THREE.MeshStandardMaterial({ map: checker, roughness: 0.8 });
    this.disposables.push(checkerMat, checker);
    this.paintQuad(0.0005, checkerMat, 1.8);
    // sector lines
    const secMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7 });
    this.disposables.push(secMat);
    for (const sec of this.def.sectors) this.paintQuad(sec, secMat, 0.9);
    // grid slot L-shapes (local: +Z = car forward)
    const boxMat = new THREE.MeshBasicMaterial({ color: 0xf0f0f0 });
    this.disposables.push(boxMat);
    for (const slot of this.gridSlots) {
      const holder = new THREE.Group();
      holder.position.copy(slot.pos).add(new THREE.Vector3(0, 0.028, 0));
      holder.rotation.y = slot.yaw;
      for (const [ox, oz, w, d] of [[-1.6, 0.6, 0.14, 1.2], [1.6, 0.6, 0.14, 1.2], [0, 1.25, 3.3, 0.14]] as const) {
        const geo = new THREE.PlaneGeometry(w, d);
        this.disposables.push(geo);
        const m = new THREE.Mesh(geo, boxMat);
        m.rotation.x = -Math.PI / 2;
        m.position.set(ox, 0, oz);
        holder.add(m);
      }
      this.group.add(holder);
    }
  }

  private buildStartLights(): void {
    const sm = this.spline.sampleAt(0.002);
    const right = sm.right;
    const g = new THREE.Group();
    const postMat = new THREE.MeshStandardMaterial({ color: 0x2a2c30, metalness: 0.7, roughness: 0.4 });
    this.disposables.push(postMat);
    for (const side of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.2, 6.4, 8), postMat);
      this.disposables.push(post.geometry);
      post.position.set(sm.pos.x + right.x * side * (sm.halfWidth + 1.4), sm.pos.y + 3.2, sm.pos.z + right.z * side * (sm.halfWidth + 1.4));
      post.castShadow = true;
      g.add(post);
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(sm.halfWidth * 2 + 3.2, 0.35, 0.35), postMat);
    this.disposables.push(beam.geometry);
    beam.position.set(sm.pos.x, sm.pos.y + 6.3, sm.pos.z);
    beam.rotation.y = Math.atan2(right.x, right.z) + Math.PI / 2;
    beam.castShadow = true;                 // v21: the gantry shadows the grid
    g.add(beam);
    // 5 pods across the beam
    const podMat = new THREE.MeshStandardMaterial({ color: 0x0c0d10, roughness: 0.6 });
    this.disposables.push(podMat);
    const tan = sm.tangent;
    for (let i = 0; i < 5; i++) {
      const pod = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.72, 0.3), podMat);
      this.disposables.push(pod.geometry);
      const off = (i - 2) * 1.05;
      pod.position.set(sm.pos.x + right.x * off, sm.pos.y + 5.6, sm.pos.z + right.z * off);
      pod.rotation.y = Math.atan2(tan.x, tan.z) + Math.PI;   // face the grid (backwards)
      pod.castShadow = true;
      g.add(pod);
      // 2 lamps per pod
      for (const l of [-1, 1]) {
        const lampMat = new THREE.MeshStandardMaterial({
          color: 0x400a0a, emissive: 0xff1a1a, emissiveIntensity: 0, roughness: 0.4,
        });
        this.disposables.push(lampMat);
        const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.13, 10, 8), lampMat);
        this.disposables.push(lamp.geometry);
        const back = tan.clone().multiplyScalar(-0.18);
        lamp.position.set(pod.position.x + right.x * l * 0.16 + back.x, pod.position.y + l * 0.18, pod.position.z + right.z * l * 0.16 + back.z);
        g.add(lamp);
        this.lightPods.push(lamp);
      }
    }
    this.group.add(g);
  }

  /** 0..5 lit pods (5 = all on, 0 = out → GO). */
  setStartLights(n: number): void {
    this.lightPods.forEach((lamp, i) => {
      const pod = Math.floor(i / 2);
      const mat = lamp.material as THREE.MeshStandardMaterial;
      mat.emissiveIntensity = pod < n ? 4.2 : 0;
      mat.color.setHex(pod < n ? 0xff2a2a : 0x400a0a);
    });
  }

  private buildBoards(): void {
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x8a8d94, metalness: 0.6, roughness: 0.5 });
    this.disposables.push(poleMat);
    const place = (s: number, side: 1 | -1, tex: THREE.Texture, w = 1.6, h = 1.2, tall = 2.6): void => {
      this.disposables.push(tex);
      const sm = this.spline.sampleAt(s);
      const lat = side * (sm.halfWidth + 3.4);
      const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.65 });
      this.disposables.push(mat);
      const board = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
      this.disposables.push(board.geometry);
      board.position.set(sm.pos.x + sm.right.x * lat, sm.pos.y + tall, sm.pos.z + sm.right.z * lat);
      board.rotation.y = Math.atan2(sm.tangent.x, sm.tangent.z) + Math.PI;  // face oncoming
      board.castShadow = true;               // v21: boards shadow the runoff
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, tall, 6), poleMat);
      this.disposables.push(pole.geometry);
      pole.position.set(sm.pos.x + sm.right.x * lat, sm.pos.y + tall / 2, sm.pos.z + sm.right.z * lat);
      pole.castShadow = true;
      this.group.add(board, pole);
    };
    // DRS zone boards
    for (const z of this.def.drsZones) {
      place(z.detect, 1, boardTexture('drs'));
      place(z.start, 1, boardTexture('drs'));
      place(z.end, -1, boardTexture('chevron'), 1.2, 1.0);
    }
    // brake markers at the biggest stops (curvature jumps ahead)
    const N = SAMPLES;
    const drops: { s: number; drop: number }[] = [];
    for (let i = 0; i < N; i++) {
      const ahead = (i + 12) % N;
      const drop = Math.abs(this.curvature[ahead]) - Math.abs(this.curvature[i]);
      if (drop > 0.009 && Math.abs(this.curvature[i]) < 0.002 && Math.abs(this.curvature[ahead]) > 0.012) {
        drops.push({ s: this.spline.samples[i].s, drop });
      }
    }
    drops.sort((a, b) => b.drop - a.drop);
    const placed = drops.slice(0, 4);
    for (const d of placed) {
      const back100 = ((d.s - 100 / this.spline.length) % 1 + 1) % 1;
      const back50 = ((d.s - 50 / this.spline.length) % 1 + 1) % 1;
      place(back100, 1, boardTexture('brake', '100'), 1.1, 1.3);
      place(back50, 1, boardTexture('brake', '50'), 0.95, 1.15);
    }
  }

  /** True when (x,z) keeps `margin` meters of clearance from EVERY track
   *  section — the anti-"grandstand growing out of the road" check.
   *  skipFrom/skipTo (circular index window) excludes the pit's own straight. */
  clearOfTrackPub(x: number, z: number, margin: number, skipFrom?: number, skipTo?: number): boolean {
    return this.clearOfTrack(x, z, margin, skipFrom, skipTo);
  }

  /** True when (x,z) keeps `margin` meters of clearance from EVERY track
   *  section — the anti-"grandstand growing out of the road" check. */
  private clearOfTrack(x: number, z: number, margin: number, skipFrom?: number, skipTo?: number): boolean {
    const N = SAMPLES;
    const inSkip = (j: number): boolean => {
      if (skipFrom === undefined || skipTo === undefined) return false;
      // circular containment [skipFrom..skipTo] (wraps through 0)
      const circ = (a: number, b: number): number => ((a - b) % N + N) % N;
      return circ(j, skipFrom) <= circ(skipTo, skipFrom);
    };
    for (let j = 0; j < N; j++) {
      if (inSkip(j)) continue;
      const sm = this.spline.samples[j];
      const dx = x - sm.pos.x, dz = z - sm.pos.z;
      const lim = sm.halfWidth + margin;
      if (dx * dx + dz * dz < lim * lim) return false;
    }
    return true;
  }

  private buildEnv(decorScale: number, crowdScale: number): void {
    // ---- pit building along the main straight ------------------------------
    // (v17: superseded by the full pit complex — garages + lane + fence —
    //  built by buildPitVisuals. Only circuits WITHOUT a pit lane keep the
    //  old standalone building so the straight never looks empty.)
    if (!this.pit) {
    const smMid = this.spline.sampleAt(0.995);
    const side = new THREE.Vector3(-smMid.right.x, 0, -smMid.right.z);   // left of the road
    const lat = smMid.halfWidth + 16;
    const buildYaw = Math.atan2(smMid.tangent.x, smMid.tangent.z) + Math.PI / 2;
    // clearance: the 180 m box must not touch another track section
    let buildOk = true;
    for (let d = -85; d <= 85 && buildOk; d += 17) {
      const x = smMid.pos.x + side.x * lat + smMid.tangent.x * d;
      const z = smMid.pos.z + side.z * lat + smMid.tangent.z * d;
      if (!this.clearOfTrack(x, z, 8)) buildOk = false;
    }
    if (buildOk) {
      const build = new THREE.Mesh(
        new THREE.BoxGeometry(180, 9, 12),
        new THREE.MeshStandardMaterial({ color: 0x3a3f4a, roughness: 0.6, metalness: 0.15 }),
      );
      this.disposables.push(build.geometry, build.material as THREE.Material);
      build.position.set(smMid.pos.x + side.x * lat, smMid.pos.y + 4.5, smMid.pos.z + side.z * lat);
      build.rotation.y = buildYaw;
      build.castShadow = true;
      this.group.add(build);
      const glass = new THREE.Mesh(
        new THREE.BoxGeometry(179, 2.6, 0.4),
        new THREE.MeshStandardMaterial({ color: 0x9fd4e8, metalness: 0.6, roughness: 0.15, emissive: 0x223844, emissiveIntensity: this.weather === 'night' ? 1.6 : 0.3 }),
      );
      this.disposables.push(glass.geometry, glass.material as THREE.Material);
      glass.position.copy(build.position).add(new THREE.Vector3(side.x * 6.2, 1.2, side.z * 6.2));
      glass.rotation.y = buildYaw;
      glass.castShadow = true;
      this.group.add(glass);
    }
    }

    if (decorScale < 0.3) return;

    // ---- v27 STREET BUILDINGS (Monaco): the city canyon -------------------
    // Street circuits are defined by buildings at the kerb. One InstancedMesh
    // of facade-textured boxes (per-instance color) hugging both sides of
    // the lap: the sea side of the harbor stays open (quay + yachts), the
    // pit complex s-range is left to the pit visuals, everything else that
    // clears another track section gets a building.
    if (this.def.street) {
      const N2 = SAMPLES;
      const off = this.def.seaOffset ?? [480, 0];
      const cx2 = this.spline.samples.reduce((a, s) => a + s.pos.x, 0) / N2;
      const cz2 = this.spline.samples.reduce((a, s) => a + s.pos.z, 0) / N2;
      const seaX = cx2 + off[0], seaZ = cz2 + off[1];
      const pitFrom = this.pit ? this.pit.entryS : -1;
      const pitTo = this.pit ? this.pit.exitS : -1;
      const inPitRange = (s: number): boolean => {
        if (pitFrom < 0) return false;
        const wrap = (a: number, b: number) => ((a - b) % 1 + 1) % 1;
        return wrap(s, pitFrom) <= wrap(pitTo, pitFrom);
      };

      // facade texture: window grid on white (tinted per instance)
      const fc = document.createElement('canvas');
      fc.width = 64; fc.height = 64;
      const fg = fc.getContext('2d')!;
      fg.fillStyle = '#ffffff'; fg.fillRect(0, 0, 64, 64);
      for (let wy = 0; wy < 5; wy++) {
        for (let wx = 0; wx < 4; wx++) {
          const lit = this.weather === 'night' && ((wx * 7 + wy * 13) % 5 < 2);
          fg.fillStyle = lit ? '#ffe9a8' : '#3d434e';
          fg.fillRect(6 + wx * 14, 7 + wy * 12, 9, 7);
        }
      }
      fg.fillStyle = '#00000022'; fg.fillRect(0, 0, 64, 5);   // roof band
      const facadeTex = new THREE.CanvasTexture(fc);
      facadeTex.colorSpace = THREE.SRGBColorSpace;
      this.disposables.push(facadeTex);
      const facadeMat = new THREE.MeshStandardMaterial({
        color: 0xffffff, map: facadeTex, roughness: 0.85,
      });
      this.disposables.push(facadeMat);

      const tones = [0xe8dcc8, 0xdfd0b8, 0xd8c8a8, 0xcfc4b4, 0xe2d4c0, 0xc9bfae, 0xd9cbb2];
      const boxGeo = new THREE.BoxGeometry(1, 1, 1);
      this.disposables.push(boxGeo);
      const mats: THREE.Matrix4[] = [];
      const cols: THREE.Color[] = [];
      const pv = new THREE.Vector3(), sv = new THREE.Vector3(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
      let placedB = 0;
      for (let i = 0; i < N2; i += 3) {
        const sm = this.spline.samples[i];
        const sHere = sm.s;
        for (const side of [-1, 1] as const) {
          // skip the pit side through the pit complex range
          if (this.pit && side === this.pit.side && inPitRange(sHere)) continue;
          // keep the waterfront open: no buildings on the sea-facing side
          const dxs = seaX - sm.pos.x, dzs = seaZ - sm.pos.z;
          const dSea = Math.hypot(dxs, dzs);
          if (dSea < 260 && (sm.right.x * side * dxs + sm.right.z * side * dzs) / (dSea || 1) > 0.35) continue;
          const wallAbs = Math.max(Math.abs(this.wallR[i]), Math.abs(this.wallL[i]));
          const depth = 9 + (i % 3) * 2.5;
          const lat = side * (wallAbs + 4.2 + depth / 2);
          const bx = sm.pos.x + sm.right.x * lat, bz = sm.pos.z + sm.right.z * lat;
          if (!this.clearOfTrack(bx, bz, 3)) continue;
          const floors = 3 + ((i * 7 + (side > 0 ? 3 : 0)) % 5);       // 3..7
          const h = floors * 3.1;
          const wdt = 11 + ((i * 13 + (side > 0 ? 5 : 0)) % 4) * 2.4;  // 11..18
          pv.set(bx, sm.pos.y + h / 2 - 0.3, bz);
          sv.set(wdt, h, depth);
          q.setFromAxisAngle(up, Math.atan2(sm.tangent.x, sm.tangent.z));
          mats.push(new THREE.Matrix4().compose(pv, q, sv));
          cols.push(new THREE.Color(tones[(i + (side > 0 ? 2 : 0)) % tones.length]));
          placedB++;
        }
      }
      if (mats.length) {
        const im = new THREE.InstancedMesh(boxGeo, facadeMat, mats.length);
        for (let k = 0; k < mats.length; k++) im.setMatrixAt(k, mats[k]);
        for (let k = 0; k < cols.length; k++) im.setColorAt(k, cols[k]);
        im.instanceMatrix.needsUpdate = true;
        if (im.instanceColor) im.instanceColor.needsUpdate = true;
        im.castShadow = true;
        im.receiveShadow = true;
        this.group.add(im);
      }
    }

    // ---- grandstands at the top curvature clusters ---------------------------
    if (crowdScale > 0.25) {
      const N = SAMPLES;
      const hot: number[] = [];
      for (let i = 0; i < N; i += 6) {
        if (Math.abs(this.curvature[i]) > 0.008) hot.push(i);
      }
      const clusters: number[] = [];
      for (const i of hot) {
        if (!clusters.length || this.arcDist(clusters[clusters.length - 1], i) > 34) clusters.push(i);
        if (clusters.length >= 5) break;
      }
      const crowdTex = crowdTexture();
      this.disposables.push(crowdTex);
      for (const i of clusters) {
        const sm = this.spline.samples[i];
        const outSide = this.curvature[i] > 0 ? 1 : -1;
        // push outward until BOTH wing tips clear every track section (a 46 m
        // stand on a hairpin used to curl right across the road)
        let lat = (outSide > 0 ? this.wallR[i] : -this.wallL[i]) + 10;
        let ok = false;
        for (let tries = 0; tries < 4 && !ok; tries++, lat += 14) {
          const px = sm.pos.x + sm.right.x * lat, pz = sm.pos.z + sm.right.z * lat;
          // wing axis ≈ perpendicular to the line from stand to track point
          const dirX = sm.pos.x - px, dirZ = sm.pos.z - pz;
          const dl = Math.hypot(dirX, dirZ) || 1;
          const wx = -dirZ / dl, wz = dirX / dl;
          ok = this.clearOfTrack(px, pz, 5)
            && this.clearOfTrack(px + wx * 21, pz + wz * 21, 6)
            && this.clearOfTrack(px - wx * 21, pz - wz * 21, 6);
        }
        if (!ok) continue;   // no room for a stand here — skip it
        const crowdMat = new THREE.MeshBasicMaterial({ map: crowdTex.clone() });
        crowdMat.map!.repeat.set(9, 3);
        crowdMat.map!.needsUpdate = true;
        this.disposables.push(crowdMat, crowdMat.map!);
        this.crowdMats.push(crowdMat);
        const stand = new THREE.Group();
        const body = new THREE.Mesh(
          new THREE.BoxGeometry(46, 7.5, 12),
          new THREE.MeshStandardMaterial({ color: 0x2c3038, roughness: 0.85 }),
        );
        this.disposables.push(body.geometry, body.material as THREE.Material);
        body.position.y = 3.4;
        body.castShadow = true;
        body.receiveShadow = true;            // v21: stands take tree/roof shadows
        stand.add(body);
        const crowd = new THREE.Mesh(new THREE.PlaneGeometry(44, 6), crowdMat);
        this.disposables.push(crowd.geometry);
        crowd.position.set(0, 5.2, 6.2);
        stand.add(crowd);
        const roof = new THREE.Mesh(
          new THREE.BoxGeometry(48, 0.5, 13),
          new THREE.MeshStandardMaterial({ color: 0xd8dae0, roughness: 0.6, metalness: 0.2 }),
        );
        this.disposables.push(roof.geometry, roof.material as THREE.Material);
        roof.position.y = 8.4;
        roof.castShadow = true;
        roof.receiveShadow = true;
        stand.add(roof);
        // v21: two waving flags on the roofline — the broadcast detail
        const flagTexs = flagTextures();
        for (const fx of [-17, 17]) {
          const fGeo = new THREE.PlaneGeometry(1.7, 1.05, 12, 5);
          this.disposables.push(fGeo);
          const f = new THREE.Mesh(fGeo, this.makeFlagMaterial(flagTexs[(i + (fx > 0 ? 1 : 3)) % flagTexs.length]));
          f.position.set(fx, 9.9, 0.6);
          f.rotation.y = Math.PI * (fx > 0 ? 0.5 : -0.5);
          f.castShadow = true;
          stand.add(f);
        }
        const dirx = sm.right.x * lat, dirz = sm.right.z * lat;
        stand.position.set(sm.pos.x + dirx, sm.pos.y, sm.pos.z + dirz);
        stand.lookAt(sm.pos.x, sm.pos.y, sm.pos.z);
        this.group.add(stand);
        // v21: camera-flash points across the crowd plane (world coords)
        stand.updateMatrixWorld(true);
        const scratch = new THREE.Vector3();
        for (let f = 0; f < 18; f++) {
          scratch.set((Math.random() - 0.5) * 42, 5.2 + (Math.random() - 0.5) * 5.4, 6.45);
          stand.localToWorld(scratch);
          this.flashPts.push(scratch.x, scratch.y, scratch.z);
        }
      }
    }

    // ---- trees -----------------------------------------------------------------
    // Mixed woodland: 3-tier flat-shaded conifers + round noise-blob
    // deciduous trees — variety reads as real woodland instead of a cone farm.
    const treeCount = Math.round(120 * decorScale);
    const trunkGeo = new THREE.CylinderGeometry(0.18, 0.32, 2.6, 6);
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x54422e, roughness: 1 });
    const crownTiers: [number, number, number][] = [
      [2.3, 3.1, 0.0],    // radius, height, base offset (in tiers)
      [1.75, 2.6, 1.9],
      [1.15, 2.2, 3.7],
    ];
    const crownGeos = crownTiers.map(([r, h]) => new THREE.ConeGeometry(r, h, 7));
    // deciduous crown: icosahedron blob with vertex noise (shared geometry)
    const blobGeo = new THREE.IcosahedronGeometry(2.1, 1);
    {
      const pa = blobGeo.attributes.position as THREE.BufferAttribute;
      for (let v = 0; v < pa.count; v++) {
        const vx = pa.getX(v), vy = pa.getY(v), vz = pa.getZ(v);
        const n = 1 + Math.sin(vx * 2.1 + vy * 1.3) * 0.16 + Math.cos(vz * 2.7 + vx) * 0.12;
        pa.setXYZ(v, vx * n * 1.15, vy * n * 0.8, vz * n * 1.15);   // squashed dome
      }
      blobGeo.computeVertexNormals();
    }
    const greens = this.def.env === 'alpine'
      ? [0x2c4f34, 0x35593c, 0x274830]
      : this.def.env === 'parkland'
      ? [0x33582e, 0x3c6a36, 0x2b4f2a]
      : this.def.env === 'highland'
      ? [0x6b6f3f, 0x77794a, 0x5d6238]
      : this.def.env === 'prairie'
      ? [0x5a6b36, 0x6a7742, 0x4f5e30]   // v26 Texas: dry-green prairie with brown undertone
      : [0x39682f, 0x42733a, 0x315d2c];
    // deciduous tones (lighter, yellower) — dry olive in the highlands,
    // warm late-season foliage on the Texas prairie
    const leafTones = this.def.env === 'highland'
      ? [0x8f8a4e, 0x9b9257, 0x7d7a45]
      : this.def.env === 'prairie'
      ? [0x7d8046, 0x8a8a50, 0x6e723b]
      : [0x4a7a35, 0x568843, 0x40702e];
    const foliage = foliageTexture();                     // shared, cached — never disposed here
    // v22 PERF: ONE material per part, white base — the tone variety the old
    // 3-material split provided now comes from per-instance COLORS, so the
    // whole woodland bakes into 5 InstancedMeshes (1 trunk + 3 tiers + blob)
    const crownMat = new THREE.MeshStandardMaterial({
      color: 0xffffff, map: foliage, roughness: 1, flatShading: true,
    });
    const leafMat = new THREE.MeshStandardMaterial({
      color: 0xffffff, map: foliage, roughness: 1, flatShading: true,
    });
    // v21: living woodland — every crown sways in the wind (vertex shader,
    // phase from world position so no two trees move in lockstep)
    this.applyFoliageWind(crownMat);
    this.applyFoliageWind(leafMat);
    this.disposables.push(trunkGeo, trunkMat, blobGeo, ...crownGeos, crownMat, leafMat);
    const N = SAMPLES;
    // placement pass — collect transforms + tones, then bake the instances
    const trunkM: THREE.Matrix4[] = [];
    const coneM: THREE.Matrix4[][] = [[], [], []];
    const coneC: THREE.Color[][] = [[], [], []];
    const blobM: THREE.Matrix4[] = [];
    const blobC: THREE.Color[] = [];
    {
      const q = new THREE.Quaternion();
      const yAxis = new THREE.Vector3(0, 1, 0);
      const sv = new THREE.Vector3();
      const pv = new THREE.Vector3();
      let placed = 0;
      for (let k = 0; k < treeCount * 3 && placed < treeCount; k++) {
        const i = Math.floor((k / (treeCount * 3)) * N * 2.7) % N;
        const sm = this.spline.samples[i];
        const side = k % 2 === 0 ? 1 : -1;
        const wall = side > 0 ? this.wallR[i] : -this.wallL[i];
        // v20: trees hug the barriers (3-38 m out) — with the wider road the old
        // 10-50 m stand left their shadows short of the asphalt; close trees
        // now STRIPE the track with sun shadow (the Monza parkland look)
        const lat = side * (wall + 3 + Math.random() * 35);
        const x = sm.pos.x + sm.right.x * lat;
        const z = sm.pos.z + sm.right.z * lat;
        if (!this.clearOfTrack(x, z, 4)) continue;   // never on (or hanging over) the road
        placed++;
        const y = sm.pos.y - 0.1;
        const s = 0.75 + Math.random() * 0.9;
        const conifer = placed % 5 < 3;              // ~60% conifers / 40% round
        const tone = (pool: number[]): THREE.Color =>
          new THREE.Color(pool[placed % pool.length]);
        // trunk
        pv.set(x, y + 1.3 * s, z); sv.setScalar(s); q.identity();
        trunkM.push(new THREE.Matrix4().compose(pv, q, sv));
        if (conifer) {
          for (let t = 0; t < crownTiers.length; t++) {
            const [r, h, base] = crownTiers[t];
            pv.set(x, y + (base + h * 0.5 + 0.9) * s, z);
            sv.set(s * (0.9 + Math.random() * 0.2), s * (0.9 + Math.random() * 0.25), s);
            q.setFromAxisAngle(yAxis, Math.random() * Math.PI);
            coneM[t].push(new THREE.Matrix4().compose(pv, q, sv));
            coneC[t].push(tone(greens));
          }
        } else {
          pv.set(x, y + (2.9 + 1.4) * s, z);
          sv.set(s * (0.9 + Math.random() * 0.35), s * (0.85 + Math.random() * 0.3), s * (0.9 + Math.random() * 0.35));
          q.setFromAxisAngle(yAxis, Math.random() * Math.PI);
          blobM.push(new THREE.Matrix4().compose(pv, q, sv));
          blobC.push(tone(leafTones));
        }
      }
    }
    // bake the forest: 5 draw calls for ~120 trees (was ~380 meshes — main
    // AND shadow pass each paid a draw call per mesh before)
    const bake = (geo: THREE.BufferGeometry, mat: THREE.Material,
                  mats: THREE.Matrix4[], cols?: THREE.Color[]): void => {
      if (!mats.length) return;
      const im = new THREE.InstancedMesh(geo, mat, mats.length);
      for (let i = 0; i < mats.length; i++) im.setMatrixAt(i, mats[i]);
      if (cols) for (let i = 0; i < cols.length; i++) im.setColorAt(i, cols[i]);
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      im.castShadow = true;               // every tree shadows the ground
      this.group.add(im);
    };
    bake(trunkGeo, trunkMat, trunkM);
    for (let t = 0; t < crownGeos.length; t++) bake(crownGeos[t], crownMat, coneM[t], coneC[t]);
    bake(blobGeo, leafMat, blobM, blobC);
  }

  private buildBackdrop(): void {
    // distant ring of mountains — ALWAYS beyond the outermost track point
    // (the old fixed 700 m radius cut straight across the long circuits)
    const N = SAMPLES;
    let cx = 0, cz = 0, minY = Infinity, maxR = 0;
    for (const sm of this.spline.samples) {
      cx += sm.pos.x; cz += sm.pos.z; minY = Math.min(minY, sm.pos.y);
    }
    cx /= N; cz /= N;
    for (const sm of this.spline.samples) {
      maxR = Math.max(maxR, Math.hypot(sm.pos.x - cx, sm.pos.z - cz));
    }
    const night = this.weather === 'night';
    const alpine = this.def.env === 'alpine';
    const baseTone = alpine ? (night ? 0x2c3648 : 0x8fa3bd)
      : this.def.env === 'coast' ? (night ? 0x22303c : 0x6f8f6a)
      : this.def.env === 'parkland' ? (night ? 0x1d2618 : 0x53743e)
      : this.def.env === 'highland' ? (night ? 0x242019 : 0x8a815a)
        : (night ? 0x25302a : 0x5d7050);
    // three slightly different rock tones → layered ridges, not clone-stamped
    const rockMats = [0, 1, 2].map(i => {
      const c = new THREE.Color(baseTone);
      c.offsetHSL(0, 0, (i - 1) * 0.035);
      return new THREE.MeshStandardMaterial({ color: c, roughness: 1, flatShading: true });
    });
    const snowMat = new THREE.MeshStandardMaterial({ color: night ? 0x9aa8c4 : 0xf2f5fa, roughness: 0.9 });
    this.disposables.push(...rockMats, snowMat);

    /** one mountain = 3-4 overlapping elongated cones with FULL vertex-noise
     *  displacement — every vertex is jittered (two noise scales) so the
     *  straight cone edges break into fractured rock. Reads as a ridge. */
    const range = (cxm: number, czm: number, ang: number, r: number, hMax: number, snow: boolean): void => {
      const g = new THREE.Group();
      const peaks = 3 + Math.floor(Math.random() * 2);
      const tangent = ang + Math.PI / 2;
      for (let p = 0; p < peaks; p++) {
        const h = hMax * (0.55 + Math.random() * 0.45);
        const geo = new THREE.ConeGeometry(h * (0.85 + Math.random() * 0.35), h, 14, 3);
        // full-volume noise: radial + vertical jitter on EVERY vertex
        const pa = geo.attributes.position as THREE.BufferAttribute;
        const seedR = Math.random() * 100;
        for (let v = 0; v < pa.count; v++) {
          const vx = pa.getX(v), vy = pa.getY(v), vz = pa.getZ(v);
          const n1 = Math.sin(vx * 0.35 + seedR) * Math.cos(vz * 0.41 + seedR * 1.7);
          const n2 = Math.sin(vx * 1.3 + seedR * 2.1) * Math.sin(vz * 1.7 + seedR * 0.6);
          const rr = 1 + n1 * 0.34 + n2 * 0.2;
          pa.setX(v, vx * rr);
          pa.setZ(v, vz * rr);
          pa.setY(v, vy + n2 * h * 0.08);           // broken crest line
        }
        geo.computeVertexNormals();
        this.disposables.push(geo);
        const m = new THREE.Mesh(geo, rockMats[(p + peaks) % 3]);
        const along = (p - (peaks - 1) / 2) * h * 0.75;
        m.position.set(Math.cos(tangent) * along, h / 2 - 4, Math.sin(tangent) * along);
        m.scale.set(0.8 + Math.random() * 0.3, 1, 2.1 + Math.random() * 1.6);  // elongated along the ridge
        m.rotation.y = Math.random() * 0.4 - 0.2;
        g.add(m);
        // snow cap on the tall peaks (alpine look)
        if (snow && h > hMax * 0.72) {
          const capGeo = new THREE.ConeGeometry(h * 0.34, h * 0.36, 14);
          this.disposables.push(capGeo);
          const cap = new THREE.Mesh(capGeo, snowMat);
          cap.position.set(m.position.x, h - h * 0.18 - 4, m.position.z);
          cap.scale.set(0.8, 1, 2.1);
          cap.rotation.y = m.rotation.y;
          g.add(cap);
        }
      }
      g.position.set(cxm + Math.cos(ang) * r, minY - 4, czm + Math.sin(ang) * r);
      g.rotation.y = -ang;
      this.group.add(g);
    };

    // FAR RING — jagged ridge silhouettes: a single strip mesh whose top edge
    // is a 2-octave noise profile. This is how distant ranges actually read
    // from a circuit (a continuous serrated horizon), instead of lone pyramids.
    const ridgeTone = new THREE.Color(baseTone).offsetHSL(0, 0, -0.04);
    const ridgeMat = new THREE.MeshStandardMaterial({
      color: ridgeTone, roughness: 1, side: THREE.DoubleSide,
    });
    this.disposables.push(ridgeMat);
    const buildRidge = (rBase: number, maxH: number, seed: number): void => {
      const SEG = 240;
      const pos: number[] = [], idx: number[] = [];
      for (let i = 0; i <= SEG; i++) {
        const a = (i / SEG) * Math.PI * 2;
        const wob = Math.sin(i * 0.33 + seed) * 90 + Math.sin(i * 0.11 + seed * 2.1) * 140;
        const r = rBase + wob;
        const x = Math.cos(a) * r, z = Math.sin(a) * r;
        // BROAD massifs (slow waves → long mountain groups) with a fine
        // serrated crest on top — a real distant range, not isolated spikes.
        const t = i / SEG * Math.PI * 2;
        const massif = Math.sin(t * 3 + seed) * 0.5 + Math.sin(t * 7 + seed * 2.2) * 0.28
          + Math.sin(t * 11 + seed * 0.7) * 0.16;
        const base = 0.3 + Math.max(0, massif) * 0.62;
        const serr = Math.abs(Math.sin(i * 1.9 + seed * 3.1)) * 0.1
          + Math.abs(Math.sin(i * 3.7 + seed)) * 0.05;
        const h = maxH * (base * 0.88 + serr);
        pos.push(x, 0, z, x, h, z);
        if (i < SEG) {
          const b = i * 2;
          idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      this.disposables.push(geo);
      const m = new THREE.Mesh(geo, ridgeMat);
      m.position.set(cx, minY - 2, cz);
      this.group.add(m);
    };
    buildRidge(maxR + 720, alpine ? 210 : 95, 3.1);    // grand far range
    buildRidge(maxR + 460, alpine ? 130 : 58, 8.7);    // mid range (lighter fog)
    // alpine: a few snow-capped rocky peaks between the ridges and the hills
    if (alpine) {
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2 + 0.7;
        range(cx, cz, a, maxR + 380 + (i % 2) * 90, 150 + (i % 3) * 45, true);
      }
    }

    // NEAR ring — ROLLING HILLS (noise-displaced flattened hemispheres):
    // reads as terrain between the track and the distant ridges, never as
    // pyramids.
    const nearCount = 12;
    const hillMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(baseTone).offsetHSL(0, 0.02, -0.02), roughness: 1, flatShading: true,
    });
    this.disposables.push(hillMat);
    for (let i = 0; i < nearCount; i++) {
      const a = ((i + 0.5) / nearCount) * Math.PI * 2 + Math.cos(i * 5.1) * 0.14;
      const r = maxR + 250 + Math.sin(i * 1.7) * 110 + (i % 2) * 70;
      const h = alpine ? 52 + (i % 3) * 24 : 22 + (i % 3) * 14;
      const geo = new THREE.SphereGeometry(h, 12, 7, 0, Math.PI * 2, 0, Math.PI / 2);
      const pa = geo.attributes.position as THREE.BufferAttribute;
      const seedR = Math.random() * 10;
      for (let v = 0; v < pa.count; v++) {
        const vx = pa.getX(v), vy = pa.getY(v), vz = pa.getZ(v);
        const n = 1 + Math.sin(vx * 0.08 + seedR) * 0.3 + Math.cos(vz * 0.11 + seedR * 1.9) * 0.22;
        pa.setXYZ(v, vx * n * 2.6, vy * (1 + Math.sin(vz * 0.07 + seedR) * 0.25), vz * n * 1.9);  // long & flat
      }
      geo.computeVertexNormals();
      this.disposables.push(geo);
      const m = new THREE.Mesh(geo, hillMat);
      m.position.set(cx + Math.cos(a) * r, minY - 3, cz + Math.sin(a) * r);
      m.rotation.y = Math.random() * Math.PI;
      this.group.add(m);
    }
    if (this.def.env === 'coast') {
      // v27: the port is LAYOUT-AWARE — a water polygon whose west edge
      // follows the harbor-side samples (offset past the walls) and opens
      // east to the horizon. The v26 big rotated plane sat BELOW the distant
      // grass plane (minY-1.2 vs minY-0.6) and was never visible: Monaco
      // showed grass where the reference image has a harbor full of yachts.
      // The new sheet sits at minY-0.42: above the distant grass, below the
      // verges/road — so it only shows where the polygon actually is.
      const off = this.def.seaOffset ?? [480, 0];
      const seaX = cx + off[0], seaZ = cz + off[1];
      const seaY = minY - 0.42;

      // v26 yacht materials (hull + cabin + mast)
      const hullMat = new THREE.MeshStandardMaterial({ color: 0xf2f4f6, roughness: 0.35, metalness: 0.1 });
      const cabinMat = new THREE.MeshStandardMaterial({ color: 0x2a3542, roughness: 0.5 });
      const mastMat = new THREE.MeshStandardMaterial({ color: 0xd8dce0, roughness: 0.3, metalness: 0.6 });
      this.disposables.push(hullMat, cabinMat, mastMat);

      const yacht = (x: number, z: number, yaw: number, s: number): void => {
        const g = new THREE.Group();
        const hull = new THREE.Mesh(new THREE.CylinderGeometry(0.7 * s, 0.45 * s, 6.5 * s, 8), hullMat);
        hull.rotation.z = Math.PI / 2;
        hull.position.y = 0.5 * s;
        g.add(hull);
        const cabin = new THREE.Mesh(new THREE.BoxGeometry(2.2 * s, 1.2 * s, 2.0 * s), cabinMat);
        cabin.position.set(0.6 * s, 1.4 * s, 0);
        g.add(cabin);
        const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.08 * s, 0.12 * s, 8 * s, 6), mastMat);
        mast.position.set(-1.2 * s, 5 * s, 0);
        g.add(mast);
        g.position.set(x, seaY + 0.15, z);
        g.rotation.y = yaw;
        this.group.add(g);
      };

      if (this.def.id === 'monaco') {
        // ---- collect harbor-side samples: those within 240 m of the sea
        // center, in driving order (tunnel -> chicane -> harbor -> Rascasse)
        const seaSide: number[] = [];
        for (let i = 0; i < N; i++) {
          const sm = this.spline.samples[i];
          const d = Math.hypot(sm.pos.x - seaX, sm.pos.z - seaZ);
          if (d < 240) seaSide.push(i);
        }
        if (seaSide.length > 12) {
          // the collection may wrap around the lap; rotate it contiguous
          let brk = 0;
          for (let k = 1; k < seaSide.length; k++) {
            if ((seaSide[k] - seaSide[k - 1] + N) % N > 1) { brk = k; break; }
          }
          const ordered = seaSide.slice(brk).concat(seaSide.slice(0, brk));

          // west edge of the water: 26 m past the wall, toward the sea
          const edge: THREE.Vector2[] = [];
          for (const i of ordered) {
            const sm = this.spline.samples[i];
            const dx = seaX - sm.pos.x, dz = seaZ - sm.pos.z;
            const d = Math.hypot(dx, dz) || 1;
            const wallAbs = Math.max(Math.abs(this.wallR[i]), Math.abs(this.wallL[i]));
            const t = wallAbs + 26;
            edge.push(new THREE.Vector2(sm.pos.x + dx / d * t, sm.pos.z + dz / d * t));
          }
          // close the polygon out east (beyond the visible world)
          const first = edge[0], last = edge[edge.length - 1];
          const fDir = new THREE.Vector2(first.x - seaX, first.y - seaZ).normalize();
          const lDir = new THREE.Vector2(last.x - seaX, last.y - seaZ).normalize();
          const poly = edge.concat([
            new THREE.Vector2(last.x + lDir.x * 700, last.y + lDir.y * 700),
            new THREE.Vector2(seaX + 850, seaZ + 700),
            new THREE.Vector2(seaX + 850, seaZ - 700),
            new THREE.Vector2(first.x + fDir.x * 700, first.y + fDir.y * 700),
          ]);
          const shape = new THREE.Shape(poly);
          const seaGeo = new THREE.ShapeGeometry(shape);
          this.disposables.push(seaGeo);
          const seaMat = new THREE.MeshStandardMaterial({
            color: this.weather === 'night' ? 0x0a1420 : 0x2d6f9e,
            roughness: this.weather === 'night' ? 0.35 : 0.22,
            metalness: 0.4,
            envMapIntensity: this.weather === 'night' ? 0.5 : 1.0,
          });
          this.disposables.push(seaMat);
          const sea = new THREE.Mesh(seaGeo, seaMat);
          sea.rotation.x = -Math.PI / 2;
          sea.position.y = seaY;
          this.group.add(sea);

          // ---- the marina: yachts in the basin, hugging the quay -------
          let placed = 0;
          for (let k = 4; k < ordered.length - 4 && placed < 14; k += 5) {
            const i = ordered[k];
            const sm = this.spline.samples[i];
            const dx = seaX - sm.pos.x, dz = seaZ - sm.pos.z;
            const d = Math.hypot(dx, dz) || 1;
            const wallAbs = Math.max(Math.abs(this.wallR[i]), Math.abs(this.wallL[i]));
            const t = wallAbs + 34 + (k % 3) * 16;
            const yx = sm.pos.x + dx / d * t, yz = sm.pos.z + dz / d * t;
            if (!this.clearOfTrack(yx, yz, 12)) continue;
            yacht(yx, yz, Math.atan2(dx, dz) + 0.35 + (k % 3) * 0.18,
              0.8 + (k % 4) * 0.22);
            placed++;
          }
        }
      } else {
        // every other coast circuit: the classic far sea plane (now lifted
        // above the distant grass so it is actually VISIBLE)
        const sea = new THREE.Mesh(
          new THREE.PlaneGeometry(2400, 1600),
          new THREE.MeshStandardMaterial({
            color: this.weather === 'night' ? 0x0a1420 : 0x2d6f9e,
            roughness: this.weather === 'night' ? 0.35 : 0.25,
            metalness: 0.4, envMapIntensity: this.weather === 'night' ? 0.5 : 1.0,
          }),
        );
        this.disposables.push(sea.geometry, sea.material as THREE.Material);
        sea.rotation.x = -Math.PI / 2;
        sea.rotation.z = 0.4;
        sea.position.set(seaX, seaY, seaZ);
        this.group.add(sea);
      }
    }
  }

  // ------------------------------------------------------------------ assist line (F1-style guidance)

  /** Show/hide the on-track guidance arrows (racing line assist). */
  setAssistLine(on: boolean): void {
    if (this.assistGroup) this.assistGroup.visible = on;
  }

  /**
   * F1-game driving line (v22: QUIET & CLEAN — the old one was loud and
   * busy): a slim tinted strip along the racing line plus sparse chevron
   * hints. Color = what the car should be doing right here:
   *   RED   — braking zone (deceleration required ahead)
   *   AMBER — corner (hold, trail to apex)
   *   GREEN — flat out (or accelerating out)
   * The strip is thin (0.22 m half-width) at 55% opacity — guidance you can
   * read at 300 km/h without the track looking like a toy.
   */
  private buildAssistLine(): void {
    const line = this.racingLine;
    const N = SAMPLES;
    const ds = this.spline.length / N;

    // ---- classify each sample -------------------------------------------
    const GREEN: [number, number, number] = [0.10, 0.60, 0.32];
    const AMBER: [number, number, number] = [0.82, 0.56, 0.13];
    const RED:   [number, number, number] = [0.72, 0.16, 0.12];
    const cols: [number, number, number][] = [];
    for (let i = 0; i < N; i++) {
      // required deceleration if we keep rolling into the next ~85 m
      let need = 0;
      const vHere = line.vTarget[i];
      for (let k = 2; k < 42; k++) {
        const j = (i + k) % N;
        const vj = line.vTarget[j];
        if (vj < vHere) {
          const decel = (vHere * vHere - vj * vj) / (2 * k * ds);
          if (decel > need) need = decel;
        }
      }
      const cornering = line.curv[i] > 0.0033;
      let c: [number, number, number];
      if (need > 3.2) {
        const t = clamp((need - 3.2) / 6, 0, 1);
        c = mix3(AMBER, RED, t);
      } else if (cornering || need > 1.1) {
        c = AMBER;
      } else {
        c = GREEN;
      }
      cols.push(c);
    }
    // smooth the color transitions (±3 samples)
    const sm: [number, number, number][] = cols.map(() => [0, 0, 0]);
    for (let i = 0; i < N; i++) {
      let r = 0, g = 0, b = 0;
      for (let k = -3; k <= 3; k++) {
        const c = cols[(i + k + N) % N];
        r += c[0]; g += c[1]; b += c[2];
      }
      sm[i] = [r / 7, g / 7, b / 7];
    }

    const group = new THREE.Group();
    group.name = 'assistLine';
    const pos: number[] = [], col: number[] = [], idx: number[] = [];
    const lineW = 0.17;   // half width of the slim v22 strip (~a tyre's width)

    const pushVert = (x: number, y: number, z: number, c: [number, number, number]): number => {
      pos.push(x, y, z); col.push(c[0], c[1], c[2]);
      return pos.length / 3 - 1;
    };

    // ---- strip along the line --------------------------------------------
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N;
      const a = this.linePoint(i, line.lat[i]);
      const b = this.linePoint(j, line.lat[j]);
      const ra = this.spline.samples[i].right;
      const rb = this.spline.samples[j].right;
      const a0 = pushVert(a.x - ra.x * lineW, a.y + 0.045, a.z - ra.z * lineW, sm[i]);
      const a1 = pushVert(a.x + ra.x * lineW, a.y + 0.045, a.z + ra.z * lineW, sm[i]);
      const b0 = pushVert(b.x - rb.x * lineW, b.y + 0.045, b.z - rb.z * lineW, sm[j]);
      const b1 = pushVert(b.x + rb.x * lineW, b.y + 0.045, b.z + rb.z * lineW, sm[j]);
      idx.push(a0, b0, b1, a0, b1, a1);
    }

    // ---- chevron hints every ~24 m (sparse — direction, not a sea of arrows) --
    const step = Math.max(5, Math.round(24 / ds));
    for (let i = 0; i < N; i += step) {
      const p = this.linePoint(i, line.lat[i]);
      const t = this.spline.samples[i].tangent;
      const r = this.spline.samples[i].right;
      const c = sm[i];
      const y = p.y + 0.055;
      const L = 0.85, W = 0.44, notch = 0.26;
      const tip    = pushVert(p.x + t.x * L * 0.5, y, p.z + t.z * L * 0.5, c);
      const backL  = pushVert(p.x - t.x * L * 0.5 + r.x * W, y, p.z - t.z * L * 0.5 + r.z * W, c);
      const backC  = pushVert(p.x - t.x * L * 0.5 + t.x * notch, y, p.z - t.z * L * 0.5 + t.z * notch, c);
      const backR  = pushVert(p.x - t.x * L * 0.5 - r.x * W, y, p.z - t.z * L * 0.5 - r.z * W, c);
      idx.push(tip, backL, backC, tip, backC, backR);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex(idx);
    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.42,
      side: THREE.DoubleSide, depthWrite: false,
    });
    this.disposables.push(geo, mat);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 2;
    group.add(mesh);
    this.assistGroup = group;
    this.group.add(group);
  }

  private linePoint(i: number, lat: number): THREE.Vector3 {
    const sm = this.spline.samples[i];
    return new THREE.Vector3(
      sm.pos.x + sm.right.x * lat, sm.pos.y, sm.pos.z + sm.right.z * lat);
  }

  // ------------------------------------------------------------------ night floodlights

  /** Night race: floodlight masts around the circuit (heads exposed for the
   *  Game to drive a small pool of real SpotLights). */
  private buildFloodlights(): void {
    if (this.weather !== 'night') return;
    const N = SAMPLES;
    const masts = 14;
    const step = Math.floor(N / masts);
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x3a3f48, metalness: 0.7, roughness: 0.4 });
    const headMat = new THREE.MeshStandardMaterial({
      color: 0xf8fbff, emissive: 0xf2f7ff, emissiveIntensity: 5.5, roughness: 0.3,
    });
    const coneMat = new THREE.MeshBasicMaterial({
      color: 0xbfd4ff, transparent: true, opacity: 0.05, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    this.disposables.push(poleMat, headMat, coneMat);
    for (let m = 0; m < masts; m++) {
      const i = (m * step + Math.floor(step / 2)) % N;
      const sm = this.spline.samples[i];
      const side = m % 2 === 0 ? 1 : -1;
      const wall = side > 0 ? this.wallR[i] : -this.wallL[i];
      const lat = side * (wall + 7);
      const px = sm.pos.x + sm.right.x * lat, pz = sm.pos.z + sm.right.z * lat;
      if (!this.clearOfTrack(px, pz, 3)) continue;
      const py = sm.pos.y;
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.3, 17, 8), poleMat);
      this.disposables.push(pole.geometry);
      pole.position.set(px, py + 8.5, pz);
      pole.castShadow = true;
      this.group.add(pole);
      // head bar with 4 lamps aimed at the track
      const head = new THREE.Group();
      head.position.set(px, py + 17, pz);
      head.lookAt(sm.pos.x, py, sm.pos.z);
      for (let l = 0; l < 4; l++) {
        const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.4, 0.24), headMat);
        this.disposables.push(lamp.geometry);
        lamp.position.set((l - 1.5) * 1.05, 0, 0);
        head.add(lamp);
      }
      this.group.add(head);
      // soft light cone toward the tarmac
      const cone = new THREE.Mesh(new THREE.ConeGeometry(7.5, 17.5, 12, 1, true), coneMat);
      this.disposables.push(cone.geometry);
      cone.position.set(px, py + 8.6, pz);
      cone.lookAt(sm.pos.x, py - 1, sm.pos.z);
      cone.rotateX(Math.PI / 2);
      this.group.add(cone);
      this.floodHeads.push(new THREE.Vector3(px, py + 16.6, pz));
    }
  }

  // ------------------------------------------------------------------ grid

  private computeGridSlots(): GridSlot[] {
    const slots: GridSlot[] = [];
    const L = this.spline.length;
    for (let i = 0; i < 20; i++) {
      const row = Math.floor(i / 2);
      const col = i % 2;
      const back = 16 + row * 8.5;
      const s = (((1 - back / L) % 1) + 1) % 1;
      const sm = this.spline.sampleAt(s);
      // pole side alternates per row (staggered F1 grid)
      const sideSign = (row % 2 === 0 ? 1 : -1) * (col === 0 ? -1 : 1);
      const lat = sideSign * sm.halfWidth * 0.42;
      slots.push({
        s,
        pos: new THREE.Vector3(sm.pos.x + sm.right.x * lat, sm.pos.y, sm.pos.z + sm.right.z * lat),
        yaw: Math.atan2(sm.tangent.x, sm.tangent.z),
      });
    }
    return slots;
  }

  private arcDist(a: number, b: number): number {
    const d = Math.abs(a - b);
    return Math.min(d, SAMPLES - d) * (this.spline.length / SAMPLES);
  }

  // ------------------------------------------------------------------ physics queries

  groundQuery(p: THREE.Vector3, state: { mainIdx: number }): F1GroundInfo {
    const proj = this.spline.project(p, state.mainIdx);
    const idx = proj.index;
    const sm = this.spline.samples[idx];
    const hw = proj.halfWidth;
    const lat = proj.lateral;
    const absL = Math.abs(lat);

    let surface: Surface = 'road';
    const kerbHere = lat >= 0 ? this.kerbR[idx] === 1 : this.kerbL[idx] === 1;
    if (absL > hw - 0.15) {
      if (absL <= hw + KERB_W && kerbHere) surface = 'kerb';
      else if (absL <= hw + KERB_W + 0.2 && !kerbHere) surface = 'road';
      else {
        const eff = this.runoffEff[idx] > 1.5 && this.runoffSide[idx] === Math.sign(lat) ? this.runoffEff[idx] : 0;
        if (eff > 0 && absL <= hw + KERB_W + eff) surface = this.runoffType[idx];
        else surface = 'grass';
      }
    }

    const height = sm.pos.y + Math.sin(sm.bank) * lat + (surface === 'kerb' ? 0.055 : 0);
    return {
      height, hasGround: true, surface,
      s: proj.s, lateral: lat, slope: sm.tangent.y,
      mainIdx: idx, halfWidth: hw,
      wallL: this.wallL[idx] - 0.9,   // car half-width inset
      wallR: this.wallR[idx] - 0.9,
      onKerb: surface === 'kerb',
    };
  }

  wallConstrain(car: F1Car): void {
    // TRUE SEGMENT COLLISION: the car is a circle (r ≈ half width) tested
    // against every nearby wall segment — the local section's walls AND the
    // facing sections' walls (this.neighbors). Position is resolved out of
    // penetration every step, so no speed and no seam can push you through.
    const gi = car.ginfo;
    if (!gi) return;
    const N = SAMPLES;
    const idx = gi.mainIdx;
    for (let k = -3; k <= 2; k++) {
      const s = ((idx + k) % N + N) % N;
      this.wallSeg(car, s, 1);
      this.wallSeg(car, s, -1);
    }
    for (const j of this.neighbors[idx]) {
      for (let k = -2; k <= 1; k++) {
        const s = ((j + k) % N + N) % N;
        this.wallSeg(car, s, 1);
        this.wallSeg(car, s, -1);
      }
    }
  }

  /** Circle-vs-segment resolution against one wall segment. */
  private wallSeg(car: F1Car, k: number, side: 1 | -1): void {
    const N = SAMPLES;
    const a = this.spline.samples[k];
    const b = this.spline.samples[(k + 1) % N];
    const la = side > 0 ? this.wallR[k] : this.wallL[k];
    const lb = side > 0 ? this.wallR[(k + 1) % N] : this.wallL[(k + 1) % N];
    const ax = a.pos.x + a.right.x * la, az = a.pos.z + a.right.z * la;
    const bx = b.pos.x + b.right.x * lb, bz = b.pos.z + b.right.z * lb;
    const abx = bx - ax, abz = bz - az;
    const len2 = abx * abx + abz * abz;
    if (len2 < 1e-6) return;
    let t = ((car.pos.x - ax) * abx + (car.pos.z - az) * abz) / len2;
    t = clamp(t, 0, 1);
    const cx = ax + abx * t, cz = az + abz * t;
    let dx = car.pos.x - cx, dz = car.pos.z - cz;
    const dist = Math.hypot(dx, dz);
    if (dist >= WALL_CAR_R) return;

    // track-side normal: wall midpoint → sample center
    const mx = (ax + bx) * 0.5, mz = (az + bz) * 0.5;
    let nx = a.pos.x - mx, nz = a.pos.z - mz;
    const nl = Math.hypot(nx, nz) || 1;
    nx /= nl; nz /= nl;

    let px: number, pz: number, pen: number;
    if (dist < 1e-4) {
      px = nx; pz = nz; pen = WALL_CAR_R;
    } else {
      const dnx = dx / dist, dnz = dz / dist;
      if (dnx * nx + dnz * nz < 0) {
        // crossed the wall line within one step — push all the way back
        px = nx; pz = nz; pen = WALL_CAR_R + dist;
      } else {
        px = dnx; pz = dnz; pen = WALL_CAR_R - dist;
      }
    }
    car.pos.x += px * pen;
    car.pos.z += pz * pen;

    // kill the into-wall velocity component (restitution + scrub)
    const v = car.velocity;
    const vn = v.x * px + v.z * pz;
    if (vn < 0) {
      const impact = -vn;
      v.x -= px * vn * (1 + PHYS.wallRestitution);
      v.z -= pz * vn * (1 + PHYS.wallRestitution);
      v.multiplyScalar(PHYS.wallScrub);
      const fwd = car.forward();
      const rightB = new THREE.Vector3(Math.cos(car.yaw), 0, -Math.sin(car.yaw));
      car.vLong = v.dot(fwd);
      car.vLat = v.dot(rightB);
      car.wallHit = Math.max(car.wallHit, Math.min(1, impact / 14));
      if (impact > 15 && car.spinT <= 0) car.spinFromContact(impact / 24);
    }
  }

  update(_t: number, _dt: number): void {
    // v21: wind clock drives foliage sway, flag waves and crowd flashes
    this.windU.uTime.value = _t;
  }

  // ================================================================ v21 wind/flags

  /** Gentle elliptical sway for tree crowns: amplitude grows with height
   *  inside each crown, phase from world position (no clone-army sway).
   *  v22: INSTANCING-AWARE — with the woodland baked into InstancedMeshes
   *  the phase comes from the instance's world position (instanceMatrix),
   *  so instanced trees still sway out of lockstep. */
  private applyFoliageWind(mat: THREE.MeshStandardMaterial): void {
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.windU.uTime;
      shader.uniforms.uWind = this.windU.uWind;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform float uWind;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          {
            vec4 ip = vec4(transformed, 1.0);
            #ifdef USE_INSTANCING
              ip = instanceMatrix * ip;
            #endif
            vec4 wp = modelMatrix * ip;
            float ph = wp.x * 0.061 + wp.z * 0.083;
            float hgt = clamp((transformed.y + 1.3) / 2.6, 0.0, 1.0);
            float amp = uWind * hgt * hgt * 0.12;
            transformed.x += (sin(uTime * 1.31 + ph) * 0.62 + sin(uTime * 2.33 + ph * 1.7) * 0.31) * amp;
            transformed.z += (cos(uTime * 1.13 + ph * 1.3) * 0.58 + sin(uTime * 2.71 + ph) * 0.27) * amp;
          }`);
    };
    mat.customProgramCacheKey = () => 'wind-foliage';
  }

  /** Cloth-on-a-pole flag material: a travelling wave that grows from the
   *  pole edge to the free edge, with a slow gust cycle. */
  private makeFlagMaterial(tex: THREE.Texture): THREE.MeshStandardMaterial {
    const mat = new THREE.MeshStandardMaterial({
      map: tex, roughness: 0.85, metalness: 0, side: THREE.DoubleSide,
    });
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.windU.uTime;
      shader.uniforms.uWind = this.windU.uWind;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform float uWind;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          {
            vec4 wp = modelMatrix * vec4(transformed, 1.0);
            float ph = wp.x * 0.35 + wp.z * 0.41;
            float attach = smoothstep(-0.9, 0.9, transformed.x);   // pole edge -> free edge
            float gust = 0.75 + 0.25 * sin(uTime * 0.43 + ph * 0.31);
            float wave = sin(transformed.x * 3.1 - uTime * 5.6 + ph) * 0.15
                       + sin(transformed.x * 5.7 - uTime * 7.9 + ph * 1.7) * 0.07;
            transformed.z += wave * attach * attach * uWind * gust;
            transformed.y += sin(transformed.x * 2.3 - uTime * 4.6 + ph * 1.3) * 0.05 * attach * uWind;
          }`);
    };
    mat.customProgramCacheKey = () => 'wind-flag';
    this.disposables.push(mat);
    return mat;
  }

  /** Waving flags: a big checkered marshal flag at the start line plus a
   *  scatter of circuit flags just outside the barriers (and the tricolor on
   *  highland/México). Flags cast shadows — a lovely detail at low sun. */
  private buildFlags(): void {
    if (this.spline.length < 200) return;
    const texs = flagTextures();
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x9aa0a8, metalness: 0.6, roughness: 0.4 });
    this.disposables.push(poleMat);
    const highland = this.def.env === 'highland';
    const put = (x: number, y: number, z: number, yaw: number, texIdx: number,
                 poleH: number, fw: number, fh: number): void => {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, poleH, 6), poleMat);
      this.disposables.push(pole.geometry);
      pole.position.set(x, y + poleH / 2, z);
      pole.castShadow = true;
      this.group.add(pole);
      const flag = new THREE.Mesh(new THREE.PlaneGeometry(fw, fh, 12, 5), this.makeFlagMaterial(texs[texIdx % texs.length]));
      this.disposables.push(flag.geometry);
      flag.position.set(
        x + Math.cos(yaw) * fw * 0.5,
        y + poleH - fh * 0.5 - 0.08,
        z - Math.sin(yaw) * fw * 0.5);
      flag.rotation.y = yaw;
      flag.castShadow = true;
      this.group.add(flag);
    };
    // start-line marshal flag (checkered) just past the gantry, outside the wall
    {
      const sm = this.spline.sampleAt(0.996);
      const lat = -(sm.halfWidth + 3.4);
      const yaw = Math.atan2(sm.tangent.x, sm.tangent.z) + Math.PI / 2;
      put(sm.pos.x + sm.right.x * lat, sm.pos.y, sm.pos.z + sm.right.z * lat, yaw, 0, 4.8, 2.1, 1.35);
    }
    // circuit flags around the lap, alternating sides
    const spots = [0.08, 0.17, 0.3, 0.44, 0.58, 0.72, 0.86];
    const N = SAMPLES;
    spots.forEach((sVal, k) => {
      const idx = Math.floor(sVal * N) % N;
      const sm = this.spline.samples[idx];
      const side = k % 2 === 0 ? 1 : -1;
      const wall = side > 0 ? this.wallR[idx] : -this.wallL[idx];
      const lat = side * (wall + 5.5);
      const x = sm.pos.x + sm.right.x * lat;
      const z = sm.pos.z + sm.right.z * lat;
      if (!this.clearOfTrack(x, z, 3.5)) return;
      const yaw = Math.atan2(sm.tangent.x, sm.tangent.z) + Math.PI / 2 + (k % 3 - 1) * 0.5;
      const texIdx = highland ? (k % 3 === 0 ? 1 : (k % 5) + 1) : (k % 5) + 1;
      put(x, sm.pos.y, z, yaw, texIdx, 4.4 + (k % 3) * 0.6, 1.8, 1.15);
    });
  }

  /** Crowd camera flashes — additive sparkle points that pop at random like
   *  broadcast grandstand photos (stands + Foro Sol tiers). */
  private buildCrowdFlashes(pts: number[]): THREE.Points {
    const n = pts.length / 3;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const seeds = new Float32Array(n);
    for (let i = 0; i < n; i++) seeds[i] = Math.random() * 100;
    geo.setAttribute('seed', new THREE.BufferAttribute(seeds, 1));
    const pr = Math.min(window.devicePixelRatio || 1, 2);
    const mat = new THREE.ShaderMaterial({
      uniforms: { uTime: this.windU.uTime, uPR: { value: pr } },
      vertexShader: `
        attribute float seed;
        uniform float uTime; uniform float uPR;
        varying float vB;
        void main() {
          // camera flash: sharp pop + fast decay inside each point's slot —
          // reads as a real photo flash, not a glowing dot
          float ph = uTime * 2.7 + seed * 13.0;
          float slot = floor(ph);
          float t = fract(ph);
          float h = fract(sin(seed * 127.31 + slot * 311.7) * 43758.5453);
          vB = pow(h, 36.0) * exp(-t * 9.0);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = (40.0 + vB * 360.0) * uPR / max(1.0, -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying float vB;
        void main() {
          float d = length(gl_PointCoord - vec2(0.5));
          float a = smoothstep(0.5, 0.08, d) * vB;
          if (a < 0.012) discard;
          gl_FragColor = vec4(vec3(1.0, 0.97, 0.9) * a * 2.2, a);
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.disposables.push(geo, mat);
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    points.renderOrder = 6;
    points.name = 'crowdFlashes';
    this.group.add(points);
    return points;
  }

  dispose(): void {
    this.group.parent?.remove(this.group);
    for (const d of this.disposables) d.dispose();
  }
}

/** linear mix of two rgb triples */
function mix3(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** v21 flag textures: 0 = checkered (start line), 1 = MEX tricolor,
 *  2..5 = solid marshals/team colours. Module-cached. */
let flagTexCache: THREE.Texture[] | null = null;
function flagTextures(): THREE.Texture[] {
  if (flagTexCache) return flagTexCache;
  const make = (paint: (g: CanvasRenderingContext2D) => void): THREE.Texture => {
    const cv = document.createElement('canvas');
    cv.width = 128; cv.height = 80;
    paint(cv.getContext('2d')!);
    const t = new THREE.CanvasTexture(cv);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  const checkered = make(g => {
    g.fillStyle = '#f2f3f5'; g.fillRect(0, 0, 128, 80);
    g.fillStyle = '#141519';
    for (let y = 0; y < 5; y++)
      for (let x = 0; x < 8; x++)
        if ((x + y) % 2 === 0) g.fillRect(x * 16, y * 16, 16, 16);
  });
  const tricolor = make(g => {
    g.fillStyle = '#0d6e4f'; g.fillRect(0, 0, 43, 80);
    g.fillStyle = '#f4f5f7'; g.fillRect(43, 0, 42, 80);
    g.fillStyle = '#c8102e'; g.fillRect(85, 0, 43, 80);
  });
  const solid = (c: string): THREE.Texture =>
    make(g => { g.fillStyle = c; g.fillRect(0, 0, 128, 80); });
  flagTexCache = [checkered, tricolor, solid('#c8102e'), solid('#1c52d8'), solid('#ffd400'), solid('#151a22')];
  return flagTexCache;
}
