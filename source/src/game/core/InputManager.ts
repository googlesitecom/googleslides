/**
 * APEX GP — Input: keyboard + gamepad, F1 control scheme.
 *
 *  W/↑ throttle · S/↓ brake · A/D/←→ steer
 *  X shift up · Z shift down (manual gearbox)
 *  E DRS · Q look back · C camera · ESC pause
 * Pads: RT/LT drive, left stick steer, A shift↑, X shift↓, B DRS, Y back, start pause.
 */

import type { F1Controls } from './Types';

export type Action =
  | 'accelerate' | 'brake' | 'steerLeft' | 'steerRight'
  | 'shiftUp' | 'shiftDown' | 'drs' | 'lookBack' | 'camera' | 'pit' | 'pause';

export interface Binding {
  code: string;
  action: Action;
  label: string;
}

export const DEFAULT_BINDINGS: Binding[] = [
  { code: 'ArrowUp', action: 'accelerate', label: 'W / ↑' },
  { code: 'KeyW', action: 'accelerate', label: 'W / ↑' },
  { code: 'ArrowDown', action: 'brake', label: 'S / ↓' },
  { code: 'KeyS', action: 'brake', label: 'S / ↓' },
  { code: 'ArrowLeft', action: 'steerLeft', label: 'A / ←' },
  { code: 'KeyA', action: 'steerLeft', label: 'A / ←' },
  { code: 'ArrowRight', action: 'steerRight', label: 'D / →' },
  { code: 'KeyD', action: 'steerRight', label: 'D / →' },
  { code: 'KeyX', action: 'shiftUp', label: 'X — shift up' },
  { code: 'KeyZ', action: 'shiftDown', label: 'Z — shift down' },
  { code: 'KeyE', action: 'drs', label: 'E — DRS' },
  { code: 'KeyQ', action: 'lookBack', label: 'Q — mirar atrás' },
  { code: 'KeyC', action: 'camera', label: 'C — cámara' },
  { code: 'KeyP', action: 'pit', label: 'P — pits' },
  { code: 'Escape', action: 'pause', label: 'ESC' },
  { code: 'Enter', action: 'pause', label: 'ESC / ENTER' },
];

const PAD_BUTTONS: Partial<Record<number, Action>> = {
  0: 'shiftUp',     // A / cross
  1: 'drs',         // B / circle
  2: 'shiftDown',   // X / square
  3: 'lookBack',    // Y / triangle
  9: 'pause',       // start
};

export class InputManager {
  private down = new Set<string>();
  private bindings: Binding[] = DEFAULT_BINDINGS.map(b => ({ ...b }));
  private gamepadIndex: number | null = null;
  private padAxes = { steer: 0, throttle: 0, brake: 0 };

  public pausePressed = false;
  public pitPressed = false;
  public cameraPressed = false;
  public shiftUpPressed = false;
  public shiftDownPressed = false;
  private prevPause = false;
  private prevPit = false;
  private prevCamera = false;
  private prevShiftUp = false;
  private prevShiftDown = false;

  private onKey = (e: KeyboardEvent, isDown: boolean): void => {
    if (e.repeat) return;
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
    if (isDown) this.down.add(e.code); else this.down.delete(e.code);
  };
  private kd = (e: KeyboardEvent): void => this.onKey(e, true);
  private ku = (e: KeyboardEvent): void => this.onKey(e, false);
  private onBlur = (): void => { this.down.clear(); };
  private padConnect = (e: GamepadEvent): void => { this.gamepadIndex = e.gamepad.index; };
  private padDisconnect = (): void => {
    this.gamepadIndex = null;
    this.padAxes = { steer: 0, throttle: 0, brake: 0 };
    for (const code of [...this.down]) if (code.startsWith('pad:')) this.down.delete(code);
  };

  attach(): void {
    window.addEventListener('keydown', this.kd, { passive: false });
    window.addEventListener('keyup', this.ku);
    window.addEventListener('blur', this.onBlur);
    window.addEventListener('gamepadconnected', this.padConnect as EventListener);
    window.addEventListener('gamepaddisconnected', this.padDisconnect as EventListener);
  }

  detach(): void {
    window.removeEventListener('keydown', this.kd);
    window.removeEventListener('keyup', this.ku);
    window.removeEventListener('blur', this.onBlur);
    window.removeEventListener('gamepadconnected', this.padConnect as EventListener);
    window.removeEventListener('gamepaddisconnected', this.padDisconnect as EventListener);
    this.down.clear();
  }

  setBindings(b: Binding[]): void { this.bindings = b.map(x => ({ ...x })); }
  getBindings(): Binding[] { return this.bindings.map(b => ({ ...b })); }
  rebind(action: Action, code: string): void {
    const existing = this.bindings.find(b => b.action === action);
    if (existing) existing.code = code;
  }

  isDown(action: Action): boolean {
    for (const b of this.bindings) if (b.action === action && this.down.has(b.code)) return true;
    return false;
  }

  /** Once per rendered frame BEFORE physics substeps: pad merge + edges. */
  poll(): void {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const pad = this.gamepadIndex != null ? pads[this.gamepadIndex] : (pads.find(p => p && p.connected) || null);
    let steer = 0, throttle = 0, brake = 0;
    if (pad) {
      const ax = pad.axes[0] ?? 0;
      if (Math.abs(ax) > 0.1) steer = ax;
      throttle = pad.buttons[7]?.value ?? 0;
      brake = pad.buttons[6]?.value ?? 0;
      for (const [btn, act] of Object.entries(PAD_BUTTONS)) {
        const pressed = (pad.buttons[+btn]?.value ?? 0) > 0.5;
        const code = `pad:${btn}`;
        if (pressed) this.down.add(code); else this.down.delete(code);
        if (act === undefined) continue;
        void act;
      }
      // pad edge actions handled via the down-set like keys
    }
    this.padAxes = { steer, throttle, brake };

    const pauseDown = this.isDown('pause');
    const camDown = this.isDown('camera');
    const pitDown = this.isDown('pit');
    const upDown = this.isDown('shiftUp');
    const downDown = this.isDown('shiftDown');
    this.pausePressed = pauseDown && !this.prevPause;
    this.cameraPressed = camDown && !this.prevCamera;
    this.pitPressed = pitDown && !this.prevPit;
    this.shiftUpPressed = upDown && !this.prevShiftUp;
    this.shiftDownPressed = downDown && !this.prevShiftDown;
    this.prevPause = pauseDown;
    this.prevCamera = camDown;
    this.prevPit = pitDown;
    this.prevShiftUp = upDown;
    this.prevShiftDown = downDown;
  }

  /** Player controls for the current frame. */
  readControls(): F1Controls {
    const kSteer = (this.isDown('steerRight') ? 1 : 0) - (this.isDown('steerLeft') ? 1 : 0);
    const str = Math.abs(this.padAxes.steer) > Math.abs(kSteer) ? this.padAxes.steer : kSteer;
    return {
      throttle: Math.max(this.isDown('accelerate') ? 1 : 0, this.padAxes.throttle),
      brake: Math.max(this.isDown('brake') ? 1 : 0, this.padAxes.brake),
      steer: Math.max(-1, Math.min(1, str)),
      drs: this.isDown('drs'),
      shiftUp: this.shiftUpPressed,
      shiftDown: this.shiftDownPressed,
      lookBack: this.isDown('lookBack'),
    };
  }
}
