import fs from "node:fs";
import path from "node:path";

// A second opinion on what a local model produced. Small open models make
// mistakes a stronger one catches: code that does not run, a wrong fact, a
// picture that misses the description. The reply (or the picture) is sent
// to Claude only when the user asks for the check, with their own
// Anthropic API key, and the review streams back as it is written.

export const REVIEW_MODEL = "claude-opus-5";

// Images go to the API as base64; this is the limit for one image.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MEDIA_TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };

const TEXT_SYSTEM = `You review answers written by small open-source language models that people run on their own computers. These models are much weaker than you and often make mistakes: code with bugs or that does not run, invented functions or facts, arithmetic slips, steps that do not follow, answers to a different question than the one asked.

The person will show you what they asked and what the model answered, and wants to know whether they can rely on it.

Start with one line that gives the verdict in plain words, for example "This is correct." or "This has two problems." Then list the problems, most serious first, saying where each one is and why it is wrong. When code needs changes, give the corrected code: the whole thing when it is short, only the changed parts when it is long. When the answer is right, say so briefly and stop; do not invent problems or pad the review with style preferences. If you cannot verify something, such as a claim that depends on information you do not have, say that it is unverified instead of guessing.

The app shows your reply exactly as written, as plain text. Do not use markdown headings, bold or tables. Put code in fenced code blocks. Keep it as short as the problems allow.`;

const IMAGE_SYSTEM = `You review pictures made by open-source image models that people run on their own computers. These models often miss parts of the description and produce flaws: malformed hands and faces, extra or missing limbs, garbled text, objects that merge, the wrong style, things the person asked to avoid.

The person will show you a picture, the description they gave the model and anything they asked it to avoid, and wants to know how well the picture matches and how to get a better one.

Start with one line that gives the verdict in plain words. Then say what matches the description and what does not, and list the visible flaws, most noticeable first. Finish with a better description to try and a better avoid list, each on its own line starting with "Description:" and "Avoid:". Image models read short comma-separated phrases, not sentences, and cannot read "no" or "not", so anything unwanted belongs in the avoid list.

The app shows your reply exactly as written, as plain text. Do not use markdown headings, bold or tables. Keep it short.`;

// Claude as an editor rather than a reviewer: the person says what should
// change about an answer, and gets the revised answer back, ready to use.
const EDIT_TEXT_SYSTEM = `You revise answers written by small open-source language models that people run on their own computers. The person will show you what they asked, what the model answered, and what they want changed. Make exactly that change, fix anything plainly wrong that you touch on the way, and keep everything else as it was.

Reply with only the revised answer, complete, so it can replace the old one as it stands. No preamble, no explanation, no closing remark. Keep the old answer's form: if it was code, reply with code in a fenced block; if it was a list, keep the list. Do not use markdown headings, bold or tables.`;

// For a picture, Claude cannot paint, so it writes the edit for an image
// model that can: a new description for a pass that keeps the picture's
// layout and changes what the description says.
const EDIT_IMAGE_SYSTEM = `You help people edit pictures made by open-source image models they run on their own computers. The person will show you a picture, the description it was made from, and the change they want. The edit will be done by an image model painting over this very picture from a new description (an image-to-image pass): it keeps the composition and changes what the description changes, and it understands short comma-separated phrases, not sentences or "no" and "not".

Look at the picture and work out what the new description has to say so that the change happens and everything else stays. Reply with exactly these lines, each starting with the word shown:

Description: the full new description, every important element of the picture included, with the change made
Avoid: what the model must not paint, comma-separated
Keep: a whole number from 20 to 90, the percentage of the current picture to keep: 85 for a touch-up such as colours, lighting or a small object; 60 for changing or adding things; 35 for a different scene on the same layout

Then one or two plain sentences on what this edit can and cannot achieve with such a model. Plain text only; no markdown.`;

export class ReviewError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// The request for one review. Kept separate from the call so it can be
// checked without the network.
export function buildRequest(input, { outputDir } = {}) {
  const base = {
    model: REVIEW_MODEL,
    max_tokens: 64000,
    thinking: { type: "adaptive" },
    // If a safety classifier declines the request, the API reruns it on the
    // model Anthropic recommends for that case instead of returning nothing.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
  };
  const from = input.model ? `a local model (${input.model})` : "a local model";
  const editing = input.mode === "edit";
  const request = String(input.request ?? "").trim();
  if (editing && !request) throw new ReviewError("Say what should change.");
  if (input.kind === "text") {
    const answer = String(input.answer ?? "");
    if (!answer.trim()) throw new ReviewError("There is no answer to check yet.");
    const question = String(input.question ?? "").trim();
    const instructions = String(input.system ?? "").trim();
    const parts = [`I asked ${from}:`, `<request>\n${question || "(the request was not kept)"}\n</request>`];
    if (instructions) parts.push(`It had these standing instructions:`, `<instructions>\n${instructions}\n</instructions>`);
    parts.push(`It answered:`, `<answer>\n${answer}\n</answer>`);
    if (editing) parts.push(`Change this about the answer:`, `<change>\n${request}\n</change>`, `Reply with only the revised answer.`);
    else parts.push(`Is the answer right? Check it and tell me what, if anything, is wrong.`);
    return { ...base, system: editing ? EDIT_TEXT_SYSTEM : TEXT_SYSTEM, messages: [{ role: "user", content: parts.join("\n\n") }] };
  }
  if (input.kind === "image") {
    // The picture is either one this app made (named by file) or, on the
    // hosted site, one the visitor picked (sent as base64 with its type).
    let mediaType;
    let bytes;
    if (input.image) {
      mediaType = String(input.image.media_type ?? "");
      if (!Object.values(MEDIA_TYPES).includes(mediaType)) throw new ReviewError("The picture has to be a PNG, JPEG or WebP file.");
      const data = String(input.image.data ?? "");
      if (!data || !/^[A-Za-z0-9+/]+=*$/.test(data)) throw new ReviewError("The picture did not arrive intact. Pick it again.");
      bytes = Buffer.from(data, "base64");
    } else {
      const file = path.basename(String(input.file ?? ""));
      mediaType = MEDIA_TYPES[path.extname(file).toLowerCase()];
      if (!file || !mediaType) throw new ReviewError("That is not a picture this app made.");
      const full = path.join(outputDir ?? "", file);
      if (!fs.existsSync(full)) throw new ReviewError("That picture is no longer on this computer.", 404);
      bytes = fs.readFileSync(full);
    }
    if (bytes.length > MAX_IMAGE_BYTES) throw new ReviewError("That picture is larger than 5 MB, which is more than Claude accepts.");
    const prompt = String(input.prompt ?? "").trim();
    const negative = String(input.negative ?? "").trim();
    const ask = editing ? `I want this changed about the picture:\n\n<change>\n${request}\n</change>\n\nWrite the Description, Avoid and Keep lines for the image-to-image pass.` : "How well does the picture match, what is wrong with it, and what should I ask for instead?";
    const text = [`${from[0].toUpperCase()}${from.slice(1)} made this picture from my description:`, `<description>\n${prompt || "(the description was not kept)"}\n</description>`, negative ? `I asked it to avoid:\n\n<avoid>\n${negative}\n</avoid>` : "I gave it nothing to avoid.", ask].join("\n\n");
    return {
      ...base,
      system: editing ? EDIT_IMAGE_SYSTEM : IMAGE_SYSTEM,
      messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: mediaType, data: bytes.toString("base64") } }, { type: "text", text }] }],
    };
  }
  throw new ReviewError("Unknown kind of check.");
}

// Loads the Anthropic SDK when the first check is asked for, so the app
// starts without it and the hosted copy never needs it.
async function loadSdk() {
  try {
    return (await import("@anthropic-ai/sdk")).default;
  } catch {
    throw new ReviewError("The Claude check needs its library. Run `npm install` in the huggingfound folder once, then start the app again.", 501);
  }
}

// `review(input, onText, use)` streams the review and resolves with how it
// ended. `sdk` and `client` can be handed in by tests.
export function createReviewer({ apiKey = () => "", outputDir, sdk = null, client = null } = {}) {
  return {
    // `use.apiKey` is a key for this one check (a visitor's own, on the
    // hosted site); it is passed to Anthropic and kept nowhere.
    async review(input, onText, use = {}) {
      const params = buildRequest(input, { outputDir });
      const Anthropic = sdk ?? (client ? null : await loadSdk());
      const key = use.apiKey || apiKey();
      const api = client ?? (key ? new Anthropic({ apiKey: key }) : new Anthropic());
      try {
        const stream = api.beta.messages.stream(params);
        let wrote = false;
        for await (const event of stream) {
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            wrote = true;
            onText(event.delta.text);
          }
        }
        const message = await stream.finalMessage();
        if (message.stop_reason === "refusal") {
          // Whatever was written before the stop is not a finished review.
          return { declined: true, discard: wrote, model: message.model, note: "Claude declined to review this." };
        }
        return { declined: false, model: message.model, note: message.stop_reason === "max_tokens" ? "The review was cut off at the length limit." : "" };
      } catch (err) {
        throw explain(err, Anthropic);
      }
    },
  };
}

// A sentence a person can act on for each way the request can fail.
function explain(err, Anthropic) {
  if (err instanceof ReviewError || !Anthropic) return err;
  if (err instanceof Anthropic.AuthenticationError) return new ReviewError("Anthropic refused the API key. Check that it is entered correctly and still active.", 401);
  if (err instanceof Anthropic.PermissionDeniedError) return new ReviewError("This API key is not allowed to use that model.", 403);
  if (err instanceof Anthropic.RateLimitError) return new ReviewError("Anthropic is rate limiting this key right now. Try again in a minute.", 429);
  if (err instanceof Anthropic.BadRequestError) return new ReviewError(`Anthropic rejected the request: ${err.message}`, 400);
  if (err instanceof Anthropic.APIConnectionError) return new ReviewError("Could not reach Anthropic. Check the internet connection.", 502);
  if (err instanceof Anthropic.APIError) return new ReviewError(`Anthropic answered with an error (${err.status ?? "unknown"}): ${err.message}`, 502);
  return err;
}
