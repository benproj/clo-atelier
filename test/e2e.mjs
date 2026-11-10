// End-to-end test without CLO: real MCP server + real bridge script, with
// CLO's API modules replaced by test/mock_clo.py.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "clo-mcp-test-"));
const stateFile = path.join(stateDir, "bridge.json");

const mock = spawn(process.env.PYTHON || "python3", [path.join(root, "test", "mock_clo.py")], {
  env: { ...process.env, CLO_MCP_STATE_DIR: stateDir, CLO_MCP_PORT: "9977", PYTHONUNBUFFERED: "1" },
  stdio: ["ignore", "inherit", "inherit"],
});

const client = new Client({ name: "e2e", version: "0" });
const textOf = (res) => res.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
const call = (name, args = {}) => client.callTool({ name, arguments: args });

try {
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(root, "server", "index.js")],
      env: { ...process.env, CLO_MCP_STATE_FILE: stateFile },
    }),
  );

  const tools = (await client.listTools()).tools.map((t) => t.name);
  console.log("tools:", tools.join(", "));
  assert.ok(tools.includes("clo_execute_python"));

  // Before the bridge is up, tools explain how to start it.
  if (!fs.existsSync(stateFile)) {
    const res = await call("clo_status");
    assert.equal(res.isError, true);
    assert.match(textOf(res), /Python Script/);
  }
  for (let i = 0; i < 100 && !fs.existsSync(stateFile); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(fs.existsSync(stateFile), "bridge did not start");
  assert.equal(fs.statSync(stateFile).mode & 0o077, 0, "state file must be private");

  let res = await call("clo_status");
  assert.ok(!res.isError, textOf(res));
  assert.equal(JSON.parse(textOf(res)).clo.clo_version, "2025.0.84");

  res = await call("clo_create_patterns", {
    patterns: [
      { name: "Front", points: [{ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 500, type: "spline" }, { x: 0, y: 500 }], arrangement_point: "leg_skirt_back", layer: 1 },
      { name: "Back", points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }], arrangement_point: "Nowhere" },
    ],
  });
  let created = JSON.parse(textOf(res));
  assert.deepEqual(created.map((p) => p.index), [0, 1]);
  assert.equal(created[0].arrangement, "Leg_Skirt_Back");
  assert.match(created[1].arrangement_error, /No arrangement point named/);

  res = await call("clo_sew", {
    seams: [
      { pattern_a: 0, line_a: 1, pattern_b: 1, line_b: 1, direction_b: false },
      { pattern_a: 0, line_a: 0, pattern_b: 1, line_b: 1 },
    ],
  });
  const sewn = JSON.parse(textOf(res));
  assert.equal(sewn.seam_group_count, 2);
  assert.equal(sewn.seams[0].length_mismatch_mm, undefined);
  assert.deepEqual(sewn.seams[1].length_mismatch_mm, [300, 500]);

  res = await call("clo_get_scene");
  const scene = JSON.parse(textOf(res));
  assert.deepEqual(scene.patterns.map((p) => p.name), ["Front", "Back"]);
  assert.deepEqual(scene.patterns[0].seam_groups, [0, 1]);
  assert.equal(scene.avatars[0], "Mock Avatar");

  res = await call("clo_get_patterns", { pattern_indices: [0] });
  assert.deepEqual(JSON.parse(textOf(res))[0].points[2], [300, 500]);
  res = await call("clo_get_patterns");
  assert.equal(JSON.parse(textOf(res)).length, 2);

  res = await call("clo_list_arrangement_points", { filter: "SKIRT" });
  assert.equal(textOf(res), "1: Leg_Skirt_Back");

  res = await call("clo_edit_pattern", { pattern_index: 1, name: "Back Panel", layer: 2 });
  assert.equal(JSON.parse(textOf(res)).name, "Back Panel");
  res = await call("clo_edit_pattern", { pattern_index: 1 });
  assert.equal(res.isError, true);
  res = await call("clo_edit_pattern", { pattern_index: 9, name: "x" });
  assert.match(textOf(res), /No pattern with index 9/);

  res = await call("clo_edit_fabric", { fabric_index: 0, color: "#ff0000", name: "Red" });
  assert.equal(JSON.parse(textOf(res)).name, "Red");
  res = await call("clo_edit_fabric", { fabric_index: 0, color: "red" });
  assert.match(textOf(res), /hex value/);

  res = await call("clo_delete_patterns", { pattern_indices: [0, 1] });
  assert.equal(JSON.parse(textOf(res)).pattern_count, 0);

  // Undo history: every change above was recorded; failed and read-only calls were not.
  let hist = JSON.parse(textOf(await call("clo_history")));
  assert.deepEqual(hist.undo.map((e) => e.tool), ["clo_delete_patterns", "clo_edit_fabric", "clo_edit_pattern", "clo_sew", "clo_create_patterns"]);
  res = await call("clo_undo");
  assert.deepEqual(JSON.parse(textOf(res)).undone, ["clo_delete_patterns"]);
  assert.equal(JSON.parse(textOf(res)).now.patterns, 2);
  assert.equal(JSON.parse(textOf(res)).now.seams, 2);
  res = await call("clo_redo");
  assert.equal(JSON.parse(textOf(res)).now.patterns, 0);
  res = await call("clo_redo");
  assert.match(textOf(res), /Nothing to redo/);
  await call("clo_undo", { steps: 3 });
  hist = JSON.parse(textOf(await call("clo_history", { checkpoint: "after sewing" })));
  assert.equal(hist.undo[0].checkpoint, "after sewing");
  assert.equal(hist.redo.length, 0, "a new entry discards the undone future");
  await call("clo_delete_patterns", { pattern_indices: [0] });
  res = await call("clo_undo", { to_checkpoint: "after sewing" });
  assert.equal(JSON.parse(textOf(res)).now.patterns, 2);
  res = await call("clo_undo", { to_checkpoint: "missing" });
  assert.match(textOf(res), /No checkpoint labelled/);
  res = await call("clo_undo", { steps: 50 });
  assert.equal(JSON.parse(textOf(res)).now.patterns, 0, "undoing everything returns to the empty garment");

  // REPL behaviour: state persists, last expression is returned, stdout captured.
  await call("clo_execute_python", { code: "x = 20\nprint('hello')" });
  res = await call("clo_execute_python", { code: "print('again')\nx + 1" });
  assert.match(textOf(res), /^21\n\nstdout:\nagain$/);
  res = await call("clo_execute_python", { code: 'name = "caf\\u00e9 \\"q\\""\nname' });
  assert.equal(textOf(res), 'café "q"');

  // Errors come back as tracebacks and leave the bridge running.
  res = await call("clo_execute_python", { code: "print('before')\n1/0" });
  assert.equal(res.isError, true);
  assert.match(textOf(res), /ZeroDivisionError[\s\S]*before/);
  res = await call("clo_execute_python", { code: "import sys\nsys.exit(3)" });
  assert.equal(res.isError, true);
  res = await call("clo_simulate", { steps: 5 });
  assert.equal(JSON.parse(textOf(res)).simulated, true);

  res = await call("clo_screenshot", { views: ["front", "current"] });
  assert.ok(!res.isError, textOf(res));
  assert.equal(res.content.filter((c) => c.type === "image").length, 2);

  res = await call("clo_search_api", { query: "topstitch color" });
  console.log("search sample:", textOf(res).split("\n")[0]);

  res = await call("clo_open_file", { file_path: "/no/such/file.zprj" });
  assert.equal(res.isError, true);

  res = await call("clo_stop_bridge");
  assert.ok(!res.isError, textOf(res));
  await new Promise((r) => mock.once("exit", r));
  assert.ok(!fs.existsSync(stateFile), "state file should be removed on stop");

  console.log("\nALL PASSED");
} finally {
  await client.close().catch(() => {});
  mock.kill();
  fs.rmSync(stateDir, { recursive: true, force: true });
}
