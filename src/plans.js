import { chooseFile, quantTag, repoFiles } from "./hf.js";
import { fitFor, platformName } from "./machine.js";
import { imageSettings } from "./runners.js";
import { estimate, measuredText } from "./speed.js";
import { isAddon } from "./quality.js";
import { videoLoraBase } from "./categorize.js";

// Turns "I want to try this model" into the ordered steps this computer
// needs, with the ones already done marked so the page can skip them.
// Each step names a kind from runners.js; the page never sends commands.

export function buildPlan({ model, files, machine, detected, hasToken, preferredFile, timings = {}, imageServer = null, twin = null }) {
  const runner = model.runner;
  if (!runner) return { runnable: false, reason: "This kind of model has no local runner in HuggingFound yet.", steps: [] };
  if (isAddon(model.name) && (runner.id === "sd" || runner.id === "diffusers")) return addonPlan({ model, files, detected });
  if (runner.id === "diffusers") return diffusersPlan({ model, files, machine, detected, hasToken, twin });
  if (!runner.easy) {
    return {
      runnable: false,
      reason: `${model.name} is published for ${runner.name}, which needs a Python setup. HuggingFound runs models that come as single files for Ollama, whisper.cpp or stable-diffusion.cpp. Look for a version of this model tagged GGUF, or pick one from the Easy to set up list.`,
      steps: [],
      link: `https://huggingface.co/models?search=${encodeURIComponent(model.name.replace(/-GGUF/i, ""))}%20gguf`,
    };
  }
  const file = (preferredFile && files.find((f) => f.name === preferredFile)) || chooseFile(files, runner.id);
  if (!file && isAddon(model.name)) {
    return {
      runnable: false,
      addon: true,
      reason: `${model.name} is an add-on, not a model: a piece that changes how a base model such as Stable Diffusion 1.5 or SDXL draws (a LoRA, an adapter, a VAE). It makes nothing by itself, and HuggingFound does not apply add-ons yet. Pick a full model from the Easy to set up list, or one that says Makes images.`,
      steps: [],
      link: model.url,
    };
  }
  if (!file) {
    return {
      runnable: false,
      reason: `${model.name} has no single checkpoint file to download; it is stored in the folder layout Python libraries use. Look for a GGUF or single-file version, or pick one from the Easy to set up list.`,
      steps: [],
      link: `https://huggingface.co/models?search=${encodeURIComponent(model.name)}%20gguf`,
    };
  }
  if (model.gated && !hasToken) {
    return {
      runnable: false,
      gated: true,
      reason: `${model.name} is gated: its licence has to be accepted on Hugging Face, and downloads need a token. Add a read token in Settings after accepting the licence on the model page, and this plan unlocks.`,
      steps: [],
      link: model.url,
    };
  }

  const fit = fitFor(file.gb, machine);
  const speed = estimate({ runnerId: runner.id, sizeGb: file.gb, fileName: file.name, machine, xl: file.xl });
  // A diffusers folder ends up merged into one checkpoint named after the model.
  const mergedName = file.folder ? `${model.name.replace(/[^\w.-]/g, "-")}.safetensors` : null;
  const downloaded = detected.models.includes(`${model.id}/${mergedName ?? file.name}`);
  const steps = [];
  const os = machine.hosted ? "your system" : platformName(machine.platform);

  if (runner.id === "ollama") {
    const quant = quantTag(file.name);
    const viaPull = !model.gated && quant;
    const localName = model.name.toLowerCase().replace(/-gguf$/i, "").replace(/[^a-z0-9.-]/g, "-");
    const ollamaName = viaPull ? `hf.co/${model.id}:${quant}` : localName;
    // On a chat server the only step is the download, done by the server.
    if (detected.ollama.remote) {
      if (!viaPull) {
        return {
          runnable: false,
          reason: `${model.name} cannot be fetched by the chat server directly${model.gated ? " because it is gated" : ""}. Models that Ollama can pull straight from Hugging Face work there; this one would have to be downloaded on this computer. Clear the chat server in Settings to run it here.`,
          steps: [],
          link: model.url,
        };
      }
      const done = detected.ollama.models.some((m) => m.toLowerCase() === ollamaName.toLowerCase());
      steps.push({
        kind: "pull-model",
        args: { name: ollamaName },
        title: `Download the model on the chat server (${file.gb ? file.gb.toFixed(1) + " GB" : "size unknown"})`,
        text: `The server fetches the ${quant} version of ${model.name} straight from Hugging Face; nothing is downloaded to this computer. ${fit.text}.${detected.ollama.running ? "" : ` ${serverDownNote(detected.ollama.rented)}`}`,
        done,
        command: `ollama pull ${ollamaName}`,
      });
      return { runnable: true, runner: runner.id, file, fit, speed, measured: measuredText(timings[ollamaName] ?? null), steps, remote: detected.ollama.remote, tryWith: { kind: "chat", model: ollamaName }, remove: [{ kind: "ollama", name: ollamaName }] };
    }
    steps.push({
      kind: "install-ollama",
      title: "Install Ollama",
      text: `Ollama is the program that runs chat models on your computer. ${installNote("ollama", machine, detected)}`,
      done: detected.ollama.installed,
      command: displayCommand("install-ollama", machine),
    });
    steps.push({
      kind: "start-ollama",
      title: "Start Ollama",
      text: "Ollama runs in the background and answers on this computer only.",
      done: detected.ollama.running,
      command: "ollama serve",
    });
    if (viaPull) {
      steps.push({
        kind: "pull-model",
        args: { name: ollamaName },
        title: `Download the model (${file.gb ? file.gb.toFixed(1) + " GB" : "size unknown"})`,
        text: `Ollama fetches the ${quant} version of ${model.name} straight from Hugging Face. ${fit.text}.`,
        done: detected.ollama.models.some((m) => m.toLowerCase() === ollamaName.toLowerCase()),
        command: `ollama pull ${ollamaName}`,
      });
    } else {
      steps.push({
        kind: "download-file",
        args: { repo: model.id, file: file.name },
        title: `Download ${file.name} (${file.gb ? file.gb.toFixed(1) + " GB" : "size unknown"})`,
        text: `${model.gated ? "Uses your Hugging Face token because the model is gated. " : ""}${fit.text}.`,
        done: downloaded,
        command: `download to ~/HuggingFound/models/${model.id}/${file.name}`,
      });
      steps.push({
        kind: "create-model",
        args: { repo: model.id, file: file.name, name: localName },
        title: "Register it with Ollama",
        text: "Tells Ollama where the file is so it can load it by name.",
        done: detected.ollama.models.some((m) => m.startsWith(localName)),
        command: `ollama create ${localName} -f Modelfile`,
      });
    }
    const remove = viaPull ? [{ kind: "ollama", name: ollamaName }] : [{ kind: "ollama", name: localName }, { kind: "file", repo: model.id, file: file.name }];
    const measured = timings[ollamaName] ?? null;
    return { runnable: true, runner: runner.id, file, fit, speed, measured: measuredText(measured), steps, tryWith: { kind: "chat", model: ollamaName }, remove };
  }

  if (runner.id === "whisper") {
    steps.push({
      kind: "install-whisper",
      title: "Install whisper.cpp",
      text: `The program that turns recordings into text. ${installNote("whisper", machine, detected)}`,
      done: detected.whisper.installed,
      command: displayCommand("install-whisper", machine),
    });
    steps.push({
      kind: "download-file",
      args: { repo: model.id, file: file.name },
      title: `Download ${file.name} (${file.gb ? file.gb.toFixed(2) + " GB" : "size unknown"})`,
      text: `${fit.text}. Bigger Whisper models are more accurate and slower.`,
      done: downloaded,
      command: `download to ~/HuggingFound/models/${model.id}/${file.name}`,
    });
    return { runnable: true, runner: runner.id, file, fit, speed, measured: measuredText(timings[`${model.id}/${file.name}`]), steps, tryWith: { kind: "transcribe", repo: model.id, file: file.name, ffmpeg: detected.ffmpeg }, remove: [{ kind: "file", repo: model.id, file: file.name }] };
  }

  if (runner.id === "sd") {
    const fast = /turbo|lightning|lcm|hyper/i.test(`${model.id}/${file.name}`);
    const style = imageStyle(model);
    // Each preset carries the settings a picture is made with, so a machine
    // elsewhere (the rented GPU's agent) can be asked for exactly the same.
    const qualities = Object.fromEntries(["fast", "default", "max"].map((q) => {
      const n = fast ? (q === "max" ? 8 : 4) : { fast: 12, default: 20, max: 40 }[q];
      const s = imageSettings(q, { fast, xl: Boolean(file.xl || /xl/i.test(file.name)) });
      return [q, { steps: n, size: s.size, cfg: s.cfg, sampler: s.samplerName, scheduler: s.schedulerName, ...estimate({ runnerId: "sd", sizeGb: file.gb, fileName: file.name, machine, xl: file.xl, steps: n }) }];
    }));
    // On the rented GPU the only step is the download, done by the machine;
    // pictures are then made there, asked for by the browser itself, in a
    // card's time rather than this computer's.
    if (detected.gpu?.url) {
      for (const q of Object.values(qualities)) q.seconds = gpuSeconds({ width: q.size, height: q.size, steps: q.steps });
      if (model.gated && !hasToken) {
        return { runnable: false, gated: true, reason: `${model.name} is gated: accept its licence on Hugging Face and add a read token in Settings, and the rented GPU fetches it with that token.`, steps: [], link: model.url };
      }
      // A folder-layout model: the machine fetches the parts and merges
      // them into one checkpoint, as this computer would.
      if (file.folder) {
        const stale = staleMachine(model, detected.gpu, "pull-image-folder", "folder-layout models could be merged there");
        if (stale) return stale;
        const done = detected.gpu.files.includes(`${model.id}/${mergedName}`);
        // The parts and the checkpoint merged from them share the disk for a while.
        const room = done ? null : diskRoom(detected.gpu, model, (file.gb || 0) * 2);
        if (room) return room;
        steps.push({
          kind: "pull-image-folder",
          args: { repo: model.id, files: file.parts.map((part) => ({ from: part.from, to: part.to })), into: mergedName },
          title: `Download the model's ${file.parts.length} files on the rented GPU and merge them (${file.gb ? file.gb.toFixed(1) + " GB" : "size unknown"})`,
          text: `The machine fetches the parts (the image network, the text encoders and the decoder) straight from Hugging Face onto its own disk and merges them into one checkpoint; nothing comes to this computer. ${fit.text}.${detected.gpu.running ? "" : ` ${serverDownNote(detected.gpu.rented)}`}`,
          done,
          command: `download ${file.parts.map((part) => part.from).join(", ")} onto the rented GPU and merge into ${mergedName}`,
        });
        return { runnable: true, runner: runner.id, file, fit, speed, measured: "", steps, qualities, fast, style, remote: detected.gpu.url, tryWith: { kind: "image", repo: model.id, file: mergedName, agent: detected.gpu.url }, remove: [{ kind: "gpu-file", repo: model.id, file: mergedName }] };
      }
      const key = `${model.id}/${file.name}`;
      const done = detected.gpu.files.includes(key);
      const room = done ? null : diskRoom(detected.gpu, model, file.gb || 0);
      if (room) return room;
      steps.push({
        kind: "pull-image-model",
        args: { repo: model.id, file: file.name },
        title: `Download the model on the rented GPU (${file.gb ? file.gb.toFixed(1) + " GB" : "size unknown"})`,
        text: `The machine fetches ${file.name} straight from Hugging Face onto its own disk; nothing comes to this computer. ${fit.text}.${detected.gpu.running ? "" : ` ${serverDownNote(detected.gpu.rented)}`}`,
        done,
        command: `download ${file.name} onto the rented GPU`,
      });
      return { runnable: true, runner: runner.id, file, fit, speed, measured: "", steps, qualities, fast, style, remote: detected.gpu.url, tryWith: { kind: "image", repo: model.id, file: file.name, agent: detected.gpu.url }, remove: [{ kind: "gpu-file", repo: model.id, file: file.name }] };
    }
    // With a remote image server nothing is downloaded here; the server
    // makes the picture with whatever model it has loaded.
    if (imageServer) {
      return {
        runnable: true,
        runner: runner.id,
        file,
        fit: { level: "good", text: "Made on the image server" },
        speed: { text: `Made by the image server at ${imageServer.url}${imageServer.model ? `, which has ${imageServer.model} loaded` : ""}`, seconds: null },
        measured: "",
        steps: [],
        qualities,
        remote: imageServer.url,
        tryWith: { kind: "image", repo: model.id, file: file.folder ? mergedName : file.name, remote: imageServer.url },
        remove: [],
      };
    }
    steps.push({
      kind: "install-sd",
      title: "Install stable-diffusion.cpp",
      text: `The program that turns a description into an image. HuggingFound downloads the ready-made build for ${os}${machine.platform === "win32" ? "." : ", and builds it from source if that build does not run on this version."}`,
      done: detected.sd.installed,
      command: machine.platform === "win32" ? "download the latest release from github.com/leejet/stable-diffusion.cpp" : "download the latest release from github.com/leejet/stable-diffusion.cpp, or build it with CMake",
    });
    if (file.folder) {
      steps.push({
        kind: "download-files",
        args: { repo: model.id, files: file.parts.map((part) => ({ from: part.from, to: part.to })), convert: "diffusers", into: mergedName },
        title: `Download the model's ${file.parts.length} files and merge them (${file.gb ? file.gb.toFixed(1) + " GB" : "size unknown"})`,
        text: `${fit.text}. This model is published as separate parts (the image network, the text encoders and the decoder). HuggingFound downloads them and merges them into one checkpoint file, the form stable-diffusion.cpp loads; the parts are removed afterwards. ${file.xl ? "An SDXL model: pictures come out at 768 by 768 and take several minutes each on a laptop." : "A 512 by 512 picture takes one to a few minutes on a laptop, longer the first time."}`,
        done: downloaded,
        command: `download ${file.parts.map((part) => part.from).join(", ")} and merge into ~/HuggingFound/models/${model.id}/${mergedName}`,
      });
      return { runnable: true, runner: runner.id, file, fit, speed, measured: measuredText(timings[`${model.id}/${mergedName}`]), steps, qualities, fast, style, keepsLoaded: detected.sd.server, tryWith: { kind: "image", repo: model.id, file: mergedName }, remove: [{ kind: "folder", repo: model.id }] };
    }
    steps.push({
      kind: "download-file",
      args: { repo: model.id, file: file.name },
      title: `Download ${file.name} (${file.gb ? file.gb.toFixed(1) + " GB" : "size unknown"})`,
      text: `${fit.text}. Image models are large; a 512 by 512 picture takes one to a few minutes on a laptop, longer the first time while the graphics shaders compile.`,
      done: downloaded,
      command: `download to ~/HuggingFound/models/${model.id}/${file.name}`,
    });
    return { runnable: true, runner: runner.id, file, fit, speed, measured: measuredText(timings[`${model.id}/${file.name}`]), steps, qualities, fast, style, keepsLoaded: detected.sd.server, tryWith: { kind: "image", repo: model.id, file: file.name }, remove: [{ kind: "file", repo: model.id, file: file.name }] };
  }

  return { runnable: false, reason: "Unsupported runner.", steps: [] };
}

// The agent on a rented machine grows with the app; a machine rented
// before a feature runs an older image. Each feature names the version it
// needs, and a plan for an older machine says to replace it.
export const AGENT_NEEDS = { "pull-image-folder": 2, "pull-image-repo": 3, "pull-addon": 4, "pull-lora": 19 };
// The version a machine needs to be current. Image 24 only adds the
// Cloudflare tunnels a Vast.ai machine opens (and a Vast.ai machine always
// runs the newest image), so a version 23 machine at RunPod is not told
// to be replaced for it.
export const AGENT_VERSION = 23;

function staleMachine(model, gpu, kind, what) {
  const have = gpu.version ?? null;
  if (!gpu.running || have == null || have >= AGENT_NEEDS[kind]) return null;
  return {
    runnable: false,
    staleMachine: true,
    reason: `Your rented machine runs an older HuggingFound image (version ${have}) from before ${what}. Replace the machine and the new one comes up with the current image; models downloaded onto the old one are fetched again.`,
    steps: [],
    link: model.url,
  };
}

// An add-on (an IP-Adapter, a LoRA) is applied on the rented GPU to a base
// model that is already there: the machine fetches the add-on's files and
// its Python side loads the base with the add-on on top. An IP-Adapter
// steers the picture with a reference image; a LoRA changes the style.
export function addonVariants(files, videoBase = null) {
  const names = files.map((f) => f.name);
  const weights = files.filter((f) => /\.(bin|safetensors)$/i.test(f.name) && !/image_encoder/i.test(f.name) && !/\.safetensors\.index\.json$/i.test(f.name));
  // A LoRA for a video model: its weights, applied to that model's transformer.
  if (videoBase) {
    // A file of several GB is a whole transformer (a fine-tune), not a
    // LoRA: it is used from the base model's window, not applied as one.
    const variants = weights.filter((f) => /\.safetensors$/i.test(f.name) && !/^(media|images?|assets?|examples?|samples?)\//i.test(f.name) && !((f.gb ?? 0) > 4)).map((f) => {
      const stem = f.name.replace(/\.safetensors$/i, "");
      return { file: f.name, lora: null, xl: false, gb: f.gb ?? 0, label: stem.split("/").pop().replace(/[-_]/g, " "), faceid: false };
    });
    return { kind: "video-lora", variants, encoders: [] };
  }
  const ip = weights.filter((f) => /ip[-_]?adapter/i.test(f.name) && !/_lora\.safetensors$/i.test(f.name));
  const kind = ip.length ? "ip-adapter" : "lora";
  const pool = kind === "ip-adapter" ? ip : weights.filter((f) => /lora|lycoris/i.test(f.name) || /\.safetensors$/i.test(f.name));
  // Where a file comes as .bin and .safetensors, one copy is enough.
  const seen = new Set();
  const variants = [];
  for (const f of pool.sort((a, b) => (/\.safetensors$/i.test(a.name) ? -1 : 1) - (/\.safetensors$/i.test(b.name) ? -1 : 1))) {
    const stem = f.name.replace(/\.(bin|safetensors)$/i, "");
    if (seen.has(stem)) continue;
    seen.add(stem);
    const lora = kind === "ip-adapter" ? names.find((n) => n === `${stem}_lora.safetensors`) ?? null : null;
    const xl = /sdxl|xl/i.test(stem);
    const label = stem.split("/").pop().replace(/^ip[-_]?adapter[-_]?/i, "").replace(/[-_]/g, " ") || stem;
    variants.push({ file: f.name, lora, xl, gb: (f.gb ?? 0) + (lora ? files.find((x) => x.name === lora)?.gb ?? 0 : 0), label: `${label} (${xl ? "SDXL" : "SD 1.5"})`, faceid: /faceid/i.test(stem) });
  }
  const encoders = files.filter((f) => /image_encoder\/(config\.json|model\.safetensors)$/i.test(f.name)).map((f) => f.name);
  return { kind, variants, encoders };
}

function addonPlan({ model, files, detected }) {
  const videoBase = videoLoraBase(model);
  const { kind, variants, encoders } = addonVariants(files, videoBase);
  const baseName = videoBase ? videoBase.split("/").pop() : null;
  const what = kind === "video-lora" ? `a LoRA for ${baseName}: it changes how that video model moves, frames or styles a clip` : kind === "ip-adapter" ? "an IP-Adapter: it steers a base model's picture with a reference image (a face, a style, a subject)" : "a LoRA: it changes how a base model draws";
  if (!variants.length) {
    // A fine-tuned version of a video model, in a repository of its own.
    if (videoBase && files.some((f) => /\.safetensors$/i.test(f.name) && (f.gb ?? 0) > 4)) {
      return { runnable: false, addon: true, reason: `${model.name} is a fine-tuned version of ${baseName}: a whole transformer used in place of the model's own. Open ${baseName}, and under "LoRAs and fine-tunes" in its window look for it and add it to the machine.`, steps: [], link: `https://huggingface.co/${videoBase}` };
    }
    return { runnable: false, addon: true, reason: `${model.name} is an add-on with no weights HuggingFound recognises. It makes nothing by itself.`, steps: [], link: model.url };
  }
  if (!detected.gpu?.url) {
    return {
      runnable: false,
      addon: true,
      needsGpu: true,
      reason: `${model.name} is ${what}. Add-ons are applied on a rented GPU, to ${kind === "video-lora" ? `${baseName} downloaded there` : "a Stable Diffusion 1.5 or SDXL model downloaded there"}. Rent one by the hour and the machine does the rest.`,
      steps: [],
      link: model.url,
    };
  }
  // A LoRA is set through the peft library, which machines before image 19 lacked.
  const stale = staleMachine(model, detected.gpu, kind === "ip-adapter" ? "pull-addon" : "pull-lora", kind === "ip-adapter" ? "add-ons could be applied there" : "LoRAs could be set there");
  if (stale) return stale;
  const download = [...variants.map((v) => v.file), ...variants.map((v) => v.lora).filter(Boolean), ...encoders];
  const have = new Set(detected.gpu.addons ?? []);
  const done = download.every((f) => have.has(`${model.id}/${f}`));
  const gb = variants.reduce((t, v) => t + v.gb, 0) + encoders.reduce((t, n) => t + (files.find((f) => f.name === n)?.gb ?? 0), 0);
  // Bases: the checkpoints and Stable Diffusion folders already on the
  // machine; for a video LoRA, the one model it was made for, when there.
  const bases = (detected.gpu.files ?? [])
    .filter((key) => (kind === "video-lora" ? key === `${videoBase}/model_index.json` : /\.(safetensors|ckpt)$/i.test(key) || key.endsWith("/model_index.json")))
    .map((key) => {
      const i = key.indexOf("/", key.indexOf("/") + 1);
      const repo = key.slice(0, i);
      const file = key.slice(i + 1);
      return { repo, file, xl: /xl/i.test(key), label: `${repo.split("/").pop()}${file === "model_index.json" ? "" : ` (${file})`}` };
    });
  const steps = [{
    kind: "pull-addon",
    args: { repo: model.id, files: download },
    title: `Download the add-on on the rented GPU (${gb ? gb.toFixed(1) + " GB" : "size unknown"})`,
    text: `The machine fetches ${model.name}'s ${download.length} file${download.length === 1 ? "" : "s"} straight from Hugging Face; nothing comes to this computer.${detected.gpu.running ? "" : ` ${serverDownNote(detected.gpu.rented)}`}`,
    done,
    command: `download ${download.length} files of ${model.id} onto the rented GPU`,
  }];
  const qualities = kind === "video-lora" ? withGpuSeconds(MINIMAX_QUALITIES(5), 134) : {
    fast: { steps: 15, size: 512, cfg: 6, text: "fewer steps" },
    default: { steps: 25, size: 512, cfg: 6, text: "the standard settings" },
    max: { steps: 40, size: 512, cfg: 6, text: "more steps" },
  };
  // A video LoRA's clips: the base's lengths and canvases, from three
  // seconds (the orbit LoRA was trained on 73 frames). One trained on a
  // first and last frame (an orbit back to its start) wants a starting
  // picture and ends on it unless another is given.
  const tags = (model.tags ?? []).map((t) => String(t).toLowerCase());
  const firstLast = kind === "video-lora" && tags.some((t) => /flf2v|first-last|orbit|360/.test(t));
  const video = kind === "video-lora" ? { ...minimaxSpec(134, 5), minSeconds: 3, defaultSeconds: 3 } : null;
  return {
    runnable: true,
    runner: "addon",
    addon: true,
    file: { name: `${variants.length} variant${variants.length === 1 ? "" : "s"}`, gb: gb || null, variants: variants.length },
    fit: { level: "good", text: `${what.split(":")[0]}` },
    speed: { text: bases.length ? `Applied to ${kind === "video-lora" ? baseName : "a base model"} on the rented GPU${kind === "video-lora" ? "" : `; ${bases.length} there now`}.` : kind === "video-lora" ? `Needs ${baseName} on the rented GPU first: open it and download it there.` : "Needs a Stable Diffusion 1.5 or SDXL model on the rented GPU first: download one there from the Easy to set up list.", seconds: null },
    measured: "",
    steps,
    qualities,
    ...(video ? { video } : {}),
    fast: false,
    style: null,
    remote: detected.gpu.url,
    tryWith: { kind: kind === "video-lora" ? "video" : "image", engine: "addon", addonKind: kind, repo: model.id, agent: detected.gpu.url, variants, bases, ...(kind === "video-lora" ? { base: videoBase, startPicture: firstLast ? "required" : "optional", lastPicture: firstLast ? "same" : "none", triggerPrompt: model.triggerPrompt ?? null, strength: 1 } : {}) },
    remove: download.map((f) => ({ kind: "gpu-addon", repo: model.id, file: f })),
  };
}

// A model only the diffusers library loads (FLUX, Qwen-Image, Wan and the
// other folder-layout families, video included): it runs on a rented GPU,
// where the machine fetches the folder and its Python side makes the
// pictures or clips. Nothing on a person's own computer loads these.
function diffusersPlan({ model, files, machine, detected, hasToken = false, twin = null }) {
  const repo = repoFiles(files);
  const video = /video/.test(model.pipeline ?? "") || (model.tags ?? []).some((t) => /video/.test(t));
  const what = video ? "clips" : "pictures";
  // LTX-2 and 2.5 (Lightricks): clips with sound at 24 fps from a plain
  // pipeline, 8n + 1 frames on a canvas of multiples of 32. The repository
  // carries a modular index as well, but the pipeline that loads is the
  // plain one, so the model is placed whole on the card, never in turns.
  const ltx = /ltx-2/i.test(model.id);
  const modular = Boolean(repo?.modular) && !ltx;
  if (!repo) {
    // The same model is often published twice: once as pieces for ComfyUI
    // and once in the folder the diffusers library loads. The folder runs.
    if (twin) {
      return {
        runnable: false,
        twin,
        reason: `${model.name} is published here as loose pieces for other tools. The same model in the layout the rented GPU runs is ${twin.name}; open it and it runs there.`,
        steps: [],
        link: model.url,
      };
    }
    return {
      runnable: false,
      reason: `${model.name} is published as loose pieces (quantised or split weights without the folder the diffusers library loads), which have to be assembled by hand. Look for the model's diffusers version, usually the maker's own repository or one whose name ends in -Diffusers.`,
      steps: [],
      link: `https://huggingface.co/models?search=${encodeURIComponent(model.name.replace(/-?gguf/i, ""))}%20diffusers`,
    };
  }
  if (!detected.gpu?.url) {
    return {
      runnable: false,
      needsGpu: true,
      reason: `${model.name} runs only on a rented GPU: it is loaded by the diffusers library, which nothing on a laptop runs well${repo.gb ? `, and its ${repo.gb.toFixed(0)} GB of weights want a data-centre card${repo.gb > 60 ? (modular ? " (its models take turns on a card smaller than all of them together)" : ltx ? " (it wants a card with room for all of it at once)" : " (it loads at 8 bits on a card with room for about half of that, or in full precision across several cards)") : ""}` : ""}. Rent one by the hour and the machine fetches the model and makes ${what} there.`,
      steps: [],
      link: model.url,
      file: repo,
      tierGb: recommendedGb(repo.gb, modular, ltx),
      diskGb: diskFor(repo.gb),
    };
  }
  if (model.gated && !hasToken) {
    return { runnable: false, gated: true, reason: `${model.name} is gated: its licence has to be accepted on Hugging Face, and the rented GPU needs your Hugging Face read token to fetch it. Accept the licence on the model page, add the token in Settings, and this plan unlocks.`, steps: [], link: model.url };
  }
  const stale = staleMachine(model, detected.gpu, "pull-image-repo", "this family could run there");
  if (stale) return stale;
  const fit = diffusersFit(repo.gb, machine, modular);
  // Whole when every file is there: an agent that lists a folder's files
  // tells a download that stopped partway from a finished model.
  const have = detected.gpu.folders?.[model.id] ?? null;
  const done = have ? repo.files.every((f) => have.includes(f.from)) : detected.gpu.files.includes(`${model.id}/model_index.json`);
  if (!done) {
    const left = have ? repo.files.filter((f) => !have.includes(f.from)).reduce((a, f) => a + (f.gb || 0), 0) : repo.gb;
    const room = diskRoom(detected.gpu, model, left);
    if (room) return room;
  }
  const fast = /turbo|lightning|schnell|distill|hyper|rapid|fast|step/i.test(model.id);
  const cfg = /flux/i.test(model.id) ? 3.5 : /qwen/i.test(model.id) ? 4 : ltx ? 3 : 5;
  // MiniMax-H3 makes clips with sound of 5 to 15 seconds at 24 fps, in
  // frame counts of 17n + 5 on a canvas of multiples of 32 with a 768
  // short edge; smaller canvases are its biggest speed lever.
  const minimax = /minimax-h3/i.test(model.id);
  // What a clip can be, for the page to pick a length and a quality from
  // and guess the time: frames a second, the lengths the model makes, the
  // frame counts its video VAE decodes, and three levels of steps and size.
  // The three levels differ in kind, not only in passes. Low is a draft on
  // a small canvas. Medium is the full canvas the model was trained for,
  // with the family's standard avoid list, which these models were tuned
  // with. High adds passes, and has the description expanded first into
  // the detailed shot these models do best with (by Claude, with a key).
  // A model draws no better above its trained canvas, so none goes higher.
  const levelText = LEVEL_TEXT;
  // LTX-2.5's distilled transformer runs a fixed schedule of eight passes
  // whatever is asked, so its levels differ by canvas and by the expansion.
  const ltxText = { low: "fast draft, 768 by 512", medium: "720p", high: "720p, words expanded" };
  const videoSpec = video ? (ltx
    ? { fps: 24, minSeconds: 2, maxSeconds: 10, defaultSeconds: 5, frameStep: 8, frameAdd: 1, sound: true, cfg, heavy: heavyFactor(repo.gb), avoid: VIDEO_AVOID, levels: { low: { steps: 8, width: 768, height: 512, text: ltxText.low }, medium: { steps: 8, width: 1280, height: 704, text: ltxText.medium }, high: { steps: 8, width: 1280, height: 704, expand: true, text: ltxText.high } } }
    : minimax
    ? minimaxSpec(repo.gb, cfg)
    : { fps: 16, minSeconds: 1, maxSeconds: 5, defaultSeconds: 3, frameStep: 4, frameAdd: 1, sound: false, cfg, heavy: heavyFactor(repo.gb), avoid: VIDEO_AVOID, levels: { low: { steps: 20, width: 832, height: 480, text: levelText.low }, medium: { steps: 30, width: 1280, height: 704, text: levelText.medium }, high: { steps: 50, width: 1280, height: 704, expand: true, text: levelText.high } } }) : null;
  const qualities = withGpuSeconds(video
    ? ltx
      ? {
          fast: { steps: 8, width: 768, height: 512, frames: 121, fps: 24, cfg, text: "a 5-second clip with sound at 768 by 512" },
          default: { steps: 8, width: 1280, height: 704, frames: 121, fps: 24, cfg, text: "a 5-second clip with sound at 720p" },
          max: { steps: 8, width: 1280, height: 704, frames: 241, fps: 24, cfg, text: "a 10-second clip with sound at 720p, many minutes" },
        }
      : minimax
      ? MINIMAX_QUALITIES(cfg)
      : {
        fast: { steps: 20, width: 832, height: 480, frames: 33, fps: 16, cfg, text: "a 2-second clip at 480p" },
        default: { steps: 30, width: 832, height: 480, frames: 49, fps: 16, cfg, text: "a 3-second clip at 480p" },
        max: { steps: 40, width: 1280, height: 704, frames: 81, fps: 16, cfg, text: "a 5-second clip at 720p, many minutes" },
      }
    : {
        fast: { steps: fast ? 4 : 12, size: 768, width: 768, height: 768, cfg, text: "768 by 768, fewer steps" },
        default: { steps: fast ? 4 : 28, size: 1024, width: 1024, height: 1024, cfg, text: "1024 by 1024" },
        max: { steps: fast ? 8 : 40, size: 1024, width: 1024, height: 1024, cfg, expand: true, text: "1024 by 1024, more steps, your words expanded first into a detailed description" },
      }, repo.gb);
  const steps = [{
    kind: "pull-image-repo",
    args: { repo: model.id, files: repo.files.map((f) => f.from), gb: repo.gb || 0 },
    title: `Download the model's ${repo.files.length} files on the rented GPU (${repo.gb ? repo.gb.toFixed(1) + " GB" : "size unknown"})`,
    text: `The machine fetches the model's folder straight from Hugging Face onto its own disk${model.gated ? ", with your Hugging Face token since the model is gated" : ""}; nothing comes to this computer. ${fit.text}.${detected.gpu.running ? "" : ` ${serverDownNote(detected.gpu.rented)}`}`,
    done,
    command: `download ${repo.files.length} files of ${model.id} onto the rented GPU`,
  }];
  // The reference-to-video part (MiniMax-H3's second transformer, 62 GB):
  // a step of its own, for clips made from reference pictures of the
  // people and things to show; the model works without it.
  const referenceDone = repo.reference ? Boolean(have) && repo.reference.files.every((f) => have.includes(f.from)) : null;
  // Room for it, said where it is offered: the model stays usable without it.
  const referenceRoom = repo.reference && !referenceDone && done ? diskRoom(detected.gpu, model, repo.reference.gb) : null;
  if (repo.reference) {
    steps.push({
      kind: "pull-image-repo",
      // The model's index goes with it: the machine takes a folder download
      // only with its index, and skips the one already there.
      args: { repo: model.id, files: ["model_index.json", ...repo.reference.files.map((f) => f.from)], gb: repo.reference.gb || 0 },
      title: `Add clips from reference pictures (${repo.reference.gb.toFixed(1)} GB more)`,
      text: "Optional. Make a clip from up to nine photos of the people and things in it. Switching between this and ordinary clips reloads the model, a few minutes.",
      ...(referenceRoom ? { growTo: referenceRoom.growTo } : {}),
      done: referenceDone,
      optional: true,
      command: `download ${repo.reference.files.length} files of ${model.id} (the reference part) onto the rented GPU`,
    });
  }
  const speed = { text: video ? "A short clip takes a few minutes on a data-centre card; the first one longer while the model loads." : "A picture takes some seconds to a minute on a data-centre card; the first one longer while the model loads.", seconds: null };
  // An image-to-video model animates a picture; a text-to-video one may take one as well.
  const startPicture = video ? (/image-to-video/.test(model.pipeline ?? "") && !(model.tags ?? []).includes("text-to-video") ? "required" : "optional") : null;
  return { runnable: true, runner: "diffusers", file: repo, fit, tierGb: recommendedGb(repo.gb, modular, ltx), speed, measured: "", steps, qualities, ...(videoSpec ? { video: videoSpec } : {}), fast, style: imageStyle(model), remote: detected.gpu.url, tryWith: { kind: video ? "video" : "image", repo: model.id, file: "model_index.json", agent: detected.gpu.url, engine: "diffusers", ...(startPicture ? { startPicture } : {}), ...(video ? { addonsHere: (detected.gpu.addons ?? []).slice(0, 400) } : {}), ...(repo.reference ? { references: referenceDone, referenceGb: repo.reference.gb, ...(referenceRoom ? { referenceGrowTo: referenceRoom.growTo } : {}) } : {}) }, remove: [{ kind: "gpu-file", repo: model.id, file: "model_index.json" }] };
}

// How a folder model sits on the rented machine's card or cards: whole,
// at 8 or 4 bits (the worker's own ladder), or not at all. The sizes
// mirror worker.py: 8-bit takes about 0.6 of the full weights, 4-bit 0.35.
export function diffusersFit(gb, machine, modular = false) {
  if (!gb) return { level: "unknown", text: "Size unknown" };
  const room = machine.gpuGb ?? machine.comfortableGb ?? 0;
  const where = `the server's ${room} GB`;
  if (gb * 1.15 <= room) return { level: "good", text: `Fits ${where} (${gb.toFixed(1)} GB)` };
  if (modular) {
    // A modular pipeline is not quantised: what does not fit at once takes
    // turns on the card, each model moved in from the machine's memory as
    // its step comes.
    if (gb * 0.5 <= room) return { level: "tight", text: `Its ${gb.toFixed(1)} GB do not all sit on ${where} at once: its models take turns on the card from the machine's memory, a little slower per clip` };
    return { level: "no", text: `Too big for ${where} (${gb.toFixed(1)} GB): even one of its models at a time would not leave room to work; it needs a bigger size` };
  }
  if (gb * 0.6 <= room) return { level: "tight", text: `Loads at 8 bits on ${where} (${gb.toFixed(1)} GB in full precision); a little lower quality` };
  if (gb * 0.35 <= room) return { level: "tight", text: `Loads at 4 bits on ${where} (${gb.toFixed(1)} GB in full precision); lower quality and slower, a bigger size would do better` };
  return { level: "no", text: `Too big for ${where} even at 4 bits (${gb.toFixed(1)} GB); it would stream from the machine's memory, very slowly, or needs a bigger size` };
}

const LEVEL_TEXT = { low: "fast draft, smaller", medium: "full size", high: "full size, more passes, words expanded" };
// MiniMax-H3 makes clips with sound of 5 to 15 seconds at 24 fps, in
// frame counts of 17n + 5 on a canvas of multiples of 32 with a 768
// short edge; smaller canvases are its biggest speed lever.
function minimaxSpec(gb, cfg) {
  return { fps: 24, minSeconds: 5, maxSeconds: 15, defaultSeconds: 5, frameStep: 17, frameAdd: 5, sound: true, cfg, heavy: heavyFactor(gb), avoid: VIDEO_AVOID, levels: { low: { steps: 20, width: 960, height: 544, text: LEVEL_TEXT.low }, medium: { steps: 30, width: 1344, height: 768, text: LEVEL_TEXT.medium }, high: { steps: 50, width: 1344, height: 768, expand: true, text: LEVEL_TEXT.high } } };
}
const MINIMAX_QUALITIES = (cfg) => ({
  fast: { steps: 20, width: 960, height: 544, frames: 124, fps: 24, cfg, text: "a 5-second clip with sound at 960 by 544" },
  default: { steps: 30, width: 1344, height: 768, frames: 124, fps: 24, cfg, text: "a 5-second clip with sound at 768p" },
  max: { steps: 40, width: 1344, height: 768, frames: 243, fps: 24, cfg, text: "a 10-second clip with sound at 768p, many minutes" },
});

// The size to recommend for a folder model: room for it at 8 bits with
// margin, which is where quality is still close to full precision. A
// modular pipeline is never quantised; its models take turns on the card
// when they do not all fit, so a card with room for most of it does. On a
// two-card machine the worker puts its text encoder on the second card and
// the rest whole on the first, which is the fast way for MiniMax-H3.
function recommendedGb(gb, modular = false, whole = false) {
  return gb ? gb * (whole ? 1.15 : modular ? 0.7 : 0.6) : null;
}

// The disk a rented machine wants for a model: the model with a margin,
// rounded up to tens, never under the 50 GB default.
export function diskFor(gb) {
  return Math.max(50, Math.ceil(((Number(gb) || 0) * 1.1 + 10) / 10) * 10);
}

// Whether a download fits the rented machine's disk. A newer agent says
// how much is free; an older one leaves only the disk's size, from the
// rental. Over the line the plan stops before a download that would die
// partway (a full disk once left the agent dead and the site waiting on
// it) and says what disk to grow to.
function diskRoom(gpu, model, needGb) {
  if (!(needGb > 0)) return null;
  const rented = gpu.rented ?? null;
  let free = gpu.diskFreeGb ?? rented?.diskGb ?? null;
  let total = gpu.diskTotalGb ?? rented?.diskGb ?? null;
  // The disk's size is what was rented (and grown since): the machine's own
  // reading is either the pool its volume is a quota on, far too large, or
  // the size it was told at the rent, too small after a grow. What is used
  // is the machine's count of its folders, or its models' sizes.
  if (rented?.diskGb) {
    const plausible = gpu.diskTotalGb != null && gpu.diskTotalGb <= rented.diskGb * 2 && gpu.diskTotalGb >= rented.diskGb;
    const counted = gpu.diskUsedGb != null && gpu.diskUsedGb <= rented.diskGb * 1.05 ? gpu.diskUsedGb : null;
    const used = counted ?? (plausible ? Math.max(0, gpu.diskTotalGb - (gpu.diskFreeGb ?? 0)) : 0);
    total = rented.diskGb;
    free = Math.max(0, total - used);
  }
  if (free == null) return null;
  // Free space is exact; a disk's size alone leaves the file system's share unknown.
  if (needGb + (gpu.diskFreeGb != null ? 0.5 : needGb * 0.03 + 1) <= free) return null;
  const used = total != null ? Math.max(0, total - free) : 0;
  const diskGb = rented?.diskGb ?? (total != null ? Math.round(total) : null);
  const growTo = Math.max((diskGb ?? 0) + 10, Math.ceil((used + needGb * 1.1 + 10) / 10) * 10);
  const have = gpu.diskFreeGb != null && total != null ? ` (${free.toFixed(1)} GB free of ${Math.round(total)})` : "";
  // A Vast.ai machine's disk is set when it is rented; the way to more is a fresh machine.
  const vast = rented?.provider === "vast";
  return {
    runnable: false,
    needsDisk: true,
    diskGb,
    growTo,
    ...(vast ? { replaceForDisk: true } : {}),
    reason: `${model.name} needs ${needGb.toFixed(1)} GB more on the rented machine's storage disk (where model files are kept, apart from the GPU's own memory), and its ${diskGb ?? "small"} GB disk has no room for that${have}. ${vast ? `A Vast.ai machine's disk cannot be grown: replace the machine with one that has a ${growTo} GB disk (what is on this one downloads again)` : `Grow the disk to ${growTo} GB and the download goes on from the files already there`}; or delete models from the machine.`,
    steps: [],
  };
}

// Why the chat server is not answering: a rented machine says where it is
// in its life; any other server gets the general advice.
function serverDownNote(rented) {
  if (rented?.rented) {
    if (["PROVISIONING", "STARTING", "UNKNOWN"].includes(rented.status)) return "The rented GPU is still starting; it usually answers within a few minutes of being rented.";
    if (rented.status === "RUNNING" && rented.containerUp === false) return `RunPod lists the rented GPU as running, but its container has not started yet${rented.podNote ? ` (RunPod: ${rented.podNote})` : ""}: a fresh host fetches the machine image first, a few minutes; past ten, the host is not delivering, and Replace the machine from the GPU bar rents one on another host.`;
    if (rented.status === "RUNNING" && rented.agentRefused) return "The rented GPU is up and answers, but it refused the secret this site sends it, so the site cannot use it. Stop it and start it again from the bar; if it still refuses, replace it, and say so.";
    if (rented.status === "RUNNING") return "The rented GPU is up but has not answered yet; try again in a moment.";
    return "The rented GPU is stopped. Run this step starts it again, and a download goes on from the files already on its disk.";
  }
  return "The server is not answering right now; check the address or the tunnel in Settings.";
}

function installNote(runner, machine, detected) {
  // The hosted site does not know the visitor's system, so it names every one.
  if (machine.hosted) {
    if (runner === "ollama") return "HuggingFound downloads the official build for your system into ~/HuggingFound/bin; by hand, get it from ollama.com/download.";
    return "HuggingFound builds it into ~/HuggingFound/bin on a Mac or Linux (needs git and a C compiler) and downloads a ready-made build on Windows.";
  }
  if (runner === "ollama") {
    if (machine.platform === "linux") return "Installed with the official script from ollama.com.";
    return `HuggingFound downloads the official release build for ${platformName(machine.platform)} into ~/HuggingFound/bin. No package manager, nothing else touched.`;
  }
  if (machine.platform === "win32") return "Downloaded as a ready-made build.";
  return "Built from source into ~/HuggingFound/bin, which takes a minute or two. Needs git and a C compiler (the Xcode command line tools on a Mac); CMake is fetched if missing.";
}

function displayCommand(kind, machine) {
  if (machine.hosted) {
    if (kind === "install-ollama") return "download Ollama for your system from ollama.com/download";
    if (kind === "install-whisper") return "git clone github.com/ggerganov/whisper.cpp and build it with CMake, or download whisper-bin-x64.zip on Windows";
    return "";
  }
  if (kind === "install-ollama") return { darwin: "download ollama-darwin.tgz from github.com/ollama/ollama/releases", win32: "download ollama-windows-amd64.zip from github.com/ollama/ollama/releases", linux: "curl -fsSL https://ollama.com/install.sh | sh" }[machine.platform];
  if (kind === "install-whisper") return machine.platform === "win32" ? "download whisper-bin-x64.zip from the whisper.cpp releases" : "git clone github.com/ggerganov/whisper.cpp and build it with CMake";
  return "";
}

// What kind of pictures an image model was trained for, from its name and
// tags, so nobody asks an anime model for a photograph.
export function imageStyle(model) {
  const text = `${model.id} ${(model.tags ?? []).join(" ")}`.toLowerCase();
  // A realism merge of an anime base (the many "realistic pony" mixes) is
  // meant for photographs, so the realistic words win.
  if (/realistic|realism|photoreal|photo|juggernaut|realvis|epicrealism|cyberrealistic|photon|absolutereality|dreamshaper|majic/.test(text)) {
    return { kind: "realistic", text: "Trained for photographic, realistic pictures." };
  }
  if (/illustrious|pony|anime|animagine|noob|waifu|hentai|cartoon|toon|manga|counterfeit|anything-v/.test(text)) {
    return { kind: "anime", text: "Trained on anime and illustration. Asking it for a photograph will not work; a realistic model is a better fit for that (search for realistic, photoreal or juggernaut)." };
  }
  return null;
}

// A rough guess at how long a data-centre card takes for one picture or
// clip: a pixel-step for a picture, a pixel-step per frame for a clip,
// and more for a model too big to sit on one card in full precision. The
// page replaces it with the measured time once a picture has been made,
// and prices it at the machine's hourly rate.
export function gpuSeconds({ width = 1024, height = 1024, frames = 0, steps = 20, gb = 0 } = {}) {
  const megapixels = (width * height) / 1e6;
  const heavy = heavyFactor(gb);
  const seconds = frames ? 0.5 * megapixels * frames * steps * heavy : 0.15 * megapixels * steps * heavy + 2;
  return Math.round(seconds);
}
// A model too big for one card in full precision runs slower: its weights
// are quantised or take turns on the card.
export function heavyFactor(gb) {
  return gb > 60 ? 1.6 : gb > 30 ? 1.25 : 1;
}
// The machine makes at most this many frames in one clip.
export const MAX_FRAMES = 361;

// What the video families were tuned to steer away from: Wan's published
// list, in short. Used when nothing is given to avoid, at Medium and High.
export const VIDEO_AVOID = "blurry, low quality, overexposed, washed out, static, still image, flicker, jitter, distorted faces, deformed hands, extra fingers, fused limbs, subtitles, text, watermark, logo, cluttered background";
// The frame count nearest a length in seconds that the model's video VAE
// decodes (its step and offset), within what the machine makes.
export function framesFor(seconds, spec) {
  const want = Math.max(spec.minSeconds, Math.min(spec.maxSeconds, Number(seconds) || spec.defaultSeconds)) * spec.fps;
  let n = Math.max(1, Math.round((want - spec.frameAdd) / spec.frameStep));
  while (n > 1 && n * spec.frameStep + spec.frameAdd > MAX_FRAMES) n--;
  return n * spec.frameStep + spec.frameAdd;
}
function withGpuSeconds(qualities, gb) {
  for (const q of Object.values(qualities)) q.seconds = gpuSeconds({ width: q.width, height: q.height, frames: q.frames ?? 0, steps: q.steps, gb });
  return qualities;
}
