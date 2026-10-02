# Hosting HuggingFound on Render

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
at $0.25), plus a domain if you want one. The free plan has no disk and sleeps
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

## Phase 3: Create the Render service (you)

1. Sign up at <https://render.com> and connect your GitHub account.
2. **New, then Blueprint**, choose the `huggingfound` repository. Render reads
   `render.yaml` and proposes one web service with a 1 GB disk at `/var/data`.
3. It prompts for the three keys above; leave any of them blank.
4. Click **Apply**. The first build takes about a minute. The first scan starts
   a few seconds after the service is up and takes a few minutes; the gather of
   what people say runs after it and takes ten to twenty minutes for the three
   hundred or so models in a scan. Until the scan lands, the page says the
   catalogue is being scanned and the curated picks already work.

Render gives the service an address such as `https://huggingfound.onrender.com`.

## Phase 4: A domain (you, optional)

1. In the service's **Settings, Custom Domains**, add your domain (and `www`).
2. Render shows the DNS records to add at your registrar: a CNAME for `www`
   and an A or ALIAS record for the bare domain. Add them, wait for the check
   to pass, and Render issues the certificate.

## Checking it works

- `https://<your address>/api/state` answers JSON with `"hosted": true`.
- `POST https://<your address>/api/run` answers 403 with a message pointing at
  the app; so do settings, scan, chat, upload, remove and storage.
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
