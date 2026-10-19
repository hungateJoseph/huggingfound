import fs from "node:fs";
import path from "node:path";

// A second opinion on what a local model produced. Small open models make
// mistakes a stronger one catches: code that does not run, a wrong fact, a
// picture that misses the description. The reply (or the picture) is sent
// to Claude only when the user asks for the check, with their own
// Anthropic API key, and the review streams back as it is written.

export const REVIEW_MODEL = "claude-opus-5";

// How much can happen in a clip of a given length. A video model plays the
// words out in real time and stops when the clip's frames run out, so an
// action written past the clip's length is never made: eight seconds of
// events in a five-second clip loses its last three. About one distinct
// action every three seconds of clip, at a natural pace.
export function actionBudget(seconds) {
  const s = Number(seconds);
  return s > 0 ? Math.max(1, Math.round(s / 3)) : null;
}
const PACING = `

Timing matters. The model plays the description out in real time and stops when the clip's length runs out, so whatever is written past that length is never shown. Describe only what really happens in the time given, at a natural pace: about one distinct action every three seconds, so a 5-second clip holds one action or two quick ones, 10 seconds about three, 15 seconds four or five. Spend the other words on how the action looks, the subject, the setting, the light and the camera, never on more events.`;
// The clip's length and what fits in it, said in the request itself.
function lengthLine(seconds, what = "The clip") {
  const n = actionBudget(seconds);
  if (!n) return "";
  return `${what} runs ${Number(seconds).toFixed(Number(seconds) % 1 ? 1 : 0)} seconds: describe at most ${n} distinct action${n === 1 ? "" : "s"}, at a natural pace, all over within those seconds.`;
}

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

// A clip cannot be painted over by the video models here, so a reply to
// one is a revised description for the same model and seed: the words
// change where the reply says, and the rest stays, so the scene does too.
const EDIT_CLIP_SYSTEM = `You help people revise short video clips made by open-source video models they run on rented GPUs. The person will show you the description the clip was made from and what they want changed. The clip will be made again by the same model from a new description with the same random seed, so the scene stays close wherever the words stay the same; the model reads short comma-separated phrases, not sentences or "no" and "not".

Reply with exactly these lines, each starting with the word shown:

Description: the full new description, every important element of the old one included, with the change made
Avoid: what the model must not show, comma-separated, or the word nothing

Then one plain sentence on what this remake can and cannot achieve. Plain text only; no markdown.`;
const EDIT_CLIP_PACED = EDIT_CLIP_SYSTEM.replace("\n\nReply with exactly", `${PACING}\n\nReply with exactly`);

// A long clip was made as shots, each from the last frame of the one
// before, then joined; the person says what went wrong. Only the shots
// the complaint touches are made again, from revised words and the same
// seeds, with the rest kept as they are: a missing hat in one shot is not
// a reason to make the whole clip over.
const FIX_SYSTEM = `You help people fix long video clips made by open-source video models they run on rented GPUs. Such a clip is made as shots, one after another, each shot by the model in one go from its own description and the last frame of the shot before, then the shots are joined. The person shows you the shot list the clip was made from and says what is wrong with the result: often the model left out something the words asked for, or got a detail wrong. Only the shots that need it will be made again, from revised words with the same random seed, so the scene stays close wherever the words stay the same; the other shots are kept as they are. The model reads short, plain, literal description, not instructions, "no" or "not"; what it left out is best said again early in the description, concretely, and once more where it matters.

Work out which shots the complaint touches. A missing or wrong thing in one shot touches that shot alone; a missing or wrong thing about a person, an object or the setting that is in frame through later shots touches every shot from the first wrong one on. When a later shot is made again, it starts from the new last frame of the shot before, so the fix carries through. A shot keeps its length, so its revised description holds only as much action as that length allows at a natural pace, about one distinct action every three seconds: the model stops when the length runs out, and action written past it is never made.

Reply with exactly these lines and nothing else:

Shot N: the full revised description for shot N, every element of its old one included, with the fix made and said plainly
(one such line for each shot to make again, in order, and none for a shot that stays)
Carry: yes or no, whether the shots after the last one named above are to be made again too so the change carries through them (yes when the fixed thing stays in frame; no when it was over by then)
Why: one plain sentence on what you changed and where

Plain text only; no markdown.`;

// A short description expanded into the detailed one an image or video
// model does best with: the subject, the setting, the light, the camera.
const EXPAND_SYSTEM = `You write descriptions for open-source image and video models that people run on rented GPUs, for ordinary creative work: short films, ads, music videos, illustrations. The person gives a short description. Everyday actions and scenes are described plainly and literally as they would be in a shooting script: someone taking off a jacket, changing shoes, swimming, dancing, arguing, cooking. Expand it into the detailed description such a model does best with: the subject and what it does, the setting, the light, the colours and the mood, the camera (the framing, and for a clip its movement and pace), the style and the medium. Keep every element the person named and add nothing that changes what they asked for; where they left something open, choose what fits. Such models read plain descriptive prose, not instructions, "no" or "not".

Reply with only the description: 60 to 120 words in one paragraph of plain text, no heading, no list, no quotation marks, no comment.`;
const EXPAND_CLIP_SYSTEM = EXPAND_SYSTEM.replace("\n\nReply with only", `${PACING}\n\nReply with only`);

// A clip continued: the next shot starts from the last frame of the one
// before, so its description is what happens next, with the scene kept.
const CONTINUE_SYSTEM = `You write descriptions for open-source video models that people run on rented GPUs, for ordinary creative work: short films, ads, music videos. Everyday actions are described plainly and literally, as in a shooting script. A clip was made from a description; the person says what happens next. The next clip will be made by the same model starting from the last frame of the first, so the scene, the people and the light are already there in the picture; the new description has to say what moves and what happens from that frame on, with the same subjects, setting and style, and nothing that contradicts the frame. Such models read plain descriptive prose, not instructions, "no" or "not".

Reply with only the description of the next clip: 40 to 90 words in one paragraph of plain text, no heading, no list, no quotation marks, no comment.`;
const CONTINUE_PACED = CONTINUE_SYSTEM.replace("\n\nReply with only", `${PACING}\n\nReply with only`);

// A better description for what the person wants, before anything is made:
// literal, concrete, in the phrasing these models follow, with the
// unwanted moved to the avoid list, and the starting picture taken into
// account when there is one.
const SUGGEST_SYSTEM = `You help people write descriptions for open-source image and video models they run on rented GPUs, for ordinary creative work: short films, ads, music videos, illustrations. The person shows you what they typed, and sometimes the picture the clip or image will start from. Such models follow plain, literal, concrete description and cannot read instructions, "no", "not" or "do not": anything unwanted belongs in a separate avoid list.

Write the description they should use instead: what is in the frame and what happens, in order; for a motion, how it is actually performed, so the model gets it right (for jumping jacks, the feet apart as the hands meet overhead, then together as the arms come down); the framing and the camera, kept still unless movement is asked for; and, with a starting picture, what stays as it is and what changes. Keep every element the person asked for and add nothing that changes what they asked for. Everyday actions and scenes are described plainly, as in a shooting script.

Reply with exactly these lines, each starting with the word shown:

Description: the description to use, 40 to 120 words, one paragraph
Avoid: what the model must not show, comma-separated, or the word nothing
Why: one or two plain sentences on what you changed and why

Plain text only; no markdown.`;

// A scene laid out as shots: each shot is a piece the model makes in one
// go from the last frame of the shot before, with its own description and
// length, so a sequence of events happens in order instead of the same
// words going to every piece.
const SCENE_SYSTEM = `You write shot lists for open-source video models that people run on rented GPUs, for ordinary creative work: short films, ads, music videos, fitness and fashion clips. Everyday actions and scenes are described plainly and literally, as in a shooting script: someone taking off a jacket or a sweater, changing shoes, warming up in gym clothes, swimming, dancing, arguing, cooking. The person describes a sequence of events longer than the model makes in one go. Lay it out as shots. Each shot is made separately by the same model, starting from the last frame of the shot before, so: cut at moments of rest, never in the middle of a movement (a jump, a turn, a fall); every shot's description stands on its own and repeats the subject, their clothes, the setting and the light in the same words, since the model making it sees only that text and one still frame; anyone who is to appear later is already in frame in the shot before; the camera is still unless a movement is asked for. Each shot holds only what really happens in its own length, at a natural real-time pace: about one distinct action every three seconds of shot, so a 5-second shot holds one action or two quick ones, a 10-second shot about three. The model stops when a shot's length runs out, so action written past it is never made. When the events need more time, give them another shot or a longer one within the range; never crowd a shot. Use as few shots as the events allow at that pace, each within the length range given, with the lengths adding up to the total asked for, give or take a second. If the events cannot all happen at a natural pace in the total, lay out the ones that fit, in order, and name the rest in the Note line with the length they would need. Keep every element the person named and add nothing that changes what they asked for. Such models read plain descriptive prose, not instructions, "no" or "not".

Reply with only the shots, one per line, each in this form and nothing else:

Shot 1 (8 s): the description, 30 to 80 words, one paragraph, with only as much action as 8 seconds hold
Shot 2 (7 s): the next description

If some part cannot be laid out, lay out the rest as shots all the same and add one last line starting with "Note:" saying in a few words what was left out. Plain text only; no heading, no markdown, no other comment.`;

// A shot made shorter by hand: its description is fitted to the new length,
// keeping the look in the same words and the actions that fit, in order,
// and saying what had to go, so nothing is dropped unseen.
const FIT_SYSTEM = `You fit shot descriptions for open-source video models to a new length. The person made a shot shorter than its description was written for. Keep the subject, their clothes, the setting, the light, the style and the camera in the same words. Keep the actions in order from the start, as many as fit in the new length at a natural pace, and leave out the rest; never squeeze more in by speeding them up.${PACING.replace("\n\n", " ")}

Reply with exactly these lines, each starting with the word shown:

Description: the fitted description, one paragraph
Dropped: the actions left out, in a few words, or the word nothing

Plain text only; no markdown.`;

// Coding with a model on a rented GPU and Claude together. A check that
// fixes: the problems found, then the whole answer corrected.
const CODE_FIX_SYSTEM = `You check and fix code written by open-source language models that people run on rented GPUs. These models are weaker than you: their code often has bugs, does not run, calls functions or library features that do not exist, misses edge cases, or does not do what was asked. The person shows you their request and the model's answer. Find what is actually wrong and fix it. Keep the model's structure, names and style where they are sound; change what must change and add what was asked for but is missing; do not rewrite working code for taste.

Reply in exactly two parts, nothing before or after:

Found:
- one line per real problem, the one that matters most first, saying where it is and what is wrong
(or the single line "- nothing wrong" when the code is right)
=== Corrected ===
the complete corrected answer: every file and block in full, never only the changed lines, in fenced code blocks with the language named, each with a one-line note above it when the answer had several. When nothing was wrong, the code unchanged.`;

// Which parts of a coding request the model on the rented GPU should leave
// to Claude: the ones a model of its size tends to get wrong.
const HANDOFF_PLAN_SYSTEM = `You help split coding work between an open-source language model that the person runs on a rented GPU and you. The person shows you a coding request and names the model. Judge which parts of the request a model of that size is likely to get wrong: non-trivial algorithms and mathematics (probability and inference, solvers, search, optimisation, physics, geometry), concurrency, security-sensitive code, parsers, intricate rules engines, exact protocol or file-format details. Ordinary structure, user interface, input handling, wiring, plain game loops and boilerplate stay with the model. Name at most four parts, the hardest first, each small and self-contained enough to be one function or module with a clear interface.

Reply with only lines in this form, nothing else:

Part: short name | what it must do, in one sentence | why it is hard for the model

or the single line "Part: none" when the model can do all of it well.`;

// Claude writes the parts the model handed off, to fit the model's code.
const HANDOFF_FINISH_SYSTEM = `You finish code that an open-source language model wrote with some parts handed off to you. The model wrote what it could and left stubs for the parts it judged too hard, each marked with a comment containing "HANDOFF TO CLAUDE:" and a description of what the part must do; it may also have named such parts in its prose without a marked stub. Write each handed-off part so that it fits the model's code exactly: the same language, the names, parameters, return values and data structures its code already defines and calls, its style and its libraries. Do not rename or restructure the model's code; change it only where a call into your part is plainly wrong or where it would not run, and say so. The result must run as a whole.

Reply in exactly two parts, nothing before or after:

Wrote:
- one line per part: its name, and in a few words how it works; then one line per change you had to make to the model's code
=== Finished ===
the complete program with the handed-off parts written in place of their stubs: every file and block in full, in fenced code blocks with the language named. The model's prose may be cut to one sentence; the "HANDOFF TO CLAUDE" comments go.`;

// With a starting picture, the words must defer to it: the person, the
// clothes, the place and the light are already decided, and a description
// that re-imagines them has the model replace them. Added to the brief for
// an expansion or a continuation that has the picture.
const WITH_PICTURE = `

A starting picture is shown. The clip begins from it, so the person, their face, hair, clothes and body, the place and the light are already decided by the picture and must be kept exactly: do not re-describe or change them, and add no setting of your own. Describe the motion and the camera, and say that the person, clothes and setting stay as they are in the picture; name the clothes and the place briefly as they are, so the model holds on to them through the motion.`;

// The starting picture a request carries, checked, as an image block.
function pictureOf(input) {
  if (!input.image) return null;
  const mediaType = String(input.image.media_type ?? "");
  if (!Object.values(MEDIA_TYPES).includes(mediaType)) throw new ReviewError("The starting picture has to be a PNG, JPEG or WebP file.");
  const data = String(input.image.data ?? "");
  if (!data || !/^[A-Za-z0-9+/]+=*$/.test(data)) throw new ReviewError("The starting picture did not arrive intact.");
  if (Buffer.from(data, "base64").length > MAX_IMAGE_BYTES) throw new ReviewError("That picture is larger than 5 MB, which is more than Claude accepts.");
  return { type: "image", source: { type: "base64", media_type: mediaType, data } };
}

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
  // A reply to a result is an edit written from the person's words; for a
  // clip, or a picture no longer at hand, it is written from the words alone.
  const replying = input.mode === "reply";
  const editing = input.mode === "edit" || replying;
  const clip = replying && Boolean(input.clip);
  const request = String(input.request ?? "").trim();
  if (editing && !request) throw new ReviewError("Say what should change.");
  if (input.kind === "code") {
    const question = String(input.question ?? "").trim();
    const answer = String(input.answer ?? "");
    if (input.mode === "handoff-plan") {
      if (!question) throw new ReviewError("Type the coding request first.");
      const text = [`The model is ${input.model || "an open-source model"}. The request:`, `<request>\n${question}\n</request>`, "Name the parts to leave to you, as Part lines."].join("\n\n");
      return { ...base, max_tokens: 4000, output_config: { effort: "low" }, system: HANDOFF_PLAN_SYSTEM, messages: [{ role: "user", content: text }] };
    }
    if (!answer.trim()) throw new ReviewError("There is no answer to work on yet.");
    if (input.mode !== "fix" && input.mode !== "finish") throw new ReviewError("Unknown kind of code check.");
    const text = [`I asked ${from}:`, `<request>\n${question || "(the request was not kept)"}\n</request>`, "It answered:", `<answer>\n${answer}\n</answer>`, input.mode === "fix" ? "Check the code and fix it: the Found lines, then the corrected answer." : "Write the parts it handed off to you: the Wrote lines, then the finished program."].join("\n\n");
    // Medium effort: a coding check is wanted in a minute or two, not ten.
    return { ...base, output_config: { effort: "medium" }, system: input.mode === "fix" ? CODE_FIX_SYSTEM : HANDOFF_FINISH_SYSTEM, messages: [{ role: "user", content: text }] };
  }
  if (input.kind === "text") {
    const answer = String(input.answer ?? "");
    if (!answer.trim()) throw new ReviewError("There is no answer to check yet.");
    const question = String(input.question ?? "").trim();
    const instructions = String(input.system ?? "").trim();
    const parts = [`I asked ${from}:`, `<request>\n${question || "(the request was not kept)"}\n</request>`];
    if (instructions) parts.push(`It had these standing instructions:`, `<instructions>\n${instructions}\n</instructions>`);
    parts.push(`It answered:`, `<answer>\n${answer}\n</answer>`);
    const focus = String(input.focus ?? "").trim();
    if (editing) parts.push(`Change this about the answer:`, `<change>\n${request}\n</change>`, `Reply with only the revised answer.`);
    else parts.push(`Is the answer right? Check it and tell me what, if anything, is wrong.${focus ? ` Pay particular attention to: ${focus}` : ""}`);
    return { ...base, system: editing ? EDIT_TEXT_SYSTEM : TEXT_SYSTEM, messages: [{ role: "user", content: parts.join("\n\n") }] };
  }
  if (input.kind === "image") {
    // The picture is either one this app made (named by file) or, on the
    // hosted site, one the visitor picked (sent as base64 with its type).
    let mediaType;
    let bytes = null;
    const pictureless = replying && !input.image && (!input.file || clip);
    if (pictureless) {
      // nothing to look at: the words carry the request
    } else if (input.image) {
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
    if (bytes && bytes.length > MAX_IMAGE_BYTES) throw new ReviewError("That picture is larger than 5 MB, which is more than Claude accepts.");
    const prompt = String(input.prompt ?? "").trim();
    const negative = String(input.negative ?? "").trim();
    const focus = String(input.focus ?? "").trim();
    const thing = clip ? "clip" : "picture";
    const ask = clip ? `I want this changed about the clip:\n\n<change>\n${request}\n</change>\n\n${lengthLine(input.seconds) ? `${lengthLine(input.seconds)}\n\n` : ""}Write the Description and Avoid lines for the remake.` : editing ? `I want this changed about the picture:\n\n<change>\n${request}\n</change>\n\nWrite the Description, Avoid and Keep lines for the image-to-image pass.` : `How well does the picture match, what is wrong with it, and what should I ask for instead?${focus ? ` Pay particular attention to: ${focus}` : ""}`;
    const text = [`${from[0].toUpperCase()}${from.slice(1)} made this ${thing} from my description:`, `<description>\n${prompt || "(the description was not kept)"}\n</description>`, negative ? `I asked it to avoid:\n\n<avoid>\n${negative}\n</avoid>` : "I gave it nothing to avoid.", ...(pictureless && !clip ? ["The picture itself is not at hand; go by the description."] : []), ask].join("\n\n");
    return {
      ...base,
      system: clip ? EDIT_CLIP_PACED : editing ? EDIT_IMAGE_SYSTEM : IMAGE_SYSTEM,
      messages: [{ role: "user", content: bytes ? [{ type: "image", source: { type: "base64", media_type: mediaType, data: bytes.toString("base64") } }, { type: "text", text }] : text }],
    };
  }
  if (input.kind === "prompt" && input.mode === "suggest") {
    const prompt = String(input.prompt ?? "").trim();
    if (!prompt) throw new ReviewError("Type what the picture or clip should show first.");
    const negative = String(input.negative ?? "").trim();
    const thing = input.clip ? "clip" : "picture";
    const parts = [`I want a ${thing} from ${input.model ? `${input.model}` : "an open-source model"}. I typed:`, `<description>\n${prompt}\n</description>`, negative ? `I asked it to avoid: ${negative}.` : "I gave it nothing to avoid."];
    const picture = pictureOf(input);
    if (picture) parts.push(`The ${thing} starts from the picture shown: the person, clothes, place and light are to stay as they are in it, and the avoid list should name a different person, a changed face, changed clothes and a changed background.`);
    if (input.clip && lengthLine(input.seconds)) parts.push(lengthLine(input.seconds));
    parts.push("Write the Description, Avoid and Why lines.");
    const text = parts.join("\n\n");
    const suggestSystem = input.clip ? SUGGEST_SYSTEM.replace("\n\nReply with exactly", `${PACING}\n\nReply with exactly`) : SUGGEST_SYSTEM;
    return { ...base, max_tokens: 4000, system: picture ? suggestSystem + WITH_PICTURE : suggestSystem, messages: [{ role: "user", content: picture ? [picture, { type: "text", text }] : text }] };
  }
  if (input.kind === "prompt" && input.mode === "continue") {
    const prompt = String(input.prompt ?? "").trim();
    if (!request) throw new ReviewError("Say what happens next.");
    const picture = pictureOf(input);
    const parts = [`The clip was made${input.model ? ` by ${input.model}` : ""} from this description:`, `<description>\n${prompt || "(the description was not kept)"}\n</description>`, `What happens next:`, `<next>\n${request}\n</next>`, ...(picture ? ["The next clip starts from the frame shown: the person, clothes, place and light in it are to be kept."] : []), ...(lengthLine(input.seconds, "The next clip") ? [lengthLine(input.seconds, "The next clip")] : []), "Reply with only the description of the next clip."];
    const text = parts.join("\n\n");
    return { ...base, max_tokens: 4000, system: picture ? CONTINUE_PACED + WITH_PICTURE : CONTINUE_PACED, messages: [{ role: "user", content: picture ? [picture, { type: "text", text }] : text }] };
  }
  if (input.kind === "prompt" && input.mode === "scene") {
    const prompt = String(input.prompt ?? "").trim();
    if (!prompt) throw new ReviewError("Say what happens in the scene.");
    const total = Number(input.seconds);
    const min = Number(input.minSeconds);
    const max = Number(input.maxSeconds);
    if (!(total > 0 && min > 0 && max >= min)) throw new ReviewError("The scene needs a length and the model's shot range.");
    const negative = String(input.negative ?? "").trim();
    const picture = pictureOf(input);
    const parts = [`Lay out this scene as shots for a video model${input.model ? ` (${input.model})` : ""}. The model makes ${min} to ${max} seconds in one go; the whole scene should run about ${total} seconds.`, `<scene>\n${prompt}\n</scene>`, `At a natural pace a ${min}-second shot holds about ${actionBudget(min)} distinct action${actionBudget(min) === 1 ? "" : "s"} and a ${max}-second shot about ${actionBudget(max)}; give each shot a length its action needs.`];
    if (negative) parts.push(`It is asked to avoid: ${negative}. Leave those out of the descriptions.`);
    if (picture) parts.push("The first shot starts from the picture shown: the person, clothes, place and light in it are to be kept through every shot, and each description should say so.");
    // The picture is at hand but not shown: it is described to the writer
    // as a given, so the shots defer to it all the same.
    else if (input.pictureUnseen) parts.push("The first shot starts from a photo that is not shown here, of the person and the place the clip begins from. They are already decided by that photo: do not invent a face, hair, clothes or a setting; refer to them as they are in the picture, and say in each shot that the person, their clothes and the place stay as they are in the picture apart from what the shot changes.");
    parts.push("Reply with only the shot lines.");
    const text = parts.join("\n\n");
    return { ...base, max_tokens: 6000, system: picture ? SCENE_SYSTEM + WITH_PICTURE : SCENE_SYSTEM, messages: [{ role: "user", content: picture ? [picture, { type: "text", text }] : text }] };
  }
  if (input.kind === "prompt" && input.mode === "fix") {
    if (!request) throw new ReviewError("Say what is wrong with the clip.");
    const shots = Array.isArray(input.shots) ? input.shots.map((s, i) => ({ index: Number(s.index) || i + 1, seconds: Number(s.seconds) || 0, text: String(s.text ?? "").trim() })).filter((s) => s.text) : [];
    if (shots.length < 2) throw new ReviewError("A fix needs the clip's shots, two or more.");
    const prompt = String(input.prompt ?? "").trim();
    const negative = String(input.negative ?? "").trim();
    const parts = [`A clip was made${input.model ? ` by ${input.model}` : ""} as ${shots.length} shots, joined${prompt ? ", from this request:" : "."}`, ...(prompt ? [`<request>\n${prompt}\n</request>`] : []), "The shots, each with its length and the description it was made from:", `<shots>\n${shots.map((s) => `Shot ${s.index} (${s.seconds.toFixed(1)} s): ${s.text}`).join("\n")}\n</shots>`, negative ? `The model was asked to avoid: ${negative}.` : "", "What is wrong with the result:", `<wrong>\n${request}\n</wrong>`, "Write the Shot lines for the shots to make again, then the Carry and Why lines."].filter(Boolean);
    return { ...base, max_tokens: 6000, system: FIX_SYSTEM, messages: [{ role: "user", content: parts.join("\n\n") }] };
  }
  if (input.kind === "prompt" && input.mode === "fit") {
    const prompt = String(input.prompt ?? "").trim();
    if (!prompt) throw new ReviewError("There is no description to fit.");
    const to = Number(input.seconds);
    const from = Number(input.fromSeconds);
    if (!(to > 0)) throw new ReviewError("Say the shot's new length.");
    const parts = [`This shot description was written for ${from > 0 ? `${from} seconds` : "a longer shot"}; the shot is now ${to} seconds.`, `<description>\n${prompt}\n</description>`, lengthLine(to, "The shot"), "Write the Description and Dropped lines."];
    return { ...base, max_tokens: 3000, system: FIT_SYSTEM, messages: [{ role: "user", content: parts.join("\n\n") }] };
  }
  if (input.kind === "prompt" && input.mode === "expand") {
    const prompt = String(input.prompt ?? "").trim();
    if (!prompt) throw new ReviewError("Say what the picture or clip should show.");
    const negative = String(input.negative ?? "").trim();
    const picture = pictureOf(input);
    const parts = [`Expand this description for a ${input.clip ? "video" : "picture"} model${input.model ? ` (${input.model})` : ""}:`, `<description>\n${prompt}\n</description>`];
    if (negative) parts.push(`It is asked to avoid: ${negative}. Leave those out of the description.`);
    if (picture) parts.push(`The ${input.clip ? "clip" : "picture"} starts from the picture shown: the person, clothes, place and light in it are to be kept, and the description should say so.`);
    if (input.clip && lengthLine(input.seconds)) parts.push(lengthLine(input.seconds));
    parts.push("Reply with only the expanded description.");
    const text = parts.join("\n\n");
    const system = input.clip ? EXPAND_CLIP_SYSTEM : EXPAND_SYSTEM;
    return { ...base, max_tokens: 4000, system: picture ? system + WITH_PICTURE : system, messages: [{ role: "user", content: picture ? [picture, { type: "text", text }] : text }] };
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
    // `onEvent` hears where Claude is: thinking (with how much so far) or
    // writing, so a page can show progress before the first word.
    async review(input, onText, use = {}, onEvent = () => {}) {
      let params = buildRequest(input, { outputDir });
      const Anthropic = sdk ?? (client ? null : await loadSdk());
      const key = use.apiKey || apiKey();
      const api = client ?? (key ? new Anthropic({ apiKey: key }) : new Anthropic());
      try {
        let stream;
        let wrote = false;
        let thought = 0;
        for (let attempt = 0; ; attempt++) {
          stream = api.beta.messages.stream(params);
          try {
            for await (const event of stream) {
              if (event.type === "content_block_start" && event.content_block?.type === "thinking") onEvent({ phase: "thinking", thought });
              else if (event.type === "content_block_delta" && event.delta.type === "thinking_delta") {
                thought += event.delta.thinking?.length ?? 0;
                onEvent({ phase: "thinking", thought });
              } else if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
                if (!wrote) onEvent({ phase: "writing", thought });
                wrote = true;
                onText(event.delta.text);
              }
            }
            break;
          } catch (err) {
            // An effort setting the API does not take: asked again without it.
            if (attempt === 0 && !wrote && params.output_config && Anthropic && err instanceof Anthropic.BadRequestError && /output_config|effort/i.test(err.message)) {
              const { output_config: _, ...rest } = params;
              params = rest;
              continue;
            }
            throw err;
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
