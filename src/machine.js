import { execFileSync } from "node:child_process";
import os from "node:os";

// What this computer can run. Memory is the deciding factor for local
// models: a model has to fit in RAM (or unified memory on Apple Silicon)
// with some headroom, and the GPU decides how fast it goes.

export function describeMachine() {
  const totalGb = os.totalmem() / 1024 ** 3;
  const cpu = os.cpus()[0]?.model ?? "unknown CPU";
  const platform = os.platform();
  const arch = os.arch();
  const appleSilicon = platform === "darwin" && arch === "arm64";
  let gpu = appleSilicon ? "Apple Silicon (unified memory, Metal)" : "none detected";
  if (!appleSilicon) {
    try {
      const out = execFileSync("nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader"], { encoding: "utf8", timeout: 3000 });
      gpu = out.trim().split("\n")[0];
    } catch {
      // no NVIDIA tools on the path; the CPU will do the work
    }
  }
  return {
    platform,
    arch,
    os: platformName(platform),
    cpu,
    cores: os.cpus().length,
    ramGb: Math.round(totalGb),
    gpu,
    appleSilicon,
    // The size of model file this machine can load with headroom for the
    // system and the runner. Unified memory makes Apple Silicon generous.
    comfortableGb: Math.max(1, Math.round((appleSilicon ? 0.7 : 0.55) * totalGb)),
  };
}

export function platformName(platform) {
  return { darwin: "macOS", win32: "Windows", linux: "Linux" }[platform] ?? platform;
}

// How a model of `sizeGb` fits on a machine with `comfortableGb` to spare.
export function fitFor(sizeGb, machine) {
  if (!sizeGb) return { level: "unknown", text: "Size unknown until scanned" };
  if (sizeGb <= machine.comfortableGb * 0.6) return { level: "good", text: `Fits easily (${sizeGb.toFixed(1)} GB)` };
  if (sizeGb <= machine.comfortableGb) return { level: "tight", text: `Fits, close other apps (${sizeGb.toFixed(1)} GB)` };
  return { level: "no", text: `Too big for this machine (${sizeGb.toFixed(1)} GB, room for about ${machine.comfortableGb} GB)` };
}
