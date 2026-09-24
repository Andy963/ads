import { describe, expect, it } from "vitest";

import {
  computeVoiceWaveformFrame,
  createIdleVoiceWaveformLevels,
  VOICE_WAVEFORM_IDLE_LEVEL,
} from "./voiceWaveform";

describe("voice waveform mapping", () => {
  it("maps microphone energy into bounded responsive bar levels", () => {
    const loudSamples = new Uint8Array(256);
    for (let index = 0; index < loudSamples.length; index += 1) {
      loudSamples[index] = index % 2 === 0 ? 220 : 36;
    }

    let loudFrame = computeVoiceWaveformFrame(loudSamples);
    for (let index = 0; index < 6; index += 1) {
      loudFrame = computeVoiceWaveformFrame(loudSamples, loudFrame.amplitude);
    }

    expect(loudFrame.levels).toHaveLength(18);
    expect(Math.max(...loudFrame.levels)).toBeGreaterThan(0.8);
    expect(Math.min(...loudFrame.levels)).toBeGreaterThanOrEqual(VOICE_WAVEFORM_IDLE_LEVEL);
    expect(Math.max(...loudFrame.levels)).toBeLessThanOrEqual(1);
  });

  it("decays silence toward the baseline", () => {
    const silence = new Uint8Array(256).fill(128);
    let frame = computeVoiceWaveformFrame(silence, 0.95);

    for (let index = 0; index < 40; index += 1) {
      frame = computeVoiceWaveformFrame(silence, frame.amplitude);
    }

    expect(frame.amplitude).toBeLessThan(0.15);
    expect(frame.amplitude).toBeGreaterThan(VOICE_WAVEFORM_IDLE_LEVEL);
  });

  it("creates a deterministic baseline envelope", () => {
    expect(createIdleVoiceWaveformLevels()).toEqual(
      Array.from({ length: 18 }, () => VOICE_WAVEFORM_IDLE_LEVEL),
    );
  });
});
