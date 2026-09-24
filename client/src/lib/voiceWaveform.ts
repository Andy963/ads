export const VOICE_WAVEFORM_BAR_COUNT = 18;
export const VOICE_WAVEFORM_IDLE_LEVEL = 0.12;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function createIdleVoiceWaveformLevels(
  barCount = VOICE_WAVEFORM_BAR_COUNT,
): number[] {
  return Array.from({ length: Math.max(1, Math.floor(barCount)) }, () => VOICE_WAVEFORM_IDLE_LEVEL);
}

export function computeVoiceWaveformFrame(
  samples: ArrayLike<number>,
  previousAmplitude = VOICE_WAVEFORM_IDLE_LEVEL,
  barCount = VOICE_WAVEFORM_BAR_COUNT,
): { amplitude: number; levels: number[] } {
  const sampleCount = Math.max(1, samples.length);
  let sumSquares = 0;
  for (let index = 0; index < sampleCount; index += 1) {
    const centered = (Number(samples[index] ?? 128) - 128) / 128;
    sumSquares += centered * centered;
  }

  const rms = Math.sqrt(sumSquares / sampleCount);
  const normalized = clamp((rms - 0.015) * 4.5, 0, 1);
  const target = VOICE_WAVEFORM_IDLE_LEVEL + normalized * (1 - VOICE_WAVEFORM_IDLE_LEVEL);
  const previous = clamp(Number(previousAmplitude), 0, 1);
  const smoothing = target > previous ? 0.45 : 0.12;
  const amplitude = previous + (target - previous) * smoothing;
  const count = Math.max(1, Math.floor(barCount));
  const levels = Array.from({ length: count }, (_, index) => {
    const variation = 0.82 + 0.18 * Math.sin((index + 1) * 1.17);
    return clamp(
      VOICE_WAVEFORM_IDLE_LEVEL + (amplitude - VOICE_WAVEFORM_IDLE_LEVEL) * variation,
      VOICE_WAVEFORM_IDLE_LEVEL,
      1,
    );
  });

  return { amplitude, levels };
}
