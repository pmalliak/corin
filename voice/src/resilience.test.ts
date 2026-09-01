import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createFaultHandler, isTransientNetworkFault } from "./resilience.ts";

function withCode(code: string): Error {
  return Object.assign(new Error(code), { code });
}

test("the fault that actually killed the host is survivable", () => {
  assert.ok(isTransientNetworkFault(withCode("ECONNRESET")));
});

test("the usual family of network faults is survivable", () => {
  for (const code of ["ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH"]) {
    assert.ok(isTransientNetworkFault(withCode(code)), code);
  }
});

test("a fault wrapped by fetch is found through its cause", () => {
  const wrapped = Object.assign(new Error("fetch failed"), { cause: withCode("ECONNRESET") });
  assert.ok(isTransientNetworkFault(wrapped));
});

test("a self referencing cause does not loop forever", () => {
  const looped: Error & { cause?: unknown } = new Error("odd");
  looped.cause = looped;
  assert.equal(isTransientNetworkFault(looped), false);
});

test("a programming mistake is not survivable", () => {
  assert.equal(isTransientNetworkFault(new TypeError("x is not a function")), false);
  assert.equal(isTransientNetworkFault(withCode("ENOENT")), false);
  assert.equal(isTransientNetworkFault("just a string"), false);
});

test("the handler exits on a real defect and stays up on a reset", () => {
  const exits: number[] = [];
  const handle = createFaultHandler((code) => exits.push(code));

  handle("uncaught exception", withCode("ECONNRESET"));
  assert.deepEqual(exits, [], "a reset must not end the process");

  handle("uncaught exception", new TypeError("boom"));
  assert.deepEqual(exits, [1], "a defect must end the process");
});
