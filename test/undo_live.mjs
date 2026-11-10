// Live test of the undo history against a real CLO with the bridge running.
// Leaves the garment as it found it (everything it does is undone at the end).
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const client = new Client({ name: "undo-live", version: "0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, "server", "index.js")] }));
const call = async (name, args = {}) => {
  const t0 = Date.now();
  const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 });
  const txt = res.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  console.log(`${name} ${JSON.stringify(args).slice(0, 70)} ${res.isError ? "ERROR " + txt.slice(0, 200) : "ok"} (${Date.now() - t0}ms)`);
  return { txt, isError: !!res.isError };
};
const state = async () => {
  const { txt } = await call("clo_execute_python", { code: `n = pattern_api.GetPatternCount()\n{"names": [pattern_api.GetPatternPieceName(i) for i in range(n)], "seams": pattern_api.GetSeamlinePairGroupCount(), "pos": [[round(v) for v in pattern_api.GetPatternPiecePos(i)] for i in range(n)], "layer": [pattern_api.GetPatternLayer(i) for i in range(n)], "fabrics": sorted(fabric_api.GetFabricStyleNameList())}` });
  return JSON.parse(txt);
};
const hist = async () => JSON.parse((await call("clo_history")).txt);

const start = await state();
console.log("start", JSON.stringify(start));
const h0 = (await hist()).undo.length;

// a read-only python call and a failed call must not create history entries
await call("clo_edit_pattern", { pattern_index: 99, name: "nope" });
assert.equal((await hist()).undo.length, h0, "reads and failed calls are not recorded");

await call("clo_create_patterns", { patterns: [{ name: "Junk", points: [{ x: 2000, y: 0 }, { x: 2300, y: 0 }, { x: 2300, y: 300 }, { x: 2000, y: 300 }] }] });
await call("clo_edit_pattern", { pattern_index: 0, center: { x: 900, y: 900 }, layer: 3 });
await call("clo_history", { checkpoint: "v1" });
const v1 = await state();
await call("clo_simulate", { steps: 30 });
await call("clo_delete_patterns", { pattern_indices: [0, 1] });
const wrecked = await state();
assert.equal(wrecked.names.length, start.names.length - 1);
console.log("history", JSON.stringify((await hist()).undo.map((e) => e.checkpoint ?? e.tool)));

await call("clo_undo");                                   // undo the delete
assert.deepEqual(await state(), v1, "undo restores deleted pieces, seams, position and layer");
await call("clo_redo");
assert.deepEqual(await state(), wrecked, "redo reapplies the delete");
await call("clo_undo", { to_checkpoint: "v1" });
assert.deepEqual(await state(), v1, "undo to a labelled checkpoint");
const r = await call("clo_undo", { steps: 2 });           // undo the move/layer edit and the junk piece
assert.deepEqual(await state(), start, "two more steps return to the starting state");
console.log(r.txt.replace(/\s+/g, " "));
const none = await call("clo_undo", { steps: 50 });
console.log("after full undo:", JSON.stringify(await state()) === JSON.stringify(start) ? "still at start" : "changed", "|", none.txt.slice(0, 90).replace(/\s+/g, " "));
await client.close();
console.log("\nUNDO LIVE TEST PASSED");
