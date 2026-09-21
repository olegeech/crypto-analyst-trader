import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type {
  ExchangeExecutionFailure,
  ExchangeOrderObservation,
} from "../../src/ports/exchange-execution.js";

export const DEMO_EVIDENCE_SCHEMA_VERSION = "bybit-demo-adapter/v1";

export type DemoVerificationVerdict =
  "CONFIRMED_CLEAN" | "UNRESOLVED" | "BLOCKED";

export interface DemoStageEvidence {
  readonly name: string;
  readonly status: "passed" | "blocked" | "unresolved" | "skipped";
  readonly clientOrderId?: string;
  readonly exchangeOrderId?: string;
  readonly acknowledgement?: string;
  readonly terminalState?: string;
  readonly filledQuantity?: string;
  readonly fillCount?: number;
  readonly cleanup?: string;
  readonly message?: string;
}

export interface DemoVerificationEvidence {
  readonly schemaVersion: typeof DEMO_EVIDENCE_SCHEMA_VERSION;
  readonly environment: "demo";
  readonly verdict: DemoVerificationVerdict;
  readonly runId: string;
  readonly accountHash: string;
  readonly symbol: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly stages: readonly DemoStageEvidence[];
  readonly failure?: ExchangeExecutionFailure;
}

export function accountHash(accountId: string): string {
  return createHash("sha256")
    .update(accountId, "utf8")
    .digest("hex")
    .slice(0, 12);
}

export function shortExchangeOrderId(
  orderId: string | undefined,
): string | undefined {
  if (orderId === undefined) return undefined;
  if (orderId.length <= 8) return `${orderId.slice(0, 2)}…${orderId.slice(-2)}`;
  return `${orderId.slice(0, 4)}…${orderId.slice(-4)}`;
}

function safeText(value: string | undefined): string | undefined {
  if (value === undefined || /[\u0000-\u001f\u007f\r\n]/u.test(value)) {
    return undefined;
  }
  return value;
}

function sanitizeFailure(
  failure: ExchangeExecutionFailure | undefined,
): ExchangeExecutionFailure | undefined {
  if (failure === undefined) return undefined;
  const exchangeOrderId = shortExchangeOrderId(failure.exchangeOrderId);
  return {
    kind: failure.kind,
    message: safeText(failure.message) ?? "normalized Demo failure",
    retry: failure.retry,
    ...(failure.operation === undefined
      ? {}
      : { operation: failure.operation }),
    ...(failure.exchangeCode === undefined
      ? {}
      : { exchangeCode: failure.exchangeCode }),
    ...(failure.httpStatus === undefined
      ? {}
      : { httpStatus: failure.httpStatus }),
    ...(failure.clientOrderId === undefined
      ? {}
      : { clientOrderId: safeText(failure.clientOrderId) ?? "unverified" }),
    ...(exchangeOrderId === undefined ? {} : { exchangeOrderId }),
  };
}

export function stageFromObservation(
  name: string,
  observation: ExchangeOrderObservation,
  values: Pick<
    DemoStageEvidence,
    "clientOrderId" | "cleanup" | "fillCount"
  > = {},
): DemoStageEvidence {
  const exchangeOrderId = shortExchangeOrderId(observation.exchangeOrderId);
  return {
    name,
    status: "passed",
    clientOrderId: values.clientOrderId ?? observation.clientOrderId,
    ...(exchangeOrderId === undefined ? {} : { exchangeOrderId }),
    terminalState: observation.status,
    filledQuantity: observation.filledQuantity.toString(),
    ...(values.cleanup === undefined ? {} : { cleanup: values.cleanup }),
    ...(values.fillCount === undefined ? {} : { fillCount: values.fillCount }),
  };
}

export function sanitizeEvidence(
  evidence: DemoVerificationEvidence,
): DemoVerificationEvidence {
  const failure = sanitizeFailure(evidence.failure);
  return Object.freeze({
    ...evidence,
    accountHash: safeText(evidence.accountHash) ?? "unverified",
    ...(failure === undefined ? {} : { failure }),
    stages: Object.freeze(
      evidence.stages.map((stage) => {
        const exchangeOrderId = shortExchangeOrderId(stage.exchangeOrderId);
        const message = safeText(stage.message);
        return Object.freeze({
          ...stage,
          ...(exchangeOrderId === undefined ? {} : { exchangeOrderId }),
          ...(message === undefined ? {} : { message }),
        });
      }),
    ),
  });
}

export async function writeEvidence(
  directory: string,
  evidence: DemoVerificationEvidence,
): Promise<string> {
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(evidence.runId)) {
    throw new TypeError("runId must contain only safe filename characters.");
  }
  const path = join(directory, `${evidence.runId}.json`);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return path;
}

export async function writeSanitizedEvidence(
  directory: string,
  evidence: DemoVerificationEvidence,
): Promise<string> {
  return writeEvidence(directory, sanitizeEvidence(evidence));
}
