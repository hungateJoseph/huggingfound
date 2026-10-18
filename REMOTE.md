# Running big chat models on a rented GPU

Some models are too big for a laptop: a 70B model is a 40 GB file and wants
a 48 GB GPU. HuggingFound can keep its window on your computer and hand the
heavy part to another machine. With a **chat server** set in Settings, chat
models are downloaded and run on that machine; your computer only sends and
receives text.

The server is just [Ollama](https://ollama.com) on a machine with a GPU.
There are two ways to get one: let HuggingFound rent it for you, or set one
up yourself and connect to it through a tunnel.

## Let HuggingFound rent it

This works in the app on your computer and, signed in, on huggingfound.com.
On the site your browser talks to the rented machine directly, so what you
say to a model never passes through the site.

HuggingFound can rent the machine at [RunPod](https://www.runpod.io), a GPU
cloud that bills by the hour, and manage it for you: start it, point the
chat server at it, stop it when it sits idle, and delete it when you are
done. You pay RunPod; HuggingFound charges nothing and never sees your card.

1. Make a RunPod account and add some credit (ten dollars goes a long way;
   see the prices below).
2. In RunPod, on the **Credentials** page (Account, Credentials, API Keys), create a key with read and
   write access. It has to make and stop machines.
3. In HuggingFound's **Settings**, under **Rent a GPU by the hour**, paste
   the key and save. The sizes on offer appear with the price an hour of the
   cheapest card that is free right now:

   | Size | Model files up to about | Examples | Typical price |
   | --- | --- | --- | --- |
   | 24 GB | 17 GB | 30B-class models at 4-bit | $0.30 to $0.70 an hour |
   | 48 GB | 34 GB | 70B-class models at 4-bit | $0.40 to $1.20 an hour |
   | 80 GB | 57 GB | 100B-class models, or 70B at higher quality | $1.60 to $3 an hour |
   | 141 GB | 100 GB | the biggest open models | $3 to $4 an hour |

4. Pick a size and a disk for its models (50 GB, or what the model you came
   from needs with room to spare), and click **Rent it**. A disk can be grown
   later, never shrunk: a model that will not fit the machine's disk says so
   in its window, before anything is fetched, with a button that grows the
   disk to the size it needs; the models already on it stay. Every chat model's window also
   offers this: two buttons at the top choose between your computer and a
   rented GPU, and choosing the GPU without one asks whether you have a
   RunPod key, takes it, and opens this section with the right size chosen.

The machine runs HuggingFound's own image (built with `gpu/Dockerfile` in this
repository): Ollama for chat models, stable-diffusion.cpp for single-file
image models, and a Python worker with the diffusers library for the
families only it loads (FLUX, Qwen-Image, Wan and other video models),
all behind a small agent. Speech models stay on your computer.

The machine takes two to four minutes to start. Meanwhile:

- A bar under the header shows what is rented, the price an hour, how long
  it has run and roughly what that has cost, with **Stop** right there.
- Every chat model's card and window shows whether it fits the rented GPU.
- A model's window has one step, "Download the model on the chat server".
  The machine fetches it straight from Hugging Face at data-centre speed,
  and loads it into the GPU so the first message is quick.
- The chat box, the saved conversation and "Ask Claude to check this" work
  as before.
- Every image model gets the same two buttons. On the machine its one step
  is "Download the model on the rented GPU"; pictures are then made there in
  seconds, asked for by your browser directly, shown in the page and saved
  to your computer with Download. "Improve this" can have the same model on
  the machine paint over a picture, with Claude writing the edit if asked.
  Gated image models and ones published as several files stay on your
  computer.

### Stopping, starting and deleting

- **Stop** ends the hourly charge. The disk and the models on it stay, and
  RunPod charges for the disk every day, twice as much while the machine is
  stopped as while it runs ($0.20 a gigabyte a month: a 50 GB disk is about
  33 cents a day, $10 a month, for as long as the machine exists). The
  Settings card says the figure for your disk. **Start** brings the machine
  back in a minute or two with the models still there; if RunPod has no
  card of that kind free at that moment, try again later.
- **Delete machine and models** removes everything. Nothing is charged after
  that. It is the only way to end the disk charge.
- The machine **stops by itself** after a while without a chat, picture or
  download: 30 minutes on a cheap card, 10 on one costing $2 an hour or
  more, unless you set the minutes under the rented machine in Settings; 0
  keeps it running until you stop it. A download in progress always keeps
  it awake. **Stop the GPU when this finishes** under a download is ticked
  unless you untick it once (remembered in the browser); the stop comes a
  minute after the download and stands down when another of your
  downloads is still going, when a request is at work on the machine by
  then, or when the page sees requests waiting in that model's queue (it
  takes the flag back and says so in the step's log). **Stop the rented
  GPU after this picture** in the try box ends the bill the moment the
  work is done rather than after an idle wait.
- The page asks **whether you are still there** after 30 minutes without a
  click or key while the machine runs, downloads included, and stops it
  when nobody answers. The minutes are in Settings. That stop is refused
  by the site (409, `busy`) while the machine is at work on a request,
  asked from this window or any other: a working machine is never stopped
  by the check; the page stands down and asks again later. The idle stop
  defaults to 30 minutes whatever the card costs, and skips a busy
  machine as before.
- A stopped machine whose host has **no free card** ("No free GPU on this
  machine's host"): the page asks Start again every minute for half an
  hour by itself, says so in the bar with the count, and offers Stop
  asking and Replace the machine meanwhile.
- A **spend cap** stops the machine once the day's machines have cost the
  amount you set ($50 unless changed), counted across stops, starts and
  replaced machines from midnight UTC.
- **One machine at a time.** Renting is refused while another HuggingFound
  machine is running on the account, and stopped ones left from before are
  offered for deletion first, since each bills for its disk. The bar says
  when such machines exist even with nothing rented.
- **What a picture or clip costs** is said before you pay: each preset in
  the try box shows its time and machine cost at the rented card's price,
  from a guess at first and from the measured time after the first one;
  the rent confirm says the same for the model you opened, with the cost of
  loading a big model the first time.
- The Settings card shows **RunPod's bill for the account** for the last
  week, GPU time apart from disks and by machine, and lists any **other
  HuggingFound machines** on the account that this app no longer manages
  (from an earlier session, or under a key since removed), with what their
  disks cost a day and one button to delete them all.
- **Quitting HuggingFound stops it** too (Ctrl+C in the terminal, or
  closing the terminal). Untick "Stop it when HuggingFound quits" to keep
  it running without the app, and remember it is billing.
- If HuggingFound is not running, the machine still watches itself: it
  stops after the same idle time without word from the app, and after a
  day at most. Check the bar when you come back, or the pods page at
  runpod.io.
- **Replacing a machine costs the downloads again.** A fresh machine pulls
  the machine image (about 9 GB) and fetches its models again, all on the
  hourly rate; a 200 GB video model is a quarter of an hour or more on a
  $10 an hour machine before the first clip. Prefer Stop and Start, which
  keep the disk, and replace only when Start cannot find a card on the
  machine's host.

### What to know

- Ollama on the machine answers at a long random address RunPod makes for
  it (the machine's id and the port, on RunPod's proxy). Only this
  computer knows it, it is never shown on the hosted site, and it goes
  when the machine is deleted. Anyone who learned it could use the GPU, so
  keep the settings file to yourself.
- Gated models, and ones that need a file downloaded by hand, cannot be
  fetched by the machine through HuggingFound; their window says so.
- Fit and speed go by the card's memory; speed is a rough guess for a
  modern NVIDIA card.
- RunPod's stock is asked per card count and with the machine image's CUDA
  floor, so a pair of cards is offered only when some host has two free,
  not merely when the card exists. The sizes are kept for fifteen minutes;
  Refresh prices asks again. Stock still moves between the listing and the
  request: a card RunPod has just run out of is passed over for the next
  free card of the size, up to three, and when all are gone the sizes are
  refreshed and the card says so.
- Big files are fetched in pieces over several connections at once (byte
  ranges from the Hub's content network, eight 32 MB pieces in flight), the
  way the hf_transfer tool does; one connection rarely fills a data-centre
  link. A server that does not serve ranges gets one stream as before.
- The machine weighs a download against its disk before fetching, file by
  file as it goes, and stops with a plain message when the disk is full
  rather than dying partway; a folder that stopped partway is not taken for
  a whole model, and running the step again fetches only what is missing.
- A machine that stops under a download (its idle timer, the daily cap, a
  Stop, or RunPod itself) ends the step within seconds with the reason, not
  after minutes of waiting on a dead link. The files it fetched stay on its
  disk; running the step again starts the machine and goes on from them, and
  half-written parts from the cut-off are swept when the machine comes up.
  A download in progress keeps the idle timer from stopping the machine.
- A machine at work is never stopped: not by the idle timer, the spend
  cap or the still-there check. The site asks the machine whether it is
  busy (a picture or clip the browser asked it for directly, a download)
  before any stop of its own, the page tells the site the machine is in use
  every so often while a clip is made and holds the still-there check until
  it is done, and the cap stops the machine as soon as the work ends. A
  machine that stops under a clip anyway (a Stop from another tab, RunPod
  itself) is reported within seconds, with the reason, not waited on.
- "Suggest a better description" under the prompt (with an Anthropic key)
  has Claude read what was typed, and the starting picture when there is
  one, and write the description these models follow: literal and
  concrete, the motion spelt out, the camera stated, anything unwanted
  moved to the avoid list since the models cannot read "no" or "do not".
  It shows the suggestion, the avoid list and why, with Use it or Keep
  mine; nothing is sent until the button is clicked. At High the expansion
  shows the same way before anything is sent, editable, with Send this or
  Send my words as typed; what is in the box goes to the model as it
  stands, read by nobody again, and the caption says when it was edited.
- Starting from a picture (a picked one, or the last frame of a clip being
  continued), the words defer to it. The expansion and the next shot are
  written with the picture in front of Claude and a brief that says the
  person, clothes, place and light are decided by it and must be kept, not
  re-described; and the avoid list gets "a different person, changed face,
  changed hair, changed clothes, changed background, studio backdrop". Before
  this, an expansion written blind invented a setting, and the model
  followed the words over the picture: a different woman in a studio for a
  360 turn. A full turn still asks the model to re-imagine the face when it
  comes back; shorter turns and Medium or High hold identity better.
- A clip is asked for by length in seconds and a quality (low, medium,
  high); the page says what the model will make (the nearest frame count
  its video VAE decodes) and guesses the time and cost. The levels differ
  in kind: Low is a draft on a small canvas with 20 passes; Medium is the
  model's full trained canvas, 30 passes and the family's standard avoid
  list (used when nothing is typed to avoid); High is 50 passes and the
  words expanded first by Claude, with a key, into the detailed shot
  description these models follow best (shown in the log and the caption).
  A picture's Max preset expands the words the same way. Replies are never
  expanded: they revise the words that were asked. The guess is
  adjusted from the clips made here: each one's time is measured against
  the guess made for it, and the next guess leans on that.
- Several requests can be queued; the queue runs itself, each request
  starting as soon as the machine is free of the one under way, with no
  click, so a list left under a model keeps the rented GPU working. A
  request added while one runs waits and goes next. "Hold the queue"
  collects requests to start by hand with Start all. Those that start
  together are handed to the machine all at once, so it goes on with them
  even if the page is left, and the machine can be told to stop when the
  last is made (the stop waits for whatever is still queued). Everything made is kept in this browser under its model (up to
  2 GB, oldest out first) until removed, whatever happens to the machine or
  the window, and each finished result is also saved to the computer as it
  comes, up to a size set in the try box.
- The page sends the machine's secret only as the standard Authorization
  header: a browser asks the machine first whether a header may be sent,
  and a machine on an earlier image allows that one alone. The agent now
  allows whatever headers a page asks about, so a page newer than the image
  is never refused at that step; the secret check decides. The site's own
  calls carry a second header too, for a proxy that drops the first.
- A step that downloads many files shows "File N of M" in front of the
  percentage, with the bar running over the whole set.
- Each rented machine's agent is started with a secret of its own
  (HF_AGENT_TOKEN, made at rent and kept with the rental as
  RUNPOD_AGENT_TOKEN), and answers no request without it: not the page's,
  not the site's, not anyone's who has learned the machine's proxy address.
  The page gets it with the rental status, the site adds it to every call
  it makes to that address. Ollama on the machine's other port is still
  open to anyone with the address; it holds no results, but it can be used.
- The queue and the log live under the model, not in the window: leaving
  the model and coming back shows the queue as it was and the log as it
  stands, with the lines still coming, and a result made meanwhile lands in
  the window that is open then. A page reloaded while jobs ran finds them
  on the machine and follows them again.
- A clip longer than the model makes in one shot (on a model that starts
  from a picture) is made as equal pieces of at most that length, each
  from the last frame of the one before (the worker returns the last frame
  as a picture, GET /jobs/:id/last), kept and shown as they come, then
  joined on the machine (POST /jobs/join, ffmpeg concat, stream copy with
  an encode as fallback) into one clip kept as "N s in K pieces". The
  form offers the two apart: Short clip (one shot, the model's own range)
  and Long clip (from one second past that up to six shots' worth, a
  minute at most), each with its own length box range and remembered
  length, and the estimate line says how it will be made. With an
  Anthropic key there is a third, Scene: Claude lays the words out as
  shots (review mode "scene": the length asked and the model's one-shot
  range go to it; it answers "Shot N (T s): ..." lines, cut at rest, each
  repeating who and where). On a two-card machine (the 282 GB size) the
  worker puts a modular pipeline's text encoder on the second card and
  the transformer and decoders whole on the first (`on_two_cards`, mode
  "two-cards"), so MiniMax-H3 runs every pass at full speed instead of
  taking turns from the machine's memory; the pipeline is made to report
  the first card as its device, and hooks on the encoder move its inputs
  over and a top-level call's answers back. Image version 10. A scene goes by way of "Preview Claude's
  scene setup", which stands in for Generate and Add to queue: the shots
  show as editable rows (length and words, add and remove), then
  "Generate this scene", "Add to queue" or "Discard". The preview works
  while the machine is busy with something else (the next request can be
  prepared, picture and all, and read over meanwhile); then only the queue
  is offered, and the scene runs next by itself. What is in the rows goes
  to the model shot by shot, unreviewed, each shot from the last frame of
  the one before, then joined as "T s as a scene of N shots". No Shot
  lines: the preview says so, shows what Claude wrote instead, and the
  words can go as a plain long clip of equal pieces. The lines are read
  however they are dressed (bold, bullets, "seconds", a running-time
  range) and a closing "Note:" line is shown as Claude's note. With a
  starting photo in front of it Claude may write no shots; the page then
  asks once more with the photo described rather than shown
  (`pictureUnseen`), and says so above the rows and in the log. Scene
  only shows with an Anthropic key saved or entered. A machine from before joining
  leaves the pieces one by one.
- The front page carries a "Why use HuggingFound?" section under the
  search (`#why`, `.why-use`, `.reasons`, `.reason.lead-reason`), shown in
  home mode only (hidden by `body[data-mode]` for results and browse). The
  lead reason is the outage case: a team's one assistant stops answering
  and nothing else is up; HuggingFound opens the whole of Hugging Face,
  running on the person's computer or a rented card. Four more: every
  kind of model, runs where you choose, know a model before you fetch it,
  yours to keep; a closing note that open models are smaller than the
  largest paid services. Plain static markup in index.html; the scan's
  first step checks the headings and that it steps aside for results.
- Placement: twice in a day a two-card and a one-card H200 pod in EUR-IS-4
  sat listed as running with no container for ten minutes and more (the
  proxy answering 404 on both ports), while a pod in US-NC-1 came up in
  under four. The status now remembers such a data centre for a day
  (`RUNPOD_SLOW_DCS`, "EUR-IS-4@<ms>,…", written when a pod has been
  RUNNING without a runtime for ten minutes), the summary carries
  `slowDataCenters`, the bar's warning names the data centre and says the
  next rent is placed away from it, and `rent()` passes `dataCenterIds`
  (the data centres the catalogue lists the card in stock, less the slow
  ones; `GET /catalog/gpus?include=AVAILABILITY` gives `dataCenters` per
  card, kept on each tier's cards) when there is something to avoid; a
  stock refusal with a preference list is retried without one. Stub:
  `state.dataCenters[gpuId]`, default US-KS-2 and EUR-IS-4 for every card;
  `state.refusePlacement` refuses a create that names data centres; a pod
  lands in the first preferred data centre.
- Image 22: the agent's `usedGb()` walked the models folder and the
  add-ons folder and then their parent as well, so 142 GB read as 284,
  the disk as full, and each grow was followed by a demand for ten more.
  The walk now takes each folder once (a root inside another is dropped);
  the site sets aside a used figure larger than the disk itself (server
  `plausibleUsed`, plan `counted`) and goes by the models' sizes instead,
  which ends the loop for a machine on image 21 as soon as the site
  deploys, though that machine's own per-file check still refuses until
  it is replaced.
- Diagnostics (image 21). The machine keeps a journal on its disk beside
  the models (`journal.log`, 4 MB, oldest out): agent start with version,
  disk and idle settings; worker start and stop (with its last lines);
  every load (what, with which LoRAs, for which workflow; the mode and
  note it ended in); every job done (size, frames, seconds) or failed
  (what, the error, the worker's traceback); downloads. The worker's
  stderr tail is 200 KB in memory. The worker answers a failure with
  `trace` (the traceback, 6 KB) and `phase`; the agent keeps the last 20
  failures (`failures`, with kind/what/error/trace/phase/jobId). `GET
  /diagnostics` gives it all: version, uptime, env (HF_DISK_GB, the disk
  hint, idle, allocator), the Python check (now with versions of torch,
  diffusers, transformers, peft, av, accelerate, bitsandbytes,
  safetensors, CUDA, bf16, every card), the disk reading, models and
  add-ons on it, what is loaded (mode, note), the worker's state and tail,
  the image server's state, the last jobs and downloads, the failures and
  the journal's tail; `GET /journal?lines=N` the raw journal. The page: a
  failed request is followed in the log by "The machine's account: …
  (while …)" and the last 14 traceback lines, read from the report; the
  GPU panel has "Machine report" (a readable text of all of the above
  plus failures remembered in this browser from earlier machines,
  `machineFailures` in localStorage) with a Copy button, meant to be
  pasted when asking for help. The memory note on load names each
  component's precision and device.

## Verified on hardware, and not

What has actually run on a rented machine, so the same thing is not
tested twice, and what has not, so a first run is known to be one.

Verified (2026-10-15 to 17): MiniMax-H3 keyframe clips (fl2va) from
words and from a picture on 2×H200, including two-card placement; long
clips as pieces, joined; scenes from Claude's shots; fixes of one shot;
download stop-after; the still-there check refusing a busy machine;
LTX-2.5 download (36 files after the spare-shard trim), load with the
prompt enhancer absent, image-to-video reaching the transformer (ran out
of memory at 121 frames on one card with everything resident, image 15);
the disk quota error (-122) at 90 GB; the EUR-IS-4 host never starting a
container, twice; peft missing from the image (fixed, image 19).

Not yet verified: LTX-2.5 generating a clip (image 16's staging and
decode batching are the fix; a text-only 5 s at Low and then one from a
picture are the two tests); the MiniMax-H3 360 orbit LoRA end to end
(image 19 has peft); clips from reference pictures (ref2va, image 20);
the grown-disk size hint (image 21); the Machine report on a real
machine (image 21). When one of these runs, move it up and note the
date and the machine.
- A disk grown after the rent (image 21): the agent took its size from
  `HF_DISK_GB` once, so after a grow to 250 GB it still counted against
  160, reported 0 GB free, and the plan asked for ten more every time.
  Now every health call carries `?diskGb=` (the pod's mount size from the
  rent status, or the saved disk size from the site's probe), the agent
  keeps the last said size (`diskGbHint`) over the environment, and the
  plan's `diskRoom` always takes the rented size as the disk's size, with
  what is used from the machine's `diskUsedGb` (or its own total less free
  when those are plausible). Until a machine is on image 21, its own
  per-file room check still goes by the old size: a fresh machine rented
  with the disk it needs is the way round on image 20.
- Reference pictures and queued pictures (image 20). MiniMax-H3's ref2va
  workflow takes up to nine `MiniMaxH3ImageReference`s (people and things
  the clip is to show) and no keyframes; it runs on `transformer_ref`,
  the 62 GB partition the model's download leaves out. hf.js `repoFiles`
  lists that partition apart as `reference {files, gb}`; the folder plan
  adds an optional second step ("Download its reference-to-video part")
  and `tryWith.references` (true when the folder holds it, false when
  not) with `referenceGb`. The video box shows a "Reference pictures"
  multi-file input when the part is there, else a line with "Download it"
  (runs the optional step). Items carry `refFiles` and an `id`;
  `requestArgs` sends `references` (data URLs) and logs "From N reference
  pictures"; `submitJob` → agent `/jobs` (`references`, nine at most,
  validated like `init`) → worker: `load` takes `workflow` (the agent asks
  for "ref2va" when references come; the load key includes it, so the
  model is loaded again when switching), `load_modular(…, wanted_workflow)`
  refuses an unknown one, and `generate` builds the references, dropping a
  starting picture with a note. Results carry `refs`; captions say "from N
  reference pictures". Queue: pictures picked for queued requests are kept
  in the browser's database ("pictures" store, database version 2, by the
  item's id: start picture and references as blobs); `rememberQueue` saves
  them, the window restores them on open and drains, `ready()` waits for
  them, Remove and a finished result forget them. The queue line names the
  start picture and the count of references.
- Image 19: the image never had `peft`, which diffusers sets every LoRA
  through, so the orbit LoRA (and any SD LoRA) failed with
  ModuleNotFoundError on the machine. peft is in the Dockerfile and its
  import checked at build; `apply_transformer_lora` says plainly when it
  is missing; `AGENT_NEEDS["pull-lora"] = 19`, so a LoRA add-on's plan on
  an older machine asks for a replacement (IP-Adapters keep needing 4).
- Disk room (image 18): a MiniMax-H3 download died at file 30 with
  "Unknown system error -122" (EDQUOT: the pod's 90 GB volume is a quota
  on a larger pool). The agent's statfs of the models folder reports the
  pool (1.2 PB, 374 TB free), so the plan's room check passed. The rent
  now sends `HF_DISK_GB`; the agent's `diskSpace()` returns the quota
  (size from the env, used from a walk of its folders) when the pool it
  reads is more than twice that, `/health` adds `diskUsedGb`, and
  `outOfRoom(err)` maps EDQUOT/-122 beside ENOSPC to the "grow the disk"
  message. On the site, `withGpu` sums the models' sizes into
  `gpu.diskUsedGb`, and `diskRoom` sets aside a total more than twice the
  rented disk (an older agent) for the rented size less what is on it, so
  the plan offers "Grow the disk to 160 GB" before the download.
- LoRAs for MiniMax-H3 (image 17), for pablodawson/MiniMax-H3-360-Orbit-LoRA
  and its kind: categorize.js `videoLoraBase(model)` (a LoRA by name or
  tag whose tags or card name MiniMax-H3) lets such a repository through
  the "pieces of a model" rule as an image-family add-on for the diffusers
  runner; hf.js summaries carry `baseModel` and `triggerPrompt`
  (cardData.base_model / instance_prompt). plans.js `addonVariants(files,
  videoBase)` gives kind "video-lora" with the .safetensors weights (sample
  media left out); `addonPlan` takes as base only `<base>/model_index.json`
  on the rented GPU, returns a `video` spec (MiniMax's, from three seconds:
  the orbit LoRA was trained on 73 frames) and `tryWith {kind: "video",
  engine: "addon", addonKind: "video-lora", base, startPicture: "required"
  for first-last/orbit tags, lastPicture: "same", triggerPrompt, strength
  1}`. Page: the add-on box names the base ("Applied to MiniMax-H3"), the
  LoRA's words are filled into the prompt, a "Last picture" select (the
  same picture / none / another) sits under the starting picture, and the
  request goes to the base with `addon {kind: "lora", repo, file, scale}`
  and `lastInit`. Agent: `/jobs` takes `lastInit` like `init`. Worker:
  `apply_transformer_lora` renames ai-toolkit/ComfyUI keys
  (`diffusion_model.blocks.N.attn.qkv_proj|out_proj`, `mlp.fc1|fc2`,
  `token_refiner.blocks.N`) to the library's (`transformer_blocks.N.attn.
  to_q/to_k/to_v` with the fused projection split in three, `to_out.0`,
  `ff.net.0.proj`, `ff.net.2`, `token_refiner.refiner_blocks.N`), refuses
  a file naming modules the transformer lacks, and sets the adapter on the
  transformer (`load_lora_adapter` + `set_adapters`); `swap_loras` changes
  LoRAs on a loaded modular model without a reload; `last_image` goes to
  the fl2va workflow; with a LoRA on, the model's five-second floor is not
  enforced. Untested on hardware: the orbit LoRA end to end.
- LTX-2.5, fourth try (image 16): image 15 ran out of memory "while pass
  1" on a request from a starting picture: the worker's log showed the
  image-to-video pipeline failing in the transformer's feed-forward with
  138.6 GB allocated against 65 GB of weights, the rest unaccounted for.
  The worker now says on load what each component weighs and at which
  precision ("the model in memory: text_encoder 24.1 GB bfloat16, …"),
  puts the parts' weight, the memory in use and the peak into an
  out-of-memory message, and stages LTX-2 pipelines through the card with
  `enable_model_cpu_offload()` (mode "staged"; the image-to-video twin is
  staged too), so only the transformer stays resident during the passes.
  The image sets PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True.
- LTX-2.5, third try (image 15): the model loaded and the GPU ran out of
  memory generating a 121-frame clip at 768 by 512 on a 141 GB card with
  65 GB of weights. The traceback was lost with the machine; the numbers
  point at the video VAE decoding all 121 frames at once (its decoder's
  full-resolution activations run to tens of gigabytes), and diffusers
  leaves `use_framewise_decoding` off unless asked. The worker now sets
  `use_framewise_decoding` and `use_framewise_encoding` on any VAE that
  has them, beside `enable_tiling()`, and an out-of-memory failure names
  the stage it happened in ("while pass 3 of 8" / "while decoding the
  frames"), kept in `state["phase"]` from the step callback.
- LTX-2.5 on the machine, first try (2026-10-16): the load failed with
  "no file named model.safetensors … found in directory <the repo root>":
  a component the index names had no folder on the disk (the prompt
  enhancer, left on the Hub), and diffusers looks for such a component in
  the folder's root. Passing it as `None` to `from_pretrained` should
  skip it (`load_module` drops components passed as None); belt and
  braces, the worker now also marks absent components `[null, null]` in
  the on-disk model_index.json (a `model_index.json.hub` copy kept), says
  in the load note which components the index names, which are left on
  the Hub and which folders hold no weights, and refuses a folder without
  weights with "run the download again" (model components only: a
  scheduler, tokenizer, processor or feature extractor is configuration
  alone, which the first cut of the check got wrong; image 14). Image version 13. The repository
  also carries the transformer sharded two ways (four parts and eight, 38
  GB each) and the connectors as one file and as two parts: hf.js
  `withoutSpareShards` (in `hub.model`) reads each such folder's
  `*.safetensors.index.json` with the person's token and keeps the parts
  it names, dropping the spare sharding and the one-file copy (about 45
  GB less to fetch). runners.js `pollAgentTask`: the "machine restarted"
  detection used to throw inside its own try/catch and be swallowed, so a
  restarted agent (404 on the task) looked like a dropped line for five
  minutes and then was blamed on the connection; it is now told after
  three 404s as "the machine's agent restarted and no longer has this
  download's record; running the step again fetches whatever is missing
  from its disk".
- A pod RunPod lists as running whose container never comes up (a fresh
  host fetching the image, or a host not delivering) used to look like a
  machine that was merely slow: the proxy answers 404 on both ports, the
  bar says running, and a download waited ten minutes and said only "did
  not answer". The status now carries `containerUp` (the pod has a
  runtime) and `podNote` (RunPod's `lastStatusChange`, when given); the
  plan's step text and the download's log say "RunPod lists the machine as
  running, but no container has started on it" with RunPod's note and the
  data centre, every two minutes, and the ten-minute give-up names the way
  out (Replace the machine). `machineWait` in runners.js holds the ceiling,
  the note cadence, the status cadence and the poll, which tests shorten.
  The bar shows a warning with a Replace button once a running machine has
  gone ten minutes with nothing on it answering. Stub: `state.noContainer`
  leaves a running pod without a runtime and notes "Pulling image: 23%".
- LTX-2 and LTX-2.5 (Lightricks, gated: the LTX-2.x Community License
  accepted on the model page and a read token in Settings) are a video
  family of their own: `/ltx-2/i` in plans.js gives 24 fps, 2 to 10 s,
  8n + 1 frames, sound, cfg 3, levels 768×512 / 1280×704 at eight passes
  (the distilled schedule is fixed, so the levels differ by canvas and the
  High expansion), presets of 121 and 241 frames. The repository carries a
  modular index too, but model_index.json names the plain LTX2Pipeline,
  so the plan treats it as whole-on-card (`modular` false for LTX,
  recommended size gb × 1.15). hf.js `repoFiles` leaves `transformer_full`
  (110 GB), `prompt_enhancer` (Gemma, 10 GB), `latent_upsampler`,
  `temporal_latent_upsampler` and `diffusion_decoder` on the Hub, as it
  did MiniMax's `transformer_ref`, so the download is about 71 GB
  (distilled transformer 38, Gemma 4 text encoder 24, connectors 6, VAEs,
  vocoder, duration head). worker.py `load_folder` passes `None` for any
  component the index names whose folder was not fetched (the enhancer);
  `generate` detects an `LTX2*` pipeline: `fit_ltx_request` snaps the
  canvas to multiples of 32 (a starting picture's shape at the preset's
  area), frames to 8n + 1, passes `frame_rate`, and for a distilled
  transformer (LTX-2.5, or "distill" in the path) replaces the step count
  with `DISTILLED_SIGMA_VALUES` unguided and without a negative prompt;
  the soundtrack comes back as `result.audio` with the vocoder's
  `output_sampling_rate`; a starting picture goes through
  `LTX2ImageToVideoPipeline.from_pipe` (`ltx_twin`, made once; it needs
  PyAV, now in the image). categorize.js `describe` says "generates video
  clips from text or a picture, with sound" for video models. Image
  version 12 (diffusers ≥ 0.41, transformers ≥ 5.5, av).
- A clip made as pieces or shots (or any one of its pieces) is fixed shot
  by shot rather than made again whole: its reply box reads "Fix a shot"
  (the "change" mode routed to `fixClip`). Only the shots the complaint
  touches are made again, each from revised words with the seed it had and
  from the last frame of the shot before; the others are kept as they were
  (the newest kept piece for each index of the group), and all are joined
  again, with a reply caption ("piece 2 made again for it, the rest kept").
  Claude says which shots and writes their words (review mode "fix": the
  request, the shot list with lengths and words, and what is wrong go to
  it; it answers "Shot N: ..." lines for the shots to make again, "Carry:
  yes|no" for whether the shots after follow so the change carries
  through, and a "Why:" line); without a key, or when Claude names none,
  the shot is read from the reply ("in shot 2", "the second shot", "the
  last one", "at 0:12", "12 seconds in") and its words revised from it as
  a single clip's would be. The plan shows first under the clip: a tick
  per shot (ticking one with its old words still there puts the revised
  ones in; editing a row ticks it), the words, a carry tick, a total line
  with the time, then "Make the fix" (or add to the queue while busy) or
  Discard. The first shot made again starts from the photo the clip began
  from, kept with that shot (`startPicture`, the data URL the machine was
  sent); a clip from before that is made again from its words. The join
  (POST /jobs/join, image 11) takes `pieces`: each a job on the machine
  (`{id}`) or the clip itself sent up from the browser (`{video}`,
  base64, up to 400 MB a request), for pieces the machine swept (jobs
  live half an hour) or lost to a restart; the page probes each kept
  piece's job and sends up the ones not there. An older machine joins by
  job only; with a piece to send up, the page says so and the shots are
  kept one by one.
- A reply to a clip can continue it instead of changing it: the next clip
  starts from this one's last frame (the kept frame, or one read from the
  clip in the browser for older results) with the words for what happens
  next, written by Claude with a key and read from the reply otherwise, at
  the clip's own settings; it lands under the clip it continues.
- A reply's result lands right under the result it answers, with a caption
  saying so; every live card carries a caption (what was asked, the
  expansion, the settings). A result kept before its settings were kept
  with it has them read back from its caption for a reply.
- A result can be replied to, as to a person ("good, but I asked for two
  jump ropes and there is one"). The description is revised with the change
  in it, by Claude when a key is saved and from the words of the reply
  otherwise, and the same model is asked again with the same seed. A
  picture is painted over at a strength that fits the size of the change,
  so it costs that fraction of a fresh one and keeps the rest; a clip
  cannot be changed in place by the video models here, so it is made again
  whole, and the seed keeps the scene close. Every request carries a seed,
  which the machine reports with the result; a machine on an older image
  ignores it, and a reply there says the remake may differ more.
- A finished clip is fetched from the machine as bytes, apart from the
  status the page polls for; a machine on an older image sends it with the
  status, tens of megabytes at once, and the page waits for that patiently
  rather than taking a slow answer for a lost machine.
- At the day's spend cap with someone at the site (a touch within ten
  minutes), the stop is announced first: the bar says the machine stops in
  about ten minutes once nothing is being made, with a button that raises
  the cap by $25; nobody there, it stops at once, and never mid-request. A
  stopped machine may not start again if its host's card has been taken
  (RunPod pins a stopped disk to its host), so an announced stop is worth
  heading off when more work is coming.
- Nothing gives up on a request by the clock. The page follows a job for as
  long as the machine says it is at it (past twice the guess the log says
  so every ten minutes); "Give up on this" beside the log asks the machine
  to drop the job (POST /unload stops a worker in flight, the job fails with
  the reason, the next job starts a fresh worker). The agent's own limit is
  a silence, an hour with no answer and no step of progress, not a length.
  The site's idle check takes a machine it cannot reach for unknown, not
  idle, for half an hour. Before this, the page gave up at 30 minutes while
  the clip went on, and every retry queued behind it until a stop.
- A size that ran out of memory on the machine is remembered in the browser
  by model (the smallest load of frames by canvas that failed, and the
  largest that was made): the estimate line warns above it before asking,
  the failure says the longest clip at that quality that should fit, and Try
  again asks for that length. The worker runs with PyTorch's growing
  allocator segments, which avoids some of the fragmentation that fails a
  clip near the card's limit.
- A clip or picture that runs out of memory on the card fails with a plain
  message (fewer frames, a smaller picture, or a bigger card), and the
  machine's worker drops the model. The next job loads it again. A machine
  on an older image forgot to do so and answered "no model is loaded"; the
  page now resets such a machine, or restarts it in place through RunPod
  (same host, card and disk, about a minute), and asks again by itself.
- If the full machine image cannot be pulled (it is published as a GitHub
  package that has to be public), HuggingFound rents a plain Ollama machine
  instead: chat models work, image models stay on your computer, and the
  Settings card says so.
- The key and the machine's id are kept in HuggingFound's settings file on
  this computer, next to the other keys.
- MiniMax-H3 makes clips with sound, 5 to 15 seconds at 24 fps, on a
  canvas of multiples of 32; a request outside that is moved to the
  nearest size the model makes and the log says so. The machine loads only
  the half it uses (words or a first picture; 134 GB of the model's 196)
  and leaves the reference-to-video partition unloaded and undownloaded.
  On a card smaller than that the weights stay in the machine's memory and
  each model moves onto the card as its turn comes, the way the library
  runs it; a 141 GB card does this with little swapping.

## Set one up yourself

Any provider that gives you a Linux machine with an NVIDIA GPU and SSH
access works too. The rest of this page connects one of those safely.

### 1. Rent a machine

RunPod, Lambda, Vast.ai and others bill by the hour while the machine is on.
Pick the GPU by the size of the model file, which HuggingFound shows on every
card:

| GPU memory | Model files up to about | Examples |
| --- | --- | --- |
| 24 GB | 20 GB | 30B-class models at 4-bit |
| 48 GB | 40 GB | 70B-class models at 4-bit |
| 80 GB | 70 GB | 100B-class models, or 70B at higher quality |

Give it a disk larger than the models you plan to keep, since they are stored
there. On providers with a separate persistent volume, point Ollama at it so
the models survive a restart, for example `export OLLAMA_MODELS=/workspace/ollama`
before starting Ollama.

### 2. Install Ollama on it

Connect with the SSH command the provider shows, then:

```sh
curl -fsSL https://ollama.com/install.sh | sh
```

That installs Ollama and starts it, listening only on the machine itself
(`127.0.0.1:11434`). Leave it that way. If the provider's image has no service
manager, start it by hand with `ollama serve &`.

### 3. Open a tunnel from your computer

Ollama has no password, so it should never be opened to the internet. An SSH
tunnel carries it to your computer privately. In a terminal on your computer:

```sh
ssh -N -L 11435:127.0.0.1:11434 user@your-server-address
```

Use the user, address and any `-p PORT` or `-i KEY` the provider gave you for
SSH. The command prints nothing and stays running; that is the tunnel. Port
11435 is used on your side so an Ollama on your own computer can keep 11434.

### 4. Point HuggingFound at it

In **Settings**, under **Chat server**:

- Address: `http://127.0.0.1:11435`
- GPU memory on that server: the number from step 1, for example `48`

Save. The line underneath says "Connected to Ollama" with its version when the
tunnel is up.

From then on:

- Every chat, coding, math and vision model shows whether it fits the
  server's GPU, and its speed there, instead of on your computer.
- A model's window has one step, "Download the model on the chat server". The
  server fetches it straight from Hugging Face.
- The chat box, the saved conversation and "Ask Claude to check this" work as
  before.
- "Scan this computer" lists what the server holds, marked "on the chat
  server", with Remove to free its disk.

Image and speech models are not affected; they still run on your computer, or
on the image server if you set one.

### 5. When you are done

- Close the tunnel with Ctrl+C. HuggingFound will say the server is not
  answering until you open it again.
- **Stop the machine at the provider** to stop the hourly charge. Most keep
  charging a little for the disk while it is stopped; delete the machine to
  stop that too, and the models go with it.
- "Use this computer" in Settings switches chat models back to your own
  machine. Nothing on the server is touched.

### A private network instead of a tunnel

If the server and your computer are on the same private network, such as
Tailscale, start Ollama with `OLLAMA_HOST=0.0.0.0` on the server and use its
private address in Settings, for example `http://100.101.102.103:11434`. Only
do this on a network you control; anyone who can reach that port can use the
GPU and delete the models.

### Limits

- Gated models and models that need a file downloaded by hand cannot be
  fetched by the server through HuggingFound; their window says so.
- Ollama does not report its hardware, so fit and speed go by the GPU memory
  you entered. Speed is a rough guess for a modern NVIDIA card.
