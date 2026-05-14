import { existsSync, readFileSync, readdirSync, statSync, watch } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { FSWatcher } from "node:fs";
import ignore, { type Ignore } from "ignore";

export interface TreeNode {
  name: string;
  path: string;          // relative to root
  kind: "file" | "dir";
  size?: number;
  children?: TreeNode[];
}

// VCS metadata directories are NEVER in .gitignore but should always be hidden.
const VCS_DIRS = new Set([".git", ".jj", ".hg", ".svn"]);

function readGitignore(dir: string): string[] {
  const path = join(dir, ".gitignore");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n");
}

/**
 * Walk the directory respecting .gitignore at every level. Nested .gitignores
 * compose: a child gitignore adds rules on top of its parent's.
 *
 * We track patterns relative to the root so the `ignore` package can match
 * paths correctly. Each .gitignore's lines are rebased to root: e.g. a rule
 * "dist/" inside <root>/server/.gitignore is rewritten as "server/dist/".
 */
export function buildTree(rootPath: string, maxEntries = 5000): TreeNode {
  const root = resolve(rootPath);
  if (!existsSync(root)) {
    return { name: rootPath.split("/").pop() ?? rootPath, path: "", kind: "dir", children: [] };
  }
  let count = 0;

  function walk(dir: string, ig: Ignore): TreeNode {
    const rel = relative(root, dir);
    const node: TreeNode = {
      name: dir.split("/").pop() ?? dir,
      path: rel,
      kind: "dir",
      children: [],
    };

    // compose ignores: pick up this directory's .gitignore (if any)
    let localIg = ig;
    const gitignoreLines = readGitignore(dir);
    if (gitignoreLines.length > 0) {
      const rebased = gitignoreLines
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#"))
        .map((l) => {
          // negation lines stay simple
          const neg = l.startsWith("!");
          const body = neg ? l.slice(1) : l;
          if (rel === "" || body.startsWith("/")) {
            return (neg ? "!" : "") + body.replace(/^\//, "");
          }
          // make this rule local to `rel/` so it doesn't bleed outside the subtree
          return (neg ? "!" : "") + rel + "/" + body;
        });
      localIg = ignore().add(ig).add(rebased);
    }

    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { return node; }
    entries.sort((a, b) => a.localeCompare(b));

    for (const name of entries) {
      if (++count > maxEntries) {
        node.children!.push({ name: "… (truncated)", path: "", kind: "file" });
        break;
      }
      if (VCS_DIRS.has(name)) continue;
      const full = join(dir, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      const isDir = st.isDirectory();
      const relChild = relative(root, full) + (isDir ? "/" : "");
      if (localIg.ignores(relChild) || localIg.ignores(relChild.replace(/\/$/, ""))) continue;

      if (isDir) {
        node.children!.push(walk(full, localIg));
      } else {
        node.children!.push({ name, path: relChild.replace(/\/$/, ""), kind: "file", size: st.size });
      }
    }

    node.children!.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return node;
  }

  const tree = walk(root, ignore());
  tree.path = "";
  tree.name = root.split("/").pop() ?? root;
  return tree;
}

// ---------- watchers ----------

interface WatchEntry {
  watcher: FSWatcher;
  debounce: NodeJS.Timeout | null;
}
const watchers = new Map<string, WatchEntry>();

export function startWatch(project: string, watchPath: string, onChange: (project: string) => void) {
  stopWatch(project);
  if (!watchPath || !existsSync(watchPath)) return;
  try {
    const w = watch(watchPath, { recursive: true }, () => {
      const entry = watchers.get(project);
      if (!entry) return;
      if (entry.debounce) clearTimeout(entry.debounce);
      entry.debounce = setTimeout(() => {
        entry.debounce = null;
        onChange(project);
      }, 200);
    });
    w.on("error", () => stopWatch(project));
    watchers.set(project, { watcher: w, debounce: null });
  } catch (e) {
    console.error(`[web-planner] watch failed for ${project}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function stopWatch(project: string) {
  const entry = watchers.get(project);
  if (!entry) return;
  if (entry.debounce) clearTimeout(entry.debounce);
  try { entry.watcher.close(); } catch { /* noop */ }
  watchers.delete(project);
}

export function stopAllWatches() {
  for (const k of [...watchers.keys()]) stopWatch(k);
}
