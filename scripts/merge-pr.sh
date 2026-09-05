#!/bin/bash
#
# Squash-merge a reviewed crypto-analyst-trader PR and sync local main.
#
# Usage:
#   ./scripts/merge-pr.sh <PR-number> <reviewed-head-SHA>
#
# The full SHA is mandatory: --match-head-commit is the authoritative
# server-side guard against merging a head that changed after review.
#
# Requires: git, gh (authenticated).

set -euo pipefail

CDPATH='' cd -- "$(dirname -- "$0")/.."

PR="${1:-}"
REVIEWED_SHA="${2:-}"

if [[ -z "$PR" || -z "$REVIEWED_SHA" || $# -ne 2 ]]; then
  echo "Usage: $0 <PR-number> <reviewed-head-SHA>" >&2
  exit 2
fi

if [[ ! "$PR" =~ ^[1-9][0-9]*$ ]]; then
  echo "ERROR: PR number must be a positive integer." >&2
  exit 2
fi

if [[ ! "$REVIEWED_SHA" =~ ^[0-9a-fA-F]{40}$ ]]; then
  echo "ERROR: reviewed head SHA must contain exactly 40 hexadecimal characters." >&2
  exit 2
fi

REVIEWED_SHA="$(printf '%s' "$REVIEWED_SHA" | tr '[:upper:]' '[:lower:]')"

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "ERROR: tracked working-tree changes must be clean before merge." >&2
  exit 1
fi

JQ_FILTER='[
  .headRefOid,
  .state,
  (.isDraft | tostring),
  .baseRefName,
  .mergeable,
  (if (.reviewDecision // "") == "" then "NONE" else .reviewDecision end),
  ([(.statusCheckRollup // [])[] | select((
    (.__typename == "CheckRun" and
      .status == "COMPLETED" and
      (.conclusion == "SUCCESS" or
        .conclusion == "NEUTRAL" or
        .conclusion == "SKIPPED"))
    or
    (.__typename == "StatusContext" and .state == "SUCCESS")
  ) | not)] | length | tostring),
  ([(.statusCheckRollup // [])[] | select(
    .name == "release-checks" and
    ((.__typename == "CheckRun" and
      .status == "COMPLETED" and .conclusion == "SUCCESS") or
     (.__typename == "StatusContext" and .state == "SUCCESS"))
  )] | length | tostring),
  (if .statusCheckRollup == null
    then "null"
    else (.statusCheckRollup | length | tostring)
  end)
] | @tsv'

PR_DATA="$(
  gh pr view "$PR" \
    --json headRefOid,state,isDraft,baseRefName,mergeable,reviewDecision,statusCheckRollup \
    --jq "$JQ_FILTER"
)"

IFS=$'\t' read -r \
  HEAD_SHA PR_STATE IS_DRAFT BASE_REF MERGEABLE REVIEW_DECISION \
  BAD_CHECKS RELEASE_CHECKS TOTAL_CHECKS \
  <<< "$PR_DATA"

for value in \
  "$HEAD_SHA" "$PR_STATE" "$IS_DRAFT" "$BASE_REF" "$MERGEABLE" \
  "$BAD_CHECKS" "$RELEASE_CHECKS" "$TOTAL_CHECKS"; do
  if [[ -z "$value" || "$value" == "null" ]]; then
    echo "ERROR: GitHub returned incomplete pull-request state." >&2
    exit 1
  fi
done

HEAD_SHA="$(printf '%s' "$HEAD_SHA" | tr '[:upper:]' '[:lower:]')"

if [[ "$PR_STATE" != "OPEN" ]]; then
  echo "ERROR: PR #${PR} is not open." >&2
  exit 1
fi

if [[ "$IS_DRAFT" != "false" ]]; then
  echo "ERROR: PR #${PR} is still a draft." >&2
  exit 1
fi

if [[ "$BASE_REF" != "main" ]]; then
  echo "ERROR: PR #${PR} targets ${BASE_REF}, not main." >&2
  exit 1
fi

case "$MERGEABLE" in
  MERGEABLE) ;;
  CONFLICTING)
    echo "ERROR: PR #${PR} has merge conflicts." >&2
    exit 1
    ;;
  UNKNOWN)
    echo "ERROR: GitHub is still computing mergeability; retry later." >&2
    exit 1
    ;;
  *)
    echo "ERROR: unsupported mergeability state: ${MERGEABLE}." >&2
    exit 1
    ;;
esac

if [[ "$HEAD_SHA" != "$REVIEWED_SHA" ]]; then
  echo "ERROR: PR head moved since review." >&2
  echo "  reviewed: ${REVIEWED_SHA}" >&2
  echo "  current:  ${HEAD_SHA}" >&2
  echo "Re-run verification and review before merging." >&2
  exit 1
fi

if [[ "$REVIEW_DECISION" == "CHANGES_REQUESTED" ]]; then
  echo "ERROR: PR #${PR} has changes requested." >&2
  exit 1
fi

if [[ ! "$BAD_CHECKS" =~ ^[0-9]+$ || ! "$RELEASE_CHECKS" =~ ^[0-9]+$ || ! "$TOTAL_CHECKS" =~ ^[0-9]+$ ]]; then
  echo "ERROR: GitHub returned invalid check-state evidence." >&2
  exit 1
fi

if (( BAD_CHECKS != 0 )); then
  echo "ERROR: PR #${PR} has pending, cancelled, or unsuccessful checks." >&2
  exit 1
fi

if (( RELEASE_CHECKS != 1 )); then
  echo "ERROR: required release-checks evidence is missing or unsuccessful." >&2
  exit 1
fi

if (( TOTAL_CHECKS == 0 )); then
  echo "ERROR: GitHub reports no checks for PR #${PR}." >&2
  exit 1
fi

echo "Merging PR #${PR} at reviewed head ${REVIEWED_SHA}."

git switch main

if ! gh pr merge "$PR" --squash --match-head-commit "$REVIEWED_SHA" --delete-branch; then
  echo "ERROR: the GitHub merge command failed; verify PR #${PR} before retrying." >&2
  exit 1
fi

if ! git pull --ff-only origin main; then
  echo "ERROR: PR #${PR} was merged, but local main was not updated." >&2
  echo "Resolve the local main state manually; do not repeat the merge." >&2
  exit 1
fi

echo "Merged PR #${PR} (${REVIEWED_SHA}) and updated local main."
