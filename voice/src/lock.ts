/**
 * Refuses to start a second voice host beside a running one.
 *
 * Two processes on one bot token do not politely queue: they take turns
 * stealing the voice connection from each other, and the symptom is not an
 * error message but wrong behaviour. An abandoned echo instance held the
 * channel while a coach instance thought it was connected, so a question got
 * answered with the asker's own voice played back, which looks exactly like a
 * broken coach and is not one.
 *
 * The lock is a file holding a process id. A crash leaves it behind, so a stale
 * lock whose process is gone is taken over rather than treated as fatal.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

export class AlreadyRunning extends Error {}

/** True when a process with this id exists. Signal 0 tests without delivering. */
export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists and belongs to somebody else, which still counts.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function readLock(path: string): number | undefined {
  if (!existsSync(path)) return undefined;
  const pid = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

export function claimSingleInstance(
  path: string,
  isAlive: (pid: number) => boolean = processIsAlive,
): () => void {
  const holder = readLock(path);
  if (holder !== undefined && holder !== process.pid && isAlive(holder)) {
    throw new AlreadyRunning(
      `Another voice host is already running as process ${holder}. ` +
        `Stop it first, or delete ${path} if you are certain it is gone.`,
    );
  }

  writeFileSync(path, String(process.pid), "utf8");
  let released = false;
  return () => {
    if (released) return;
    released = true;
    // Only ever remove our own claim, never one a successor has taken.
    if (readLock(path) === process.pid) rmSync(path, { force: true });
  };
}
