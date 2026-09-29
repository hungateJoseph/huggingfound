import assert from "node:assert/strict";
import { test } from "node:test";
import { duration, estimate, guessSizeGb, measuredText, speedTier } from "../src/speed.js";

const m3 = { appleSilicon: true, cpu: "Apple M3", gpu: "Apple Silicon" };

test("speed tiers follow the hardware", () => {
  assert.equal(speedTier(m3), 1);
  assert.equal(speedTier({ appleSilicon: true, cpu: "Apple M4 Pro" }), 2);
  assert.equal(speedTier({ appleSilicon: true, cpu: "Apple M2 Max" }), 4);
  assert.equal(speedTier({ appleSilicon: false, gpu: "NVIDIA GeForce RTX 4070, 12282 MiB" }), 6);
  assert.equal(speedTier({ appleSilicon: false, gpu: "none detected" }), 0.25);
});

test("the image guess matches the measured SD 1.5 run on a plain M3", () => {
  const e = estimate({ runnerId: "sd", sizeGb: 1.64, fileName: "stable-diffusion-v1-5-pruned-emaonly-Q8_0.gguf", machine: m3 });
  assert.ok(e.seconds >= 100 && e.seconds <= 140, `got ${e.seconds}`);
  assert.match(e.text, /About 2 minutes per 512 by 512 image/);
  const turbo = estimate({ runnerId: "sd", sizeGb: 6.9, fileName: "sd_xl_turbo_1.0_fp16.safetensors", machine: m3 });
  assert.ok(turbo.seconds < e.seconds, "four turbo steps beat twenty plain ones");
});

test("chat and speech guesses scale with size and hardware", () => {
  const small = estimate({ runnerId: "ollama", sizeGb: 2, machine: m3 });
  const big = estimate({ runnerId: "ollama", sizeGb: 4.7, machine: m3 });
  assert.ok(small.tokensPerSecond > big.tokensPerSecond);
  assert.match(small.text, /About \d+ words a second; a short answer in/);
  const fast = estimate({ runnerId: "ollama", sizeGb: 4.7, machine: { appleSilicon: false, gpu: "NVIDIA RTX 4090" } });
  assert.ok(fast.tokensPerSecond > big.tokensPerSecond);
  const base = estimate({ runnerId: "whisper", sizeGb: 0.14, fileName: "ggml-base.en.bin", machine: m3 });
  assert.match(base.text, /About 4 seconds per minute of audio/);
  const large = estimate({ runnerId: "whisper", sizeGb: 3, machine: m3 });
  assert.ok(large.seconds > base.seconds);
  assert.equal(estimate({ runnerId: "ollama", sizeGb: null, machine: m3 }).seconds, null);
});

test("sizes are guessed from names when the file is not known yet", () => {
  assert.ok(Math.abs(guessSizeGb({ id: "bartowski/Qwen2.5-7B-Instruct-GGUF", runnerId: "ollama" }) - 4.2) < 0.01);
  assert.equal(guessSizeGb({ id: "x/whisper-small", runnerId: "whisper" }), 0.46);
  assert.equal(guessSizeGb({ id: "x/some-sdxl-model", runnerId: "sd" }), 6.9);
  assert.equal(guessSizeGb({ id: "x/no-size-in-name", runnerId: "ollama" }), null);
  assert.equal(guessSizeGb({ id: "x/y", runnerId: "ollama", gb: 3.3 }), 3.3);
});

test("durations and measured lines read naturally", () => {
  assert.equal(duration(45), "45 seconds");
  assert.equal(duration(90), "1.5 minutes");
  assert.equal(duration(300), "5 minutes");
  assert.equal(duration(900), "15 minutes");
  assert.equal(measuredText({ kind: "chat", tokensPerSecond: 40 }), "Measured here: 30 words a second");
  assert.equal(measuredText({ kind: "image", seconds: 139 }), "Measured here: 2.3 minutes per image");
  assert.equal(measuredText(null), "");
});
