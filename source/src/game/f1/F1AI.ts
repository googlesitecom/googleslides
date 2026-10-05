/**
 * APEX GP — AI drivers v25 "SCHUMACHER". Real racing drivers, not items-and-
 * rubberband bots.
 *
 * - v25 SCHUMACHER: machinery and demand are now DECOUPLED. The bot's grip
 *   (paceMul = m) and its demanded speed (m^0.62) used to be the same number,
 *   so a 1.24 expert asked 24% more than its tires could answer and surfed
 *   wide through every corner. Now demand d = m^0.62: corner speed grows
 *   with machinery while utilization (d²/m = m^0.24) stays under ~1.10 —
 *   FASTER laps with LESS drift. Engine power follows at half strength
 *   (powerMul = 1 + (m−1)·0.5) so super drivers corner like gods but top
 *   out at real DRS speeds instead of 390 km/h.
 * - v25 IN-RACE TRAINING ("entrenalos"): every driver hill-climbs their own
 *   pace. A clean lap (on track, no mistakes) pushes their machinery up a
 *   notch toward a personal ceiling; an incident lap (off-track, spin,
 *   beached) pulls it back. The field literally gets faster every lap and
 *   self-calibrates per track and weather — wet races settle lower by
 *   themselves.
 * - v23 PARITY: bots drive the SAME arcade machinery family as the player
 *   and the profile is computed with the REAL grip model, so the scale is
 *   honest (a 1.0 driver ≈ a full-commit human).
 * - v22 PERSONAL RACING LINES: every driver owns one of the 8 line variants
 *   (wide-attack → tidy-economical, side biases, own smoothing) and drives
 *   THAT — nobody follows the player's guidance line.
 * - pure-pursuit steering onto the personal line; follows the speed profile
 *   of that line with the driver's own braking commitment
 * - v16 DRIVER PERSONALITY: aggression / consistency / racecraft /
 *   smoothness (biased by difficulty) + personal line bias and apex style
 * - racecraft: slipstream + DRS runs carry real speed, aggression-gated
 *   overtaking (racecraft picks the inside line), one-move defense, blue
 *   flags
 * - rare small mistakes (locked entry / late apex) scaled by consistency
 */

import type { AILevel, F1Controls } from '../core/Types';
import { AI, PHYS } from '../core/Config';
import { clamp, makeRng, wrapAngle } from '../core/MathUtils';
import type { F1Car } from './F1Car';
import type { F1RacingLine } from './RacingLine';
import type { Spline } from '../tracks/Spline';

export interface F1AIContext {
  spline: Spline;
  line: F1RacingLine;
  cars: F1Car[];
  /** total race distance (m) of every car by id */
  totalM: Map<string, number>;
  level: AILevel;
  racing: boolean;
  time: number;
}

export class F1AIDriver {
  readonly car: F1Car;
  private rng: () => number;
  // ---- v16 driver personality -------------------------------------------------
  /** 0..1 — divebomb appetite, closing tolerance, brake pressure */
  aggression = 0.5;
  /** 0..1 — low = mistake-prone (rate × (1.7 - consistency)) */
  consistency = 0.5;
  /** 0..1 — defense probability + inside-line picks */
  racecraft = 0.5;
  /** 0..1 — throttle finesse (low = stabs the pedal) */
  smoothness = 0.5;
  /** personal line offset (m): some run a bit wide, some hug the inside */
  lineBias = 0;
  /** -0.7..0.7 — apex style: negative = deep entries, positive = early apexes */
  apexStyle = 0;
  /** favourite overtaking side (-1 left / 1 right) */
  overtakeSidePref = 1;
  /** v26 UNREAL: risk appetite (0..1) — divebombs into braking zones,
   *  hard launch, razor pedals, tighter pursuit lookahead, braking envelope
   *  past 100%. Set from AI.risk[level] in the constructor. */
  private riskiness = 0;
  /** v26: the demand exponent for THIS driver's level — unreal runs a
   *  flatter curve (m^0.55) so its 1.86–2.02 machinery turns into corner
   * speeds ~1.45–1.53× a committed human while utilization (m^0.10 ≤ 1.07)
   *  keeps the car glued to its line. */
  private demandExp = 0.62;
  // ---- pit strategy (set by Game) ----------------------------------------------
  planStopLap = -1;
  planSecondStop = false;
  // ---- v22 personal racing line + real pace --------------------------------
  /** the driver's own line (one of the track variants). Falls back to the
   *  shared guidance line when the caller passes none (QA autopilot). */
  private myLine: F1RacingLine | null = null;
  /** v25: the driver's MACHINERY multiplier m — grip scales with it
   *  (car.paceMul), power at half strength (car.powerMul). The DEMANDED
   *  speed is m^0.62 (see paceDemand), so a super-fast driver corners well
   *  above a committed human without asking 40% more than his tires answer.
   *  Raised in-race by the training loop below. */
  private speedMul = 1;
  /** v25 TRAINING: personal hill-climb bounds. Starts at baseM; every clean
   *  lap steps m up toward mCeil, every incident lap steps back. mFloor is
   *  the panic bottom (never slower than where they started). */
  private baseM = 1;
  private mFloor = 1;
  private mCeil = 1;
  /** per-lap incident bookkeeping for the training loop */
  private lapOffTrackT = 0;
  private lapMistakes = 0;
  private lapSpins = 0;
  private lapCrawlT = 0;
  private sawSpinning = false;
  /** how much a clean lap is worth (consistent drivers learn faster) */
  private learnStep = 0.01;
  private brakeUse: number;
  private mistakeCooldown = 12;     // no mistakes through launch + T1
  private mistakeT = 0;             // >0 while committing a small error
  private mistakeKind = 0;          // 0 deep entry, 1 shallow entry
  private defendUntil = 0;
  private defendAgainAt = 0;
  private defendSide = 0;           // -1 left / 1 right (offset direction)
  private overtakeSide = 0;
  private overtakeUntil = 0;
  private lastLapNoise = 0;
  private lapNoise = 0;
  // v10.1 traffic memory: sense whether the car ahead is DECELERATING — the
  // old flat queue cushion allowed +12 m/s closing into a braking car,
  // which rear-ended (and spun) half the field at every heavy braking zone
  private lastAheadId = '';
  private lastAheadSpeed = 0;
  // slide-recovery hysteresis: enter at a big slip, hold through the swing,
  // exit only when properly caught (a single threshold chattered between
  // pursuit and counter-steer and fed the tank-slapper)
  private recoveringFlag = false;
  // v10.1 launch discipline: lights-out chaos fix — the whole field used to
  // enter attack mode at once (any car <18 m ahead = the entire grid) and
  // swerve ±2.6 m into each other on the run to turn 1
  private launched = false;
  private launchUntil = Infinity;

  constructor(car: F1Car, level: AILevel, seed: number, personalLine?: F1RacingLine | null) {
    this.car = car;
    this.rng = makeRng((seed * 2654435761) & 0xffff);
    // v16: personality roll — every driver gets their own aggression,
    // consistency, racecraft and smoothness, biased by the difficulty level
    const bias = AI.personalityBias[level] ?? 0;
    const roll = (): number => clamp(
      0.5 + (this.rng() - 0.5) * 0.85 + bias * (0.4 + 0.6 * this.rng()), 0.08, 1);
    this.aggression = roll();
    this.consistency = roll();
    this.racecraft = roll();
    this.smoothness = roll();
    this.lineBias = (this.rng() - 0.5) * 1.1;
    this.apexStyle = (this.rng() - 0.5) * 1.4;
    this.overtakeSidePref = this.rng() < 0.3 ? -1 : 1;

    // v22: personal line — the driver OWNS a trajectory variant. Aggressive
    // drivers roll toward the wide-attack end of the pool, tidy ones toward
    // the economical end, so the style matches the personality.
    this.myLine = personalLine ?? null;

    // v25 SCHUMACHER: machinery drawn from the level's range (now measured in
    // GRIP: expert 1.38–1.52), pushed by aggression + consistency. The demand
    // curve (m^0.62) turns that into corner speeds ~22–30% over a committed
    // human — and the training loop below climbs each driver further as they
    // prove clean laps.
    const range = AI.paceRange[level] ?? [0.93, 1.02];
    const style = (this.aggression + this.consistency) * 0.5;   // 0..1
    this.speedMul = clamp(
      range[0] + (range[1] - range[0]) * (0.2 + 0.8 * this.rng()) * (0.45 + 1.05 * style),
      range[0], range[1] + 0.005);

    // v26 UNREAL: risk appetite from the level — everything below reads it.
    this.riskiness = AI.risk[level] ?? 0.1;
    this.demandExp = level === 'unreal' ? 0.55 : 0.62;

    // v25 TRAINING bounds: metronomes (high consistency) climb higher and
    // faster; hotheads start strong but keep giving laps back. v26: risk
    // appetite accelerates the climb (unreal drivers learn FAST).
    this.baseM = this.speedMul;
    this.mFloor = this.speedMul - 0.06;
    this.mCeil = Math.min(AI.trainCeilCap, this.speedMul + 0.04 + 0.08 * this.consistency);
    this.learnStep = 0.007 + 0.009 * this.consistency + 0.004 * this.riskiness;

    // v26: grip at full m, power at half strength (unreal clamps higher —
    // ~360 km/h, not ~390) — corner like a god, top out like a real F1.
    // v27: routed through applyCarPace so the slow-bots cheat scales it.
    this.powerClamp = level === 'unreal' ? 1.46 : 1.28;
    this.applyCarPace();
    // v10.1: 0.45 was too pro — bots spun in the esses and crawled out of
    // hairpins (solo autopilot averaged 24 m/s vs a 54 m/s profile). 0.65
    // keeps them quick but stable on the limit.
    car.assistLevel = 0.65;
    // v25: per-driver braking commitment — late brakers (aggressive) run the
    // envelope at 100%, careful ones at 95%. v26 UNREAL: risk pushes the
    // envelope PAST 100% (up to ~1.05 — they out-brake the physics envelope
    // and trust the machinery to answer; the arcade model catches the rare
    // overshoot with a sniff of scrub, never a spin).
    this.brakeUse = clamp((0.95 + 0.05 * this.aggression + 0.10 * this.riskiness)
      * (0.995 + 0.01 * this.rng()), 0.9, 1.05);
  }

  /** v25: the DEMANDED speed multiplier — decoupled from machinery (m^0.62;
   *  v26 unreal: m^0.55). Demand scales with m² inside the corner-speed
   *  formula, grip with m, so a linear demand put utilization at m (1.24
   *  experts surfed wide through every corner). The exponents keep
   *  utilization ≤ ~1.10 (unreal ≤ 1.07): the super driver asks for speed
   *  his tires can actually answer.
   *  v27: class-wide cheat multiplier (admin panel "BOTS LENTOS" = 0.62) —
   *  demand AND machinery (grip + power) drop while it is on, so the
   *  whole field brakes early, corners gently and accelerates like a
   *  junior series car. */
  static cheatDemand = 1;

  private get paceDemand(): number {
    return Math.pow(this.speedMul, this.demandExp) * F1AIDriver.cheatDemand;
  }

  /** push the driver's machinery into the car (grip + power), scaled by the
   *  v27 slow-bots cheat when active. Called on construction, every lap
   *  (training) and on cheat toggles. */
  private slowCheat = false;
  private powerClamp: number;
  private applyCarPace(): void {
    const slow = F1AIDriver.cheatDemand < 1;
    const m = clamp(this.speedMul * (slow ? F1AIDriver.cheatDemand : 1), 0.5, AI.trainCeilCap);
    this.car.paceMul = m;
    this.car.powerMul = clamp(1 + (m - 1) * 0.5, 0.5, this.powerClamp);
  }

  /** v25 TRAINING step — called on every lap crossing. Clean lap → climb
   *  toward the personal ceiling; incident lap → give some pace back. The
   *  asymmetric steps (+~0.01 vs −0.024) settle each driver just under the
   *  pace that puts them in the gravel: literally trained, in-race, on this
   *  track in this weather. */
  private trainLap(incidents: number): void {
    if (incidents === 0) {
      this.speedMul = Math.min(this.mCeil, this.speedMul + this.learnStep);
    } else {
      this.speedMul = Math.max(this.mFloor, this.speedMul - 0.012 - 0.012 * incidents);
    }
    this.applyCarPace();
  }

  /** v24/v25: QA/demo hook — pin this driver to a fixed DEMAND (the
   *  autopilot proxies a good human at ~0.97, independent of the level's
   *  range). Machinery is back-solved so the demand/projection matches a
   *  human's actual car. */
  tunePace(mul: number): void {
    const d = clamp(mul, 0.8, 1.34);
    const m = Math.pow(d, 1 / 0.62);
    this.speedMul = m;
    this.baseM = m; this.mFloor = m - 0.02; this.mCeil = m;  // QA proxy: no training
    this.car.paceMul = clamp(m, 0.82, AI.trainCeilCap);
    this.car.powerMul = clamp(1 + (m - 1) * 0.5, 0.85, this.riskiness > 0.6 ? 1.46 : 1.28);
  }

  update(dt: number, ctx: F1AIContext): F1Controls {
    const car = this.car;
    // v27: live slow-bots toggle — re-apply machinery the moment the cheat
    // flips (no need to wait for the next lap-crossing training step)
    const slowNow = F1AIDriver.cheatDemand < 1;
    if (slowNow !== this.slowCheat) { this.slowCheat = slowNow; this.applyCarPace(); }
    const { spline } = ctx;
    // v22: the driver races THEIR line — the shared guidance line is only a
    // fallback (QA autopilot). Every lookup below (target speed, curvature,
    // lateral target, blue-flag offset) comes from the personal variant.
    const line = this.myLine ?? ctx.line;
    const speed = Math.abs(car.vLong);
    // v25: the demanded-speed multiplier (machinery^0.62) — every target
    // below uses THIS, never the raw machinery multiplier.
    const d = this.paceDemand;

    // ---- lap-to-lap pace noise + v25 TRAINING -------------------------------------
    const lap = car.lap;
    if (lap !== this.lastLapNoise) {
      this.lastLapNoise = lap;
      // v24: inconsistent drivers swing more lap to lap (a 1.20 hero with
      // 0.3 consistency throws away a lap now and then — a personality,
      // not a bug)
      this.lapNoise = (this.rng() - 0.5) * (0.012 + (1 - this.consistency) * 0.022);
      // v25 TRAINING: grade the lap just completed and step the machinery.
      // An incident = off-track > 0.9 s, a spin, a real mistake, or getting
      // beached (crawl). Clean laps climb; messy ones give pace back.
      if (ctx.racing && lap >= 1 && this.mCeil > this.baseM) {
        const incidents = (this.lapOffTrackT > 0.9 ? 1 : 0)
          + (this.lapSpins > 0 ? 1 : 0)
          + (this.lapMistakes >= 2 ? 1 : 0)
          + (this.lapCrawlT > 1.2 ? 1 : 0);
        this.trainLap(incidents);
      }
      this.lapOffTrackT = 0;
      this.lapMistakes = 0;
      this.lapSpins = 0;
      this.lapCrawlT = 0;
    }
    // per-frame incident bookkeeping (cheap — feeds the training grade)
    if (ctx.racing) {
      if (car.offTrack && speed > 6) this.lapOffTrackT += dt;
      if (car.spinT > 0.05) {
        if (!this.sawSpinning) { this.lapSpins++; this.sawSpinning = true; }
      } else this.sawSpinning = false;
      if (speed < 4.5 && !car.offTrack) this.lapCrawlT += dt;
    }

    // ---- where are we on the line? ------------------------------------------------
    const prog = ((car.progressS % 1) + 1) % 1;
    const idx = spline.indexAtS(prog);
    const N = line.count;

    // ---- target speed from the profile (pace + noise + mistakes) --------------------
    // v25: the DEMAND multiplier (m^0.62) scales the whole profile — grip
    // (m) runs ahead of it, so the targets sit under what the machinery can
    // answer and the pursuit holds the line instead of surfing wide.
    let vAllow = line.vTarget[idx] * d * (1 + this.lapNoise);
    // tire wear margin: the profile is computed for fresh tires; worn rubber
    // gets a proportional lift so the AI stops riding over its own grip
    // (v25: 0.06 → 0.045 — the mu drop in tireMu already degrades the car;
    // with training pushing pace UP, double-penalizing wear had the field
    // fading exactly when the user pulled away "al final")
    vAllow *= 1 - 0.045 * car.tireWear;
    // look ahead for the slowest point within braking reach — the window
    // scales with SPEED² (a 330 km/h braking zone needs ~270 m of vision;
    // the old linear 2.2·v gave 215 m at 93 and over-saw at mid speeds).
    const spacing = spline.length / N;
    const lookIdx = Math.min(N - 1, idx + Math.floor((12 + 0.028 * speed * speed) / spacing));
    const buf = clamp(speed * 0.35, 4, 30);
    for (let i = idx + 1; i <= lookIdx; i++) {
      const v = line.vTarget[i % N] * d;
      if (v < vAllow) {
        // v25: envelope = the driver's OWN braking commitment (0.95–1.00 of
        // the real pedal capability, set by aggression in the constructor)
        const dist = (i - idx) * spacing;
        const vBrake = Math.sqrt(v * v + 2 * this.brakeA(speed) * this.brakeUse * Math.max(0, dist - buf));
        if (vBrake < vAllow) vAllow = vBrake;
      }
    }
    // v23: NO global brakeUse multiply — it shaved the straights (top speed
    // cut 3.5% everywhere) while the corner targets are already honest.

    // ---- v22 race intelligence: the tow and the flap carry REAL speed ----------
    // The profile is a solo-car aero model. A driver hunting in the slipstream
    // or with DRS open IS quicker down the straight — use it to set up moves
    // (this is how the pack stops being a train: the tow produces the speed
    // difference that creates the overtake into the braking zone).
    if (car.drsOpen) vAllow *= 1.055;
    if (car.slipstreamCut > 0.15) vAllow *= 1 + car.slipstreamCut * 0.16;

    // ---- rare mistakes (consistency-scaled) --------------------------------------------
    this.mistakeCooldown -= dt;
    const rate = (AI.mistakeRate[ctx.level] ?? 0.003) * (1.7 - this.consistency);
    if (this.mistakeCooldown <= 0 && speed > 30 && this.rng() < rate * dt * 60 && line.curv[idx] > 0.008) {
      this.mistakeT = 0.7 + this.rng() * 0.8;
      this.mistakeKind = this.rng() < 0.5 ? 0 : 1;
      this.mistakeCooldown = 14 + this.rng() * 22;
      this.lapMistakes++;                      // v25: feeds the training grade
    }
    if (this.mistakeT > 0) {
      this.mistakeT -= dt;
      if (this.mistakeKind === 0) vAllow *= 1.045;      // carrying a bit much — runs deep
      else vAllow *= 0.91;                              // over-slowed — scrubs the apex
    }

    // ---- launch discipline: first seconds are single-file ------------------------------
    // v26 UNREAL: high-risk drivers launch HARD — the hold shrinks with risk
    // (0.85 s base → ~0.47 s at risk 0.88): the unreal grid races from the
    // flag instead of filing out single-file.
    if (!this.launched && ctx.racing) {
      this.launched = true;
      this.launchUntil = ctx.time + AI.launchHoldS * (0.8 + this.rng() * 0.5)
        * (1 - 0.45 * this.riskiness);
    }
    const launching = !this.launched || ctx.time < this.launchUntil;

    // braking zone ahead? (attack discipline — nobody divebombs into a corner)
    // v22: compares against the driver's OWN scaled profile
    const spacingN = spline.length / N;
    const cornerIdx = (idx + Math.round((12 + speed * 1.6) / spacingN)) % N;
    const brakingZone = line.vTarget[cornerIdx] * d < speed - 6
      || Math.abs(line.curv[cornerIdx]) > 0.006;

    // ---- traffic: ahead / alongside / behind, with LATERAL awareness --------------------
    let steerBias = 0;             // lateral offset (m) added to the line target
    const myTotal = ctx.totalM.get(car.id) ?? 0;
    const myRightX = Math.cos(car.yaw), myRightZ = -Math.sin(car.yaw);
    let nearestAhead: { car: F1Car; dist: number; lat: number } | null = null;
    let nearestChaser: { car: F1Car; dist: number; lat: number } | null = null;
    let alongside = 0;             // signed lateral of a car door-to-door with me
    for (const other of ctx.cars) {
      if (other === car) continue;
      const dxo = other.pos.x - car.pos.x, dzo = other.pos.z - car.pos.z;
      if (dxo * dxo + dzo * dzo > 90 * 90) continue;
      const d = (ctx.totalM.get(other.id) ?? 0) - myTotal;
      const lat = dxo * myRightX + dzo * myRightZ;    // + = other sits on my right
      if (other.finished) {
        // cool-down cruiser: its race totalM froze at the flag — use the
        // forward distance in MY frame instead (it's a moving chicane)
        const fwdX = Math.sin(car.yaw), fwdZ = Math.cos(car.yaw);
        const dFwd = dxo * fwdX + dzo * fwdZ;
        if (dFwd > 0 && dFwd < 60 && (!nearestAhead || dFwd < nearestAhead.dist)) {
          nearestAhead = { car: other, dist: dFwd, lat };
        }
        continue;
      }
      if (d > 0 && d < 90) {
        if (!nearestAhead || d < nearestAhead.dist) nearestAhead = { car: other, dist: d, lat };
      } else if (d < 0 && d > -25) {
        if (!nearestChaser || -d < nearestChaser.dist) nearestChaser = { car: other, dist: -d, lat };
      }
      if (Math.abs(d) < 7.5 && Math.abs(lat) < 3.0) alongside = lat;
    }
    const aheadSpeed = nearestAhead ? Math.abs(nearestAhead.car.vLong) : 0;
    // a slow car on the racing line (spun, recovering, cruising) is a moving
    // chicane: commit to the clear side and go AROUND it — queuing behind it
    // is how contact chains snowball
    const slowObstacle = !!nearestAhead && aheadSpeed < 15 && speed > 18 && nearestAhead.dist < 45;
    if (slowObstacle) {
      steerBias += (nearestAhead!.lat >= 0 ? -1 : 1) * 2.8;   // pass on the open side
    }

    // side-by-side spacing: never squeeze — drift away from a car on my flank
    if (alongside !== 0 && ctx.racing) {
      steerBias -= Math.sign(alongside) * Math.min(1.6, 3.2 - Math.abs(alongside) * 0.5);
    }

    // attack: only out of the launch window, at speed, on a straight, at a
    // car that is actually in my lane (a car 5 m to the side is not a wall).
    // v16: the gate is AGGRESSION — meek drivers sit in the tow, aggressive
    // ones take the gap; racecraft picks the INSIDE line when it's on.
    // v26 UNREAL: high-risk drivers ATTACK INTO BRAKING ZONES (the divebomb
    // gate) and start the move from much further back (gap × 1.9 at risk .88)
    // — the move is set up in the tow and completed at the apex.
    const attackGap = AI.overtakeGap * (1 + 0.9 * this.riskiness);
    const diveOK = this.riskiness > 0.55;   // braking-zone attacks (divebombs)
    if (nearestAhead && !launching && !slowObstacle && ctx.racing && speed > 20
        && nearestAhead.dist > (diveOK && brakingZone ? 14 : 5.5)
        && nearestAhead.dist < attackGap
        && Math.abs(nearestAhead.lat) < 4.2 && (!brakingZone || diveOK)) {
      const closing = speed - aheadSpeed;
      const gate = 0.35 + 0.6 * this.aggression;
      const closingTol = -1 + (0.5 - this.aggression) * 2;
      if (this.rng() < gate && (closing > closingTol || nearestAhead.dist < 12)) {
        if (this.overtakeUntil < ctx.time) {
          // racecraft > 0.55 sometimes takes the inside (opposite of the
          // preferred side) — a proper racing move, not a random swerve
          const inside = this.racecraft > 0.55 && this.rng() < 0.25;
          this.overtakeSide = inside ? -this.overtakeSidePref : this.overtakeSidePref;
          this.overtakeUntil = ctx.time + 2.4;
        }
        steerBias += this.overtakeSide * AI.avoidLat;
        if (nearestAhead.dist < 22) vAllow = Math.min(vAllow, aheadSpeed + 6 + 2 * this.aggression);
      } else if (nearestAhead.dist < 16) {
        vAllow = Math.min(vAllow, aheadSpeed + 3);
      }
    }
    // queue behind a slower car — lane-gated (only if it truly blocks me).
    // v24: car-car contact is DISABLED in this game (arcade overlap), so
    // side-by-side racing through corners is SAFE — the old wide lane gates
    // (3.4 / 6.0 m) made the whole field queue nose-to-tail through the
    // esses behind ONE car: "todos van exactamente igual". Now a car only
    // matches pace when genuinely blocked; otherwise it pulls alongside.
    // The cushion still collapses the moment the car ahead brakes — you
    // never close at 10+ m/s on brake discs.
    if (nearestAhead && nearestAhead.dist < 13 && !slowObstacle
        && (nearestAhead.dist < 10 || Math.abs(nearestAhead.lat) < 2.4)) {
      let cushion = clamp((nearestAhead.dist - 4.5) * 1.1, 2.0, 9);
      if (nearestAhead.car.id === this.lastAheadId && aheadSpeed < this.lastAheadSpeed - 0.1) {
        cushion = Math.min(cushion, 3.2);   // it's braking — match it, don't ram it
      }
      this.lastAheadId = nearestAhead.car.id;
      this.lastAheadSpeed = aheadSpeed;
      vAllow = Math.min(vAllow, aheadSpeed + cushion);
    } else {
      this.lastAheadId = '';
    }

    // ---- defense: ONE move when a faster car sits in my wake ------------------------
    if (nearestChaser && ctx.racing && !launching && speed > 25) {
      const chaserClosing = Math.abs(nearestChaser.car.vLong) - speed;
      if (this.defendUntil > ctx.time) {
        steerBias += this.defendSide * 1.7;          // hold the move
      } else if (ctx.time > this.defendAgainAt
          && nearestChaser.dist < AI.defendGapM && chaserClosing > 0.8) {
        if (this.rng() < AI.defendBias) {
          this.defendSide = Math.sign(nearestChaser.lat) || 1;   // close their side
          this.defendUntil = ctx.time + 1.5;
          this.defendAgainAt = ctx.time + 5.5;
        } else {
          this.defendAgainAt = ctx.time + 3.0;       // chose not to — re-roll later
        }
      }
    }

    // ---- blue flags: about to be lapped → move off the line and lift ----------------
    if (ctx.racing) {
      const len = spline.length;
      for (const other of ctx.cars) {
        if (other === car || other.finished) continue;
        const dTotal = (ctx.totalM.get(other.id) ?? 0) - myTotal;
        if (dTotal <= len * 0.95) continue;                 // not a lap up on me
        const onTrack = ((dTotal % len) + len) % len;       // their arc vs mine
        const behind = (len - onTrack) % len;               // how far they trail on track
        if (behind < AI.blueFlagRoomM) {
          steerBias += (line.lat[idx] >= 0 ? -1 : 1) * 2.4;  // off the racing line
          if (behind < 24) vAllow *= 0.94;                  // don't fight the leader
          break;
        }
      }
    }

    // ---- steering: pure pursuit (curvature formulation — the stable one) ------
    // κ = 2·sin(α)/L_d → δ = atan(κ·wheelbase). Scales the correction with the
    // lookahead distance, so a 3 m grid offset commands a gentle arc instead
    // of full lock (the old yaw-error P-D saturated and fishtailed at launch).
    // v25 AGILITY: the base lookahead shortens as the driver's demand rises
    // (5.2 + 0.41·v at d=1, minus ~2.6·(d−1)) — a super driver attacks the
    // apex instead of flowing at it. At d 1.30 that is ~2 m tighter at race
    // speed: visibly sharper entries, and the pursuit stays stable because
    // the demand curve keeps the car under its grip cap.
    // v26 UNREAL: risk tightens it further (−1.8 m at risk 0.88) — the
    // unreal field hammers apexes.
    const lookM = Math.max(8, 5.2 + speed * 0.41 - 2.6 * (d - 1) - 1.8 * this.riskiness);
    const li = (idx + Math.round(lookM / (spline.length / N))) % N;
    const sm = spline.samples[li];
    let latTarget = clamp(line.lat[li] + steerBias, -sm.halfWidth + 1.1, sm.halfWidth - 1.1);
    // corner traffic: within 24 m of a MOVING car ahead in a corner, take the
    // line they leave you (their wheeltracks) instead of the optimal apex —
    // two cars converging on one apex point is the classic nose-across-side
    // lap-1 contact
    if (nearestAhead && !slowObstacle && aheadSpeed > 8 && nearestAhead.dist < 24
        && Math.abs(line.curv[li]) > 0.0045) {
      const hint = car.ginfo ? car.ginfo.mainIdx : -1;
      const proj = spline.project(nearestAhead.car.pos, hint, 14);
      if (proj) latTarget = clamp(proj.lateral, -sm.halfWidth + 1.1, sm.halfWidth - 1.1);
    }
    const tx = sm.pos.x + sm.right.x * latTarget - car.pos.x;
    const tz = sm.pos.z + sm.right.z * latTarget - car.pos.z;
    const alpha = wrapAngle(Math.atan2(tx, tz) - car.yaw);
    const kappa = 2 * Math.sin(alpha) / Math.max(8, lookM);
    const delta = Math.atan(kappa * 3.6);                       // wheel angle (rad)
    const lockFrac = PHYS.steerSpeedFalloff + (1 - PHYS.steerSpeedFalloff)
      / (1 + Math.pow(speed / PHYS.steerSpeedRef, 2));
    let steer = clamp(-(delta / (PHYS.maxSteerAngle * lockFrac)) - car.yawRate * 0.10, -0.9, 0.9);

    // ---- slide recovery -----------------------------------------------------------------
    // when the rear steps out, pure pursuit is the wrong controller: the target
    // swings across the horizon as the car rotates, so it commands full lock
    // each way (tank-slapper) while the throttle keeps the rear lit. Instead:
    // point the wheels where the velocity is actually going (zero front slip —
    // the classic catch; the sign works itself out through the formula) and
    // get off the power. Hysteresis: enter >0.34, exit <0.16 — the catch must
    // be HELD through the opposite-way swing, not toggled.
    const slip = car.slipAngle;
    if (this.recoveringFlag) {
      if (Math.abs(slip) < 0.16 || speed <= 6) this.recoveringFlag = false;
    } else if (Math.abs(slip) > 0.34 && speed > 6) {
      this.recoveringFlag = true;
    }
    const recovering = this.recoveringFlag;
    if (recovering) {
      // scaled catch (~65% of alignment, capped) — a full-lock counter at
      // 100+ km/h is its own overcorrection and fed the swing both ways
      const vAngle = Math.atan2(car.vLat + car.yawRate * 1.62, Math.max(1, Math.abs(car.vLong)));
      steer = clamp(-vAngle * 0.65 / (PHYS.maxSteerAngle * lockFrac), -0.75, 0.75);
    }

    // ---- pedals ------------------------------------------------------------------------------
    // v25: razor feet. Throttle snaps to full at vErr > ~1.05 (the TC manages
    // the rest — a super driver floors it the moment the corner opens), brake
    // hits max at vErr < −0.85. Sharper thresholds than v24 (0.35/0.25) cut
    // the ramp time on every corner exit — that is most of "ágiles".
    // v26 UNREAL: risk sharpens the thresholds further (0.26→0.18 / −0.18→−0.12)
    // — the pedal response of the unreal field is instantaneous.
    const vErr = vAllow - speed;
    let throttle = 0, brake = 0;
    const thrGate = 0.26 - 0.08 * this.riskiness;
    const brkGate = -(0.18 + 0.06 * this.riskiness);
    if (vErr > thrGate) throttle = clamp(vErr * 0.95, 0.14, 1);
    else if (vErr < brkGate) brake = clamp(-vErr * 1.15, 0, 1);
    // v23: the steering-load throttle cut is GONE — the player's arcade car
    // spends grip through the friction-aware TC and holds full power against
    // steering, so the cut was a pure bot handicap on every corner exit.
    // Only a genuine slide trims the power (arcade cars barely ever do).
    if (Math.abs(car.slipAngle) > 0.26) throttle *= 0.55;

    // mid-slide: kill the power (the save matters more than the lap time)
    if (recovering) { throttle *= 0.15; brake = 0; }

    // ---- DRS -------------------------------------------------------------------------------------
    const drs = car.drsEligible && speed > 34;

    return { throttle, brake, steer, drs, shiftUp: false, shiftDown: false, lookBack: false };
  }

  private brakeA(v: number): number {
    // v24: the REAL decel capability — same formula as the profile's
    // backward pass: the smart brake controller delivers ≈0.86 of the
    // theoretical tire cap (front ABS 0.94 + rear 0.84 with load transfer),
    // and the PEDAL itself tops at PHYS.brakeForce — at high speed a
    // high-pace car has more grip than pedal, so the achievable decel is
    // the minimum of the two. v23's 0.78 (and no pedal cap) braked ~9%
    // early every zone; stacked with the envelope it handed the player a
    // free head start into every corner.
    return Math.min(
      this.car.tireMu * (9.81 + 0.5 * PHYS.airDensity * 4.35 * v * v / this.car.mass) * 0.86,
      PHYS.brakeForce * 0.97 / this.car.mass);
  }
}
