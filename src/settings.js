// What people say about a model's settings (steps, CFG, sampler,
// temperature, quantization and the like), put in HuggingFound's own terms.
//
// Model cards carry "recommended settings" blocks, and Reddit, Hugging Face
// and GitHub threads trade the numbers that worked. Each mention is matched
// to the control HuggingFound has for it: a line that says which preset or
// box to use, or, when there is no such control, a line that says so. The
// second kind is tallied across every gathered model (wantedSettings) so the
// controls people ask for most can be built first.
//
// What is stored with a summary is the raw advice (which setting, which
// values, said by users or by the author, or only asked about). The lines are
// written when a summary is shown, for the kind of model it is, so changing
// the wording here needs no new gathering.

const ADVICE = /\b(recommend\w*|suggest\w*|use[sd]?|using|set|setting|settings|try|tried|works? (best|well|great|fine)|best (results?|quality)|at least|should|optimal|sweet spot|keep|lower|raise|increase|decrease|higher|around|between|start (at|with)|go with|prefer\w*)\b|[:=]/i;
// Advice in words, for the settings that carry no number (a negative
// prompt, a system prompt, an upscale pass): "cfg: 4" counts as advice, a
// colon in "Word timestamps error: ..." does not.
const ADVICE_WORDS = new RegExp(ADVICE.source.replace(/\|\[:=\]$/, ""), "i");
// Numbers about how a model was made or measured, not how to run it.
const TRAINING = /\b(train(ed|ing)?|fine-?tun\w*|pre-?train\w*|dataset|epochs?|learning rate|batch size|benchmark\w*|evaluat\w*|perplexity|measured|held-out|hold-out|greedy decoding)\b/i;
// A context length a model is capable of is not a setting someone advises.
const CAPABILITY = /\b(supports?|native(ly)?|up to|extensible|extend(ed|s)? to|maximum|max(imum)? context)\b/i;
const QUESTION = /\?\s*$|^(how|what|which|can|does|do|is there|any(one)?|why|where|should)\b/i;

const num = (s) => Number(String(s).replace(/^\./, "0."));
const firstNum = (re, s, lo, hi) => {
  const m = re.exec(s);
  if (!m) return null;
  const v = num(m.slice(1).find((g) => g != null));
  return Number.isFinite(v) && v >= lo && v <= hi ? v : null;
};

// Sampler names as people write them, folded to one spelling.
const SAMPLERS = [
  [/\beuler[ _-]?(a\b|ancestral)/i, "Euler a"],
  [/\bdpm(\+\+|pp)[ _-]?2m[ _-]?sde\b/i, "DPM++ 2M SDE"],
  [/\bdpm(\+\+|pp)[ _-]?2m\b/i, "DPM++ 2M"],
  [/\bdpm(\+\+|pp)[ _-]?sde\b/i, "DPM++ SDE"],
  [/\bdpm(\+\+|pp)[ _-]?3m/i, "DPM++ 3M SDE"],
  [/\beuler\b/i, "Euler"],
  [/\bunipc\b/i, "UniPC"],
  [/\bddim\b/i, "DDIM"],
  [/\bheun\b/i, "Heun"],
  [/\bres[ _]?multistep\b/i, "res_multistep"],
  [/\bdeis\b/i, "DEIS"],
  [/\blcm\b(?= sampler| scheduler)/i, "LCM"],
];
const SCHEDULERS = [
  [/\bkarras\b/i, "Karras"],
  [/\bsgm[ _]uniform\b/i, "sgm_uniform"],
  [/\bexponential\b(?= scheduler)/i, "exponential"],
  [/\bbeta\b(?= scheduler)/i, "beta"],
  [/\bsimple\b(?= scheduler)|scheduler\s*[:=]?\s*simple\b/i, "simple"],
  [/\bflow ?match\w*/i, "flow-match"],
];
const QUANT = /\b(I?Q[1-8](?:[ _](?:K|0|1))?(?:[ _](?:XXS|XS|S|M|L|XL))?|BF16|F16|FP16|FP8)\b/;
const FORMATS = /\b(chatml|alpaca|vicuna|metharme|pygmalion|llama[ -]?3 (?:instruct )?(?:template|format)|mistral (?:template|format|v\d))\b/i;

// One entry per setting people talk about. `kinds` are the kinds of model it
// applies to (quality.js kindOf); `known` means it is only shown when the
// model's kind is known, since the word means other things elsewhere.
// `value` reads the setting's value out of a sentence; `key` spots a mention
// with no value (a question). `build` says what adding the control would take.
export const PARAMS = [
  {
    id: "steps", label: "steps", kinds: ["images", "video"],
    key: /\b(sampling |inference )?steps\b/i,
    // A range ("6-8 steps", "steps: 25 to 30") is kept as one.
    value: (s) => {
      const m = /(\d{1,3})(?:\s*(?:-|–|to)\s*(\d{1,3}))?\s*(?:sampling\s+|inference\s+|denoising\s+)?steps\b|\bsteps?\s*(?:[:=]|of|at|to)?\s*(\d{1,3})(?:\s*(?:-|–|to)\s*(\d{1,3}))?\b/i.exec(s);
      if (!m) return null;
      const [lo, hi] = m[1] ? [Number(m[1]), m[2] && Number(m[2])] : [Number(m[3]), m[4] && Number(m[4])];
      if (!(lo >= 1 && lo <= 150)) return null;
      return hi && hi > lo && hi <= 150 ? `${lo}–${hi}` : lo;
    },
    build: "An exact step count beside Fast, Default and Max.",
  },
  {
    id: "cfg", label: "CFG", kinds: ["images", "video"],
    key: /\bcfg\b|\bguidance[ _]scale\b/i,
    value: (s) => firstNum(/\b(?:cfg(?:[ _]scale)?|guidance(?:[ _]scale)?)\s*(?:[:=]|of|at|to|around|about|~|is)?\s*(\d{1,2}(?:\.\d+)?)\b|\b(\d{1,2}(?:\.\d+)?)\s*cfg\b/i, s, 0, 30),
    build: "A CFG field; runners.js and plans.js fix it at 7 (1 for distilled models).",
  },
  {
    id: "sampler", label: "sampler", kinds: ["images"],
    key: /\bsamplers?\b/i,
    value: (s) => SAMPLERS.find(([re]) => re.test(s))?.[1] ?? null,
    build: "A sampler list; stable-diffusion.cpp already takes --sampling-method.",
  },
  {
    id: "scheduler", label: "scheduler", kinds: ["images"],
    key: /\bschedulers?\b/i,
    value: (s) => SCHEDULERS.find(([re]) => re.test(s))?.[1] ?? null,
    build: "A scheduler list; stable-diffusion.cpp already takes --scheduler.",
  },
  {
    id: "negative", label: "negative prompt", kinds: ["images", "video"],
    key: /\bnegative[ _]prompts?\b/i,
    value: (s) => (/\bnegative[ _]prompts?\b/i.test(s) && ADVICE_WORDS.test(s) ? "a negative prompt" : null),
  },
  {
    id: "size", label: "size", kinds: ["images", "video"],
    key: /\bresolution\b/i,
    value: (s) => {
      const m = /\b(\d{3,4})\s*[x×*]\s*(\d{3,4})\b/.exec(s);
      if (!m) return null;
      const [w, h] = [Number(m[1]), Number(m[2])];
      return w >= 256 && h >= 256 && w <= 4096 && h <= 4096 ? `${w} by ${h}` : null;
    },
    build: "A size picker for pictures; imageSettings in runners.js picks 512 or 768 by itself.",
  },
  {
    id: "seed", label: "seed", kinds: ["images", "video"],
    key: /\bseeds?\b/i,
    value: (s) => (/\b(fixed|same|set|keep|lock)\w* (the )?seed|\bseed\s*[:=]?\s*\d+/i.test(s) && !TRAINING.test(s) ? "a fixed seed" : null),
    build: "A seed field; each picture now gets a random one.",
  },
  {
    id: "clipskip", label: "clip skip", kinds: ["images"],
    key: /\bclip[ _-]?skip\b/i,
    value: (s) => firstNum(/\bclip[ _-]?skip\s*(?:[:=]|of|at|to)?\s*(\d)\b/i, s, 1, 12),
    build: "A clip skip option; stable-diffusion.cpp takes --clip-skip.",
  },
  {
    id: "hires", label: "upscaling", kinds: ["images"], known: true,
    key: /\bhi-?res[ .]?fix\b|\bupscal(e|er|ing)\b/i,
    value: (s) => (/\bhi-?res[ .]?fix\b|\bupscal(e|er|ing)\b/i.test(s) && ADVICE_WORDS.test(s) ? "a hires fix or upscale pass" : null),
    build: "An upscale pass after the picture (stable-diffusion.cpp has --upscale-model).",
  },
  {
    id: "denoise", label: "denoising strength", kinds: ["images"],
    key: /\bdenois(e|ing) strength\b/i,
    value: (s) => firstNum(/\bdenois(?:e|ing)(?:[ _]strength)?\s*(?:[:=]|of|at|to|around)?\s*(0?\.\d+|1(?:\.0)?)\b/i, s, 0, 1),
    build: "A strength slider for Improve this; the page picks the strength now.",
  },
  {
    id: "lora", label: "LoRA strength", kinds: ["images", "video"],
    key: /\blora[ _](strength|weight|scale)\b/i,
    value: (s) => firstNum(/\blora[ _](?:strength|weight|scale)\s*(?:[:=]|of|at|to|around)?\s*(\d(?:\.\d+)?)\b|\b(\d(?:\.\d+)?)\s*lora[ _](?:strength|weight)\b/i, s, 0, 3),
  },
  {
    id: "shift", label: "shift", kinds: ["images", "video"], known: true,
    key: /\b(flow[ _])?shift\b/i,
    value: (s) => firstNum(/\b(?:flow[ _])?shift\s*(?:[:=]|of|to|at)?\s*(\d{1,2}(?:\.\d+)?)\b/i, s, 0, 20),
    build: "A shift field for flow-matching models (FLUX, Wan, Qwen-Image); worker.py takes it from the pipeline's default now.",
  },
  {
    id: "fps", label: "frame rate", kinds: ["video"],
    key: /\bfps\b|\bframe ?rate\b/i,
    value: (s) => firstNum(/\b(\d{1,2})\s*fps\b|\bfps\s*[:=]?\s*(\d{1,2})\b/i, s, 4, 60),
    build: "A frame-rate choice; each model's rate is fixed in plans.js.",
  },
  {
    id: "temperature", label: "temperature", kinds: ["text", "vision"], sampling: true,
    key: /\btemperature\b/i,
    value: (s) => firstNum(/\b(?:temperature|temps?)\s*(?:[:=]|of|at|to|around|range)?\s*(\d?\.\d+|\d(?:\.\d+)?)\b/i, s, 0, 5),
    build: "A temperature slider; /api/chat already passes temperature to Ollama.",
  },
  {
    id: "top_p", label: "top p", kinds: ["text", "vision"], sampling: true,
    key: /\btop[ _-]?p\b/i,
    value: (s) => firstNum(/\btop[ _-]?p(?:[ _]sampling)?\s*(?:[:=]|of|at|to)?\s*(0?\.\d+|1(?:\.0)?)\b/i, s, 0, 1),
    build: "A top p field; /api/chat already passes top_p to Ollama.",
  },
  {
    id: "top_k", label: "top k", kinds: ["text", "vision"], sampling: true,
    key: /\btop[ _-]?k\b/i,
    value: (s) => firstNum(/\btop[ _-]?k(?:[ _]sampling)?\s*(?:[:=]|of|at|to)?\s*(\d{1,3})\b/i, s, 0, 500),
    build: "A top k field, and top_k added to the options /api/chat passes to Ollama.",
  },
  {
    id: "min_p", label: "min p", kinds: ["text", "vision"], sampling: true,
    key: /\bmin[ _-]?p\b/i,
    value: (s) => firstNum(/\bmin[ _-]?p(?:[ _]sampling)?\s*(?:[:=]|of|at|to)?\s*(0?\.\d+|0)\b/i, s, 0, 1),
    build: "A min p field, and min_p added to the options /api/chat passes to Ollama.",
  },
  {
    id: "repeat", label: "repetition penalty", kinds: ["text", "vision"], sampling: true,
    key: /\brep(etition|eat)?[ _-]?pen(alty)?\b/i,
    value: (s) => firstNum(/\brep(?:etition|eat)?[ _-]?pen(?:alty)?\s*(?:[:=]|of|at|to|range)?\s*(\d(?:\.\d+)?)\b/i, s, 0.5, 2),
    build: "A repetition penalty field, and repeat_penalty added to the options /api/chat passes to Ollama.",
  },
  {
    id: "presence", label: "presence penalty", kinds: ["text", "vision"], sampling: true,
    key: /\bpresence[ _]penalty\b/i,
    value: (s) => firstNum(/\bpresence[ _]penalty\s*(?:[:=]|of|at|to)?\s*(\d(?:\.\d+)?)\b/i, s, 0, 2),
    build: "A presence penalty field, and presence_penalty added to the options /api/chat passes to Ollama.",
  },
  {
    id: "dry", label: "DRY, XTC or Mirostat", kinds: ["text"], sampling: true, known: true,
    key: /\b(DRY|XTC)\b|\bmirostat\b/,
    value: (s) => /\b(DRY|XTC)\b|\bmirostat\b/i.exec(s)?.[0]?.replace(/^m/, "M") ?? null,
    build: "Not offered by Ollama (Mirostat aside); would need llama.cpp's server on the rented machine.",
  },
  {
    id: "context", label: "context length", kinds: ["text", "vision"],
    key: /\bcontext[ _](length|size|window)\b|\bnum_ctx\b/i,
    value: (s) => {
      if (CAPABILITY.test(s) || !ADVICE.test(s)) return null;
      const m = /\b(\d{1,4})\s*k\s*(?:tokens?\s*)?(?:of\s+)?context\b|\bcontext(?:[ _](?:length|size|window))?\s*(?:[:=]|of|to|at)?\s*(?:at least\s*)?(\d{1,4}k|\d{4,7})\b|\bnum_ctx\s*[:=]?\s*(\d{3,7})\b/i.exec(s);
      if (!m) return null;
      const raw = m.slice(1).find((g) => g != null);
      const tokens = /k$/i.test(raw) ? Number(raw.slice(0, -1)) * 1024 : /^\d{1,4}$/.test(raw) && m[1] ? Number(raw) * 1024 : Number(raw);
      return tokens >= 1024 && tokens <= 2_000_000 ? `${Math.round(tokens / 1024)}k` : null;
    },
    build: "A context length choice; /api/chat already passes num_ctx to Ollama, nothing sets it.",
  },
  {
    id: "maxtokens", label: "answer length", kinds: ["text", "vision"],
    key: /\bmax(imum)?[ _](new[ _])?tokens\b|\bnum_predict\b|\bmax[ _]output\b/i,
    value: (s) => firstNum(/\b(?:max(?:imum)?[ _](?:new[ _])?tokens|num_predict|max[ _]output(?:[ _]tokens)?)\s*(?:[:=]|of|to|at)?\s*(\d{2,6})\b/i, s, 16, 1_000_000),
    build: "An exact answer-length cap beside Quick, Standard and Thorough.",
  },
  {
    id: "system", label: "system prompt", kinds: ["text", "vision"],
    key: /\bsystem[ _](prompt|message)\b/i,
    value: (s) => (/\bsystem[ _](prompt|message)\b/i.test(s) && ADVICE_WORDS.test(s) && !/\bno system\b/i.test(s) ? "a system prompt" : null),
  },
  {
    id: "thinking", label: "thinking", kinds: ["text", "vision"],
    key: /\b(enable_thinking|thinking mode|reasoning mode|\/no_think)\b/i,
    value: (s) => {
      if (/\/no_think|thinking (is )?(off|disabled)|disabl\w* (the )?thinking|turn\w* off (the )?(thinking|reasoning)|enable_thinking\s*[:=]?\s*false/i.test(s)) return "thinking off";
      if (/thinking (mode )?(on|enabled)|enabl\w* (the )?thinking|enable_thinking\s*[:=]?\s*true|turn\w* on (the )?(thinking|reasoning)/i.test(s)) return "thinking on";
      return null;
    },
  },
  {
    id: "format", label: "prompt format", kinds: ["text"], known: true,
    key: FORMATS,
    value: (s) => (ADVICE_WORDS.test(s) ? (FORMATS.exec(s)?.[1] ?? null) : null),
    build: "A prompt-format override; Ollama uses the template inside the GGUF.",
  },
  {
    id: "quant", label: "quantization", kinds: ["text", "vision", "images"],
    key: /\bquant(s|ization)?\b/i,
    value: (s) => {
      // "Which one would work best for your ARM chip" is not a recommendation.
      if (!/\b(recommend\w*|suggest\w*|go with|prefer\w*|sweet spot)\b/i.test(s)) return null;
      const m = QUANT.exec(s);
      return m ? m[1].toUpperCase().replace(/ /g, "_") : null;
    },
    build: "A quantization picker; chooseFile in hf.js takes Q4_K_M for chat and Q8_0 for pictures.",
  },
  {
    id: "language", label: "language", kinds: ["speech"], known: true,
    key: /\blanguage\b/i,
    value: (s) => {
      if (/\bauto[- ]?detect\w*/i.test(s)) return "detecting the language";
      const m = /\b(?:language|lang)\s*(?:[:=]|to\b|set to\b)\s*([a-z]{2,12})\b|(?:^|\s)(?:-l|--language)\s+([a-z]{2,5})\b/i.exec(s);
      return m ? `language ${m[1] ?? m[2]}` : null;
    },
    build: "A language choice for transcription; whisper-cli is run without -l, so it assumes English.",
  },
  {
    id: "beam", label: "beam size", kinds: ["speech"],
    key: /\bbeam[ _]?(size|search)\b/i,
    value: (s) => firstNum(/\bbeam[ _]?(?:size|search)?\s*(?:[:=]|of)?\s*(\d{1,2})\b/i, s, 1, 16),
  },
  {
    id: "subtitles", label: "subtitles or timestamps", kinds: ["speech"], known: true,
    key: /\b(srt|vtt|subtitles?|(word|segment)[ _]timestamps?|timestamps? for (the )?transcripts?)\b/i,
    value: (s) => (/\b(srt|vtt|subtitles?|(word|segment)[ _]timestamps?)\b/i.test(s) && ADVICE_WORDS.test(s) && !/\b(error|bug|fails?|reset)\b/i.test(s) ? "subtitles or timestamps" : null),
    build: "Subtitle output; whisper-cli writes .srt with -osrt, the app asks for text only.",
  },
];
const BY_ID = new Map(PARAMS.map((p) => [p.id, p]));

// Whether a sentence gives a setting's value; such a sentence is advice, not
// an opinion, and stays out of the "Users:" lines.
export function givesSetting(sentence) {
  return !QUESTION.test(sentence) && PARAMS.some((p) => p.value(sentence) != null);
}

function sentences(text) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z])|\s+[-–•]\s+|\n/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 4 && s.length <= 400);
}

// The raw advice in what people and the author wrote: for each setting, the
// values given and how often, by users and by the author, and how often it
// was only asked about. `voices` is collectVoices' output.
export function settingsAdvice({ users = [], author = "" } = {}) {
  const found = new Map();
  const note = (p, from, value, asked) => {
    const e = found.get(p.id) ?? { id: p.id, values: {}, users: 0, author: 0, asked: 0 };
    if (value != null) {
      e.values[value] = (e.values[value] ?? 0) + 1;
      e[from]++;
    } else if (asked) e.asked++;
    found.set(p.id, e);
  };
  const read = (text, from) => {
    for (const s of sentences(text)) {
      if (TRAINING.test(s)) continue;
      const question = QUESTION.test(s);
      for (const p of PARAMS) {
        const value = question ? null : p.value(s);
        if (value != null) note(p, from, String(value), false);
        else if (question && from === "users" && p.key.test(s)) note(p, from, null, true);
      }
    }
  };
  for (const u of users) read(u.text, u.author ? "author" : "users");
  read(author, "author");
  return [...found.values()];
}

// ---- what HuggingFound has for each -----------------------------------------

const presetFor = (steps) => (steps <= 8 ? "Fast" : steps <= 15 ? "Fast" : steps < 30 ? "Default" : "Max");
const PRESET_STEPS = { Fast: 12, Default: 20, Max: 40 };

// The values as one phrase: the one given most, or a short range when they
// sit close together.
function valuePhrase(values) {
  const entries = Object.entries(values).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return null;
  const nums = entries.map(([v]) => Number(v)).filter(Number.isFinite);
  if (nums.length === entries.length && nums.length > 1 && nums.length <= 3) {
    const lo = Math.min(...nums);
    const hi = Math.max(...nums);
    if (lo > 0 && hi / lo <= 2) return `${lo}–${hi}`;
  }
  return entries[0][0];
}
const topValue = (values) => Object.entries(values).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

// Whether HuggingFound has a control for this advice, and the line that
// says so. support: "yes" a control does it; "preset" a preset comes close;
// "no" nothing does yet.
export function judge(e, kind = null) {
  const p = BY_ID.get(e.id);
  if (!p) return null;
  const v = valuePhrase(e.values);
  const top = topValue(e.values);
  const n = parseFloat(top);
  switch (p.id) {
    case "steps":
      if (!v) return { support: "preset", how: "Fast, Default and Max set the steps" };
      if (kind === "video") return { support: "preset", what: `${v} steps`, how: "the Low, Medium and High levels set the steps" };
      if (n <= 8) return { support: "preset", what: `${v} steps`, how: "Fast uses 4 on Turbo, Lightning, LCM and Hyper models (Max 8), 12 on others" };
      return { support: "preset", what: `${v} steps`, how: `pick ${presetFor(n)}, which uses ${PRESET_STEPS[presetFor(n)]}` };
    case "cfg":
      return { support: "no", what: v ? `CFG ${v}` : null, how: "HuggingFound uses 7, or 1 on Turbo-type models" };
    case "sampler":
      if (top === "Euler a") return { support: "preset", what: "Euler a", how: "pick Default, which uses it" };
      if (top === "DPM++ 2M") return { support: "preset", what: "DPM++ 2M", how: "Fast and Max use it, with Karras" };
      return { support: "no", what: v ? `the ${v} sampler` : null, how: "only Euler a and DPM++ 2M Karras are offered" };
    case "scheduler":
      if (top === "Karras") return { support: "preset", what: "the Karras scheduler", how: "Fast and Max use it" };
      return { support: "no", what: v ? `the ${v} scheduler` : null, how: "only Karras is offered, at Fast and Max" };
    case "negative":
      return { support: "yes", what: "a negative prompt", how: "type it in Avoid" };
    case "size":
      if (kind === "video") return { support: "preset", what: v, how: "Low makes the smallest clip; Medium and High make 1280 by 704" };
      return { support: "no", what: v, how: "HuggingFound picks 512 or 768 by itself" };
    case "seed":
      return { support: "no", what: "a fixed seed", how: "each picture gets a random one" };
    case "clipskip":
      return { support: "no", what: v ? `clip skip ${v}` : null, how: "it is left at the model's default" };
    case "hires":
      return { support: "no", what: "a hires fix or upscale pass", how: "pictures come out at one size" };
    case "denoise":
      return { support: "preset", what: v ? `denoising ${v}` : null, how: "Improve this picks the strength from your request" };
    case "lora":
      return { support: "yes", what: v ? `LoRA strength ${v}` : null, how: v ? `set the add-on's Strength slider to ${top}` : "the add-on's Strength slider sets it" };
    case "shift":
      return { support: "no", what: v ? `shift ${v}` : null, how: "the pipeline's default shift is used" };
    case "fps":
      return { support: "no", what: v ? `${v} fps` : null, how: "each model's frame rate is fixed" };
    case "context":
      return { support: "no", what: v ? `a ${v} context` : null, how: "chats use Ollama's default context" };
    case "maxtokens":
      return { support: "preset", what: v ? `up to ${v} tokens` : null, how: "Effort caps answers: Quick 400, Standard 8,192, Thorough 16,384" };
    case "system":
      return { support: "yes", what: "a system prompt", how: "put it in the chat's system message" };
    case "thinking":
      return { support: "yes", what: top, how: top === "thinking off" ? "pick Quick Effort" : "pick Thorough Effort" };
    case "format":
      return { support: "no", what: v ? `the ${v} format` : null, how: "Ollama uses the template inside the file" };
    case "quant": {
      const ours = kind === "images" ? "Q8_0" : "Q4_K_M";
      if (top === ours) return { support: "yes", what: ours, how: "HuggingFound downloads it when there is one" };
      return { support: "no", what: v, how: `HuggingFound downloads ${ours} when there is one` };
    }
    case "language":
      return { support: "no", what: top, how: "whisper.cpp is run assuming English" };
    case "beam":
      return { support: "preset", what: v ? `beam size ${v}` : null, how: "Thorough uses 8, Quick 1" };
    case "subtitles":
      return { support: "no", what: "subtitles or timestamps", how: "transcripts come out as plain text" };
    default:
      // The chat sampling settings share one line; see settingsLines.
      return { support: "no", what: v ? `${p.label} ${v}` : null, how: "the chat has no sampling controls" };
  }
}

// Who said it. A context length is mostly reported ("runs at 256k on a
// 3090") rather than advised, so it is "mentions".
function who(e, verb = "suggest") {
  const s = verb === "suggest" ? "suggests" : "mentions";
  if (e.users && e.author) return `users and the author ${verb}`;
  if (e.author) return `the author ${s}`;
  if (e.users) return `users ${verb}`;
  return "users ask about";
}

function applies(p, kind) {
  if (!kind) return !p.known;
  // Vision models chat too; an unknown kind of writer is treated as text.
  return p.kinds.includes(kind);
}

// The lines a summary shows for this kind of model: what to set in
// HuggingFound first, then what HuggingFound cannot set yet. At most three
// of each, the most mentioned first.
export function settingsLines(advice, kind = null, { max = 3 } = {}) {
  const here = [];
  const missing = [];
  const sampling = [];
  const weight = (e) => e.users * 2 + e.author * 2 + e.asked;
  for (const e of [...(advice ?? [])].sort((a, b) => weight(b) - weight(a))) {
    const p = BY_ID.get(e.id);
    if (!p || !applies(p, kind)) continue;
    const j = judge(e, kind);
    if (!j) continue;
    const hasValue = Object.keys(e.values).length > 0;
    if (p.sampling) {
      if (hasValue) sampling.push({ e, phrase: j.what });
      else if (e.asked) sampling.push({ e, phrase: p.label, asked: true });
      continue;
    }
    if (!hasValue && !e.asked) continue;
    const subject = hasValue ? `${who(e, p.id === "context" ? "mention" : "suggest")} ${j.what ?? p.label}` : `users ask about ${p.label}`;
    const line = `${subject}; ${j.how}.`;
    if (j.support === "no") missing.push(`Not here yet: ${cap(line)}`);
    else here.push(`In HuggingFound: ${cap(line)}`);
  }
  // Temperature, top p and the rest read as one line.
  const given = sampling.filter((s) => !s.asked);
  if (given.length) {
    const from = given.reduce((t, s) => ({ users: t.users + s.e.users, author: t.author + s.e.author }), { users: 0, author: 0 });
    missing.unshift(`Not here yet: ${cap(`${who(from)} ${given.slice(0, 4).map((s) => s.phrase).join(", ")}; the chat has no sampling controls.`)}`);
  } else if (sampling.length) {
    missing.unshift(`Not here yet: Users ask about ${sampling.slice(0, 3).map((s) => s.phrase).join(", ")}; the chat has no sampling controls.`);
  }
  return [...here.slice(0, max), ...missing.slice(0, max)];
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// Presets that stand in for a number people give exactly.
const EXACT = new Set(["steps", "maxtokens"]);

// Across every gathered model: the settings people suggest that HuggingFound
// has no control for, the most asked-for first, with what building each
// would take. `entries` is [{ id, kind, settings }].
export function wantedSettings(entries) {
  const out = new Map();
  for (const { id, kind, settings } of entries) {
    for (const e of settings ?? []) {
      const p = BY_ID.get(e.id);
      if (!p || (kind && !p.kinds.includes(kind)) || (!kind && p.known)) continue;
      const j = judge(e, kind);
      // A control or a preset that does what was asked needs nothing built,
      // except where people name exact values a preset only comes near.
      if (!j || j.support === "yes" || (j.support === "preset" && !EXACT.has(p.id))) continue;
      const key = `${p.id}:${j.support}`;
      const row = out.get(key) ?? { setting: p.label, id: p.id, support: j.support, models: 0, mentions: 0, asked: 0, values: {}, examples: [], build: p.build ?? "" };
      row.models++;
      row.mentions += e.users + e.author;
      row.asked += e.asked;
      for (const [v, c] of Object.entries(e.values)) row.values[v] = (row.values[v] ?? 0) + c;
      if (row.examples.length < 5) row.examples.push(id);
      out.set(key, row);
    }
  }
  return [...out.values()]
    .map((r) => ({ ...r, values: Object.entries(r.values).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([v, c]) => ({ value: v, count: c })) }))
    .sort((a, b) => (a.support === b.support ? b.models - a.models : a.support === "no" ? -1 : 1));
}
