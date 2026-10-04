# HuggingFound

Find open-source models on Hugging Face, see which ones your computer can run, and get them running locally in a few clicks. Made for people who have heard about local models and would like to try one without learning the tooling first.

- **Start with a search.** The app opens on one box: say what you want in plain words ("creative writing", "anime pictures", "coding help", "transcribe meetings") and get models ranked by name, by the category the words point at, and above all by what people say about them, runnable ones first, each card saying why it is there. Praise counts more than a complaint that happens to use the same words. Models that people report as refusing requests ("against its guidelines", "censored", "lobotomized") are left out of the results unless you ask to see them, and are marked wherever they appear. Curated picks answer before any scan.
- **Browse** the rest: scan Hugging Face for what is trending and what is new, then browse it by what you want to do: easy to set up, chat and writing, coding, math and reasoning, understanding images, making images and speech to text.
- **Know the wait.** Every model shows a rough speed line for this computer: words per second for chat, minutes per image, seconds per minute of audio. It is a guess from the file size and the hardware; after a real run the measured time takes its place.
- **Hear what people say, in a line or two.** "Gather what people say" reads each scanned model's card and its community discussions on Hugging Face and sums them up on every card: one or two short lines, users' strengths and complaints first, the author's claim last, with More to read the rest. A chat model installed in Ollama writes the lines on this computer; without one they are lifted from the most opinionated sentences. Nothing is quoted at length. The search box finds models by name on Hugging Face and by those gathered words ("roleplay", "coding help", "blurry hands"). The same search also asks, all at once: Civitai (thumbs up, comments and downloads for image models, most of which are mirrored on the Hub), GitHub issues on llama.cpp, Ollama, stable-diffusion.cpp, whisper.cpp, SillyTavern, ComfyUI and related projects, Hacker News, Lemmy communities such as localllama and stable_diffusion, and, with free keys in Settings, YouTube (video reviews) and Reddit (r/LocalLLaMA, r/StableDiffusion, r/SillyTavernAI and related). Results that name a scanned model link to it. A model's window shows the same sources for that model, plus the prompts people post with their pictures on its Civitai page, kept for a week.
- **Find what you want.** Sort by trending, user likes, downloads or newest, narrow to this week or month, or type the traits you are after ("roleplay 7b", "japanese", "medical") to search Hugging Face directly.
- **See the fit.** Every model card shows whether the file fits in this computer's memory, before you download anything.
- **Set the model's instructions.** The chat box has an optional system message (persona and rules) that is sent before every conversation and remembered per model.
- **Say what to avoid.** The image box has an Avoid field that becomes the negative prompt, since models cannot read "not" in a description, and each image model is labelled anime or realistic so the right one gets asked.
- **Pick the speed.** Every image model offers Fast (12 steps, a sharper sampler), Default (the plain 20 steps) and Max (40 steps), each with a time estimate for this computer. Distilled models such as SDXL Turbo and SDXL Lightning are marked fast and make a picture in four steps. After the first picture the model stays loaded in memory for a quarter of an hour, so the next ones skip the loading time.
- **Use a GPU elsewhere.** Point Settings at a stable-diffusion.cpp server (`sd-server`) on another computer or a rented GPU box, and pictures are made there in seconds with the model it has loaded; nothing is downloaded here.
- **Keep your disk.** Models are gigabytes each. "Scan this computer" on the front page lists everything downloaded with its size, how much space is free on the drive, a Use button that opens the model ready to try, and a Remove button for each; the free-space figure updates as things go. The same list is in Settings, and a set-up model has a Remove button in its own window.
- **Try it locally.** Pick a model and HuggingFound lays out the steps: install the runner, start it, download the file. Each step shows the exact command, runs when you confirm, and streams its output. When the steps are done, a chat box, an image prompt or a transcription box appears right there.

Chat, coding, math and vision models run through [Ollama](https://ollama.com). Image models run through [stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp). Speech models run through [whisper.cpp](https://github.com/ggerganov/whisper.cpp). All three are open source and run entirely on your machine.

## A hosted copy

The same code can be served on the web as a catalogue: search, browse and what people say work as on a computer, the server rescans Hugging Face on a timer, and a model's window shows the steps to run it instead of running them. Nothing installs, downloads or chats on the server; the page points at running HuggingFound on your own computer for that. Set `HUGGINGFOUND_HOSTED=1` to serve that copy; `Dockerfile`, `render.yaml` and [DEPLOY.md](DEPLOY.md) have the rest.

## Run it

Needs Node 20 or newer.

```sh
git clone https://github.com/hungateJoseph/huggingfound.git
cd huggingfound
npm start
```

HuggingFound opens in a window of its own when Chrome, Edge, Brave or Chromium is installed, and in the default browser otherwise. `npm start -- --browser` always uses the browser; `--no-open` just prints the address; `--port 5000` changes the port.

Everything it saves lives in `~/HuggingFound`:

| Path | What |
| --- | --- |
| `models/` | Files downloaded directly (image, speech, and gated chat models) |
| `bin/` | Ollama, stable-diffusion.cpp, whisper.cpp and, if needed, CMake |
| `output/` | Generated images and transcripts |
| `uploads/` | Recordings you picked for transcription |
| `scan.json` | The last scan, so the next one can say what is new |
| `timings.json` | How long real runs took, shown in place of the guesses |
| `voices.json` | Model cards and discussion lists gathered for the search by what people say |
| `.env` | Your Hugging Face token, the image server address, and the GitHub token, YouTube key and Reddit app id, if you set them |

Chat models pulled through Ollama live in Ollama's own store. Set `HUGGINGFOUND_HOME` to keep all of it somewhere else.

## Hugging Face token

Optional. Most models on the easy list are openly licensed and need nothing. Some, such as Llama and Gemma, are gated: you accept the licence on the model page, then downloads need a read token from [your settings](https://huggingface.co/settings/tokens). Paste it in Settings inside HuggingFound and gated models unlock. Without a token those models show what is needed and everything else keeps working.

## What it installs, and how

HuggingFound only ever runs the fixed set of commands below, built from checked model and file names. The page names a step; it never sends a command.

| Step | macOS | Windows | Linux |
| --- | --- | --- | --- |
| Install Ollama | release build (`ollama-darwin.tgz`) unpacked into `~/HuggingFound/bin/ollama` | release build (`ollama-windows-amd64.zip`) | official install script |
| Start Ollama | `ollama serve` | same | same |
| Get a chat model | `ollama pull hf.co/<repo>:<quant>` | same | same |
| Install whisper.cpp | built from source with CMake | release zip | built from source with CMake |
| Install stable-diffusion.cpp | release zip, or built from source when the zip needs a newer macOS | release zip (CUDA or CPU) | release zip, or built from source |
| Download a file | HTTPS from Hugging Face into `~/HuggingFound/models` | same | same |
| Download a diffusers repository | the unet, VAE and text encoder files of a Stable Diffusion 1.x or XL repository, merged into one checkpoint file (tensor names mapped as in the diffusers conversion scripts, weights copied byte for byte), parts removed afterwards | same | same |

Gated chat models are downloaded with your token and registered with `ollama create` from a Modelfile.

No package manager is involved. Ollama comes from its GitHub releases; on a macOS version Homebrew no longer builds bottles for, `brew install ollama` compiles from source inside a sandbox and fails, while the release build works everywhere. stable-diffusion.cpp publishes macOS builds compiled on the newest macOS only, so a release that fails to load is replaced by a build from source; whisper.cpp publishes no macOS or Linux builds and is always built. Building needs git and a C compiler (on a Mac, `xcode-select --install`); CMake is fetched as a self-contained release into `~/HuggingFound/bin/cmake` when it is not installed. Anything already on the PATH is used as is. Every step runs from `~/HuggingFound`, never from the folder the app was started in.

## Tests

```sh
npm test               # unit and API tests, no network
npm install            # once, for the browser test
npm run test:browser   # drives the page in real Chrome against a stand-in hub
```

## Layout

```
bin/huggingfound.js   start the server and open the window
src/hf.js             Hugging Face Hub client, the scan, file choice
src/categorize.js     categories and runner detection from Hub metadata
src/machine.js        memory, GPU, and whether a file fits
src/picks.js          curated known-good models per category
src/speed.js          rough speed guesses per runner, size and hardware
src/find.js           ranks a plain-language search by name, category and what people say
src/voices.js         gathers model cards and Hub discussions; searches them
src/sources.js        Civitai, GitHub, Hacker News, Lemmy, YouTube and Reddit
src/summarize.js      sums up what people say, by a local chat model or by extraction
src/convert.js        merges a diffusers folder into one checkpoint file
src/plans.js          the step plan for a model on this computer
src/runners.js        commands, downloads, releases, live step output
src/server.js         the local HTTP API
public/               the page
test/                 node:test suites and the Playwright browser test
```

MIT licence.
