import type { AccountEvidenceEnvironment } from "../domain/account/account-evidence-bundle.js";
import { createProvisionalM1Composition } from "../application/policies/provisional-m1.js";
import type { DailyPrepareResult } from "../application/daily-prepare.js";
import type { PreparedDailyPlan } from "../domain/review/prepared-daily-plan.js";
import { summarizePreparedShadowContext } from "../domain/review/prepared-shadow-context.js";
import type { ShadowMarketReport } from "../domain/review/shadow-market-report.js";
import { createPreparedPlanApproval } from "../domain/review/prepared-plan-approval.js";
import { requireHash } from "../domain/shared/validation.js";
import { domainError } from "../domain/shared/errors.js";
import { fail, ok, type Result } from "../domain/shared/result.js";
import type { Clock } from "../domain/shared/time.js";
import type { PreparedArtifactStore } from "../ports/prepared-artifact-store.js";
import type { ShadowReportStore } from "../ports/shadow-report-store.js";

type DailyCommand =
  | {
      kind: "prepare";
      environment: AccountEvidenceEnvironment;
      symbol: string;
      allocation: string;
    }
  | {
      kind: "review" | "approve";
      environment: AccountEvidenceEnvironment;
      preparedHash: string;
      note?: string;
    }
  | {
      kind: "shadow-review";
      environment: AccountEvidenceEnvironment;
      shadowHash: string;
    };

export function parseDailyArguments(
  args: readonly string[],
): Result<DailyCommand> {
  const kind = args[0];
  const invalid = () =>
    fail(domainError("INVALID_VALUE", "Invalid daily command"));
  if (kind !== "prepare" && kind !== "review" && kind !== "approve")
    return invalid();
  const allowed =
    kind === "prepare"
      ? ["--environment", "--symbol", "--allocation"]
      : kind === "review"
        ? ["--environment", "--prepared-hash", "--shadow-hash"]
        : ["--environment", "--prepared-hash", "--note"];
  const values = new Map<string, string>();
  for (let i = 1; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (
      !flag ||
      !allowed.includes(flag) ||
      values.has(flag) ||
      !value ||
      value.startsWith("--") ||
      value.length > 2000 ||
      /[\u0000-\u001f\u007f]/u.test(value)
    )
      return invalid();
    values.set(flag, value);
  }
  const env = values.get("--environment");
  if (env !== "demo" && env !== "testnet" && env !== "mainnet")
    return invalid();
  if (kind === "prepare") {
    const symbol = values.get("--symbol");
    const allocation = values.get("--allocation");
    if (
      !symbol ||
      !allocation ||
      !createProvisionalM1Composition({ symbol, allocation }).ok
    )
      return invalid();
    return ok({ kind, environment: env, symbol, allocation });
  }
  const shadowHash = values.get("--shadow-hash");
  if (kind === "review" && shadowHash !== undefined) {
    if (values.has("--prepared-hash")) return invalid();
    const parsedShadowHash = requireHash(shadowHash, "shadowHash");
    if (!parsedShadowHash.ok) return invalid();
    return ok({
      kind: "shadow-review",
      environment: env,
      shadowHash: parsedShadowHash.value,
    });
  }
  const hash = requireHash(values.get("--prepared-hash"), "preparedHash");
  if (!hash.ok) return invalid();
  const note = values.get("--note");
  return ok({
    kind,
    environment: env,
    preparedHash: hash.value,
    ...(note === undefined ? {} : { note }),
  });
}

/** Only the domain's redacted material summary, never its private replay inputs. */
export function renderPreparedReview(p: PreparedDailyPlan): string {
  const action = p.summary.action;
  const proposal = (() => {
    if (p.state === "BLOCKED") return "No action: prepared plan is BLOCKED";
    switch (action.kind) {
      case "blocked-no-action":
        return "No action: prepared plan is BLOCKED";
      case "add-long-proposal":
        return `ADD proposal: ${p.summary.grid.length} Limit/GTC entries, attached TP, no SL`;
      case "hold-no-action":
        return "HOLD: no action proposed";
      case "close-long-quantity":
        return "REDUCE proposal: quantity-only, decision-only";
      case "reduction-no-op":
        return `REDUCE: ${action.reasonCode}; no action`;
    }
  })();
  return [
    `State: ${p.state} | reasons: ${p.reasonCodes.join(",") || "none"}`,
    `Environment: ${p.inputIdentity.environment} | account binding: ${p.inputIdentity.accountIdentityHash}`,
    "Public market origin: https://api.bybit.com (unsigned mainnet)",
    `PREPARED_HASH: ${p.contentHash}`,
    `Historical preflight evaluated at: ${p.inputIdentity.evaluationTime}`,
    `Approval TTL: ${p.summary.policies.approvalTtlMs} ms from explicit consent; historical approval does not refresh evidence`,
    ...(p.summary.shadowIntelligence === undefined
      ? []
      : [
          "Shadow intelligence is a saved historical snapshot; review does not refresh it or claim that it is current.",
        ]),
    proposal,
    JSON.stringify(p.summary, null, 2),
    "Execution authority: none. No exchange writes. No default report file.",
  ].join("\n");
}

function renderMarketIntelligenceStatus(
  shadow: DailyPrepareResult["diagnostics"]["shadowIntelligence"],
  reportHash?: string,
): string {
  const qualityStatus =
    shadow && "qualityAssessment" in shadow
      ? shadow.qualityAssessment.status
      : undefined;
  const familyStatuses =
    shadow && "families" in shadow
      ? shadow.families.map((family) => family.status)
      : [];
  const modelFamilyStatus =
    familyStatuses.length === 0 ||
    familyStatuses.every((status) => status === "unavailable")
      ? "unavailable"
      : "partial";
  const reasonCodes = [
    ...(shadow?.reasonCodes ?? []),
    ...(shadow && "families" in shadow
      ? shadow.families.flatMap((family) => family.reasonCodes)
      : []),
    ...(shadow && "qualityAssessment" in shadow
      ? shadow.qualityAssessment.findings.map((finding) => finding.reasonCode)
      : []),
    ...(!shadow ||
    (shadow.status !== "recorded" && shadow.reasonCodes.length === 0)
      ? ["SHADOW_SOURCES_UNAVAILABLE"]
      : []),
    ...(reportHash === undefined ? ["SHADOW_REPORT_NOT_PERSISTED"] : []),
  ];
  const normalizedReasons = [...new Set(reasonCodes)].sort();
  const hasQualityFindings =
    shadow !== undefined &&
    "qualityAssessment" in shadow &&
    shadow.qualityAssessment.findings.length > 0;
  const status =
    !shadow ||
    shadow.status !== "recorded" ||
    qualityStatus === "rejected" ||
    modelFamilyStatus === "unavailable"
      ? "unavailable"
      : reportHash === undefined ||
          qualityStatus !== "accepted" ||
          hasQualityFindings ||
          modelFamilyStatus === "partial"
        ? "partial"
        : "recorded";
  return `Market Intelligence: ${status} | model families: ${modelFamilyStatus} | reason codes: ${normalizedReasons.join(",") || "none"} | hash: ${reportHash ?? "unavailable"}`;
}

function renderTradingReadinessStatus(result: DailyPrepareResult): string {
  const state =
    result.kind === "prepared"
      ? result.prepared.state
      : result.kind === "blocked"
        ? "BLOCKED"
        : "UNAVAILABLE";
  const reasonCodes =
    result.kind === "prepared"
      ? result.prepared.reasonCodes
      : result.reasonCodes;
  return `Trading Readiness: ${state} | native reason codes: ${reasonCodes.join(",") || "none"}`;
}

export function renderShadowReview(report: ShadowMarketReport): string {
  const shadow = summarizePreparedShadowContext(report.context);
  const status = renderMarketIntelligenceStatus(shadow, report.contentHash);
  return [
    `SHADOW_REPORT_HASH: ${report.contentHash}`,
    status,
    "Trading Readiness: not evaluated by a shadow-only report.",
    `Schema: ${report.schemaVersion}`,
    `Environment: ${report.environment}`,
    `Run: ${report.runId}`,
    `Symbol: ${report.symbol}`,
    `Evaluation time: ${report.evaluationTime}`,
    "Public source-bound historical snapshot; review does not refresh it.",
    JSON.stringify(summarizePreparedShadowContext(report.context), null, 2),
    "Shadow-only report. Approval and execution authority: none. No exchange writes.",
  ].join("\n");
}

export interface DailyCommandDependencies {
  readonly prepare: (input: {
    environment: AccountEvidenceEnvironment;
    symbol: string;
    allocation: string;
  }) => Promise<DailyPrepareResult>;
  readonly openStore: (
    environment: AccountEvidenceEnvironment,
  ) => Result<PreparedArtifactStore>;
  readonly openShadowStore?: (
    environment: AccountEvidenceEnvironment,
  ) => Result<ShadowReportStore>;
  readonly actor: () => Result<string>;
  readonly clock: Clock;
  readonly interactive: boolean;
  readonly prompt: (label: string) => Promise<string>;
  readonly write: (text: string) => void;
}

export async function runDailyCommand(
  args: readonly string[],
  deps: DailyCommandDependencies,
): Promise<number> {
  const parsed = parseDailyArguments(args);
  const reason = (code: string, exit: number) => {
    deps.write(`Reason: ${code}`);
    return exit;
  };
  if (!parsed.ok) return reason("INVALID_INPUT", 2);
  const input = parsed.value;
  try {
    if (input.kind === "prepare") {
      const result = await deps.prepare({
        environment: input.environment,
        symbol: input.symbol,
        allocation: input.allocation,
      });
      const shadowIntelligence =
        result.diagnostics.shadowIntelligence ??
        (result.kind === "prepared"
          ? result.prepared.summary.shadowIntelligence
          : undefined);
      deps.write(
        [
          renderMarketIntelligenceStatus(
            shadowIntelligence,
            result.diagnostics.shadowReportHash,
          ),
          renderTradingReadinessStatus(result),
        ].join("\n"),
      );
      if (result.diagnostics.shadowReportHash !== undefined)
        deps.write(
          `SHADOW_REPORT_HASH: ${result.diagnostics.shadowReportHash}`,
        );
      deps.write(JSON.stringify(result.diagnostics));
      if (result.kind !== "prepared") {
        deps.write(
          JSON.stringify({
            stage: result.stage,
            reasons: result.reasonCodes,
            informational: result.informationalCodes,
            external: result.externalAvailability,
            executionAuthority: "none",
          }),
        );
        return result.kind === "blocked" ? 5 : 4;
      }
      deps.write(renderPreparedReview(result.prepared));
      return result.prepared.state === "BLOCKED" ? 5 : 0;
    }
    if (input.kind === "shadow-review") {
      const opened = deps.openShadowStore?.(input.environment);
      if (!opened?.ok)
        return reason("SHADOW_REPORT_PERSISTENCE_UNAVAILABLE", 4);
      try {
        const report = opened.value.loadShadowReport(input.shadowHash);
        if (!report.ok)
          return reason(
            report.error.code === "UNSUPPORTED_CONTRACT"
              ? "SHADOW_REPORT_UNSUPPORTED_CONTRACT"
              : "SHADOW_REPORT_INTEGRITY",
            5,
          );
        if (
          !report.value ||
          report.value.contentHash !== input.shadowHash ||
          report.value.environment !== input.environment
        )
          return reason("SHADOW_REPORT_NOT_FOUND", 4);
        deps.write(renderShadowReview(report.value));
        return 0;
      } finally {
        opened.value.close();
      }
    }
    const opened = deps.openStore(input.environment);
    if (!opened.ok) return reason("PERSISTENCE_UNAVAILABLE", 4);
    const store = opened.value;
    try {
      const loaded = store.loadPrepared(input.preparedHash);
      if (!loaded.ok)
        return reason(
          loaded.error.code === "UNSUPPORTED_CONTRACT"
            ? "PREPARED_UNSUPPORTED_CONTRACT"
            : "PREPARED_INTEGRITY",
          5,
        );
      const prepared = loaded.value;
      if (
        !prepared ||
        prepared.contentHash !== input.preparedHash ||
        prepared.inputIdentity.environment !== input.environment
      )
        return reason("PREPARED_NOT_FOUND", 4);
      deps.write(renderPreparedReview(prepared));
      if (input.kind === "review") return prepared.state === "BLOCKED" ? 5 : 0;
      if (prepared.state === "BLOCKED") return reason("PREPARED_BLOCKED", 5);
      if (!deps.interactive) return reason("INTERACTIVE_CONSENT_REQUIRED", 3);
      const actor = deps.actor();
      if (!actor.ok) return reason("OPERATOR_IDENTITY_UNAVAILABLE", 4);
      let note = input.note;
      if (prepared.noteRequired && !note?.trim()) {
        try {
          note = await deps.prompt("Review note (required)");
        } catch {
          return reason("DECLINED", 3);
        }
        if (!note.trim()) return reason("REVIEW_NOTE_REQUIRED", 5);
      }
      let answer: string;
      try {
        answer = await deps.prompt(
          `Approve exactly ${prepared.contentHash}? Type yes`,
        );
      } catch {
        return reason("DECLINED", 3);
      }
      if (answer.trim() !== "yes") return reason("DECLINED", 3);
      const approval = createPreparedPlanApproval({
        prepared,
        preparedHash: input.preparedHash,
        actor: actor.value,
        consent: true,
        approvedAt: deps.clock.now(),
        ...(note === undefined ? {} : { note }),
      });
      if (!approval.ok) return reason("INVALID_APPROVAL", 5);
      const saved = store.saveApproval(approval.value);
      if (!saved.ok) return reason("APPROVAL_PERSISTENCE_INTEGRITY", 5);
      deps.write(
        `APPROVAL_HASH: ${approval.value.contentHash}\nApproved at: ${approval.value.approvedAt}\nExpires at: ${approval.value.expiresAt}\nExecution authority: none. Historical consent only.`,
      );
      return 0;
    } finally {
      store.close();
    }
  } catch {
    return reason("INTERNAL_FAILURE", 1);
  }
}
