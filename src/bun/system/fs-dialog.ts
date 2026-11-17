/** Native folder selection and workspace file suggestions. */
import { readdir } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { Utils } from "electrobun/bun";
import type { FileSuggestion } from "../../shared/types";

const IGNORED = new Set([".git", "node_modules", "dist", "build", ".hutch", ".DS_Store"]);

export async function pickWorkspaceFolder(): Promise<string | null> {
  const paths = await Utils.openFileDialog({
    startingFolder: Bun.env.HOME ?? "/",
    canChooseFiles: false,
    canChooseDirectory: true,
    allowsMultipleSelection: false,
  });
  const selected = paths.find((path) => path.trim().length > 0);
  return selected ?? null;
}

export function workspaceName(rootPath: string): string {
  return basename(rootPath) || rootPath;
}

async function walk(
  root: string,
  current: string,
  out: string[],
  depth: number,
): Promise<void> {
  if (depth > 5 || out.length > 8000) return;
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (IGNORED.has(entry.name) || entry.name.startsWith(".DS_Store")) continue;
    const full = join(current, entry.name);
    if (entry.isDirectory()) {
      await walk(root, full, out, depth + 1);
    } else if (entry.isFile()) {
      out.push(relative(root, full));
    }
  }
}

export async function suggestFiles(
  rootPath: string,
  query: string,
): Promise<FileSuggestion[]> {
  const files: string[] = [];
  await walk(rootPath, rootPath, files, 0);
  const needle = query.toLowerCase();
  const ranked = files
    .filter((file) => !needle || file.toLowerCase().includes(needle))
    .sort((a, b) => {
      const aName = basename(a).toLowerCase();
      const bName = basename(b).toLowerCase();
      const aStarts = aName.startsWith(needle) ? 0 : 1;
      const bStarts = bName.startsWith(needle) ? 0 : 1;
      if (aStarts !== bStarts) return aStarts - bStarts;
      return a.length - b.length;
    })
    .slice(0, 40);
  return ranked.map((path) => ({ path, name: basename(path) }));
}
