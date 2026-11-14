// Finds Git repositories under the root folders of one machine.
//
// A mod can list folders only inside the home folder (fs/promises), so the
// search runs `find` through `sh -c` with a fixed script. The root folders
// are passed as arguments, never put into the script text.

import { exec, home, window } from "herdr";

/** How many folder levels under a root the search opens. */
export const DEPTH = 3;

/** A path with forward slashes and no slash at the end. */
export function normalize(path) {
  return String(path ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
}

/** The key that compares two paths: case-insensitive except on Linux. */
export function pathKey(path) {
  const p = normalize(path);
  return window()?.platform === "linux" ? p : p.toLowerCase();
}

/** True when `path` is `folder` or inside it. */
export function isInside(path, folder) {
  if (!path || !folder) return false;
  const p = pathKey(path);
  const f = pathKey(folder);
  return p === f || p.startsWith(f + "/");
}

/** A path for people, with `~` for `homeDir` (default: this computer's home). */
export function displayPath(path, homeDir = home()) {
  const p = normalize(path);
  const h = normalize(homeDir);
  if (!h) return p;
  return pathKey(p) === pathKey(h) ? "~" : isInside(p, h) ? "~" + p.slice(h.length) : p;
}

/** The key of a repository or a root: the path, after `machine|` for another machine. */
export function placeId(machine, path) {
  return machine ? `${machine}|${normalize(path)}` : normalize(path);
}

/** True for a root folder the search accepts: an absolute path or one under `~`. */
export const validRoot = (path) => /^(\/|~$|~\/)/.test(path);

// Fixed script. Arguments: $1 = depth, then the root folders.
// Prints `home<TAB>$HOME` first, then `repo<TAB>root<TAB>dir` for each folder
// that holds `.git` (a folder, or a file for worktrees and submodules), and
// `!missing<TAB>root` for a root that is not a folder. `find` also goes into
// repositories, so the mod drops nested ones afterwards. At most 2000
// repositories per root.
const SH_SCAN = `
depth="$1"; shift
printf 'home\\t%s\\n' "$HOME"
for root in "$@"; do
  start="$root"
  case "$root" in "~"|"~/"*) start="$HOME\${root#"~"}" ;; esac
  case "$start" in /*) ;; *) printf '!missing\\t%s\\n' "$root"; continue ;; esac
  if [ ! -d "$start" ]; then printf '!missing\\t%s\\n' "$root"; continue; fi
  find "$start" -mindepth 0 -maxdepth "$depth" \\( -name node_modules -o -name .venv -o -name venv \\
    -o -name __pycache__ -o -name bin -o -name obj -o -name dist -o -name build -o -name target \\
    -o -name packages -o -name .idea -o -name .vscode -o -name .gradle -o -name .next -o -name .cache \\
    -o -name vendor -o -name Pods -o -name DerivedData \\) -prune -o -name .git -print 2>/dev/null \\
    | head -n 2000 | while IFS= read -r g; do
    printf 'repo\\t%s\\t%s\\n' "$root" "$(dirname "$g")"
  done
done
`;

/**
 * The repositories under `roots` on the machine `on` (null: this computer).
 * Resolves with `{ repos: [{ path, name, root, machine }], missing: [root], home }`.
 * Rejects when the search cannot run.
 */
export async function findRepos(roots, on = null) {
  if (roots.length === 0) return { repos: [], missing: [], home: on ? "" : normalize(home()) };
  const r = await exec("sh", ["-c", SH_SCAN, "sh", String(DEPTH + 1), ...roots], { on, timeout: 120000 });
  if (r.code !== 0 && !r.stdout.trim()) {
    throw new Error(r.stderr.trim().split("\n")[0] || "The repository search failed");
  }
  const missing = [];
  const found = new Map();
  let homeDir = "";
  for (const line of r.stdout.split("\n")) {
    const [kind, a, b] = line.split("\t");
    if (kind === "home") homeDir = normalize(a);
    else if (kind === "!missing") missing.push(normalize(a));
    else if (kind === "repo" && b) {
      const path = normalize(b);
      if (!found.has(pathKey(path))) found.set(pathKey(path), { path, root: normalize(a) });
    }
  }
  // Drop a repository inside another one (a submodule, a vendored copy).
  const kept = [];
  for (const repo of [...found.values()].sort((x, y) => x.path.length - y.path.length)) {
    if (!kept.some((k) => isInside(repo.path, k.path))) kept.push(repo);
  }
  const repos = kept
    .map((repo) => ({ ...repo, machine: on ?? null, name: repo.path.split("/").pop() || repo.path }))
    .sort((x, y) => x.name.toLowerCase().localeCompare(y.name.toLowerCase()));
  return { repos, missing, home: homeDir };
}
