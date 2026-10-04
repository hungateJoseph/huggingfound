# Hosting HuggingFound on Render at huggingfound.com

The repository is ready to host: `Dockerfile` builds a small image and
`render.yaml` describes the service. What remains needs your accounts, so each
phase below says whether you do it or whether it happens by itself.

**What the hosted copy is.** HuggingFound is made to run on a person's own
computer, where it installs Ollama, whisper.cpp or stable-diffusion.cpp,
downloads models and runs them. A public copy cannot do that for visitors, so
the image runs the app in hosted mode (`HUGGINGFOUND_HOSTED=1`):

- The search box, Browse, the categories, what people say about each model and
  the outside sources all work as on a computer.
- The catalogue is scanned from Hugging Face by the server itself, every 12
  hours (`HUGGINGFOUND_REFRESH_HOURS`), and what people say is gathered and
  summed up after each scan. Visitors cannot start a scan.
- Fit and speed are shown for a typical 16 GB laptop, and the page says so.
- A model's window lists the steps to run it, with each command, and points at
  running HuggingFound on the visitor's computer, where the steps run with one
  click and a chat, image or transcription box appears. Nothing installs,
  downloads, chats or changes settings on the server; those routes answer 403.
- Summaries are lifted from the comments rather than written by a chat model,
  since the server has no Ollama.

**Running cost:** about **$8.25 a month** (Render Starter $7 plus a 1 GB disk
at $0.25), plus about $10.50 a year for the domain. The free plan has no disk and sleeps
between visits, which would mean a fresh scan on every wake.

---

## Phase 1: Code on GitHub (done)

<https://github.com/hungateJoseph/huggingfound> is public. Nothing secret is
in it; keys are read from the environment on the server.

## Phase 2: Optional keys (you)

All three are optional. Collect any you want before Phase 3.

| Key | What it does | Where |
| --- | --- | --- |
| `HF_TOKEN` | A Hugging Face read token raises the Hub's rate limit for the scans | <https://huggingface.co/settings/tokens> |
| `GITHUB_TOKEN` | Thirty GitHub issue searches a minute instead of ten | <https://github.com/settings/tokens> (no scopes needed) |
| `YOUTUBE_API_KEY` | Video reviews on cards and in the model window | Google Cloud console, YouTube Data API v3 |

## Phase 3: The Render service (done)

Created on 2026-10-04 from `render.yaml` as the Blueprint `huggingfound`: one
web service named `huggingfound` on the Starter plan with a 1 GB disk at
`/var/data`, answering at <https://huggingfound.onrender.com>. The three
optional keys were left blank; they can be added under the service's
**Environment** at any time, and saving them redeploys.

To rebuild it from nothing: on <https://render.com>, **New, then Blueprint**,
choose the `huggingfound` repository, name the Blueprint, leave or fill the
keys, and deploy. The first build takes about a minute, the first scan starts
a few seconds after the service is up, and what people say is gathered right
after it.

## Phase 4: The domain (done)

`huggingfound.com` is registered at Cloudflare (renews each October) and uses
Cloudflare's nameservers. Both names are added under the service's
**Settings, Custom Domains**, and `www` redirects to the bare domain.

The DNS records in Cloudflare, both **DNS only** (grey cloud) so that Render
issues and renews the certificates:

| Type | Name | Target |
| --- | --- | --- |
| `CNAME` | `@` | `huggingfound.onrender.com` |
| `CNAME` | `www` | `huggingfound.onrender.com` |

Cloudflare flattens the `CNAME` at the root, which is why no `A` record is
needed. Turning the proxy on (orange cloud) would put Cloudflare's certificate
in front and needs SSL set to Full (strict) first; it is not needed here.

## The Claude check on the site

The site has a "Check an answer" panel where a visitor pastes a model's answer
or picks a picture and Claude reviews it. Who pays is decided per check:

- **A visitor's own key.** They enter an Anthropic API key in the panel. It
  stays in their browser tab, travels with the check, is handed to Anthropic
  for that one request, and is never stored or logged on the server.
- **The owner's dev code.** With `ANTHROPIC_API_KEY` and `REVIEW_DEV_CODE` set
  under the service's **Environment** on Render, a check sent with the right
  code uses the site's key. Without the code nobody can spend that key. Pick a
  long random code; eight wrong guesses from one address lock that address out
  for an hour.

One address gets thirty checks an hour. Set both variables or neither; saving
them redeploys the service.

## Checking it works

- `https://huggingfound.com/api/state` answers JSON with `"hosted": true`.
- `POST https://huggingfound.com/api/run` answers 403 with a message pointing at
  the app; so do settings, scan, chat, upload, remove and storage.
- `POST https://huggingfound.com/api/review` with no key and no code answers 401.
- A model's window has no Run buttons and no try box, only the steps with
  their commands and the box that says how to get the app.

## Updating

Push to `main`. Render rebuilds and redeploys on every push; the disk keeps the
scan and what people say, so the catalogue is there straight away.

## Running the image yourself

```sh
docker build -t huggingfound .
docker run --rm -p 4188:4188 -v huggingfound-data:/var/data huggingfound
```

Then open <http://127.0.0.1:4188/>. Without `HUGGINGFOUND_HOSTED=1` the same
code is the app itself; the image sets it.
