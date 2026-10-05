/**
 * APEX GP — Real F1 asset hub.
 *
 * Loads the Dallara GP2/08 GLB chassis + photo textures (asphalt / kerb / grass)
 * once, prepares a normalized car template (front = +Z, 1.9 m wide footprint,
 * wheels hidden — procedural animated wheels replace them) and bakes per-team
 * liveries by re-mapping the source blue livery to each constructor's color.
 *
 * Everything is optional: if the assets are not loaded yet (or fail), callers
 * fall back to the procedural car / procedural textures. No load ever blocks
 * the game permanently.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { publicAsset } from '../core/Paths';

const CAR_URL = publicAsset('models/f1/f1_dallara_gp208.glb');
const TEX_ROAD = publicAsset('textures/f1/AsfaltoF1.jpg');
const TEX_KERB = publicAsset('textures/f1/Borde_PistaF1.jpg');
const TEX_GRASS = publicAsset('textures/f1/PastoF1.jpg');

/** GLB model units → game meters. Model is 2.11 × 5.66 m → 0.95 → 2.00 × 5.38 m (OBB 2.0 × 5.4). */
const CAR_SCALE = 0.95;
/** GLB sits 0.05 below y=0 → lift. */
const CAR_LIFT = 0.05;
/** Model origin is 0.28 m behind the geometric center (front wing overhang) → recentre. */
const CAR_Z_SHIFT = 0.28;

export interface CarTemplate {
  /** Root group — clone this per car. */
  root: THREE.Group;
  /** Original scene inside the normalizer (positioned/rotated). */
  body: THREE.Group;
}

export class F1Assets {
  static carTemplate: CarTemplate | null = null;
  static textures: { road: THREE.Texture; kerb: THREE.Texture; grass: THREE.Texture } | null = null;
  static get ready(): boolean { return this.carTemplate !== null; }

  private static loading: Promise<void> | null = null;
  private static liveryCache = new Map<number, THREE.CanvasTexture>();
  private static sourceLiveryCanvas: HTMLCanvasElement | null = null;

  /** Idempotent parallel load of every real asset. Never throws (falls back silently). */
  static load(): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const [car, road, kerb, grass] = await Promise.all([
        this.loadCar().catch(() => null),
        this.loadTex(TEX_ROAD).catch(() => null),
        this.loadTex(TEX_KERB).catch(() => null),
        this.loadTex(TEX_GRASS).catch(() => null),
      ]);
      if (car) this.carTemplate = car;
      if (road && kerb && grass) this.textures = { road, kerb, grass };
    })();
    return this.loading;
  }

  private static loadTex(url: string): Promise<THREE.Texture> {
    return new Promise((resolve, reject) => {
      new THREE.TextureLoader().load(url, t => {
        t.wrapS = THREE.RepeatWrapping;
        t.wrapT = THREE.RepeatWrapping;
        t.colorSpace = THREE.SRGBColorSpace;
        // max anisotropy: the kerb/road stripes stay crisp at grazing angles
        // instead of shimmering into noise at distance
        t.anisotropy = 16;
        t.userData.isPhoto = true;
        resolve(t);
      }, undefined, reject);
    });
  }

  private static loadCar(): Promise<CarTemplate> {
    return new Promise((resolve, reject) => {
      new GLTFLoader().load(CAR_URL, gltf => {
        const body = gltf.scene as THREE.Group;

        // shadows + transparency-friendly flags
        body.traverse(o => {
          const m = o as THREE.Mesh;
          if (!m.isMesh) return;
          m.castShadow = true;
          m.receiveShadow = false;
          const mats = Array.isArray(m.material) ? m.material : [m.material];
          for (const mat of mats) {
            const std = mat as THREE.MeshStandardMaterial;
            std.envMapIntensity = 1.0;
            if (std.transparent) {
              std.depthWrite = true;      // avoid seeing stripes through the paint
              std.alphaTest = 0.05;
            }
          }
        });

        // hide the static GLB wheels — animated procedural wheels replace them
        for (const name of ['Front_Tire_Rubber_low', 'Back_Tire_Rubber_low',
          'AlloysFront_low', 'AlloysBack_low', 'AlloysFrontCovers_low', 'AlloysBackCovers_low']) {
          const n = body.getObjectByName(name);
          if (n) n.visible = false;
        }

        // normalize: model front is -Z (front wing at z=-2.6) → rotate to +Z (game convention)
        const normalizer = new THREE.Group();
        normalizer.name = 'glbNormalizer';
        normalizer.rotation.y = Math.PI;
        normalizer.scale.setScalar(CAR_SCALE);
        body.position.set(0, CAR_LIFT, CAR_Z_SHIFT);
        normalizer.add(body);

        // remember the body material's original map for livery baking
        this.captureSourceLivery(body);

        resolve({ root: normalizer, body });
      }, undefined, reject);
    });
  }

  /** Grabs the F1_Base material's texture into a canvas for per-team re-coloring. */
  private static captureSourceLivery(body: THREE.Group): void {
    const found: { map: THREE.Texture | null } = { map: null };
    body.traverse(o => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || found.map) return;
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      for (const mat of mats) {
        const std = mat as THREE.MeshStandardMaterial;
        if (std.name === 'F1_Base' && std.map) { found.map = std.map; break; }
      }
    });
    const bodyMap = found.map;
    if (!bodyMap?.image) return;
    const img = bodyMap.image as { width?: number; height?: number };
    const c = document.createElement('canvas');
    c.width = Math.min(1024, img.width ?? 1024);
    c.height = Math.min(1024, img.height ?? 1024);
    const ctx = c.getContext('2d')!;
    try {
      ctx.drawImage(bodyMap.image as CanvasImageSource, 0, 0, c.width, c.height);
      this.sourceLiveryCanvas = c;
    } catch { /* tainted canvas — tinting disabled, original livery kept */ }
  }

  /**
   * Per-team livery: pixels dominated by the source blue are re-hued to the
   * team color (luminance preserved); white/black decals stay untouched.
   * Returns null when tinting isn't possible (original livery kept).
   */
  static getLivery(teamColor: number): THREE.CanvasTexture | null {
    if (!this.sourceLiveryCanvas) return null;
    const cached = this.liveryCache.get(teamColor);
    if (cached) return cached;

    const src = this.sourceLiveryCanvas;
    const w = src.width, h = src.height;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(src, 0, 0);
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;

    const tr = ((teamColor >> 16) & 255) / 255;
    const tg = ((teamColor >> 8) & 255) / 255;
    const tb = (teamColor & 255) / 255;

    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      // source livery blue: blue channel clearly dominant
      if (b > r + 18 && b >= g + 8 && b > 60) {
        // luminance of the source blue pixel, re-based so mid-blue → full team color
        const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
        const k = Math.min(1.35, 0.34 + lum * 1.35);    // keep shading, brighten mid tones
        d[i] = Math.min(255, tr * 255 * k);
        d[i + 1] = Math.min(255, tg * 255 * k);
        d[i + 2] = Math.min(255, tb * 255 * k);
      }
    }
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    tex.flipY = true;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    this.liveryCache.set(teamColor, tex);
    return tex;
  }

  /** Shared livery cache is never disposed per-car; call only on full teardown. */
  static disposeLiveries(): void {
    for (const t of this.liveryCache.values()) t.dispose();
    this.liveryCache.clear();
  }
}
