import { strict as assert } from "node:assert";
import { test } from "node:test";
import { isFollowUp } from "./coach.ts";

const NOW = 1_000_000;
const WINDOW = 20_000;
const MIN_WORDS = 3;
const QUESTION = "και τι cooldown έχει";

function check(last: { speaker: string; at: number } | undefined, speaker: string, text: string): boolean {
  return isFollowUp(last, speaker, text, NOW, WINDOW, MIN_WORDS);
}

test("the person just answered may follow up without the name", () => {
  assert.ok(check({ speaker: "Panos", at: NOW - 5_000 }, "Panos", QUESTION));
});

test("somebody else in the channel still has to say the name", () => {
  assert.equal(check({ speaker: "Panos", at: NOW - 5_000 }, "Nikos", QUESTION), false);
});

test("the window closes, so ordinary chatter never reaches the model", () => {
  assert.equal(check({ speaker: "Panos", at: NOW - 21_000 }, "Panos", QUESTION), false);
});

test("with no answer yet there is nothing to follow up", () => {
  assert.equal(check(undefined, "Panos", QUESTION), false);
});

test("thinking aloud is not a question", () => {
  // Both of these were answered in a real session and neither deserved a turn.
  assert.equal(check({ speaker: "Panos", at: NOW }, "Panos", "Λοιπόν,"), false);
  assert.equal(check({ speaker: "Panos", at: NOW }, "Panos", "Ναι."), false);
  assert.equal(check({ speaker: "Panos", at: NOW }, "Panos", ""), false);
});

test("a window of zero turns the whole behaviour off", () => {
  assert.equal(isFollowUp({ speaker: "Panos", at: NOW }, "Panos", QUESTION, NOW, 0, MIN_WORDS), false);
});
