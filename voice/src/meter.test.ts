import { strict as assert } from "node:assert";
import { test } from "node:test";
import { DEFAULT_RATES, costOfAnswer, costOfListening, createMeter } from "./meter.ts";

test("listening is priced by the minute of speech, not of wall clock", () => {
  assert.equal(costOfListening(60), 0.003);
  assert.equal(costOfListening(0), 0);
});

test("an answer is priced from the token counts OpenAI reports", () => {
  // 1M audio out alone would be $64, so a thousand of them is 6.4 cents.
  const cost = costOfAnswer({ output_tokens: 1000, output_token_details: { audio_tokens: 1000 } });
  assert.ok(Math.abs(cost - 0.064) < 1e-9);
});

test("reasoning and text output are charged even though only the total names them", () => {
  const cost = costOfAnswer({ output_tokens: 1000, output_token_details: { audio_tokens: 600 } });
  const expected = (600 * DEFAULT_RATES.audioOut + 400 * DEFAULT_RATES.textOut) / 1_000_000;
  assert.ok(Math.abs(cost - expected) < 1e-9);
});

test("cached input is not billed twice at the full rate", () => {
  const usage = {
    input_tokens: 1000,
    input_token_details: { audio_tokens: 1000, cached_tokens_details: { audio_tokens: 800 } },
  };
  const expected = (200 * DEFAULT_RATES.audioIn + 800 * DEFAULT_RATES.audioInCached) / 1_000_000;
  assert.ok(Math.abs(costOfAnswer(usage) - expected) < 1e-9);
});

test("a real session report names both halves of the bill", () => {
  const meter = createMeter();
  meter.heard(3_000);
  meter.heard(2_000);
  const line = meter.answered({ input_tokens: 500, output_tokens: 300, output_token_details: { audio_tokens: 200 } });
  assert.match(line, /500 in, 300 out/);
  assert.match(line, /1 answer\(s\)/);
  assert.match(line, /2 heard/);
  assert.match(line, /total/);
});

test("a missing usage report costs nothing rather than crashing", () => {
  assert.equal(costOfAnswer({}), 0);
});
