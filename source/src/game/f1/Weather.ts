/**
 * APEX GP — Weather system (v22 "Golden Hour").
 *
 * Five selectable conditions — CLEAR / CLOUDY / RAIN / NIGHT / SUNSET — each
 * resolving to a full environment style layered on top of the circuit's base
 * look:
 *  - sky shader v2: gradient + sun disk & glow + horizon haze (+ stars/moon at night)
 *  - light rig: sun/hemi/ambient intensities, fog, exposure
 *  - physics: rain multiplies grip down (car + AI racing line)
 *  - decor: night races get floodlight masts + follow spotlights
 *  - v22 SUNSET: golden hour — a LOW warm sun (~10° elevation) that stretches
 *    every shadow across the track, orange horizon, warm haze and tinted
 *    clouds. The most crepuscular condition: restrained god rays for free.
 */

import * as THREE from 'three';
import type { Weather } from '../core/Types';
import type { F1EnvStyle } from '../f1/F1TrackBuilder';

export interface WeatherStyle extends F1EnvStyle {
  /** grip multiplier applied to every car + the AI racing line */
  gripScale: number;
  /** wet asphalt look (low roughness, strong env reflections) */
  wetRoad: boolean;
  /** billboard clouds count / tint */
  clouds: number;
  cloudColor: number;
  cloudOpacity: number;
  /** night: stars + moon + floodlights */
  night: boolean;
  /** ambient light bump (night rig) */
  ambient: number;
  /** cloud drifting speed */
  cloudDrift: number;
  /** v21 wind strength (tree sway / flag wave scale — 1 = gentle breeze) */
  wind: number;
}

/** Layer a weather condition over the circuit's base env style. */
export function resolveWeather(base: F1EnvStyle, weather: Weather): WeatherStyle {
  const c = (hex: number, mul: number): number => {
    const col = new THREE.Color(hex).multiplyScalar(mul);
    return col.getHex();
  };
  switch (weather) {
    case 'cloudy':
      return {
        ...base,
        skyTop: 0x9aa6b8, skyBottom: 0xd8dde4, haze: 0xcfd6de,
        sunColor: 0xf2f4f8, sunIntensity: base.sunIntensity * 0.34,
        hemiSky: 0xc4ccd8, hemiGround: c(base.hemiGround, 0.9), hemiIntensity: base.hemiIntensity * 1.25,
        fog: 0xc9cfd8, fogNear: base.fogNear * 0.72, fogFar: base.fogFar * 0.72,
        exposure: 1.02, ambient: 0.42,
        gripScale: 0.97, wetRoad: false,
        clouds: 26, cloudColor: 0xe8ecf2, cloudOpacity: 0.92, cloudDrift: 1.4,
        night: false, wind: 1.7,
      };
    case 'rain':
      return {
        ...base,
        skyTop: 0x39424e, skyBottom: 0x78828e, haze: 0x767f8b,
        sunColor: 0xbcc4d0, sunIntensity: base.sunIntensity * 0.16,
        hemiSky: 0x8b95a4, hemiGround: c(base.hemiGround, 0.7), hemiIntensity: base.hemiIntensity * 1.35,
        fog: 0x8b939e, fogNear: base.fogNear * 0.5, fogFar: base.fogFar * 0.55,
        exposure: 0.98, ambient: 0.5,
        gripScale: 0.86, wetRoad: true,
        clouds: 34, cloudColor: 0x59626e, cloudOpacity: 0.96, cloudDrift: 2.6,
        night: false, wind: 2.6,
      };
    case 'night':
      return {
        ...base,
        skyTop: 0x050810, skyBottom: 0x101a2c, haze: 0x0d1626,
        sunColor: 0x9fb4ff, sunIntensity: 0.5, sunDir: [-0.35, 0.8, 0.3],
        hemiSky: 0x2c3550, hemiGround: 0x0c1018, hemiIntensity: 0.85,
        fog: 0x0b1018, fogNear: 300, fogFar: 1100,
        exposure: 1.06, ambient: 0.62,
        gripScale: 0.99, wetRoad: false,
        clouds: 0, cloudColor: 0x1a2233, cloudOpacity: 0.35, cloudDrift: 0.7,
        night: true, wind: 0.9,
      };
    case 'sunset':
      // v22 GOLDEN HOUR: low warm sun (~10° up) → every tree, stand and
      // gantry throws a long shadow across the asphalt; orange horizon
      // fading into a deep steel-blue zenith; warm dust haze; a few clouds
      // catching the light. Dry race, full grip.
      return {
        ...base,
        skyTop: 0x2b4784, skyBottom: 0xffab5e, haze: 0xf3bd85,
        sunColor: 0xffa04a, sunIntensity: base.sunIntensity * 0.8,
        sunDir: [0.82, 0.155, -0.35],
        hemiSky: 0x9a86b8, hemiGround: c(base.hemiGround, 0.82), hemiIntensity: base.hemiIntensity * 1.08,
        fog: 0xe9bd92, fogNear: 240, fogFar: 1350,
        exposure: 1.02, ambient: 0.22,
        gripScale: 1.0, wetRoad: false,
        clouds: 13, cloudColor: 0xffcf9e, cloudOpacity: 0.85, cloudDrift: 0.75,
        night: false, wind: 1.15,
      };
    case 'clear':
    default:
      return {
        ...base,
        ambient: 0.14,          // LOW fill — the sun owns the light, shadows read deep
        gripScale: 1.0, wetRoad: false,
        clouds: 11, cloudColor: 0xffffff, cloudOpacity: 0.78, cloudDrift: 1.0,
        night: false, wind: 1.0,
      };
  }
}

// ============================================================ sky shader v2

export interface SkyUniforms extends Record<string, THREE.IUniform> {
  top: THREE.IUniform<THREE.Color>;
  bottom: THREE.IUniform<THREE.Color>;
  sunDir: THREE.IUniform<THREE.Vector3>;
  sunColor: THREE.IUniform<THREE.Color>;
  sunGlow: THREE.IUniform<number>;
  night: THREE.IUniform<number>;
  haze: THREE.IUniform<THREE.Color>;
  /** v22: 1 = golden hour — swells the sun-side haze band */
  sunset: THREE.IUniform<number>;
}

/**
 * Sky shader v3 — "atmosphere" rewrite:
 *  - Rayleigh-style vertical gradient: deep saturated zenith, bright horizon,
 *    plus extra zenith darkening (the real sky deepens right overhead)
 *  - sun-side Mie warmth: the horizon haze band glows warm toward the sun and
 *    cool on the anti-solar side — the sky finally has DIRECTION
 *  - 3-lobe sun glow (wide atmospheric halo + mid bloom + tight core) so the
 *    sun reads as an object in the sky, not a sticker
 *  - night: varied-magnitude twinkling starfield + a soft milky-way band +
 *    moon halo
 *  - 1-LSB dithering: kills the 8-bit gradient banding over the dome
 */
export function makeSkyDomeV2(style: F1EnvStyle, weather: Weather): THREE.Mesh {
  const night = weather === 'night';
  const overcast = weather === 'rain' || weather === 'cloudy';
  const sunset = weather === 'sunset';
  const uniforms: SkyUniforms = {
    top: { value: new THREE.Color(style.skyTop) },
    bottom: { value: new THREE.Color(style.skyBottom) },
    sunDir: { value: new THREE.Vector3(...style.sunDir).normalize() },
    sunColor: { value: new THREE.Color(style.sunColor) },
    // sunset: a fatter warm halo — the low sun blooms through the haze
    sunGlow: { value: overcast ? 0.16 : night ? 0.55 : sunset ? 1.28 : 1.0 },
    night: { value: night ? 1 : 0 },
    haze: { value: new THREE.Color(style.haze ?? style.skyBottom) },
    sunset: { value: sunset ? 1 : 0 },
  };
  const geo = new THREE.SphereGeometry(1200, 48, 28);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms,
    vertexShader: `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform vec3 top; uniform vec3 bottom; uniform vec3 sunDir; uniform vec3 sunColor;
      uniform float sunGlow; uniform float night; uniform vec3 haze; uniform float sunset;
      varying vec3 vDir;

      float hash(vec3 p) {
        p = fract(p * 443.8975);
        p += dot(p, p.yzx + 19.19);
        return fract((p.x + p.y) * p.z);
      }

      void main() {
        vec3 d = normalize(vDir);
        vec3 sdir = normalize(sunDir);
        float h = clamp(d.y, 0.0, 1.0);
        float sunAmt = max(dot(d, sdir), 0.0);

        // ---- Rayleigh body: bright horizon -> deep zenith ------------------
        vec3 col = mix(bottom, top, pow(h, 0.52));
        // extra zenith deepening (the sky darkens right overhead)
        col = mix(col, top * 0.66, pow(h, 3.2) * 0.42);

        // ---- horizon haze: warm toward the sun, cool away from it ----------
        // v21: band trimmed (0.34+0.16) — the horizon keeps colour instead of
        // dissolving into a milky wash. v22 SUNSET: the sun-side band swells
        // to 0.34 — golden-hour glow concentrated where it belongs.
        float band = pow(1.0 - h, 4.5);
        vec3 hazeWarm = mix(haze, sunColor * 0.9 + haze * 0.1, sunAmt * sunAmt * 0.6);
        col = mix(col, hazeWarm, band * (0.34 + mix(0.16, 0.34, sunset) * sunAmt));

        // ---- sun / moon: 3-lobe glow + disc + wide forward-scatter halo ----
        float sd = dot(d, sdir);
        float glow = pow(max(sd, 0.0), 5.0) * 0.14
                   + pow(max(sd, 0.0), 26.0) * 0.46
                   + pow(max(sd, 0.0), 150.0) * 0.95;
        col += sunColor * glow * sunGlow;
        col += sunColor * pow(max(sd, 0.0), 1100.0) * 1.05 * sunGlow;   // tight halo (feeds god rays)
        float disk = smoothstep(0.99950, 0.99987, sd);
        col = mix(col, sunColor * (night > 0.5 ? 1.7 : 5.4), disk * (night > 0.5 ? 0.92 : 1.0));

        // ---- night: milky way + magnitude-varied twinkling stars -----------
        if (night > 0.5) {
          // faint galactic band across the dome (noise-modulated)
          float mwDist = abs(dot(d, normalize(vec3(0.42, 0.78, -0.46))));
          float mw = pow(max(0.0, 1.0 - mwDist * 2.1), 3.2);
          col += vec3(0.30, 0.34, 0.48) * mw * (0.06 + 0.11 * hash(floor(d * 150.0)));
          // stars: cell hash -> position + magnitude + twinkle
          vec3 sp = floor(d * 240.0);
          float star = step(0.9968, hash(sp));
          float mag = 0.30 + 0.70 * hash(sp + 3.1);
          float tw = 0.55 + 0.45 * hash(sp + 7.7);
          col += vec3(0.82, 0.88, 1.0) * star * mag * tw * smoothstep(0.02, 0.28, d.y) * 0.9;
        }

        // ---- dither: kills 8-bit gradient banding ---------------------------
        // v22: 2.2/255 — the warm sunset gradients band harder than the old
        // blue ones at 1.6; still invisible as noise
        col += (hash(d * 1024.0) - 0.5) * (2.2 / 255.0);
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const m = new THREE.Mesh(geo, mat);
  m.frustumCulled = false;
  m.name = 'skyDome';
  return m;
}

// ============================================================ clouds

let cloudTexCache: THREE.Texture[] | null = null;

/**
 * Three cloud sprite variants, each TWO-TONE (bright sunlit top, blue-grey
 * shaded underside baked into the texture) so the billboard banks read as
 * volumetric clouds instead of flat white cotton pads:
 *  0 = puffy cumulus (stacked blobs)
 *  1 = stretched stratus bank (wide, banded)
 *  2 = thin wispy cirrus streak
 */
function cloudTextures(): THREE.Texture[] {
  if (cloudTexCache) return cloudTexCache;

  const make = (paint: (g: CanvasRenderingContext2D) => void, w = 256, h = 256): THREE.Texture => {
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    paint(cv.getContext('2d')!);
    const t = new THREE.CanvasTexture(cv);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };

  /** one shaded blob: dark under-shadow + bright top core */
  const shadeBlob = (g: CanvasRenderingContext2D, x: number, y: number, r: number, a: number): void => {
    // cool shaded underside (offset down)
    let gr = g.createRadialGradient(x, y + r * 0.22, r * 0.05, x, y + r * 0.22, r);
    gr.addColorStop(0, `rgba(150,163,185,${a * 0.5})`);
    gr.addColorStop(0.6, `rgba(160,172,192,${a * 0.3})`);
    gr.addColorStop(1, 'rgba(170,180,200,0)');
    g.fillStyle = gr;
    g.beginPath(); g.arc(x, y + r * 0.22, r, 0, Math.PI * 2); g.fill();
    // sunlit top core (offset up)
    gr = g.createRadialGradient(x, y - r * 0.14, r * 0.04, x, y - r * 0.14, r * 0.92);
    gr.addColorStop(0, `rgba(255,255,255,${a})`);
    gr.addColorStop(0.55, `rgba(248,250,254,${a * 0.5})`);
    gr.addColorStop(1, 'rgba(240,244,250,0)');
    g.fillStyle = gr;
    g.beginPath(); g.arc(x, y - r * 0.14, r * 0.92, 0, Math.PI * 2); g.fill();
  };

  // 0: cumulus — a cauliflower stack
  const cumulus = make(g => {
    shadeBlob(g, 128, 148, 92, 0.85);
    shadeBlob(g, 76, 160, 58, 0.66);
    shadeBlob(g, 182, 158, 62, 0.66);
    shadeBlob(g, 128, 116, 56, 0.6);
    shadeBlob(g, 100, 128, 46, 0.5);
    shadeBlob(g, 160, 130, 48, 0.5);
  });
  // 1: stratus — wide layered bank with soft horizontal banding
  const stratus = make(g => {
    for (let i = 0; i < 5; i++) {
      const y = 96 + i * 26 + (i % 2) * 9;
      const w = 210 - i * 16;
      const x = 128 + (i % 2 === 0 ? -12 : 14);
      const gr = g.createRadialGradient(x, y, 8, x, y, w * 0.5);
      const a = 0.5 - i * 0.06;
      gr.addColorStop(0, `rgba(250,251,254,${a})`);
      gr.addColorStop(0.7, `rgba(196,206,224,${a * 0.55})`);
      gr.addColorStop(1, 'rgba(180,192,212,0)');
      g.fillStyle = gr;
      g.save();
      g.translate(x, y); g.scale(1, 0.34); g.translate(-x, -y);
      g.beginPath(); g.arc(x, y, w * 0.5, 0, Math.PI * 2); g.fill();
      g.restore();
    }
  });
  // 2: cirrus — a long fibrous streak
  const cirrus = make(g => {
    for (let i = 0; i < 7; i++) {
      const y = 118 + i * 9;
      const x0 = 24 + (i % 3) * 14;
      const x1 = 232 - (i % 2) * 18;
      const gr = g.createLinearGradient(x0, y, x1, y);
      const a = 0.34 - i * 0.03;
      gr.addColorStop(0, 'rgba(255,255,255,0)');
      gr.addColorStop(0.5, `rgba(252,253,255,${a})`);
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr;
      g.fillRect(x0, y, x1 - x0, 3.2 + (i % 3));
    }
  }, 256, 128);

  cloudTexCache = [cumulus, stratus, cirrus];
  return cloudTexCache;
}

export interface CloudLayer {
  group: THREE.Group;
  update(dt: number): void;
}

// ============================================================ rain (v16 port)

/**
 * RAIN v16 — the full wet-weather stack:
 *  - 1400 instanced streak QUADS (gradient texture, head droplet) that lean
 *    with the wind (camera velocity = car speed) and stretch at speed
 *  - 260 ground SPLASH rings where drops land (expanding, fading)
 *  - 220 mist/spray sprites — rooster tails behind EVERY fast car on track
 *    (not just the player), within 130 m of the camera
 *  - dual RIPPLE NORMAL MAPS scrolled + alternated on the wet road's
 *    clearcoat every frame — living water on the asphalt
 */
export interface RainCarLike {
  pos: THREE.Vector3;
  speed: number;
  yaw: number;
}

export interface RainSystem {
  group: THREE.Group;
  /** wet-road materials whose clearcoatNormalMap gets the animated ripples */
  wetRoads: THREE.MeshPhysicalMaterial[];
  update(dt: number, camPos: THREE.Vector3, camVel: THREE.Vector3, cars: RainCarLike[]): void;
  dispose(): void;
}

const RAIN_COUNT = 1400;         // streak quads
const RAIN_R = 36;               // curtain radius around the camera (m)
const RAIN_H = 30;               // curtain height (m)
const SPLASH_COUNT = 260;        // ground splash instances
const MIST_COUNT = 220;          // spray sprites in the pool

/** Vertical gradient streak + head droplet (32×128). */
function rainStreakTexture(): THREE.Texture {
  const cv = document.createElement('canvas');
  cv.width = 32; cv.height = 128;
  const ctx = cv.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, 0, 128);
  g.addColorStop(0, 'rgba(200,215,235,0)');
  g.addColorStop(0.45, 'rgba(200,215,235,0.10)');
  g.addColorStop(0.82, 'rgba(215,228,245,0.38)');
  g.addColorStop(1, 'rgba(225,236,250,0.62)');
  ctx.fillStyle = g;
  ctx.fillRect(12, 0, 8, 128);
  const r = ctx.createRadialGradient(16, 122, 0, 16, 122, 11);
  r.addColorStop(0, 'rgba(235,244,255,0.95)');
  r.addColorStop(0.45, 'rgba(215,230,248,0.45)');
  r.addColorStop(1, 'rgba(200,215,235,0)');
  ctx.fillStyle = r;
  ctx.beginPath();
  ctx.arc(16, 122, 11, 0, Math.PI * 2);
  ctx.fill();
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Ground splash: expanding ring + crown droplets (64×64). */
function splashTexture(): THREE.Texture {
  const cv = document.createElement('canvas');
  cv.width = 64; cv.height = 64;
  const ctx = cv.getContext('2d')!;
  const g = ctx.createRadialGradient(32, 32, 10, 32, 32, 30);
  g.addColorStop(0, 'rgba(255,255,255,0)');
  g.addColorStop(0.62, 'rgba(255,255,255,0)');
  g.addColorStop(0.78, 'rgba(230,240,252,0.85)');
  g.addColorStop(0.92, 'rgba(210,225,245,0.30)');
  g.addColorStop(1, 'rgba(200,215,235,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  // crown droplets
  ctx.fillStyle = 'rgba(230,240,252,0.8)';
  for (let k = 0; k < 5; k++) {
    const a = -Math.PI / 2 + (k - 2) * 0.5;
    ctx.beginPath();
    ctx.arc(32 + 14 * Math.cos(a), 32 + 14 * Math.sin(a), 1.8, 0, Math.PI * 2);
    ctx.fill();
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

let ripplePair: THREE.Texture[] | null = null;

/**
 * Dual concentric-ripple NORMAL MAPS (the wet-road clearcoat animation).
 * 14 seeded ripple sources per map, wrapping, b=235 — two variants get
 * scrolled in opposite directions and alternated every frame.
 */
export function rippleNormalPair(): THREE.Texture[] {
  if (ripplePair) return ripplePair;
  const make = (seed: number): THREE.Texture => {
    const cv = document.createElement('canvas');
    cv.width = 256; cv.height = 256;
    const ctx = cv.getContext('2d')!;
    const img = ctx.createImageData(256, 256);
    const src: { x: number; y: number; r: number; k: number }[] = [];
    let s = seed;
    const rng = (): number => (s = (16807 * s) % 0x7fffffff) / 0x7fffffff;
    for (let k = 0; k < 14; k++) {
      src.push({ x: 256 * rng(), y: 256 * rng(), r: 18 + 42 * rng(), k: 0.28 + 0.22 * rng() });
    }
    for (let py = 0; py < 256; py++) {
      for (let px = 0; px < 256; px++) {
        let nx = 0, ny = 0;
        for (const o of src) {
          let dx = Math.abs(px - o.x); dx = Math.min(dx, 256 - dx);
          let dy = Math.abs(py - o.y); dy = Math.min(dy, 256 - dy);
          const d = Math.hypot(dx, dy);
          if (d > o.r || d < 0.5) continue;
          const amp = Math.sin(d * o.k * Math.PI * 2) * Math.sin(d / o.r * Math.PI) * 0.55;
          nx += (dx / d) * amp;
          ny += (dy / d) * amp;
        }
        const a = (256 * py + px) * 4;
        img.data[a] = Math.max(0, Math.min(255, 128 + 90 * nx));
        img.data[a + 1] = Math.max(0, Math.min(255, 128 + 90 * ny));
        img.data[a + 2] = 235;
        img.data[a + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    const t = new THREE.CanvasTexture(cv);
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    return t;
  };
  ripplePair = [make(1234567), make(7654321)];
  return ripplePair;
}

export function makeRainSystem(): RainSystem {
  const group = new THREE.Group();
  group.name = 'rainSystem';

  // ---- streaks (instanced billboards) -----------------------------------------
  const streakTex = rainStreakTexture();
  const streakMat = new THREE.MeshBasicMaterial({
    map: streakTex, transparent: true, opacity: 0.78, depthWrite: false,
    side: THREE.DoubleSide, fog: false,
  });
  const streakGeo = new THREE.PlaneGeometry(1, 1);
  const streaks = new THREE.InstancedMesh(streakGeo, streakMat, RAIN_COUNT);
  streaks.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  streaks.frustumCulled = false;
  streaks.renderOrder = 20;
  group.add(streaks);

  const pos = new Float32Array(RAIN_COUNT * 3);   // drop positions
  const fall = new Float32Array(RAIN_COUNT);      // fall speed
  const drift = new Float32Array(RAIN_COUNT);     // lateral wind
  const len = new Float32Array(RAIN_COUNT);       // per-drop length scale
  for (let i = 0; i < RAIN_COUNT; i++) {
    fall[i] = 22 + 14 * Math.random();
    drift[i] = (Math.random() - 0.5) * 5;
    len[i] = 0.55 + 0.7 * Math.random();
  }
  const seed = (i: number, cx: number, cz: number, anywhere: boolean): void => {
    const a = Math.random() * Math.PI * 2;
    const r = RAIN_R * Math.sqrt(Math.random());
    pos[3 * i] = cx + Math.cos(a) * r;
    pos[3 * i + 1] = anywhere ? RAIN_H * Math.random() : RAIN_H * (0.85 + 0.15 * Math.random());
    pos[3 * i + 2] = cz + Math.sin(a) * r;
  };
  for (let i = 0; i < RAIN_COUNT; i++) seed(i, 0, 0, true);

  // ---- ground splashes (flat instanced quads) -----------------------------------
  const splashTex = splashTexture();
  const splashMat = new THREE.MeshBasicMaterial({
    map: splashTex, transparent: true, depthWrite: false,
    color: 0xeaf2ff, blending: THREE.AdditiveBlending, fog: true,
  });
  const splashGeo = new THREE.PlaneGeometry(1, 1);
  const splashes = new THREE.InstancedMesh(splashGeo, splashMat, SPLASH_COUNT);
  splashes.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  splashes.frustumCulled = false;
  splashes.renderOrder = 19;
  group.add(splashes);
  // splash state: x, y, z, t, dur per slot
  const sp = new Float32Array(SPLASH_COUNT * 5);
  const spBright = new Float32Array(SPLASH_COUNT);
  for (let i = 0; i < SPLASH_COUNT; i++) sp[5 * i + 3] = 1e9;   // dormant
  let splashIdx = 0;

  // ---- mist / spray pool (rooster tails) ----------------------------------------
  const sprayTex = cloudTextures()[0];   // soft radial puff = spray particle
  const mists: { m: THREE.Sprite; vx: number; vy: number; vz: number; life: number }[] = [];
  for (let i = 0; i < MIST_COUNT; i++) {
    const m = new THREE.Sprite(new THREE.SpriteMaterial({
      map: sprayTex, transparent: true, opacity: 0, color: 0xdde6f0,
      depthWrite: false, fog: true,
    }));
    m.visible = false;
    group.add(m);
    mists.push({ m, vx: 0, vy: 0, vz: 0, life: 0 });
  }
  let mistIdx = 0;
  const emitMist = (x: number, y: number, z: number, bx: number, bz: number, s: number): void => {
    const p = mists[mistIdx];
    mistIdx = (mistIdx + 1) % mists.length;
    p.m.visible = true;
    p.m.position.set(x, y, z);
    const sc = 0.7 + 0.05 * s;
    p.m.scale.set(sc, sc, 1);
    p.vx = bx * (3 + 3 * Math.random()) + (Math.random() - 0.5) * 2.5;
    p.vy = 1.2 + 2.2 * Math.random() + 0.04 * s;
    p.vz = bz * (3 + 3 * Math.random()) + (Math.random() - 0.5) * 2.5;
    p.life = 0.55 + 0.4 * Math.random();
    (p.m.material as THREE.SpriteMaterial).opacity = 0.42;
  };

  // ---- wet-road ripple animation --------------------------------------------------
  const [rippleA, rippleB] = rippleNormalPair();
  const wetRoads: THREE.MeshPhysicalMaterial[] = [];
  let rippleT = 0;

  // scratch
  const camVel = new THREE.Vector3();
  const m4 = new THREE.Matrix4();
  const scaleV = new THREE.Vector3();
  const upV = new THREE.Vector3();
  const toCam = new THREE.Vector3();
  const sideV = new THREE.Vector3();
  const up2 = new THREE.Vector3();
  const col = new THREE.Color();
  let first = true;

  const dbg = { frames: 0, emits: 0, lastCamX: 0, lastCamZ: 0, carsNear: 0 };
  (group as unknown as { __dbg: object }).__dbg = dbg;
  const sys = {
    group,
    wetRoads,
    update(dt: number, camPos: THREE.Vector3, vel: THREE.Vector3, cars: RainCarLike[]) {
      dbg.frames++;
      dbg.lastCamX = camPos.x; dbg.lastCamZ = camPos.z;
      dbg.carsNear = cars.filter(c => c.speed >= 16 && c.pos.distanceToSquared(camPos) <= 130 * 130).length;
      // clamp: a stalled frame (tab switch, slow machine) must not fast-forward
      // the spray/splash lifetimes to death in a single step
      dt = Math.min(dt, 0.05);
      camVel.copy(vel);
      rippleT += dt;
      rippleA.offset.set(0.008 * rippleT, 0.011 * rippleT);
      rippleB.offset.set(-0.006 * rippleT, 0.007 * rippleT);
      for (const m of wetRoads) {
        m.clearcoatNormalMap = m.clearcoatNormalMap === rippleA ? rippleB : rippleA;
      }
      const cx = camPos.x, cz = camPos.z;
      const wind = Math.min(0.75, 0.014 * camVel.length());
      const reseed = first;
      first = false;

      for (let i = 0; i < RAIN_COUNT; i++) {
        let y = pos[3 * i + 1] - fall[i] * dt;
        let x = pos[3 * i] + drift[i] * dt;
        let z = pos[3 * i + 2] + 0.6 * drift[i] * dt;
        if (y < 0) {
          // landed: spawn a splash ring, reseed the drop
          const s5 = splashIdx * 5;
          spBright[splashIdx] = 0.85 + 0.15 * Math.random();
          sp[s5] = x; sp[s5 + 1] = 0.06; sp[s5 + 2] = z;
          sp[s5 + 3] = 0; sp[s5 + 4] = 0.35 + 0.3 * Math.random();
          splashIdx = (splashIdx + 1) % SPLASH_COUNT;
          seed(i, cx, cz, false);
          continue;
        }
        if (Math.abs(x - cx) > 42 || Math.abs(z - cz) > 42) {
          seed(i, cx, cz, false);
          continue;
        }
        pos[3 * i] = x; pos[3 * i + 1] = y; pos[3 * i + 2] = z;
        // billboard basis: streak plane faces the camera, stretched along the
        // fall direction (drift + wind from car motion)
        upV.set(drift[i] + camVel.x * wind * 0.5, -fall[i], 0.6 * drift[i] + camVel.z * wind * 0.5).normalize();
        toCam.set(cx - x, camPos.y - y, cz - z).normalize();
        sideV.crossVectors(upV, toCam);
        if (sideV.lengthSq() < 1e-4) sideV.set(1, 0, 0); else sideV.normalize();
        up2.crossVectors(sideV, upV);
        m4.makeBasis(sideV, upV, up2);
        const stretch = len[i] * (1 + 1.6 * wind);
        scaleV.set(0.085 + 0.075 * stretch, stretch, 1);
        m4.scale(scaleV);
        m4.setPosition(x, y, z);
        streaks.setMatrixAt(i, m4);
      }
      streaks.instanceMatrix.needsUpdate = true;

      // splash rings: expand + fade, flat on the ground
      for (let s = 0; s < SPLASH_COUNT; s++) {
        const t = sp[5 * s + 3], dur = sp[5 * s + 4];
        if (t > dur) {
          m4.makeScale(0, 0, 0);
          splashes.setMatrixAt(s, m4);
          continue;
        }
        sp[5 * s + 3] = t + dt;
        const r = Math.min(1, t / dur);
        const sc = 0.18 + 0.55 * r;
        m4.makeRotationX(-Math.PI / 2);
        scaleV.set(sc, sc, 1);
        m4.scale(scaleV);
        m4.setPosition(sp[5 * s], sp[5 * s + 1], sp[5 * s + 2]);
        splashes.setMatrixAt(s, m4);
        col.setScalar((1 - r) * spBright[s]);
        splashes.setColorAt(s, col);
      }
      splashes.instanceMatrix.needsUpdate = true;
      if (splashes.instanceColor) splashes.instanceColor.needsUpdate = true;

      // rooster-tail spray behind EVERY fast car near the camera
      for (const car of cars) {
        if (car.speed < 16 || car.pos.distanceToSquared(camPos) > 130 * 130) continue;
        const bx = -Math.sin(car.yaw), bz = -Math.cos(car.yaw);
        const n = car.speed > 45 ? 3 : 2;
        dbg.emits += n;
        for (let k = 0; k < n; k++) {
          emitMist(
            car.pos.x + (Math.random() - 0.5) * 1.9,
            0.25 + 0.2 * Math.random(),
            car.pos.z + (Math.random() - 0.5) * 1.9,
            bx + (Math.random() - 0.5) * 0.8,
            bz + (Math.random() - 0.5) * 0.8,
            car.speed);
        }
      }
      // mist motion
      for (const p of mists) {
        if (!p.m.visible) continue;
        p.life -= dt;
        if (p.life <= 0) { p.m.visible = false; continue; }
        p.m.position.x += p.vx * dt;
        p.m.position.y += p.vy * dt;
        p.m.position.z += p.vz * dt;
        p.vy -= 2.2 * dt;
        const grow = 1 + 1.7 * dt;
        p.m.scale.x *= grow; p.m.scale.y *= grow;
        (p.m.material as THREE.SpriteMaterial).opacity = Math.min(0.42, 0.6 * p.life);
      }
      void reseed;
    },
    dispose() {
      streakGeo.dispose(); streakMat.dispose(); streakTex.dispose();
      splashGeo.dispose(); splashMat.dispose(); splashTex.dispose();
      for (const p of mists) (p.m.material as THREE.SpriteMaterial).dispose();
    },
  };
  (group as unknown as { __sys: object }).__sys = sys;
  return sys;
}

/**
 * Cloud field v2 — layered sky:
 *  - 3 texture variants (cumulus / stratus / cirrus) mixed per cloud
 *  - sun-side brightening: clouds toward the sun tint warm, away stay cool
 *  - two altitude bands (low banks + high thin streaks)
 *  - per-cloud size / opacity / drift variety — no clone-stamped ring
 */
export function makeCloudLayer(style: WeatherStyle, cx: number, cz: number): CloudLayer {
  const group = new THREE.Group();
  const [cumulus, stratus, cirrus] = cloudTextures();
  const night = style.night;
  const drifters: { m: THREE.Mesh; vx: number }[] = [];

  // ---- main field: cumulus + stratus banks around the horizon band ---------
  const count = Math.round(style.clouds);
  for (let i = 0; i < count; i++) {
    // 62% puffy cumulus, 38% stretched stratus — variety per bank
    const tex = Math.random() < 0.62 ? cumulus : stratus;
    const toSun = 0.5 + 0.5 * Math.random();       // per-cloud sun exposure
    const base = new THREE.Color(style.cloudColor);
    // sun-side clouds catch a warm kiss of sunlight
    base.lerp(new THREE.Color(night ? 0x2a3448 : 0xfff1dd), toSun * (night ? 0.1 : 0.38));
    const mat = new THREE.MeshBasicMaterial({
      map: tex, transparent: true, opacity: style.cloudOpacity * (0.55 + Math.random() * 0.4),
      color: base, depthWrite: false, fog: false,
    });
    // wide, LOW banks hugging the horizon band — the chase cam has a narrow
    // FOV and looks slightly down, so clouds at 250 m altitude are never
    // in frame; 55-135 m at 320-880 m sits right in the visible sky band.
    const size = (tex === stratus ? 320 : 240) + Math.random() * 240;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size * (tex === stratus ? 0.34 : 0.42)), mat);
    const a = Math.random() * Math.PI * 2;
    const r = 320 + Math.random() * 560;
    m.position.set(cx + Math.cos(a) * r, 55 + Math.random() * 80, cz + Math.sin(a) * r);
    m.rotation.y = Math.random() * Math.PI;
    m.renderOrder = -5;
    group.add(m);
    drifters.push({ m, vx: (4 + Math.random() * 5) * style.cloudDrift });
  }

  // ---- high thin cirrus streaks: 2-4 subtle depth layers, never a blanket --
  if (!night && style.clouds > 0) {
    const streaks = 2 + Math.floor(style.clouds / 8);
    for (let i = 0; i < streaks; i++) {
      const mat = new THREE.MeshBasicMaterial({
        map: cirrus, transparent: true, opacity: 0.08 + Math.random() * 0.1,
        color: new THREE.Color(style.cloudColor).lerp(new THREE.Color(0xffffff), 0.55),
        depthWrite: false, fog: false,
      });
      const size = 420 + Math.random() * 240;
      const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size * 0.16), mat);
      const a = Math.random() * Math.PI * 2;
      const r = 420 + Math.random() * 620;
      m.position.set(cx + Math.cos(a) * r, 165 + Math.random() * 85, cz + Math.sin(a) * r);
      m.rotation.y = Math.random() * Math.PI;
      m.renderOrder = -6;
      group.add(m);
      drifters.push({ m, vx: (2.2 + Math.random() * 2.4) * style.cloudDrift });
    }
  }

  let t = 0;
  return {
    group,
    update(dt: number): void {
      t += dt;
      for (const d of drifters) {
        d.m.position.x += d.vx * dt;
        // keep clouds roughly around the circuit
        if (d.m.position.x - cx > 1150) d.m.position.x = cx - 1150;
      }
      void t;
    },
  };
}
