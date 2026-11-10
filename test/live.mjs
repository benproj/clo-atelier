// Smoke test against a real CLO with the bridge running.
// WARNING: starts a new project, discarding whatever is open in CLO.
//   node test/live.mjs <output-folder>
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = process.argv[2];
if (!out) throw new Error("usage: node test/live.mjs <output-folder>");
fs.mkdirSync(out, { recursive: true });
const assets = path.join(os.homedir(), "Documents", "clo", "CLO Assets");

const client = new Client({ name: "live", version: "0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, "server", "index.js")] }));
let failures = 0;
const call = async (name, args = {}) => {
  const t0 = Date.now();
  const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 900_000 });
  const txt = res.content.map((c) => (c.type === "text" ? c.text : `<${c.mimeType}>`)).join("\n");
  if (res.isError) failures++;
  console.log(`\n### ${name} ${res.isError ? "ERROR" : "ok"} (${Date.now() - t0}ms)\n${txt.replace(/\s+/g, " ").slice(0, 700)}`);
  return txt;
};
const panel = (x0) => [{ x: x0, y: 0 }, { x: x0 + 500, y: 0 }, { x: x0 + 425, y: 550 }, { x: x0 + 75, y: 550 }];

await call("clo_new_project");
await call("clo_open_file", { file_path: path.join(assets, "Avatar", "Female", "FV2.1_Mia.avt") });
await call("clo_list_arrangement_points", { filter: "skirt" });
await call("clo_create_patterns", {
  patterns: [
    { name: "Skirt Front", points: panel(0), arrangement_point: "Leg_Skirt_Front" },
    { name: "Skirt Back", points: panel(700), arrangement_point: "Leg_Skirt_Back" },
  ],
});
await call("clo_sew", {
  seams: [
    { pattern_a: 0, line_a: 1, pattern_b: 1, line_b: 3, direction_b: false },
    { pattern_a: 0, line_a: 3, pattern_b: 1, line_b: 1, direction_b: false },
  ],
});
await call("clo_add_fabric", { file_path: path.join(assets, "Fabric", "V2_Woven_Denim_1.zfab"), assign_to_patterns: "all" });
await call("clo_edit_fabric", { fabric_index: 1, color: "#B03A2E", name: "Red Denim" });
await call("clo_get_fabric", { fabric_index: 1 });
await call("clo_copy_pattern", { pattern_index: 0, center: { x: 1700, y: 275 }, flip: "horizontal", name: "Scratch Copy" });
await call("clo_edit_pattern", { pattern_index: 2, center: { x: 1800, y: 300 }, layer: 1, particle_distance: 15 });
await call("clo_get_patterns", { pattern_indices: [2] });
await call("clo_delete_patterns", { pattern_indices: [2] });
await call("clo_simulate", { steps: 150 });
await call("clo_screenshot", { views: ["front", "back", "2d-patterns"], save_dir: out });
await call("clo_colorways", { copy_from: 0, rename: { index: 1, name: "Second" } });
await call("clo_colorways", { switch_to: 0 });
for (const format of ["glb", "fbx", "gltf", "obj", "dxf", "zpac", "techpack", "turntable", "zprj"]) {
  const ext = { techpack: "json", turntable: "png" }[format] ?? format;
  const dir = path.join(out, format);
  fs.mkdirSync(dir, { recursive: true });
  await call("clo_export", { format, file_path: path.join(dir, `skirt.${ext}`), turntable_images: 4, timeout_s: 60 });
}
await call("clo_get_scene");
await client.close();
console.log(failures ? `\n${failures} TOOL CALLS FAILED` : "\nALL LIVE CALLS OK");
