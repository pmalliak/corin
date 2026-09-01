/**
 * Counts what a session costs, so the question "is this expensive" has an
 * answer on screen rather than at the end of the month.
 *
 * The two halves are charged completely differently and it matters which is
 * which. Everything anyone says is transcribed, priced by the minute, and that
 * is the floor the coach costs just by sitting in the channel. Only what is
 * addressed to it reaches the realtime model, priced by the token, and that is
 * where the money actually goes.
 *
 * Rates are estimates and drift; the token counts are exact and come from
 * OpenAI itself. When a rate is wrong, the arithmetic below is still right.
 */

/** Dollars per million tokens, except the first, which is per minute of audio. */
export type Rates = {
  transcribePerMinute: number;
  audioIn: number;
  audioInCached: number;
  audioOut: number;
  textIn: number;
  textInCached: number;
  textOut: number;
};

/** gpt-4o-mini-transcribe and gpt-realtime-2.1, as published in August 2026. */
export const DEFAULT_RATES: Rates = {
  transcribePerMinute: 0.003,
  audioIn: 32,
  audioInCached: 0.4,
  audioOut: 64,
  textIn: 4,
  textInCached: 0.4,
  textOut: 16,
};

export type Usage = {
  input_tokens?: number;
  output_tokens?: number;
  input_token_details?: {
    audio_tokens?: number;
    text_tokens?: number;
    cached_tokens_details?: { audio_tokens?: number; text_tokens?: number };
  };
  output_token_details?: { audio_tokens?: number; text_tokens?: number };
};

export function costOfAnswer(usage: Usage, rates: Rates = DEFAULT_RATES): number {
  const input = usage.input_token_details ?? {};
  const cached = input.cached_tokens_details ?? {};
  const output = usage.output_token_details ?? {};

  // Cached tokens are billed at the cheap rate and are already counted inside
  // the totals, so they are subtracted before the full rate is applied.
  const cachedAudio = cached.audio_tokens ?? 0;
  const cachedText = cached.text_tokens ?? 0;
  const freshAudio = Math.max(0, (input.audio_tokens ?? 0) - cachedAudio);
  const freshText = Math.max(0, (input.text_tokens ?? 0) - cachedText);

  // Reasoning tokens are charged as text output, and appear only in the total.
  const audioOut = output.audio_tokens ?? 0;
  const textOut = Math.max(0, (usage.output_tokens ?? 0) - audioOut);

  return (
    (freshAudio * rates.audioIn +
      cachedAudio * rates.audioInCached +
      freshText * rates.textIn +
      cachedText * rates.textInCached +
      audioOut * rates.audioOut +
      textOut * rates.textOut) /
    1_000_000
  );
}

export function costOfListening(seconds: number, rates: Rates = DEFAULT_RATES): number {
  return (seconds / 60) * rates.transcribePerMinute;
}

export function createMeter(rates: Rates = DEFAULT_RATES) {
  let heardSeconds = 0;
  let heardCount = 0;
  let answers = 0;
  let answerCost = 0;

  return {
    heard(durationMs: number): void {
      heardSeconds += durationMs / 1000;
      heardCount += 1;
    },
    answered(usage: Usage): string {
      answers += 1;
      const cost = costOfAnswer(usage, rates);
      answerCost += cost;
      return (
        `${usage.input_tokens ?? 0} in, ${usage.output_tokens ?? 0} out, ${money(cost)}` +
        ` | session: ${answers} answer(s) ${money(answerCost)}, ` +
        `${heardCount} heard ${money(costOfListening(heardSeconds, rates))}, ` +
        `total ${money(answerCost + costOfListening(heardSeconds, rates))}`
      );
    },
  };
}

function money(dollars: number): string {
  return dollars < 0.01 ? `${(dollars * 100).toFixed(2)}c` : `$${dollars.toFixed(3)}`;
}
