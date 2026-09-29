import { chooseFile, quantTag } from "./hf.js";
import { fitFor } from "./machine.js";
import { platformName } from "./machine.js";

// Turns "I want to try this model" into the ordered steps this computer
// needs, with the ones already done marked so the page can skip them.
// Each step names a kind from runners.js; the page never sends commands.

export function buildPlan({ model, files, machine, detected, hasToken, preferredFile }) {
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
  const downloaded = detected.models.includes(`${model.id}/${file.name}`);
  const steps = [];
  const os = platformName(machine.platform);

  if (runner.id === "ollama") {
    const quant = quantTag(file.name);
    const viaPull = !model.gated && quant;
    const localName = model.name.toLowerCase().replace(/-gguf$/i, "").replace(/[^a-z0-9.-]/g, "-");
    const ollamaName = viaPull ? `hf.co/${model.id}:${quant}` : localName;
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
    return { runnable: true, runner: runner.id, file, fit, steps, tryWith: { kind: "chat", model: ollamaName }, remove };
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
    return { runnable: true, runner: runner.id, file, fit, steps, tryWith: { kind: "transcribe", repo: model.id, file: file.name, ffmpeg: detected.ffmpeg }, remove: [{ kind: "file", repo: model.id, file: file.name }] };
  }

  if (runner.id === "sd") {
    steps.push({
      kind: "install-sd",
      title: "Install stable-diffusion.cpp",
      text: `The program that turns a description into an image. HuggingFound downloads the ready-made build for ${os}${machine.platform === "win32" ? "." : ", and builds it from source if that build does not run on this version."}`,
      done: detected.sd.installed,
      command: machine.platform === "win32" ? "download the latest release from github.com/leejet/stable-diffusion.cpp" : "download the latest release from github.com/leejet/stable-diffusion.cpp, or build it with CMake",
    });
    steps.push({
      kind: "download-file",
      args: { repo: model.id, file: file.name },
      title: `Download ${file.name} (${file.gb ? file.gb.toFixed(1) + " GB" : "size unknown"})`,
      text: `${fit.text}. Image models are large; a 512 by 512 picture takes one to a few minutes on a laptop, longer the first time while the graphics shaders compile.`,
      done: downloaded,
      command: `download to ~/HuggingFound/models/${model.id}/${file.name}`,
    });
    return { runnable: true, runner: runner.id, file, fit, steps, tryWith: { kind: "image", repo: model.id, file: file.name }, remove: [{ kind: "file", repo: model.id, file: file.name }] };
  }

  return { runnable: false, reason: "Unsupported runner.", steps: [] };
}

function installNote(runner, machine, detected) {
  if (runner === "ollama") {
    if (machine.platform === "linux") return "Installed with the official script from ollama.com.";
    return `HuggingFound downloads the official release build for ${platformName(machine.platform)} into ~/HuggingFound/bin. No package manager, nothing else touched.`;
  }
  if (machine.platform === "win32") return "Downloaded as a ready-made build.";
  return "Built from source into ~/HuggingFound/bin, which takes a minute or two. Needs git and a C compiler (the Xcode command line tools on a Mac); CMake is fetched if missing.";
}

function displayCommand(kind, machine) {
  if (kind === "install-ollama") return { darwin: "download ollama-darwin.tgz from github.com/ollama/ollama/releases", win32: "download ollama-windows-amd64.zip from github.com/ollama/ollama/releases", linux: "curl -fsSL https://ollama.com/install.sh | sh" }[machine.platform];
  if (kind === "install-whisper") return machine.platform === "win32" ? "download whisper-bin-x64.zip from the whisper.cpp releases" : "git clone github.com/ggerganov/whisper.cpp and build it with CMake";
  return "";
}
