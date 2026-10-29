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
- The front page (2026-10-28 redesign). A dark hero band (`#home.hero`)
  holds the headline in Bricolage Grotesque (the latin variable file is in
  `public/fonts`, OFL, served with a year's cache; nothing is fetched from
  Google), one sentence, the search, five example chips, and on the right
  the demo (`#demo`, `startDemo()` in app.js): one search typed out,
  three results, a download bar, a line of notes and a Claude check, on a
  13-second loop that pauses in a hidden tab; with reduced motion asked
  for it sits on its finished state. Under the band one line of category
  links (`#browse-invite`, inside the hero section). Then, in `main`: the
  (2026-10-28, later) nothing: the band fills the screen (`min-height:
  calc(100vh - 56px)`, the page's footer hidden on the front page) and
  ends in one line at its foot (`.hero-foot`): the cost in a sentence
  (free models, a GPU from $0.20 an hour) and the links About the
  developer and, on the site, Privacy. The picks rail, the cost figures,
  the two drawings and the reasons grid are gone; the front page is dark
  to the bottom (`body` outside results and browse) and fits a laptop
  screen without scrolling, which the scan checks. The band's category line shows only in
  results and Browse; the front page has one "Browse all models" button
  (`#browse-all`, which clicks `#nav-browse`). In results and browse
  modes the band shrinks to the search and the category line and `#why`
  is hidden by `body[data-mode]`.
  Palette: paper, a deep blue-black (`--dark`, the bar and the band run
  into each other, with a faint coral glow top right), and one coral
  (`--accent`) for primary buttons, links, live marks and sparks. The bar
  holds only the name (a link home) and Sign in or the account; Settings
  and Check an answer sit at the end of the category line, on every view;
  Check an answer only once a model has made something in that browser
  (`hf:made` in localStorage, set by a finished reply, a picture or a clip). The things the "vibe coded" write-ups name were taken out on
  purpose: the Tailwind slate-and-blue defaults, emoji as icons, feature
  cards in a grid, cards around every section, all-caps section titles,
  the headline-then-softer-subheadline hero, and the paragraph under
  every heading. The scan's first step checks the hero, the font, the
  demo's finished state, the tiles, the figures and that it all steps
  aside for results.
- The model window in screens (2026-10-28). `renderModel` lays the runnable
  window out as panes with a tab row (`.panes-nav`): Fit (`.fit-card`:
  the size large, one sentence from `fitSentence()` on whether it fits
  this Mac, a 16 GB laptop or the rented GPU, what it makes, and the
  speed as one word from `estimate().word`, Fast, Quick, Slow or Very
  slow, with the sentence as its tooltip; the Where buttons; a Set it up
  or Use it button), Set up (`#steps`), Use (`#try`) and What people say
  (`#voices`). One pane shows at a time (`#modal-body.staged`); the
  screen a model was left on is kept for the session (`state.pane`), a
  running step keeps Set up, and a ready model opens on Use. "All at
  once" (`hf:panes` = all in localStorage, which nothing on the page sets any
  more) lays them out in a column; the scan sets that for its pages and
  tests the staged window in a step of its own. Cards show the same one word
  (`speedWord` from the server) with the sentence as the title. On the
  site, Set up is two ways: "Let HuggingFound download it", which picks
  the rented GPU, and "Download it yourself", a fold with every step's
  title and command (no step text, all steps shown, since nothing is
  marked done there) and the app's install commands folded under it. In
  What people say the users' lines sit under one "User reviews" label;
  the author's line is gone (the card text stays under Sources); the
  "In HuggingFound" and "Not here yet" settings advice is shown in the
  try box instead (`renderAdvice`, `state.advice`), under the chat's
  instructions, once the model is set up. Elsewhere shows only the
  sources that had something; with nothing found the fold is hidden.
- Accounts and adult models (2026-10-28). `accounts.register`/`login`: an
  email and a scrypt-hashed password, `verified: false`; Google sign-in
  sets `verified: true` and, finding an unverified password account on
  the same address, drops its password (whoever proves the address owns
  it). Routes `/api/auth/register` and `/api/auth/login`, ten wrong tries
  per address then a quarter hour's wait. `auth.ready` is true on the
  site whether or not Google is set up; the Google line in the sign-in
  windows shows only with a client id. Adult models: `adultAccess(ctx)`
  is true on the site only for `isAdmin` (signed in, verified, address in
  `adminEmails`, default jbabyjbaby1@gmail.com) and on a local copy only
  with `HUGGINGFOUND_ADULT=1` (the scan's local server passes
  `adult: true`); `visible(m, ctx)` replaces the old visitor filter,
  `/api/state` carries `access.adult` and `user.admin`, the nsfw
  categories are left out of the state otherwise, the LoRA finder's
  adult switch and parameter are the owner's only, and `/api/model`
  answers 403 "This model is not available here." for an adult model.
  The page: the bar shows the first name as a button (`#account`) that
  opens the account window (`#account-view`: email, name, the keys on
  file masked, the machine, Settings, Sign out, Delete); Settings is one
  window in two columns (keys left, the rented GPU and the local-only
  servers right, the rest folded) with no account box. The account
  window closes on Escape or a click beside it, folds the keys under a
  "Keys on file" bar, shows a Role line to the owner only, and has a
  fold to change the name, or the email on a password account with the
  password given again (`accounts.update`, `POST /api/account/update`:
  the new address must be free, and starts unverified; a Google
  account's address cannot be changed). The dark page and hidden footer
  are scoped to `body.app`, so about.html and privacy.html stay light.
- Later on 2026-10-28: the window's tabs are Fit, Try model and Use; What
  people say is a small link beside the name (`#say-link`) that opens
  its pane; the all-at-once switch is gone (the preference still works
  when set, which the scan does). On the site, Try model shows two cards
  of equal weight: Download to your device (the app does every step; the
  button `#way-device` unfolds the three install lines) and Run on a
  rented GPU (`#way-rented`, recommended for larger models); the manual
  Ollama steps are gone. Models users report as refusing are always left
  out of a search (`hideRefusing` is fixed on; no toggle). The category
  line shows in Browse only; Browse all models and Check an answer are
  links in the footer.
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

## Less on the screen, and words that fit the clip (2026-10-18)

- Steps: one on show at a time (the first not done); the rest wait,
  hidden, behind "Then N more steps"; done steps shrink to a line. An
  optional step (MiniMax-H3's reference part) is offered where it is used,
  the clip window's "Add it", and shows in the list only while it runs.
- Kept results: this browser tab's session (sessionStorage
  `hfSessionStart`, kept over a reload) is on show; earlier ones fold under
  "Earlier sessions", drawn only when opened.
- The clip window has two tabs, Short clip and Scene. Inside a scene:
  Claude lays out the shots, or the words go in pieces (the old long clip;
  the only way when there is no Anthropic key). The level texts, length
  help, avoid, queue and save lines are a few words each; the level
  explanation waits behind "What the levels change". Strength says what it
  is: the LoRA's scale, 1 as trained.
- Pacing: every clip request to Claude (scene, expansion at High, Suggest,
  continue, remake, fix) carries the clip's length and a budget of about
  one distinct action every three seconds (`actionBudget`), since the model
  stops when its frames run out and action written past that is never
  made. A scene that cannot fit the events names the rest in its Note. A
  shot shortened by hand in the preview says "Written for N s" and offers
  Fit, which asks Claude (mode `fit`) to keep the actions that fit and name
  the ones dropped.

## Chat replies that never come (2026-10-19, image 23)

Measured on an A100 80 GB with Qwen3.8-27B-Uncensored Q4_K_M (Ollama
0.40.6, family qwen35, context 262144, 33.8 GB resident): about 20
tokens a second, and 40 s of thinking (800 tokens) before the first word
of a one-line bash answer. The page read only `message.content`, so the
thinking (`message.thinking`) showed as an empty "Thinking" bubble for
minutes; nothing capped a reply at Standard or Thorough; and a reply the
page gave up on went on generating on the machine (the RunPod proxy does
not pass a dropped connection to Ollama), with Ollama answering one
request at a time, so later messages, and tests, got no first byte for
minutes.

- The thinking streams into a fold above the answer and stays with it
  (not sent back to the model).
- A progress row under the messages: thinking or writing, tokens, rate,
  and a share of the expected length, learned per model and effort in this
  browser (`chatTokens:<model>:<effort>`, first guesses 350, 2500, 6000);
  Stop ends the reply.
- Caps: Standard 8192 tokens, Thorough 16384 (Quick 400 as before), tripled
  on 2026-10-21 to 24576, 49152 and 1200 after a model spent all of 8192
  thinking over a 16,000-token digest and never answered; a model that
  still thinks its whole budget away is asked again at once to answer
  from its notes with thinking off; a reply
  stopped at the cap says so.
- Later the same day the same question (a 9.2 MB .exe, the Q RTX 6000)
  ended with "Thought it through, about 6,575 words" and no answer and no
  note: the thinking closed under the new cap, so Ollama's end was not
  "length" and the second ask never ran. Now any reply that has thinking
  and no words gets the second ask, whether Ollama said stop, length, or
  the stream ended without a last line; an empty reply always carries a
  note saying which it was. The agent (29) ends a chat whose Ollama
  stream breaks off before a `"done":true` line with an error line of
  its own ("Ollama's reply ended early") instead of a silent close.
- No first word in 30 s: the row says the machine is likely busy with an
  earlier reply and offers Free the machine, the agent's new
  `POST /ollama/restart` (image 23; older machines are told to Stop and
  Start). `/diagnostics` carries Ollama's log tail.
- The local relay now aborts its Ollama request when the page leaves.

## Coding with the rented model and Claude together (2026-10-19)

With an Anthropic key, three separate things on a chat model:

- Hand the hard parts to Claude (a switch under the effort, kept in this
  browser as `handoff:chat`). Before the message goes, Claude
  (`kind: "code", mode: "handoff-plan"`) names at most four parts a model
  of that size tends to get wrong, as `Part: name | what | why` lines. The
  model gets the request plus a fixed brief: write all it can, say first
  what it leaves to Claude, and leave a stub per part whose body is a
  comment starting `HANDOFF TO CLAUDE: <name>` with a method description,
  called as if it worked. The transcript keeps what was typed; the words
  sent are on the message as `sent`, shown in a fold under it.
- Claude: check and fix the code (`mode: "fix"`), on any answer with code:
  `Found:` lines, then `=== Corrected ===` and the whole answer corrected.
- Claude: write the parts handed to it (`mode: "finish"`), on an answer with
  a `HANDOFF TO CLAUDE` stub or from a handed-off request: `Wrote:` lines,
  then `=== Finished ===` and the whole program with the parts written to
  the model's names, signatures and style.
  Either result joins the conversation on a click, as Claude's version.

## Blackwell cards and the Community Cloud (2026-10-19)

RunPod's Secure Cloud had no A100, H100 or H200 free for hours while its
console listed Blackwell cards (RTX PRO 6000 96 GB, RTX 5090, B300 MIG)
and Community Cloud stock. The image is now built against CUDA 12.8 with
compute 10.0 and 12.0 for stable-diffusion.cpp, and torch from the cu128
index, so Blackwell cards are offered (a Blackwell pod asks for a host
with CUDA 12.8; others still 12.4, the libraries running on any 12.x
driver by minor-version compatibility). GB200/GB300 stay out: ARM hosts.
Not yet run on a Blackwell card.

`RUNPOD_COMMUNITY=1` (Settings, "Also rent from RunPod's Community
Cloud", off by default) asks the catalogue with `cloud=COMMUNITY` as well;
Secure cards stay first, Community ones fill a size Secure has none of,
priced from `price.community`, rented with `cloud: "COMMUNITY"` and no
data-centre placement, and labelled in the list and the bar
(`RUNPOD_POD_CLOUD`).

## Everything in a window survives leaving it (2026-10-19)

A model's window is drawn afresh each time it opens, so anything kept only
in its DOM was lost. Kept now, and drawn back as it stood (a job still
running goes on drawing into whichever window is open):

- Chat: Claude's code check and hand-off finish on each answer (`m.code`,
  with the text so far and the phase), Improve or check (`m.improve`,
  with "Use this as the answer"), the hand-off split (`m.handoff`), a
  reply still streaming with its thinking, the progress row, the words
  being typed (`chat.draft`). Finished work is saved with the
  conversation; work cut off by a reload says so.
- Clips and pictures (per model, in `state.runs[repo]`): each card's reply
  box (open, words, mode, last line), the fix plan with its ticks, words
  and carry (`fixPlans`), the scene preview and its edits
  (`scenePending`, handed to the window on show if it was reopened while
  Claude worked), Claude's suggestion, and the prompt and avoid words.

## Rent when available (2026-10-19)

A sold-out size offers "Rent when available" (Settings and the model
window). The person sets the most it may cost an hour (the listed price
plus 15% to begin with), the disk, how long to watch (1 to 72 hours) and
how long to hold the machine once rented (0 to 240 minutes). The watch is
kept with the account (`RUNPOD_WATCH`, plain "gb|disk|price|since|until|
hold|origins") and checked by the server every minute (`checkWatches`,
also at once when it starts), so it runs with the page closed and through a
restart of the site (`accounts.withWatch()`). On a free card within the
price it rents, sets `RUNPOD_HOLD_UNTIL` (the idle stop and the page's
still-there check stand aside until then), and keeps the outcome in
`RUNPOD_WATCH_RESULT` ("rented|at|text", also "expired" and "cancelled").

How the person is told: a Web Push notification (VAPID keys made once in
DATA_DIR/push-keys.json; the browser's subscription kept with the account
as `RUNPOD_PUSH`; `public/sw.js` shows it and opens the site on a click),
which appears as a system notification with the tab closed while the
browser runs. With the tab open, the page polls every 30 s and adds a
chime, a "● GPU rented" tab title and a notice; on coming back later it
tells once (`watchSeen` in this browser). Not yet seen on a real phone or
desktop push service.

## Vast.ai as a second place to rent (2026-10-19, image 24)

A Vast.ai key (Settings, under RunPod's; `VAST_API_KEY`, kept like the
RunPod key) adds Vast.ai's cards to the same list: each size keeps its
RunPod row, and gets a row of Vast.ai's cheapest offer for it, marked
"Vast.ai" with the host's place and its download price. The model window's
size list holds both too. Either key alone works.

- `src/vast.js` speaks Vast.ai's API (console.vast.ai/api/v0): offers from
  `POST /bundles/` (verified, rentable, not rented, the card count, CUDA
  12.4 or newer, two direct ports, reliability 0.95, 200 Mb/s down, amd64,
  on-demand, the price with 50 GB of disk), rent with `PUT /asks/{id}/`
  (the image, the disk, label "huggingfound", runtype "args" so the
  image's own entrypoint runs, `-p 11434:11434` and `-p 7860:7860`),
  `GET /instances/{id}/` (`{"instances": null}` once gone), `PUT` with a
  state to stop or start, `PUT /instances/reboot/{id}/`, `DELETE`.
- `rent.js` keeps one rental: the machine in force says where it is
  (`RUNPOD_POD_PROVIDER` "vast"), and stop, start, restart, delete, the
  status, the idle stop, the spend cap, "Rent when available" (RunPod's
  card first, then Vast.ai's, within the price) and the other machines on
  the account all branch on it. A Vast.ai disk cannot be grown (the grow
  step says to replace the machine); its price a GB a month is the host's
  (`RUNPOD_POD_DISK_RATE`), the same running or stopped.
- HTTPS: Vast.ai gives only the host's IP and mapped ports. With
  `HF_TUNNEL=1` the image's start.sh opens a Cloudflare quick tunnel for
  Ollama and one for the agent (cloudflared is in the image, image 24);
  the agent reads their addresses from the logs and says them on /health
  (`tunnels`). The site asks that at the mapped agent port over plain HTTP
  with the machine's secret, keeps them (`RUNPOD_POD_URL`,
  `RUNPOD_POD_AGENT_URL`, only `https://*.trycloudflare.com`), and points
  chat and pictures at them. They change at every start, so a stop or
  start forgets them and they are learned again.
- The agent's idle stop asks Vast.ai to stop the machine
  (`CONTAINER_ID`, `CONTAINER_API_KEY`, which Vast.ai sets in every
  container) before exiting, since an exited container there would leave
  the card billing; and the site stops a machine whose container ended
  while it was meant to run.
- A stopped Vast.ai machine starts again only on its own host; while that
  card is taken it waits, and the panel says so (`waitingForGpu`) with
  Replace the machine.

Not yet verified on Vast.ai itself: the search filters as Vast.ai takes
them, a rent, the image pull time, the tunnels coming up and carrying
chat streams and picture jobs, the self-stop with the container key.

## Skipped passes, faster cards, and LoRAs per shot (2026-10-20, image 26)

Skipped passes. MiniMax-H3 is guidance-distilled: one forward pass a
step, no unconditional pass, so `cfg` does nothing there and the only
levers are steps, canvas and frames. "Skip passes that barely change"
under the quality levels (per model, kept in this browser as
`fastPasses:<repo>`) sends `cache: 0.1` with the job; the agent passes it
to the worker, whose `pass_skipping(pipe, threshold)` turns on diffusers'
first-block cache (TeaCache's idea: run the first block, compare its
change with the pass before, and when within the threshold reuse the
rest of the last full pass) on the denoiser for that one generation and
takes it off afterwards. MiniMax-H3's blocks are not in the library's
block registry, so the worker registers them (one tensor in, the same
back), and its denoising loop opens no cache context, so the worker
wraps the denoiser's forward in one. The page guesses 0.65 of the time;
the real ratio is untested on hardware (expect 1.3 to 2 times on clips,
less on short ones). Checked on the tiny transformer in
test/minimax_cache_check.py: threshold 0 changes nothing, 0.1 skips some
passes and stays within cosine 0.98, the hooks are gone afterwards.
Machines before image 26 ignore `cache` (the page says so).

Faster cards. Every card in the rent options carries `speed` (src/speed.js
`gpuSpeed`, an L40S as 1: H100 2.8, H200 3.2, B200 4.2, RTX 5090 2.1,
A100 1.6, RTX 4090 1.5, A40 0.7). The model window's rent offer names
up to three cards at least as big as the pick and a third or more faster,
with the cost per clip next to the pick's (price up over time down).

LoRAs per shot. A scene's shot rows each list the LoRAs on the machine
with a tick and a strength, starting from the model's ticks; a shot's
choice goes with its piece (`shot.loras` → `item.shotLoras` →
`loraJobPart(t, own)`), is kept on the entry (`loras`) so a fix remakes
the shot with the same, and "Fit the words to the LoRAs" sends that
shot's words with its ticked LoRAs through the suggest mode, takes the
Description and the Strength lines, and notes why. Every shot still
starts from the last frame of the one before.

## Settings for visitors, and a Vast.ai key at the rent prompt (2026-10-20)

On the hosted site the Settings button shows for everyone, signed in or
not. A visitor who saves a key there (RunPod, Vast.ai, Anthropic, Hugging
Face or Civitai) becomes a guest through `/api/guest`, which now takes all
five; the page routes a visitor's saves there and skips their clears,
and `/api/settings` answers 401 to a visitor so nothing is dropped on the
floor. The guest's keys and machine last twelve hours after the last use,
as before. The model window's "Renting a GPU takes a RunPod or Vast.ai
API key" prompt takes either key or both; one is enough to rent.

## Visitors see no adult or video models, and no LoRAs (2026-10-23)

On the hosted site a visitor the server does not know (no session, or a
guest whose keys hold no Anthropic key) gets a filtered catalogue:
`fullAccess(ctx)` in src/server.js is true on your own copy, for anyone
signed in, and for a guest with `ANTHROPIC_API_KEY` in their settings;
otherwise `forVisitors(m)` (not `adult`, `kindOf(m) !== "video"`) is
applied to `/api/find` (hub, scan and picks; Civitai hits marked nsfw
dropped), `/api/search`, `/api/models` and `/api/voices/search`, and
`/api/model` answers 403 for an adult or video model, as do the four
`/api/loras` routes. `/api/state` carries `access.full`; the page hides
the "video generation" example and the LoRA fold, and a line at the top
of a model's window (`.visitor-note`), where a model is about to be used,
says what opens them (2026-10-28: moved there from the front page's
hint). Nothing about adult content is advertised to a visitor.
Page and server: a Render deploy, then a reload; no GPU change.

## HTTP 403 on a chat: the proxy's firewall, or Ollama's origins (2026-10-21, image 28)

Seen on hardware (2026-10-21, a Quadro RTX 6000 on image 27): "Ollama
replied HTTP 403" on the hosted site, in a conversation with a 9.2 MB
.exe attached, on a fresh machine too. The Machine report had come
straight from the agent, which checks the same origin list as Ollama, so
the page's address was allowed; what blocked the request was the proxy
in front of RunPod's addresses, Cloudflare, whose web firewall answers
403 to a request body that reads like an attack payload, and a binary's
strings do. The files travel with every later message, so the whole
conversation was blocked from then on.

The fix, image 28: the agent carries chats. `POST /chat` on the agent
takes `{ b64 }`, the Ollama request base64-wrapped (a firewall reads
nothing in it), decodes it, hands it to Ollama next door and streams the
answer back; the page uses it whenever the rental's agent is 28 or
newer, and the plain route to Ollama's address otherwise. The page also
reads a 403's body now: a Cloudflare page means the firewall, and the
message names the attached files and the way out (a machine on the
current image, or a new chat without the file); anything else means
Ollama refusing the page's address, which the message names with the
site's own address and "replace the machine".

Seen next on hardware (2026-10-21, 13:51): with the new page the error
read "Not on the hosted site", the hosted server refusing its own
`/api/chat`, which the page uses only when the site holds no chat address
for the machine (`state.chatServer` empty) even though the rental and
its agent were known. The old page had hidden that body behind "Ollama
replied HTTP 403", so every 403 that day was this, not the firewall. Why
the address was missing is not known: the site saves it at the rent and
at every start. Now the page needs no address on the hosted site: a chat
goes to the rental's agent whenever the machine has one; with no route
at all the message names the machine's state and the way out; the agent
starts Ollama again once when it is not answering; and the Machine
report prints a "Chat:" line (address saved or not, route in use,
whether Ollama answers the site's check, chat model count).

Then, with the chat reaching Ollama: "request (149233 tokens) exceeds
the available context size (131072 tokens)". The window is set as large
as the model allows, so that limit is the model's own; the 9.2 MB
executable's strings (up to 200,000 characters, mostly hashes and
compressed data, near a token a character) were the weight. The digest
now keeps only the strings worth reading (`stringScore` in app.js:
paths, addresses, registry keys, file and API names, format strings,
messages with words, anything about hardware, serials, licences, keys
and identity; letter salad, symbol soup and mixed letter-digit runs
score nothing) within 40,000 characters, about 16,000 tokens at worst;
the token estimate counts symbol runs as tokens so the chip's warning
is honest; and Ollama's context error is said in plain words with both
counts.

Then "Failed to fetch" (2026-10-21, 14:51): the browser could not read
the machine's reply at all. Across origins an error page from the proxy
in front of the machine carries no CORS headers, so a 502, a block or
Cloudflare's 524 (nothing said for 100 seconds) all show as a bare fetch
failure, and the page's reading of a 403's body only works on the
server's own proxy. The likely one was the 100 seconds: the agent sent
nothing until Ollama's first word, and a big model loading and reading a
16,000-token digest takes longer. Image 29: the agent's `/chat` answers
at once with a blank line and a heartbeat (`{}`) every ten seconds until
Ollama's first word, and says Ollama's errors on a line of their own; the
page skips blank lines. A reply the browser still cannot read falls back
to the plain route when there is one, else is said for what it is, with
the Machine report as the next step.

Then, on a Vast.ai machine (2026-10-21, 15:42, image 28 although 29 was
published): the agent's journal read "chat: Ollama did not answer (fetch
failed); starting it again" while the site saw Ollama answering. Node's
fetch gives up when no headers come for five minutes, which a big model
loading and then reading a 16,000-token digest on a Quadro RTX 6000 can
take, and the agent took that for Ollama being down and killed it
mid-request. Image 29 asks Ollama over a plain request with no clock on
it and starts Ollama again only when nothing listens on its port. The
older image on a fresh machine was the host's cached "latest": every
build is also tagged with its commit, so a rent now asks for the image
of the site's own commit (`pinnedImage()`, from RENDER_GIT_COMMIT or
git) when the registry has it, and "latest" only until the build is
through.

The app on a computer has the same path: its server's `/api/chat` proxy
carries the chat to the rented machine's agent (image 28, falling back to
the plain route when the agent says 404) and, when a request is still
refused, answers with a plain error the page shows as it is: a firewall
block names the attached file from the message's fenced headings, a bare
403 means Ollama refusing the address, anything else carries Ollama's
own words. Before this the proxy passed the 403 through and the page
blamed the model download, whatever the page's version.

Origins. A machine used to be rented for one address, `SITE_ORIGIN` or
the host the rent request came through, so a visitor at the site's other
spelling (with or without "www") was refused. `pageOrigins()` in
src/server.js now rents with the site's address and the request's, each
with and without "www"; a machine rented before keeps its single address
until replaced.

## fp8 weights, compiled blocks, and files for a chat model (2026-10-20, image 27)

Two more speed switches under the quality levels of a video model on a
rented machine, next to "Skip passes that barely change", each per model
and kept in this browser (`fp8Weights:<repo>`, `compiledBlocks:<repo>`),
each sent with the job as a plain `fp8: true` or `compile: true`. The
agent (27) passes both to the worker's load: fp8 is part of the load key,
so changing it loads the model again; the compiled blocks are set or
unset on the loaded model without a reload.

fp8 weights. `fp8_weights(pipe)` quantises the linear layers of the
denoiser's `transformer_blocks` with torchao's
`Float8DynamicActivationFloat8WeightConfig` (per row), weights and
activations both, so the passes' matrix products run on the card's fp8
units: about twice the bf16 rate on paper, and the blocks take half the
memory (MiniMax-H3's 62 GB transformer becomes about 31). It needs a card
of compute capability 8.9 or more (Ada: L4, L40, L40S, RTX 4090; Hopper:
H100, H200; Blackwell: RTX 5090, B200, B300; not the A100, A40, A6000 or
3090) and the torchao library, which the image installs from 27. The
worker's check reports `fp8` and `fp8Why`; the agent's `/health` carries
`fp8`, the site puts it on the rental as `fp8`, and the page disables the
switch with the card's name when it is false. When the quantisation
cannot be done the worker says why in the load note and goes on in bf16.
LoRAs load on the fp8 blocks through peft as before; the worker casts
peft's small matrices back to the working precision, since peft would
cast them to the base weight's fp8. Only the first part is checked
locally: torchao refuses fp8 on a machine without the units and the
worker says so plainly (test/minimax_fast_check.py). The speed, the
memory and the LoRA path on fp8 blocks are untested on hardware; the
page guesses 0.75 of the time.

First run on hardware (2026-10-22, H200 NVL 141 GB, MiniMax-H3 134 GB,
image 29): the model loaded in "turns" mode (its parts take turns on the
card through diffusers' ComponentsManager), fp8 quantised 350 layers
"(0.0 GB less in memory)" because the weights sat in the machine's
memory at the time, and every clip then failed at the first move of a
block onto the card: `RuntimeError: Attempted to set the storage of a
tensor on device "cuda:0" to a storage on different device "cpu"` out of
torchao's aliasing hook under `module.to(cuda)`. torchao's fp8 tensors
cannot be moved between devices, so fp8 is for a model that stays on the
card. Image 30: `fp8_allowed(mode)` in the worker refuses fp8 in the
turns, offload, staged and cpu modes with the reason in the load note
and the job's progress, and allows it in gpu, two-cards and multi-gpu;
the two-card path is still unverified. A machine on image 29 with the
fp8 switch on fails every clip of a model held in turns: turn the switch
off, or replace the machine. The same report showed "Python ?, torch ?"
and "peft none": the agent's startup check kept only `ok`, `gpu` and
`vramGb` of what the worker's `--check` printed, so the versions (and
`fp8`, which the page's switch goes by) never reached the report or
`/health`; image 30 keeps every field. AGENT_VERSION is 30, so machines
on 29 and before are told to be replaced.

Next clip on image 30, fp8 off, a long scene: every shot failed with
`TypeError: MiniMaxH3Transformer3DModel.forward() missing 5 required
positional arguments: 'token_tags', 'position_ids', 'video_indices',
'audio_indices', and 'text_indices'`, the call going through the
worker's `forward_in_context` (pass skipping), accelerate's offload hook
and diffusers' peft wrapper. diffusers 0.41's MiniMax-H3 denoise block
builds its layout kwargs from `inspect.signature(transformer.forward)`,
and the pass-skipping wrapper, a bare `(*args, **kwargs)`, hid every
parameter, so those five were never passed. Image 31 wraps it with
`functools.wraps(original_forward)`, which `inspect.signature` follows
to the real forward (test/minimax_fast_check.py asserts it). On image
30 and before, turn "Skip passes that barely change" off for MiniMax-H3
or replace the machine. AGENT_VERSION is 31.

Compiled blocks. `want_compiled(pipe, on)` gives each block of
`transformer_blocks` a `torch.compile`d forward of its own (and takes
them off again); as the blocks share one code, the compiler does the
work once, at the first pass, which is why the first clip after a start
waits a minute or two, and again after a LoRA change (peft swaps the
linear layers under the compiled forwards, so the compiler runs once
more; the dynamo cache limit is raised to 64 for it). Pass skipping
installs its hooks over the compiled forwards and hands them back when
it is removed. Checked locally on the tiny transformer: compiled blocks
match plain to 1e-4, skipping still skips 6 of 12 passes on top of them,
and setting them back restores the plain forwards. The gain is untested
on hardware; the page guesses 0.85 of the time. Both switches can be on
together with skipping; the page multiplies the guesses.

Files for a chat model. "Attach files" and "Attach a folder" under the
chat box take code and text files (a folder's node_modules, .git, build
output, dotfiles and binary files left out; at most 60 files, 400 KB
each, 600 KB together); they show as chips with a token estimate (a
warning past 24,000) until the message goes. The message to Ollama puts
each file under `### name` in a fenced block, the person's words after
them; the bubble shows the words with the files folded under, and the
files travel with the conversation so follow-up questions still have
them (`m.files` on the user message, `withFiles()` when the history is
sent). Ollama's usual window of 4096 tokens would silently cut the start
of a long request, so `contextFor()` sets `num_ctx` in steps of 4096 to
hold the conversation and the answer's room (up to 131072) whenever the
usual window would not; the hosted proxy on the machine and `/api/chat`
already pass `num_ctx` through. When the browser's store will not hold
the files' text the conversation is saved with their names alone.

## The shot preview as cards, with a line to Claude (2026-10-22)

Claude's shots for a scene were on show before anything ran, with a
LoRA row per shot, but a long clip at High went another way: the better
description came as one text, then cut into equal pieces unseen. Now a
long clip at High (`item.expand` with `pieces > 1`, Claude at hand, not
a reply or a continuation) is turned into a scene of the same length on
its way through `withExpansion`, so Claude's better description comes as
the shots it would make, all shown together.

The preview is cards: a head line (Shot N, the length, Remove), the
words, the LoRAs folded behind one line that says what is on ("Add a
LoRA" or "LoRAs: Motion 0.70"; the rows inside tick and set strength as
before, with Fit the words to the LoRAs), and a line to Claude ("Ask
Claude to change this shot"). Under the list, one line for all the shots.
Claude's modes in src/review.js: `revise` (one shot: Description and
Changed lines; the shot's ticked LoRAs go along with how their creators
prompt for them) and `revise-all` (every shot back as Shot lines, then a
Changed line; the rows are rebuilt and each row's LoRAs kept by place).
What Claude changed is said in one line under the shot or the list. The
rows go to the machine as they stand, unreviewed, as before.

Each shot has its own avoid list as well (2026-10-22, later). The scene
mode asks Claude for an "Avoid:" line under every Shot line: the few
things the model is likeliest to slip into that shot (the movement cut
before it, an extra person, a change of clothes or light between shots,
a camera move), or the word nothing; the request's own avoid list is
said to go with every shot and is not repeated. `parseShots` attaches
the line to the shot before it (`negative`, "nothing" as empty). Each
card shows it in an Avoid field under the words; `revise` takes the
shot's list in and gives it back revised (an Avoid line between
Description and Changed), `revise-all` the same per shot, and Fit the
words to the LoRAs sends the shot's own list rather than the request's.
A shot goes to the machine with `joinAvoid(item.negative, shot.negative)`:
the request's list (the typed one, or the family's standard list above
Low), then the shot's, each phrase once. The lists are kept with the
preview (`pending.got.shots`), with the queued item (`item.shots`) and
with the made clip (each piece's `negative` is the joined list), so a
fix re-makes a shot with the list it had. Page only: a reload.

## LoRAs and fine-tunes for video models (2026-10-20, image 25)

Every video model on the GPU has an optional "LoRAs and fine-tunes" fold
under its prompt. "Look for LoRAs" asks Hugging Face for repositories that
name the model as their base (`base_model:adapter:` and
`base_model:finetune:`) and Civitai for models filed under its base there
(`CIVITAI_BASES` in src/loras.js; "MiniMax H3" so far), safe-for-work
listings only. One is added to the machine with the existing pull-addon
step; a Civitai file comes from its download address
(`civitai.com/api/download/models/…`, the only form the agent fetches
from there) with the person's Civitai key (Settings, Hugging Face and
Civitai, `CIVITAI_TOKEN`), stored as `civitai/<model id>/v<version>_f<file>.
safetensors`. Civitai lets only signed-in accounts download, LoRAs too.

Ticked LoRAs (up to four, each with a strength) and a chosen fine-tune go
with each clip (`loras`, `finetune` on the agent's /jobs) and become the
worker's adapters; what is added and ticked is kept in this browser per
model (`loras:<repo>`), so the window reads the same when opened again. A
LoRA's trigger words lead the description. A machine before image 25 is
told to be replaced rather than make the clip without them.

- LoRAs for MiniMax-H3 come in three spellings: ComfyUI's
  (`diffusion_model.blocks.N.attn.qkv_proj.lora_A`), the same with an
  `.alpha` per module, and Kohya's (`lora_unet_blocks_N_attn_qkv_proj.
  lora_down`). The worker renames them, splits the fused projection, folds
  alpha / rank into B, and swaps the feed-forward's halves: ComfyUI keeps
  `fc1` as [gate | up] and the library as [up | gate] (checked against the
  published weights). Before image 25 that swap was missing, so a LoRA's
  feed-forward part went to the wrong half (the orbit LoRA included).
- A fine-tune (DaSiWa's MiniMax-H3 and the other Civitai checkpoints filed
  under MiniMax H3) is a whole transformer in ComfyUI's layout.
  gpu/comfy_minimax.py builds the library's transformer from the base's
  config and reads the file in: query, key and value split, the halves
  swapped, 8-bit weights turned back (integers times row scale, then the
  ConvRot rotation: a normalised Hadamard over groups of 256, its own
  inverse; checked on Comfy-Org's int8 file against its bf16 twin, cosine
  0.9999), fp8 with its scale, and the curve form (ComfyUI's pruned
  MiniMax-H3): the time embedder replaced by the 1025-row table read at t
  in [0, 1] and narrow AdaLN projections with no activation. The base's
  own 67 GB transformer is never read; DaSiWa's comes to about 39 GB at
  bf16. 4-bit packs, GGUF and several-head distilled files are refused
  with the reason.
- Checked on a tiny transformer with the real library
  (test/comfy_minimax_check.py, test/minimax_lora_check.py, run by
  test/comfy-minimax.test.js when `HF_TEST_PYTHON` names a Python with
  torch, diffusers, peft and safetensors).

Links and adult listings (2026-10-20): a link pasted under the finder is
read as one item (`/api/loras/link`, `parseLink`): a PromptHero model page
(`prompthero.com/ai-models/<name>-<number>-download`, a copy of the Civitai
model with that number), a Civitai page (civitai.com, .red or .green; the
version a `modelVersionId` names, else the newest) or a Hugging Face
repository. One made for another base model is refused with the reason.
"Include 18+ results" (off unless ticked, kept in this browser as
`lorasAdult`) asks Civitai with `nsfw=true`; adult items carry an 18+ mark
and are confirmed once before the download, as adult models are elsewhere
on the site.

The creator's settings (2026-10-20): every LoRA and fine-tune, added or
just found, has a "Creator's settings" button that reads how its creator
got the clips that show it off (`/api/loras/recipe`, `recipe()` in
src/loras.js). For a Civitai model it is the version on the machine
(`/api/v1/model-versions/<id>`: the notes, the trigger words, the showcase
clips with the prompt each was made from and, where the upload kept them,
its steps, guidance, sampler and ComfyUI workflow, walked for this LoRA's
own strength, the other LoRAs beside it, the checkpoint under it and the
canvas), ranked by the reactions on the creator's own posts
(`/api/v1/images?modelVersionId=&username=`; the public images listing
carries no prompts, the version does). For a Hugging Face repository it is
the model card: `instance_prompt`, the widget's examples with their clips,
a settings table read as "setting: value" lines, the prompt in a text
block, and the sentences with advice in them. The strength the creator
names ("I recommend using strength 0.7", "0.5 - 0.9 strength") is found
in the notes, else the showcase's own. Adult showcase clips are shown only
with "Include 18+ results" on.

From the panel: "Set 0.7" moves the strength slider; "Use this prompt"
puts a showcase prompt in the description box to reshape; "Make clips
with it at these" keeps the showcase's steps and guidance on the LoRA
(`settings` on its book entry, shown as a pill on its row), and while it
is ticked the clip's steps and guidance follow them in place of the
quality setting's (`loraSettings` in `chosen()`; the estimate says so and
such a clip does not teach the time guess). A turbo LoRA needs that: its
few steps at guidance 1. "Ask Claude how to prompt with it" sends the
notes, trigger words and up to four showcase prompts with their settings
through `/api/review` (`kind: "prompt", mode: "lora"`) for Strength,
Prompt, Settings, Pairs with and Avoid lines. Nothing in the panel needs
Claude; it is read off the page.

Fitting the person's own words to a LoRA (2026-10-20): with LoRAs ticked,
the suggest button under the description reads "Ask Claude to fit it to
<LoRA>". The suggestion request (`mode: "suggest"`) and the expansion at
send time (`mode: "expand"`) carry `loras`: each ticked LoRA with its
current strength, the creator's recommended strength, trigger words,
notes, settings and up to three showcase prompts (`loraContext` on the
page, `loraMaterial` in src/review.js). Claude writes the description in
the showcase prompts' shape with the person's subject, action and setting
kept (the showcase wins on style, the person on content), and the
suggestion adds "Strength: <name> = <number>" per LoRA and "Settings: N
steps, guidance X" or "as they are". The suggestion box shows the
description, the strength change and the settings; "Use it" puts the
words in the box, moves the LoRA's slider and keeps the settings on its
row, so the next clip goes out that way. A starting picture goes along as
before, so "show this man eating an apple" with a picture keeps the man
as he is.

Not yet verified on hardware: DaSiWa loading and its clips, Civitai
downloads with a real key, any Civitai LoRA, several LoRAs at once, a
turbo LoRA at its borrowed steps and guidance.

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
The reference-part download refused with HTTP 400 on hardware (2026-10-18):
the agent takes a folder download only with `model_index.json` in its
list, and the step sent only `transformer_ref/*`. Fixed site-side: the
step now sends the index too (the agent skips it, already there), and the
stub agent enforces the same rule so the tests catch it.

Not yet verified: LTX-2.5 generating a clip (image 16's staging and
decode batching are the fix; a text-only 5 s at Low and then one from a
picture are the two tests); the MiniMax-H3 360 orbit LoRA end to end
(image 19 has peft); clips from reference pictures (ref2va, image 20);
the grown-disk size hint (image 21); the Machine report on a real
machine (image 21). When one of these runs, move it up and note the
date and the machine.
- The speed switches of images 26 and 27: the real ratio from skipped
  passes; fp8 weights (the speed, the memory saved, and a LoRA loading on
  the fp8 blocks); the compiled blocks' gain and how long the first clip
  waits; and a long chat with files on a rented Ollama (the window set
  with `num_ctx` reloads the model once).
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
