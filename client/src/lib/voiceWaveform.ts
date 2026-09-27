export const VOICE_WAVEFORM_BAR_COUNT = 36;
export const VOICE_WAVEFORM_IDLE_LEVEL = 0.12;
export const VOICE_WAVEFORM_SAMPLE_INTERVAL_MS = 95;
export const VOICE_WAVEFORM_FADE_BAR_COUNT = 10;
export const VOICE_WAVEFORM_MIN_OPACITY = 0.25;

const ENVELOPE_ATTACK = 0.55;
const ENVELOPE_RELEASE = 0.18;
const NOISE_FLOOR_RISE_RATE = 0.03;
const PEAK_DECAY_RATE = 0.995;
const MIN_DYNAMIC_RANGE = 0.01;
const NOISE_HEADROOM = 1.25;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

export function createIdleVoiceWaveformLevels(
  barCount = VOICE_WAVEFORM_BAR_COUNT,
): number[] {
  return Array.from({ length: Math.max(1, Math.floor(barCount)) }, () => VOICE_WAVEFORM_IDLE_LEVEL);
}

export function pushVoiceWaveformLevel(
  levels: ReadonlyArray<number>,
  newLevel: number,
  barCount = VOICE_WAVEFORM_BAR_COUNT,
): number[] {
  const count = Math.max(1, Math.floor(barCount));
  const retained = levels.slice(-(count - 1)).map((level) => clamp(finiteOr(Number(level), VOICE_WAVEFORM_IDLE_LEVEL), 0, 1));
  const missing = count - 1 - retained.length;
  const padded =
    missing > 0 ? [...Array.from({ length: missing }, () => VOICE_WAVEFORM_IDLE_LEVEL), ...retained] : retained;
  return [...padded, clamp(finiteOr(Number(newLevel), VOICE_WAVEFORM_IDLE_LEVEL), 0, 1)];
}

export function computeVoiceWaveformRms(samples: ArrayLike<number>): number {
  const sampleCount = samples.length;
  if (sampleCount <= 0) return 0;
  let sumSquares = 0;
  for (let index = 0; index < sampleCount; index += 1) {
    const centered = (Number(samples[index] ?? 128) - 128) / 128;
    sumSquares += centered * centered;
  }
  return Math.sqrt(sumSquares / sampleCount);
}

export class VoiceWaveformEnvelope {
  private noiseFloor = 0;
  private peak = MIN_DYNAMIC_RANGE;
  private level = VOICE_WAVEFORM_IDLE_LEVEL;

  reset(): void {
    this.noiseFloor = 0;
    this.peak = MIN_DYNAMIC_RANGE;
    this.level = VOICE_WAVEFORM_IDLE_LEVEL;
  }

  push(rawAmplitude: number): number {
    const raw = clamp(finiteOr(Number(rawAmplitude), 0), 0, 1);

    if (raw < this.noiseFloor) {
      this.noiseFloor = raw;
    } else {
      this.noiseFloor += (raw - this.noiseFloor) * NOISE_FLOOR_RISE_RATE;
    }

    if (raw > this.peak) {
      this.peak = raw;
    } else {
      this.peak = Math.max(this.noiseFloor + MIN_DYNAMIC_RANGE, this.peak * PEAK_DECAY_RATE);
    }

    const range = Math.max(this.peak - this.noiseFloor, MIN_DYNAMIC_RANGE);
    const gated = Math.max(0, raw - this.noiseFloor * NOISE_HEADROOM);
    const normalized = clamp(gated / range, 0, 1);
    const target = VOICE_WAVEFORM_IDLE_LEVEL + normalized * (1 - VOICE_WAVEFORM_IDLE_LEVEL);
    const rate = target > this.level ? ENVELOPE_ATTACK : ENVELOPE_RELEASE;
    this.level += (target - this.level) * rate;
    return this.level;
  }
}

export function voiceWaveformBarOpacity(
  index: number,
  barCount = VOICE_WAVEFORM_BAR_COUNT,
): number {
  const count = Math.max(1, Math.floor(barCount));
  const fadeCount = Math.min(VOICE_WAVEFORM_FADE_BAR_COUNT, count);
  const position = clamp(Math.floor(finiteOr(Number(index), 0)), 0, count - 1);
  if (position >= fadeCount) return 1;
  if (fadeCount <= 1) return 1;
  const progress = position / (fadeCount - 1);
  return VOICE_WAVEFORM_MIN_OPACITY + (1 - VOICE_WAVEFORM_MIN_OPACITY) * progress;
}
