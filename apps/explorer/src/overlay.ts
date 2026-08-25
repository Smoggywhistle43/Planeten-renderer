/**
 * The HUD. Acceptance criteria 5 and 6 are read off this, so it shows the two
 * numbers they name — node builds per frame against the budget, and frametime —
 * plus the precision figures that explain why the picture is stable.
 */

import {
  float32PrecisionAt,
  meanRadius as bodyMeanRadius,
  type Body,
  type Vec3d,
} from '@planet/core';
import type { DepthConfiguration, PlanetCamera, PlanetStats } from '@planet/render';

export interface OverlayInput {
  readonly body: Body;
  /** World position of the body's centre. */
  readonly bodyCenter: Vec3d;
  readonly camera: PlanetCamera;
  readonly stats: PlanetStats;
  readonly depth: DepthConfiguration;
  readonly budget: number;
  readonly errorThreshold: number;
  readonly altitude: number;
  readonly frameMs: number;
  readonly pixelRatio: number;
  readonly drawingBufferHeight: number;
  readonly flightRunning: boolean;
  /** Seconds past the epoch the body is posed for. */
  readonly simSeconds: number;
  /** Simulated seconds per real second. */
  readonly timeScale: number;
  /** Rotation angle of the body right now, radians. */
  readonly spinAngle: number;
  readonly heightScale: number;
  /** Exposure value at ISO 100 currently in use. */
  readonly ev100: number;
  /** The multiplier the scene luminance is scaled by. */
  readonly exposure: number;
  readonly toneMapper: string;
  /** Sunlight arriving at the body, lux. */
  readonly sunIlluminance: number;
  /** Brightest surface luminance the body can produce, cd/m^2. */
  readonly subsolarLuminance: number;
}

/** Rolling frametime window. 120 frames is about two seconds at 60 Hz. */
const WINDOW = 120;

export class Overlay {
  private readonly element: HTMLElement;
  private readonly samples: number[] = [];
  private worstBuildsPerFrame = 0;
  private budgetBreached = false;

  constructor(element: HTMLElement) {
    this.element = element;
  }

  /** Highest build count seen in any frame. Acceptance criterion 5. */
  get peakBuildsPerFrame(): number {
    return this.worstBuildsPerFrame;
  }

  get everExceededBudget(): boolean {
    return this.budgetBreached;
  }

  reset(): void {
    this.samples.length = 0;
    this.worstBuildsPerFrame = 0;
    this.budgetBreached = false;
  }

  update(input: OverlayInput): void {
    this.samples.push(input.frameMs);
    if (this.samples.length > WINDOW) this.samples.shift();

    if (input.stats.buildsStartedThisFrame > this.worstBuildsPerFrame) {
      this.worstBuildsPerFrame = input.stats.buildsStartedThisFrame;
    }
    if (input.stats.buildsStartedThisFrame > input.budget) this.budgetBreached = true;

    this.element.innerHTML = this.render(input);
  }

  private render(input: OverlayInput): string {
    const sorted = [...this.samples].sort((a, b) => a - b);
    const mean = this.samples.reduce((a, b) => a + b, 0) / Math.max(1, this.samples.length);
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;
    const fps = mean > 0 ? 1000 / mean : 0;

    const { stats, camera, body } = input;
    const originDrift = camera.frame.distanceFromOrigin(camera.position);
    const cameraDistance = camera.distanceFromCentre(input.bodyCenter);

    const budgetClass = this.budgetBreached ? 'bad' : 'ok';
    const fpsClass = fps >= 58 ? 'ok' : fps >= 30 ? 'warn' : 'bad';
    const depthClass = input.depth.reversedDepth ? 'ok' : 'bad';

    return [
      row(
        'body',
        `${body.id}  r=${sci(bodyMeanRadius(body))} m  f=1/${(1 / body.flattening).toFixed(0)}`,
      ),
      row('altitude', `${sci(input.altitude)} m${input.flightRunning ? '' : '  [pausiert]'}`),
      row(
        'drehung',
        `${degrees(input.spinAngle)}  Neigung ${degrees(body.axialTilt)}  ` +
          `Tag ${(Math.abs(body.rotationPeriod) / 3600).toFixed(2)} h` +
          `${body.rotationPeriod < 0 ? ' rückläufig' : ''}`,
      ),
      row('zeit', `${input.simSeconds.toFixed(1)} s   ${input.timeScale.toFixed(0)}x`),
      '',
      row(
        'frametime',
        span(fpsClass, `${mean.toFixed(2)} ms   ${fps.toFixed(1)} fps`) +
          `   p95 ${p95.toFixed(2)} ms`,
      ),
      row('viewport', `${input.drawingBufferHeight}px hoch  dpr ${input.pixelRatio.toFixed(2)}`),
      '',
      row(
        'builds/frame',
        span(budgetClass, `${stats.buildsStartedThisFrame} / ${input.budget}`) +
          `   Spitze ${this.worstBuildsPerFrame}` +
          (this.budgetBreached ? span('bad', '  BUDGET GERISSEN') : ''),
      ),
      // A peak on its own reads as "permanently at the ceiling". The duty
      // cycle is the number that says how often it is actually there.
      row(
        '  am Anschlag',
        `${stats.framesAtBudget} von ${stats.framesTotal} Frames (${(
          (100 * stats.framesAtBudget) /
          Math.max(1, stats.framesTotal)
        ).toFixed(1)} %)`,
      ),
      row(
        '  eingeschwungen',
        stats.framesSinceBuildActivity > 0
          ? span('ok', `seit ${stats.framesSinceBuildActivity} Frames ruhig`)
          : span('warn', 'baut gerade'),
      ),
      row('  offen', `${stats.buildsPending} laufend, ${stats.buildsDeferredThisFrame} zurückgestellt`),
      row('  gesamt', `${stats.buildsTotal} gebaut, ${stats.discardedBuilds} verworfen`),
      '',
      row('tiles', `${stats.selectedNodes} gezeichnet, ${stats.residentTiles} geladen`),
      row('dreiecke', `${(stats.triangles / 1000).toFixed(0)}k`),
      row('knoten', `${stats.residentNodes} im Baum, max Tiefe ${stats.maxSelectedDepth}`),
      row(
        'fehler',
        `${stats.maxSelectedErrorPixels.toFixed(2)} px  (Schwelle ${input.errorThreshold})`,
      ),
      '',
      row('rebases', `${stats.rebases}   Drift ${originDrift.toFixed(0)} m`),
      row('f32 @ kamera', `${float32PrecisionAt(cameraDistance).toExponential(1)} m absolut`),
      row('f32 @ tile', `${float32PrecisionAt(Math.max(1, input.altitude)).toExponential(1)} m relativ`),
      '',
      row(
        'tiefenpuffer',
        span(
          depthClass,
          `${input.depth.backend}  ${input.depth.reversedDepth ? 'reversed-Z' : 'STANDARD-Z'}`,
        ),
      ),
      row('  clear', `${input.depth.clearDepth}   compare ${input.depth.depthCompare}`),
      row('höhenfeld', input.heightScale === 0 ? 'aus (exakte Kugel)' : `x${input.heightScale}`),
      '',
      row('sonne', `${sci(input.sunIlluminance)} lx  (Beleuchtungsstärke)`),
      row('hellster punkt', `${sci(input.subsolarLuminance)} cd/m²`),
      row(
        'belichtung',
        `EV ${input.ev100.toFixed(2)}   x${input.exposure.toExponential(2)}   ${input.toneMapper}`,
      ),
      row(
        '  ergibt',
        `${(input.subsolarLuminance * input.exposure).toFixed(3)} vor dem Tonemapping`,
      ),
    ].join('\n');
  }
}

/** An angle in degrees, wrapped to 0..360. */
function degrees(radians: number): string {
  const deg = ((radians * 180) / Math.PI) % 360;
  return `${(deg < 0 ? deg + 360 : deg).toFixed(1)}\u00b0`;
}

function row(label: string, value: string): string {
  return `${label.padEnd(13)}${value}`;
}

function span(cls: string, text: string): string {
  return `<span class="${cls}">${text}</span>`;
}

/** Compact scientific notation, readable at a glance while numbers move. */
function sci(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const abs = Math.abs(value);
  if (abs === 0) return '0';
  if (abs >= 1e5 || abs < 1e-2) {
    const exponent = Math.floor(Math.log10(abs));
    const mantissa = value / 10 ** exponent;
    return `${mantissa.toFixed(3)}e${exponent}`;
  }
  return value.toFixed(abs < 10 ? 2 : 0);
}
