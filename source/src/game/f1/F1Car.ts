/**
 * APEX GP — F1 car physics. THE realism module.
 *
 * Dynamic bicycle model (the standard sim-lite compromise):
 *  - body-frame velocity (vLong, vLat) + yawRate state
 *  - per-axle slip angles → Pacejka-lite lateral forces (magic formula)
 *  - load model: static + aero (v² downforce, split front/rear) + longitudinal
 *    weight transfer; grip follows load with sensitivity
 *  - friction ellipse couples braking/traction with lateral grip (trail-braking
 *    loosens the rear, throttle-on oversteer, lockups kill steering)
 *  - engine: rpm from gear & speed, power-curve torque, 8-speed box with
 *    auto/manual shifts, MGU-K deploy/harvest, fuel burn, DRS drag/downforce cut
 *  - surfaces: asphalt / kerb / runoff / grass / gravel with grip + drag
 *
 * Assists (stability + traction) are subtle and speed-scaled so a keyboard
 * can hold a 4g corner without feeling like an arcade kart.
 */

import * as THREE from 'three';
import type { CarSetup, F1Controls, TireCompound } from '../core/Types';
import { PHYS, cdaOf, claOf, enginePower, rpmAtSpeed, speedAtRpm } from '../core/Config';
import { clamp, damp, makeRng } from '../core/MathUtils';
import { teamPower, teamAero } from './Teams';

export type Surface = 'road' | 'kerb' | 'runoff' | 'grass' | 'gravel';

export interface F1GroundInfo {
  height: number;
  hasGround: boolean;
  surface: Surface;
  s: number;               // lap progress 0..1
  lateral: number;         // signed meters from centerline
  slope: number;           // road tangent.y
  mainIdx: number;
  halfWidth: number;       // road half width at this sample
  /** lateral clamp where the barrier stands (left/right, meters from center) */
  wallL: number;
  wallR: number;
  onKerb: boolean;
}

export interface F1StepWorld {
  groundQuery(p: THREE.Vector3, state: { mainIdx: number }): F1GroundInfo;
  wallConstrain?(car: F1Car): void;
}

// --- chassis geometry -----------------------------------------------------------
const WHEELBASE = 3.6;         // m
const A_CG = 1.62;             // CG → front axle
const B_CG = 1.98;             // CG → rear axle
const H_CG = 0.31;             // CG height

// Pacejka-lite lateral
const LAT_B = 9.0, LAT_C = 1.55;

export const NEUTRAL_CONTROLS: F1Controls = {
  throttle: 0, brake: 0, steer: 0, drs: false, shiftUp: false, shiftDown: false, lookBack: false,
};

export class F1Car {
  readonly id: string;
  readonly isPlayer: boolean;
  readonly teamId: string;
  readonly driverName: string;
  readonly driverNumber: number;
  readonly isBot: boolean;
  /** online: pose driven by a RemoteDriver (owner is the authority) */
  remoteDriven = false;
  /** v17: under PitSystem kinematic control (physics/AI/respawn skipped) */
  pitting = false;

  // --- transform & motion -----------------------------------------------------
  pos = new THREE.Vector3();
  yaw = 0;
  vLong = 0;                // m/s body-frame forward
  vLat = 0;                 // m/s body-frame right (positive = sliding right)
  yawRate = 0;
  vy = 0;
  grounded = true;
  steerAngle = 0;           // actual front wheel angle (rad, + = right)
  steerSm = 0;              // ramped input for the player (visuals read this too)

  // --- powertrain ----------------------------------------------------------------
  gear = 1;
  rpm: number = PHYS.idleRpm;
  fuel = 0;                 // kg
  ersJ = 0;                 // joules in the battery
  ersDeploying = false;
  shiftTimer = 0;
  autoGears = true;
  drsOpen = false;
  /** injected by Game: 0..1 drag cut from the slipstream */
  slipstreamCut = 0;
  /** injected by Game: front downforce loss in dirty air (0..1) */
  dirtyAir = 0;
  /** injected by RaceManager: DRS allowed right here right now */
  drsEligible = false;

  // --- tires -----------------------------------------------------------------------
  setup: CarSetup;
  tireWear = 0;             // 0 fresh → 1 spent
  lockupFront = 0;          // 0..1 front locking visual/audio
  wheelSpin = 0;            // 0..1 wheelspin
  slipRear = 0;             // rear slip severity (smoke/audio)

  // --- surface -----------------------------------------------------------------------
  ginfo: F1GroundInfo | null = null;
  private mainIdx = -1;
  surface: Surface = 'road';
  offTrack = false;         // all 4 wheels beyond the kerbs (track limits)

  // --- race state ---------------------------------------------------------------------
  lap = 0;
  progressS = 0;
  rank = 1;
  finished = false;
  spinT = 0;                // lost control after contact
  penaltySec = 0;
  wallHit = 0;              // 1-frame impact intensity (0..1)
  requestRespawn = false;

  // --- assists ------------------------------------------------------------------------
  /** 0 = pro (AI-like), 1 = full keyboard assists (player default) */
  assistLevel = 1;
  /** ARCADE handling (player): grip-capped kinematic steering — cannot spin,
   *  snap oversteer or tank-slap. Corners too fast → understeer + speed scrub. */
  arcade = false;
  /** per-driver natural pace (0.93..1.0 applied to grip/power) — AI only */
  paceMul = 1;
  /** v25: engine power multiplier, DECOUPLED from paceMul (grip). Bots run
   *  superhuman grip machinery (paceMul up to ~1.6 so their corner speeds
   *  sit above a committed human), but letting the same multiplier run the
   *  engine pushed terminal velocity to ~390 km/h — silly. powerMul follows
   *  paceMul at half strength (1 + (m−1)·0.5), capping top speed near real
   *  DRS figures. The player's car keeps 1.0 for both. */
  powerMul = 1;
  /** weather grip multiplier (rain < 1) — set by Game at session start */
  wetGripScale = 1;

  // --- v27 damage (airstrike / admin) ------------------------------------------------
  /** 0 pristine → 1 wrecked. Bombed cars lose power, grip and aero, trail
   *  black smoke and fire. Repaired via the admin panel. */
  damage = 0;
  /** admin INVENCIBLE toggle: bombs and impacts never damage this car */
  invulnerable = false;
  /** admin BOOST: seconds of +1.1 MW rocket thrust remaining */
  boostT = 0;
  /** admin TURBO toggle: engine ×1.5, drag ×0.86 */
  cheatTurbo = false;
  /** admin SIN DESGASTE toggle: tyres + fuel frozen */
  cheatNoWear = false;
  /** timestamp of the last damage event (drives the FX burst) */
  damageFxAt = 0;

  /** v27: apply damage (0..1 added). Respects invulnerable. Returns the
   *  resulting damage so callers can spawn matching FX. */
  applyDamage(amount: number): number {
    if (this.invulnerable) return this.damage;
    this.damage = clamp(this.damage + amount, 0, 1);
    if (amount > 0.15) this.damageFxAt = performance.now();
    return this.damage;
  }

  /** v27: full repair (admin). */
  repair(): void {
    this.damage = 0;
  }

  // --- telemetry (for HUD/audio/visuals; refreshed per step) -----------------------------
  latG = 0;
  longG = 0;
  brakeGlow = 0;            // 0..1 disc glow
  lastEngineForce = 0;

  private rng: () => number;
  private stalledOff = 0;   // time stuck slow & off-track (auto recovery)
  /** last step's rear lateral demand (0..1 of the axle cap) — lets the
   * traction controller leave lateral headroom instead of eating it all */
  private rearLatDemand = 0;

  constructor(opts: {
    id: string; isPlayer: boolean; teamId: string; driverName: string; driverNumber: number;
    setup: CarSetup; isBot?: boolean; seed?: number; fuelKg?: number; autoGears?: boolean;
  }) {
    this.id = opts.id;
    this.isPlayer = opts.isPlayer;
    this.teamId = opts.teamId;
    this.driverName = opts.driverName;
    this.driverNumber = opts.driverNumber;
    this.setup = { ...opts.setup };
    this.isBot = !!opts.isBot;
    this.fuel = opts.fuelKg ?? 55;
    this.ersJ = PHYS.ersCapacity * 0.85;
    this.autoGears = opts.autoGears ?? true;
    this.rng = makeRng((opts.seed ?? Math.floor(Math.random() * 65535)) & 0xffff);
  }

  // ------------------------------------------------------------------ getters

  get mass(): number { return PHYS.chassisMass + Math.max(0, this.fuel); }
  get speed(): number { return Math.hypot(this.vLong, this.vLat); }
  get speedKmh(): number { return this.speed * 3.6; }
  get velocity(): THREE.Vector3 {
    return new THREE.Vector3(
      Math.sin(this.yaw) * this.vLong + Math.cos(this.yaw) * this.vLat, 0,
      Math.cos(this.yaw) * this.vLong - Math.sin(this.yaw) * this.vLat);
  }
  get compound(): TireCompound { return this.setup.compound; }
  get ersPct(): number { return this.ersJ / PHYS.ersCapacity; }
  /** slip angle of the velocity vector vs heading (rad) */
  get slipAngle(): number { return Math.atan2(this.vLat, Math.max(1, Math.abs(this.vLong))); }
  get engineWatts(): number { return enginePower(this.rpm, teamPower(this.teamId)) + (this.ersDeploying ? PHYS.mguKPower : 0); }
  // ---- v16 wet tyre model ---------------------------------------------------------
  /** a wet session is any track with reduced grip (rain) */
  get wetSession(): boolean { return this.wetGripScale < 0.999; }
  /** slicks = soft/medium/hard (they aquaplane in the wet) */
  get onSlicks(): boolean { return this.setup.compound === 'soft' || this.setup.compound === 'medium' || this.setup.compound === 'hard'; }
  /** inters/wets overheat & lose grip on a dry track (0.9 / 0.84) */
  get compoundDryPenalty(): number {
    if (!this.wetSession) {
      if (this.setup.compound === 'inter') return 0.9;
      if (this.setup.compound === 'wet') return 0.84;
    }
    return 1;
  }
  /** wet track: slicks suffer the full grip loss, inters keep 95%, full wets 100% */
  get wetSurfaceScale(): number {
    if (!this.wetSession) return 1;
    if (this.onSlicks) return this.wetGripScale;
    return this.setup.compound === 'inter' ? 0.95 : 1;
  }
  /** AQUAPLANING: slicks at speed on standing water lose up to 14% grip */
  get aquaplaneLoss(): number {
    return this.wetSession && this.onSlicks
      ? 0.14 * clamp((this.vLong - 38) / 90, 0, 1) : 0;
  }
  /** wear rate by compound & session (wet rubber on a dry track self-destructs) */
  get compoundWearMul(): number {
    const c = this.setup.compound;
    if (this.wetSession) {
      if (this.onSlicks) return 1.2;
      return c === 'inter' ? 0.9 : 0.8;
    }
    return c === 'inter' ? 2.4 : c === 'wet' ? 3 : c === 'soft' ? 1.5 : c === 'medium' ? 1 : 0.72;
  }
  get tireMu(): number {
    const base = PHYS.tireMu[this.setup.compound];
    const wear = 1 - (1 - PHYS.tireWearFloor) * this.tireWear;
    // v27: a wrecked car corners like a shopping trolley (−38% grip)
    return base * wear * this.compoundDryPenalty * this.paceMul * (1 - 0.38 * this.damage);
  }

  // ------------------------------------------------------------------ placement

  placeAt(p: THREE.Vector3, yaw: number): void {
    this.pos.copy(p);
    this.yaw = yaw;
    this.vLong = 0; this.vLat = 0; this.vy = 0; this.yawRate = 0;
    this.gear = 1;
    this.rpm = PHYS.idleRpm;
    this.steerAngle = 0; this.steerSm = 0;
    this.spinT = 0; this.drsOpen = false;
    this.mainIdx = -1;
    this.stalledOff = 0;
  }

  /** Recover to the racing surface: placed ON the racing line at the car's
   *  progress, facing forward, carrying ~45% of the profile speed — never a
   *  dead stop in the middle of the road (the old "stuck" respawn). */
  recoverOnLine(spline: { roadPoint(s: number, lat: number): THREE.Vector3; sampleAt(s: number): { tangent: { x: number; z: number } } },
    s: number, lateral: number, speed: number): void {
    const sc = ((s % 1) + 1) % 1;
    const sm = spline.sampleAt(sc);
    this.placeAt(spline.roadPoint(sc, lateral), Math.atan2(sm.tangent.x, sm.tangent.z));
    this.vLong = speed;
    this.gear = Math.max(1, this.idealGear);
    this.rpm = rpmAtSpeed(this.gear, speed);
  }

  spinFromContact(power: number): boolean {
    if (this.spinT > 0) return false;
    this.spinT = PHYS.contactSpinTime * clamp(power, 0.5, 1.4);
    this.drsOpen = false;
    return true;
  }

  // ------------------------------------------------------------------ the step

  step(dt: number, world: F1StepWorld, cars: F1Car[], controls: F1Controls, racing: boolean): void {
    // 1. ground ------------------------------------------------------------------
    this.ginfo = world.groundQuery(this.pos, { mainIdx: this.mainIdx });
    this.mainIdx = this.ginfo.mainIdx;
    // heading vs track direction (wrong-way detector)
    {
      const sm2 = (world as unknown as { spline?: { samples: { tangent: { x: number; z: number } }[] } }).spline;
      if (sm2 && this.ginfo.mainIdx >= 0 && sm2.samples[this.ginfo.mainIdx]) {
        const t = sm2.samples[this.ginfo.mainIdx].tangent;
        const f = this.forward();
        this.lastTangentDot = f.x * t.x + f.z * t.z;
      }
    }
    this.progressS = this.ginfo.s;
    this.surface = this.ginfo.surface;
    this.offTrack = this.ginfo.surface === 'grass' || this.ginfo.surface === 'gravel';

    // 2. timers ---------------------------------------------------------------------
    this.spinT = Math.max(0, this.spinT - dt);
    this.shiftTimer = Math.max(0, this.shiftTimer - dt);
    this.wallHit = Math.max(0, this.wallHit - dt * 5);
    this.lockupFront = Math.max(0, this.lockupFront - dt * 4);
    this.wheelSpin = Math.max(0, this.wheelSpin - dt * 3);
    this.slipRear = Math.max(0, this.slipRear - dt * 2.5);

    const spinning = this.spinT > 0;
    const speed = this.speed;

    // 3. control conditioning ------------------------------------------------------------
    let throttle = spinning ? 0 : clamp(controls.throttle, 0, 1);
    let brake = spinning ? 0 : clamp(controls.brake, 0, 1);
    let steer = spinning ? 0 : clamp(controls.steer, -1, 1);
    if (!racing && this.grounded) {
      // grid: cars hold on the brakes
      throttle = 0;
      brake = Math.max(brake, 0.3);
      steer = 0;
    }

    // player steering feel: expo + ramp + speed-sensitive lock
    if (this.isPlayer) {
      const a = this.arcade ? PHYS.arcade : null;
      const expo = Math.sign(steer) * Math.pow(Math.abs(steer), a ? a.steerExpo : PHYS.steerExpo);
      const rampIn = a ? a.steerRampIn : PHYS.steerRampIn;
      const rampOut = a ? a.steerRampOut : PHYS.steerRampOut;
      const ramp = Math.abs(expo) > Math.abs(this.steerSm) ? rampIn : rampOut;
      const delta = expo - this.steerSm;
      const stepAmt = Math.min(Math.abs(delta), ramp * dt);
      this.steerSm = clamp(this.steerSm + Math.sign(delta) * stepAmt, -1, 1);
      steer = this.steerSm;
    } else {
      this.steerSm = damp(this.steerSm, steer, 20, dt);
    }
    // speed-sensitive lock: less steering angle as aero loads the front
    const falloff = this.arcade && this.isPlayer ? PHYS.arcade.steerSpeedFalloff : PHYS.steerSpeedFalloff;
    const lockFrac = falloff + (1 - falloff)
      / (1 + Math.pow(speed / PHYS.steerSpeedRef, 2));
    // sign convention: controls.steer +1 = screen RIGHT; yaw+ = screen LEFT,
    // so the wheel angle negates the input (see KartController lineage note).
    this.steerAngle = -steer * PHYS.maxSteerAngle * lockFrac;
    this.steerAngleVis = steer;   // normalized input (+1 = right) for the visuals

    // 4. rpm & gearbox -------------------------------------------------------------------
    if (this.autoGears) {
      if (this.rpm > PHYS.shiftUpRpm && this.gear < 8 && this.shiftTimer <= 0 && throttle > 0.1) this.shift(1);
      else if (this.rpm < PHYS.shiftDownRpm && this.gear > 1 && this.shiftTimer <= 0) this.shift(-1);
    } else {
      if (controls.shiftUp && this.gear < 8 && this.shiftTimer <= 0) this.shift(1);
      else if (controls.shiftDown && this.gear > 1 && this.shiftTimer <= 0) this.shift(-1);
    }
    this.rpm = rpmAtSpeed(this.gear, Math.abs(this.vLong));
    // rev limiter bounce
    if (this.rpm >= PHYS.maxRpm - 40) this.rpm = PHYS.maxRpm - 60 - this.rng() * 80;

    // 5. masses & aero ----------------------------------------------------------------------
    const m = this.mass;
    const rho = PHYS.airDensity;
    const v2 = Math.max(0, this.vLong) * Math.max(0, this.vLong);
    const q = 0.5 * rho * v2;
    const dirtyFactor = 1 - this.dirtyAir * 0.55;   // dirty air hits the FRONT wing
    const cla = claOf(this.setup.wing, this.drsOpen) * (1 + teamAero(this.teamId));
    // v27: battle damage wrecks the aero package; the turbo cheat cleans it
    let cda = cdaOf(this.setup.wing, this.drsOpen) * (1 - this.slipstreamCut);
    cda *= (1 + 0.55 * this.damage) * (this.cheatTurbo ? 0.86 : 1);
    const downF = q * cla;
    const dragF = q * cda + PHYS.rollingResist * m * 9.81 * (this.vLong > 0.2 ? 1 : 0);

    // 6. axle loads (static + aero + longitudinal transfer) ------------------------------------
    const prevLong = this.longG * 9.81;
    const transfer = m * prevLong * H_CG / WHEELBASE;
    let FzF = m * 9.81 * (B_CG / WHEELBASE) + downF * (PHYS.aeroBalance * dirtyFactor) - transfer;
    let FzR = m * 9.81 * (A_CG / WHEELBASE) + downF * (1 - PHYS.aeroBalance) + transfer;
    FzF = Math.max(600, FzF);
    FzR = Math.max(600, FzR);

    // surface grip (with SANE load sensitivity: a gentle relative falloff —
    // the old linear formula went NEGATIVE under aero load and made every
    // fast corner feel like ice). Weather scales every surface (rain).
    const surfGrip = (PHYS.surfaceGrip[this.surface] ?? 1) * this.wetSurfaceScale * (1 - this.aquaplaneLoss);
    const loadMul = (Fz: number): number => 1 - PHYS.loadSensitivity * Math.max(0, Fz / 4000 - 1);
    const muF = this.tireMu * surfGrip * loadMul(FzF);
    const muR = this.tireMu * surfGrip * loadMul(FzR);

    // 7. longitudinal forces ----------------------------------------------------------------------
    // engine traction (rear axle)
    const wheelSpeed = Math.max(0, this.vLong);
    let traction = 0;
    if (throttle > 0.02 && this.shiftTimer <= 0 && !spinning) {
      const deploy = this.ersJ > 10000 && throttle > 0.85 && wheelSpeed > PHYS.ersDeployMinSpeed;
      this.ersDeploying = deploy;
      // v27: damage guts the engine (−62%); the admin BOOST adds a rocket
      // (extra ~1.1 MW + the turbo cheat ×1.5 base) — enough to drive past
      // the whole field, which is exactly what "win me the race" means.
      const dmgMul = 1 - 0.62 * this.damage;
      const turbo = this.cheatTurbo ? 1.5 : 1;
      const watts = enginePower(this.rpm, teamPower(this.teamId)) * throttle
        * this.powerMul * dmgMul * turbo
        + (deploy ? PHYS.mguKPower * throttle : 0)
        + (this.boostT > 0 ? 1_100_000 * throttle : 0);
      traction = watts / Math.max(wheelSpeed, 6.5);
      // wheelspin / traction control — TC rides JUST UNDER the grip limit
      // (never over it: an over-limit tractive force zeroes the rear lateral
      // grip through the friction ellipse and swaps ends on every launch)
      const gripR = muR * FzR;
      // v10.1 FRICTION-ELLIPSE-AWARE TC: full traction is only available on a
      // straight. While the rear axle is spending grip on lateral force, the
      // tractive budget shrinks by sqrt(1 - latDemand²). The old flat 0.93
      // clamp handed the rear 93% longitudinal INSIDE corners — the ellipse
      // then left ~37% lateral where the corner needed 85% → snap oversteer
      // in every chicane (power-on, and the AI held power mid-transition).
      const latRoom = Math.sqrt(Math.max(0.06, 1 - this.rearLatDemand * this.rearLatDemand));
      if (traction > gripR * latRoom) {
        this.wheelSpin = this.assistLevel > 0.5 ? 0.32 : 0.55;
        traction = gripR * latRoom * (this.assistLevel > 0.5 ? 0.97 : 0.93);
        this.ersDeploying = false;
      }
    } else {
      this.ersDeploying = false;
    }

    // brakes (bias split) — SMART BRAKE CONTROLLER: the rear axle never fully
    // saturates (brake-by-wire style stability — a saturated rear has zero
    // lateral grip and swaps ends on every corner entry); the surplus demand
    // moves to the front, which may lock (understeer, the honest consequence)
    let brakeF = 0, brakeR = 0;
    if (brake > 0.02 && !spinning) {
      const total = PHYS.brakeForce * brake;
      const capF = muF * FzF, capR = muR * FzR;
      const wantedF = total * this.setup.brakeBias;
      const wantedR = total * (1 - this.setup.brakeBias);
      const rearTarget = Math.min(wantedR, capR * 0.84);
      brakeR = rearTarget;
      if (this.assistLevel > 0.5) {
        // PLAYER ABS: cap the fronts just under the lock threshold — a locked
        // front axle has no steering (the "broken" feel) and keyboard braking
        // has no feathering. Pros (assist 0) can still lock up.
        brakeF = Math.min(wantedF + (wantedR - rearTarget), capF * 0.94);
      } else {
        brakeF = Math.min(wantedF + (wantedR - rearTarget), capF * 0.96);
        if (brakeF >= capF * 0.94) this.lockupFront = 1;
      }
    }
    this.brakeGlow = damp(this.brakeGlow,
      brake > 0.4 && speed > PHYS.brakeGlowSpeed ? clamp((speed - PHYS.brakeGlowSpeed) / 45, 0, 1) : 0, 3, dt);

    // surface drag (gravel/grass scrub)
    const surfDrag = (PHYS.surfaceDrag[this.surface] ?? 0) * (this.vLong > 0 ? 1 : 0);

    // reverse
    let reverseF = 0;
    if (this.vLong < 0.5 && brake > 0.5 && throttle < 0.1) {
      reverseF = -5200;   // m/s² scale: 5200N / 900kg ≈ 5.8 m/s² — reverse gear creep
      if (this.vLong < -PHYS.reverseTop) reverseF = 0;
    }

    const Fx = traction - (this.vLong > 0 ? brakeF + brakeR : 0) * Math.sign(this.vLong || 1)
      - dragF * Math.sign(this.vLong || 1) - surfDrag * Math.sign(this.vLong || 1) + reverseF;

    // 8-10. ARCADE lateral dynamics (player) — grip-capped kinematic steering.
    // The bicycle model above stays for AI cars. The arcade model can NEVER
    // spin: yaw follows the steering kinematically, capped by the grip circle,
    // and vLat is glued near zero. Overspeed into a corner understeers wide and
    // scrubs speed — the honest, forgiving arcade consequence.
    if (this.arcade && !spinning) {
      const A = PHYS.arcade;
      const gripMu = this.tireMu * surfGrip;
      const v = Math.max(3.5, Math.abs(this.vLong));
      // grip budget: flat tire grip + v² aero downforce (arcade-scaled)
      const latMax = 9.81 * gripMu * A.gripBoost + this.vLong * this.vLong * A.aeroLat;
      // where the wheels point vs what the tires can hold
      const yawDesired = (this.vLong / WHEELBASE) * Math.tan(this.steerAngle);
      // low-speed pivot: the Ackermann radius (≈10 m) is too wide to catch a
      // pursuit target at crawl speeds — below 14 m/s blend in direct rotation
      // (kart-like tight maneuvering) so the car can tighten onto the line
      let yawCmd = yawDesired;
      if (speed < 14 && speed > 0.3) {
        yawCmd += -this.steerSm * Math.min(1, (14 - speed) / 14) * 1.35;
      }
      const yawCap = latMax / Math.max(8, v);
      const yawTarget = clamp(yawCmd, -yawCap, yawCap);
      this.yawRate = damp(this.yawRate, yawTarget, A.yawFollow, dt);
      // understeer scrub: asking past the cap bleeds speed (wide line = slow)
      const overshoot = Math.abs(yawDesired) - yawCap;
      if (overshoot > 0 && this.vLong > 0) {
        this.vLong = Math.max(0, this.vLong - overshoot * v * A.scrub * dt);
      }
      // tire scrub drag even below the limit (full lock fries the rears)
      if (this.vLong > 0) {
        this.vLong = Math.max(0, this.vLong - Math.abs(this.yawRate) * v * A.scrubDrag * dt);
      }
      // glued with a whisper of drift angle for feel
      const drift = this.yawRate * Math.min(Math.abs(this.vLong) * 0.03, 0.5);
      this.vLat = damp(this.vLat, drift, A.glue, dt);
      this.yaw += this.yawRate * dt;

      const FxTotal = Fx;
      const vLongDot = FxTotal / this.mass;
      this.vLong += vLongDot * dt;
      this.longG = clamp(vLongDot / 9.81, -8, 8);
      this.latG = clamp(this.yawRate * this.vLong / 9.81, -8, 8);
      // slip telemetry: smoke/squeal only when deep past the cap (big understeer)
      this.slipRear = Math.max(this.slipRear, clamp((overshoot / Math.max(0.1, yawCap)) - 0.55, 0, 0.8));
      this.rearLatDemand = clamp(Math.abs(this.yawRate) / Math.max(0.05, yawCap), 0, 1);
    } else if (!spinning) {
      // ---- simulation lateral forces (Pacejka-lite magic formula per axle) --------------
      const absV = Math.max(Math.abs(this.vLong), 1.4);
      const alphaF = Math.atan2(this.vLat + this.yawRate * A_CG, absV) - this.steerAngle * Math.sign(this.vLong || 1);
      const alphaR = Math.atan2(this.vLat - this.yawRate * B_CG, absV);
      const latForce = (alpha: number, mu: number, Fz: number): number => {
        const D = mu * Fz;
        return -D * Math.sin(LAT_C * Math.atan(LAT_B * alpha));
      };
      let FyF = latForce(alphaF, muF, FzF);
      let FyR = latForce(alphaR, muR, FzR);
      // remember the rear lateral DEMAND (pre-ellipse) for next step's TC
      this.rearLatDemand = clamp(Math.abs(FyR) / Math.max(1, muR * FzR), 0, 1);

      // friction ellipse: longitudinal demand eats lateral grip
      const ellipse = (mu: number, Fz: number, longF: number, latF: number): number => {
        const cap = Math.max(1, mu * Fz);
        const usage = Math.abs(longF) / cap;
        if (usage >= 1) return 0;
        return latF * Math.sqrt(Math.max(0, 1 - usage * usage));
      };
      const longF_front = -brakeF * Math.sign(this.vLong || 1);
      const longF_rear = traction - brakeR * Math.sign(this.vLong || 1);
      FyF = ellipse(muF, FzF, longF_front, FyF);
      // lockup washes out the front tires completely (brake past the limit)
      if (this.lockupFront > 0.5) FyF *= 1 - PHYS.lockupMuDrop * 0.5;
      FyR = ellipse(muR, FzR, longF_rear, FyR);
      if (this.wheelSpin > 0.4) FyR *= 1 - (this.wheelSpin - 0.4) * 0.55;   // power oversteer

      // rear slip telemetry (smoke + audio)
      const rearUse = Math.abs(FyR) / Math.max(1, muR * FzR);
      if (rearUse > 0.94 && speed > 12) this.slipRear = Math.max(this.slipRear, clamp((rearUse - 0.94) * 12, 0, 1));
      if (this.wheelSpin > 0.5) this.slipRear = Math.max(this.slipRear, this.wheelSpin);

      // stability assist — damps the yaw toward the velocity vector (keyboard aid)
      if (this.assistLevel > 0 && speed > 8) {
        const targetRate = (this.vLong / WHEELBASE) * Math.tan(this.steerAngle);
        this.yawRate += (targetRate - this.yawRate) * clamp(PHYS.stabilityAssist * this.assistLevel, 0, 0.4) * dt * 12;
      }

      // integrate (body frame, rotating terms)
      const Iz = PHYS.izScale * (m / 798);
      const yawTorque = (FyF * A_CG - FyR * B_CG) / Iz;
      this.yawRate += yawTorque * dt;
      this.yawRate *= Math.exp(-1.1 * dt);   // yaw damping

      const FxTotal = Fx;
      const FyTotal = FyF + FyR;
      const vLongDot = FxTotal / m + this.vLat * this.yawRate;
      const vLatDot = FyTotal / m - Math.abs(this.vLong) * this.yawRate * Math.sign(this.vLong || 1);
      this.vLong += vLongDot * dt;
      this.vLat += vLatDot * dt;
      this.yaw += this.yawRate * dt;

      // low-speed kinematic steering (avoids the slip-angle singularity)
      if (speed < 3.2) {
        this.yawRate = damp(this.yawRate, (this.vLong / WHEELBASE) * Math.tan(this.steerAngle), 8, dt);
        this.vLat *= Math.exp(-6 * dt);
      }

      // reported G (clamped — the vLat·yawRate term explodes during spins)
      this.longG = clamp(vLongDot / 9.81, -8, 8);
      this.latG = clamp((this.vLat * this.yawRate + vLatDot) / 9.81 * -1, -8, 8);
    } else {
      // contact spin: scripted rotation, no control. Net rotation ≈ 70-90°
      // (the old ±170° donut parked victims FACING BACKWARDS on the road —
      // and a stationary wrong-way car never triggered recovery)
      this.yawRate = (Math.PI * 2.0) / PHYS.contactSpinTime * (this.spinT > PHYS.contactSpinTime * 0.55 ? 1 : -1);
      const FxTotal = -dragF - 2400;
      this.vLong += (FxTotal / m) * dt;
      this.vLat *= Math.exp(-4 * dt);
      this.yaw += this.yawRate * dt;
      this.longG = 0; this.latG = 0;
    }

    // 11. integrate world position -----------------------------------------------------------------------
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    this.pos.x += (sin * this.vLong + cos * this.vLat) * dt;
    this.pos.z += (cos * this.vLong - sin * this.vLat) * dt;

    // vertical: follow the road height (F1 tracks have no jumps; keep glued)
    const g = this.ginfo;
    if (g && g.hasGround) {
      this.pos.y = damp(this.pos.y, g.height, 30, dt);
      this.grounded = true;
    } else {
      this.grounded = false;
    }

    // 12. ERS & fuel -----------------------------------------------------------------------------------------
    if (this.boostT > 0) this.boostT = Math.max(0, this.boostT - dt);
    if (this.ersDeploying) this.ersJ = Math.max(0, this.ersJ - PHYS.mguKPower * dt);
    else if (throttle > 0.4) this.ersJ = Math.min(PHYS.ersCapacity, this.ersJ + PHYS.mguHTrickle * dt);
    if (brake > 0.2 && speed > 12) this.ersJ = Math.min(PHYS.ersCapacity, this.ersJ + PHYS.ersBrakeHarvest * dt);
    if (!this.cheatNoWear) this.fuel = Math.max(0, this.fuel - (this.engineWatts * throttle / 34_000_000) * dt - 0.008 * dt);

    // 13. tire wear (load-cycle driven) ------------------------------------------------------------------------
    const tireLoad = clamp((Math.abs(this.latG) * 2.4 + Math.abs(this.longG) * 1.6 + this.wheelSpin * 1.2) / 5.5, 0, 1);
    if (!this.cheatNoWear) {
      this.tireWear = clamp(this.tireWear + tireLoad * PHYS.tireWearRate * this.compoundWearMul * dt, 0, 1);
    }

    // 14. DRS gate ------------------------------------------------------------------------------------------------
    // (opens on request inside an allowed zone — Game flags eligibility; braking closes it)
    if (!this.drsEligible || brake > 0.15 || this.speed < 30) this.drsOpen = false;

    // 15. auto-recovery — ONLY for cars genuinely in trouble (off the road,
    // against the barriers, or facing the wrong way after a spin). A car
    // merely sitting in its grid box must NEVER be teleported.
    const inTrouble = racing && this.ginfo
      && (this.offTrack || Math.abs(this.ginfo.lateral) > this.ginfo.halfWidth);
    // facing backwards vs the track direction: the pursuit degenerates at
    // |alpha| ≈ π and a turned-around car loops forever — recover instead.
    // A car PARKED facing the wrong way (post-spin, speed ≈ 0) must recover
    // too — the old > 2 m/s gate left those beached on the asphalt forever,
    // jamming the whole field behind them.
    const wrongWay = !spinning && this.lastTangentDot < -0.35 && Math.abs(this.vLong) > 2;
    const parkedWrongWay = !spinning && racing && this.speed < 3 && this.lastTangentDot < -0.3;
    // wedged against a wall (or another car) nose-first while "racing": speed
    // ≈ 0 facing any direction — the wall clamp eats every Newton of thrust
    // and the low-speed steering can't rotate a stationary car. Nothing else
    // will ever free it → recover.
    const parkedStuck = !spinning && racing && this.speed < 1.8;
    // ARCADE: a car that never spins never needs low-speed maneuvering —
    // crawling under 4.5 m/s ON the racing surface means the pursuit looped
    // (hairpin apron, merged pack). Recover instead of crawling forever.
    const arcadeCrawl = this.arcade && !spinning && racing && !this.offTrack
      && this.speed < 4.5 && Math.abs(this.ginfo?.lateral ?? 0) < (this.ginfo?.halfWidth ?? 0) + 3;
    if ((speed < 6 && !spinning && inTrouble) || wrongWay || parkedWrongWay || parkedStuck || arcadeCrawl) {
      this.stalledOff += dt;
      const limit = wrongWay || parkedWrongWay ? 1.4 : parkedStuck ? 1.8
        : arcadeCrawl && !(speed < 6 && inTrouble) ? 2.4 : 2.6;
      if (this.stalledOff > limit) this.requestRespawn = true;
    } else {
      this.stalledOff = Math.max(0, this.stalledOff - dt);
    }

    // 16. walls ----------------------------------------------------------------------------------------------------------
    world.wallConstrain?.(this);

    // 17. NaN watchdog — a single degenerate integration must never poison the
    // world (projection crash, AI NaN targets). Reset to the last good state.
    if (!isFinite(this.pos.x + this.pos.y + this.pos.z + this.vLong + this.vLat + this.yawRate)) {
      this.pos.copy(this.lastGoodPos);
      this.yaw = this.lastGoodYaw;
      this.vLong = 0; this.vLat = 0; this.yawRate = 0;
      this.requestRespawn = true;
    } else {
      this.lastGoodPos.copy(this.pos);
      this.lastGoodYaw = this.yaw;
    }
    void cars;
  }

  /** Lose control after hard contact — admin cheat "TROMPO GENERAL"
   *  (spin the whole field) uses the same path with a big power. */
  spinOut(power = 1): void {
    if (this.spinT > 0) return;
    this.spinT = PHYS.contactSpinTime * clamp(power, 0.5, 1.4);
  }

  shift(dir: 1 | -1): void {
    const next = this.gear + dir;
    if (next < 1 || next > 8) return;
    this.gear = next;
    this.shiftTimer = PHYS.shiftTime;
    this.rpm = rpmAtSpeed(this.gear, Math.abs(this.vLong));
  }

  /** Gear the car would need at this speed for launch/shift logic. */
  get idealGear(): number {
    for (let g = 1; g <= 8; g++) if (speedAtRpm(g, PHYS.maxRpm) >= Math.abs(this.vLong) + 0.5) return g;
    return 8;
  }

  /** normalized steering input (+1 = right) for visuals/HUD. */
  steerAngleVis = 0;

  private lastGoodPos = new THREE.Vector3();
  private lastTangentDot = 1;
  private lastGoodYaw = 0;

  forward(): THREE.Vector3 { return new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw)); }
}
