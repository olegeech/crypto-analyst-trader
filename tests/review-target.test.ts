import assert from "node:assert/strict";
import test from "node:test";

import {
  REVIEWER_TOOL_POLICY,
  reviewScopeDigest,
  reviewTarget,
  type NormalizedIssueTarget,
  type NormalizedPrTarget,
  type ReviewerInvocation,
  type ReviewerRunResult,
} from "../scripts/review-target.js";

const issueOne: NormalizedIssueTarget = {
  kind: "issue",
  number: 58,
  url: "https://github.com/olegeech/crypto-analyst-trader/issues/58",
  title: "Bounded reviewer",
  body: "Bind the issue before review.",
  labels: ["status:ready"],
  milestone: "M0",
  state: "OPEN",
  reviewScopeDigest: reviewScopeDigest(
    "Bounded reviewer",
    "Bind the issue before review.",
  ),
};

const issueTwo: NormalizedIssueTarget = {
  ...issueOne,
  labels: ["status:in-progress"],
  milestone: "M1",
  state: "CLOSED",
};

const prOne: NormalizedPrTarget = {
  kind: "pr",
  number: 59,
  url: "https://github.com/olegeech/crypto-analyst-trader/pull/59",
  title: "Add reviewer adapter",
  body: "Closes #58",
  state: "OPEN",
  labels: [],
  milestone: null,
  baseRefName: "main",
  headSha: "a".repeat(40),
  patch: "diff --git a/scripts/review-target.ts b/scripts/review-target.ts",
  linkedIssues: [issueOne],
  checks: [
    { name: "release-checks", status: "COMPLETED", conclusion: "SUCCESS" },
  ],
};

function reviewerPass(): ReviewerRunResult {
  return {
    exitCode: 0,
    stdout: JSON.stringify({
      type: "result",
      result: "VERDICT: PASS",
    }),
    stderr: "",
  };
}

function reviewerBlocked(): ReviewerRunResult {
  return {
    exitCode: 0,
    stdout: JSON.stringify({
      type: "result",
      result:
        "VERDICT: BLOCKED\nFINDING: MATERIAL: release evidence is missing",
    }),
    stderr: "",
  };
}

function dependencies(
  targets: NormalizedIssueTarget[] | NormalizedPrTarget[],
  result: ReviewerRunResult = reviewerPass(),
) {
  const invocations: ReviewerInvocation[] = [];
  let index = 0;
  return {
    invocations,
    fetchTarget: async () => {
      const target = targets[Math.min(index++, targets.length - 1)];
      assert.ok(target);
      return target;
    },
    runReviewer: async (invocation: ReviewerInvocation) => {
      invocations.push(invocation);
      return result;
    },
  };
}

test("reviews an issue through bound stdin and ignores metadata-only drift", async () => {
  const deps = dependencies([issueOne, issueTwo]);

  const result = await reviewTarget({ kind: "issue", number: 58 }, deps);

  assert.equal(result.kind, "success");
  if (result.kind !== "success") return;
  assert.equal(result.verdict, "PASS");
  assert.equal(result.attemptConsumed, true);
  assert.equal(result.reviewScopeDigest, issueOne.reviewScopeDigest);
  assert.equal(deps.invocations.length, 1);
  assert.deepEqual(deps.invocations[0]?.argv, ["issue", "58"]);
  assert.match(
    deps.invocations[0]?.stdin ?? "",
    /Bind the issue before review/,
  );
  assert.doesNotMatch(deps.invocations[0]?.argv.join(" ") ?? "", /Bind|review/);
  assert.deepEqual(deps.invocations[0]?.policy.allowedShellCommands, [
    "git status --short",
    "gh issue view 58 --repo olegeech/crypto-analyst-trader",
  ]);
  assert.ok(
    deps.invocations[0]?.policy.allowedShellCommands.every(
      (command) => !/[;&|`$]/.test(command),
    ),
  );
});

test("reviews an exact-head PR and returns a blocked finding", async () => {
  const deps = dependencies([prOne, prOne], reviewerBlocked());

  const result = await reviewTarget(
    { kind: "pr", number: 59, expectedHeadSha: prOne.headSha },
    deps,
  );

  assert.equal(result.kind, "success");
  if (result.kind !== "success") return;
  assert.equal(result.verdict, "BLOCKED");
  assert.equal(result.findings[0]?.severity, "MATERIAL");
  assert.equal(result.attemptConsumed, true);
  assert.deepEqual(deps.invocations[0]?.argv, ["pr", "59", prOne.headSha]);
  assert.ok(
    deps.invocations[0]?.policy.allowedShellCommands.includes(
      "gh pr diff 59 --repo olegeech/crypto-analyst-trader",
    ),
  );
});

test("rejects linked issue scope drift even when the PR head is unchanged", async () => {
  const changedLinkedIssue: NormalizedIssueTarget = {
    ...issueOne,
    body: "The linked acceptance scope changed.",
    reviewScopeDigest: reviewScopeDigest(
      issueOne.title,
      "The linked acceptance scope changed.",
    ),
  };
  const changedPr: NormalizedPrTarget = {
    ...prOne,
    linkedIssues: [changedLinkedIssue],
  };
  const deps = dependencies([prOne, changedPr]);

  const result = await reviewTarget(
    { kind: "pr", number: 59, expectedHeadSha: prOne.headSha },
    deps,
  );

  assert.equal(result.kind, "failure");
  if (result.kind !== "failure") return;
  assert.equal(result.code, "REVIEW_INPUT_STALE");
  assert.equal(result.attemptConsumed, false);
});

test("rejects issue semantic scope drift without consuming an attempt", async () => {
  const changedIssue: NormalizedIssueTarget = {
    ...issueOne,
    body: "The bound issue changed.",
    reviewScopeDigest: reviewScopeDigest(
      issueOne.title,
      "The bound issue changed.",
    ),
  };
  const deps = dependencies([issueOne, changedIssue]);

  const result = await reviewTarget({ kind: "issue", number: 58 }, deps);

  assert.equal(result.kind, "failure");
  if (result.kind !== "failure") return;
  assert.equal(result.code, "REVIEW_INPUT_STALE");
  assert.equal(result.attemptConsumed, false);
});

test("rejects a moved PR head as stale", async () => {
  const changedPr: NormalizedPrTarget = {
    ...prOne,
    headSha: "b".repeat(40),
  };
  const deps = dependencies([prOne, changedPr]);

  const result = await reviewTarget(
    { kind: "pr", number: 59, expectedHeadSha: prOne.headSha },
    deps,
  );

  assert.equal(result.kind, "failure");
  if (result.kind !== "failure") return;
  assert.equal(result.code, "REVIEW_INPUT_STALE");
  assert.equal(result.attemptConsumed, false);
});

test("maps unavailable and malformed reviewer results without consuming attempts", async () => {
  const unavailable = dependencies([issueOne, issueOne], {
    exitCode: 1,
    stdout: "",
    stderr: "permission denied",
  });
  const unavailableResult = await reviewTarget(
    { kind: "issue", number: 58 },
    unavailable,
  );
  assert.equal(unavailableResult.kind, "failure");
  if (unavailableResult.kind === "failure") {
    assert.equal(unavailableResult.code, "REVIEWER_UNAVAILABLE");
    assert.equal(unavailableResult.attemptConsumed, false);
  }

  const malformed = dependencies([issueOne, issueOne], {
    exitCode: 0,
    stdout: JSON.stringify({ type: "result", result: "VERDICT: MAYBE" }),
    stderr: "",
  });
  const malformedResult = await reviewTarget(
    { kind: "issue", number: 58 },
    malformed,
  );
  assert.equal(malformedResult.kind, "failure");
  if (malformedResult.kind === "failure") {
    assert.equal(malformedResult.code, "REVIEWER_UNAVAILABLE");
    assert.equal(malformedResult.attemptConsumed, false);
  }
});

test("exposes only bounded read-only reviewer capabilities", () => {
  assert.deepEqual(REVIEWER_TOOL_POLICY.allowedTools, [
    "Read",
    "Glob",
    "Grep",
    "Bash",
    "WebFetch",
  ]);
  for (const denied of [
    "Edit",
    "Write",
    "untracked file access",
    "mutating shell commands",
    "push/merge",
    "secret paths and environment values",
    "dangerously-skip-permissions",
  ] as const) {
    assert.ok(REVIEWER_TOOL_POLICY.deniedCapabilities.includes(denied));
  }
});
