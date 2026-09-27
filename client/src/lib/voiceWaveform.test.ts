import { describe, expect, it } from "vitest";

import {
  computeVoiceWaveformRms,
  createIdleVoiceWaveformLevels,
  pushVoiceWaveformLevel,
  VoiceWaveformEnvelope,
  voiceWaveformBarOpacity,
  VOICE_WAVEFORM_BAR_COUNT,
  VOICE_WAVEFORM_FADE_BAR_COUNT,
  VOICE_WAVEFORM_IDLE_LEVEL,
  VOICE_WAVEFORM_MIN_OPACITY,
} from "./voiceWaveform";

function loudSamples(value = 220): Uint8Array {
  const samples = new Uint8Array(256);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = index % 2 === 0 ? value : 256 - value;
  }
  return samples;
}

describe("voice waveform idle levels", () => {
  it("creates a deterministic idle buffer of 36 bars", () => {
    expect(VOICE_WAVEFORM_BAR_COUNT).toBe(36);
    expect(createIdleVoiceWaveformLevels()).toEqual(
      Array.from({ length: VOICE_WAVEFORM_BAR_COUNT }, () => VOICE_WAVEFORM_IDLE_LEVEL),
    );
  });
});

describe("pushVoiceWaveformLevel", () => {
  it("appends new samples on the right and shifts older samples left", () => {
    const idle = createIdleVoiceWaveformLevels(4);
    const once = pushVoiceWaveformLevel(idle, 0.9, 4);
    expect(once).toEqual([VOICE_WAVEFORM_IDLE_LEVEL, VOICE_WAVEFORM_IDLE_LEVEL, VOICE_WAVEFORM_IDLE_LEVEL, 0.9]);
    const twice = pushVoiceWaveformLevel(once, 0.5, 4);
    expect(twice).toEqual([VOICE_WAVEFORM_IDLE_LEVEL, VOICE_WAVEFORM_IDLE_LEVEL, 0.9, 0.5]);
  });

  it("drops the oldest sample once the window is full (FIFO)", () => {
    let levels = createIdleVoiceWaveformLevels(4);
    for (const level of [0.2, 0.4, 0.6, 0.8, 1]) {
      levels = pushVoiceWaveformLevel(levels, level, 4);
    }
    expect(levels).toEqual([0.4, 0.6, 0.8, 1]);
    expect(levels).toHaveLength(4);
  });

  it("clamps incoming levels into the 0..1 range", () => {
    const levels = pushVoiceWaveformLevel(createIdleVoiceWaveformLevels(2), 7, 2);
    expect(levels[1]).toBe(1);
    const negative = pushVoiceWaveformLevel(createIdleVoiceWaveformLevels(2), -3, 2);
    expect(negative[1]).toBe(0);
  });
});

describe("computeVoiceWaveformRms", () => {
  it("returns 0 for digital silence and a high value for loud input", () => {
    const silence = new Uint8Array(256).fill(128);
    expect(computeVoiceWaveformRms(silence)).toBe(0);
    expect(computeVoiceWaveformRms(loudSamples())).toBeGreaterThan(0.5);
  });
});

describe("VoiceWaveformEnvelope", () => {
  it("keeps silence at the idle level", () => {
    const envelope = new VoiceWaveformEnvelope();
    let level = 1;
    for (let index = 0; index < 30; index += 1) {
      level = envelope.push(0);
    }
    expect(level).toBeLessThanOrEqual(VOICE_WAVEFORM_IDLE_LEVEL + 0.01);
  });

  it("rises quickly on loud input and stays clamped to 1", () => {
    const envelope = new VoiceWaveformEnvelope();
    let level = envelope.push(0.9);
    expect(level).toBeGreaterThan(0.5);
    for (let index = 0; index < 20; index += 1) {
      level = envelope.push(0.9);
    }
    expect(level).toBeLessThanOrEqual(1);
    expect(level).toBeGreaterThan(VOICE_WAVEFORM_IDLE_LEVEL);
  });

  it("reaches near full scale for speech bursts above the noise floor", () => {
    const envelope = new VoiceWaveformEnvelope();
    for (let index = 0; index < 300; index += 1) {
      envelope.push(0.02);
    }
    let level = 0;
    for (let index = 0; index < 8; index += 1) {
      level = envelope.push(0.3);
    }
    expect(level).toBeGreaterThan(0.8);
  });

  it("adapts to steady background noise so it no longer pins the waveform", () => {
    const envelope = new VoiceWaveformEnvelope();
    let level = 0;
    for (let index = 0; index < 400; index += 1) {
      level = envelope.push(0.05);
    }
    expect(level).toBeLessThan(VOICE_WAVEFORM_IDLE_LEVEL + 0.1);
  });

  it("normalizes speech across quiet and loud microphone input levels", () => {
    const quietMic = new VoiceWaveformEnvelope();
    for (let index = 0; index < 300; index += 1) {
      quietMic.push(0.02);
    }
    let quietSpeech = 0;
    for (let index = 0; index < 10; index += 1) {
      quietSpeech = quietMic.push(0.09);
    }

    const loudMic = new VoiceWaveformEnvelope();
    for (let index = 0; index < 300; index += 1) {
      loudMic.push(0.2);
    }
    let loudSpeech = 0;
    for (let index = 0; index < 10; index += 1) {
      loudSpeech = loudMic.push(0.9);
    }

    expect(quietSpeech).toBeGreaterThan(0.6);
    expect(loudSpeech).toBeGreaterThan(0.6);
    expect(loudSpeech).toBeLessThanOrEqual(1);
    expect(Math.abs(quietSpeech - loudSpeech)).toBeLessThan(0.35);
  });

  it("reset restores the idle baseline", () => {
    const envelope = new VoiceWaveformEnvelope();
    for (let index = 0; index < 20; index += 1) {
      envelope.push(0.9);
    }
    envelope.reset();
    let level = 1;
    for (let index = 0; index < 30; index += 1) {
      level = envelope.push(0);
    }
    expect(level).toBeLessThanOrEqual(VOICE_WAVEFORM_IDLE_LEVEL + 0.01);
  });
});

describe("voiceWaveformBarOpacity", () => {
  it("fades the leftmost bars and keeps the rest fully opaque", () => {
    expect(voiceWaveformBarOpacity(0)).toBeCloseTo(VOICE_WAVEFORM_MIN_OPACITY);
    expect(voiceWaveformBarOpacity(VOICE_WAVEFORM_FADE_BAR_COUNT - 1)).toBeCloseTo(1);
    expect(voiceWaveformBarOpacity(VOICE_WAVEFORM_FADE_BAR_COUNT)).toBe(1);
    expect(voiceWaveformBarOpacity(VOICE_WAVEFORM_BAR_COUNT - 1)).toBe(1);
    for (let index = 1; index < VOICE_WAVEFORM_FADE_BAR_COUNT; index += 1) {
      expect(voiceWaveformBarOpacity(index)).toBeGreaterThan(voiceWaveformBarOpacity(index - 1));
    }
  });
});
