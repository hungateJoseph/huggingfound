import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { startStubHub } from "./stub-hub.js";

process.env.HUGGINGFOUND_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "huggingfound-review-"));
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;
const { REVIEW_MODEL, ReviewError, actionBudget, buildRequest, createReviewer } = await import("../src/review.js");
const { createServer } = await import("../src/server.js");

const outputDir = path.join(process.env.HUGGINGFOUND_HOME, "output");
fs.mkdirSync(outputDir, { recursive: true });
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
fs.writeFileSync(path.join(outputDir, "pic.png"), PNG);

// A stand-in for the Anthropic client: remembers the request and plays back a stream.
function fakeClient({ texts = ["Looks right."], stop = "end_turn", model = REVIEW_MODEL, fail = null } = {}) {
  const calls = [];
  return {
    calls,
    beta: {
      messages: {
        stream(params) {
          calls.push(params);
          return {
            async *[Symbol.asyncIterator]() {
              if (fail) throw fail;
              yield { type: "content_block_start", content_block: { type: "thinking" } };
              yield { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" } };
              for (const text of texts) yield { type: "content_block_delta", delta: { type: "text_delta", text } };
            },
            finalMessage: async () => ({ stop_reason: stop, model }),
          };
        },
      },
    },
  };
}

test("a text check asks Opus with the question, the answer and the model's instructions", () => {
  const req = buildRequest({ kind: "text", model: "qwen-coder", question: "Write fizzbuzz", answer: "for i in range(15): print(i)", system: "Be terse." });
  assert.equal(req.model, "claude-opus-5");
  assert.deepEqual(req.thinking, { type: "adaptive" });
  assert.equal(req.fallbacks, "default");
  assert.deepEqual(req.betas, ["server-side-fallback-2026-07-01"]);
  assert.match(req.system, /small open-source language models/);
  const text = req.messages[0].content;
  assert.match(text, /a local model \(qwen-coder\)/);
  assert.match(text, /<request>\nWrite fizzbuzz\n<\/request>/);
  assert.match(text, /<instructions>\nBe terse\.\n<\/instructions>/);
  assert.match(text, /<answer>\nfor i in range\(15\): print\(i\)\n<\/answer>/);
  assert.equal(req.messages.length, 1);
});

test("nothing is cut from a long answer", () => {
  const answer = "x = 1\n".repeat(20000);
  assert.ok(buildRequest({ kind: "text", question: "q", answer }).messages[0].content.includes(answer));
});

test("a picture check sends the image with its description and avoid list", () => {
  const req = buildRequest({ kind: "image", model: "sd15", file: "../output/pic.png", prompt: "a lighthouse at dusk", negative: "anime" }, { outputDir });
  const [image, text] = req.messages[0].content;
  assert.deepEqual(image, { type: "image", source: { type: "base64", media_type: "image/png", data: PNG.toString("base64") } });
  assert.match(text.text, /<description>\na lighthouse at dusk\n<\/description>/);
  assert.match(text.text, /<avoid>\nanime\n<\/avoid>/);
  assert.match(req.system, /Description:.*Avoid:/s);
});

test("a reply to a result is an edit written from the words: with the picture when it is at hand, from the description alone for a clip", () => {
  const pic = buildRequest({ kind: "image", mode: "reply", model: "sd15", request: "two lighthouses, not one", prompt: "a lighthouse at dusk", image: { media_type: "image/png", data: PNG.toString("base64") } });
  assert.match(pic.system, /Keep:/);
  const [image, text] = pic.messages[0].content;
  assert.equal(image.type, "image");
  assert.match(text.text, /<change>\ntwo lighthouses, not one\n<\/change>/);
  const clip = buildRequest({ kind: "image", mode: "reply", clip: true, model: "wan", request: "slower camera pan", prompt: "waves at dusk", negative: "blurry" });
  assert.match(clip.system, /same random seed/);
  assert.doesNotMatch(clip.system, /Keep:/);
  assert.equal(typeof clip.messages[0].content, "string", "nothing to look at: words only");
  assert.match(clip.messages[0].content, /made this clip from my description:[\s\S]*<description>\nwaves at dusk\n<\/description>[\s\S]*<avoid>\nblurry\n<\/avoid>[\s\S]*<change>\nslower camera pan\n<\/change>/);
  // A picture no longer at hand is replied to from its description.
  const blind = buildRequest({ kind: "image", mode: "reply", request: "darker", prompt: "a barn" });
  assert.equal(typeof blind.messages[0].content, "string");
  assert.match(blind.messages[0].content, /The picture itself is not at hand/);
  assert.throws(() => buildRequest({ kind: "image", mode: "reply", prompt: "a barn", request: " " }), /Say what should change/);
});

test("a suggestion asks for the description to use instead, with the starting picture when there is one", () => {
  const plain = buildRequest({ kind: "prompt", mode: "suggest", clip: true, model: "wan", prompt: "jumping jacks in bare feet", negative: "blurry" });
  assert.match(plain.system, /cannot read instructions, "no", "not" or "do not"/);
  assert.match(plain.system, /Description:[\s\S]*Avoid:[\s\S]*Why:/);
  assert.equal(typeof plain.messages[0].content, "string");
  assert.match(plain.messages[0].content, /I want a clip from wan\. I typed:[\s\S]*<description>\njumping jacks in bare feet\n<\/description>[\s\S]*avoid: blurry\./);
  const withPicture = buildRequest({ kind: "prompt", mode: "suggest", clip: true, prompt: "jumping jacks", image: { media_type: "image/png", data: PNG.toString("base64") } });
  const [image, text] = withPicture.messages[0].content;
  assert.equal(image.type, "image");
  assert.match(text.text, /starts from the picture shown/);
  assert.throws(() => buildRequest({ kind: "prompt", mode: "suggest", prompt: " " }), /Type what/);
  assert.throws(() => buildRequest({ kind: "prompt", mode: "suggest", prompt: "x", image: { media_type: "image/gif", data: "AAAA" } }), /PNG, JPEG or WebP/);
});

test("continuing a clip asks for the next shot from the first description and what happens next", () => {
  const req = buildRequest({ kind: "prompt", mode: "continue", clip: true, model: "wan", prompt: "a man dealing a deck of cards", request: "now he stands up and leaves the cards on the table" });
  assert.match(req.system, /starting from the last frame of the first/);
  assert.match(req.messages[0].content, /made by wan from this description:[\s\S]*<description>\na man dealing a deck of cards\n<\/description>[\s\S]*<next>\nnow he stands up and leaves the cards on the table\n<\/next>/);
  assert.throws(() => buildRequest({ kind: "prompt", mode: "continue", prompt: "a man", request: " " }), /what happens next/);
});

test("expanding a description asks for prose a model follows, with the avoid list kept out of it", () => {
  const req = buildRequest({ kind: "prompt", mode: "expand", clip: true, model: "wan", prompt: "waves at dusk", negative: "blurry, text" });
  assert.match(req.system, /60 to 120 words/);
  assert.equal(req.max_tokens, 4000);
  assert.match(req.messages[0].content, /for a video model \(wan\):[\s\S]*<description>\nwaves at dusk\n<\/description>[\s\S]*avoid: blurry, text\. Leave those out/);
  assert.match(buildRequest({ kind: "prompt", mode: "expand", prompt: "a barn" }).messages[0].content, /for a picture model:/);
  // With a starting picture, the words defer to it: the person, clothes and place are kept, not re-imagined.
  const fromPicture = buildRequest({ kind: "prompt", mode: "expand", clip: true, prompt: "she does a 360 turn", image: { media_type: "image/png", data: PNG.toString("base64") } });
  assert.match(fromPicture.system, /must be kept exactly: do not re-describe or change them/);
  const [img, body] = fromPicture.messages[0].content;
  assert.equal(img.type, "image");
  assert.match(body.text, /starts from the picture shown: the person, clothes, place and light in it are to be kept/);
  const next = buildRequest({ kind: "prompt", mode: "continue", clip: true, prompt: "a man dealing cards", request: "he stands up", image: { media_type: "image/png", data: PNG.toString("base64") } });
  assert.match(next.system, /must be kept exactly/);
  assert.equal(next.messages[0].content[0].type, "image");
  assert.throws(() => buildRequest({ kind: "prompt", mode: "expand", prompt: " " }), /should show/);
  assert.throws(() => buildRequest({ kind: "prompt", mode: "other", prompt: "x" }), /Unknown/);
});

test("a fix to a pieced clip asks which shots to make again, with the shot list, the request and what went wrong", () => {
  const req = buildRequest({ kind: "prompt", mode: "fix", clip: true, model: "wan", prompt: "a man eats a hamburger next to his wife in a big orange hat; he spills ketchup on his white pants", request: "the wife's orange hat is missing from the second shot on", negative: "blurry", shots: [{ index: 1, seconds: 4.1, text: "a man eats a hamburger at a diner table, his wife beside him in a big orange hat" }, { index: 2, seconds: 4.1, text: "the same man bites the hamburger, his wife beside him" }, { index: 3, seconds: 4.1, text: "ketchup drips onto the man's white pants; his wife laughs" }] });
  assert.match(req.system, /Only the shots that need it will be made again[\s\S]*Shot N: the full revised description[\s\S]*Carry: yes or no[\s\S]*Why:/);
  assert.equal(req.max_tokens, 6000);
  assert.match(req.messages[0].content, /A clip was made by wan as 3 shots, joined, from this request:\n\n<request>\na man eats a hamburger[\s\S]*<shots>\nShot 1 \(4\.1 s\): a man eats a hamburger at a diner table[\s\S]*Shot 3 \(4\.1 s\): ketchup drips[\s\S]*<\/shots>\n\nThe model was asked to avoid: blurry\.\n\nWhat is wrong with the result:\n\n<wrong>\nthe wife's orange hat is missing from the second shot on\n<\/wrong>\n\nWrite the Shot lines for the shots to make again, then the Carry and Why lines\./);
  assert.throws(() => buildRequest({ kind: "prompt", mode: "fix", request: " ", shots: [{ text: "a" }, { text: "b" }] }), /Say what is wrong/);
  assert.throws(() => buildRequest({ kind: "prompt", mode: "fix", request: "no hat", shots: [{ text: "a" }] }), /two or more/);
});

test("a scene is laid out as shots within the model's range, cut at rest, each repeating who and where", () => {
  const req = buildRequest({ kind: "prompt", mode: "scene", clip: true, model: "wan", prompt: "a man on a trampoline does a front flip, falls, then a backflip; the camera pans to his father", seconds: 12, minSeconds: 1, maxSeconds: 5, negative: "blurry" });
  assert.match(req.system, /cut at moments of rest, never in the middle of a movement[\s\S]*repeats the subject, their clothes, the setting and the light[\s\S]*Shot 1 \(8 s\):/);
  assert.equal(req.max_tokens, 6000);
  assert.match(req.messages[0].content, /video model \(wan\)\. The model makes 1 to 5 seconds in one go; the whole scene should run about 12 seconds\.[\s\S]*<scene>\na man on a trampoline[\s\S]*<\/scene>[\s\S]*avoid: blurry\. Leave those out[\s\S]*Reply with only the shot lines\./);
  const fromPicture = buildRequest({ kind: "prompt", mode: "scene", clip: true, prompt: "she walks to the window", seconds: 10, minSeconds: 5, maxSeconds: 15, image: { media_type: "image/png", data: PNG.toString("base64") } });
  assert.match(fromPicture.system, /must be kept exactly/);
  assert.equal(fromPicture.messages[0].content[0].type, "image");
  assert.match(fromPicture.messages[0].content[1].text, /The first shot starts from the picture shown/);
  assert.match(req.system, /taking off a jacket or a sweater, changing shoes, warming up in gym clothes[\s\S]*add one last line starting with "Note:"/);
  // The photo at hand but not shown: described as a given, the shots defer to it.
  const unseen = buildRequest({ kind: "prompt", mode: "scene", clip: true, prompt: "she takes off her sweater", seconds: 8, minSeconds: 1, maxSeconds: 5, pictureUnseen: true });
  assert.equal(typeof unseen.messages[0].content, "string", "no image block");
  assert.match(unseen.messages[0].content, /starts from a photo that is not shown here[\s\S]*do not invent a face, hair, clothes or a setting/);
  assert.doesNotMatch(unseen.system, /A starting picture is shown/);
  assert.throws(() => buildRequest({ kind: "prompt", mode: "scene", prompt: "x", minSeconds: 1, maxSeconds: 5 }), /needs a length/);
  assert.throws(() => buildRequest({ kind: "prompt", mode: "scene", prompt: " ", seconds: 10, minSeconds: 1, maxSeconds: 5 }), /happens in the scene/);
});

test("bad requests are refused before anything is sent", () => {
  assert.throws(() => buildRequest({ kind: "text", question: "q", answer: "  " }), ReviewError);
  assert.throws(() => buildRequest({ kind: "image", file: "notes.txt" }, { outputDir }), /not a picture/);
  assert.throws(() => buildRequest({ kind: "image", file: "gone.png" }, { outputDir }), /no longer on this computer/);
  assert.throws(() => buildRequest({ kind: "video" }), /Unknown/);
  fs.writeFileSync(path.join(outputDir, "big.png"), Buffer.alloc(5 * 1024 * 1024 + 1));
  assert.throws(() => buildRequest({ kind: "image", file: "big.png" }, { outputDir }), /larger than 5 MB/);
});

test("the review streams text only, and reports the model that wrote it", async () => {
  const client = fakeClient({ texts: ["This has ", "one problem."] });
  const seen = [];
  const result = await createReviewer({ client, outputDir }).review({ kind: "text", question: "q", answer: "a" }, (t) => seen.push(t));
  assert.deepEqual(seen, ["This has ", "one problem."]);
  assert.deepEqual(result, { declined: false, model: "claude-opus-5", note: "" });
  assert.equal(client.calls.length, 1);
});

test("a declined or cut-off review says so", async () => {
  const declined = await createReviewer({ client: fakeClient({ texts: ["partial"], stop: "refusal" }) }).review({ kind: "text", question: "q", answer: "a" }, () => {});
  assert.equal(declined.declined, true);
  assert.equal(declined.discard, true);
  const cut = await createReviewer({ client: fakeClient({ stop: "max_tokens" }) }).review({ kind: "text", question: "q", answer: "a" }, () => {});
  assert.match(cut.note, /cut off/);
});

test("API failures become sentences a person can act on", async () => {
  const sdk = (await import("@anthropic-ai/sdk")).default;
  const cases = [
    [new sdk.AuthenticationError(401, {}, "bad key", new Headers()), /refused the API key/, 401],
    [new sdk.RateLimitError(429, {}, "slow down", new Headers()), /rate limiting/, 429],
    [new sdk.BadRequestError(400, {}, "image too large", new Headers()), /rejected the request/, 400],
    [new sdk.APIConnectionError({ message: "offline" }), /Could not reach Anthropic/, 502],
  ];
  for (const [fail, pattern, status] of cases) {
    await assert.rejects(
      createReviewer({ sdk, client: fakeClient({ fail }) }).review({ kind: "text", question: "q", answer: "a" }, () => {}),
      (err) => err instanceof ReviewError && pattern.test(err.message) && err.status === status,
    );
  }
});

// ---- through the server -----------------------------------------------------

let stub;
let server;
let base;
let asked;
const home = process.env.HUGGINGFOUND_HOME;
const dead = "http://127.0.0.1:1";
const common = () => ({ envFile: path.join(home, ".env"), scanFile: path.join(home, "scan.json"), voicesFile: path.join(home, "voices.json"), hubBase: stub.base, civitaiBase: dead, redditAuthBase: dead, redditApiBase: dead, githubBase: dead, hnBase: dead, lemmyBase: dead, youtubeBase: dead, writtenSummaries: false });
const listen = (s) => new Promise((resolve) => s.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${s.address().port}`)));
const post = (b, p, body) => fetch(b + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

before(async () => {
  stub = await startStubHub();
  asked = [];
  server = createServer({
    ...common(),
    reviewer: {
      async review(input, onText) {
        asked.push(input);
        if (input.answer === "boom") throw new ReviewError("Anthropic refused the API key. Check that it is entered correctly and still active.", 401);
        onText("This is ");
        if (input.answer === "late") throw new Error("socket closed");
        onText("correct.");
        return { declined: false, model: "claude-opus-5", note: "" };
      },
    },
  });
  base = await listen(server);
});

after(() => {
  server.close();
  stub.server.close();
});

test("without a key the check explains what is missing, and the key setting is validated and masked", async () => {
  const plain = createServer(common());
  const b = await listen(plain);
  try {
    let s = await (await fetch(`${b}/api/state`)).json();
    assert.equal(s.claudeReady, false);
    assert.equal(s.claudeKey, "");
    const res = await post(b, "/api/review", { kind: "text", question: "q", answer: "a" });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /Anthropic API key in Settings/);
    assert.equal((await post(b, "/api/settings", { ANTHROPIC_API_KEY: "hello" })).status, 400);
    assert.equal((await post(b, "/api/settings", { ANTHROPIC_API_KEY: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz" })).status, 200);
    s = await (await fetch(`${b}/api/state`)).json();
    assert.equal(s.claudeReady, true);
    assert.match(s.claudeKey, /^sk-a\*+wxyz$/);
    assert.equal((await post(b, "/api/settings", { ANTHROPIC_API_KEY: "" })).status, 200);
    assert.equal((await (await fetch(`${b}/api/state`)).json()).claudeReady, false);
  } finally {
    plain.close();
  }
});

test("a check streams back as lines: the text, then how it ended", async () => {
  const res = await post(base, "/api/review", { kind: "text", model: "m", question: "q", answer: "a" });
  assert.equal(res.status, 200);
  const lines = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines, [{ text: "This is " }, { text: "correct." }, { done: true, declined: false, model: "claude-opus-5", note: "" }]);
  assert.deepEqual(asked.at(-1), { kind: "text", model: "m", question: "q", answer: "a" });
});

test("a failure before any text is an error status; one after it ends the stream with the reason", async () => {
  const early = await post(base, "/api/review", { kind: "text", question: "q", answer: "boom" });
  assert.equal(early.status, 401);
  assert.match((await early.json()).error, /refused the API key/);
  const late = await post(base, "/api/review", { kind: "text", question: "q", answer: "late" });
  assert.equal(late.status, 200);
  const lines = (await late.text()).trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines, [{ text: "This is " }, { error: "The check failed: socket closed" }]);
});

test("a clip's words are paced to its length: Claude is told how long it runs and how much action fits, so no action is written past the end", () => {
  const text = (r) => (typeof r.messages[0].content === "string" ? r.messages[0].content : r.messages[0].content.at(-1).text);
  assert.deepEqual([1, 2, 5, 8, 10, 15].map(actionBudget), [1, 1, 2, 3, 3, 5]);
  const scene = buildRequest({ kind: "prompt", mode: "scene", clip: true, prompt: "a man does a flip, falls, gets up and bows", seconds: 30, minSeconds: 5, maxSeconds: 15 });
  assert.match(scene.system, /Each shot holds only what really happens in its own length/);
  assert.match(scene.system, /never crowd a shot/);
  assert.match(scene.system, /name the rest in the Note line/, "events that do not fit are said, not dropped unseen");
  assert.match(text(scene), /a 5-second shot holds about 2 distinct actions and a 15-second shot about 5/);
  const expand = buildRequest({ kind: "prompt", mode: "expand", clip: true, prompt: "a dog runs on a beach", seconds: 5 });
  assert.match(expand.system, /Timing matters/);
  assert.match(text(expand), /The clip runs 5 seconds: describe at most 2 distinct actions/);
  assert.doesNotMatch(buildRequest({ kind: "prompt", mode: "expand", prompt: "a dog" }).system, /Timing matters/, "a picture has no length");
  assert.match(text(buildRequest({ kind: "prompt", mode: "suggest", clip: true, prompt: "jumping jacks", seconds: 10 })), /runs 10 seconds: describe at most 3 distinct actions/);
  assert.match(text(buildRequest({ kind: "prompt", mode: "continue", clip: true, prompt: "a", request: "then he sits", seconds: 5 })), /The next clip runs 5 seconds/);
  const remake = buildRequest({ kind: "image", mode: "reply", clip: true, prompt: "a man", request: "give him a hat", seconds: 5 });
  assert.match(remake.system, /Timing matters/);
  assert.match(text(remake), /runs 5 seconds/);
  assert.match(buildRequest({ kind: "prompt", mode: "fix", clip: true, request: "no hat", prompt: "p", shots: [{ index: 1, seconds: 5, text: "a" }, { index: 2, seconds: 5, text: "b" }] }).system, /A shot keeps its length/);
  // A shot shortened by hand is fitted to its new length, and what had to go is named.
  const fit = buildRequest({ kind: "prompt", mode: "fit", prompt: "he jumps, lands, bows and waves", fromSeconds: 9, seconds: 5 });
  assert.match(text(fit), /written for 9 seconds; the shot is now 5 seconds/);
  assert.match(text(fit), /The shot runs 5 seconds: describe at most 2 distinct actions/);
  assert.match(fit.system, /Dropped: the actions left out/);
  assert.throws(() => buildRequest({ kind: "prompt", mode: "fit", prompt: "x" }), /new length/);
});

test("coding with the rented model and Claude: Claude names the hard parts, checks and fixes code, and writes the parts handed to it", () => {
  const plan = buildRequest({ kind: "code", mode: "handoff-plan", question: "write Minesweeper combined with Scrabble", model: "Qwen3.8-27B" });
  assert.match(plan.system, /at most four parts/);
  assert.match(plan.system, /Part: short name \| what it must do/);
  assert.match(plan.messages[0].content, /The model is Qwen3\.8-27B\. The request:\n\n<request>\nwrite Minesweeper combined with Scrabble\n<\/request>/);
  const fix = buildRequest({ kind: "code", mode: "fix", model: "Qwen3.8-27B", question: "a fizzbuzz", answer: "```py\nfor i in range(15): print(i)\n```" });
  assert.match(fix.system, /=== Corrected ===/);
  assert.match(fix.messages[0].content, /<answer>\n```py\nfor i in range\(15\)/);
  const finish = buildRequest({ kind: "code", mode: "finish", question: "q", answer: "def odds(board):\n    # HANDOFF TO CLAUDE: odds\n    pass" });
  assert.match(finish.system, /"HANDOFF TO CLAUDE:"/);
  assert.match(finish.system, /=== Finished ===/);
  assert.match(finish.system, /the names, parameters, return values and data structures its code already defines and calls/);
  assert.throws(() => buildRequest({ kind: "code", mode: "fix", question: "q", answer: " " }), /no answer/);
  assert.throws(() => buildRequest({ kind: "code", mode: "handoff-plan", question: "" }), /request first/);
});

test("Claude's thinking is reported as it goes, and an effort setting the API refuses is asked again without it", async () => {
  class BadRequestError extends Error {}
  const sdk = Object.assign(function Anthropic() {}, { BadRequestError, AuthenticationError: class extends Error {}, PermissionDeniedError: class extends Error {}, RateLimitError: class extends Error {}, APIConnectionError: class extends Error {}, APIError: class extends Error {} });
  const sent = [];
  const events = [
    { type: "content_block_start", content_block: { type: "thinking" } },
    { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "Let me see. " } },
    { type: "content_block_delta", delta: { type: "text_delta", text: "Wrote:\n- odds" } },
  ];
  const client = {
    beta: {
      messages: {
        stream(params) {
          sent.push(params);
          const refuse = sent.length === 1;
          return {
            async *[Symbol.asyncIterator]() {
              if (refuse) throw new BadRequestError("output_config.effort: Extra inputs are not permitted");
              yield* events;
            },
            finalMessage: async () => ({ model: "claude-opus-5", stop_reason: "end_turn" }),
          };
        },
      },
    },
  };
  const reviewer = createReviewer({ sdk, client });
  const heard = [];
  let text = "";
  const result = await reviewer.review({ kind: "code", mode: "finish", question: "q", answer: "def odds(): # HANDOFF TO CLAUDE: odds" }, (t) => (text += t), {}, (e) => heard.push(e));
  assert.equal(result.declined, false);
  assert.equal(text, "Wrote:\n- odds");
  assert.deepEqual(sent.map((p) => p.output_config?.effort ?? null), ["medium", null], "asked at medium effort, then again without the setting");
  assert.deepEqual(heard.map((e) => e.phase), ["thinking", "thinking", "writing"]);
  assert.equal(heard.at(-1).thought, "Let me see. ".length);
  assert.equal(buildRequest({ kind: "code", mode: "handoff-plan", question: "q" }).output_config.effort, "low");
});
