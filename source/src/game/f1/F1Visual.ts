/**
 * APEX GP — F1 car visuals.
 *
 * Primary mode: the real Dallara GP2/08 GLB chassis (team-colored livery,
 * static DRS flap animation on the rear wing) combined with the animated
 * procedural wheels (spin / steer / compound stripes / glowing brake discs)
 * positioned to match the GLB wheel arches exactly.
 *
 * Fallback mode (assets not yet loaded / failed): the fully procedural
 * 2022-regulation car below. Both modes share the exact same public API.
 */

import * as THREE from 'three';
import { clamp } from '../core/MathUtils';
import type { TireCompound } from '../core/Types';
import { PHYS } from '../core/Config';
import { F1Assets } from './F1Assets';

export interface F1VisualState {
  steer: number;            // -1..1 wheel input (visual steer angle)
  speed: number;            // m/s
  drsOpen: boolean;
  brakeGlow: number;        // 0..1
  slip: number;             // 0..1 rear slip (visual wiggle)
  wheelSpin: number;        // 0..1
  compound?: TireCompound;  // change pit... (future)
}

const COMPOUND_COLORS: Record<TireCompound, number> = {
  soft: 0xe10600, medium: 0xffd500, hard: 0xf0f0f0,
  inter: 0x43b02a, wet: 0x0062ad,
};

/** Cylinder rod between two points (suspension arms). */
function rod(a: THREE.Vector3, b: THREE.Vector3, r: number, mat: THREE.Material): THREE.Mesh {
  const dir = b.clone().sub(a);
  const len = dir.length();
  const geo = new THREE.CylinderGeometry(r, r, len, 6);
  const m = new THREE.Mesh(geo, mat);
  m.position.copy(a).addScaledVector(dir, 0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  return m;
}

export class F1Visual {
  readonly group = new THREE.Group();
  private wheels: { pivot: THREE.Group; spin: THREE.Group; front: boolean }[] = [];
  private drsFlap: THREE.Mesh | null = null;
  private drsAngle = 0;
  private brakeDiscs: THREE.Mesh[] = [];
  private brakeMat: THREE.MeshStandardMaterial;
  private wheelSpinAngle = 0;
  private bodyMat: THREE.MeshPhysicalMaterial;
  private accentMat: THREE.MeshPhysicalMaterial;
  private disposables: (THREE.BufferGeometry | THREE.Material | THREE.Texture)[] = [];
  private ghostMatCache: { mat: THREE.Material; opacity: number; transparent: boolean }[] = [];
  /** GLB mode: rear-wing node rotated by DRS, cloned materials to dispose. */
  private drsNode: THREE.Object3D | null = null;
  private drsNodeBaseX = 0;
  private glbClonedMats: THREE.Material[] = [];

  constructor(teamColor: number, teamAccent: number, driverNumber: number, compound: TireCompound) {
    const track = (g: THREE.BufferGeometry | THREE.Material | THREE.Texture): void => { this.disposables.push(g); };

    // ---- materials (shared by both modes) --------------------------------------------
    this.bodyMat = new THREE.MeshPhysicalMaterial({
      color: teamColor, metalness: 0.28, roughness: 0.32,
      clearcoat: 1.0, clearcoatRoughness: 0.16, envMapIntensity: 1.15,
    });
    this.accentMat = new THREE.MeshPhysicalMaterial({
      color: teamAccent, metalness: 0.35, roughness: 0.3,
      clearcoat: 0.8, clearcoatRoughness: 0.2, envMapIntensity: 1.1,
    });
    this.brakeMat = new THREE.MeshStandardMaterial({
      color: 0x3a1c08, emissive: 0xff5a00, emissiveIntensity: 0, roughness: 0.6,
    });
    track(this.bodyMat); track(this.accentMat); track(this.brakeMat);

    // ---- blob contact shadow: soft dark pool under the chassis ------------------
    // Sun shadows go soft/patchy at speed; this cheap radial-gradient quad
    // grounds every car on the tarmac 100% of the time (the F1-game trick).
    {
      const c = document.createElement('canvas');
      c.width = 128; c.height = 64;
      const g = c.getContext('2d')!;
      const grd = g.createRadialGradient(64, 32, 3, 64, 32, 62);
      grd.addColorStop(0, 'rgba(0,0,0,0.78)');
      grd.addColorStop(0.5, 'rgba(0,0,0,0.44)');
      grd.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grd;
      g.fillRect(0, 0, 128, 64);
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      const mat = new THREE.MeshBasicMaterial({
        map: tex, transparent: true, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
      });
      const blob = new THREE.Mesh(new THREE.PlaneGeometry(5.2, 2.5), mat);   // v21: narrower — matches the car footprint (no floating look)
      blob.rotation.x = -Math.PI / 2;
      blob.position.y = 0.035;
      blob.renderOrder = 2;
      this.group.add(blob);
      track(tex); track(mat); track(blob.geometry);
    }

    const template = F1Assets.carTemplate;
    if (template) {
      this.buildGLBCar(template, teamColor, teamAccent, driverNumber, compound, track);
      return;
    }
    this.buildProceduralCar(teamColor, teamAccent, driverNumber, compound, track);
  }

  // ================================================================ GLB mode

  private buildGLBCar(template: { root: THREE.Group }, teamColor: number, teamAccent: number,
    driverNumber: number, compound: TireCompound,
    track: (g: THREE.BufferGeometry | THREE.Material | THREE.Texture) => void): void {
    const car = template.root.clone(true);
    car.name = 'glbCar';

    // ---- per-car materials: clone everything (ghost mode mutates opacity) ------
    const livery = F1Assets.getLivery(teamColor);
    const matMap = new Map<THREE.Material, THREE.Material>();
    car.traverse(o => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      const cloned = mats.map(src => {
        let dst = matMap.get(src);
        if (!dst) {
          dst = (src as THREE.MeshStandardMaterial).clone();
          matMap.set(src, dst);
          this.glbClonedMats.push(dst);
        }
        return dst;
      });
      m.material = Array.isArray(m.material) ? cloned : cloned[0];
    });
    // team livery: re-paint the chassis with the team color (decals survive)
    if (livery) {
      for (const mat of this.glbClonedMats) {
        const std = mat as THREE.MeshStandardMaterial;
        if (std.name === 'F1_Base') {
          std.map = livery;
          std.color.setHex(0xffffff);
          std.needsUpdate = true;
        }
      }
    }

    // ---- DRS: rotate the rear-wing top flap node ------------------------------
    const wing = car.getObjectByName('Spoiler_Top_low');
    if (wing) {
      this.drsNode = wing;
      this.drsNodeBaseX = wing.rotation.x;
    }

    this.group.add(car);

    // ---- procedural wheels at the GLB wheel-arch positions ---------------------
    // model (scaled 0.95): front axle z=+1.72, rear z=-1.78, x=±0.82, r=0.36
    this.buildWheels(0.82, 1.72, -0.78, 0.36, compound, track);
    this.buildRainLight(0, 0.85, -2.35, track);   // rear-wing rain light

    // ---- driver helmet (the GLB ships without one) -----------------------------
    const helmetMat = new THREE.MeshPhysicalMaterial({
      color: teamAccent, metalness: 0.4, roughness: 0.22, clearcoat: 1,
    });
    const visorMat = new THREE.MeshStandardMaterial({ color: 0x0a0c14, metalness: 0.9, roughness: 0.08 });
    track(helmetMat); track(visorMat);
    const helmetGeo = new THREE.SphereGeometry(0.145, 16, 12);
    track(helmetGeo);
    const helmet = new THREE.Mesh(helmetGeo, helmetMat);
    helmet.scale.set(1, 0.92, 1.18);
    helmet.position.set(0, 0.62, 0.02);
    helmet.castShadow = true;
    this.group.add(helmet);
    const visorGeo = new THREE.BoxGeometry(0.2, 0.06, 0.05);
    track(visorGeo);
    const visor = new THREE.Mesh(visorGeo, visorMat);
    visor.position.set(0, 0.64, 0.16);
    this.group.add(visor);

    // ---- number plate on the nose ----------------------------------------------
    this.addNumberPlate(driverNumber, 2.2, 0.42, track);
  }

  // ================================================================ shared wheel rig

  /** Wheels + suspension look + brakes; `r` = PHYS.tireRadius-equivalent. */
  private buildWheels(wx: number, fz: number, rz: number, tireW: number,
    compound: TireCompound, track: (g: THREE.BufferGeometry | THREE.Material | THREE.Texture) => void): void {
    const carbon = new THREE.MeshStandardMaterial({ color: 0x15161a, metalness: 0.55, roughness: 0.46 });
    const tireMat = new THREE.MeshStandardMaterial({ color: 0x161618, roughness: 0.93, metalness: 0 });
    const rimMat = new THREE.MeshStandardMaterial({ color: 0x2c2e33, metalness: 0.9, roughness: 0.28 });
    const stripeMat = new THREE.MeshStandardMaterial({
      color: COMPOUND_COLORS[compound], roughness: 0.85, emissive: COMPOUND_COLORS[compound], emissiveIntensity: 0.25,
    });
    track(carbon); track(tireMat); track(rimMat); track(stripeMat);
    this.stripeMats.push(stripeMat);
    this.currentCompound = compound;

    const R = PHYS.tireRadius;
    const defs = [
      { x: wx, z: fz, w: tireW, front: true },
      { x: -wx, z: fz, w: tireW, front: true },
      { x: wx + 0.02, z: rz, w: tireW + 0.1, front: false },
      { x: -wx - 0.02, z: rz, w: tireW + 0.1, front: false },
    ];
    for (const wd of defs) {
      const pivot = new THREE.Group();          // steering
      pivot.position.set(wd.x, R, wd.z);
      const spin = new THREE.Group();           // rolling
      pivot.add(spin);

      const tireGeo = new THREE.CylinderGeometry(R, R, wd.w, 22);
      track(tireGeo);
      const tire = new THREE.Mesh(tireGeo, tireMat);
      tire.rotation.z = Math.PI / 2;
      tire.castShadow = true;
      spin.add(tire);

      for (const s of [-1, 1]) {
        const stripe = new THREE.Mesh(new THREE.TorusGeometry(0.30, 0.012, 6, 26), stripeMat);
        track(stripe.geometry);
        stripe.rotation.y = Math.PI / 2;
        stripe.position.x = s * (wd.w / 2 + 0.002);
        spin.add(stripe);
      }

      const rimGeo = new THREE.CylinderGeometry(0.215, 0.215, wd.w + 0.01, 18);
      track(rimGeo);
      const rim = new THREE.Mesh(rimGeo, rimMat);
      rim.rotation.z = Math.PI / 2;
      spin.add(rim);
      for (let s = 0; s < 5; s++) {
        const spoke = new THREE.Mesh(new THREE.BoxGeometry(wd.w + 0.02, 0.36, 0.03), rimMat);
        track(spoke.geometry);
        spoke.rotation.x = (s / 5) * Math.PI;
        spin.add(spoke);
      }

      const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.03, 16), this.brakeMat);
      track(disc.geometry);
      disc.rotation.z = Math.PI / 2;
      pivot.add(disc);
      this.brakeDiscs.push(disc);

      this.wheels.push({ pivot, spin, front: wd.front });
      this.group.add(pivot);
    }
  }

  private addNumberPlate(driverNumber: number, noseZ: number, noseY: number,
    track: (g: THREE.BufferGeometry | THREE.Material | THREE.Texture) => void): void {
    const numCanvas = document.createElement('canvas');
    numCanvas.width = numCanvas.height = 64;
    const nctx = numCanvas.getContext('2d')!;
    nctx.fillStyle = '#0c0d10';
    nctx.fillRect(0, 0, 64, 64);
    nctx.fillStyle = '#ffffff';
    nctx.font = '900 44px "Arial Black", Arial, sans-serif';
    nctx.textAlign = 'center';
    nctx.textBaseline = 'middle';
    nctx.fillText(String(driverNumber), 32, 36);
    const numTex = new THREE.CanvasTexture(numCanvas);
    const numMat = new THREE.MeshStandardMaterial({ map: numTex, roughness: 0.5, metalness: 0.1 });
    track(numMat); track(numTex);
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.3), numMat);
    track(plate.geometry);
    plate.position.set(0, noseY, noseZ);
    plate.rotation.x = -Math.PI / 2 + 0.12;
    this.group.add(plate);
  }

  // ================================================================ procedural fallback

  private buildProceduralCar(teamColor: number, teamAccent: number, driverNumber: number,
    compound: TireCompound, track: (g: THREE.BufferGeometry | THREE.Material | THREE.Texture) => void): void {
    void teamColor;
    const carbon = new THREE.MeshStandardMaterial({ color: 0x15161a, metalness: 0.55, roughness: 0.46 });
    const carbonGloss = new THREE.MeshStandardMaterial({ color: 0x101114, metalness: 0.6, roughness: 0.32 });
    const helmetMat = new THREE.MeshPhysicalMaterial({
      color: teamAccent, metalness: 0.4, roughness: 0.22, clearcoat: 1,
    });
    const visorMat = new THREE.MeshStandardMaterial({ color: 0x0a0c14, metalness: 0.9, roughness: 0.08 });
    track(carbon); track(carbonGloss); track(helmetMat); track(visorMat);

    const B = (w: number, h: number, d: number, mat: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh => {
      const geo = new THREE.BoxGeometry(w, h, d);
      track(geo);
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.castShadow = true;
      return m;
    };
    const CYL = (rt: number, rb: number, h: number, seg: number, mat: THREE.Material): THREE.Mesh => {
      const geo = new THREE.CylinderGeometry(rt, rb, h, seg);
      track(geo);
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = true;
      return m;
    };

    // ---- floor & diffuser ------------------------------------------------------------
    const floor = B(1.92, 0.05, 4.3, carbon, 0, 0.055, -0.35);
    this.group.add(floor);
    const diffuser = B(1.5, 0.22, 0.55, carbonGloss, 0, 0.17, -2.18);
    diffuser.rotation.x = -0.32;
    this.group.add(diffuser);

    // ---- survival cell / cockpit -------------------------------------------------------
    const cell = B(0.92, 0.44, 2.5, this.bodyMat, 0, 0.32, 0.15);
    this.group.add(cell);
    const cockpitRim = B(0.78, 0.1, 1.1, carbonGloss, 0, 0.55, 0.45);
    this.group.add(cockpitRim);
    const headrest = B(0.6, 0.18, 0.4, this.accentMat, 0, 0.6, -0.28);
    this.group.add(headrest);

    // driver: helmet + shoulders
    const helmet = CYL(0.145, 0.145, 0.24, 14, helmetMat);
    helmet.rotation.x = Math.PI / 2;
    helmet.position.set(0, 0.68, -0.02);
    this.group.add(helmet);
    const visor = B(0.24, 0.07, 0.06, visorMat, 0, 0.7, 0.1);
    this.group.add(visor);
    const shoulders = B(0.5, 0.2, 0.4, this.bodyMat, 0, 0.56, -0.3);
    this.group.add(shoulders);

    // ---- nose (tapered hexagonal) ---------------------------------------------------------
    const nose = CYL(0.075, 0.17, 1.5, 6, this.bodyMat);
    nose.rotation.x = Math.PI / 2;
    nose.rotation.y = Math.PI / 6;
    nose.position.set(0, 0.28, 1.62);
    this.group.add(nose);

    // ---- front wing -----------------------------------------------------------------------
    const fwY = 0.12, fwZ = 2.5;
    const fwMain = B(1.98, 0.028, 0.5, carbonGloss, 0, fwY, fwZ);
    fwMain.rotation.x = 0.14;
    this.group.add(fwMain);
    const fwFlap = B(1.9, 0.024, 0.3, this.accentMat, 0, fwY + 0.09, fwZ - 0.3);
    fwFlap.rotation.x = 0.32;
    this.group.add(fwFlap);
    for (const sx of [-1, 1]) {
      const ep = B(0.026, 0.2, 0.62, this.bodyMat, sx * 0.98, fwY + 0.07, fwZ - 0.05);
      ep.rotation.x = -0.08;
      this.group.add(ep);
    }
    // nose pillars
    for (const sx of [-1, 1]) {
      this.group.add(rod(new THREE.Vector3(sx * 0.12, 0.32, fwZ - 0.18),
        new THREE.Vector3(sx * 0.13, fwY + 0.03, fwZ + 0.1), 0.018, carbon));
    }

    // ---- sidepods (undercut look) --------------------------------------------------------------
    for (const sx of [-1, 1]) {
      const pod = B(0.62, 0.36, 1.6, this.bodyMat, sx * 0.62, 0.3, -0.5);
      this.group.add(pod);
      const inlet = B(0.5, 0.2, 0.1, carbonGloss, sx * 0.62, 0.36, 0.32);
      this.group.add(inlet);
      const floorEdge = B(0.06, 0.09, 1.7, this.accentMat, sx * 0.95, 0.11, -0.55);
      this.group.add(floorEdge);
    }

    // ---- engine cover + shark fin ----------------------------------------------------------------
    const engine = B(0.72, 0.42, 1.7, this.bodyMat, 0, 0.5, -1.15);
    this.group.add(engine);
    const fin = B(0.02, 0.34, 1.0, this.accentMat, 0, 0.78, -1.45);
    this.group.add(fin);
    // airbox + roll hoop
    const airbox = B(0.34, 0.26, 0.5, this.bodyMat, 0, 0.74, -0.55);
    this.group.add(airbox);
    // T-cam
    const tcam = B(0.26, 0.09, 0.12, new THREE.MeshStandardMaterial({ color: 0x000000, roughness: 0.6 }), 0, 0.9, -0.55);
    track((tcam.material as THREE.Material));
    this.group.add(tcam);

    // ---- halo ---------------------------------------------------------------------------------------
    const haloMat = carbonGloss;
    const haloArc = new THREE.Mesh(new THREE.TorusGeometry(0.44, 0.032, 8, 20, Math.PI), haloMat);
    track(haloArc.geometry);
    haloArc.rotation.set(-Math.PI / 2, 0, 0);
    haloArc.rotation.x = -1.35;   // tilted ring wrapping the cockpit
    haloArc.position.set(0, 0.72, 0.22);
    haloArc.castShadow = true;
    this.group.add(haloArc);
    const haloPillar = rod(new THREE.Vector3(0, 0.5, 0.62), new THREE.Vector3(0, 0.78, 0.3), 0.026, haloMat);
    this.group.add(haloPillar);
    for (const sx of [-1, 1]) {
      this.group.add(rod(new THREE.Vector3(sx * 0.42, 0.56, 0.02),
        new THREE.Vector3(sx * 0.3, 0.56, 0.42), 0.022, haloMat));
    }

    // ---- rear wing + DRS ------------------------------------------------------------------------------
    const rwZ = -2.35, rwY = 0.98;
    const rwMain = B(1.04, 0.03, 0.36, carbonGloss, 0, rwY, rwZ);
    rwMain.rotation.x = 0.12;
    this.group.add(rwMain);
    // DRS flap: hinged at its rear-top edge
    const flapGeo = new THREE.BoxGeometry(1.02, 0.022, 0.2);
    track(flapGeo);
    this.drsFlap = new THREE.Mesh(flapGeo, this.accentMat);
    this.drsFlap.castShadow = true;
    const flapPivot = new THREE.Group();
    flapPivot.position.set(0, rwY + 0.09, rwZ - 0.16);
    this.drsFlap.position.set(0, 0, 0.1);
    flapPivot.add(this.drsFlap);
    flapPivot.rotation.x = -0.52;    // closed: steep angle
    this.group.add(flapPivot);
    this.drsPivot = flapPivot;
    for (const sx of [-1, 1]) {
      const ep = B(0.024, 0.5, 0.58, this.bodyMat, sx * 0.52, rwY - 0.12, rwZ - 0.03);
      this.group.add(ep);
    }
    // beam wing + swan neck pillar
    const beam = B(0.9, 0.025, 0.26, carbonGloss, 0, 0.55, rwZ - 0.06);
    beam.rotation.x = 0.18;
    this.group.add(beam);
    this.group.add(rod(new THREE.Vector3(0, 0.62, rwZ + 0.12), new THREE.Vector3(0, rwY - 0.05, rwZ), 0.024, carbonGloss));

    // ---- mirrors ------------------------------------------------------------------------------------------
    for (const sx of [-1, 1]) {
      this.group.add(rod(new THREE.Vector3(sx * 0.42, 0.62, 0.62), new THREE.Vector3(sx * 0.66, 0.66, 0.52), 0.012, carbon));
      const mir = B(0.14, 0.08, 0.04, this.accentMat, sx * 0.7, 0.66, 0.5);
      this.group.add(mir);
    }

    // ---- driver number plate on the nose ---------------------------------------
    this.addNumberPlate(driverNumber, 1.35, 0.43, track);

    // ---- wheels + suspension ---------------------------------------------------------------------------------
    this.buildWheels(0.8, 1.68, -1.75, 0.32, compound, track);
    this.buildRainLight(0, 0.78, -2.45, track);   // rear-wing rain light
    // suspension wishbones (procedural body has exposed arms)
    const suspDefs = [
      { x: 0.8, z: 1.68, front: true }, { x: -0.8, z: 1.68, front: true },
      { x: 0.82, z: -1.75, front: false }, { x: -0.82, z: -1.75, front: false },
    ];
    for (const wd of suspDefs) {
      const bodyY = wd.front ? 0.42 : 0.5;
      const bodyZ = wd.front ? 1.15 : -1.3;
      for (const dy of [0.07, -0.06]) {
        this.group.add(rod(
          new THREE.Vector3(wd.x * 0.35, bodyY + dy, bodyZ + (wd.front ? 0.22 : 0.2)),
          new THREE.Vector3(wd.x, PHYS.tireRadius + dy * 1.6, wd.z + (wd.front ? 0.12 : 0.1)), 0.016, carbon));
        this.group.add(rod(
          new THREE.Vector3(wd.x * 0.35, bodyY + dy, bodyZ - (wd.front ? 0.22 : 0.2)),
          new THREE.Vector3(wd.x, PHYS.tireRadius + dy * 1.6, wd.z - (wd.front ? 0.12 : 0.1)), 0.016, carbon));
      }
      this.group.add(rod(
        new THREE.Vector3(wd.x * 0.4, bodyY - 0.04, bodyZ + (wd.front ? 0.3 : 0.26)),
        new THREE.Vector3(wd.x, PHYS.tireRadius, wd.z + (wd.front ? 0.16 : 0.12)), 0.013, carbon));
    }

    // gentle AoA: the car squats slightly at the rear
    this.group.rotation.x = 0;
  }

  private drsPivot: THREE.Group | null = null;
  private stripeMats: THREE.MeshStandardMaterial[] = [];
  private currentCompound!: TireCompound;
  /** rear rain light (F1 LED): blinks in wet conditions / night */
  private rainLight: THREE.Mesh | null = null;

  /** Recolour the tyre stripes (pit stop compound change). */
  setCompound(c: TireCompound): void {
    this.currentCompound = c;
    const col = COMPOUND_COLORS[c];
    for (const m of this.stripeMats) {
      m.color.setHex(col);
      m.emissive.setHex(col);
    }
  }
  get compound(): TireCompound { return this.currentCompound; }

  /** Rear rain light: red LED on the crash structure, 0.8 s blink cycle. */
  setRainLight(active: boolean, time: number): void {
    if (!this.rainLight) return;
    const mat = this.rainLight.material as THREE.MeshBasicMaterial;
    mat.opacity = active ? 0.35 + 0.65 * (time % 0.8 < 0.4 ? 1 : 0.15) : 0;
    this.rainLight.visible = active;
  }

  private buildRainLight(x: number, y: number, z: number,
    track: (g: THREE.BufferGeometry | THREE.Material | THREE.Texture) => void): void {
    const mat = new THREE.MeshBasicMaterial({ color: 0xff2018, transparent: true, opacity: 0.9 });
    track(mat);
    const geo = new THREE.BoxGeometry(0.16, 0.1, 0.05);
    track(geo);
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    this.group.add(m);
    this.rainLight = m;
  }

  /** Frame update: wheels, DRS, brake glow, body language. */
  update(dt: number, state: F1VisualState): void {
    // wheel spin from speed (+ wheelspin exaggeration)
    const spinRate = (state.speed / PHYS.tireRadius) * (1 + state.wheelSpin * 2.2);
    this.wheelSpinAngle -= spinRate * dt;
    for (const w of this.wheels) {
      w.spin.rotation.x = this.wheelSpinAngle;
      // steer +1 = screen RIGHT → wheels point right = negative Y rotation
      if (w.front) w.pivot.rotation.y = -state.steer * PHYS.maxSteerAngle * 0.62;
    }
    // DRS: procedural flap pivots -0.52 → -0.06; GLB rotates the wing node flat
    if (this.drsPivot) {
      const target = state.drsOpen ? -0.06 : -0.52;
      this.drsAngle += (target - this.drsAngle) * clamp(dt * 14, 0, 1);
      this.drsPivot.rotation.x = this.drsAngle;
    } else if (this.drsNode) {
      // GLB wing: base -90° (steep). Open = rotate toward flat (verified visually).
      const target = state.drsOpen ? this.drsNodeBaseX + 0.87 : this.drsNodeBaseX;
      this.drsAngle += (target - this.drsAngle) * clamp(dt * 14, 0, 1);
      this.drsNode.rotation.x = this.drsAngle;
    }
    // brake disc glow
    this.brakeMat.emissiveIntensity = state.brakeGlow * 3.2;
    // rear slip: subtle body wiggle
    this.group.rotation.z = state.slip > 0.1 ? Math.sin(performance.now() * 0.04) * state.slip * 0.018 : 0;
  }

  setGhost(ghost: boolean): void {
    if (ghost && this.ghostMatCache.length === 0) {
      this.group.traverse(o => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        for (const mat of mats) {
          const mm = mat as THREE.MeshStandardMaterial;
          this.ghostMatCache.push({ mat: mm, opacity: mm.opacity, transparent: mm.transparent });
          mm.transparent = true;
          mm.opacity = 0.38;
        }
      });
    } else if (!ghost && this.ghostMatCache.length) {
      for (const e of this.ghostMatCache) {
        (e.mat as THREE.MeshStandardMaterial).opacity = e.opacity;
        (e.mat as THREE.MeshStandardMaterial).transparent = e.transparent;
      }
      this.ghostMatCache = [];
    }
  }

  dispose(): void {
    this.group.parent?.remove(this.group);
    for (const d of this.disposables) d.dispose();
    // GLB mode: cloned materials are ours; shared template geometries/textures are NOT disposed
    for (const m of this.glbClonedMats) m.dispose();
    this.glbClonedMats.length = 0;
  }
}
