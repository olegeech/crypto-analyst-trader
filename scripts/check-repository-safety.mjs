import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";

const PLACEHOLDER_VALUES = new Set([
  "",
  "changeme",
  "change_me",
  "dummy",
  "example",
  "placeholder",
  "test",
]);
const SENSITIVE_PATH =
  /(?:^|\/)(?:\.env(?:\.[^/]+)?|credentials?(?:[._-][^/]*)?|secrets?(?:[._-][^/]*)?)(?:\/|$)|(?:^|\/)data\/private(?:\/|$)/i;
const SENSITIVE_EXTENSION = /\.(?:key|pem)$/i;
const BYBIT_CREDENTIAL =
  /["']?\bBYBIT_API_(?:KEY|SECRET)\b["']?[ \t]*(?:=|:)[ \t]*["']?([^"'\s,#},]*)/gi;

function isPlaceholder(value) {
  const normalized = value.trim().toLowerCase();

  return (
    PLACEHOLDER_VALUES.has(normalized) ||
    normalized.startsWith("your_") ||
    normalized.startsWith("replace_") ||
    normalized.startsWith("<") ||
    normalized.endsWith(">") ||
    normalized.startsWith("${")
  );
}

function trackedPaths(repositoryRoot) {
  const output = execFileSync("git", ["ls-files", "-z"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });

  return output.split("\0").filter(Boolean);
}

function inspectRepository(repositoryRoot = process.cwd()) {
  const violations = [];

  for (const path of trackedPaths(repositoryRoot)) {
    if (
      path !== ".env.example" &&
      (SENSITIVE_PATH.test(path) || SENSITIVE_EXTENSION.test(path))
    ) {
      violations.push(`tracked credential path: ${path}`);
    }

    let content;
    try {
      content = readFileSync(`${repositoryRoot}/${path}`);
    } catch {
      violations.push(`unreadable tracked path: ${path}`);
      continue;
    }

    if (content.includes(0)) {
      continue;
    }

    for (const match of content.toString("utf8").matchAll(BYBIT_CREDENTIAL)) {
      if (!isPlaceholder(match[1] ?? "")) {
        violations.push(`non-placeholder Bybit credential field: ${path}`);
        break;
      }
    }
  }

  return violations;
}

try {
  const violations = inspectRepository();
  if (violations.length > 0) {
    console.error("Repository safety check failed:");
    for (const violation of violations) {
      console.error(`- ${violation}`);
    }
    process.exitCode = 1;
  }
} catch (error) {
  console.error(
    `Repository safety check could not complete: ${error instanceof Error ? error.message : "unknown error"}`,
  );
  process.exitCode = 1;
}
