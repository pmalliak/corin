/**
 * Keeps the voice host alive through the network faults it will certainly meet.
 *
 * This is not defensive programming for its own sake. `@discordjs/ws` attaches
 * an error handler to its socket only when it runs shards in worker threads; in
 * the single process mode used here, a reset connection reaches Node as an
 * unhandled `error` event and kills the process. It happened on the first idle
 * night: logged in, nobody in a channel, dead from `ECONNRESET`.
 *
 * A gateway that drops is normal and the library reconnects on its own, so the
 * right response to a transient network fault is a log line, not a funeral. Any
 * other exception is a real defect, and the process exits so that it restarts
 * clean rather than continuing in an unknown state.
 */

const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "EPIPE",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "ERR_STREAM_PREMATURE_CLOSE",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
]);

export function isTransientNetworkFault(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  if (code && TRANSIENT_CODES.has(code)) return true;
  // Undici wraps the real cause, which is where the code actually lives.
  const cause = (error as { cause?: unknown }).cause;
  return cause !== undefined && cause !== error && isTransientNetworkFault(cause);
}

export type FaultHandler = (label: string, error: unknown) => void;

/**
 * Separated from the wiring below so it can be tested directly. Emitting a fake
 * `uncaughtException` on the real process only fights the test runner, which
 * listens for exactly that.
 */
export function createFaultHandler(exit: (code: number) => void): FaultHandler {
  return (label, error) => {
    if (isTransientNetworkFault(error)) {
      const code = (error as NodeJS.ErrnoException).code ?? "network";
      console.warn(`[net] ${label}: ${code}, carrying on`);
      return;
    }
    console.error(`[fatal] ${label}:`, error);
    exit(1);
  };
}

export function installCrashGuard(exit: (code: number) => void = (code) => process.exit(code)): void {
  const handle = createFaultHandler(exit);
  process.on("uncaughtException", (error) => handle("uncaught exception", error));
  process.on("unhandledRejection", (reason) => handle("unhandled rejection", reason));
}
