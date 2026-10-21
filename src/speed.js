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

export function estimate({ runnerId, sizeGb, fileName = "", machine, xl = false, steps = null }) {
  const tier = speedTier(machine);
  if (!sizeGb) return { text: "Speed unknown until the file size is known", seconds: null };
  if (runnerId === "ollama") {
    const tokensPerSecond = Math.max(0.5, (tier * 100 * 0.6) / sizeGb);
    const short = Math.round(200 / tokensPerSecond);
    const words = Math.max(1, Math.round(tokensPerSecond * 0.75));
    return { text: `About ${words} word${words === 1 ? "" : "s"} a second; a short answer in ${duration(short)}`, seconds: short, tokensPerSecond };
  }
  if (runnerId === "sd") {
    const turbo = /turbo|lightning|lcm|hyper/i.test(fileName);
    const n = steps ?? (turbo ? 4 : 20);
    // Measured on a plain M3: 5.4 s a step for SD 1.5 at 512, 7.4 s a step
    // for SDXL at 768. Within a family the file size barely moves this.
    const isXl = xl || /xl/i.test(fileName);
    const perStep = (isXl && !turbo ? 7.4 : 5.4) / tier;
    const seconds = Math.round(n * perStep + 10);
    const side = isXl && !turbo ? 768 : 512;
    return { text: `About ${duration(seconds)} per ${side} by ${side} image${turbo ? " (a fast model: 4 steps)" : ""}, longer the first time`, seconds };
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

// How fast one data-centre card makes pictures and clips next to another,
// for the models HuggingFound runs on them (bf16 transformers; the cost is
// mostly matrix multiplies and attention). An L40S is 1. Rough figures
// from published throughput and people's timings; the point is to say
// when a bigger card is worth it for speed and not only for memory.
const GPU_SPEEDS = [
  [/\bB200\b/i, 4.2],
  [/\bB300\b/i, 4.6],
  [/\bH200\b/i, 3.2],
  [/\bH100\b/i, 2.8],
  [/RTX PRO 6000/i, 2.6],
  [/\bRTX 5090\b/i, 2.1],
  [/\bA100\b/i, 1.6],
  [/\bRTX 4090\b/i, 1.5],
  [/\bL40S\b/i, 1],
  [/\bL40\b/i, 0.85],
  [/\bA6000\b|RTX 6000 Ada/i, 0.9],
  [/\bA40\b/i, 0.7],
  [/\bRTX 3090\b/i, 0.65],
  [/\bA5000\b/i, 0.55],
  [/\bL4\b/i, 0.4],
  [/\bRTX A4500\b|\bA4000\b/i, 0.4],
];
export function gpuSpeed(name) {
  const hit = GPU_SPEEDS.find(([re]) => re.test(String(name ?? "")));
  return hit ? hit[1] : null;
}

// Among the cards on offer, the ones worth a word next to the one picked:
// meaningfully faster (a third or more), with how much faster and what
// that does to the price of a clip. Nothing when the picked card is the
// fastest known, or speeds are unknown.
export function fasterCards(picked, offers) {
  const base = gpuSpeed(picked?.gpu?.name);
  if (!base || !(picked?.pricePerHour > 0)) return [];
  const out = [];
  for (const o of offers) {
    if (o === picked || !(o.pricePerHour > 0)) continue;
    const s = gpuSpeed(o.gpu?.name);
    if (!s || s / base < 1.3) continue;
    const times = s / base;
    // What the same clip costs there, relative: price up, time down.
    const costRatio = (o.pricePerHour / picked.pricePerHour) / times;
    if (out.some((x) => x.gpu?.name === o.gpu?.name && x.provider === o.provider)) continue;
    out.push({ ...o, times: Math.round(times * 10) / 10, costRatio: Math.round(costRatio * 100) / 100 });
  }
  return out.sort((a, b) => b.times - a.times).slice(0, 3);
}
