/**
 * APEX GP — Procedural circuit textures (canvas → THREE).
 * Everything is generated at runtime: no external image assets.
 */

import * as THREE from 'three';

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return [c, c.getContext('2d')!];
}

function noise(ctx: CanvasRenderingContext2D, w: number, h: number, alpha: number, mono = true): void {
  for (let i = 0; i < w * h * 0.22; i++) {
    const x = Math.random() * w, y = Math.random() * h;
    const v = Math.floor(Math.random() * 255);
    ctx.fillStyle = mono
      ? `rgba(${v},${v},${v},${alpha})`
      : `rgba(${v},${Math.floor(Math.random() * 60)},${Math.floor(Math.random() * 60)},${alpha})`;
    ctx.fillRect(x, y, 1.2, 1.2);
  }
}

/** Dark F1 asphalt with a rubbered racing groove. Tileable on V. */
export function asphaltTexture(): THREE.Texture {
  const [c, ctx] = canvas(256, 256);
  ctx.fillStyle = '#33343a';
  ctx.fillRect(0, 0, 256, 256);
  noise(ctx, 256, 256, 0.10);
  // rubbered groove down the middle (marbles off-line are handled by tint)
  const grad = ctx.createLinearGradient(0, 0, 256, 0);
  grad.addColorStop(0.18, 'rgba(20,20,24,0)');
  grad.addColorStop(0.42, 'rgba(20,20,24,0.34)');
  grad.addColorStop(0.58, 'rgba(20,20,24,0.34)');
  grad.addColorStop(0.82, 'rgba(20,20,24,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 256, 256);
  // faint aggregate speckles
  for (let i = 0; i < 300; i++) {
    ctx.fillStyle = `rgba(120,122,130,${0.05 + Math.random() * 0.07})`;
    ctx.fillRect(Math.random() * 256, Math.random() * 256, 2, 2);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** Roughness map matching the groove (rubber = smoother). */
export function asphaltRoughness(): THREE.Texture {
  const [c, ctx] = canvas(128, 128);
  ctx.fillStyle = '#b8b8b8';
  ctx.fillRect(0, 0, 128, 128);
  noise(ctx, 128, 128, 0.16);
  const grad = ctx.createLinearGradient(0, 0, 128, 0);
  grad.addColorStop(0.2, 'rgba(70,70,70,0)');
  grad.addColorStop(0.5, 'rgba(70,70,70,0.5)');
  grad.addColorStop(0.8, 'rgba(70,70,70,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/** WET roughness map: near-black mirror PUDDLES + soaked rubbered groove —
 *  dark = glossy = the road visibly mirrors the sky in patches. */
export function asphaltRoughnessWet(): THREE.Texture {
  const [c, ctx] = canvas(256, 256);
  ctx.fillStyle = '#5e5e5e';                       // damp base (glossy-ish)
  ctx.fillRect(0, 0, 256, 256);
  noise(ctx, 256, 256, 0.12);
  // soaked racing groove
  const grad = ctx.createLinearGradient(0, 0, 256, 0);
  grad.addColorStop(0.2, 'rgba(28,28,28,0)');
  grad.addColorStop(0.5, 'rgba(24,24,24,0.85)');
  grad.addColorStop(0.8, 'rgba(28,28,28,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 256, 256);
  // irregular puddles (soft dark blobs — mirror patches)
  for (let i = 0; i < 26; i++) {
    const x = Math.random() * 256, y = Math.random() * 256;
    const r = 8 + Math.random() * 26;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(10,10,10,0.95)');
    g.addColorStop(0.55, 'rgba(18,18,18,0.55)');
    g.addColorStop(1, 'rgba(30,30,30,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/** Foliage noise for tree crowns: light/dark green speckle + darker base
 *  gradient (multiplied by the crown material color). */
let foliageCache: THREE.Texture | null = null;
export function foliageTexture(): THREE.Texture {
  if (foliageCache) return foliageCache;
  const [c, ctx] = canvas(128, 128);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 2600; i++) {
    const v = 150 + Math.floor(Math.random() * 105);
    ctx.fillStyle = `rgba(${v},${v},${v},${0.25 + Math.random() * 0.4})`;
    const x = Math.random() * 128, y = Math.random() * 128;
    ctx.fillRect(x, y, 1 + Math.random() * 2.5, 1 + Math.random() * 2.5);
  }
  // clumping — darker gaps between needle clusters
  for (let i = 0; i < 400; i++) {
    ctx.fillStyle = `rgba(60,70,50,${0.1 + Math.random() * 0.22})`;
    ctx.fillRect(Math.random() * 128, Math.random() * 128, 2 + Math.random() * 4, 2 + Math.random() * 4);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  foliageCache = tex;
  return tex;
}

/** Red/white kerb stripes (1 tile = 1 stripe pair along the road). */
export function kerbTexture(): THREE.Texture {
  const [c, ctx] = canvas(64, 64);
  ctx.fillStyle = '#e8e8ea';
  ctx.fillRect(0, 0, 64, 64);
  ctx.fillStyle = '#d40000';
  ctx.fillRect(0, 0, 64, 32);
  // wear dirt
  noise(ctx, 64, 64, 0.08);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Pale asphalt run-off with painted red/white edge. */
export function runoffTexture(): THREE.Texture {
  const [c, ctx] = canvas(128, 128);
  ctx.fillStyle = '#5c5e66';
  ctx.fillRect(0, 0, 128, 128);
  noise(ctx, 128, 128, 0.12);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Mown grass. */
export function grassTexture(): THREE.Texture {
  const [c, ctx] = canvas(128, 128);
  ctx.fillStyle = '#3f6b2e';
  ctx.fillRect(0, 0, 128, 128);
  noise(ctx, 128, 128, 0.14, false);
  for (let i = 0; i < 40; i++) {
    ctx.fillStyle = `rgba(${70 + Math.random() * 40},${110 + Math.random() * 40},50,0.25)`;
    ctx.fillRect(Math.random() * 128, Math.random() * 128, 8, 3);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Gravel trap. */
export function gravelTexture(): THREE.Texture {
  const [c, ctx] = canvas(128, 128);
  ctx.fillStyle = '#9a8a72';
  ctx.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 1400; i++) {
    const v = 140 + Math.floor(Math.random() * 80);
    ctx.fillStyle = `rgba(${v},${v - 18},${v - 40},0.6)`;
    ctx.fillRect(Math.random() * 128, Math.random() * 128, 2.5, 2.5);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Crowd texture for grandstands. */
export function crowdTexture(): THREE.Texture {
  const [c, ctx] = canvas(128, 96);
  ctx.fillStyle = '#17181d';
  ctx.fillRect(0, 0, 128, 96);
  const palette = ['#e2e6ee', '#d4453a', '#3d6fd8', '#e8c04a', '#43a35c', '#e0803a', '#b04ad0', '#f0f0f0'];
  for (let y = 6; y < 92; y += 6) {
    for (let x = 2; x < 126; x += 4) {
      ctx.fillStyle = palette[Math.floor(Math.random() * palette.length)];
      ctx.globalAlpha = 0.55 + Math.random() * 0.45;
      ctx.fillRect(x + Math.random() * 1.6, y, 2.6, 3.4);
    }
  }
  ctx.globalAlpha = 1;
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Number/labeled board (DRS, brake markers, chevrons). */
export function boardTexture(kind: 'drs' | 'brake' | 'chevron', label = ''): THREE.Texture {
  const [c, ctx] = canvas(128, 96);
  if (kind === 'drs') {
    ctx.fillStyle = '#0a0a0c';
    ctx.fillRect(0, 0, 128, 96);
    ctx.fillStyle = '#00e07a';
    ctx.font = '900 44px "Arial Black", Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('DRS', 64, 50);
  } else if (kind === 'brake') {
    ctx.fillStyle = '#0d0d10';
    ctx.fillRect(0, 0, 128, 96);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(8, 8, 112, 80);
    ctx.fillStyle = '#d40000';
    ctx.font = '900 58px "Arial Black", Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label || '100', 64, 52);
  } else {
    ctx.fillStyle = '#d40000';
    ctx.fillRect(0, 0, 128, 96);
    ctx.fillStyle = '#ffffff';
    for (let i = -2; i < 6; i++) {
      ctx.save();
      ctx.translate(i * 32, 48);
      ctx.rotate(-0.5);
      ctx.fillRect(-9, -80, 18, 160);
      ctx.restore();
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Checkered finish-line strip (2 rows of squares). */
export function checkerTexture(): THREE.Texture {
  const [c, ctx] = canvas(64, 32);
  for (let y = 0; y < 2; y++) {
    for (let x = 0; x < 8; x++) {
      ctx.fillStyle = (x + y) % 2 === 0 ? '#f2f2f2' : '#111114';
      ctx.fillRect(x * 8, y * 16, 8, 16);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
