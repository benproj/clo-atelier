#!/usr/bin/env node
// MCP server for CLO 3D.
//
// CLO only exposes its API to Python running inside the application, so this
// server forwards work to a small bridge script (bridge/clo_mcp_bridge.py)
// that the user runs from CLO's Python Script editor.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { loadApiIndex, searchApi } from "./api-index.js";
import { BRIDGE_LOADER, exec, py, request } from "./bridge-client.js";

const server = new McpServer(
  { name: "clo-atelier", version: "0.2.0" },
  {
    instructions: [
      "Controls a running CLO 3D session through its embedded Python API.",
      `The bridge script must be running inside CLO: the user opens Edit > Python Script, pastes ${BRIDGE_LOADER} and presses Run. Call clo_status first.`,
      "",
      "Conventions: patterns, lines, fabrics and colorways use zero-based indices. Lengths are millimetres. Pattern coordinates are absolute positions in the 2D window with Y pointing up. Outline line N runs from point N to point N+1.",
      "",
      "Building a garment: 1) clo_open_file an avatar (.avt) if the scene has none. 2) clo_create_patterns for all pieces in one call, each with its own area of the 2D window and an arrangement_point so it starts near the right body part. 3) clo_sew all seams in one call. 4) clo_add_fabric. 5) clo_simulate. 6) clo_screenshot with several views, including 2d-patterns, to check the result.",
      "Sewing direction: two sewn lines must run the same way along the seam. If a seam is twisted after simulation, flip direction_b on that seam.",
      "",
      "Anything the dedicated tools do not cover: clo_search_api to find the function, then clo_execute_python to call it.",
      "CLO's API has no undo; export a .zprj before destructive edits. Some API calls open dialogs in CLO, which block every further request until the user closes them; pass an ApiTypes options struct where an overload takes one to avoid the dialog.",
    ].join("\n"),
  },
);

// ---------------------------------------------------------------- helpers

function text(value) {
  return { type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) };
}

function formatExec({ result, stdout }) {
  const parts = [];
  if (result !== null && result !== undefined) parts.push(typeof result === "string" ? result : JSON.stringify(result, null, 2));
  if (stdout && stdout.trim()) parts.push(`stdout:\n${stdout.trimEnd()}`);
  return parts.join("\n\n") || "OK (no return value)";
}

/** Wrap a tool handler so failures come back as readable tool errors. */
function tool(handler) {
  return async (args) => {
    try {
      const out = await handler(args ?? {});
      if (out && Array.isArray(out.content)) return out;
      return { content: [text(out)] };
    } catch (err) {
      const stdout = err.stdout && err.stdout.trim() ? `\n\nstdout before the error:\n${err.stdout.trimEnd()}` : "";
      return { content: [text(`${err.message}${stdout}`)], isError: true };
    }
  };
}

async function run(code, opts) {
  return formatExec(await exec(code, opts));
}

const idx = (what) => z.number().int().min(0).describe(`Zero-based ${what} index.`);

const timeoutArg = z
  .number()
  .int()
  .min(1)
  .max(3600)
  .optional()
  .describe("Seconds to wait for CLO before giving up.");

const ms = (seconds, fallback = 120) => (seconds ?? fallback) * 1000;

function tmpFile(suffix) {
  return path.join(os.tmpdir(), `clo-mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${suffix}`);
}

function requireFile(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
}

/** Read an image for an inline result, shrinking it first if it is large. */
function imageContent(file) {
  let imagePath = file;
  if (process.platform === "darwin" && fs.statSync(file).size > 1_200_000) {
    const small = tmpFile(".png");
    try {
      execFileSync("/usr/bin/sips", ["-Z", "1568", file, "--out", small], { stdio: "ignore" });
      imagePath = small;
    } catch {
      /* fall back to the original */
    }
  }
  const data = fs.readFileSync(imagePath);
  const mimeType = data[0] === 0xff && data[1] === 0xd8 ? "image/jpeg" : "image/png";
  return { type: "image", data: data.toString("base64"), mimeType };
}

// Shared Python helpers, prepended to the requests that need them.
const PRELUDE = `
def _t(fn, default=None):
    try:
        return fn()
    except Exception as exc:
        return default if default is not None else "unavailable: %s" % (exc,)

def _j(s):
    try:
        return json.loads(s)
    except Exception:
        return s

def _geometry(p):
    info = _j(pattern_api.GetPatternInputInformation(p))["Pattern InputInformation"][0]
    points = [[pt["Point positionX"], pt["Point positionY"]] for pt in info["PointList"] if "Point index" in pt]
    lines = [{"index": int(ln["Line index"]), "length": round(ln["Line length"], 2), "curved": ln["Line type"] != "Straight type"} for ln in info["LineList"] if "Line index" in ln]
    return {"points": points, "lines": lines}

def _fabric_count():
    # GetFabricCount(True) under-reports; the style list has one entry per fabric.
    try:
        return len(fabric_api.GetFabricStyleNameList())
    except Exception:
        return fabric_api.GetFabricCount(False)

def _arrangement_index(name_or_index):
    if isinstance(name_or_index, int):
        return name_or_index
    pts = pattern_api.GetArrangementList()
    for i, pt in enumerate(pts):
        if pt.get("ArrangementName", "").lower() == name_or_index.lower():
            return i
    raise ValueError("No arrangement point named %r. The scene has %d arrangement points; an avatar must be loaded, and clo_list_arrangement_points shows the names." % (name_or_index, len(pts)))
`;

const arrangementArg = z
  .union([z.number().int().min(0), z.string()])
  .describe('Arrangement point on the avatar, by name (e.g. "Body_Front_Center_2", "Leg_Skirt_Back", "Arm_Outside_1_L") or index. See clo_list_arrangement_points.');

// ------------------------------------------------------------ inspection

server.registerTool(
  "clo_status",
  {
    title: "CLO status",
    description:
      "Check that CLO is running with the bridge loaded. Returns CLO version, open project, and counts of patterns, fabrics, colorways and avatars. Call this first.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  tool(async () => {
    const ping = await request({ op: "ping" }, { timeoutMs: 5000 });
    if (!ping.ok) throw new Error(ping.error || "bridge ping failed");
    const { result } = await exec(
      PRELUDE +
        `
result = {
    "clo_version": _t(lambda: "%d.%d.%d" % (utility_api.GetMajorVersion(), utility_api.GetMinorVersion(), utility_api.GetPatchVersion())),
    "project_name": _t(lambda: utility_api.GetProjectName()),
    "project_path": _t(lambda: utility_api.GetProjectFilePath()),
    "pattern_count": _t(lambda: pattern_api.GetPatternCount()),
    "fabric_count": _t(lambda: _fabric_count()),
    "colorway_count": _t(lambda: utility_api.GetColorwayCount()),
    "avatar_count": _t(lambda: export_api.GetAvatarCount()),
}
`,
      { timeoutMs: 20_000 },
    );
    return { bridge: ping.result, clo: result };
  }),
);

server.registerTool(
  "clo_get_scene",
  {
    title: "Describe the CLO scene",
    description:
      "Summarise the open project in one call: every pattern piece (index, name, fabric, centre position, size, arrangement point, seam groups), fabrics, colorways, avatars and simulation quality. Use clo_get_patterns for outline points and line indices.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  tool(() =>
    run(
      PRELUDE +
        `
_n = _t(lambda: pattern_api.GetPatternCount(), 0) or 0
_patterns = []
for _i in range(_n):
    _box = _t(lambda: pattern_api.GetBoundingBoxOfPattern(_i), {})
    _patterns.append({
        "index": _i,
        "name": _t(lambda: pattern_api.GetPatternPieceName(_i)),
        "fabric_index": _t(lambda: fabric_api.GetFabricIndexForPattern(_i)),
        "center": _t(lambda: pattern_api.GetPatternPiecePos(_i)),
        "width": _t(lambda: round(float(_box["Width"]), 1)),
        "height": _t(lambda: round(float(_box["Height"]), 1)),
        "arrangement": _t(lambda: pattern_api.GetArrangementOfPattern(_i).get("ArrangementName")),
        "seam_groups": _t(lambda: pattern_api.GetSeamlinePairGroupListInPattern(_i)),
    })
_fn = _t(lambda: _fabric_count(), 0) or 0
_cn = _t(lambda: utility_api.GetColorwayCount(), 0) or 0
result = {
    "project_name": _t(lambda: utility_api.GetProjectName()),
    "project_path": _t(lambda: utility_api.GetProjectFilePath()),
    "patterns": _patterns,
    "seam_group_count": _t(lambda: pattern_api.GetSeamlinePairGroupCount()),
    "fabrics": [{"index": _i, "name": _t(lambda: fabric_api.GetFabricName(_i))} for _i in range(_fn)],
    "colorways": {
        "current": _t(lambda: utility_api.GetCurrentColorwayIndex()),
        "names": [_t(lambda: utility_api.GetColorwayName(_i)) for _i in range(_cn)],
    },
    "avatars": _t(lambda: export_api.GetAvatarNameList()),
    "simulation_quality": _t(lambda: utility_api.GetSimulationQuality()),
}
`,
      { timeoutMs: 60_000 },
    ),
  ),
);

server.registerTool(
  "clo_get_patterns",
  {
    title: "Get pattern geometry",
    description:
      "Outline geometry for one or more pattern pieces: points (mm), outline lines with index, length and whether curved, plus fabric, grain, layer, mesh particle distance, arrangement and seam groups. Use it to find line indices and matching lengths before sewing. Omit pattern_indices for every piece.",
    inputSchema: {
      pattern_indices: z.array(idx("pattern")).optional().describe("Pieces to describe. Omit for all pieces."),
    },
    annotations: { readOnlyHint: true },
  },
  tool(({ pattern_indices }) =>
    run(
      PRELUDE +
        `
_want = ${py(pattern_indices ?? null)}
if _want is None:
    _want = list(range(pattern_api.GetPatternCount()))
result = []
for _p in _want:
    _g = _t(lambda: _geometry(_p), {})
    result.append({
        "index": _p,
        "name": _t(lambda: pattern_api.GetPatternPieceName(_p)),
        "points": _g.get("points") if isinstance(_g, dict) else _g,
        "lines": _g.get("lines") if isinstance(_g, dict) else None,
        "center": _t(lambda: pattern_api.GetPatternPiecePos(_p)),
        "fabric_index": _t(lambda: fabric_api.GetFabricIndexForPattern(_p)),
        "grain_direction": _t(lambda: pattern_api.GetPatternPieceGrainDirection(_p)),
        "layer": _t(lambda: pattern_api.GetPatternLayer(_p)),
        "particle_distance": _t(lambda: pattern_api.GetParticleDistanceOfPattern(_p)),
        "arrangement": _t(lambda: pattern_api.GetArrangementOfPattern(_p)),
        "seam_groups": _t(lambda: pattern_api.GetSeamlinePairGroupListInPattern(_p)),
    })
`,
      { timeoutMs: 60_000 },
    ),
  ),
);

server.registerTool(
  "clo_list_arrangement_points",
  {
    title: "List avatar arrangement points",
    description:
      "List the arrangement points around the loaded avatar (index and name), which place pattern pieces near a body part before simulation. Returns nothing if no avatar is loaded.",
    inputSchema: {
      filter: z.string().optional().describe('Only names containing this text, case-insensitive, e.g. "skirt", "arm", "body_front".'),
    },
    annotations: { readOnlyHint: true },
  },
  tool(({ filter }) =>
    run(`
_f = ${py((filter ?? "").toLowerCase())}
_pts = pattern_api.GetArrangementList()
_rows = ["%d: %s" % (i, p.get("ArrangementName", "?")) for i, p in enumerate(_pts) if _f in p.get("ArrangementName", "").lower()]
result = "\\n".join(_rows) if _rows else ("No arrangement points match." if _pts else "No arrangement points: load an avatar first.")
`),
  ),
);

// ----------------------------------------------------------- patterns

const pointSchema = z.object({
  x: z.number().describe("X in mm."),
  y: z.number().describe("Y in mm (up)."),
  type: z
    .enum(["straight", "spline", "bezier"])
    .optional()
    .describe("Vertex type (default straight). Spline points make the outline curve smoothly through them."),
});
const VERTEX_TYPE = { straight: 0, spline: 2, bezier: 3 };
const pyPoints = (points) => "[" + points.map((p) => `(${py(p.x)}, ${py(p.y)}, ${VERTEX_TYPE[p.type ?? "straight"]})`).join(", ") + "]";

server.registerTool(
  "clo_create_patterns",
  {
    title: "Create pattern pieces",
    description:
      "Draw one or more new pattern pieces from ordered outline points (each outline closes back to its first point). Create all pieces of a garment in one call. Coordinates are absolute positions in the 2D window, so give each piece its own area or they overlap. Returns each new piece's index and its outline lines (index, length), ready for clo_sew.",
    inputSchema: {
      patterns: z
        .array(
          z.object({
            name: z.string().optional().describe("Name for the piece."),
            points: z.array(pointSchema).min(3).describe("Outline vertices in drawing order."),
            fabric_index: idx("fabric").optional(),
            arrangement_point: arrangementArg.optional(),
            layer: z.number().int().optional().describe("Collision layer; higher layers sit outside lower ones (default 0)."),
          }),
        )
        .min(1),
    },
  },
  tool(({ patterns }) =>
    run(
      PRELUDE +
        `
_specs = ${py(patterns.map((p) => ({ name: p.name ?? null, fabric: p.fabric_index ?? null, arr: p.arrangement_point ?? null, layer: p.layer ?? null })))}
_outlines = [${patterns.map((p) => pyPoints(p.points)).join(", ")}]
result = []
for _spec, _pts in zip(_specs, _outlines):
    _i = pattern_api.CreatePatternWithPoints(_pts)
    _row = {"index": _i}
    if _spec["name"] is not None:
        pattern_api.SetPatternPieceName(_i, _spec["name"])
        _row["name"] = _spec["name"]
    if _spec["fabric"] is not None:
        pattern_api.SetPatternPieceFabricIndex(_i, _spec["fabric"])
    if _spec["layer"] is not None:
        pattern_api.SetPatternLayer(_i, _spec["layer"])
    if _spec["arr"] is not None:
        try:
            pattern_api.SetArrangement(_i, _arrangement_index(_spec["arr"]))
            _row["arrangement"] = pattern_api.GetArrangementOfPattern(_i).get("ArrangementName")
        except Exception as exc:
            _row["arrangement_error"] = str(exc)
    _row["lines"] = _t(lambda: _geometry(_i)["lines"])
    result.append(_row)
`,
      { timeoutMs: 60_000 },
    ),
  ),
);

server.registerTool(
  "clo_add_internal_shape",
  {
    title: "Add an internal line or shape",
    description:
      "Draw an internal line or closed internal shape (dart, fold line, pocket placement, cut-out guide) inside an existing pattern piece.",
    inputSchema: {
      pattern_index: idx("pattern"),
      points: z.array(pointSchema).min(2).describe("Vertices of the internal line, in the same coordinates as the pattern outline."),
      closed: z.boolean().optional().describe("Join the last point back to the first (default false)."),
    },
  },
  tool(({ pattern_index, points, closed }) =>
    run(`pattern_api.CreateInternalShapeWithPoints(${py(pattern_index)}, ${pyPoints(points)}, ${py(closed ?? false)})`),
  ),
);

server.registerTool(
  "clo_edit_pattern",
  {
    title: "Edit a pattern piece",
    description:
      "Change properties of an existing pattern piece. Set only the fields you want changed: rename, move in the 2D window, flip, re-place on the avatar, change fabric, layer, grain, mesh density, or freeze/hide it in 3D.",
    inputSchema: {
      pattern_index: idx("pattern"),
      name: z.string().optional(),
      center: z.object({ x: z.number(), y: z.number() }).optional().describe("Move the piece so its centre is here in the 2D window (mm)."),
      flip: z.enum(["horizontal", "vertical"]).optional().describe("Mirror the piece in place."),
      arrangement_point: arrangementArg.optional(),
      fabric_index: idx("fabric").optional(),
      layer: z.number().int().optional().describe("Collision layer; higher layers sit outside lower ones."),
      grain_direction: z.number().optional().describe("Grain line angle in degrees."),
      particle_distance: z.number().min(1).optional().describe("Mesh resolution in mm (default 20; smaller is finer and slower)."),
      freeze: z.boolean().optional().describe("Freeze the piece so simulation does not move it."),
      hide_3d: z.boolean().optional().describe("Hide the piece in the 3D window."),
    },
  },
  tool((a) => {
    const p = py(a.pattern_index);
    const steps = [];
    if (a.name !== undefined) steps.push(`pattern_api.SetPatternPieceName(${p}, ${py(a.name)})`);
    if (a.center) steps.push(`pattern_api.SetPatternPiecePos(${p}, ${py(a.center.x)}, ${py(a.center.y)})`);
    if (a.flip) steps.push(`pattern_api.FlipPatternPiece(${p}, ${py(a.flip === "horizontal")}, True)`);
    if (a.fabric_index !== undefined) steps.push(`pattern_api.SetPatternPieceFabricIndex(${p}, ${py(a.fabric_index)})`);
    if (a.layer !== undefined) steps.push(`pattern_api.SetPatternLayer(${p}, ${py(a.layer)})`);
    if (a.grain_direction !== undefined) steps.push(`pattern_api.SetPatternPieceGrainDirection(${p}, ${py(a.grain_direction)})`);
    if (a.particle_distance !== undefined) steps.push(`pattern_api.SetParticleDistanceOfPattern(${p}, ${py(a.particle_distance)})`);
    if (a.freeze !== undefined) steps.push(`pattern_api.SetPatternFreeze(${p}, ${py(a.freeze)})`);
    if (a.hide_3d !== undefined) steps.push(`pattern_api.SetPatternHide3D(${p}, ${py(a.hide_3d)})`);
    if (a.arrangement_point !== undefined) steps.push(`pattern_api.SetArrangement(${p}, _arrangement_index(${py(a.arrangement_point)}))`);
    if (!steps.length) throw new Error("Nothing to change: set at least one field besides pattern_index.");
    return run(
      PRELUDE +
        `
if not 0 <= ${p} < pattern_api.GetPatternCount():
    raise IndexError("No pattern with index %d (the project has %d)." % (${p}, pattern_api.GetPatternCount()))
${steps.join("\n")}
result = {
    "index": ${p},
    "name": _t(lambda: pattern_api.GetPatternPieceName(${p})),
    "center": _t(lambda: pattern_api.GetPatternPiecePos(${p})),
    "fabric_index": _t(lambda: fabric_api.GetFabricIndexForPattern(${p})),
    "layer": _t(lambda: pattern_api.GetPatternLayer(${p})),
    "arrangement": _t(lambda: pattern_api.GetArrangementOfPattern(${p}).get("ArrangementName")),
}
`,
    );
  }),
);

server.registerTool(
  "clo_copy_pattern",
  {
    title: "Copy a pattern piece",
    description:
      "Duplicate a pattern piece, placing the copy's centre at a position in the 2D window. Optionally mirror the copy, e.g. to make a right sleeve from a left one. Returns the new piece's index.",
    inputSchema: {
      pattern_index: idx("pattern"),
      center: z.object({ x: z.number(), y: z.number() }).describe("Centre of the copy in the 2D window (mm)."),
      flip: z.enum(["horizontal", "vertical"]).optional().describe("Mirror the copy."),
      name: z.string().optional().describe("Name for the copy."),
    },
  },
  tool(({ pattern_index, center, flip, name }) =>
    run(`
_before = pattern_api.GetPatternCount()
_ret = pattern_api.CopyPatternPiecePos(${py(pattern_index)}, ${py(center.x)}, ${py(center.y)})
_after = pattern_api.GetPatternCount()
if _after <= _before:
    raise RuntimeError("CLO did not create a copy.")
_new = _after - 1
${flip ? `pattern_api.FlipPatternPiece(_new, ${py(flip === "horizontal")}, True)` : ""}
${name !== undefined ? `pattern_api.SetPatternPieceName(_new, ${py(name)})` : ""}
result = {"pattern_index": _new, "name": pattern_api.GetPatternPieceName(_new), "pattern_count": _after}
`),
  ),
);

server.registerTool(
  "clo_delete_patterns",
  {
    title: "Delete pattern pieces",
    description:
      "Delete pattern pieces, along with their seams. Cannot be undone. Remaining pieces are renumbered, so re-read indices with clo_get_scene afterwards.",
    inputSchema: { pattern_indices: z.array(idx("pattern")).min(1) },
    annotations: { destructiveHint: true },
  },
  tool(({ pattern_indices }) =>
    run(`
_n = pattern_api.GetPatternCount()
_del = sorted(set(${py(pattern_indices)}), reverse=True)
_bad = [i for i in _del if i >= _n]
if _bad:
    raise IndexError("No pattern with index %s (the project has %d)." % (_bad, _n))
_names = [pattern_api.GetPatternPieceName(i) for i in _del]
for _i in _del:
    pattern_api.DeletePatternPiece(_i)
result = {"deleted": _names, "pattern_count": pattern_api.GetPatternCount()}
`),
  ),
);

server.registerTool(
  "clo_sew",
  {
    title: "Sew pattern lines together",
    description:
      "Create seams, each joining an outline line on one piece to an outline line on another (or the same) piece. Pass every seam of the garment in one call. Get line indices from clo_create_patterns or clo_get_patterns. The two lines are joined start-to-start by default; set direction_b false when line B runs the opposite way along the seam, otherwise the seam twists.",
    inputSchema: {
      seams: z
        .array(
          z.object({
            pattern_a: idx("pattern"),
            line_a: idx("line"),
            pattern_b: idx("pattern"),
            line_b: idx("line"),
            direction_a: z.boolean().optional().describe("Sew line A forward (default true)."),
            direction_b: z.boolean().optional().describe("Sew line B forward (default true)."),
          }),
        )
        .min(1),
    },
  },
  tool(({ seams }) =>
    run(`
_seams = ${py(seams.map((s) => [s.pattern_a, s.line_a, s.pattern_b, s.line_b, s.direction_a ?? true, s.direction_b ?? true]))}
result = {"seams": [], "seam_group_count": 0}
for _s in _seams:
    _row = {"a": [_s[0], _s[1]], "b": [_s[2], _s[3]]}
    try:
        _row["sewn"] = pattern_api.AddSeamlinePairGroup(*_s)
        _la, _lb = pattern_api.GetLineLength(_s[0], _s[1]), pattern_api.GetLineLength(_s[2], _s[3])
        if _la and _lb and abs(_la - _lb) / max(_la, _lb) > 0.05:
            _row["length_mismatch_mm"] = [round(_la, 1), round(_lb, 1)]
    except Exception as exc:
        _row["sewn"] = False
        _row["error"] = str(exc)
    result["seams"].append(_row)
result["seam_group_count"] = pattern_api.GetSeamlinePairGroupCount()
`),
  ),
);

// ---------------------------------------------------- simulate and look

const QUALITY = { normal: [0, 0], animation: [1, 0], fitting: [2, 0], "fast-gpu": [3, 1] };

server.registerTool(
  "clo_simulate",
  {
    title: "Run the drape simulation",
    description:
      "Simulate the garment for a number of steps. CLO is busy until it finishes; follow with clo_screenshot to see the result. Around 100-200 steps settles a simple garment.",
    inputSchema: {
      steps: z.number().int().min(1).max(5000).optional().describe("Simulation frames to run (default 100)."),
      quality: z
        .enum(Object.keys(QUALITY))
        .optional()
        .describe("Switch the project's simulation preset first: normal, animation (stable), fitting (accurate fabric, slow) or fast-gpu. Leave unset to keep the current one."),
      reset_arrangement: z.boolean().optional().describe("Put all pieces back at their arrangement positions before simulating, to recover from a tangled drape."),
      timeout_s: timeoutArg,
    },
  },
  tool(({ steps, quality, reset_arrangement, timeout_s }) =>
    run(
      `
import time as _time
${quality ? `utility_api.SetSimulationQuality(${QUALITY[quality][0]}, ${QUALITY[quality][1]})` : ""}
${reset_arrangement ? "utility_api.ResetClothArrangement()" : ""}
_t0 = _time.time()
_ok = utility_api.Simulate(${py(steps ?? 100)})
result = {"simulated": _ok, "steps": ${py(steps ?? 100)}, "seconds": round(_time.time() - _t0, 2)}
`,
      { timeoutMs: ms(timeout_s, 900) },
    ),
  ),
);

const VIEWS = { front: 2, back: 8, left: 6, right: 4, "three-quarter-left": 3, "three-quarter-right": 1, top: 5, bottom: 0 };
const VIEW_NAMES = ["current", ...Object.keys(VIEWS), "2d-patterns"];

server.registerTool(
  "clo_screenshot",
  {
    title: "Look at the garment",
    description:
      "Capture images of the scene so you can see it. Ask for several views in one call. 3D views other than `current` move the user's camera. `2d-patterns` is a flat layout of the pattern pieces as drawn in the 2D window; the number labels restart for each fabric and are not pattern indices.",
    inputSchema: {
      views: z.array(z.enum(VIEW_NAMES)).min(1).max(6).optional().describe("Views to capture (default: current)."),
      save_dir: z.string().optional().describe("Folder to keep the images in. Defaults to a temporary folder."),
    },
    annotations: { readOnlyHint: true },
  },
  tool(async ({ views, save_dir }) => {
    const list = [...new Set(views ?? ["current"])];
    const dir = save_dir || fs.mkdtempSync(path.join(os.tmpdir(), "clo-mcp-shot-"));
    if (!fs.existsSync(dir)) throw new Error(`Folder does not exist: ${dir}`);
    const jobs = list.map((view) => ({ view, file: path.join(dir, `${view}.png`), cam: VIEWS[view] ?? null }));
    const { result } = await exec(
      `
_out = {}
for _job in ${py(jobs)}:
    try:
        if _job["view"] == "2d-patterns":
            _opt = ApiTypes.ExportTechpackOption()
            for _n in dir(_opt):
                if _n.startswith("m_b"):
                    setattr(_opt, _n, False)
            _opt.m_bCapturePatternLayoutThumbnail = True
            _tp = os.path.join(os.path.dirname(_job["file"]), "_techpack")
            os.makedirs(_tp, exist_ok=True)
            export_api.ExportTechPack(os.path.join(_tp, "techpack.json"), _opt)
            _src = os.path.join(_tp, "patternLayoutThumbnail.png")
            if os.path.exists(_src):
                os.replace(_src, _job["file"])
                _out[_job["view"]] = _job["file"]
            else:
                _out[_job["view"]] = "error: CLO produced no pattern layout image (no patterns?)"
        else:
            if _job["cam"] is not None:
                utility_api.SetCamViewPoint(_job["cam"])
                utility_api.Refresh3DWindow()
            _out[_job["view"]] = export_api.ExportThumbnail3D(_job["file"]) or "error: CLO did not write an image"
    except Exception as exc:
        _out[_job["view"]] = "error: %s" % (exc,)
result = _out
`,
      { timeoutMs: 120_000 },
    );
    const content = [];
    for (const { view } of jobs) {
      const saved = result?.[view];
      if (typeof saved === "string" && !saved.startsWith("error:") && fs.existsSync(saved)) {
        content.push(text(`${view}: ${saved}`), imageContent(saved));
      } else {
        content.push(text(`${view}: ${saved ?? "no result"}`));
      }
    }
    return { content, isError: !content.some((c) => c.type === "image") };
  }),
);

// ------------------------------------------------------------ fabrics

function parseColor(color) {
  const m = /^#?([0-9a-f]{6})$/i.exec(color.trim());
  if (!m) throw new Error(`Colour must be a hex value like "#1A2B3C" (got ${JSON.stringify(color)}).`);
  return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255);
}

server.registerTool(
  "clo_add_fabric",
  {
    title: "Add a fabric",
    description:
      "Load a fabric file (.zfab, .jfab) into the project's fabric list and optionally assign it to pattern pieces. CLO's bundled fabrics are in ~/Documents/clo/CLO Assets/Fabric (denim, jersey knits, organza, velvet, ...).",
    inputSchema: {
      file_path: z.string().describe("Absolute path to the fabric file."),
      assign_to_patterns: z
        .union([z.array(idx("pattern")), z.literal("all")])
        .optional()
        .describe('Pattern indices to give this fabric to, or "all".'),
    },
  },
  tool(({ file_path, assign_to_patterns }) => {
    requireFile(file_path);
    return run(`
_f = fabric_api.AddFabric(${py(file_path)})
_targets = ${py(assign_to_patterns ?? [])}
if _targets == "all":
    _targets = list(range(pattern_api.GetPatternCount()))
_failed = [p for p in _targets if not fabric_api.AssignFabricToPattern(_f, p, 3)]
result = {"fabric_index": _f, "fabric_name": fabric_api.GetFabricName(_f), "assigned_to": [p for p in _targets if p not in _failed], "failed": _failed}
`);
  }),
);

server.registerTool(
  "clo_assign_fabric",
  {
    title: "Assign a fabric to patterns",
    description: "Apply a fabric already in the project to pattern pieces.",
    inputSchema: {
      fabric_index: idx("fabric"),
      pattern_indices: z.union([z.array(idx("pattern")).min(1), z.literal("all")]).describe('Pattern indices, or "all".'),
      scope: z
        .enum(["current-colorway", "all-colorways-unlinked", "all-colorways-linked"])
        .optional()
        .describe("Which colorways receive the change (default all-colorways-linked)."),
    },
  },
  tool(({ fabric_index, pattern_indices, scope }) => {
    const option = { "current-colorway": 1, "all-colorways-unlinked": 2, "all-colorways-linked": 3 }[scope ?? "all-colorways-linked"];
    return run(`
_targets = ${py(pattern_indices)}
if _targets == "all":
    _targets = list(range(pattern_api.GetPatternCount()))
_failed = [p for p in _targets if not fabric_api.AssignFabricToPattern(${py(fabric_index)}, p, ${option})]
result = {"fabric_index": ${py(fabric_index)}, "assigned_to": [p for p in _targets if p not in _failed], "failed": _failed}
`);
  }),
);

server.registerTool(
  "clo_get_fabric",
  {
    title: "Get fabric details",
    description: "Properties of one fabric in the project: name, material and physical information, width, base colour and texture paths.",
    inputSchema: { fabric_index: idx("fabric") },
    annotations: { readOnlyHint: true },
  },
  tool(({ fabric_index }) =>
    run(
      PRELUDE +
        `
_f = ${py(fabric_index)}
def _hex(c):
    return "#%02X%02X%02X" % tuple(int(round(v * 255)) for v in c[:3])
result = {
    "index": _f,
    "name": _t(lambda: fabric_api.GetFabricName(_f)),
    "information": _t(lambda: fabric_api.GetFabricInformation(_f)),
    "width_mm": _t(lambda: round(fabric_api.GetFabricWidth(_f), 1)),
    "front_base_color": _t(lambda: _hex(fabric_api.GetFabricPBRMaterialBaseColor(_f, 0))),
    "base_texture": _t(lambda: fabric_api.GetBaseTextureMapImageFilePath(_f)),
    "normal_map": _t(lambda: fabric_api.GetNormalMapImageFilePath(_f)),
    "used_by_patterns": _t(lambda: [i for i in range(pattern_api.GetPatternCount()) if fabric_api.GetFabricIndexForPattern(i) == _f]),
}
`,
    ),
  ),
);

server.registerTool(
  "clo_edit_fabric",
  {
    title: "Edit a fabric",
    description:
      "Change a fabric in the project: rename it, set its base colour (tints any texture), or replace it with a different fabric file while keeping its assignments. Set only the fields you want changed.",
    inputSchema: {
      fabric_index: idx("fabric"),
      name: z.string().optional(),
      color: z.string().optional().describe('Base colour as hex, e.g. "#C0392B". Applied to front, back and side.'),
      replace_with_file: z.string().optional().describe("Absolute path of a .zfab file to replace this fabric with."),
    },
  },
  tool(({ fabric_index, name, color, replace_with_file }) => {
    const f = py(fabric_index);
    const steps = [];
    if (replace_with_file !== undefined) {
      requireFile(replace_with_file);
      steps.push(`_changes["replaced"] = fabric_api.ReplaceFabric(${f}, ${py(replace_with_file)})`);
    }
    if (color !== undefined) {
      const [r, g, b] = parseColor(color);
      steps.push(`_changes["colored"] = all([fabric_api.SetFabricPBRMaterialBaseColor(${f}, face, ${r}, ${g}, ${b}, 1.0) for face in (0, 1, 2)])`);
    }
    if (name !== undefined) steps.push(`fabric_api.SetFabricName(${f}, ${py(name)})`);
    if (!steps.length) throw new Error("Nothing to change: set name, color or replace_with_file.");
    return run(
      PRELUDE +
        `
if not 0 <= ${f} < _fabric_count():
    raise IndexError("No fabric with index %d (the project has %d)." % (${f}, _fabric_count()))
_changes = {}
${steps.join("\n")}
utility_api.Refresh3DWindow()
result = dict(_changes, fabric_index=${f}, name=fabric_api.GetFabricName(${f}))
`,
    );
  }),
);

server.registerTool(
  "clo_colorways",
  {
    title: "List or change colorways",
    description:
      "List the project's colorways, and optionally add one by copying, rename one, or switch the active one. With no arguments it only lists. Operations run in the order copy, rename, switch.",
    inputSchema: {
      copy_from: idx("colorway").optional().describe("Create a new colorway as an unlinked copy of this one."),
      rename: z.object({ index: idx("colorway"), name: z.string() }).optional(),
      switch_to: idx("colorway").optional().describe("Make this the active colorway."),
    },
  },
  tool(({ copy_from, rename, switch_to }) =>
    run(`
_new = None
${copy_from !== undefined ? `_new = utility_api.CopyColorway(${py(copy_from)}, 0)` : ""}
${rename ? `utility_api.SetColorwayName(${py(rename.index)}, ${py(rename.name)})` : ""}
${switch_to !== undefined ? `utility_api.SetCurrentColorwayIndex(${py(switch_to)})` : ""}
${copy_from !== undefined || rename || switch_to !== undefined ? "utility_api.UpdateColorways(True)" : ""}
result = {
    "current": utility_api.GetCurrentColorwayIndex(),
    "colorways": [utility_api.GetColorwayName(i) for i in range(utility_api.GetColorwayCount())],
}
if _new is not None:
    result["created_index"] = _new
`),
  ),
);

// ------------------------------------------------------------- files

server.registerTool(
  "clo_new_project",
  {
    title: "Start a new project",
    description: "Clear the current garment and start a new one. Unsaved work is lost; export a .zprj first if it matters.",
    inputSchema: {},
    annotations: { destructiveHint: true },
  },
  tool(() =>
    run(`
utility_api.NewProject()
result = {"pattern_count": pattern_api.GetPatternCount(), "avatar_count": export_api.GetAvatarCount()}
`),
  ),
);

server.registerTool(
  "clo_open_file",
  {
    title: "Open or import a file",
    description:
      "Open a file in CLO by path. A project (.zprj) replaces the current scene, discarding unsaved work. Avatars (.avt), garments (.zpac), fabrics (.zfab), DXF patterns, OBJ/FBX/glTF meshes and other supported formats are added to it using CLO's defaults. Bundled avatars are in ~/Documents/clo/CLO Assets/Avatar.",
    inputSchema: {
      file_path: z.string().describe("Absolute path of the file to open."),
      add_to_scene: z.boolean().optional().describe("For .zprj only: add the project's contents to the current scene instead of replacing it (default false)."),
      timeout_s: timeoutArg,
    },
  },
  tool(({ file_path, add_to_scene, timeout_s }) => {
    requireFile(file_path);
    return run(
      `
_path = ${py(file_path)}
_ext = os.path.splitext(_path)[1].lower()
# These two formats open an options dialog unless given an options struct.
if _ext == ".zprj":
    _o = ApiTypes.ImportZPRJOption()
    _o.bAppend = ${py(add_to_scene ?? false)}
    _o.bLoadGarment = True
    _o.bLoadAvatar = True
    _o.bLoadSceneAndProps = True
    _o.bLoadRenderProperties = True
    _o.bLoadCustomView = True
    _ok = import_api.ImportZprj(_path, _o)
elif _ext == ".dxf":
    _o = ApiTypes.ImportDxfOption()
    _o.m_bAppend = True
    _ok = import_api.ImportDXF(_path, _o)
else:
    _ok = import_api.ImportFile(_path)
result = {"imported": _ok, "project_name": utility_api.GetProjectName(), "pattern_count": pattern_api.GetPatternCount(), "avatar_count": export_api.GetAvatarCount()}
`,
      { timeoutMs: ms(timeout_s, 300) },
    );
  }),
);

// Mesh formats take an options struct, which also stops CLO opening a dialog.
const meshOptions = (includeAvatar) => `
_o = ApiTypes.ImportExportOption()
_o.bExportGarment = True
_o.bExportAvatar = ${py(includeAvatar)}
`;
const EXPORTERS = {
  zprj: { code: (p) => `_out = export_api.ExportZPrj(${p}, True)` },
  zpac: { code: (p) => `_out = export_api.ExportZPac(${p})` },
  obj: { mesh: true, code: (p) => `_out = export_api.ExportOBJ(${p}, _o)` },
  fbx: { mesh: true, code: (p) => `_out = export_api.ExportFBX(${p}, _o)` },
  glb: { mesh: true, code: (p) => `_out = export_api.ExportGLB(${p}, _o)` },
  gltf: { mesh: true, code: (p) => `_out = export_api.ExportGLTF(${p}, _o, False)` },
  dxf: { code: (p) => `_out = export_api.ExportDXF(${p}, ApiTypes.ExportDxfOption())` },
  "pattern-json": { code: (p) => `_out = pattern_api.ExportPatternJSON(${p})` },
  techpack: { code: (p) => `export_api.ExportTechPack(${p}, ApiTypes.ExportTechpackOption())\n_out = ${p}` },
  turntable: { code: (p, a) => `_out = export_api.ExportTurntableImages(${p}, ${py(a.turntable_images ?? 8)}, 1000, 1500)` },
  avatar: { code: (p) => `_out = export_api.ExportAVT(${p})` },
};

server.registerTool(
  "clo_export",
  {
    title: "Save or export the project",
    description:
      "Write the current work to disk, overwriting any file at that path. zprj saves the whole project; zpac the garment only; obj/fbx/glb/gltf the 3D mesh; dxf the 2D patterns; pattern-json CLO's pattern data; techpack a .json with images alongside; turntable a rotating image sequence (give a .png path); avatar an .avt.",
    inputSchema: {
      format: z.enum(Object.keys(EXPORTERS)),
      file_path: z.string().describe("Absolute output path, including the extension."),
      include_avatar: z.boolean().optional().describe("For mesh formats: include the avatar as well as the garment (default false)."),
      turntable_images: z.number().int().min(2).max(72).optional().describe("For turntable: number of images around 360 degrees (default 8)."),
      timeout_s: timeoutArg,
    },
  },
  tool((a) => {
    const dir = path.dirname(a.file_path);
    if (!fs.existsSync(dir)) throw new Error(`Folder does not exist: ${dir}`);
    const exporter = EXPORTERS[a.format];
    return run(
      `
${exporter.mesh ? meshOptions(a.include_avatar ?? false) : ""}
${exporter.code(py(a.file_path), a)}
_files = _out if isinstance(_out, list) else [_out]
_files = [f for f in _files if isinstance(f, str) and f]
if _out in ("", False, None) or _out == []:
    raise RuntimeError("CLO reported that the ${a.format} export wrote nothing.")
result = {"format": ${py(a.format)}, "files": _files[:20], "file_count": len(_files)} if _files else {"format": ${py(a.format)}, "written": ${py(a.file_path)}}
`,
      { timeoutMs: ms(a.timeout_s, 300) },
    );
  }),
);

// -------------------------------------------------------- escape hatch

server.registerTool(
  "clo_search_api",
  {
    title: "Search CLO Python API",
    description:
      "Search CLO's Python API reference (read from the installed CLO application) by keyword. Returns matching function signatures with their documentation, and matching option struct types. Works without CLO running.",
    inputSchema: {
      query: z.string().describe('Keywords, e.g. "topstitch", "elastic", "shrinkage", "avatar pose", "graphic".'),
      module: z
        .enum(["utility_api", "pattern_api", "fabric_api", "import_api", "export_api", "rest_api"])
        .optional()
        .describe("Restrict the search to one module."),
      limit: z.number().int().min(1).max(50).optional().describe("Maximum results (default 12)."),
    },
    annotations: { readOnlyHint: true },
  },
  tool(({ query, module, limit }) => {
    const index = loadApiIndex();
    if (!index.dir) {
      throw new Error(
        "Could not find CLO's API stub files. Set CLO_APP_PATH to the CLO application, or CLO_API_STUBS to its ApiStubFiles folder.",
      );
    }
    const hits = searchApi(query, { module, limit: limit ?? 12 });
    const terms = query.toLowerCase().split(/\W+/).filter((t) => t.length > 3);
    const typeHits = Object.entries(index.types).filter(([name]) => terms.some((t) => name.toLowerCase().includes(t)));
    if (!hits.length && !typeHits.length) return `No API functions match "${query}" (${index.entries.length} functions indexed).`;
    const out = hits.map((h) => `${h.signature}\n${h.doc.replace(/^/gm, "    ")}`);
    for (const [name, fields] of typeHits) out.push(`type ApiTypes.${name}:\n${fields.map((f) => "    " + f).join("\n")}`);
    return out.join("\n\n");
  }),
);

server.registerTool(
  "clo_execute_python",
  {
    title: "Run Python in CLO",
    description:
      "Run Python inside CLO on its main thread, for anything the other tools do not cover. In scope: utility_api, pattern_api, fabric_api, import_api, export_api, rest_api, ApiTypes (option structs such as ApiTypes.ImportExportOption()), json and os. Variables persist between calls. Returns the value of the last expression, or of a variable named `result`, plus anything printed. Look functions up with clo_search_api first.",
    inputSchema: {
      code: z.string().describe("Python source to execute."),
      timeout_s: timeoutArg,
    },
  },
  tool(({ code, timeout_s }) => run(code, { timeoutMs: ms(timeout_s) })),
);

server.registerTool(
  "clo_stop_bridge",
  {
    title: "Stop the CLO bridge",
    description:
      "Stop the bridge script inside CLO. The other tools stop working until the user runs the bridge script again, so only call this when the user asks.",
    inputSchema: {},
  },
  tool(async () => {
    const resp = await request({ op: "stop" }, { timeoutMs: 10_000 });
    if (!resp.ok) throw new Error(resp.error || "stop failed");
    return "Bridge stopped. Run the bridge script in CLO's Python Script editor to start it again.";
  }),
);

await server.connect(new StdioServerTransport());
