import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const REPOSITORY = "olegeech/crypto-analyst-trader";

export const REVIEWER_TOOL_POLICY = {
  allowedTools: ["Read", "Glob", "Grep", "Bash", "WebFetch"],
  deniedCapabilities: [
    "Edit",
    "Write",
    "untracked file access",
    "mutating shell commands",
    "push/merge",
    "secret paths and environment values",
    "dangerously-skip-permissions",
  ],
} as const;

type ReviewerToolPolicy = {
  allowedTools: readonly string[];
  allowedShellCommands: readonly string[];
  deniedCapabilities: readonly string[];
};

const FINDING_SEVERITIES = [
  "BLOCKING",
  "MATERIAL",
  "NON_BLOCKING",
  "INFORMATIONAL",
] as const;
const MAX_REVIEWER_OUTPUT_BYTES = 1024 * 1024;
const REVIEWER_TIMEOUT_MS = 900_000;
const VERDICTS = ["PASS", "BLOCKED"] as const;

export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];
export type ReviewVerdict = (typeof VERDICTS)[number];
export type ReviewFailureCode =
  "REVIEW_INPUT_UNAVAILABLE" | "REVIEWER_UNAVAILABLE" | "REVIEW_INPUT_STALE";

export type ReviewTargetRequest =
  | { kind: "issue"; number: number }
  | { kind: "pr"; number: number; expectedHeadSha: string };

export type ReviewFinding = {
  severity: FindingSeverity;
  message: string;
};

export type NormalizedIssueTarget = {
  kind: "issue";
  number: number;
  url: string;
  title: string;
  body: string;
  labels: string[];
  milestone: string | null;
  state: string;
  reviewScopeDigest: string;
};

export type NormalizedPrTarget = {
  kind: "pr";
  number: number;
  url: string;
  title: string;
  body: string;
  state: string;
  labels: string[];
  milestone: string | null;
  baseRefName: string;
  headSha: string;
  patch: string;
  linkedIssues: NormalizedIssueTarget[];
  checks: Array<{
    name: string;
    status: string;
    conclusion: string | null;
  }>;
};

export type NormalizedTarget = NormalizedIssueTarget | NormalizedPrTarget;

export type ReviewEnvelope = {
  protocol: "issue-delivery-review/v1";
  target: NormalizedTarget;
  boundIdentity: {
    reviewScopeDigest: string | null;
    expectedHeadSha: string | null;
  };
  outputContract: {
    verdicts: readonly ["PASS", "BLOCKED"];
    findingSeverities: readonly [
      "BLOCKING",
      "MATERIAL",
      "NON_BLOCKING",
      "INFORMATIONAL",
    ];
  };
};

export type ReviewerInvocation = {
  argv: string[];
  stdin: string;
  policy: ReviewerToolPolicy;
};

export type ReviewerRunResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type ReviewTargetDependencies = {
  fetchTarget: (request: ReviewTargetRequest) => Promise<NormalizedTarget>;
  runReviewer: (invocation: ReviewerInvocation) => Promise<ReviewerRunResult>;
};

export type ReviewTargetSuccess = {
  kind: "success";
  verdict: ReviewVerdict;
  findings: ReviewFinding[];
  reviewScopeDigest: string | null;
  reviewedHeadSha: string | null;
  attemptConsumed: true;
};

export type ReviewTargetFailure = {
  kind: "failure";
  code: ReviewFailureCode;
  message: string;
  recovery: string;
  attemptConsumed: false;
};

export type ReviewTargetResult = ReviewTargetSuccess | ReviewTargetFailure;

type ParsedReviewerOutput = {
  verdict: ReviewVerdict;
  findings: ReviewFinding[];
};

export function reviewScopeDigest(title: string, body: string): string {
  const canonicalTitle = normalizeText(title);
  const canonicalBody = normalizeText(body);
  return createHash("sha256")
    .update(JSON.stringify([canonicalTitle, canonicalBody]))
    .digest("hex");
}

export function parseTargetArgs(argv: string[]): ReviewTargetRequest {
  if (argv[0] === "issue" && argv.length === 2) {
    const number = parseIssueNumber(argv[1]);
    return { kind: "issue", number };
  }

  if (argv[0] === "pr" && argv.length === 3) {
    const number = parseIssueNumber(argv[1]);
    const expectedHeadSha = argv[2];
    if (!expectedHeadSha || !/^[0-9a-f]{40}$/i.test(expectedHeadSha)) {
      throw new Error(
        "PR review requires a full 40-character hexadecimal head SHA.",
      );
    }
    return {
      kind: "pr",
      number,
      expectedHeadSha: expectedHeadSha.toLowerCase(),
    };
  }

  throw new Error(
    "Usage: npm run review:target -- issue <number> | pr <number> <expected-head-sha>",
  );
}

export async function reviewTarget(
  request: ReviewTargetRequest,
  dependencies: ReviewTargetDependencies,
): Promise<ReviewTargetResult> {
  let initialTarget: NormalizedTarget;
  try {
    initialTarget = await dependencies.fetchTarget(request);
    validateTarget(initialTarget, request);
  } catch (error) {
    return failure(
      "REVIEW_INPUT_UNAVAILABLE",
      `Could not bind the review target: ${errorMessage(error)}`,
      "Refresh GitHub access and target data, then start a new review.",
    );
  }

  if (
    request.kind === "pr" &&
    initialTarget.kind === "pr" &&
    initialTarget.headSha.toLowerCase() !== request.expectedHeadSha
  ) {
    return failure(
      "REVIEW_INPUT_UNAVAILABLE",
      "The PR head does not match the expected full SHA before review.",
      "Capture the current full PR head SHA and start a new exact-head review.",
    );
  }

  const envelope = JSON.stringify(
    buildReviewEnvelope(initialTarget, request),
    null,
    2,
  );
  let reviewerResult: ReviewerRunResult;
  try {
    reviewerResult = await dependencies.runReviewer({
      argv: reviewerArgv(request),
      stdin: envelope,
      policy: reviewerToolPolicy(request),
    });
  } catch (error) {
    return failure(
      "REVIEWER_UNAVAILABLE",
      `The independent reviewer could not execute: ${errorMessage(error)}`,
      "Verify the configured reviewer CLI and authentication, then retry the review.",
    );
  }

  if (reviewerResult.exitCode !== 0) {
    return failure(
      "REVIEWER_UNAVAILABLE",
      "The independent reviewer exited unsuccessfully.",
      "Inspect reviewer availability without consuming a quality-review attempt, then retry.",
    );
  }

  let parsedReview: ParsedReviewerOutput;
  try {
    parsedReview = parseReviewerOutput(reviewerResult.stdout);
  } catch (error) {
    return failure(
      "REVIEWER_UNAVAILABLE",
      `The reviewer returned malformed output: ${errorMessage(error)}`,
      "Fix the reviewer output contract or configuration, then retry the review.",
    );
  }

  let currentTarget: NormalizedTarget;
  try {
    currentTarget = await dependencies.fetchTarget(request);
    validateTarget(currentTarget, request);
  } catch (error) {
    return failure(
      "REVIEW_INPUT_UNAVAILABLE",
      `Could not re-fetch the review target: ${errorMessage(error)}`,
      "Refresh GitHub access and target data, then start a new review.",
    );
  }

  if (isStale(initialTarget, currentTarget)) {
    return failure(
      "REVIEW_INPUT_STALE",
      "The bound issue semantic scope or PR head changed during review.",
      "Discard this evidence, capture the new target, and start a fresh review.",
    );
  }

  return {
    kind: "success",
    verdict: parsedReview.verdict,
    findings: parsedReview.findings,
    reviewScopeDigest:
      initialTarget.kind === "issue" ? initialTarget.reviewScopeDigest : null,
    reviewedHeadSha: initialTarget.kind === "pr" ? initialTarget.headSha : null,
    attemptConsumed: true,
  };
}

export function buildReviewEnvelope(
  target: NormalizedTarget,
  request: ReviewTargetRequest,
): ReviewEnvelope {
  return {
    protocol: "issue-delivery-review/v1",
    target,
    boundIdentity: {
      reviewScopeDigest:
        target.kind === "issue" ? target.reviewScopeDigest : null,
      expectedHeadSha: request.kind === "pr" ? request.expectedHeadSha : null,
    },
    outputContract: {
      verdicts: VERDICTS,
      findingSeverities: FINDING_SEVERITIES,
    },
  };
}

function parseIssueNumber(value: string | undefined): number {
  if (!value || !/^[1-9][0-9]*$/.test(value)) {
    throw new Error("Target number must be a positive integer.");
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new Error("Target number is outside the safe integer range.");
  }
  return number;
}

function reviewerArgv(request: ReviewTargetRequest): string[] {
  return request.kind === "issue"
    ? ["issue", String(request.number)]
    : ["pr", String(request.number), request.expectedHeadSha];
}

function reviewerToolPolicy(request: ReviewTargetRequest): ReviewerToolPolicy {
  const allowedShellCommands = [
    "git status --short",
    request.kind === "issue"
      ? `gh issue view ${request.number} --repo ${REPOSITORY}`
      : `gh pr view ${request.number} --repo ${REPOSITORY}`,
    ...(request.kind === "pr"
      ? [`gh pr diff ${request.number} --repo ${REPOSITORY}`]
      : []),
  ];
  return {
    allowedTools: REVIEWER_TOOL_POLICY.allowedTools,
    allowedShellCommands,
    deniedCapabilities: REVIEWER_TOOL_POLICY.deniedCapabilities,
  };
}

function normalizeText(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

function validateTarget(
  target: NormalizedTarget,
  request: ReviewTargetRequest,
): void {
  if (target.kind !== request.kind || target.number !== request.number) {
    throw new Error(
      "Fetched target identity does not match the requested target.",
    );
  }
  if (!target.url || !target.title || typeof target.body !== "string") {
    throw new Error(
      "Fetched target is missing required identity or scope fields.",
    );
  }
  if (target.kind === "issue") {
    if (!/^[0-9a-f]{64}$/i.test(target.reviewScopeDigest)) {
      throw new Error("Issue target has an invalid review scope digest.");
    }
    if (
      target.reviewScopeDigest !== reviewScopeDigest(target.title, target.body)
    ) {
      throw new Error(
        "Issue target review scope digest does not match its scope.",
      );
    }
    return;
  }
  if (!/^[0-9a-f]{40}$/i.test(target.headSha)) {
    throw new Error("PR target has an invalid full head SHA.");
  }
  for (const linkedIssue of target.linkedIssues) {
    validateTarget(linkedIssue, { kind: "issue", number: linkedIssue.number });
  }
}

function isStale(
  initialTarget: NormalizedTarget,
  currentTarget: NormalizedTarget,
): boolean {
  if (initialTarget.kind !== currentTarget.kind) return true;
  if (initialTarget.kind === "issue" && currentTarget.kind === "issue") {
    return initialTarget.reviewScopeDigest !== currentTarget.reviewScopeDigest;
  }
  if (initialTarget.kind === "pr" && currentTarget.kind === "pr") {
    return (
      initialTarget.headSha.toLowerCase() !==
        currentTarget.headSha.toLowerCase() ||
      linkedIssueScopesChanged(
        initialTarget.linkedIssues,
        currentTarget.linkedIssues,
      )
    );
  }
  return true;
}

function linkedIssueScopesChanged(
  initialIssues: NormalizedIssueTarget[],
  currentIssues: NormalizedIssueTarget[],
): boolean {
  if (initialIssues.length !== currentIssues.length) return true;
  return initialIssues.some((initialIssue, index) => {
    const currentIssue = currentIssues[index];
    return (
      !currentIssue ||
      initialIssue.number !== currentIssue.number ||
      initialIssue.reviewScopeDigest !== currentIssue.reviewScopeDigest
    );
  });
}

function parseReviewerOutput(stdout: string): ParsedReviewerOutput {
  const envelope = JSON.parse(stdout) as { type?: unknown; result?: unknown };
  if (envelope.type !== "result" || typeof envelope.result !== "string") {
    throw new Error("Expected a Claude JSON result envelope.");
  }

  const lines = envelope.result
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const verdictLine = lines.find((line) => line.startsWith("VERDICT:"));
  const verdict = verdictLine?.slice("VERDICT:".length).trim();
  if (!verdict || !VERDICTS.includes(verdict as ReviewVerdict)) {
    throw new Error("Expected VERDICT: PASS or VERDICT: BLOCKED.");
  }

  const findings: ReviewFinding[] = [];
  for (const line of lines.filter((candidate) =>
    candidate.startsWith("FINDING:"),
  )) {
    const match =
      /^FINDING:\s*(BLOCKING|MATERIAL|NON_BLOCKING|INFORMATIONAL):\s*(.+)$/.exec(
        line,
      );
    if (!match?.[1] || !match[2]) {
      throw new Error("Each finding must use FINDING: SEVERITY: message.");
    }
    findings.push({
      severity: match[1] as FindingSeverity,
      message: match[2],
    });
  }

  if (
    verdict === "PASS" &&
    findings.some(
      (finding) =>
        finding.severity === "BLOCKING" || finding.severity === "MATERIAL",
    )
  ) {
    throw new Error("PASS cannot contain BLOCKING or MATERIAL findings.");
  }

  return { verdict: verdict as ReviewVerdict, findings };
}

function failure(
  code: ReviewFailureCode,
  message: string,
  recovery: string,
): ReviewTargetFailure {
  return { kind: "failure", code, message, recovery, attemptConsumed: false };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

type GhIssueJson = {
  number: number;
  url: string;
  title: string;
  body: string | null;
  state: string;
  labels: Array<{ name: string }>;
  milestone: { title: string } | null;
};

type GhPrJson = GhIssueJson & {
  baseRefName: string;
  headRefOid: string;
  closingIssuesReferences: Array<{ number: number }>;
  statusCheckRollup: Array<{
    name?: string;
    status?: string;
    conclusion?: string | null;
  }>;
};

async function ghJson<T>(args: string[]): Promise<T> {
  const { stdout } = await execFileAsync("gh", args, {
    cwd: process.cwd(),
    maxBuffer: 8 * 1024 * 1024,
  });
  return JSON.parse(stdout) as T;
}

async function fetchIssue(number: number): Promise<NormalizedIssueTarget> {
  const issue = await ghJson<GhIssueJson>([
    "issue",
    "view",
    String(number),
    "--repo",
    REPOSITORY,
    "--json",
    "number,url,title,body,state,labels,milestone",
  ]);
  const body = issue.body ?? "";
  return {
    kind: "issue",
    number: issue.number,
    url: issue.url,
    title: issue.title,
    body,
    labels: issue.labels.map((label) => label.name),
    milestone: issue.milestone?.title ?? null,
    state: issue.state,
    reviewScopeDigest: reviewScopeDigest(issue.title, body),
  };
}

async function fetchPr(number: number): Promise<NormalizedPrTarget> {
  const pr = await ghJson<GhPrJson>([
    "pr",
    "view",
    String(number),
    "--repo",
    REPOSITORY,
    "--json",
    "number,url,title,body,state,labels,milestone,baseRefName,headRefOid,closingIssuesReferences,statusCheckRollup",
  ]);
  const { stdout: patch } = await execFileAsync(
    "gh",
    ["pr", "diff", String(number), "--repo", REPOSITORY],
    {
      cwd: process.cwd(),
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  const linkedIssues = await Promise.all(
    pr.closingIssuesReferences.map((issue) => fetchIssue(issue.number)),
  );
  return {
    kind: "pr",
    number: pr.number,
    url: pr.url,
    title: pr.title,
    body: pr.body ?? "",
    state: pr.state,
    labels: pr.labels.map((label) => label.name),
    milestone: pr.milestone?.title ?? null,
    baseRefName: pr.baseRefName,
    headSha: pr.headRefOid.toLowerCase(),
    patch,
    linkedIssues,
    checks: pr.statusCheckRollup.map((check) => ({
      name: check.name ?? "unknown",
      status: check.status ?? "unknown",
      conclusion: check.conclusion ?? null,
    })),
  };
}

async function fetchTarget(
  request: ReviewTargetRequest,
): Promise<NormalizedTarget> {
  return request.kind === "issue"
    ? fetchIssue(request.number)
    : fetchPr(request.number);
}

async function createSafeReviewWorkspace(revision: string): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "review-target-"));
  try {
    const archive = await archiveRepository(revision);
    const archivePath = join(workspace, "repository.tar");
    await writeFile(archivePath, archive);
    await execFileAsync("tar", ["-xf", archivePath, "-C", workspace], {
      maxBuffer: 1024 * 1024,
    });
    await rm(archivePath, { force: true });
    return workspace;
  } catch (error) {
    await rm(workspace, { recursive: true, force: true });
    throw error;
  }
}

function archiveRepository(revision: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["archive", "--format=tar", revision], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let stderr = "";
    let settled = false;
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.once("close", (exitCode) => {
      if (settled) return;
      settled = true;
      if (exitCode !== 0) {
        reject(
          new Error(`Could not create a safe review workspace: ${stderr}`),
        );
      } else {
        resolve(Buffer.concat(chunks));
      }
    });
  });
}

async function runLiveReviewer(
  invocation: ReviewerInvocation,
): Promise<ReviewerRunResult> {
  const revision = await reviewerRevision(invocation);
  const safeWorkspace = await createSafeReviewWorkspace(revision);
  const allowedTools = [
    ...invocation.policy.allowedTools.filter(
      (tool) => !["Bash", "Read", "Glob", "Grep"].includes(tool),
    ),
    ...invocation.policy.allowedTools.filter((tool) =>
      ["Read", "Glob", "Grep"].includes(tool),
    ),
    ...invocation.policy.allowedShellCommands.map(
      (command) => `Bash(${command})`,
    ),
  ];
  const args = [
    "-p",
    "Read the JSON review envelope from stdin. Review the bound target's scope and acceptance criteria, the exact diff when the target is a PR, tests, release-check evidence, and safety/invariant impact using read-only access. Reply with PLAIN TEXT ONLY - no JSON, no markdown, and no code fences. The first line must be exactly VERDICT: PASS or VERDICT: BLOCKED. Each finding must be on its own single line, exactly FINDING: <SEVERITY>: <message>, where <SEVERITY> is one of BLOCKING, MATERIAL, NON_BLOCKING, INFORMATIONAL. Output nothing else.",
    "--model",
    "claude-opus-5",
    "--effort",
    "high",
    "--output-format",
    "json",
    "--tools",
    invocation.policy.allowedTools.join(","),
    "--allowedTools",
    allowedTools.join(","),
    "--permission-prompts",
    "none",
    "--add-dir",
    safeWorkspace,
  ];
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn("claude", args, {
        cwd: safeWorkspace,
        shell: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      let outputBytes = 0;
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          child.kill();
          reject(new Error("Reviewer process exceeded the bounded timeout."));
        }
      }, REVIEWER_TIMEOUT_MS);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      const appendOutput = (stream: "stdout" | "stderr", chunk: string) => {
        outputBytes += Buffer.byteLength(chunk, "utf8");
        if (outputBytes > MAX_REVIEWER_OUTPUT_BYTES && !settled) {
          settled = true;
          clearTimeout(timeout);
          child.kill();
          reject(new Error("Reviewer output exceeded the bounded limit."));
          return;
        }
        if (stream === "stdout") stdout += chunk;
        else stderr += chunk;
      };
      child.stdout.on("data", (chunk: string) => appendOutput("stdout", chunk));
      child.stderr.on("data", (chunk: string) => appendOutput("stderr", chunk));
      child.once("error", (error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(error);
        }
      });
      child.once("close", (exitCode) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          resolve({ exitCode: exitCode ?? 1, stdout, stderr });
        }
      });
      child.stdin.end(invocation.stdin);
    });
  } finally {
    await rm(safeWorkspace, { recursive: true, force: true });
  }
}

async function reviewerRevision(
  invocation: ReviewerInvocation,
): Promise<string> {
  if (invocation.argv[0] !== "pr") return "HEAD";

  const number = invocation.argv[1];
  const expectedHeadSha = invocation.argv[2];
  if (!number || !expectedHeadSha) {
    throw new Error("PR reviewer invocation is missing its bound identity.");
  }

  try {
    await execFileAsync(
      "git",
      ["cat-file", "-e", `${expectedHeadSha}^{commit}`],
      { cwd: process.cwd(), maxBuffer: 1024 * 1024 },
    );
  } catch {
    await execFileAsync(
      "git",
      ["fetch", "--no-tags", "origin", `pull/${number}/head`],
      {
        cwd: process.cwd(),
        maxBuffer: 1024 * 1024,
        timeout: 30_000,
      },
    );
    await execFileAsync(
      "git",
      ["cat-file", "-e", `${expectedHeadSha}^{commit}`],
      { cwd: process.cwd(), maxBuffer: 1024 * 1024 },
    );
  }
  return expectedHeadSha;
}

async function main(): Promise<void> {
  let request: ReviewTargetRequest;
  try {
    request = parseTargetArgs(process.argv.slice(2));
  } catch (error) {
    console.error(errorMessage(error));
    process.exitCode = 2;
    return;
  }

  const result = await reviewTarget(request, {
    fetchTarget,
    runReviewer: runLiveReviewer,
  });
  console.log(JSON.stringify(result));
  if (result.kind === "failure") {
    process.exitCode = result.code === "REVIEW_INPUT_STALE" ? 4 : 3;
  } else if (result.verdict === "BLOCKED") {
    process.exitCode = 5;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
