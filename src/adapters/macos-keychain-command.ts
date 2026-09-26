import { spawn } from "node:child_process";
import process from "node:process";

const SECURITY_COMMAND = "/usr/bin/security";
const SECURITY_COMMAND_TIMEOUT_MS = 30_000;

type SecurityCommandFailure = "timeout";

export interface SecurityCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  failure?: SecurityCommandFailure;
}

export type SecurityRunner = (
  args: string[],
  input?: string,
) => Promise<SecurityCommandResult>;

const PARENT_TERMINATION_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

type ParentProcess = Pick<NodeJS.Process, "pid" | "kill" | "once" | "off">;

interface SecurityRunOptions {
  timeoutMs?: number;
  spawnProcess?: typeof spawn;
  parentProcess?: ParentProcess;
}

export class SecurityCommandTimeoutError extends Error {
  constructor() {
    super("security command timed out");
    this.name = "SecurityCommandTimeoutError";
  }
}

export function runSecurity(
  args: string[],
  input?: string,
  {
    timeoutMs = SECURITY_COMMAND_TIMEOUT_MS,
    spawnProcess = spawn,
    parentProcess = process,
  }: SecurityRunOptions = {},
): Promise<SecurityCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(SECURITY_COMMAND, args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      // security reads prompted values through getpass(), which prefers the
      // controlling terminal over piped stdin. A new session has no
      // controlling terminal, so the piped value is always used.
      detached: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const effectiveTimeoutMs =
      Number.isFinite(timeoutMs) && timeoutMs > 0
        ? timeoutMs
        : SECURITY_COMMAND_TIMEOUT_MS;

    const killChild = (): void => {
      try {
        child.kill("SIGKILL");
      } catch {
        // The process may have exited before the kill attempt.
      }
    };
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      parentProcess.off("exit", killChild);
      for (const signal of PARENT_TERMINATION_SIGNALS) {
        parentProcess.off(signal, onParentSignal);
      }
      callback();
    };
    const onParentSignal = (signal: NodeJS.Signals): void => {
      killChild();
      finish(() => reject(new Error("security command was interrupted")));
      parentProcess.kill(parentProcess.pid, signal);
    };
    const timeout = setTimeout(() => {
      killChild();
      finish(() => reject(new SecurityCommandTimeoutError()));
    }, effectiveTimeoutMs);
    parentProcess.once("exit", killChild);
    for (const signal of PARENT_TERMINATION_SIGNALS) {
      parentProcess.once(signal, onParentSignal);
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", () =>
      finish(() => reject(new Error("security command could not be started"))),
    );
    child.once("close", (exitCode) => {
      finish(() => resolve({ stdout, stderr, exitCode: exitCode ?? 1 }));
    });

    if (input !== undefined) {
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }
  });
}
