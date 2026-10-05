/**
 * VELOCITY GP v17 — PIT LANE: geometry, visuals and the guided pit path.
 *
 * The pit complex runs along the main straight, on the inside of the pit
 * wall (the circuit's own 1.15 m barrier, reshaped by the TrackBuilder so
 * physics and visuals are the SAME wall — no invisible walls anywhere):
 *
 *   track | kerb | grass | PIT WALL 1.15 m + catch fencing | 7 m concrete
 *   lane + limit line 80 | garage row (10 bays, one per team) + gantries.
 *
 * The path is what the PitSystem drives kinematically:
 *   entry blend (leaves the racing surface) → lane (80 km/h limiter)
 *   → team garage stop (tyres + fuel, progress + countdown) → exit blend
 *   (rejoins before the next corner — Monza exits right before the
 *   Rettifilo, adaptively computed from curvature for every circuit).
 *
 * UNITS: everything about placement is METERS along the arc from the start
 * line (negative = before the line). Conversion to spline progress happens
 * only at the sampling boundary.
 */

import * as THREE from 'three';
import { clamp } from '../core/MathUtils';
import { TEAMS } from './Teams';

export interface PitLanePathPoint {
  pos: THREE.Vector3;
  yaw: number;
  /** main-spline progress this path point parallels */
  mainS: number;
}

export interface PitLaneData {
  side: 1 | -1;                 // +1 = right of the road, -1 = left
  wallLat: number;              // lateral offset of the pit wall (centerline→wall)
  laneLat: number;              // lateral offset of the lane CENTER
  laneHalf: number;             // half width of the concrete lane
  entryS: number;               // main-spline progress where the path leaves the track
  exitS: number;                // main-spline progress where the path rejoins the track
  pts: PitLanePathPoint[];      // ordered entry → exit
  cum: number[];                // cumulative distance along pts
  length: number;               // total path length (m)
  garageDist: number[];         // per-team stop distance along the path (index = TEAMS order)
  limitDist: number;            // path distance where the 80 km/h limiter starts
  /** samples idx range on the main spline that the pit occupies (for walls) */
  entryIdx: number;
  exitIdx: number;
  /** path distance where the entry blend ends / exit blend starts */
  blendInEnd: number;
  blendOutStart: number;
}

/** Sample the path at an arc distance. */
export function pitAt(pit: PitLaneData, dist: number): { pos: THREE.Vector3; yaw: number; mainS: number } {
  const d = clamp(dist, 0, pit.length);
  const { cum, pts } = pit;
  let i = 1;
  while (i < cum.length - 1 && cum[i] < d) i++;
  const a = pts[i - 1], b = pts[i];
  const span = Math.max(1e-6, cum[i] - cum[i - 1]);
  const t = clamp((d - cum[i - 1]) / span, 0, 1);
  let dy = b.yaw - a.yaw;
  while (dy > Math.PI) dy -= Math.PI * 2;
  while (dy < -Math.PI) dy += Math.PI * 2;
  return {
    pos: new THREE.Vector3().lerpVectors(a.pos, b.pos, t),
    yaw: a.yaw + dy * t,
    mainS: a.mainS + (b.mainS - a.mainS) * t,
  };
}

const SAMPLES = 480;

interface StraightInfo { startS: number; endS: number; len: number }

/** Longest low-curvature window that contains the start line (s≈0). */
function mainStraight(curvature: Float32Array, spacing: number, minCurv: number): StraightInfo {
  const N = SAMPLES;
  const flat = (i: number): boolean => Math.abs(curvature[((i % N) + N) % N]) < minCurv;
  let back = 0;
  while (back < N - 1 && flat(-back - 1) && back * spacing < 420) back++;
  let fwd = 0;
  while (fwd < N - 1 && flat(fwd + 1) && fwd * spacing < 420) fwd++;
  return { startS: -back * spacing, endS: fwd * spacing, len: (back + fwd) * spacing };
}

type SampleFn = (s: number) => { pos: THREE.Vector3; right: THREE.Vector3; tangent: THREE.Vector3; halfWidth: number; bank: number };

interface SplineLike { length: number; sampleAt(s: number): ReturnType<SampleFn> }

/**
 * Compute the pit lane for a circuit. Returns null when neither side has
 * room for a safe complex (the game then simply hides pit features).
 * v27: optional entry/exit FRACTIONS along the main straight (0 = straight
 * start, 1 = straight end) — Monza's real pit entry sits mid-straight past
 * the start line, not right off the last corner, and players looking for
 * it there found a closed wall ("no hay entrada a pits").
 */
export function buildPitLaneData(
  spline: SplineLike,
  curvature: Float32Array,
  spacing: number,
  clearOfTrack: (x: number, z: number, margin: number, skipFrom?: number, skipTo?: number) => boolean,
  pitFracs?: { entry: number; exit: number },
): PitLaneData | null {
  const straight = mainStraight(curvature, spacing, 0.012);
  if (straight.len < 118) return null;   // the pre/post minimums (65+45) gate the real cases

  const preLen = -straight.startS;
  const postLen = straight.endS;
  if (preLen < 65 || postLen < 45) return null;

  let entryM: number;
  let exitM: number;
  if (pitFracs) {
    // explicit placement along the straight (entry stays before exit, with
    // blend room at both ends)
    const total = straight.len;
    entryM = straight.startS + clamp(pitFracs.entry, 0.04, 0.9) * total;
    exitM = straight.startS + clamp(pitFracs.exit, pitFracs.entry + 0.18, 0.97) * total;
  } else {
    entryM = straight.startS + preLen * 0.24;
    exitM = Math.min(straight.endS - postLen * 0.12, postLen - 8);
  }
  const len = spline.length;
  const prog = (m: number): number => ((m / len) % 1 + 1) % 1;

  const lat = (m: number, lateral: number): THREE.Vector3 => {
    const sm = spline.sampleAt(prog(m));
    return sm.pos.clone().addScaledVector(sm.right, lateral)
      .add(new THREE.Vector3(0, lateral * Math.sin(sm.bank), 0));
  };
  const yawAt = (m: number): number => {
    const sm = spline.sampleAt(prog(m));
    return Math.atan2(sm.tangent.x, sm.tangent.z);
  };
  const hwMid = spline.sampleAt(0).halfWidth;

  // Two layouts: standard (roomy) and compact (tight circuits).
  // NOTE: clearOfTrack measures from the OTHER section's CENTERLINE
  // (lim = halfWidth + margin), so the margin only needs to keep the garage
  // box off that road's asphalt edge (halfWidth is already counted) —
  // a 2.4-4.5 m visual buffer. Wider v20 tracks exposed the old fat margins.
  const layouts = [
    { wall: 3.4, laneHalf: 3.5, garageDepth: 9.5, margin: 4.5 },
    { wall: 2.4, laneHalf: 2.6, garageDepth: 7, margin: 2.5 },
  ];

  for (const side of [-1, 1] as const) {
    for (const L of layouts) {
      const wallLat = hwMid + 1.9 + L.wall;
      const laneLat = wallLat + 0.62 + L.laneHalf;
      const garageFront = laneLat + L.laneHalf + 0.9;
      const garageBack = garageFront + L.garageDepth;

      // ---- clearance sweep: lane edges + garage box must clear every OTHER
      // track section — the straight we parallel is excluded via the skip
      // window (the lane legitimately runs beside its own road).
      let ok = true;
      const N = SAMPLES;
      const iEntry = ((Math.round(entryM / len * N) % N) + N) % N;
      const iExit = ((Math.round(exitM / len * N) % N) + N) % N;
      const skipFrom = ((iEntry - Math.round(60 / spacing)) % N + N) % N;
      const skipTo = ((iExit + Math.round(60 / spacing)) % N + N) % N;
      const spanM = exitM - entryM;
      for (let d = 0; d <= spanM && ok; d += spacing * 4) {
        const m = entryM + d;
        for (const lateral of [wallLat, laneLat + L.laneHalf, garageFront, garageBack]) {
          const p = lat(m, side * lateral);
          if (!clearOfTrack(p.x, p.z, L.margin, skipFrom, skipTo)) { ok = false; break; }
        }
      }
      if (!ok) continue;

      // ---- path control points -------------------------------------------------
      const blend = Math.min(24, spanM * 0.18);
      const pts: PitLanePathPoint[] = [];
      const push = (m: number, lateral: number): void => {
        pts.push({ pos: lat(m, side * lateral), yaw: yawAt(m), mainS: prog(m) });
      };
      // first point: the track edge on the pit side (the car is still on the
      // racing surface when the guided handover begins)
      push(entryM, 2.2);
      push(entryM + blend * 0.45, wallLat + 1.2);
      push(entryM + blend * 0.8, laneLat);
      const laneStartM = entryM + blend;
      const laneEndM = exitM - blend;
      const nMid = Math.max(3, Math.round((laneEndM - laneStartM) / 26));
      for (let i = 0; i <= nMid; i++) {
        push(laneStartM + (laneEndM - laneStartM) * (i / nMid), laneLat);
      }
      push(exitM - blend * 0.8, laneLat);
      push(exitM - blend * 0.45, wallLat + 1.2);
      push(exitM, 2.2);

      // cumulative distance
      const cum: number[] = [0];
      for (let i = 1; i < pts.length; i++) {
        cum.push(cum[i - 1] + pts[i].pos.distanceTo(pts[i - 1].pos));
      }
      const length = cum[cum.length - 1];

      // garages: spread across the middle 62% of the lane run
      const g0 = length * 0.21, g1 = length * 0.83;
      const garageDist = TEAMS.map((_t, i) => g0 + (g1 - g0) * (i / Math.max(1, TEAMS.length - 1)));

      return {
        side, wallLat, laneLat, laneHalf: L.laneHalf,
        entryS: prog(entryM),
        exitS: prog(exitM),
        pts, cum, length,
        garageDist,
        limitDist: blend + 4,
        entryIdx: iEntry,
        exitIdx: iExit,
        blendInEnd: blend,
        blendOutStart: length - blend,
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------- visuals

export interface GarageAnim {
  /** mechanic groups (2) + lollipop; animated by the PitSystem */
  men: THREE.Group[];
  lollipop: THREE.Object3D;
}

export interface PitVisuals {
  group: THREE.Group;
  garages: GarageAnim[];
  /** everything that must be disposed with the world */
  disposables: (THREE.BufferGeometry | THREE.Material | THREE.Texture)[];
}

function textBoardTexture(text: string, bg: string, fg: string, sub?: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = bg;
  g.fillRect(0, 0, 512, 128);
  g.fillStyle = fg;
  g.font = 'italic 900 62px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 256, sub ? 52 : 64);
  if (sub) {
    g.font = '700 30px system-ui, sans-serif';
    g.fillText(sub, 256, 100);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Painted text on the tarmac (flat plane, aligned to the lane). */
function paintText(
  group: THREE.Group,
  disposables: (THREE.BufferGeometry | THREE.Material | THREE.Texture)[],
  text: string, pos: THREE.Vector3, yaw: number, w: number, color = '#e8eaec',
): void {
  const tex = textBoardTexture(text, 'rgba(0,0,0,0)', color);
  disposables.push(tex);
  const geo = new THREE.PlaneGeometry(w, w * 0.25);
  disposables.push(geo);
  const mat = new THREE.MeshStandardMaterial({
    map: tex, transparent: true, depthWrite: false,
    roughness: 0.9, metalness: 0,
  });
  disposables.push(mat);
  const m = new THREE.Mesh(geo, mat);
  m.position.copy(pos);
  m.position.y += 0.045;
  m.rotation.set(-Math.PI / 2, 0, 0);
  // read ALONG the direction of travel (empirically verified orientation)
  m.rotateZ(Math.PI / 2 - yaw);
  group.add(m);
}

export function buildPitVisuals(
  pit: PitLaneData,
  _sampleMain: SampleFn,
  _splineLength: number,
  weather: string,
): PitVisuals {
  const group = new THREE.Group();
  const disposables: (THREE.BufferGeometry | THREE.Material | THREE.Texture)[] = [];
  const night = weather === 'night';

  // ============================================================ concrete lane
  {
    const pos: number[] = [];
    const idx: number[] = [];
    const uv: number[] = [];
    const n = 26;
    for (let i = 0; i <= n; i++) {
      const d = (i / n) * pit.length;
      const a = pitAt(pit, d);
      // right vector of the path direction
      const rx = Math.cos(a.yaw), rz = -Math.sin(a.yaw);
      const w = pit.laneHalf * (i === 0 || i === n ? 0.55 : 1);   // tapers at the blends
      pos.push(a.pos.x + rx * w, a.pos.y + 0.03, a.pos.z + rz * w);
      pos.push(a.pos.x - rx * w, a.pos.y + 0.03, a.pos.z - rz * w);
      uv.push(0, d / 8, 1, d / 8);
      if (i < n) {
        const v = i * 2;
        idx.push(v, v + 1, v + 2, v + 1, v + 3, v + 2);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    disposables.push(geo);
    const mat = new THREE.MeshStandardMaterial({ color: 0x8d9095, roughness: 0.92, metalness: 0.02 });
    disposables.push(mat);
    const lane = new THREE.Mesh(geo, mat);
    lane.receiveShadow = true;
    group.add(lane);

    // white speed-limit line across the lane
    const lineAt = pitAt(pit, pit.limitDist);
    const lgeo = new THREE.PlaneGeometry(pit.laneHalf * 2, 0.55);
    disposables.push(lgeo);
    const lmat = new THREE.MeshBasicMaterial({ color: 0xf2f4f6 });
    disposables.push(lmat);
    const line = new THREE.Mesh(lgeo, lmat);
    line.position.copy(lineAt.pos);
    line.position.y += 0.06;
    line.rotation.set(-Math.PI / 2, 0, 0);
    line.rotateZ(-lineAt.yaw);
    group.add(line);

    // painted lane text
    const a1 = pitAt(pit, pit.limitDist + 9);
    paintText(group, disposables, 'PIT LANE', a1.pos, a1.yaw, 10);
    const a2 = pitAt(pit, pit.limitDist + 17);
    paintText(group, disposables, '80', a2.pos, a2.yaw, 4.5, '#ffd400');
    const a3 = pitAt(pit, pit.blendOutStart - 12);
    paintText(group, disposables, 'PIT EXIT', a3.pos, a3.yaw, 10);
  }

  // ============================================================ catch fence
  // (the separating wall itself is the circuit barrier, reshaped by the
  //  TrackBuilder — we only add the fencing above it)
  {
    const postMat = new THREE.MeshStandardMaterial({ color: 0x5a6068, roughness: 0.5, metalness: 0.5 });
    const fenceMat = new THREE.MeshBasicMaterial({
      color: 0xb8c4cc, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false,
    });
    disposables.push(postMat, fenceMat);
    const postGeo = new THREE.CylinderGeometry(0.05, 0.06, 2.6, 6);
    const fenceGeo = new THREE.PlaneGeometry(1, 1);
    disposables.push(postGeo, fenceGeo);
    const laneToWall = pit.laneLat - pit.wallLat;   // lateral distance path → wall
    const fenceAt = (d: number): THREE.Vector3 => {
      const at = pitAt(pit, d);
      const rx = Math.cos(at.yaw), rz = -Math.sin(at.yaw);
      return at.pos.clone().add(new THREE.Vector3(-rx * laneToWall, 0, -rz * laneToWall));
    };
    for (let d = pit.blendInEnd + 6; d < pit.blendOutStart - 6; d += 12) {
      const a = fenceAt(d);
      const post = new THREE.Mesh(postGeo, postMat);
      post.position.copy(a);
      post.position.y += 1.15 + 1.3;
      post.castShadow = true;
      group.add(post);
      const b = fenceAt(Math.min(pit.blendOutStart - 6, d + 12));
      const fence = new THREE.Mesh(fenceGeo, fenceMat);
      fence.position.lerpVectors(a, b, 0.5);
      fence.position.y = (a.y + b.y) / 2 + 1.15 + 1.3;
      fence.scale.set(Math.hypot(b.x - a.x, b.z - a.z), 2.4, 1);
      fence.rotation.y = Math.atan2(b.x - a.x, b.z - a.z);
      group.add(fence);
    }
  }

  // ============================================================ garage row
  const garages: GarageAnim[] = [];
  {
    const bayW = Math.min(12.5, (pit.blendOutStart - pit.blendInEnd) / TEAMS.length - 1.4);
    const depth = 8.5;
    for (let t = 0; t < TEAMS.length; t++) {
      const team = TEAMS[t];
      const at = pitAt(pit, pit.garageDist[t]);
      const g = new THREE.Group();
      g.position.copy(at.pos);
      // frame: +Z = AWAY from the track (outward), X = along the lane —
      // the path yaw alone would put "forward" where we need "outward"
      g.rotation.y = at.yaw + (pit.side < 0 ? -Math.PI / 2 : Math.PI / 2);

      // ---- garage with an OPEN FORECOURT --------------------------------------
      // The bay is recessed: men, tyres, fuel rig and lollipop stand in the
      // open (visible!), the solid building sits behind them, and a canopy
      // roof covers the whole working area — like a real F1 pit garage.
      const fore = 2.4;                       // open forecourt depth (m)
      const front = pit.laneHalf + 1.1;       // lane edge → forecourt start
      const boxFront = front + fore;          // solid building starts here

      // solid body (recessed)
      const body = new THREE.Mesh(
        new THREE.BoxGeometry(bayW, 6.4, depth),
        new THREE.MeshStandardMaterial({ color: 0x30343c, roughness: 0.8 }),
      );
      disposables.push(body.geometry, body.material as THREE.Material);
      body.position.set(0, 3.2, boxFront + depth / 2);
      body.castShadow = true;
      body.receiveShadow = true;
      g.add(body);

      // open bay: dark inset on the building face
      const bay = new THREE.Mesh(
        new THREE.PlaneGeometry(bayW - 1.6, 4.2),
        new THREE.MeshStandardMaterial({ color: 0x0c0e12, roughness: 1 }),
      );
      disposables.push(bay.geometry, bay.material as THREE.Material);
      bay.position.set(0, 2.1, boxFront + 0.06);
      bay.rotation.y = Math.PI;   // face the lane
      g.add(bay);

      // team-color fascia + name board on the face, above the opening
      const fascia = new THREE.Mesh(
        new THREE.BoxGeometry(bayW, 1.5, 0.3),
        new THREE.MeshStandardMaterial({
          color: team.color, roughness: 0.45, metalness: 0.1,
          emissive: night ? team.color : 0x000000, emissiveIntensity: night ? 0.55 : 0,
        }),
      );
      disposables.push(fascia.geometry, fascia.material as THREE.Material);
      fascia.position.set(0, 5.1, boxFront + 0.2);
      g.add(fascia);

      const nameTex = textBoardTexture(
        team.short, '#0c0e12', `#${team.color.toString(16).padStart(6, '0')}`,
        team.drivers.map(dr => String(dr.number)).join(' · '),
      );
      disposables.push(nameTex);
      const nameBoard = new THREE.Mesh(
        new THREE.PlaneGeometry(bayW - 1.2, 1.32),
        new THREE.MeshBasicMaterial({ map: nameTex }),
      );
      disposables.push(nameBoard.geometry, nameBoard.material as THREE.Material);
      nameBoard.position.set(0, 5.1, boxFront + 0.38);
      nameBoard.rotation.y = Math.PI;
      g.add(nameBoard);

      // glazed upper floor (on the solid part)
      const glass = new THREE.Mesh(
        new THREE.BoxGeometry(bayW - 0.8, 1.9, depth - 1.2),
        new THREE.MeshStandardMaterial({
          color: 0x9fd4e8, metalness: 0.6, roughness: 0.15,
          emissive: 0x223844, emissiveIntensity: night ? 1.6 : 0.25,
        }),
      );
      disposables.push(glass.geometry, glass.material as THREE.Material);
      glass.position.set(0, 7.4, boxFront + depth / 2);
      g.add(glass);

      // canopy roof: low awning over the open forecourt (F1 pit height ~5.5 m)
      const roof = new THREE.Mesh(
        new THREE.BoxGeometry(bayW + 0.9, 0.3, fore + 1.6),
        new THREE.MeshStandardMaterial({ color: 0xe4e6ea, roughness: 0.55, metalness: 0.2 }),
      );
      disposables.push(roof.geometry, roof.material as THREE.Material);
      roof.position.set(0, 5.6, front + fore / 2 - 0.3);
      roof.castShadow = true;
      g.add(roof);

      // ---- per-bay props in the OPEN forecourt: tyre stacks + fuel rig ------
      const tyreMat = new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.95 });
      disposables.push(tyreMat);
      const tyreGeo = new THREE.TorusGeometry(0.34, 0.14, 7, 14);
      disposables.push(tyreGeo);
      for (let k = 0; k < 2; k++) {
        const stack = new THREE.Group();
        for (let h = 0; h < 3; h++) {
          const tyre = new THREE.Mesh(tyreGeo, tyreMat);
          tyre.rotation.x = Math.PI / 2;
          tyre.position.set(0, 0.15 + h * 0.29, 0);
          tyre.castShadow = true;
          stack.add(tyre);
        }
        stack.position.set(-bayW / 2 + 1.2 + k * 1.1, 0.02, front + 1.2);
        g.add(stack);
      }
      const rig = new THREE.Mesh(
        new THREE.BoxGeometry(0.8, 1.7, 0.7),
        new THREE.MeshStandardMaterial({ color: 0x3c424c, roughness: 0.5, metalness: 0.4 }),
      );
      disposables.push(rig.geometry, rig.material as THREE.Material);
      rig.position.set(bayW / 2 - 1.3, 0.85, front + 1.3);
      rig.castShadow = true;
      g.add(rig);

      // ---- mechanics (2) + lollipop man in the forecourt --------------------
      const mkMan = (x: number, z: number, capColor: number): THREE.Group => {
        const man = new THREE.Group();
        const suit = new THREE.MeshStandardMaterial({
          color: team.color, roughness: 0.7,
          emissive: night ? team.color : 0x000000, emissiveIntensity: night ? 0.25 : 0,
        });
        disposables.push(suit);
        const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.24, 0.52, 3, 8), suit);
        torso.position.y = 0.78;
        torso.castShadow = true;
        man.add(torso);
        const headMat = new THREE.MeshStandardMaterial({ color: 0xd8b49a, roughness: 0.8 });
        disposables.push(headMat);
        const head = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 8), headMat);
        head.position.y = 1.28;
        man.add(head);
        const capMat = new THREE.MeshStandardMaterial({ color: capColor, roughness: 0.7 });
        disposables.push(capMat);
        const cap = new THREE.Mesh(
          new THREE.SphereGeometry(0.148, 8, 6, 0, Math.PI * 2, 0, Math.PI / 2),
          capMat,
        );
        disposables.push(cap.geometry);
        cap.position.y = 1.30;
        man.add(cap);
        // working arms (pivot at the shoulder — animated by the PitSystem)
        const armMat = new THREE.MeshStandardMaterial({ color: team.color, roughness: 0.7 });
        disposables.push(armMat);
        for (const sd of [-1, 1]) {
          const arm = new THREE.Group();
          const limb = new THREE.Mesh(new THREE.CapsuleGeometry(0.06, 0.42, 3, 6), armMat);
          limb.position.y = -0.24;
          arm.add(limb);
          arm.position.set(sd * 0.26, 1.02, 0);
          man.add(arm);
        }
        man.position.set(x, 0, z);
        man.rotation.y = Math.PI;   // face the lane
        return man;
      };
      // two tyre carriers right where the car stops + a front jack man
      const men = [
        mkMan(-1.0, front + 0.55, team.accent),
        mkMan(1.0, front + 0.55, team.color),
        mkMan(0, front + 0.75, 0x101216),
      ];
      for (const m of men) g.add(m);

      // lollipop: pole + sign disc, flips up on release
      const lolli = new THREE.Group();
      const poleMat = new THREE.MeshStandardMaterial({ color: 0x22262c, roughness: 0.6 });
      disposables.push(poleMat);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 1.9, 6), poleMat);
      disposables.push(pole.geometry);
      pole.position.y = 0.95;
      lolli.add(pole);
      const signTex = textBoardTexture('BOX', '#101216', `#${team.accent.toString(16).padStart(6, '0')}`);
      disposables.push(signTex);
      const signMat = new THREE.MeshBasicMaterial({ map: signTex, side: THREE.DoubleSide });
      disposables.push(signMat);
      const sign = new THREE.Mesh(new THREE.CircleGeometry(0.42, 18), signMat);
      disposables.push(sign.geometry);
      sign.position.y = 2.0;
      lolli.add(sign);
      lolli.position.set(bayW / 2 - 2.2, 0, front + 0.5);
      g.add(lolli);

      group.add(g);
      garages.push({ men, lollipop: lolli });
    }
  }

  // ============================================================ gantries
  {
    const postMat = new THREE.MeshStandardMaterial({ color: 0x2c3138, roughness: 0.5, metalness: 0.45 });
    disposables.push(postMat);
    const gantry = (d: number, text: string): void => {
      const at = pitAt(pit, d);
      const g = new THREE.Group();
      g.position.copy(at.pos);
      g.rotation.y = at.yaw;
      const postGeo = new THREE.CylinderGeometry(0.14, 0.16, 6.4, 8);
      disposables.push(postGeo);
      for (const s of [-1, 1]) {
        const post = new THREE.Mesh(postGeo, postMat);
        post.position.set(s * (pit.laneHalf + 0.8), 3.2, 0);
        post.castShadow = true;
        g.add(post);
      }
      const beam = new THREE.Mesh(
        new THREE.BoxGeometry(pit.laneHalf * 2 + 2.2, 0.5, 0.5),
        postMat,
      );
      disposables.push(beam.geometry);
      beam.position.set(0, 6.1, 0);
      beam.castShadow = true;
      g.add(beam);
      const tex = textBoardTexture(text, '#0b2e13', '#ffffff');
      disposables.push(tex);
      const boardMat = new THREE.MeshBasicMaterial({ map: tex });
      disposables.push(boardMat);
      const board = new THREE.Mesh(new THREE.PlaneGeometry(6.4, 1.55), boardMat);
      disposables.push(board.geometry);
      board.position.set(0, 5.2, -0.3);
      board.rotation.y = Math.PI;
      g.add(board);
      group.add(g);
    };
    gantry(pit.limitDist + 3, 'PIT LANE');
    gantry(pit.blendOutStart - 4, 'PIT EXIT');
  }

  void _sampleMain; void _splineLength;
  return { group, garages, disposables };
}
