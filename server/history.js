// Automatic undo history.
//
// CLO's own undo stack only records some API changes (it misses moves and
// layer changes), and the API cannot read or jump around in it. So undo here
// is snapshot-based: before each tool call that changes the project, the
// garment is saved to a .zpac file. A garment snapshot holds patterns, seams,
// fabrics, colorways and the 3D drape. It does not hold the avatar or scene.
//
// The history is a timeline of operations with a position in it:
//
//   ops[i].before   the garment just before operation i ran
//   tip             the garment at the end of the timeline, saved when the
//                   first undo leaves it
//   position        how many operations are currently applied
//
// Undo and redo move the position and load one snapshot, however many steps
// they cover. A new operation recorded mid-timeline discards what was ahead.
//
// A .zpac drops fabrics that no pattern uses, so those are saved separately
// as .zfab files and added back after a restore.

import fs from "node:fs";
import path from "node:path";

import { STATE_FILE, exec, py } from "./bridge-client.js";

const DIR = path.join(path.dirname(STATE_FILE), "history");
const INDEX = path.join(DIR, "index.json");
const FABRICS = path.join(DIR, "fabrics");
const LIMIT = Math.max(2, parseInt(process.env.CLO_MCP_HISTORY_SIZE || "25", 10) || 25);
export const ENABLED = process.env.CLO_MCP_HISTORY !== "0";

function bridgePid() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")).pid ?? null;
  } catch {
    return null;
  }
}

function removeSnapshots(snapshots) {
  for (const snap of snapshots) if (snap?.file) fs.rmSync(snap.file, { force: true });
}

/** Load the history, discarding it when it belongs to an earlier CLO launch. */
function load() {
  let state = null;
  try {
    state = JSON.parse(fs.readFileSync(INDEX, "utf8"));
  } catch {
    /* no history yet */
  }
  const pid = bridgePid();
  if (!state || state.pid !== pid || !Array.isArray(state.ops)) {
    fs.rmSync(DIR, { recursive: true, force: true });
    state = { pid, seq: 0, ops: [], position: 0, tip: null };
  }
  return state;
}

function save(state) {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(INDEX, JSON.stringify(state, null, 1), { mode: 0o600 });
}

/** Save the current garment and return a description of the snapshot. */
async function snapshot(state) {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const file = path.join(DIR, `${String(++state.seq).padStart(5, "0")}.zpac`);
  const { result } = await exec(
    `
import hashlib
_n = pattern_api.GetPatternCount()
_file = None
_fabrics = []
# CLO writes nothing for an empty garment (and takes seconds to say so).
if _n > 0:
    export_api.ExportZPac(${py(file)})
    _file = ${py(file)} if os.path.exists(${py(file)}) else None
    if _file is None:
        raise RuntimeError("CLO did not write the undo snapshot")
    _used = set(fabric_api.GetFabricIndexForPattern(_i) for _i in range(_n))
    os.makedirs(${py(FABRICS)}, exist_ok=True)
    for _i, _name in enumerate(fabric_api.GetFabricStyleNameList()):
        _row = {"name": _name, "used": _i in _used}
        if _i not in _used:
            # Unchanged fabrics hash the same, so each is exported only once.
            _key = hashlib.md5((_name + "|" + fabric_api.GetFabricInfo(_i)).encode("utf-8", "replace")).hexdigest()
            _path = os.path.join(${py(FABRICS)}, _key + ".zfab")
            if not os.path.exists(_path):
                fabric_api.ExportZFab(_path, _i)
            _row["file"] = _path if os.path.exists(_path) else None
        _fabrics.append(_row)
result = {"file": _file, "patterns": _n, "project": utility_api.GetProjectName(), "fabrics": _fabrics}
`,
    { timeoutMs: 120_000 },
  );
  return result;
}

/** Replace the current garment with a snapshot. */
async function restore(snap) {
  if (snap.file && !fs.existsSync(snap.file)) throw new Error("That history snapshot is missing from disk.");
  const { result } = await exec(
    snap.file
      ? `
if not import_api.ImportFile(${py(snap.file)}):
    raise RuntimeError("CLO could not load the undo snapshot")
# Put back the fabrics the garment file left out because no pattern used them.
_saved = ${py(snap.fabrics ?? [])}
for _row in _saved:
    if not _row["used"] and _row.get("file") and os.path.exists(_row["file"]):
        _idx = fabric_api.AddFabric(_row["file"])
        fabric_api.SetFabricName(_idx, _row["name"])
_now = fabric_api.GetFabricStyleNameList()
result = {"patterns": pattern_api.GetPatternCount(), "seams": pattern_api.GetSeamlinePairGroupCount(), "fabrics": _now}
if _now != [_row["name"] for _row in _saved]:
    result["note"] = "Fabric indices changed; use the order in fabrics."
`
      : `
for _i in range(pattern_api.GetPatternCount() - 1, -1, -1):
    pattern_api.DeletePatternPiece(_i)
result = {"patterns": pattern_api.GetPatternCount(), "seams": pattern_api.GetSeamlinePairGroupCount(), "fabrics": fabric_api.GetFabricStyleNameList()}
`,
    { timeoutMs: 180_000 },
  );
  return result;
}

function describeArgs(args) {
  const text = JSON.stringify(args ?? {});
  return text.length > 90 ? text.slice(0, 87) + "..." : text;
}

/**
 * Record the state before a tool call that changes the project, or a
 * labelled checkpoint. Never throws: a failed snapshot must not stop the
 * tool from running.
 */
export async function record(tool, args, label) {
  if (!ENABLED) return;
  try {
    const state = load();
    const before = await snapshot(state);
    // A new change made after undoing replaces the undone future.
    removeSnapshots([...state.ops.splice(state.position).map((op) => op.before), state.tip]);
    state.tip = null;
    state.ops.push({ tool, args: describeArgs(args), label, time: new Date().toISOString(), before });
    while (state.ops.length > LIMIT) removeSnapshots([state.ops.shift().before]);
    state.position = state.ops.length;
    save(state);
  } catch {
    /* the bridge is down or busy; the tool call itself will report that */
  }
}

/** Drop the newest operation, for a tool call that turned out to change nothing. */
export function discardLast() {
  if (!ENABLED) return;
  try {
    const state = load();
    if (state.position !== state.ops.length || !state.ops.length) return;
    removeSnapshots([state.ops.pop().before]);
    state.position = state.ops.length;
    save(state);
  } catch {
    /* nothing to discard */
  }
}

async function move(direction, { steps = 1, toLabel, force = false }) {
  if (!ENABLED) throw new Error("Undo history is switched off (CLO_MCP_HISTORY=0).");
  const state = load();
  const back = direction === "undo";
  const available = back ? state.position : state.ops.length - state.position;
  if (!available) {
    throw new Error(back ? "Nothing to undo. No tool call has changed the garment in this CLO session." : "Nothing to redo. Redo is only available after an undo, until the next change.");
  }
  let target = back ? state.position - Math.min(steps, available) : state.position + Math.min(steps, available);
  if (toLabel !== undefined) {
    const at = state.ops.slice(0, state.position).map((op) => op.label).lastIndexOf(toLabel);
    if (at === -1) {
      const labels = state.ops.slice(0, state.position).map((op) => op.label).filter(Boolean);
      throw new Error(`No checkpoint labelled "${toLabel}" to go back to. Checkpoints: ${labels.length ? labels.join(", ") : "none"}.`);
    }
    target = at;
  }
  const atTip = state.position === state.ops.length;
  const goal = target === state.ops.length ? state.tip : state.ops[target].before;
  const { result: project } = await exec("utility_api.GetProjectName()", { timeoutMs: 15_000 });
  if (goal.project !== project && !force) {
    throw new Error(
      `That point in the history was recorded in project "${goal.project}", but CLO now has "${project}" open. ` +
        `Restoring would replace this project's garment. Pass force: true if that is what you want.`,
    );
  }
  // Leaving the end of the timeline: keep it, so redo can come back to it.
  if (back && atTip) {
    state.tip = await snapshot(state);
    save(state);
  }
  const now = await restore(goal);
  const crossed = back ? state.ops.slice(target, state.position).reverse() : state.ops.slice(state.position, target);
  state.position = target;
  save(state);
  return {
    [back ? "undone" : "redone"]: crossed.map((op) => (op.label ? `checkpoint "${op.label}"` : op.tool)),
    now,
    can_undo: state.position,
    can_redo: state.ops.length - state.position,
  };
}

export const undo = (options = {}) => move("undo", options);
export const redo = (options = {}) => move("redo", options);

export function list() {
  const state = load();
  const row = (op) => ({ ...(op.label ? { checkpoint: op.label } : { tool: op.tool, args: op.args }), time: op.time, patterns_before: op.before.patterns });
  return {
    enabled: ENABLED,
    undo: state.ops.slice(0, state.position).map(row).reverse(),
    redo: state.ops.slice(state.position).map(row),
    note: "undo[0] is the most recent change and redo[0] the next one to reapply. Undoing N steps restores the garment as it was before undo[N-1].",
  };
}
