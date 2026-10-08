import { chooseFile, quantTag } from "./hf.js";
import { fitFor, platformName } from "./machine.js";
import { imageSettings } from "./runners.js";
import { estimate, measuredText } from "./speed.js";

// Turns "I want to try this model" into the ordered steps this computer
// needs, with the ones already done marked so the page can skip them.
// Each step names a kind from runners.js; the page never sends commands.

export function buildPlan({ model, files, machine, detected, hasToken, preferredFile, timings = {}, imageServer = null }) {
  const runner = model.runner;
  if (!runner) return { runnable: false, reason: "This kind of model has no local runner in HuggingFound yet.", steps: [] };
  if (!runner.easy) {
    if (runner.id === "sd-parts") {
      return {
        runnable: false,
        reason: `${model.name} ships as several files (the model, one or two text encoders and a VAE) that have to be matched by hand. HuggingFound sets up image models that come as one file, such as Stable Diffusion 1.5 and SDXL Turbo on the Easy to set up list.`,
        steps: [],
        link: model.url,
      };
    }
    return {
      runnable: false,
      reason: `${model.name} is published for ${runner.name}, which needs a Python setup. HuggingFound runs models that come as single files for Ollama, whisper.cpp or stable-diffusion.cpp. Look for a version of this model tagged GGUF, or pick one from the Easy to set up list.`,
      steps: [],
      link: `https://huggingface.co/models?search=${encodeURIComponent(model.name.replace(/-GGUF/i, ""))}%20gguf`,
    };
  }
  const file = (preferredFile && files.find((f) => f.name === preferredFile)) || chooseFile(files, runner.id);
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
      if (file.folder) {
        return { runnable: false, reason: `${model.name} is published as several files that HuggingFound merges on this computer; the rented GPU runs image models that come as one file. Run it on this computer, or pick a single-file version.`, steps: [], link: model.url };
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
