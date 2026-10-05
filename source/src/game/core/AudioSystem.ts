/**
 * VELOCITY GP — Audio: a synthesized 2022 V6 turbo-hybrid power unit plus a
 * fully procedural menu anthem (epic sports-theme: driving drums, sub bass,
 * supersaw stabs and a 16th arpeggio — zero audio assets, all WebAudio).
 *
 * Engine: layered saw/square oscillators at the V6 firing frequency
 * (rpm/60·3) with detune and a soft-clip waveshaper, PLUS an intake-roar
 * noise bed and a glue compressor — the pitch scream of a modern hybrid.
 * Turbo whistle + MGU-K whine + gearbox whine layered on top, wind/scrub/
 * kerb noise beds, shift cuts, downshift crackles, and a distant crowd bed.
 */

export class AudioSys {
  private static ctx: AudioContext | null = null;
  private static master: GainNode | null = null;
  private static sfxGain: GainNode | null = null;
  private static musicGain: GainNode | null = null;

  // engine voice
  private static engOsc: OscillatorNode[] = [];
  private static engGain: GainNode[] = [];
  private static engShaper: WaveShaperNode | null = null;
  private static engFilter: BiquadFilterNode | null = null;
  private static engOut: GainNode | null = null;
  private static turboOsc: OscillatorNode | null = null;
  private static turboGain: GainNode | null = null;
  private static mguOsc: OscillatorNode | null = null;
  private static mguGain: GainNode | null = null;
  private static gearWhineOsc: OscillatorNode | null = null;
  private static gearWhineGain: GainNode | null = null;

  // noise beds
  private static windSrc: AudioBufferSourceNode | null = null;
  private static windGain: GainNode | null = null;
  private static scrubSrc: AudioBufferSourceNode | null = null;
  private static scrubGain: GainNode | null = null;
  private static kerbOsc: OscillatorNode | null = null;
  private static kerbGain: GainNode | null = null;
  private static crowdSrc: AudioBufferSourceNode | null = null;
  private static crowdGain: GainNode | null = null;

  // ---- real engine recording (repo Motor.mp3) --------------------------------
  // THE engine voice: a looping 3 s steady-rev window of the user's own
  // Motor.mp3 recording, pitch-shifted live by RPM (playbackRate) — the
  // synth oscillator stack below becomes a quiet support layer (or the
  // fallback if the file can't be fetched).
  private static engSampleBuf: AudioBuffer | null = null;
  private static engSampleSrc: AudioBufferSourceNode | null = null;
  private static engSampleGain: GainNode | null = null;
  private static engSampleFilter: BiquadFilterNode | null = null;
  private static engSampleReady = false;

  // intake roar (throttle-driven noise band)
  private static intakeSrc: AudioBufferSourceNode | null = null;
  private static intakeGain: GainNode | null = null;
  private static intakeFilter: BiquadFilterNode | null = null;

  // ---- procedural menu music --------------------------------------------------
  private static musicTimer: ReturnType<typeof setInterval> | null = null;
  private static musicNextT = 0;          // next 16th-note grid time
  private static musicStep = 0;           // absolute 16th index
  private static musicBus: GainNode | null = null;
  private static musicPlaying = false;

  private static started = false;
  private static sfxVol = 0.8;
  private static musicVol = 0.55;
  private static noiseBuf: AudioBuffer | null = null;

  static init(opts: { music: number; sfx: number }): void {
    if (this.started) return;
    try {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 1;
      // master glue limiter — nothing may clip, everything stays punchy
      const limiter = this.ctx.createDynamicsCompressor();
      limiter.threshold.value = -6;
      limiter.knee.value = 6;
      limiter.ratio.value = 8;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.18;
      this.master.connect(limiter);
      limiter.connect(this.ctx.destination);
      this.sfxGain = this.ctx.createGain();
      this.sfxGain.gain.value = opts.sfx;
      // sfx glue compressor (engine + impacts live together)
      const sfxComp = this.ctx.createDynamicsCompressor();
      sfxComp.threshold.value = -14;
      sfxComp.knee.value = 10;
      sfxComp.ratio.value = 3.5;
      sfxComp.attack.value = 0.004;
      sfxComp.release.value = 0.12;
      this.sfxGain.connect(sfxComp);
      sfxComp.connect(this.master);
      this.musicGain = this.ctx.createGain();
      this.musicGain.gain.value = opts.music;
      this.musicGain.connect(this.master);
      this.sfxVol = opts.sfx;
      this.musicVol = opts.music;
      this.noiseBuf = this.makeNoise(2);
      this.buildEngine();
      this.buildBeds();
      this.buildMusicBus();
      this.loadEngineSample();
      this.started = true;
    } catch { /* audio unavailable */ }
  }

  /** Fetch + decode the repo's Motor.mp3 and start it as a silent, looping,
   *  RPM-pitched engine voice. Never throws — on failure the procedural
   *  synth engine stays at full volume (fallback). */
  private static loadEngineSample(): void {
    try {
      const base = (process.env.NEXT_PUBLIC_BASE_PATH ?? '').replace(/\/$/, '');
      void fetch(`${base}/audio/Motor.mp3`)
        .then(r => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then(ab => {
          if (!this.ctx) return null;
          return this.ctx.decodeAudioData(ab);
        })
        .then(buf => {
          if (!buf || !this.ctx || !this.sfxGain) return;
          this.engSampleBuf = buf;
          // steady full-throttle window of the recording (15.0 s → 18.0 s,
          // ≈1.34 kHz dominant — the most RPM-stable stretch, measured)
          const LOOP_START = 15.0;
          const LOOP_END = Math.min(18.0, buf.duration - 0.05);
          const src = this.ctx.createBufferSource();
          src.buffer = buf;
          src.loop = true;
          src.loopStart = LOOP_START;
          src.loopEnd = LOOP_END;
          this.engSampleFilter = this.ctx.createBiquadFilter();
          this.engSampleFilter.type = 'lowpass';
          this.engSampleFilter.frequency.value = 900;
          this.engSampleFilter.Q.value = 0.7;
          this.engSampleGain = this.ctx.createGain();
          this.engSampleGain.gain.value = 0;          // silent until driving
          src.connect(this.engSampleFilter);
          this.engSampleFilter.connect(this.engSampleGain);
          this.engSampleGain.connect(this.sfxGain);
          src.start(0, LOOP_START);
          this.engSampleSrc = src;
          this.engSampleReady = true;
        })
        .catch(() => { /* file missing → procedural engine stays full */ });
    } catch { /* fetch unavailable → procedural engine */ }
  }

  /** Unlock the AudioContext from a user gesture (intro click). */
  static unlock(): void {
    if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume();
  }

  private static makeNoise(seconds: number): AudioBuffer | null {
    if (!this.ctx) return null;
    const buf = this.ctx.createBuffer(1, this.ctx.sampleRate * seconds, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < d.length; i++) {
      // pinkish
      const w = Math.random() * 2 - 1;
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.2;
    }
    return buf;
  }

  private static buildEngine(): void {
    const ctx = this.ctx!;
    this.engOut = ctx.createGain();
    this.engOut.gain.value = 0;
    this.engOut.connect(this.sfxGain!);

    // waveshaper: asymmetric soft clip = exhaust grit
    this.engShaper = ctx.createWaveShaper();
    const n = 1024, curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = Math.tanh(x * 3.1) * 0.86;
    }
    this.engShaper.curve = curve;
    this.engFilter = ctx.createBiquadFilter();
    this.engFilter.type = 'lowpass';
    this.engFilter.frequency.value = 1200;
    this.engFilter.Q.value = 0.8;
    this.engShaper.connect(this.engFilter);
    this.engFilter.connect(this.engOut);

    // harmonics: fire fundamental + 2nd (detuned) + sub octave + 4th + 5th
    // (the extra high partials are what read as "scream" at 12k rpm)
    const voices: [OscillatorType, number, number][] = [
      ['sawtooth', 1.0, 0.5],
      ['sawtooth', 2.02, 0.30],
      ['square', 0.5, 0.34],
      ['sawtooth', 3.01, 0.14],
      ['sawtooth', 4.05, 0.085],
      ['square', 5.92, 0.05],
    ];
    for (const [type, mul, gain] of voices) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = 200 * mul;
      const g = ctx.createGain();
      g.gain.value = gain;
      o.connect(g);
      g.connect(this.engShaper);
      o.start();
      this.engOsc.push(o);
      this.engGain.push(g);
      (o as unknown as { _mul: number })._mul = mul;
    }

    // intake roar: noise band that opens with throttle+rpm (the deep bellow
    // under the scream — without it the engine sounds thin and synthetic)
    this.intakeSrc = ctx.createBufferSource();
    this.intakeSrc.buffer = this.noiseBuf;
    this.intakeSrc.loop = true;
    this.intakeFilter = ctx.createBiquadFilter();
    this.intakeFilter.type = 'bandpass';
    this.intakeFilter.frequency.value = 320;
    this.intakeFilter.Q.value = 0.9;
    this.intakeGain = ctx.createGain();
    this.intakeGain.gain.value = 0;
    this.intakeSrc.connect(this.intakeFilter);
    this.intakeFilter.connect(this.intakeGain);
    this.intakeGain.connect(this.engOut);
    this.intakeSrc.start();

    // turbo whistle
    this.turboOsc = ctx.createOscillator();
    this.turboOsc.type = 'sine';
    this.turboOsc.frequency.value = 3800;
    this.turboGain = ctx.createGain();
    this.turboGain.gain.value = 0;
    this.turboOsc.connect(this.turboGain);
    this.turboGain.connect(this.engOut);
    this.turboOsc.start();

    // MGU-K whine
    this.mguOsc = ctx.createOscillator();
    this.mguOsc.type = 'sawtooth';
    this.mguOsc.frequency.value = 1400;
    this.mguGain = ctx.createGain();
    this.mguGain.gain.value = 0;
    const mguF = ctx.createBiquadFilter();
    mguF.type = 'bandpass';
    mguF.frequency.value = 2400;
    mguF.Q.value = 8;
    this.mguOsc.connect(this.mguGain);
    this.mguGain.connect(mguF);
    mguF.connect(this.engOut);
    this.mguOsc.start();

    // gearbox whine (rpm-scaled, quiet)
    this.gearWhineOsc = ctx.createOscillator();
    this.gearWhineOsc.type = 'square';
    this.gearWhineOsc.frequency.value = 900;
    this.gearWhineGain = ctx.createGain();
    this.gearWhineGain.gain.value = 0;
    const gwf = ctx.createBiquadFilter();
    gwf.type = 'bandpass';
    gwf.frequency.value = 1800;
    gwf.Q.value = 6;
    this.gearWhineOsc.connect(this.gearWhineGain);
    this.gearWhineGain.connect(gwf);
    gwf.connect(this.engOut);
    this.gearWhineOsc.start();
  }

  private static buildBeds(): void {
    const ctx = this.ctx!;
    // wind
    this.windSrc = ctx.createBufferSource();
    this.windSrc.buffer = this.noiseBuf;
    this.windSrc.loop = true;
    const wf = ctx.createBiquadFilter();
    wf.type = 'lowpass';
    wf.frequency.value = 700;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    this.windSrc.connect(wf);
    wf.connect(this.windGain);
    this.windGain.connect(this.sfxGain!);
    this.windSrc.start();

    // tire scrub
    this.scrubSrc = ctx.createBufferSource();
    this.scrubSrc.buffer = this.noiseBuf;
    this.scrubSrc.loop = true;
    const sf = ctx.createBiquadFilter();
    sf.type = 'bandpass';
    sf.frequency.value = 1100;
    sf.Q.value = 1.4;
    this.scrubGain = ctx.createGain();
    this.scrubGain.gain.value = 0;
    this.scrubSrc.connect(sf);
    sf.connect(this.scrubGain);
    this.scrubGain.connect(this.sfxGain!);
    this.scrubSrc.start();

    // kerb rumble
    this.kerbOsc = ctx.createOscillator();
    this.kerbOsc.type = 'square';
    this.kerbOsc.frequency.value = 34;
    this.kerbGain = ctx.createGain();
    this.kerbGain.gain.value = 0;
    const kf = ctx.createBiquadFilter();
    kf.type = 'lowpass';
    kf.frequency.value = 120;
    this.kerbOsc.connect(this.kerbGain);
    this.kerbGain.connect(kf);
    kf.connect(this.sfxGain!);
    this.kerbOsc.start();

    // crowd bed
    this.crowdSrc = ctx.createBufferSource();
    this.crowdSrc.buffer = this.noiseBuf;
    this.crowdSrc.loop = true;
    const cf = ctx.createBiquadFilter();
    cf.type = 'lowpass';
    cf.frequency.value = 420;
    this.crowdGain = ctx.createGain();
    this.crowdGain.gain.value = 0;
    this.crowdSrc.connect(cf);
    cf.connect(this.crowdGain);
    this.crowdGain.connect(this.sfxGain!);
    this.crowdSrc.start();
  }

  /**
   * Per-frame engine + ambience mix.
   * @param rpmN     0..1 normalized rpm
   * @param throttle 0..1
   * @param speed    m/s
   * @param slip     0..1 tire slip
   * @param onKerb   on the kerbs
   * @param offTrack grass/gravel
   * @param ers      deploying ERS
   * @param shifting torque cut in progress
   */
  static engine(rpmN: number, throttle: number, speed: number, slip = 0,
    onKerb = false, offTrack = false, ers = false, shifting = false): void {
    if (!this.ctx || !this.engOut) return;
    const t = this.ctx.currentTime;
    const set = (p: AudioParam, v: number, tc = 0.045): void => { p.setTargetAtTime(v, t, tc); };

    const fire = 60 + rpmN * 580;              // firing frequency at the crank*3
    for (let i = 0; i < this.engOsc.length; i++) {
      const mul = (this.engOsc[i] as unknown as { _mul: number })._mul;
      set(this.engOsc[i].frequency, fire * mul, 0.02);
    }
    // ---- the REAL engine (repo Motor.mp3) — the player's instrument -------
    // pitch maps to RPM (idle ≈ ×0.58, redline ≈ ×1.30), volume to throttle
    // load; the filter opens with revs so low rpm sounds muffled and the
    // high-rev scream cuts through exactly like a real power unit.
    const cut = shifting ? 0.22 : 1;
    const load = 0.2 + 0.8 * Math.max(throttle, rpmN * 0.42);
    if (this.engSampleReady && this.engSampleSrc && this.engSampleGain && this.engSampleFilter) {
      set(this.engSampleSrc.playbackRate, 0.58 + rpmN * 0.72, 0.03);
      set(this.engSampleGain.gain, 0.5 * load * cut * this.sfxVol, 0.05);
      set(this.engSampleFilter.frequency, 850 + rpmN * 4400 + throttle * 2100, 0.06);
    }
    // ---- synth stack: support layer under the recording (full only if the
    // file is missing) --------------------------------------------------------
    const synthScale = this.engSampleReady ? 0.26 : 1;
    set(this.engOut.gain, 0.30 * synthScale * load * cut * this.sfxVol, 0.05);
    // brightness follows rpm + throttle
    set(this.engFilter!.frequency, 480 + rpmN * 3000 + throttle * 3600, 0.06);
    // intake roar: bellow opens with throttle, pitch rises with rpm
    set(this.intakeGain!.gain, (0.10 + 0.16 * throttle) * (0.35 + rpmN * 0.65) * this.sfxVol, 0.06);
    set(this.intakeFilter!.frequency, 240 + rpmN * 640 + throttle * 260, 0.08);
    // turbo spool
    set(this.turboGain!.gain, 0.012 * throttle * (0.3 + rpmN) * this.sfxVol, 0.1);
    set(this.turboOsc!.frequency, 2200 + rpmN * 5200 + throttle * 800, 0.1);
    // MGU-K whine while deploying
    set(this.mguGain!.gain, (ers ? 0.05 : 0) * this.sfxVol, 0.08);
    // gearbox whine with speed
    set(this.gearWhineGain!.gain, 0.014 * Math.min(1, speed / 70) * this.sfxVol, 0.1);
    set(this.gearWhineOsc!.frequency, 700 + rpmN * 1500, 0.1);
    // wind
    set(this.windGain!.gain, Math.min(0.16, Math.pow(speed / 90, 2) * 0.2) * this.sfxVol, 0.12);
    // scrub
    set(this.scrubGain!.gain, slip * 0.14 * this.sfxVol, 0.05);
    // kerb
    set(this.kerbGain!.gain, onKerb && speed > 8 ? 0.13 * this.sfxVol : 0, 0.03);
    // off-track: gravel/grass rumble via scrub boost + wind cut
    if (offTrack) set(this.scrubGain!.gain, Math.min(0.22, speed / 60) * this.sfxVol, 0.05);
    // crowd bed during races
    set(this.crowdGain!.gain, 0.018 * this.sfxVol, 0.5);
  }

  static engineOff(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.engOut?.gain.setTargetAtTime(0, t, 0.08);
    this.engSampleGain?.gain.setTargetAtTime(0, t, 0.08);   // the recording too
    this.windGain?.gain.setTargetAtTime(0, t, 0.1);
    this.scrubGain?.gain.setTargetAtTime(0, t, 0.05);
    this.kerbGain?.gain.setTargetAtTime(0, t, 0.05);
    this.turboGain?.gain.setTargetAtTime(0, t, 0.05);
    this.mguGain?.gain.setTargetAtTime(0, t, 0.05);
    this.gearWhineGain?.gain.setTargetAtTime(0, t, 0.05);
    this.intakeGain?.gain.setTargetAtTime(0, t, 0.05);
  }

  /** Gear shift: throttle cut click + short blip. */
  static playShift(up: boolean, rpmN: number): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    // mechanical click
    this.blip(240 + rpmN * 160, 0.03, 'square', 0.10);
    // upshift: rising chirp; downshift: exhaust crackle
    if (up) {
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(300 + rpmN * 500, t);
      o.frequency.exponentialRampToValueAtTime(600 + rpmN * 900, t + 0.05);
      g.gain.setValueAtTime(0.06 * this.sfxVol, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
      o.connect(g);
      g.connect(this.sfxGain!);
      o.start(t);
      o.stop(t + 0.08);
    } else {
      this.crackle(0.14);
    }
  }

  /** Exhaust crackle burst (downshifts, limiter). */
  private static crackle(dur: number): void {
    if (!this.ctx || !this.noiseBuf) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = 0.6;
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 900;
    f.Q.value = 0.8;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.16 * this.sfxVol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f);
    f.connect(g);
    g.connect(this.sfxGain!);
    src.start(t, Math.random());
    src.stop(t + dur + 0.02);
  }

  /** Start-light beep (low) / lights-out (high). */
  static playLightsBeep(n: number): void {
    this.blip(n > 0 ? 520 : 880, n > 0 ? 0.12 : 0.34, 'square', 0.2);
  }

  /** UI/game one-shot beep. */
  static playBeep(freq: number, dur: number, type: OscillatorType = 'sine', gain = 0.15): void {
    this.blip(freq, dur, type, gain);
  }

  private static blip(freq: number, dur: number, type: OscillatorType, gain: number): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(gain * this.sfxVol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g);
    g.connect(this.sfxGain!);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  /** Tire squeal at the limit (lockup / big slide). */
  static playSqueal(intensity: number): void {
    if (!this.ctx || !this.noiseBuf) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = 1.8;
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.setValueAtTime(1600, t);
    f.frequency.linearRampToValueAtTime(2300, t + 0.3);
    f.Q.value = 14;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.12 * intensity * this.sfxVol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    src.connect(f);
    f.connect(g);
    g.connect(this.sfxGain!);
    src.start(t, Math.random());
    src.stop(t + 0.4);
  }

  /** Big impact thud (wall / contact). */
  static playImpact(strength: number): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(120, t);
    o.frequency.exponentialRampToValueAtTime(38, t + 0.18);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.3 * Math.min(1, strength) * this.sfxVol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
    o.connect(g);
    g.connect(this.sfxGain!);
    o.start(t);
    o.stop(t + 0.25);
    this.crackle(0.1);
  }

  /** Crowd roar (finish / overtake fireworks). */
  static crowdSwell(strength = 1): void {
    if (!this.ctx || !this.crowdGain) return;
    const t = this.ctx.currentTime;
    this.crowdGain.gain.cancelScheduledValues(t);
    this.crowdGain.gain.setTargetAtTime(0.07 * strength * this.sfxVol, t, 0.4);
    this.crowdGain.gain.setTargetAtTime(0.018 * this.sfxVol, t + 2.5, 1.2);
  }

  static setSfxVolume(v: number): void {
    this.sfxVol = v;
    if (this.sfxGain) this.sfxGain.gain.value = v;
  }
  static getSfxVolume(): number { return this.sfxVol; }

  // ============================================================ MENU ANTHEM
  // A procedural epic sports theme — 126 BPM, A minor, the classic
  // vi–IV–I–V epic loop (Am F C G). Layered: 4-on-the-floor kick, clap
  // snare, offbeat hats, driving sub-bass 8ths, detuned supersaw chord
  // stabs, and a 16th-note pluck arpeggio through a feedback delay.
  // Everything is scheduled on a look-ahead grid (like a DAW) so the
  // groove never drifts or stutters.

  private static buildMusicBus(): void {
    const ctx = this.ctx!;
    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = 0;
    // glue compressor + a touch of high-shelf sparkle
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 12;
    comp.ratio.value = 3;
    comp.attack.value =  0.006;
    comp.release.value = 0.14;
    const shine = ctx.createBiquadFilter();
    shine.type = 'highshelf';
    shine.frequency.value = 3800;
    shine.gain.value = 2.5;
    this.musicBus.connect(comp);
    comp.connect(shine);
    shine.connect(this.musicGain!);
    // shared delay for the arp (dotted-8th feedback echo)
    this.mDelay = ctx.createDelay(1);
    this.mDelay.delayTime.value = (60 / 126) * 0.75;
    this.mFeedback = ctx.createGain();
    this.mFeedback.gain.value = 0.34;
    this.mDelay.connect(this.mFeedback);
    this.mFeedback.connect(this.mDelay);
    const delayOut = ctx.createGain();
    delayOut.gain.value = 0.5;
    this.mDelay.connect(delayOut);
    delayOut.connect(this.musicBus);
  }

  private static mDelay: DelayNode | null = null;
  private static mFeedback: GainNode | null = null;
  /** the repo's background track (Triumph in Motion.mp3) — menu anthem */
  private static musicEl: HTMLAudioElement | null = null;
  private static musicFileOk = false;

  /** Start the anthem (menu). Idempotent. File track first, procedural
   *  fallback if the file is missing or autoplay is blocked outright. */
  static musicStart(): void {
    if (this.musicPlaying) return;
    this.musicPlaying = true;
    // ---- 1. the repo track, FULL volume (player request) --------------------
    try {
      if (!this.musicEl) {
        // basePath-aware URL (GitHub Pages serves under /gmail/) — the
        // user's own track from the asset repo
        const base = (process.env.NEXT_PUBLIC_BASE_PATH ?? '').replace(/\/$/, '');
        const el = typeof Audio !== 'undefined' ? new Audio(`${base}/audio/TriumphInMotion.mp3`) : null;
        if (el) {
          el.loop = true;
          el.preload = 'auto';
          this.musicEl = el;
          el.addEventListener('canplaythrough', () => { this.musicFileOk = true; }, { once: true });
          el.addEventListener('error', () => { this.musicFileOk = false; }, { once: true });
        }
      }
      if (this.musicEl) {
        this.musicEl.volume = Math.min(1, Math.max(0.01, this.musicVol));
        this.musicEl.currentTime = this.musicEl.currentTime || 0;
        const p = this.musicEl.play();
        if (p) p.then(() => { this.musicFileOk = true; }).catch(() => {
          // autoplay refused → will start on the first user gesture
        });
      }
    } catch { /* fall through to procedural */ }
    // ---- 2. procedural layer underneath (silenced while the file plays) ----
    if (this.ctx && this.musicBus) {
      const t = this.ctx.currentTime;
      this.musicBus.gain.cancelScheduledValues(t);
      this.musicBus.gain.setTargetAtTime(this.musicFileOk ? 0 : 0.9, t, 0.4);
      this.musicStep = 0;
      this.musicNextT = t + 0.08;
      if (this.musicTimer) clearInterval(this.musicTimer);
      this.musicTimer = setInterval(() => this.musicTick(), 30);
    }
  }

  /** Stop the anthem with a quick fade (race start / option mute). */
  static musicStop(fadeSec = 0.4): void {
    // The file: PAUSE IMMEDIATELY. A fade via setInterval starves when the
    // session build blocks the main thread for a second+ (world + liveries),
    // and the music must NOT bleed into the race — the user asked for
    // "menu loud, race silent".
    if (this.musicEl && !this.musicEl.paused) {
      try {
        this.musicEl.pause();
        this.musicEl.volume = Math.min(1, Math.max(0.01, this.musicVol)); // ready for next menu visit
      } catch { /* element gone — nothing to stop */ }
    }
    if (!this.musicPlaying) return;
    this.musicPlaying = false;
    if (!this.ctx || !this.musicBus) return;
    if (this.musicTimer) { clearInterval(this.musicTimer); this.musicTimer = null; }
    const t = this.ctx.currentTime;
    this.musicBus.gain.cancelScheduledValues(t);
    this.musicBus.gain.setTargetAtTime(0, t, fadeSec / 3);
  }

  static get musicActive(): boolean { return this.musicPlaying; }

  /** QA/debug: live state of the audio rig (exposed via __apex.audio()). */
  static get debugState(): Record<string, unknown> {
    return {
      ctxState: this.ctx?.state ?? null,
      musicPlaying: this.musicPlaying,
      musicFileOk: this.musicFileOk,
      musicSrc: this.musicEl?.src ?? null,
      musicPaused: this.musicEl?.paused ?? null,
      musicVol: this.musicVol,
      engSampleReady: this.engSampleReady,
      engSampleRate: this.engSampleSrc?.playbackRate.value ?? null,
      engSampleGain: this.engSampleGain?.gain.value ?? null,
      engSampleFilterHz: this.engSampleFilter?.frequency.value ?? null,
    };
  }

  /** Scheduler tick: schedule every 16th whose time is within the window. */
  private static musicTick(): void {
    if (!this.ctx || !this.musicPlaying) return;
    const STEP = (60 / 126) / 4;           // 16th at 126 BPM
    const horizon = this.ctx.currentTime + 0.16;
    while (this.musicNextT < horizon) {
      if (!this.musicFileOk) this.scheduleStep(this.musicStep, this.musicNextT);
      this.musicStep++;
      this.musicNextT += STEP;
    }
  }

  // chords: root midi notes of Am, F, C, G (2 bars each = 32 steps per chord)
  private static readonly STEP16 = (60 / 126) / 4;
  private static readonly PROG = [57, 53, 48, 55];
  private static readonly ARP = [
    [0, 7, 12, 16, 19, 16, 12, 7],
    [0, 7, 12, 16, 19, 16, 12, 7],
    [0, 4, 7, 12, 16, 12, 7, 4],
    [0, 7, 11, 14, 19, 14, 11, 7],
  ];

  private static scheduleStep(step: number, t: number): void {
    const ctx = this.ctx!;
    const s16 = step % 16;                  // position in the bar
    const bar = Math.floor(step / 16);
    const chordIdx = Math.floor((bar % 8) / 2) % 4;   // 2 bars per chord
    const root = this.PROG[chordIdx];
    const section = Math.floor((step / 256)) % 2;    // A (drums+stab) / B (+arp)

    // ---- drums ------------------------------------------------------------
    if (s16 % 4 === 0) this.mKick(t);
    if (s16 === 4 || s16 === 12) this.mSnare(t);
    if (s16 % 2 === 1) this.mHat(t, s16 === 7 || s16 === 15 ? 0.4 : 0.22);
    // fill at the end of every 8 bars
    if (bar % 8 === 7 && s16 >= 12) this.mSnare(t, 0.4 + (s16 - 12) * 0.12);

    // ---- bass: driving 8ths (root octave down) ----------------------------
    if (s16 % 2 === 0) {
      this.mBass(t, root - 24, this.STEP16 * 1.8);
    }

    // ---- supersaw chord stab on the offbeats -------------------------------
    if (s16 === 2 || s16 === 6 || s16 === 10 || s16 === 14) {
      this.mStab(t, [root, root + 7, root + 12, root + 16]);
    }

    // ---- sustained pad at the start of every 2-bar chord -------------------
    if (step % 32 === 0) {
      this.mPad(t, [root, root + 7, root + 12, root + 16], this.STEP16 * 32);
    }

    // ---- arpeggio (section B — the driving hook) ---------------------------
    if (section === 1 && s16 % 2 === 0) {
      const notes = this.ARP[chordIdx];
      const note = root + 12 + notes[(s16 / 2) % 8];
      this.mPluck(t, note);
    }

    // ---- riser into each section change -------------------------------------
    if (step % 256 === 240 && s16 % 2 === 0) this.mRiser(t, 2);
  }

  private static mKick(t: number): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(148, t);
    o.frequency.exponentialRampToValueAtTime(44, t + 0.11);
    g.gain.setValueAtTime(0.9, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.24);
    o.connect(g); g.connect(this.musicBus!);
    o.start(t); o.stop(t + 0.26);
  }

  private static mSnare(t: number, gain = 0.5): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = 1.4;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass'; f.frequency.value = 1900; f.Q.value = 0.8;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
    src.connect(f); f.connect(g); g.connect(this.musicBus!);
    src.start(t, Math.random()); src.stop(t + 0.18);
  }

  private static mHat(t: number, gain: number): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = 3.2;
    const f = ctx.createBiquadFilter();
    f.type = 'highpass'; f.frequency.value = 8200;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    src.connect(f); f.connect(g); g.connect(this.musicBus!);
    src.start(t, Math.random()); src.stop(t + 0.06);
  }

  private static mBass(t: number, midi: number, dur: number): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    const o2 = ctx.createOscillator();
    o.type = 'sawtooth'; o2.type = 'square';
    const freq = 440 * Math.pow(2, (midi - 69) / 12);
    o.frequency.value = freq; o2.frequency.value = freq / 2;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.setValueAtTime(520, t);
    f.frequency.exponentialRampToValueAtTime(180, t + dur);
    f.Q.value = 6;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0, t);
    g.gain.linearRampToValueAtTime(0.42, t + 0.012);
    g.gain.setTargetAtTime(0.0, t + dur * 0.7, 0.05);
    o.connect(f); o2.connect(f); f.connect(g); g.connect(this.musicBus!);
    o.start(t); o2.start(t); o.stop(t + dur + 0.1); o2.stop(t + dur + 0.1);
  }

  private static mStab(t: number, chord: number[]): void {
    const ctx = this.ctx!;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0, t);
    g.gain.linearRampToValueAtTime(0.11, t + 0.015);
    g.gain.setTargetAtTime(0.0, t + 0.09, 0.045);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 2600; f.Q.value = 1;
    f.connect(g); g.connect(this.musicBus!);
    for (const midi of chord) {
      for (const det of [-7, 0, 7]) {           // supersaw width
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = 440 * Math.pow(2, (midi - 69) / 12);
        o.detune.value = det;
        o.connect(f);
        o.start(t); o.stop(t + 0.3);
      }
    }
  }

  private static mPad(t: number, chord: number[], dur: number): void {
    const ctx = this.ctx!;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0, t);
    g.gain.linearRampToValueAtTime(0.055, t + 0.6);
    g.gain.setTargetAtTime(0.0, t + dur * 0.8, 0.5);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(400, t);
    f.frequency.linearRampToValueAtTime(1500, t + dur * 0.5);
    f.frequency.linearRampToValueAtTime(500, t + dur);
    f.connect(g); g.connect(this.musicBus!);
    for (const midi of chord) {
      for (const det of [-5, 5]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = 440 * Math.pow(2, (midi - 69) / 12);
        o.detune.value = det;
        o.connect(f);
        o.start(t); o.stop(t + dur + 0.4);
      }
    }
  }

  private static mPluck(t: number, midi: number): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = 440 * Math.pow(2, (midi - 69) / 12);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.setValueAtTime(4200, t);
    f.frequency.exponentialRampToValueAtTime(900, t + 0.22);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0, t);
    g.gain.linearRampToValueAtTime(0.16, t + 0.008);
    g.gain.setTargetAtTime(0.0, t + 0.05, 0.06);
    o.connect(f); f.connect(g);
    g.connect(this.musicBus!);
    if (this.mDelay) g.connect(this.mDelay);   // echo
    o.start(t); o.stop(t + 0.4);
  }

  private static mRiser(t: number, dur: number): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass'; f.Q.value = 2;
    f.frequency.setValueAtTime(500, t);
    f.frequency.exponentialRampToValueAtTime(5200, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0, t);
    g.gain.linearRampToValueAtTime(0.13, t + dur * 0.9);
    g.gain.linearRampToValueAtTime(0.0, t + dur);
    src.connect(f); f.connect(g); g.connect(this.musicBus!);
    src.start(t); src.stop(t + dur + 0.05);
  }

  /** Ambience bed volume (crowd/wind character). */
  static setMusicVolume(v: number): void {
    this.musicVol = v;
    if (this.musicGain) this.musicGain.gain.value = v;
    if (this.musicEl) this.musicEl.volume = Math.min(1, Math.max(0, v));
    if (this.crowdGain && this.ctx) {
      this.crowdGain.gain.setTargetAtTime(0.018 * v * this.sfxVol, this.ctx.currentTime, 0.2);
    }
  }

  /** Compatibility with the HUD music button: mutes the anthem/file bus. */
  static get musicMuted(): boolean { return this.musicVol <= 0.001; }
  static toggleMusic(): boolean {
    this.musicVol = this.musicVol <= 0.001 ? 0.9 : 0;
    if (this.musicGain) this.musicGain.gain.value = this.musicVol;
    if (this.musicEl) {
      this.musicEl.volume = Math.min(1, Math.max(0, this.musicVol));
      if (this.musicVol > 0 && this.musicEl.paused && this.musicPlaying) void this.musicEl.play().catch(() => {});
      if (this.musicVol <= 0.001 && !this.musicEl.paused) this.musicEl.pause();
    }
    return !this.musicMuted;
  }
}
