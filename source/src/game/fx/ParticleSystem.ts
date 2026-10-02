/**
 * APEX KART — Pooled GPU point-sprite particle system.
 * One draw call for up to 900 particles: drift sparks (blue/orange/purple),
 * boost flames, offroad dust, impacts, star trails, confetti, puffs.
 * Fade is achieved by scaling color toward black under additive blending.
 */

import * as THREE from 'three';
import { makeRng } from '../core/MathUtils';

const MAX = 900;

export class ParticleSystem {
  readonly points: THREE.Points;
  private pos: Float32Array;
  private col: Float32Array;
  private size: Float32Array;
  private vel: Float32Array;
  private life: Float32Array;
  private maxLife: Float32Array;
  private grav: Float32Array;
  private cursor = 0;
  private rng = makeRng(31337);

  constructor() {
    this.pos = new Float32Array(MAX * 3);
    this.col = new Float32Array(MAX * 3);
    this.size = new Float32Array(MAX);
    this.vel = new Float32Array(MAX * 3);
    this.life = new Float32Array(MAX);
    this.maxLife = new Float32Array(MAX);
    this.grav = new Float32Array(MAX);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(this.col, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1));
    geo.setDrawRange(0, MAX);

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uTex: { value: makeSpriteTexture() } },
      vertexShader: `
        attribute float aSize;
        attribute vec3 aColor;
        varying vec3 vColor;
        void main() {
          vColor = aColor;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * (240.0 / -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform sampler2D uTex;
        varying vec3 vColor;
        void main() {
          vec4 t = texture2D(uTex, gl_PointCoord);
          gl_FragColor = vec4(vColor * t.a, t.a);
        }`,
    });

    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    // init all dead
    this.life.fill(0);
    this.size.fill(0);
  }

  private spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number,
    r: number, g: number, b: number, life: number, size: number, gravity: number): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % MAX;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.col[i * 3] = r; this.col[i * 3 + 1] = g; this.col[i * 3 + 2] = b;
    this.life[i] = life; this.maxLife[i] = life;
    this.size[i] = size;
    this.grav[i] = gravity;
  }

  // ------------------------------------------------------------------ emitters

  /** Drift sparks at rear wheels. Level 1..3 = blue/orange/purple. */
  driftSpark(p: THREE.Vector3, level: number, side: number): void {
    const c = level >= 3 ? [0.72, 0.36, 1.0] : level === 2 ? [1.0, 0.65, 0.2] : [0.28, 0.75, 1.0];
    const spread = 0.35 + this.rng() * 0.5;
    this.spawn(
      p.x + (this.rng() - 0.5) * 0.4, p.y + 0.15, p.z + side * 0.8 + (this.rng() - 0.5) * 0.4,
      (this.rng() - 0.5) * 3, 1.2 + this.rng() * 2.5, (this.rng() - 0.5) * 3,
      c[0] * spread + 0.2, c[1] * spread + 0.2, c[2] * spread + 0.2,
      0.35 + this.rng() * 0.3, 0.55 + level * 0.12, -6,
    );
  }

  boostFlame(p: THREE.Vector3): void {
    this.spawn(
      p.x + (this.rng() - 0.5) * 0.5, p.y + 0.3 + (this.rng() - 0.5) * 0.3, p.z,
      (this.rng() - 0.5) * 2, 0.5 + this.rng(), (this.rng() - 0.5) * 2,
      1.0, 0.55 + this.rng() * 0.3, 0.1,
      0.3, 0.9, 0,
    );
  }

  offroadDust(p: THREE.Vector3): void {
    const v = 0.5 + this.rng() * 0.3;
    this.spawn(
      p.x + (this.rng() - 0.5) * 0.8, p.y + 0.12, p.z + (this.rng() - 0.5) * 0.8,
      (this.rng() - 0.5) * 1.5, 0.8 + this.rng() * 1.2, (this.rng() - 0.5) * 1.5,
      v, v * 0.9, v * 0.7,
      0.55, 1.1, 0.5,
    );
  }

  impactStar(p: THREE.Vector3): void {
    for (let i = 0; i < 10; i++) {
      const a = this.rng() * Math.PI * 2;
      const s = 3 + this.rng() * 4;
      this.spawn(p.x, p.y + 0.8, p.z,
        Math.cos(a) * s, 2 + this.rng() * 3, Math.sin(a) * s,
        1.0, 0.9, 0.3, 0.5, 0.8, -8);
    }
  }

  starTrail(p: THREE.Vector3, t: number): void {
    const hue = (t * 0.6) % 1;
    const c = new THREE.Color().setHSL(hue, 1, 0.6);
    this.spawn(
      p.x + (this.rng() - 0.5) * 0.6, p.y + 0.4 + (this.rng() - 0.5) * 0.4, p.z,
      (this.rng() - 0.5) * 0.8, 0.6, (this.rng() - 0.5) * 0.8,
      c.r, c.g, c.b, 0.5, 0.8, 0,
    );
  }

  confettiBurst(p: THREE.Vector3): void {
    for (let i = 0; i < 26; i++) {
      const c = new THREE.Color().setHSL(this.rng(), 0.9, 0.6);
      this.spawn(
        p.x + (this.rng() - 0.5) * 2, p.y + 2 + this.rng() * 3, p.z + (this.rng() - 0.5) * 2,
        (this.rng() - 0.5) * 5, 3 + this.rng() * 5, (this.rng() - 0.5) * 5,
        c.r, c.g, c.b, 1.6 + this.rng(), 0.7, -7,
      );
    }
  }

  puff(p: THREE.Vector3, color: [number, number, number] = [0.8, 0.8, 0.9]): void {
    for (let i = 0; i < 14; i++) {
      const a = this.rng() * Math.PI * 2;
      this.spawn(p.x, p.y + 0.6, p.z,
        Math.cos(a) * (1 + this.rng() * 2), 1 + this.rng() * 2, Math.sin(a) * (1 + this.rng() * 2),
        color[0], color[1], color[2], 0.6, 1.3, -2);
    }
  }

  /** Golden pop when a kart grabs a coin. */
  coinSparkle(p: THREE.Vector3): void {
    for (let i = 0; i < 7; i++) {
      const a = this.rng() * Math.PI * 2;
      const s = 1.2 + this.rng() * 2;
      this.spawn(p.x, p.y + 0.5, p.z,
        Math.cos(a) * s, 1.5 + this.rng() * 2.5, Math.sin(a) * s,
        1.0, 0.82, 0.25, 0.4 + this.rng() * 0.2, 0.55, -4);
    }
  }

  /** Golden fountain of stolen coins when a kart gets hit. */
  coinLossBurst(p: THREE.Vector3, count: number): void {
    for (let i = 0; i < Math.min(12, count * 4); i++) {
      const a = this.rng() * Math.PI * 2;
      const s = 2 + this.rng() * 3.5;
      this.spawn(p.x, p.y + 0.7, p.z,
        Math.cos(a) * s, 3 + this.rng() * 4, Math.sin(a) * s,
        1.0, 0.75, 0.18, 0.6, 0.7, -10);
    }
  }

  /** Cyan burst when a stunt lands clean (MK8 trick boost). */
  trickBurst(p: THREE.Vector3): void {
    for (let i = 0; i < 12; i++) {
      const a = this.rng() * Math.PI * 2;
      const s = 2.5 + this.rng() * 3;
      this.spawn(p.x, p.y + 0.5, p.z,
        Math.cos(a) * s, 1 + this.rng() * 3, Math.sin(a) * s,
        0.35, 0.95, 1.0, 0.45, 0.7, -5);
    }
  }

  /**
   * v8 slipstream streaks: whitish speed lines whipping past the kart while
   * it sits in a rival's draft. `charge` 0..1 = draft buildup (dim, thin),
   * `active` = the boost itself (bright, chunky).
   */
  slipstreamStreak(p: THREE.Vector3, back: THREE.Vector3, charge: number, active: boolean): void {
    const n = active ? 3 : charge > 0.2 ? 2 : 1;
    const bright = active ? 0.85 : 0.35 + charge * 0.35;
    for (let i = 0; i < n; i++) {
      const side = this.rng() > 0.5 ? 1 : -1;
      const off = (1.1 + this.rng() * 0.9) * side;
      // perpendicular to the kart heading (back is the rearward vector)
      this.spawn(
        p.x - back.z * off + (this.rng() - 0.5) * 0.3,
        p.y + 0.35 + this.rng() * 0.75,
        p.z + back.x * off + (this.rng() - 0.5) * 0.3,
        back.x * (14 + this.rng() * 8), (this.rng() - 0.5) * 1.5, back.z * (14 + this.rng() * 8),
        bright, bright, bright + 0.1,
        active ? 0.5 + this.rng() * 0.3 : 0.3, 0.16 + this.rng() * 0.08, 0,
      );
    }
  }

  /** White-hot metallic sparks — kart crashes and guardrail scrapes. */
  sparkBurst(p: THREE.Vector3, strength = 1): void {
    const n = Math.round(8 + 14 * Math.min(1.4, strength));
    for (let i = 0; i < n; i++) {
      const a = this.rng() * Math.PI * 2;
      const s = (2 + this.rng() * 5) * strength;
      this.spawn(p.x, p.y + 0.45, p.z,
        Math.cos(a) * s, 1.5 + this.rng() * 4 * strength, Math.sin(a) * s,
        1.0, 0.85, 0.45 + this.rng() * 0.15, 0.3 + this.rng() * 0.25, 0.42, -14);
    }
  }

  /**
   * Item-hit bursts with a per-family signature so the victim (and everyone
   * behind them) can read WHAT just landed:
   *   zap = cyan electric scatter (darts)
   *   seeker = magenta pop with slow fall (seeker orb)
   *   blast = orange/fire explosion, fast + hot (mine / track hunter)
   *   goo = green drips that fall and die fast (goo trap)
   *   storm = violet sparks raining DOWN onto the victim
   */
  itemHitBurst(p: THREE.Vector3, fx: string): void {
    switch (fx) {
      case 'zap':
        for (let i = 0; i < 16; i++) {
          const a = this.rng() * Math.PI * 2;
          const s = 4 + this.rng() * 7;
          this.spawn(p.x, p.y + 0.9, p.z,
            Math.cos(a) * s, 2 + this.rng() * 4, Math.sin(a) * s,
            0.2, 0.88, 1.0, 0.3 + this.rng() * 0.2, 0.5, -2);
        }
        break;
      case 'seeker':
        for (let i = 0; i < 20; i++) {
          const a = this.rng() * Math.PI * 2;
          const s = 3 + this.rng() * 5;
          this.spawn(p.x, p.y + 0.9, p.z,
            Math.cos(a) * s, 1.5 + this.rng() * 3.5, Math.sin(a) * s,
            1.0, 0.35, 0.85, 0.4, 0.75, -3.5);
        }
        break;
      case 'blast':
        for (let i = 0; i < 26; i++) {
          const a = this.rng() * Math.PI * 2;
          const s = 3 + this.rng() * 8;
          this.spawn(p.x, p.y + 0.6, p.z,
            Math.cos(a) * s, 2.5 + this.rng() * 6, Math.sin(a) * s,
            1.0, 0.45 + this.rng() * 0.25, 0.1, 0.45, 0.55, -9);
        }
        break;
      case 'goo':
        for (let i = 0; i < 18; i++) {
          const a = this.rng() * Math.PI * 2;
          const s = 1.5 + this.rng() * 3.5;
          this.spawn(p.x, p.y + 1.0, p.z,
            Math.cos(a) * s, 0.5 + this.rng() * 2, Math.sin(a) * s,
            0.35, 0.95, 0.3, 0.5, 0.9, -16);
        }
        break;
      case 'storm':
        for (let i = 0; i < 22; i++) {
          const a = this.rng() * Math.PI * 2;
          const r = this.rng() * 2.2;
          this.spawn(p.x + Math.cos(a) * r, p.y + 5 + this.rng() * 2, p.z + Math.sin(a) * r,
            (this.rng() - 0.5) * 1.5, -7 - this.rng() * 4, (this.rng() - 0.5) * 1.5,
            0.72, 0.4, 1.0, 0.28, 0.6, 0);
        }
        break;
      default:
        this.impactStar(p);
    }
  }

  // ------------------------------------------------------------------ update

  update(dt: number): void {
    const pos = this.pos, vel = this.vel, life = this.life, col = this.col;
    for (let i = 0; i < MAX; i++) {
      if (life[i] <= 0) { this.size[i] = 0; continue; }
      life[i] -= dt;
      const f = Math.max(0, life[i] / this.maxLife[i]);
      vel[i * 3 + 1] += this.grav[i] * dt;
      pos[i * 3] += vel[i * 3] * dt;
      pos[i * 3 + 1] += vel[i * 3 + 1] * dt;
      pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
      // fade color (additive => fades to invisible)
      col[i * 3] *= 0.965;
      col[i * 3 + 1] *= 0.965;
      col[i * 3 + 2] *= 0.965;
      this.size[i] = Math.max(0, f * this.size[i] + 0.001); // shrink slightly
    }
    const geo = this.points.geometry;
    (geo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (geo.getAttribute('aColor') as THREE.BufferAttribute).needsUpdate = true;
    (geo.getAttribute('aSize') as THREE.BufferAttribute).needsUpdate = true;
  }
}

function makeSpriteTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 32; c.height = 32;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.4, 'rgba(255,255,255,0.6)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(c);
}
