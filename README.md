# HuggingFound

Find open-source models on Hugging Face, see which ones your computer can run, and get them running locally in a few clicks. Made for people who have heard about local models and would like to try one without learning the tooling first.

- **Scan** Hugging Face for what is trending and what is new, then browse it by what you want to do: easy to set up, chat and writing, coding, math and reasoning, understanding images, making images, speech to text.
- **Know the wait.** Every model shows a rough speed line for this computer: words per second for chat, minutes per image, seconds per minute of audio. It is a guess from the file size and the hardware; after a real run the measured time takes its place.
- **Find what you want.** Tabs for NSFW writing and NSFW images alongside the rest, sort by trending, user likes, downloads or newest, narrow to this week or month, or type the traits you are after ("uncensored roleplay 7b", "japanese", "medical") to search Hugging Face directly.
- **See the fit.** Every model card shows whether the file fits in this computer's memory, before you download anything.
- **Say what to avoid.** The image box has an Avoid field that becomes the negative prompt, since models cannot read "not" in a description, and each image model is labelled anime or realistic so the right one gets asked.
- **Pick the speed.** Every image model offers Fast (12 steps, a sharper sampler), Default (the plain 20 steps) and Max (40 steps), each with a time estimate for this computer. Distilled models such as SDXL Turbo and SDXL Lightning are marked fast and make a picture in four steps. After the first picture the model stays loaded in memory for a quarter of an hour, so the next ones skip the loading time.
- **Use a GPU elsewhere.** Point Settings at a stable-diffusion.cpp server (`sd-server`) on another computer or a rented GPU box, and pictures are made there in seconds with the model it has loaded; nothing is downloaded here.
- **Keep your disk.** Models are gigabytes each. Once you have tried one, a button in the same window removes it; Settings lists everything downloaded, with sizes, so any of it can go.
- **Try it locally.** Pick a model and HuggingFound lays out the steps: install the runner, start it, download the file. Each step shows the exact command, runs when you confirm, and streams its output. When the steps are done, a chat box, an image prompt or a transcription box appears right there.

Chat, coding, math and vision models run through [Ollama](https://ollama.com). Image models run through [stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp). Speech models run through [whisper.cpp](https://github.com/ggerganov/whisper.cpp). All three are open source and run entirely on your machine.

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
| `.env` | Your Hugging Face token and the image server address, if you set them |

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
src/convert.js        merges a diffusers folder into one checkpoint file
src/plans.js          the step plan for a model on this computer
src/runners.js        commands, downloads, releases, live step output
src/server.js         the local HTTP API
public/               the page
test/                 node:test suites and the Playwright browser test
```

MIT licence.
