/**
 * APEX GP — F1 physics & race tuning. SI units (meters, m/s, kg, N, W).
 *
 * Numbers are calibrated against 2022-regulation F1 cars:
 *   - mass 798 kg (+ fuel), ~700 kW combined ICE+MGU-K
 *   - top speed ~330 km/h (Monza trim, DRS) / ~315 km/h default
 *   - braking 5+ g at high speed (downforce-fed), ~2 g below 100 km/h
 *   - lateral 4-5 g in fast corners, grip grows with v² (aero)
 */

import type { TireCompound } from './Types';

export const PHYS = {
  fixedDt: 1 / 120,          // 120 Hz physics for high-g stability
  maxSubSteps: 8,
  renderDt: 1 / 60,

  gravity: 9.81,

  // ---- mass & inertia ---------------------------------------------------
  chassisMass: 798,          // kg, without fuel
  fuelPerMeter: 0.00052,     // kg/m (~0.9 kg/s at full throttle ≈ 210 g/km... scaled to laps)
  izScale: 1050,             // yaw inertia (kg·m²) — F1 cars rotate fast

  // ---- engine (2022 V6 turbo hybrid) --------------------------------------
  idleRpm: 4200,
  maxRpm: 12200,             // regulated 15000, raced at ~12k
  shiftUpRpm: 11900,
  shiftDownRpm: 8200,
  /** power curve: fraction of peak power vs rpm norm (0=idle..1=max) */
  powerCurve: (rpmN: number): number => {
    // torque plateau from 0.55, tapering after 0.9 (fuel-flow limited top end)
    if (rpmN < 0.28) return 0.24 + rpmN * 1.5;
    if (rpmN < 0.88) return 0.66 + (rpmN - 0.28) * 0.34 / 0.60;
    return 1.0 - Math.pow((rpmN - 0.88) / 0.12, 2) * 0.18;
  },
  icePower: 585_000,         // W
  mguKPower: 120_000,        // W deploy
  mguHTrickle: 18_000,       // W constant harvest while on throttle
  ersCapacity: 1_200_000,    // J (≈ 100 s of full deploy)
  ersDeployMinSpeed: 16,     // m/s — no deploy out of hairpins in 1st
  ersBrakeHarvest: 95_000,   // W recovered while braking
  shiftTime: 0.06,           // s torque cut on upshift

  // ---- gearbox ---------------------------------------------------------------
  /** top speed per gear (m/s @ maxRpm) — 1st ~94 km/h, 8th ~335 km/h */
  gearTopSpeed: [26, 36, 46, 56, 66, 76, 85, 93],
  reverseTop: 12,

  // ---- aero ------------------------------------------------------------------
  airDensity: 1.20,
  /** base drag area (Cd·A) at wing 3 */
  cdaBase: 1.42,
  /** drag delta per wing step */
  cdaPerWing: 0.055,
  /** base downforce area (Cl·A) at wing 3 */
  claBase: 4.35,
  /** downforce delta per wing step */
  claPerWing: 0.30,
  /** front downforce share (affects balance more than total) */
  aeroBalance: 0.44,
  drsCdaCut: 0.24,           // DRS open: drag ÷ (1 + cut)
  drsClACut: 0.78,           // ...and rear downforce nearly gone
  slipstreamDragCut: [0.34, 0.12],  // [max cut, taper distance factor]
  slipstreamRange: 42,       // m behind a car
  slipstreamCone: 0.86,      // cos of angle to the car ahead's heading
  dirtyAirLose: 0.10,        // following closer than 12m loses front downforce

  // ---- tires -------------------------------------------------------------------
  tireMu: { soft: 1.98, medium: 1.92, hard: 1.85, inter: 1.9, wet: 1.86 } as Record<TireCompound, number>,
  /** grip retained at 100% wear */
  tireWearFloor: 0.82,
  /** wear per second at full lateral+longitudinal load (~2%/lap) */
  tireWearRate: 0.0016,
  /** load sensitivity: mu drops this fraction per 100% load above 4 kN */
  loadSensitivity: 0.06,
  tireRadius: 0.36,
  rollingResist: 0.014,

  // ---- brakes -----------------------------------------------------------------
  brakeForce: 46000,         // N total at full pedal (carbon discs)
  lockupMuDrop: 0.62,        // grip multiplier once sliding
  brakeGlowSpeed: 55,        // m/s where discs start glowing visually

  // ---- surfaces -----------------------------------------------------------------
  surfaceGrip: { road: 1.0, kerb: 0.96, runoff: 0.92, grass: 0.58, gravel: 0.40 },
  surfaceDrag: { road: 0, kerb: 80, runoff: 50, grass: 300, gravel: 1100 },
  kerbRumbleSpeed: 9,        // m/s where the kerb starts shaking the car

  // ---- steering --------------------------------------------------------------------
  maxSteerAngle: 0.34,       // rad (19.5°) at the front wheels, low speed
  steerSpeedFalloff: 0.62,   // steering lock fraction at 250 km/h
  steerSpeedRef: 62,         // m/s where falloff is halfway
  steerRampIn: 6.8,          // keyboard ramp (rad/s of wheel input)
  steerRampOut: 9.5,
  steerExpo: 1.22,

  // ---- ARCADE handling (player) -------------------------------------------------------
  /** the player car uses grip-capped kinematic steering: it CANNOT spin, snap
   *  oversteer or tank-slap — taking a corner too fast understeers + scrubs
   *  speed instead. AI cars stay on the full simulation. */
  arcade: {
    /** flat grip multiplier (fun > realism) */
    gripBoost: 1.32,
    /** lateral acceleration gained per v² from aero downforce (m/s² per (m/s)²)
     *  0.0065 ≈ +32 m/s² of cornering at 250 km/h — F1-fast without the knife edge */
    aeroLat: 0.0072,
    /** fraction of the EXCESS lateral demand bled as speed (cornering scrub).
     *  0.06 ≈ 1.5-2 g of drag at a full-lock 300 km/h mistake — heavy but fair */
    scrub: 0.06,
    /** tire scrub drag at full lock (m/s²) scaled by yaw rate */
    scrubDrag: 0.05,
    /** how fast vLat is glued back to the drift target (1/s) */
    glue: 6.5,
    /** how fast yawRate chases the kinematic target (1/s) */
    yawFollow: 11,
    /** keyboard steering: slower in, more expo — smooth, not twitchy */
    steerRampIn: 4.6,
    steerRampOut: 7.0,
    steerExpo: 1.34,
    steerSpeedFalloff: 0.5,
  },

  // ---- driver aids (subtle — keeps keyboard driving credible) ----------------------
  stabilityAssist: 0.30,     // yaw damping toward the velocity vector
  tractionAssist: 0.45,      // wheelspin suppression below 30 m/s
  autoThrottleTraction: 0.6,

  // ---- collisions --------------------------------------------------------------------
  /** car-vs-car contact is DISABLED by player request — cars overlap freely
   *  (arcade style); track walls still collide. */
  carCollisions: false,
  carLength: 5.4,              // OBB footprint (matches the visual car)
  carWidth: 2.0,
  wallRestitution: 0.26,
  wallScrub: 0.86,           // speed retained per second of wall contact
  /** car-car bounciness (carbon panels barely rebound) */
  contactRestitution: 0.2,
  /** closing speed (m/s) that spins the victim in a nose-to-tail hit
   *  (13.5: lap-1 diagonal rubs wobble; real hits still spin) */
  contactSpinClosing: 13.5,
  contactSpinTime: 1.35,     // s of lost control
  /** closing speed (m/s) that destabilises without a full spin */
  contactWobble: 4.0,

  // ---- timing -----------------------------------------------------------------------
  gapWindow: 1.0,            // s behind the car ahead for DRS eligibility
} as const;

export const RACE = {
  /** lights come on one by one every 900ms; then a random hold before out */
  lightStepMs: 900,
  lightsOutHoldMinMs: 700,
  lightsOutHoldMaxMs: 1600,
  /** jump start: car moving before lights out */
  jumpStartTolerance: 0.35,   // m of movement allowed (creep)
  jumpStartPenaltySec: 5,
  trackLimitWarnings: 4,
  trackLimitPenaltySec: 5,
  /** time added when the player skips a full off-track excursion */
  finishSpectateMs: 9000,
  /** hard end after the winner crosses (+ gap-scaled grace) */
  raceOverBaseMs: 25000,
  checkpoints: 24,
  gridRows: 10,               // 20 cars: 2 per row, staggered
  gridRowGap: 8.5,            // m between grid rows
  gridStagger: 3.8,           // lateral stagger per row
  points: [25, 18, 15, 12, 10, 8, 6, 4, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  maxCars: 20,
  blueFlagGapM: -0.55,        // m of race distance (leader lapping you)
} as const;

export const AI = {
  lookaheadNear: 7,
  lookaheadFar: 26,
  steerKp: 5.4,
  steerKd: 0.85,
  /** v25 SCHUMACHER: per-driver MACHINERY multiplier range by level (grip
   *  scales with it 1:1; the demanded speed is m^0.62 and engine power at
   *  half strength — see F1AI). Measured against the real arcade limit:
   *  expert 1.38–1.52 demands 1.22–1.30× a full-commit human's corner speed
   *  and the in-race training climbs the consistent ones toward 1.60
   *  machinery (Monza ~54–57 s, ~335 km/h) — "el doble de buenos y ágiles".
   *  v26 UNREAL: machinery 1.86–2.02 with a FLATTER demand curve (m^0.55 —
   *  utilization m^0.10 ≤ 1.07, glued) — corner speeds ~1.45–1.53× a
   *  committed human, ~360 km/h with the raised power clamp. These drivers
   *  attack with 0.88 risk (divebombs into braking zones, launch hard,
   *  razor pedals) and make almost no mistakes. Hard brackets a good human
   * fight, medium is equal machinery, easy stays learnable. */
  paceRange: {
    easy: [0.90, 0.96], medium: [1.0, 1.08], hard: [1.06, 1.18], expert: [1.38, 1.52],
    unreal: [1.86, 2.02],
  } as Record<string, [number, number]>,
  /** v25: absolute machinery cap for the in-race training hill-climb — no
   *  driver, however metronomic, exceeds this grip. v26: raised to 2.15 so
   *  the unreal field can train up from 1.86–2.02 (expert tops at ~1.64,
   *  far below the cap — only unreal drivers ever see it). */
  trainCeilCap: 2.15,
  /** small-error chance per corner by level (scaled by driver consistency).
   *  v24: super drivers err RARELY — a 2-mistakes-per-lap field is a train,
   *  not a race. v26 unreal: near-flawless (0.00015 — they do not blink). */
  mistakeRate: { easy: 0.006, medium: 0.002, hard: 0.0009, expert: 0.0004, unreal: 0.00015 } as Record<string, number>,
  /** driver personality bias by level (aggression/racecraft/consistency push) */
  personalityBias: { easy: -0.18, medium: -0.06, hard: 0.06, expert: 0.16, unreal: 0.30 } as Record<string, number>,
  /** v26 UNREAL — risk appetite by level: gates divebomb attacks into
   *  braking zones, shortens the launch hold, sharpens the pedals, tightens
   *  the pursuit lookahead and pushes the braking envelope past 100%. */
  risk: { easy: 0.05, medium: 0.12, hard: 0.20, expert: 0.32, unreal: 0.88 } as Record<string, number>,
  defendBias: 0.6,            // willingness to move off-line to defend
  /** v22: attacks start earlier — out of the tow at 26 m back, so the move
   *  is SET UP on the straight and completed into the braking zone */
  overtakeGap: 26,
  avoidLat: 3.1,              // lateral offset when passing a car
  /** v25: 0.85 s of single-file launch discipline — just enough to avoid the
   *  lights-out swerve pileup; with super machinery these drivers RACE from
   *  the flag (a longer hold kept the front of the grid asleep while the
   *  player threaded them). */
  launchHoldS: 0.85,
  defendGapM: 12,             // chaser within this range may trigger one-move defense
  blueFlagRoomM: 32,          // yield the line when a car a lap up is this close behind
} as const;

export const CAMERA = {
  // F1-game chase: LOW, TIGHT, SNAPPY — sits just above the engine cover,
  // reacts fast, speed FOV stretch for the sensation of velocity.
  chaseDist: 8.1,
  chaseHeight: 2.0,
  chaseFov: 63,
  chaseFovSpeed: 17,          // +fov at 300km/h
  chaseLerp: 11.5,
  chaseLookLerp: 20,
  cockpitFov: 74,
  tvFov: 34,
  tvSwitchAheadM: 60,
  noseFov: 68,
  minCamY: 0.9,
  /** look-ahead: the camera peeks into the corner (meters of arc) */
  chaseLookAhead: 7,
  /** subtle high-speed rumble (0..1 shake floor at 300 km/h) */
  chaseSpeedShake: 0.055,
} as const;

export const WEATHER = {
  /** grip multiplier on every surface when wet */
  rainGrip: 0.86,
  /** AI racing-line mu multiplier in the rain (profile must match physics) */
  rainLineMu: 0.9,
} as const;

export const VIDEO = {
  /** ULTRA is the only tier — graphics are locked at maximum quality.
   *  Legacy low/medium entries remain for save-file compatibility only. */
  quality: {
    low:    { pixelRatio: 2, shadows: true, decor: 1.0, crowd: 1.0 },
    medium: { pixelRatio: 2, shadows: true, decor: 1.0, crowd: 1.0 },
    high:   { pixelRatio: 2, shadows: true, decor: 1.0, crowd: 1.0 },
  } as Record<string, { pixelRatio: number; shadows: boolean; decor: number; crowd: number }>,
} as const;

// ------------------------------------------------------- physics helpers

/** Engine power (W) available at the current rpm. */
export function enginePower(rpm: number, powerDelta = 0): number {
  const n = Math.max(0, Math.min(1, (rpm - PHYS.idleRpm) / (PHYS.maxRpm - PHYS.idleRpm)));
  return PHYS.icePower * PHYS.powerCurve(n) * (1 + powerDelta);
}

/** Wing-derived drag area. */
export function cdaOf(wing: number, drsOpen: boolean): number {
  const base = PHYS.cdaBase + (wing - 3) * PHYS.cdaPerWing;
  return drsOpen ? base / (1 + PHYS.drsCdaCut) : base;
}

/** Wing-derived downforce area (rear wing DRS dump mostly hits the rear axle). */
export function claOf(wing: number, drsOpen: boolean): number {
  const base = PHYS.claBase + (wing - 3) * PHYS.claPerWing;
  return drsOpen ? base * (1 - PHYS.drsClACut * 0.82) : base;
}

/** Speed (m/s) at a given rpm in a given gear [1..8]. */
export function speedAtRpm(gear: number, rpm: number): number {
  const top = PHYS.gearTopSpeed[gear - 1] ?? 100;
  return (rpm / PHYS.maxRpm) * top;
}

/** Ideal rpm for a speed in a gear. */
export function rpmAtSpeed(gear: number, speed: number): number {
  const top = PHYS.gearTopSpeed[gear - 1] ?? 100;
  return Math.max(PHYS.idleRpm, Math.min(PHYS.maxRpm, (speed / top) * PHYS.maxRpm));
}

/** rpm → gear that keeps the engine on the power band. */
export function idealGearFor(speed: number): number {
  for (let g = 1; g <= 8; g++) {
    const top = PHYS.gearTopSpeed[g - 1];
    if (speed <= top * 0.985) return g;
  }
  return 8;
}
