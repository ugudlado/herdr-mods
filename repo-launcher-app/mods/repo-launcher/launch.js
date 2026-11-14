// Opens a terminal or an agent for a repository: in a new tab of the
// repository's open space, or in a new space on the repository's machine.

import { spaces, panes, run } from "herdr";
import { isInside } from "./scan.js";

/**
 * The open spaces of `machine` (null: this computer) that work in `repo`: a
 * space with a terminal whose live folder is in the repository.
 *
 * Best first: the space named after the repository (Herdr names a space after
 * the repository of its first terminal), then one whose start folder is in
 * the repository, then the shown space; then the most terminals there.
 */
export function spacesFor(repoPath, machine = null, allSpaces = spaces(), allPanes = panes()) {
  const repoName = repoPath.replace(/\/+$/, "").split("/").pop().toLowerCase();
  const inRepo = new Map(); // tab id -> [panes in the repository, all panes]
  for (const p of allPanes) {
    if (!p.terminal) continue;
    const [hit, all] = inRepo.get(p.tab) ?? [0, 0];
    inRepo.set(p.tab, [hit + (isInside(p.cwd, repoPath) ? 1 : 0), all + 1]);
  }
  const share = (s) => {
    let hit = 0;
    let all = 0;
    for (const t of s.tabs) {
      const [h, a] = inRepo.get(t.id) ?? [0, 0];
      hit += h;
      all += a;
    }
    return { hit, ratio: all ? hit / all : 0 };
  };
  // `folder` is where a space was made, not where it works now: only a tie-break.
  const rank = (s) => (s.name.toLowerCase() === repoName ? 4 : 0) + (isInside(s.folder, repoPath) ? 2 : 0) + (s.active ? 1 : 0);
  return allSpaces
    .filter((s) => (s.machine ?? null) === (machine ?? null))
    .map((s) => ({ s, rank: rank(s), share: share(s) }))
    .filter((x) => x.share.hit > 0)
    .sort((a, b) => (b.rank - a.rank) || (b.share.ratio - a.share.ratio) || (a.s.index - b.s.index))
    .map((x) => x.s);
}

/**
 * Opens `argv` (null: a shell) in the repository.
 * `space`: an open space to add a tab to; null makes a new space on `machine`
 * (null: this computer). `name`: the tab name.
 */
export function open(repoPath, { argv = null, name = undefined, machine = null, space = null } = {}) {
  const extra = { ...(argv ? { argv } : {}) };
  if (!space) {
    run("space.new", { folder: repoPath, machine: machine ?? "", ...extra, ...(name ? { tab: name } : {}) });
    return;
  }
  run("space.select", { id: space.id });
  run("tab.new", { space: space.id, folder: repoPath, ...extra, ...(name ? { name } : {}) });
}
