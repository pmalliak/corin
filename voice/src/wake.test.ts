import { strict as assert } from "node:assert";
import { test } from "node:test";
import { defaultTranscribePrompt, isAddressed, isPromptEcho, loudness, normalise, withinOneEdit } from "./wake.ts";

const WORDS = ["corin", "κοριν", "coach", "κοουτς"].map(normalise);

test("the name is heard when it is spelled correctly, in either script", () => {
  assert.ok(isAddressed("Corin, how much CS do I have?", WORDS));
  assert.ok(isAddressed("Κόριν, τι κάνει το ulti της Kindred;", WORDS));
});

test("the name is heard when speech to text mishears one letter", () => {
  // Exactly what gpt-4o-mini-transcribe returned for a Greek speaker saying "Κόριν".
  assert.ok(isAddressed("Corim, τι κάνει το ulti της Kindred;", WORDS));
  assert.ok(isAddressed("Korin, what should I build?", WORDS));
  assert.ok(isAddressed("Coring, help", WORDS));
});

test("ordinary team talk is left alone, which is where the money is saved", () => {
  assert.ok(!isAddressed("Dude, go back to base. You're gonna die.", WORDS));
  assert.ok(!isAddressed("Μέση, πάμε δράκον τώρα, έχουμε flash.", WORDS));
  assert.ok(!isAddressed("i'm going to roam bot", WORDS));
});

test("a name inside another word does not wake the coach", () => {
  assert.ok(!isAddressed("scoring is what matters", WORDS));
  assert.ok(!isAddressed("the corinthian column", WORDS));
});

test("accents and case never decide the answer", () => {
  assert.ok(isAddressed("ΚΟΡΙΝ ΤΙ ΚΑΝΩ", WORDS));
  assert.ok(isAddressed("κορίν βοήθα", WORDS));
});

test("one edit means one edit", () => {
  assert.ok(withinOneEdit("corin", "corin"));
  assert.ok(withinOneEdit("corim", "corin")); // substitution
  assert.ok(withinOneEdit("corn", "corin")); // deletion
  assert.ok(withinOneEdit("coring", "corin")); // insertion
  assert.ok(!withinOneEdit("cousin", "corin")); // two edits
  assert.ok(!withinOneEdit("dragon", "corin"));
});

test("the transcriber is primed with the coach's own name", () => {
  const prompt = defaultTranscribePrompt(["corin", "κοριν"]);
  assert.ok(prompt.includes("corin"));
  assert.ok(prompt.includes("κοριν"));
  // Both languages named, so neither is forced on the other.
  assert.ok(prompt.includes("ελληνικά") && prompt.includes("αγγλικά"));
});

test("the vocabulary handed back as a transcript is not a question", () => {
  const prompt = defaultTranscribePrompt(["corin", "κοριν", "coach", "κοουτς"]);
  // Both of these came back from a real session and both made the coach speak.
  assert.ok(isPromptEcho(prompt, prompt));
  assert.ok(
    isPromptEcho(
      "Champion, lane, jungle, gank, ulti, cooldown, CS, KDA, gold, items, dragon, baron, inhibitor, ward.",
      prompt,
    ),
  );
});

test("a real question is never mistaken for the vocabulary", () => {
  const prompt = defaultTranscribePrompt(["corin", "κοριν", "coach", "κοουτς"]);
  assert.equal(isPromptEcho("Κόριν, τι κάνει το ulti της Kindred;", prompt), false);
  assert.equal(isPromptEcho("Corin, πόσο cooldown έχει το flash μου;", prompt), false);
  // Short shouts of the name live inside the prompt and must still get through.
  assert.equal(isPromptEcho("Κόριν!", prompt), false);
  assert.equal(isPromptEcho("Corin, βοήθα", prompt), false);
});

test("loudness separates speech from a silent room", () => {
  const silence = Buffer.alloc(4800);
  const speech = Buffer.alloc(4800);
  for (let i = 0; i < 2400; i++) speech.writeInt16LE(Math.round(6000 * Math.sin(i / 3)), i * 2);
  assert.equal(loudness(silence), 0);
  assert.ok(loudness(speech) > 0.1);
  assert.equal(loudness(Buffer.alloc(0)), 0);
});
