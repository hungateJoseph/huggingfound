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

// What the hosted site assumes about the visitor's computer: a typical
// 16 GB laptop with no separate GPU. The fit and speed lines say so.
export function hostedMachine() {
  return { platform: "any", arch: "any", os: "a typical laptop", cpu: "", cores: 8, ramGb: 16, gpu: "no separate GPU", appleSilicon: false, comfortableGb: 9, hosted: true };
}

// The machine chat models run on when a chat server is set: a GPU box
// whose memory the user told us, since Ollama does not report hardware.
export function chatServerMachine(url, gpuGb) {
  const gb = Number(gpuGb) > 0 ? Number(gpuGb) : 24;
  return { platform: "linux", arch: "x64", os: "the chat server", cpu: "", cores: 8, ramGb: gb, gpu: `NVIDIA GPU, ${gb} GB (chat server)`, appleSilicon: false, comfortableGb: Math.max(1, Math.floor(gb * 0.9)), remote: url, gpuGb: gb };
}

export function platformName(platform) {
  return { darwin: "macOS", win32: "Windows", linux: "Linux" }[platform] ?? platform;
}

// How a model of `sizeGb` fits on a machine with `comfortableGb` to spare.
export function fitFor(sizeGb, machine) {
  if (!sizeGb) return { level: "unknown", text: "Size unknown until scanned" };
  if (machine.remote) {
    if (sizeGb <= machine.comfortableGb * 0.8) return { level: "good", text: `Fits the server's ${machine.gpuGb} GB GPU (${sizeGb.toFixed(1)} GB)` };
    if (sizeGb <= machine.comfortableGb) return { level: "tight", text: `A tight fit on the server's ${machine.gpuGb} GB GPU (${sizeGb.toFixed(1)} GB)` };
    return { level: "no", text: `Too big for the server's ${machine.gpuGb} GB GPU (${sizeGb.toFixed(1)} GB)` };
  }
  if (machine.hosted) {
    if (sizeGb <= machine.comfortableGb * 0.6) return { level: "good", text: `Runs on a 16 GB laptop (${sizeGb.toFixed(1)} GB)` };
    if (sizeGb <= machine.comfortableGb) return { level: "tight", text: `Needs 16 GB of memory with other apps closed (${sizeGb.toFixed(1)} GB)` };
    return { level: "no", text: `Needs 32 GB of memory or a big GPU (${sizeGb.toFixed(1)} GB)` };
  }
  if (sizeGb <= machine.comfortableGb * 0.6) return { level: "good", text: `Fits easily (${sizeGb.toFixed(1)} GB)` };
  if (sizeGb <= machine.comfortableGb) return { level: "tight", text: `Fits, close other apps (${sizeGb.toFixed(1)} GB)` };
  return { level: "no", text: `Too big for this machine (${sizeGb.toFixed(1)} GB, room for about ${machine.comfortableGb} GB)` };
}
