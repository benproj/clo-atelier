# CLO Atelier

A Claude plugin and MCP server for [CLO 3D](https://www.clo3d.com/). With it,
Claude can work in a CLO session you have open: it reads the scene, drafts
pattern pieces, sews them, puts fabric on them, runs the simulation, takes
screenshots to check the drape, and exports files.

I made this for my own pattern work. It is unofficial and has no connection to
CLO Virtual Fashion, who own the CLO name. You need your own CLO license.

## What it can do

You can ask for "load this avatar and make a straight skirt in denim", "sew
the side seams and simulate", "show me the back view" or "export the garment
as GLB". The tools for creating pieces and sewing take lists, so Claude can
build a whole garment in a few calls.

| Tool | What it does |
| --- | --- |
| `clo_status` | Bridge and CLO version, open project, object counts |
| `clo_get_scene` | Every pattern (size, fabric, arrangement, seams), fabrics, colorways, avatars |
| `clo_get_patterns` | Outline points and line indices/lengths for some or all patterns |
| `clo_list_arrangement_points` | Avatar arrangement points, filterable by name |
| `clo_create_patterns` | Create several pieces at once, each with name, fabric, layer and arrangement point |
| `clo_add_internal_shape` | Internal line or shape inside a pattern |
| `clo_edit_pattern` | Rename, move, flip, re-arrange, fabric, layer, grain, mesh density, freeze, hide |
| `clo_copy_pattern` | Duplicate a piece, optionally mirrored |
| `clo_delete_patterns` | Delete pieces |
| `clo_sew` | Create several seams at once; warns when the two lines differ in length |
| `clo_simulate` | Run N steps, optionally switching quality preset or resetting arrangement |
| `clo_screenshot` | Several views in one call: 3D standard views and a 2D pattern layout |
| `clo_add_fabric`, `clo_assign_fabric`, `clo_get_fabric`, `clo_edit_fabric` | Load, assign, inspect, rename, recolour or replace fabrics |
| `clo_colorways` | List, copy, rename, switch colorways |
| `clo_new_project`, `clo_open_file` | Start fresh; open or import a file by path |
| `clo_export` | zprj, zpac, obj, fbx, glb, gltf, dxf, pattern JSON, tech pack, turntable, avatar |
| `clo_undo`, `clo_redo` | Step back and forward through the changes the tools made |
| `clo_history` | List those changes, or label a checkpoint to return to by name |
| `clo_search_api` | Keyword search over CLO's 600+ Python API functions and option structs |
| `clo_execute_python` | Run any Python inside CLO (persistent namespace) |
| `clo_stop_bridge` | Stop the bridge |

## Undo

CLO's Python API has no undo call. CLO does put most API changes on its own
undo stack (the History panel), but it skips some, such as moving a piece or
changing its layer, and a script can't read that list or jump to a point in it.

So the server keeps its own history. Before any tool call that changes the
garment, it saves the garment to a file under `~/.clo-mcp/history/`. `clo_undo`
loads the save from before the last change, or from several changes back, and
`clo_redo` goes forward again. An undo brings back patterns, seams, fabrics,
colorways and the simulated drape, so you can undo a simulation that went
wrong. `clo_history` shows the list and can label a checkpoint, for example
"before sleeves", that `clo_undo` returns to by name.

Each save adds roughly half a second to a tool call, and an undo takes about
three seconds. The history keeps the last 25 changes and starts over each time
CLO is launched. Three things to know:

- The avatar and scene are not saved, only the garment.
- An undo also throws away what you changed by hand in CLO after that point.
  `clo_redo` brings it back if you haven't made another change since.
- Loading a save clears the list in CLO's own History panel.

## Requirements

- CLO with the Python Script editor. I built and tested this on CLO Standalone
  2025.0 for macOS. I have not tried it on Windows.
- Node.js 18 or later
- Claude Code, or another MCP client

## Install

As a Claude Code plugin, inside a session:

```
/plugin install clo-atelier --marketplace benproj/clo-atelier
```

or from your shell:

```sh
claude plugin marketplace add benproj/clo-atelier
claude plugin install clo-atelier@clo-atelier
```

Or as a plain MCP server for any client:

```sh
git clone https://github.com/benproj/clo-atelier.git
cd clo-atelier && npm ci
claude mcp add clo3d -- node "$PWD/server/index.js"
```

## Start the bridge in CLO

CLO only lets Python that runs inside the application use its API. So there is
a small bridge script, and you start it once each time you launch CLO:

1. In CLO, open **Edit > Python Script**.
2. Paste this line into the editor and press Run (the play button):

   ```python
   import os; exec(open(os.path.expanduser("~/.clo-mcp/clo_mcp_bridge.py")).read())
   ```

3. The editor's output shows `[clo-mcp] Bridge 0.1.0 listening on 127.0.0.1:9877`.

The server copies the bridge script to `~/.clo-mcp/` when it first starts, so
open your MCP client once before step 2. If the bridge isn't running, each
tool answers with these instructions. To stop the bridge, press Run a second
time or call `clo_stop_bridge`.

## How it works and what it touches

```
MCP client ──stdio──▶ server/index.js ──localhost TCP──▶ bridge/clo_mcp_bridge.py (inside CLO)
```

The bridge runs on CLO's main thread and uses only the Python standard
library. It listens on `127.0.0.1`, runs the Python the server sends, and
pumps Qt events between requests so you can keep using CLO while it runs.

When the bridge starts it writes its port and a random token to
`~/.clo-mcp/bridge.json`, readable only by you. The server reads that file
before every request, so another user on the machine can't reach the bridge.

`clo_execute_python` runs whatever Python it is given inside CLO, with your
permissions. The other tools work the same way with fixed snippets. Connect
only MCP clients you trust.

The tools read and write the file paths you or Claude give them for imports,
exports and screenshots. Beyond those they write temporary screenshot files
and the `~/.clo-mcp/` folder, which also holds the undo history. The only network traffic is the local socket
between the server and CLO, and there is no telemetry.

The server depends on the official MCP SDK and zod, both pinned in
`package-lock.json`. `clo_search_api` reads the API stub files inside your CLO
installation (`Contents/Resources/ApiStubFiles`), so its results match your
CLO version, and it works when CLO is closed.

## Configuration

| Variable | Used by | Purpose |
| --- | --- | --- |
| `CLO_MCP_PORT` | bridge | First port to try (default 9877; tries the next 9 if busy) |
| `CLO_APP_PATH` / `CLO_API_STUBS` | server | Where to find CLO's API stubs if not auto-detected |
| `CLO_MCP_HISTORY` | server | Set to `0` to switch the undo history off |
| `CLO_MCP_HISTORY_SIZE` | server | How many changes to keep (default 25) |
| `CLO_MCP_STATE_FILE` | server | Location of the bridge state file (default `~/.clo-mcp/bridge.json`) |

## Limits

- Undo covers the garment only. `clo_new_project` and opening a `.zprj`
  replace the avatar and scene too, so export a `.zprj` first if you care
  about them.
- CLO can't do anything else while a request runs, which you will notice
  during long simulations.
- Some API calls open a dialog in CLO, and CLO then ignores the bridge until
  you close it. Tools called in the meantime fail within a few seconds and say
  why. The built-in tools pass option structs to skip the dialogs I found.
- The API can't select objects, move the 3D gizmo, or edit avatars.

## Development

```sh
npm ci
npm test                              # real server + bridge against a mock of CLO's API
node test/call.mjs clo_status         # call one tool against a live CLO
node test/undo_live.mjs               # undo, redo and checkpoints against a live CLO
node test/live.mjs /tmp/clo-live      # full smoke test; starts a new project in CLO, so save first
```

## License

MIT
