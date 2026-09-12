import { accountHash, type ProbeVerdict } from "./store.js";
import type { DispatchErrorEvidence } from "./scenarios.js";

export type AttachedExitFinding =
  "accepted" | "silent-drop" | "rejected-110057" | "unverified";

export interface SanitizedScenarioFinding {
  readonly name: string;
  readonly requestAccepted: boolean;
  readonly acknowledgement: "pending" | "rejected";
  readonly terminalState: string | undefined;
  readonly exchangeOrderId: string | undefined;
  readonly orderLinkId: string | undefined;
  readonly attachedExits: AttachedExitFinding;
  readonly protectionAfterFill: "observed" | "unverified";
  readonly duplicateOutcome?: "accepted" | "rejected" | "unverified";
  readonly dispatchError?: DispatchErrorEvidence;
}

export interface FindingsInput {
  readonly runId: string;
  readonly verdict: ProbeVerdict;
  readonly accountId: string;
  readonly scenarios: readonly SanitizedScenarioFinding[];
}

export function truncateExchangeOrderId(orderId: string | undefined): string {
  if (!orderId) return "unverified";
  if (orderId.length <= 8) return `${orderId.slice(0, 2)}…${orderId.slice(-2)}`;
  return `${orderId.slice(0, 4)}…${orderId.slice(-4)}`;
}

function display(value: string | undefined): string {
  return value && !/[\u0000-\u001f\u007f\r\n]/.test(value)
    ? value
    : "unverified";
}

function displayDispatchError(error: DispatchErrorEvidence): string {
  const kind = display(error.transportKind);
  const retCode = Number.isSafeInteger(error.retCode)
    ? `; retCode: ${error.retCode}`
    : "";
  return `${error.classification}; transport kind: ${kind}${retCode}`;
}

export function renderSanitizedFindings(input: FindingsInput): string {
  const lines = [
    "Bybit Testnet capability probe findings",
    `run: ${display(input.runId)}`,
    `verdict: ${input.verdict}`,
    `account: ${accountHash(input.accountId)}`,
  ];
  for (const scenario of input.scenarios) {
    lines.push(`scenario: ${display(scenario.name)}`);
    lines.push(
      `  request accepted: ${scenario.requestAccepted ? "yes" : "no"}`,
    );
    lines.push(`  acknowledgement: ${scenario.acknowledgement}`);
    lines.push(`  terminal REST state: ${display(scenario.terminalState)}`);
    lines.push(
      `  exchange order: ${truncateExchangeOrderId(scenario.exchangeOrderId)}`,
    );
    lines.push(`  orderLinkId: ${display(scenario.orderLinkId)}`);
    lines.push(`  attached exits: ${scenario.attachedExits}`);
    lines.push(`  protection after fill: ${scenario.protectionAfterFill}`);
    lines.push(
      `  duplicate client-order-ID outcome: ${scenario.duplicateOutcome ?? "unverified"}`,
    );
    if (scenario.dispatchError !== undefined) {
      lines.push(
        `  dispatch error: ${displayDispatchError(scenario.dispatchError)}`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

export function assertSanitizedOutput(
  output: string,
  secrets: readonly string[],
): void {
  for (const secret of secrets) {
    if (secret && output.includes(secret)) {
      throw new Error("sanitized findings contain a credential or signature");
    }
  }
}
