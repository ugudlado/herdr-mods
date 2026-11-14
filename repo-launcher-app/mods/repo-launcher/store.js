// The mod's saved state, in shared state (shared.json), so the list shows on
// the first frame of the popup without a file read.

import { shared, setShared } from "herdr";
import { pathKey, placeId } from "./scan.js";

export const MOD = "repo-launcher";

const SETTINGS = `${MOD}.settings`;
const CACHE = `${MOD}.cache`;
// Other mods of the kit read `repo-launcher.agents` as this computer's list
// and `repo-launcher.cache` as the repository list: keep both shapes.
const AGENTS = `${MOD}.agents`;
const REMOTE_AGENTS = `${AGENTS}.remote`;

const DEFAULTS = {
  roots: [], // folders on this computer
  remoteRoots: [], // folders on other machines: { machine, path }
  reuse: true, // open in the repository's open space when it has one
  recent: {}, // placeId key -> time the repository was last opened
};

export function settings() {
  return { ...DEFAULTS, ...(shared(SETTINGS) ?? {}) };
}

export function updateSettings(change) {
  const next = { ...settings(), ...(typeof change === "function" ? change(settings()) : change) };
  setShared(SETTINGS, next);
  return next;
}

/**
 * `{ repos: [{ path, name, root, machine }], scannedAt, missing, machines }`.
 * `missing`: placeId() of each root that was not found. `machines`:
 * `{ [name]: { home } }` of the other machines, so their paths show with `~`.
 */
export function cache() {
  return { repos: [], scannedAt: null, missing: [], machines: {}, ...(shared(CACHE) ?? {}) };
}

export function setCache(value) {
  setShared(CACHE, value);
}

/**
 * Every root folder: `[{ machine, path, id }]`, this computer first.
 * `known`: the machine names Herdr knows now; roots of other machines are left out.
 */
export function allRoots(known = null) {
  const s = settings();
  return [
    ...s.roots.map((path) => ({ machine: null, path, id: placeId(null, path) })),
    ...s.remoteRoots
      .filter((r) => !known || known.includes(r.machine))
      .map((r) => ({ machine: r.machine, path: r.path, id: placeId(r.machine, r.path) })),
  ];
}

/** The installed agents of this computer, as knownAgents() gave them: `{ list, checkedAt }`. */
export function agentCache() {
  return { list: null, checkedAt: null, ...(shared(AGENTS) ?? {}) };
}

export function setAgentCache(list) {
  setShared(AGENTS, { list, checkedAt: Date.now() });
}

/** The installed agents of another machine: `{ list, checkedAt }`. */
export function remoteAgentCache(machine) {
  return { list: null, checkedAt: null, ...(shared(REMOTE_AGENTS)?.[machine] ?? {}) };
}

export function setRemoteAgentCache(machine, list) {
  setShared(REMOTE_AGENTS, { ...(shared(REMOTE_AGENTS) ?? {}), [machine]: { list, checkedAt: Date.now() } });
}

export function markOpened(id) {
  updateSettings((s) => {
    // Keep the 50 most recent.
    const entries = Object.entries({ ...s.recent, [pathKey(id)]: Date.now() })
      .sort((a, b) => b[1] - a[1])
      .slice(0, 50);
    return { recent: Object.fromEntries(entries) };
  });
}

export function lastOpened(id) {
  return settings().recent[pathKey(id)] ?? 0;
}
