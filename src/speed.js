import { paramSize } from "./categorize.js";

// Rough guesses at how long a model takes to do its job on this computer.
// They come from a handful of measured runs (Stable Diffusion 1.5 at 8 bits
// took 5.4 s per step on a plain M3; a 2 GB chat model streams about 30
// tokens a second there) scaled by model size and by how much faster or
// slower the graphics hardware is. They are only meant to set expectations;
// a measured time from a real run replaces them once there is one.

// How this machine compares with a plain Apple M-series chip.
export function speedTier(machine) {
  if (machine.appleSilicon) {
    const cpu = machine.cpu ?? "";
    if (/ultra/i.test(cpu)) return 8;
    if (/max/i.test(cpu)) return 4;
    if (/pro/i.test(cpu)) return 2;
    return 1;
  }
  if (/nvidia|geforce|rtx|quadro|tesla/i.test(machine.gpu ?? "")) return 6;
  return 0.25;
}

// The file size to reason about when the real one is not known yet: a
// 4-bit chat model is about 0.6 GB per billion parameters.
export function guessSizeGb({ id, runnerId, gb }) {
  if (gb) return gb;
  const name = id.split("/").pop() ?? "";
  if (runnerId === "whisper") {
    if (/tiny/i.test(name)) return 0.075;
    if (/base/i.test(name)) return 0.14;
    if (/small/i.test(name)) return 0.46;
    if (/medium/i.test(name)) return 1.5;
    return 3;
  }
  if (runnerId === "sd") return /xl|sdxl/i.test(name) ? 6.9 : 2;
  const params = paramSize(id);
  if (params) return parseFloat(params) * 0.6;
  return null;
}

export function estimate({ runnerId, sizeGb, fileName = "", machine, xl = false }) {
  const tier = speedTier(machine);
  if (!sizeGb) return { text: "Speed unknown until the file size is known", seconds: null };
  if (runnerId === "ollama") {
    const tokensPerSecond = Math.max(0.5, (tier * 100 * 0.6) / sizeGb);
    const short = Math.round(200 / tokensPerSecond);
    const words = Math.max(1, Math.round(tokensPerSecond * 0.75));
    return { text: `About ${words} word${words === 1 ? "" : "s"} a second; a short answer in ${duration(short)}`, seconds: short, tokensPerSecond };
  }
  if (runnerId === "sd") {
    const turbo = /turbo|lightning|lcm/i.test(fileName);
    const steps = turbo ? 4 : 20;
    // Measured on a plain M3: 5.4 s a step for SD 1.5 at 512, 7.4 s a step
    // for SDXL at 768. Within a family the file size barely moves this.
    const isXl = xl || /xl/i.test(fileName);
    const perStep = (isXl && !turbo ? 7.4 : 5.4) / tier;
    const seconds = Math.round(steps * perStep + 10);
    const side = isXl && !turbo ? 768 : 512;
    return { text: `About ${duration(seconds)} per ${side} by ${side} image, longer the first time`, seconds };
  }
  if (runnerId === "whisper") {
    const perMinute = Math.max(1, Math.round((4 * (sizeGb / 0.14)) / Math.max(1, tier)));
    return { text: `About ${duration(perMinute)} per minute of audio`, seconds: perMinute };
  }
  return { text: "", seconds: null };
}

export function duration(seconds) {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} second${Math.round(seconds) === 1 ? "" : "s"}`;
  const minutes = seconds / 60;
  if (minutes < 10) return `${minutes.toFixed(1).replace(/\.0$/, "")} minute${minutes < 1.05 ? "" : "s"}`;
  return `${Math.round(minutes)} minutes`;
}

// A sentence for a real run that already happened on this computer.
export function measuredText(measured) {
  if (!measured) return "";
  if (measured.kind === "chat" && measured.tokensPerSecond) return `Measured here: ${Math.round(measured.tokensPerSecond * 0.75)} words a second`;
  if (measured.kind === "image") return `Measured here: ${duration(measured.seconds)} per image`;
  if (measured.kind === "transcribe") return `Measured here: ${duration(measured.seconds)} for the last recording`;
  return "";
}
