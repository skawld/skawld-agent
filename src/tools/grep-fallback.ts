/**
 * Pure-JS fallback for GrepTool, used when ripgrep is not on PATH.
 * Produces output that mirrors rg's output shapes for the common flag combinations.
 */

import fs from "node:fs";
import path from "node:path";
import fastGlob from "fast-glob";
import ignore from "ignore";
import type { GrepInput } from "./grep";

// ---------------------------------------------------------------------------
// .gitignore loading
// ---------------------------------------------------------------------------

/** Walk from root upward, loading each .gitignore found into an ignore instance. */
export async function loadGitignoreMatcher(root: string): Promise<ReturnType<typeof ignore>> {
  const ig = ignore();
  let dir = root;
  const visited = new Set<string>();
  while (!visited.has(dir)) {
    visited.add(dir);
    const giPath = path.join(dir, ".gitignore");
    try {
      const content = await fs.promises.readFile(giPath, "utf8");
      ig.add(content);
    } catch {
      // no .gitignore here
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return ig;
}

// ---------------------------------------------------------------------------
// Binary detection
// ---------------------------------------------------------------------------

export function isBinary(buf: Buffer): boolean {
  const end = Math.min(buf.length, 8192);
  for (let i = 0; i < end; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Type → glob mapping
// ---------------------------------------------------------------------------

export const TYPE_GLOBS: Record<string, string> = {
  ts: "**/*.{ts,tsx}",
  js: "**/*.{js,jsx,mjs,cjs}",
  py: "**/*.py",
  go: "**/*.go",
  rs: "**/*.rs",
  md: "**/*.{md,markdown}",
  json: "**/*.json",
  yaml: "**/*.{yaml,yml}",
  html: "**/*.{html,htm}",
  css: "**/*.css",
  sh: "**/*.sh",
  c: "**/*.{c,h}",
  cpp: "**/*.{cpp,cc,cxx,hpp,hxx}",
  java: "**/*.java",
  rb: "**/*.rb",
  php: "**/*.php",
  swift: "**/*.swift",
  kt: "**/*.kt",
};

// ---------------------------------------------------------------------------
// Per-file matching
// ---------------------------------------------------------------------------

interface MatchLine {
  lineNo: number; // 1-indexed
  text: string;
}

interface FileMatches {
  relPath: string;
  matches: MatchLine[];
}

async function grepFile(absPath: string, relPath: string, re: RegExp): Promise<FileMatches | null> {
  const buf = await fs.promises.readFile(absPath).catch(() => null);
  if (!buf || isBinary(buf)) return null;
  const lines = buf.toString("utf8").split("\n");
  const matches: MatchLine[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    re.lastIndex = 0;
    if (re.test(line)) matches.push({ lineNo: i + 1, text: line });
  }
  return matches.length > 0 ? { relPath, matches } : null;
}

// ---------------------------------------------------------------------------
// Output renderers
// ---------------------------------------------------------------------------

function renderFilesWithMatches(results: FileMatches[]): string {
  return results.map((r) => r.relPath).join("\n");
}

function renderCount(results: FileMatches[]): string {
  return results.map((r) => `${r.relPath}:${r.matches.length}`).join("\n");
}

function renderContent(results: FileMatches[], input: GrepInput, fileLines: Map<string, string[]>): string {
  const ctxC = input["-C"];
  const ctxA = ctxC !== undefined ? ctxC : (input["-A"] ?? 0);
  const ctxB = ctxC !== undefined ? ctxC : (input["-B"] ?? 0);
  const showLineNo = input["-n"] ?? false;
  const out: string[] = [];

  for (const r of results) {
    const fc = fileLines.get(r.relPath) ?? [];
    type Range = { start: number; end: number };
    const ranges: Range[] = [];
    for (const m of r.matches) {
      const start = Math.max(0, m.lineNo - 1 - ctxB);
      const end = Math.min(fc.length - 1, m.lineNo - 1 + ctxA);
      const last = ranges[ranges.length - 1];
      if (last !== undefined && start <= last.end + 1) {
        last.end = Math.max(last.end, end);
      } else {
        ranges.push({ start, end });
      }
    }
    let prevEnd = -1;
    for (const range of ranges) {
      if (prevEnd >= 0 && range.start > prevEnd + 1) out.push("--");
      for (let i = range.start; i <= range.end; i++) {
        const lineText = fc[i] ?? "";
        const isMatch = r.matches.some((m) => m.lineNo === i + 1);
        if (showLineNo) {
          const sep = isMatch ? ":" : "-";
          out.push(`${r.relPath}${sep}${i + 1}${sep}${lineText}`);
        } else {
          out.push(`${r.relPath}:${lineText}`);
        }
      }
      prevEnd = range.end;
    }
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Main fallback entry point
// ---------------------------------------------------------------------------

export async function runGrepFallback(input: GrepInput, searchRoot: string): Promise<string> {
  const mode = input.output_mode ?? "files_with_matches";
  const flags = (input["-i"] ? "i" : "") + (input.multiline ? "ms" : "") + "g";
  let re: RegExp;
  try {
    re = new RegExp(input.pattern, flags);
  } catch (err) {
    return `Invalid regex: ${(err as Error).message}`;
  }

  const ig = await loadGitignoreMatcher(searchRoot);

  let globPattern = input.glob ?? "**/*";
  if (input.type) {
    const typeGlob = TYPE_GLOBS[input.type];
    if (typeGlob) globPattern = input.glob ? `{${input.glob},${typeGlob}}` : typeGlob;
  }

  const allFiles = await fastGlob(globPattern, {
    cwd: searchRoot,
    dot: false,
    onlyFiles: true,
    followSymbolicLinks: false,
    ignore: [".git/**", ".hg/**", ".svn/**"],
  });
  const files = allFiles.filter((f) => !ig.ignores(f));

  const results: FileMatches[] = [];
  const fileLines = new Map<string, string[]>();

  for (const relPath of files) {
    const absPath = path.join(searchRoot, relPath);
    const fm = await grepFile(absPath, relPath, re);
    if (fm) {
      results.push(fm);
      if (mode === "content") {
        const content = await fs.promises.readFile(absPath, "utf8").catch(() => "");
        fileLines.set(relPath, content.split("\n"));
      }
    }
  }

  if (results.length === 0) return "";

  switch (mode) {
    case "files_with_matches": return renderFilesWithMatches(results);
    case "count":              return renderCount(results);
    case "content":            return renderContent(results, input, fileLines);
  }
}
