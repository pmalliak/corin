import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AlreadyRunning, claimSingleInstance, processIsAlive, readLock } from "./lock.ts";

function lockPath(): string {
  return join(mkdtempSync(join(tmpdir(), "corin-lock-")), "voice.lock");
}

test("a free lock is claimed and records this process", () => {
  const path = lockPath();
  const release = claimSingleInstance(path);
  assert.equal(readFileSync(path, "utf8"), String(process.pid));
  release();
  assert.equal(existsSync(path), false);
});

test("a lock held by a live process is refused", () => {
  const path = lockPath();
  writeFileSync(path, "4242");
  assert.throws(() => claimSingleInstance(path, () => true), AlreadyRunning);
});

test("a lock left behind by a dead process is taken over", () => {
  const path = lockPath();
  writeFileSync(path, "4242");
  const release = claimSingleInstance(path, () => false);
  assert.equal(readLock(path), process.pid);
  release();
});

test("garbage in the lock file does not stop a start", () => {
  const path = lockPath();
  writeFileSync(path, "not a pid");
  assert.equal(readLock(path), undefined);
  claimSingleInstance(path, () => true)();
});

test("releasing twice is harmless, and never removes a successor's claim", () => {
  const path = lockPath();
  const release = claimSingleInstance(path);
  release();
  writeFileSync(path, "9999"); // somebody else took over
  release();
  assert.equal(readLock(path), 9999);
});

test("this very process counts as alive, and an absurd id does not", () => {
  assert.ok(processIsAlive(process.pid));
  assert.equal(processIsAlive(2_147_483_646), false);
});
