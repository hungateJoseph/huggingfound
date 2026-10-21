import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// The machine's Python side for MiniMax-H3 fine-tunes and LoRAs, checked on
// a tiny transformer with the real library: a ComfyUI-layout file (DaSiWa's
// kind: 8 bits with ConvRot, the curve form's time table) read back to the
// same outputs, and LoRAs in each spelling applied as if merged by hand.
// Needs torch, diffusers, peft and safetensors, so it runs when
// HF_TEST_PYTHON names a Python that has them, and is skipped otherwise.
const here = path.dirname(fileURLToPath(import.meta.url));
const python = process.env.HF_TEST_PYTHON;

for (const [name, script] of [["a ComfyUI-layout MiniMax-H3 transformer loads to the same outputs", "comfy_minimax_check.py"], ["LoRAs in each spelling apply as if merged by hand, several at once", "minimax_lora_check.py"], ["passes that barely change are skipped and the clip stays close; off again afterwards", "minimax_cache_check.py"], ["compiled blocks give the same clip, with skipping on top, and are set back; fp8 weights refused plainly without a card", "minimax_fast_check.py"]]) {
  test(name, { skip: python ? false : "set HF_TEST_PYTHON to a Python with torch, diffusers, peft and safetensors" }, () => {
    const out = spawnSync(python, [path.join(here, script)], { encoding: "utf8", timeout: 300000 });
    assert.equal(out.status, 0, `${out.stdout}\n${out.stderr}`.slice(-3000));
  });
}
