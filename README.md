# HuggingFound

Find open-source models on Hugging Face, see which ones your computer can run, and get them running locally in a few clicks. Made for people who have heard about local models and would like to try one without learning the tooling first.

- **Scan** Hugging Face for what is trending and what is new, then browse it by what you want to do: easy to set up, chat and writing, coding, math and reasoning, understanding images, making images, speech to text.
- **See the fit.** Every model card shows whether the file fits in this computer's memory, before you download anything.
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
| `bin/` | Ollama, stable-diffusion.cpp and, on Windows, whisper.cpp builds |
| `output/` | Generated images and transcripts |
| `uploads/` | Recordings you picked for transcription |
| `scan.json` | The last scan, so the next one can say what is new |
| `.env` | Your Hugging Face token, if you added one |

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
| Install whisper.cpp | `brew install whisper-cpp` | release zip | `brew install whisper-cpp` |
| Install stable-diffusion.cpp | release zip for Apple Silicon | release zip (CUDA or CPU) | release zip |
| Download a file | HTTPS from Hugging Face into `~/HuggingFound/models` | same | same |

Gated chat models are downloaded with your token and registered with `ollama create` from a Modelfile.

Ollama is fetched from its GitHub releases rather than through Homebrew or winget on purpose. On a macOS version Homebrew no longer builds bottles for, `brew install ollama` compiles from source inside a sandbox and fails; the release build works everywhere. An Ollama already on the PATH is used as is. Every step runs from `~/HuggingFound`, never from the folder the app was started in.

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
src/plans.js          the step plan for a model on this computer
src/runners.js        commands, downloads, releases, live step output
src/server.js         the local HTTP API
public/               the page
test/                 node:test suites and the Playwright browser test
```

MIT licence.
