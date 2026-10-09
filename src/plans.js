import { chooseFile, quantTag, repoFiles } from "./hf.js";
import { fitFor, platformName } from "./machine.js";
import { imageSettings } from "./runners.js";
import { estimate, measuredText } from "./speed.js";
import { isAddon } from "./quality.js";

// Turns "I want to try this model" into the ordered steps this computer
// needs, with the ones already done marked so the page can skip them.
// Each step names a kind from runners.js; the page never sends commands.

export function buildPlan({ model, files, machine, detected, hasToken, preferredFile, timings = {}, imageServer = null }) {
  const runner = model.runner;
  if (!runner) return { runnable: false, reason: "This kind of model has no local runner in HuggingFound yet.", steps: [] };
  if (isAddon(model.name) && (runner.id === "sd" || runner.id === "diffusers")) return addonPlan({ model, files, detected });
  if (runner.id === "diffusers") return diffusersPlan({ model, files, machine, detected });
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
    // pictures are then made there, asked for by the browser itself.
    if (detected.gpu?.url) {
      if (model.gated) {
        return { runnable: false, gated: true, reason: `${model.name} is gated, and the rented GPU fetches files without your Hugging Face token. Run it on this computer instead, or pick an open model.`, steps: [], link: model.url };
      }
      // A folder-layout model: the machine fetches the parts and merges
      // them into one checkpoint, as this computer would.
      if (file.folder) {
        const done = detected.gpu.files.includes(`${model.id}/${mergedName}`);
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

// An add-on (an IP-Adapter, a LoRA) is applied on the rented GPU to a base
// model that is already there: the machine fetches the add-on's files and
// its Python side loads the base with the add-on on top. An IP-Adapter
// steers the picture with a reference image; a LoRA changes the style.
export function addonVariants(files) {
  const names = files.map((f) => f.name);
  const weights = files.filter((f) => /\.(bin|safetensors)$/i.test(f.name) && !/image_encoder/i.test(f.name) && !/\.safetensors\.index\.json$/i.test(f.name));
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
  const { kind, variants, encoders } = addonVariants(files);
  const what = kind === "ip-adapter" ? "an IP-Adapter: it steers a base model's picture with a reference image (a face, a style, a subject)" : "a LoRA: it changes how a base model draws";
  if (!variants.length) {
    return { runnable: false, addon: true, reason: `${model.name} is an add-on with no weights HuggingFound recognises. It makes nothing by itself.`, steps: [], link: model.url };
  }
  if (!detected.gpu?.url) {
    return {
      runnable: false,
      addon: true,
      needsGpu: true,
      reason: `${model.name} is ${what}. Add-ons are applied on a rented GPU, to a Stable Diffusion 1.5 or SDXL model downloaded there. Rent one by the hour and the machine does the rest.`,
      steps: [],
      link: model.url,
    };
  }
  const download = [...variants.map((v) => v.file), ...variants.map((v) => v.lora).filter(Boolean), ...encoders];
  const have = new Set(detected.gpu.addons ?? []);
  const done = download.every((f) => have.has(`${model.id}/${f}`));
  const gb = variants.reduce((t, v) => t + v.gb, 0) + encoders.reduce((t, n) => t + (files.find((f) => f.name === n)?.gb ?? 0), 0);
  // Bases: the checkpoints and Stable Diffusion folders already on the machine.
  const bases = (detected.gpu.files ?? [])
    .filter((key) => /\.(safetensors|ckpt)$/i.test(key) || key.endsWith("/model_index.json"))
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
  const qualities = {
    fast: { steps: 15, size: 512, cfg: 6, text: "fewer steps" },
    default: { steps: 25, size: 512, cfg: 6, text: "the standard settings" },
    max: { steps: 40, size: 512, cfg: 6, text: "more steps" },
  };
  return {
    runnable: true,
    runner: "addon",
    addon: true,
    file: { name: `${variants.length} variant${variants.length === 1 ? "" : "s"}`, gb: gb || null, variants: variants.length },
    fit: { level: "good", text: `${what.split(":")[0]}` },
    speed: { text: bases.length ? `Applied to a base model on the rented GPU; ${bases.length} there now.` : "Needs a Stable Diffusion 1.5 or SDXL model on the rented GPU first: download one there from the Easy to set up list.", seconds: null },
    measured: "",
    steps,
    qualities,
    fast: false,
    style: null,
    remote: detected.gpu.url,
    tryWith: { kind: "image", engine: "addon", addonKind: kind, repo: model.id, agent: detected.gpu.url, variants, bases },
    remove: download.map((f) => ({ kind: "gpu-addon", repo: model.id, file: f })),
  };
}

// A model only the diffusers library loads (FLUX, Qwen-Image, Wan and the
// other folder-layout families, video included): it runs on a rented GPU,
// where the machine fetches the folder and its Python side makes the
// pictures or clips. Nothing on a person's own computer loads these.
function diffusersPlan({ model, files, machine, detected }) {
  const repo = repoFiles(files);
  const video = /video/.test(model.pipeline ?? "");
  const what = video ? "clips" : "pictures";
  if (!repo) {
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
      reason: `${model.name} runs only on a rented GPU: it is loaded by the diffusers library, which nothing on a laptop runs well${repo.gb ? `, and its ${repo.gb.toFixed(0)} GB of weights want a data-centre card` : ""}. Rent one by the hour and the machine fetches the model and makes ${what} there.`,
      steps: [],
      link: model.url,
      file: repo,
    };
  }
  if (model.gated) {
    return { runnable: false, gated: true, reason: `${model.name} is gated, and the rented GPU fetches files without your Hugging Face token. Pick an open model, or the same family from a maker who publishes it openly.`, steps: [], link: model.url };
  }
  const fit = fitFor(repo.gb, machine);
  const done = detected.gpu.files.includes(`${model.id}/model_index.json`);
  const fast = /turbo|lightning|schnell|distill|hyper|rapid|fast|step/i.test(model.id);
  const cfg = /flux/i.test(model.id) ? 3.5 : /qwen/i.test(model.id) ? 4 : 5;
  const qualities = video
    ? {
        fast: { steps: 20, width: 832, height: 480, frames: 33, fps: 16, cfg, text: "a 2-second clip at 480p" },
        default: { steps: 30, width: 832, height: 480, frames: 49, fps: 16, cfg, text: "a 3-second clip at 480p" },
        max: { steps: 40, width: 1280, height: 720, frames: 81, fps: 16, cfg, text: "a 5-second clip at 720p, many minutes" },
      }
    : {
        fast: { steps: fast ? 4 : 12, size: 768, width: 768, height: 768, cfg, text: "768 by 768, fewer steps" },
        default: { steps: fast ? 4 : 28, size: 1024, width: 1024, height: 1024, cfg, text: "1024 by 1024" },
        max: { steps: fast ? 8 : 40, size: 1024, width: 1024, height: 1024, cfg, text: "1024 by 1024, more steps" },
      };
  const steps = [{
    kind: "pull-image-repo",
    args: { repo: model.id, files: repo.files.map((f) => f.from) },
    title: `Download the model's ${repo.files.length} files on the rented GPU (${repo.gb ? repo.gb.toFixed(1) + " GB" : "size unknown"})`,
    text: `The machine fetches the model's folder straight from Hugging Face onto its own disk; nothing comes to this computer. ${fit.text}.${detected.gpu.running ? "" : ` ${serverDownNote(detected.gpu.rented)}`}`,
    done,
    command: `download ${repo.files.length} files of ${model.id} onto the rented GPU`,
  }];
  const speed = { text: video ? "A short clip takes a few minutes on a data-centre card; the first one longer while the model loads." : "A picture takes some seconds to a minute on a data-centre card; the first one longer while the model loads.", seconds: null };
  return { runnable: true, runner: "diffusers", file: repo, fit, speed, measured: "", steps, qualities, fast, style: imageStyle(model), remote: detected.gpu.url, tryWith: { kind: video ? "video" : "image", repo: model.id, file: "model_index.json", agent: detected.gpu.url, engine: "diffusers" }, remove: [{ kind: "gpu-file", repo: model.id, file: "model_index.json" }] };
}

// Why the chat server is not answering: a rented machine says where it is
// in its life; any other server gets the general advice.
function serverDownNote(rented) {
  if (rented?.rented) {
    if (["PROVISIONING", "STARTING", "UNKNOWN"].includes(rented.status)) return "The rented GPU is still starting; it usually answers within a few minutes of being rented.";
    if (rented.status === "RUNNING") return "The rented GPU is up but Ollama on it has not answered yet; try again in a moment.";
    return "The rented GPU is stopped. Start it under Rent a GPU in Settings.";
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
