import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function documentationOnly(files: readonly string[] | null): boolean {
  return (
    files !== null &&
    files.length > 0 &&
    files.every((file) =>
      /^(?:[^/]+\.md|docs\/.+\.md|\.github\/pull_request_template\.md|\.github\/PULL_REQUEST_TEMPLATE\/.+\.md)$/iu.test(
        file,
      ),
    )
  );
}

function diffRange(): string | null {
  const base = process.env.CI_DIFF_BASE ?? "";
  const head = process.env.CI_DIFF_HEAD ?? "";
  if (
    !/^[a-f0-9]{40}$/iu.test(base) ||
    !/^[a-f0-9]{40}$/iu.test(head) ||
    /^0+$/u.test(base)
  ) {
    return null;
  }
  return `${base}${process.env.CI_DIFF_EVENT === "pull_request" ? "..." : ".."}${head}`;
}

function changedFiles(range: string | null): string[] | null {
  if (!range) return null;
  try {
    return execFileSync(
      "git",
      ["diff", "--no-renames", "--name-only", "-z", range, "--"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    )
      .split("\0")
      .filter(Boolean);
  } catch {
    return null;
  }
}

function withoutFencedCode(content: string): string {
  return content.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[^\n]*$/gmu, "");
}

function markdownAnchors(content: string): Set<string> {
  const anchors = new Set<string>();
  const counts = new Map<string, number>();
  for (const match of withoutFencedCode(content).matchAll(
    /^#{1,6}\s+(.+?)\s*#*$/gmu,
  )) {
    const slug = (match[1] ?? "")
      .replace(/\[([^\]]+)\]\([^)]+\)/gu, "$1")
      .replace(/<[^>]*>/gu, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_\- ]/gu, "")
      .replace(/ /gu, "-");
    const count = counts.get(slug) ?? 0;
    anchors.add(count ? `${slug}-${count}` : slug);
    counts.set(slug, count + 1);
  }
  for (const match of content.matchAll(/\b(?:id|name)=["']([^"']+)["']/gu)) {
    anchors.add(match[1] ?? "");
  }
  return anchors;
}

export function localLinkErrors(file: string): string[] {
  const content = withoutFencedCode(readFileSync(file, "utf8")).replace(
    /`[^`\n]+`/gu,
    "",
  );
  const links = [
    ...content.matchAll(/\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+[^)]*)?\)/gu),
    ...content.matchAll(/^\s*\[[^\]]+\]:\s*(<[^>]+>|\S+)/gmu),
  ];
  const errors: string[] = [];
  for (const match of links) {
    const link = (match[1] ?? "").replace(/^<|>$/gu, "");
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(link)) continue;
    try {
      const [path = "", fragment] = link.split("#", 2);
      // Root-relative links refer to GitHub routes, not repository files.
      if (path.startsWith("/")) continue;
      const target = path
        ? resolve(dirname(file), decodeURIComponent(path))
        : file;
      if (!existsSync(target)) {
        errors.push(`${file}: missing link target ${link}`);
      } else if (
        fragment &&
        /\.md$/iu.test(target) &&
        !markdownAnchors(readFileSync(target, "utf8")).has(
          decodeURIComponent(fragment),
        )
      ) {
        errors.push(`${file}: missing Markdown anchor ${link}`);
      }
    } catch {
      errors.push(`${file}: invalid local link ${link}`);
    }
  }
  return errors;
}

function main(): void {
  const range = diffRange();
  const files = changedFiles(range);
  const docsOnly = documentationOnly(files);
  if (process.argv[2] === "scope") {
    const output = `docs_only=${docsOnly}\n`;
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(process.env.GITHUB_OUTPUT, output);
    console.log(output.trim());
    if (files === null)
      console.log("Diff unavailable; use full release checks.");
    return;
  }
  if (process.argv[2] !== "docs" || !docsOnly || !range || !files) {
    throw new Error(
      "Documentation checks require a known documentation-only diff.",
    );
  }
  execFileSync("git", ["diff", "--check", range, "--"], { stdio: "inherit" });
  const existing = files.filter((file) => existsSync(file));
  if (existing.length) {
    execFileSync(
      "npx",
      [
        "--yes",
        "--package=prettier@3.9.8",
        "prettier",
        "--check",
        ...existing.map((file) => `./${file}`),
      ],
      { stdio: "inherit" },
    );
  }
  const errors = existing.flatMap(localLinkErrors);
  if (errors.length) throw new Error(errors.join("\n"));
  console.log("Documentation formatting, local links and diff checks passed.");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
