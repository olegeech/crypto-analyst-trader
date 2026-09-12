import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import process from "node:process";
import { join } from "node:path";

import { parseDecimal, toDecimalString } from "./decimal.js";
import { hashProbePlan, type ProbePlan } from "./probe-plan.js";

export const DEFAULT_PROBE_DATA_ROOT = "data/private/bybit-probe";
export const UNRESOLVED_RUN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;

export const EXIT_CODES = {
  CONFIRMED_CLEAN: 0,
  REFUSED: 2,
  PRECONDITION_FAILED: 3,
  CONTRADICTION: 4,
  UNRESOLVED: 5,
} as const;

export type ProbeVerdict = keyof typeof EXIT_CODES;

export class ProbeStoreError extends Error {
  readonly code:
    | "live-lock"
    | "invalid-lock"
    | "blocking-prior-runs"
    | "invalid-record"
    | "not-owner";

  constructor(code: ProbeStoreError["code"], message: string) {
    super(message);
    this.name = "ProbeStoreError";
    this.code = code;
  }
}

export interface StoredPlan extends Omit<ProbePlan, "accountId"> {
  readonly accountIdHash: string;
}

export interface StoredIntentInput {
  readonly runId: string;
  readonly attemptId: string;
  readonly scenario: string;
  readonly plan: ProbePlan;
  readonly planDigest: string;
  readonly approvedAt: number;
  readonly approvalExpiresAt: number;
  readonly createdAt: number;
  readonly orderLinkId: string | undefined;
  readonly exchangeOrderId: string | undefined;
  readonly baselineSignedQty: string | undefined;
}

export interface StoredIntent extends Omit<StoredIntentInput, "plan"> {
  readonly recordVersion: 1;
  readonly plan: StoredPlan;
  readonly path: string;
}

export interface StoredRun {
  readonly runId: string;
  readonly intents: readonly StoredIntent[];
  readonly verdict: ProbeVerdict | undefined;
  readonly createdAt: number | undefined;
  readonly path: string;
}

export interface RecoveryHandoff {
  readonly runId: string;
  readonly lastConfirmedState: string;
  readonly uncertainty: string;
  readonly nextAction: string;
}

export interface StoredVerdict {
  readonly recordVersion: 1;
  readonly runId: string;
  readonly verdict: ProbeVerdict;
  readonly exitCode: number;
  readonly recordedAt: number;
  readonly recoveryHandoff?: RecoveryHandoff & {
    readonly reference: "SECURITY.md";
  };
  readonly path: string;
}

export interface StoredFindings {
  readonly recordVersion: 1;
  readonly runId: string;
  readonly verdict: ProbeVerdict;
  readonly recordedAt: number;
  readonly content: string;
  readonly path: string;
}

interface LockRecord {
  readonly pid: number;
  readonly runId: string;
  readonly startedAt: number;
}

function safeId(value: string, field: string): string {
  if (!/^(?=.*[^.])[A-Za-z0-9._-]{1,128}$/.test(value)) {
    throw new ProbeStoreError("invalid-record", `${field} is invalid`);
  }
  return value;
}

function safeText(value: string, field: string): string {
  if (!value || /[\u0000-\u001f\u007f\r\n]/.test(value)) {
    throw new ProbeStoreError("invalid-record", `${field} is invalid`);
  }
  return value;
}

const STORED_PLAN_FIELDS = new Set([
  "schemaVersion",
  "environment",
  "scenario",
  "expiresAt",
  "method",
  "endpoint",
  "params",
  "accountIdHash",
]);

const STORED_PARAM_FIELDS = new Set([
  "category",
  "symbol",
  "side",
  "orderLinkId",
  "orderId",
  "price",
  "qty",
  "takeProfit",
  "stopLoss",
  "orderType",
  "timeInForce",
  "reduceOnly",
  "positionIdx",
  "tpslMode",
  "tpOrderType",
  "slOrderType",
  "tpTriggerBy",
  "slTriggerBy",
  "closeOnTrigger",
]);

const STORED_DECIMAL_FIELDS = new Set([
  "price",
  "qty",
  "takeProfit",
  "stopLoss",
]);

function recordObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProbeStoreError("invalid-record", `${field} is invalid`);
  }
  return value as Record<string, unknown>;
}

function storedString(
  record: Record<string, unknown>,
  field: string,
  required = false,
): string | undefined {
  const value = record[field];
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string") {
    throw new ProbeStoreError("invalid-record", `${field} is invalid`);
  }
  return safeText(value, field);
}

function storedTimestamp(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new ProbeStoreError("invalid-record", `${field} is invalid`);
  }
  return value as number;
}

function validateStoredPlan(value: unknown): StoredPlan {
  const plan = recordObject(value, "plan");
  if (
    Object.keys(plan).some((field) => !STORED_PLAN_FIELDS.has(field)) ||
    plan.schemaVersion !== 1 ||
    plan.environment !== "testnet"
  ) {
    throw new ProbeStoreError("invalid-record", "the stored plan is invalid");
  }
  const accountIdHash = plan.accountIdHash;
  if (
    typeof accountIdHash !== "string" ||
    !/^[a-f0-9]{12}$/.test(accountIdHash)
  ) {
    throw new ProbeStoreError(
      "invalid-record",
      "the stored account identity is invalid",
    );
  }
  const scenario = storedString(plan, "scenario", true);
  const endpoint = storedString(plan, "endpoint", true);
  if (scenario === undefined || endpoint === undefined) {
    throw new ProbeStoreError("invalid-record", "the stored plan is invalid");
  }
  storedTimestamp(plan.expiresAt, "plan.expiresAt");
  if (plan.method !== "GET" && plan.method !== "POST") {
    throw new ProbeStoreError("invalid-record", "the stored method is invalid");
  }
  if (
    !endpoint.startsWith("/") ||
    endpoint.includes("//") ||
    endpoint.includes("#")
  ) {
    throw new ProbeStoreError(
      "invalid-record",
      "the stored endpoint is invalid",
    );
  }
  const params = recordObject(plan.params, "plan.params");
  if (Object.keys(params).some((field) => !STORED_PARAM_FIELDS.has(field))) {
    throw new ProbeStoreError(
      "invalid-record",
      "the stored order parameters are invalid",
    );
  }
  storedString(params, "category", true);
  storedString(params, "symbol", true);
  const side = params.side;
  if (side !== "Buy" && side !== "Sell") {
    throw new ProbeStoreError("invalid-record", "the stored side is invalid");
  }
  for (const field of ["orderLinkId", "orderId"]) {
    storedString(params, field);
  }
  for (const field of STORED_DECIMAL_FIELDS) {
    const raw = params[field];
    if (raw === undefined) continue;
    if (typeof raw !== "string") {
      throw new ProbeStoreError("invalid-record", `${field} is invalid`);
    }
    try {
      if (toDecimalString(parseDecimal(raw)) !== raw) {
        throw new Error("non-canonical decimal");
      }
    } catch {
      throw new ProbeStoreError("invalid-record", `${field} is invalid`);
    }
  }
  const enumFields: Record<string, readonly string[]> = {
    orderType: ["Limit", "Market"],
    timeInForce: ["GTC", "IOC", "FOK", "PostOnly"],
    tpslMode: ["Full"],
    tpOrderType: ["Market", "Limit"],
    slOrderType: ["Market", "Limit"],
    tpTriggerBy: ["LastPrice", "MarkPrice", "IndexPrice"],
    slTriggerBy: ["LastPrice", "MarkPrice", "IndexPrice"],
  };
  for (const [field, allowed] of Object.entries(enumFields)) {
    const raw = params[field];
    if (
      raw !== undefined &&
      (typeof raw !== "string" || !allowed.includes(raw))
    ) {
      throw new ProbeStoreError("invalid-record", `${field} is invalid`);
    }
  }
  for (const field of ["reduceOnly", "closeOnTrigger"]) {
    const raw = params[field];
    if (raw !== undefined && typeof raw !== "boolean") {
      throw new ProbeStoreError("invalid-record", `${field} is invalid`);
    }
  }
  const positionIdx = params.positionIdx;
  if (
    positionIdx !== undefined &&
    (typeof positionIdx !== "number" ||
      !Number.isInteger(positionIdx) ||
      positionIdx < 0)
  ) {
    throw new ProbeStoreError("invalid-record", "positionIdx is invalid");
  }
  return plan as unknown as StoredPlan;
}

export function accountHash(accountId: string): string {
  return createHash("sha256")
    .update(safeText(accountId, "accountId"), "utf8")
    .digest("hex")
    .slice(0, 12);
}

function sanitizedPlan(plan: ProbePlan): StoredPlan {
  const { accountId, ...rest } = plan;
  return { ...rest, accountIdHash: accountHash(accountId) };
}

function ensureFiniteTimestamp(value: number, field: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ProbeStoreError("invalid-record", `${field} is invalid`);
  }
}

async function atomicJsonWrite(path: string, value: unknown): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, path);
}

function defaultIsProcessAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class ProbeStore {
  readonly rootDir: string;
  private readonly clock: () => number;
  private readonly processId: number;
  private readonly isProcessAlive: (pid: number) => boolean;

  constructor({
    rootDir = DEFAULT_PROBE_DATA_ROOT,
    clock = Date.now,
    processId = process.pid,
    isProcessAlive = defaultIsProcessAlive,
  }: {
    rootDir?: string;
    clock?: () => number;
    processId?: number;
    isProcessAlive?: (pid: number) => boolean;
  } = {}) {
    this.rootDir = rootDir;
    this.clock = clock;
    this.processId = processId;
    this.isProcessAlive = isProcessAlive;
  }

  private async ensureRoot(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    await chmod(this.rootDir, 0o700);
  }

  private runDir(runId: string): string {
    return join(this.rootDir, safeId(runId, "runId"));
  }

  private lockPath(): string {
    return join(this.rootDir, ".lock");
  }

  async acquireLock(runId: string): Promise<void> {
    safeId(runId, "runId");
    await this.ensureRoot();
    const record: LockRecord = {
      pid: this.processId,
      runId,
      startedAt: this.clock(),
    };
    try {
      const handle = await open(this.lockPath(), "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    let existing: LockRecord;
    try {
      existing = JSON.parse(
        await readFile(this.lockPath(), "utf8"),
      ) as LockRecord;
    } catch {
      throw new ProbeStoreError(
        "invalid-lock",
        "the probe lock is unreadable; inspect it manually",
      );
    }
    if (
      !Number.isInteger(existing.pid) ||
      typeof existing.runId !== "string" ||
      !Number.isInteger(existing.startedAt)
    ) {
      throw new ProbeStoreError(
        "invalid-lock",
        "the probe lock is invalid; inspect it manually",
      );
    }
    if (this.isProcessAlive(existing.pid)) {
      throw new ProbeStoreError("live-lock", "another probe run is active");
    }
    await unlink(this.lockPath());
    const handle = await open(this.lockPath(), "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async releaseLock(runId: string): Promise<void> {
    const path = this.lockPath();
    let existing: LockRecord;
    try {
      existing = JSON.parse(await readFile(path, "utf8")) as LockRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new ProbeStoreError(
        "invalid-lock",
        "the probe lock is unreadable; inspect it manually",
      );
    }
    if (existing.runId !== runId || existing.pid !== this.processId) {
      throw new ProbeStoreError(
        "not-owner",
        "the probe lock is owned by another run",
      );
    }
    await unlink(path);
  }

  async writeIntent(input: StoredIntentInput): Promise<StoredIntent> {
    safeId(input.runId, "runId");
    safeId(input.attemptId, "attemptId");
    safeText(input.scenario, "scenario");
    if (!/^[a-f0-9]{64}$/.test(input.planDigest)) {
      throw new ProbeStoreError("invalid-record", "planDigest is invalid");
    }
    if (input.planDigest !== hashProbePlan(input.plan)) {
      throw new ProbeStoreError(
        "invalid-record",
        "planDigest does not match the persisted probe plan",
      );
    }
    ensureFiniteTimestamp(input.approvedAt, "approvedAt");
    ensureFiniteTimestamp(input.approvalExpiresAt, "approvalExpiresAt");
    ensureFiniteTimestamp(input.createdAt, "createdAt");
    if (input.orderLinkId !== undefined)
      safeText(input.orderLinkId, "orderLinkId");
    if (input.exchangeOrderId !== undefined)
      safeText(input.exchangeOrderId, "exchangeOrderId");
    if (input.baselineSignedQty !== undefined)
      safeText(input.baselineSignedQty, "baselineSignedQty");
    const directory = this.runDir(input.runId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const path = join(
      directory,
      `intent-${safeId(input.attemptId, "attemptId")}.json`,
    );
    const stored: Omit<StoredIntent, "path"> = {
      recordVersion: 1,
      runId: input.runId,
      attemptId: input.attemptId,
      scenario: input.scenario,
      plan: sanitizedPlan(input.plan),
      planDigest: input.planDigest,
      approvedAt: input.approvedAt,
      approvalExpiresAt: input.approvalExpiresAt,
      createdAt: input.createdAt,
      orderLinkId: input.orderLinkId,
      exchangeOrderId: input.exchangeOrderId,
      baselineSignedQty: input.baselineSignedQty,
    };
    await atomicJsonWrite(path, stored);
    return { ...stored, path };
  }

  async updateIntent(
    runId: string,
    attemptId: string,
    patch: Partial<
      Pick<StoredIntentInput, "exchangeOrderId" | "baselineSignedQty">
    >,
  ): Promise<StoredIntent> {
    const existing = await this.readIntent(runId, attemptId);
    const stored: Omit<StoredIntent, "path"> = {
      recordVersion: 1,
      runId: existing.runId,
      attemptId: existing.attemptId,
      scenario: existing.scenario,
      plan: existing.plan,
      planDigest: existing.planDigest,
      approvedAt: existing.approvedAt,
      approvalExpiresAt: existing.approvalExpiresAt,
      createdAt: existing.createdAt,
      orderLinkId: existing.orderLinkId,
      exchangeOrderId: patch.exchangeOrderId ?? existing.exchangeOrderId,
      baselineSignedQty: patch.baselineSignedQty ?? existing.baselineSignedQty,
    };
    await atomicJsonWrite(existing.path, stored);
    return { ...stored, path: existing.path };
  }

  private async readIntent(
    runId: string,
    attemptId: string,
  ): Promise<StoredIntent> {
    const path = join(
      this.runDir(runId),
      `intent-${safeId(attemptId, "attemptId")}.json`,
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, "utf8"));
    } catch {
      throw new ProbeStoreError(
        "invalid-record",
        "the probe intent record is unavailable or invalid",
      );
    }
    return this.validateStoredIntent(parsed, path, runId, attemptId);
  }

  private validateStoredIntent(
    value: unknown,
    path: string,
    expectedRunId?: string,
    expectedAttemptId?: string,
  ): StoredIntent {
    const record = recordObject(value, "probe intent record");
    if (
      record.recordVersion !== 1 ||
      typeof record.runId !== "string" ||
      typeof record.attemptId !== "string" ||
      typeof record.scenario !== "string" ||
      typeof record.planDigest !== "string" ||
      typeof record.plan !== "object" ||
      record.plan === null ||
      typeof record.approvedAt !== "number" ||
      typeof record.approvalExpiresAt !== "number" ||
      typeof record.createdAt !== "number"
    ) {
      throw new ProbeStoreError(
        "invalid-record",
        "the probe intent record is invalid",
      );
    }
    const runId = safeId(record.runId, "runId");
    const attemptId = safeId(record.attemptId, "attemptId");
    if (
      (expectedRunId !== undefined && runId !== expectedRunId) ||
      (expectedAttemptId !== undefined && attemptId !== expectedAttemptId)
    ) {
      throw new ProbeStoreError(
        "invalid-record",
        "the probe intent identity does not match its path",
      );
    }
    const scenario = safeText(record.scenario, "scenario");
    const planDigest = safeText(record.planDigest, "planDigest");
    if (!/^[a-f0-9]{64}$/.test(planDigest)) {
      throw new ProbeStoreError("invalid-record", "planDigest is invalid");
    }
    const plan = validateStoredPlan(record.plan);
    if (plan.scenario !== scenario) {
      throw new ProbeStoreError(
        "invalid-record",
        "the intent scenario does not match its plan",
      );
    }
    const approvedAt = storedTimestamp(record.approvedAt, "approvedAt");
    const approvalExpiresAt = storedTimestamp(
      record.approvalExpiresAt,
      "approvalExpiresAt",
    );
    const createdAt = storedTimestamp(record.createdAt, "createdAt");
    if (approvalExpiresAt > plan.expiresAt || approvalExpiresAt <= approvedAt) {
      throw new ProbeStoreError(
        "invalid-record",
        "the persisted approval window is invalid",
      );
    }
    const orderLinkId = storedString(record, "orderLinkId");
    const exchangeOrderId = storedString(record, "exchangeOrderId");
    const baselineSignedQty = storedString(record, "baselineSignedQty");
    const planOrderLinkId = plan.params.orderLinkId;
    const planOrderId = plan.params.orderId;
    if (
      orderLinkId !== undefined &&
      planOrderLinkId !== undefined &&
      orderLinkId !== planOrderLinkId
    ) {
      throw new ProbeStoreError(
        "invalid-record",
        "the intent orderLinkId does not match its plan",
      );
    }
    if (
      exchangeOrderId !== undefined &&
      planOrderId !== undefined &&
      exchangeOrderId !== planOrderId
    ) {
      throw new ProbeStoreError(
        "invalid-record",
        "the intent exchangeOrderId does not match its plan",
      );
    }
    if (baselineSignedQty !== undefined) {
      try {
        if (
          toDecimalString(parseDecimal(baselineSignedQty)) !== baselineSignedQty
        ) {
          throw new Error("non-canonical decimal");
        }
      } catch {
        throw new ProbeStoreError(
          "invalid-record",
          "baselineSignedQty is invalid",
        );
      }
    }
    return {
      recordVersion: 1,
      runId,
      attemptId,
      scenario,
      plan,
      planDigest,
      approvedAt,
      approvalExpiresAt,
      createdAt,
      orderLinkId,
      exchangeOrderId,
      baselineSignedQty,
      path,
    };
  }

  async listSavedRuns(): Promise<readonly StoredRun[]> {
    let entries;
    try {
      entries = await readdir(this.rootDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const runs: StoredRun[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === ".") continue;
      const runId = safeId(entry.name, "runId");
      const directory = join(this.rootDir, runId);
      const files = await readdir(directory, { withFileTypes: true });
      const intents: StoredIntent[] = [];
      for (const file of files) {
        if (!file.isFile() || !/^intent-[A-Za-z0-9._-]+\.json$/.test(file.name))
          continue;
        const path = join(directory, file.name);
        let parsed: unknown;
        try {
          parsed = JSON.parse(await readFile(path, "utf8"));
        } catch {
          throw new ProbeStoreError(
            "invalid-record",
            `saved probe run ${runId} contains invalid JSON`,
          );
        }
        const attemptId = file.name.slice("intent-".length, -".json".length);
        intents.push(this.validateStoredIntent(parsed, path, runId, attemptId));
      }
      intents.sort((left, right) => left.createdAt - right.createdAt);
      let verdict: ProbeVerdict | undefined;
      const verdictPath = join(directory, "verdict.json");
      try {
        const parsed = JSON.parse(
          await readFile(verdictPath, "utf8"),
        ) as Record<string, unknown>;
        if (
          typeof parsed.verdict !== "string" ||
          !(parsed.verdict in EXIT_CODES)
        ) {
          throw new Error("invalid verdict");
        }
        verdict = parsed.verdict as ProbeVerdict;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw new ProbeStoreError(
            "invalid-record",
            `saved probe run ${runId} contains an invalid verdict`,
          );
        }
      }
      runs.push({
        runId,
        intents,
        verdict,
        createdAt: intents[0]?.createdAt,
        path: directory,
      });
    }
    return runs.sort(
      (left, right) => (left.createdAt ?? 0) - (right.createdAt ?? 0),
    );
  }

  async assertNoBlockingPriorRuns(
    currentRunId: string,
    savedRuns?: readonly StoredRun[],
  ): Promise<void> {
    const prior = (savedRuns ?? (await this.listSavedRuns())).filter(
      (run) =>
        run.runId !== currentRunId &&
        run.verdict !== "CONFIRMED_CLEAN" &&
        run.verdict !== "REFUSED" &&
        (run.verdict !== "PRECONDITION_FAILED" || run.intents.length > 0),
    );
    if (prior.length > 1) {
      throw new ProbeStoreError(
        "blocking-prior-runs",
        "multiple unresolved prior probe runs require manual recovery",
      );
    }
    const oldest = prior[0]?.createdAt;
    if (
      oldest !== undefined &&
      this.clock() - oldest > UNRESOLVED_RUN_MAX_AGE_MS
    ) {
      throw new ProbeStoreError(
        "blocking-prior-runs",
        "an unresolved probe run is older than seven days and requires manual recovery",
      );
    }
  }

  async writeVerdict(
    runId: string,
    verdict: ProbeVerdict,
    handoff?: RecoveryHandoff,
  ): Promise<StoredVerdict> {
    safeId(runId, "runId");
    if (!(verdict in EXIT_CODES))
      throw new ProbeStoreError("invalid-record", "verdict is invalid");
    const directory = this.runDir(runId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const path = join(directory, "verdict.json");
    const record = {
      recordVersion: 1 as const,
      runId,
      verdict,
      exitCode: EXIT_CODES[verdict],
      recordedAt: this.clock(),
      ...(handoff === undefined
        ? {}
        : {
            recoveryHandoff: {
              runId: safeId(handoff.runId, "handoff.runId"),
              lastConfirmedState: safeText(
                handoff.lastConfirmedState,
                "lastConfirmedState",
              ),
              uncertainty: safeText(handoff.uncertainty, "uncertainty"),
              nextAction: safeText(handoff.nextAction, "nextAction"),
              reference: "SECURITY.md" as const,
            },
          }),
    };
    await atomicJsonWrite(path, record);
    return { ...record, path };
  }

  async writeFindings(
    runId: string,
    verdict: ProbeVerdict,
    content: string,
  ): Promise<StoredFindings> {
    safeId(runId, "runId");
    if (!(verdict in EXIT_CODES))
      throw new ProbeStoreError("invalid-record", "verdict is invalid");
    if (
      typeof content !== "string" ||
      !content ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(content)
    ) {
      throw new ProbeStoreError(
        "invalid-record",
        "findings content is invalid",
      );
    }
    const directory = this.runDir(runId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const path = join(directory, "findings.json");
    const record = {
      recordVersion: 1 as const,
      runId,
      verdict,
      recordedAt: this.clock(),
      content,
    };
    await atomicJsonWrite(path, record);
    return { ...record, path };
  }

  verdictLine(verdict: ProbeVerdict, message: string): string {
    return `${verdict} (${EXIT_CODES[verdict]}): ${message}`;
  }

  async removeRunForTestOnly(runId: string): Promise<void> {
    // Not used by the CLI. Kept private-data cleanup explicit for deterministic tests.
    await rm(this.runDir(runId), { recursive: true, force: false });
  }
}
