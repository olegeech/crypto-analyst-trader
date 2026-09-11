import { createInterface } from "node:readline";
import process from "node:process";

export class PromptInterruptedError extends Error {
  readonly reason: "cancelled" | "timeout";

  constructor(reason: "cancelled" | "timeout") {
    super(
      reason === "timeout"
        ? "Interactive prompt timed out."
        : "Interactive prompt was cancelled.",
    );
    this.name = "PromptInterruptedError";
    this.reason = reason;
  }
}

export function promptVisible(
  label: string,
  nonInteractiveMessage = "Interactive prompt requires a terminal.",
  {
    timeoutMs,
    signal,
    input = process.stdin,
    output = process.stdout,
  }: {
    timeoutMs?: number;
    signal?: AbortSignal;
    input?: NodeJS.ReadableStream & { isTTY?: boolean };
    output?: NodeJS.WritableStream;
  } = {},
): Promise<string> {
  if (!input.isTTY) {
    throw new Error(nonInteractiveMessage);
  }
  const readline = createInterface({ input, output });
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      callback();
      readline.close();
    };
    const onAbort = (): void =>
      finish(() => reject(new PromptInterruptedError("cancelled")));
    // Ctrl-C and end of input cancel the prompt instead of leaving it pending.
    readline.once("SIGINT", () =>
      finish(() => reject(new PromptInterruptedError("cancelled"))),
    );
    readline.once("close", () =>
      finish(() => reject(new PromptInterruptedError("cancelled"))),
    );
    if (timeoutMs !== undefined) {
      timeout = setTimeout(
        () => finish(() => reject(new PromptInterruptedError("timeout"))),
        timeoutMs,
      );
    }
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    readline.question(`${label}: `, (answer) => finish(() => resolve(answer)));
  });
}
