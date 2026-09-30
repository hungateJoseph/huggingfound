// Finds reports that a model refuses requests: "won't answer", "says it is
// against its guidelines", "censored", "lobotomized". Counter-reports
// ("uncensored", "never refuses", "abliterated") weigh against them. The
// search hides models with a clear refusal record unless asked to show them.

export const REFUSAL_RE = /\b(refus(e|es|ed|ing|al|als)|won'?t (answer|respond|write|help|do|generate|comply)|(it|model|she|he|bot|assistant) (says?|said|replies|replied|responds|responded|tells?|told)[^.?!]{0,40}\b(can'?t|cannot|won'?t|not able)|i can'?t (help|assist|comply|do that|provide|generate|write|create|answer)|declin(e|es|ed|ing)|censor(ed|ship|s)?|guidelines?|content polic(y|ies)|safety (filter|training|rails|guardrails)|guardrails?|lobotomi[sz]ed|moralis(es|ing)|moraliz(es|ing)|preach(y|es|ing)|lectur(es|ing)|nann(y|ies)|too (safe|restricted)|overly (cautious|restrictive)|restrictive|as an ai\b|not allowed|against (the |its |my )?(law|policy|rules|terms))\b/i;

export const UNCENSORED_RE = /\b(uncensored|unrestricted|abliterated|heretic|no refusals?|never refuses|doesn'?t refuse|does not refuse|without refusals?|no censorship|unfiltered|nsfw|low refusal rate|fewer refusals|less censored|remov(e|es|ed|ing) (the |its |all )?(refusals?|censorship)|refusals? (removed|gone))\b/i;

// The summarizer itself sometimes refuses; that is not a report about the model.
export const SUMMARIZER_REFUSAL_RE = /^(users:\s*)?(i can'?t|i cannot|i'?m (not able|unable)|i am (not able|unable)|sorry,? (but )?i|as an ai)/i;

function pieces(entry, summary) {
  const out = [];
  for (const d of entry?.discussions ?? []) {
    out.push({ text: d.title ?? "", weight: 1 + Math.min(2, (d.comments ?? 0) / 4) });
    for (const c of d.comments_text ?? []) out.push({ text: c.text ?? "", weight: 0.8 });
  }
  for (const line of summary?.long ?? []) {
    if (/^Users:/.test(line) && !SUMMARIZER_REFUSAL_RE.test(line)) out.push({ text: line, weight: 1.5, summary: true });
  }
  return out;
}

// Weighs what people wrote. Returns a small report: how strong the refusal
// record is, the strongest example, and whether people also call the model
// uncensored (which cancels weak reports).
export function refusalSignals(entry, summary = null) {
  let refusing = 0;
  let open = 0;
  let example = null;
  for (const p of pieces(entry, summary)) {
    const text = String(p.text);
    const r = REFUSAL_RE.test(text);
    const u = UNCENSORED_RE.test(text);
    // A question ("how to remove censorship?") is a weaker report than a statement.
    const weight = /\?\s*$/.test(text) ? p.weight * 0.4 : p.weight;
    if (r && !u) {
      refusing += weight;
      if (!example || p.summary) example = text.replace(/^Users:\s*/, "").slice(0, 140);
    } else if (u && !r) {
      open += weight;
    } else if (r && u) {
      // "not uncensored at all, it refuses" is a refusal report; "uncensored, never refuses" is not.
      if (/\b(not|isn'?t|is not)\s+(really\s+|actually\s+)?(uncensored|unrestricted)\b/i.test(text) || /\bstill (refuses|censored)\b/i.test(text)) {
        refusing += weight;
        example = example ?? text.replace(/^Users:\s*/, "").slice(0, 140);
      } else open += weight;
    }
  }
  // A name that promises no censorship counts as one voice for openness.
  if (UNCENSORED_RE.test(String(entry?.name ?? entry?.id ?? ""))) open += 0.5;
  const score = refusing - open;
  return { refusing: Math.round(refusing * 10) / 10, open: Math.round(open * 10) / 10, refuses: score >= 1, example: score >= 1 ? example : null };
}
