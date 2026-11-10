// Talks to the bridge script running inside CLO (bridge/clo_mcp_bridge.py).
// One short-lived connection per request, so a restarted bridge is picked up
// automatically.

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const STATE_FILE =
  process.env.CLO_MCP_STATE_FILE || path.join(os.homedir(), ".clo-mcp", "bridge.json");

const BUNDLED_BRIDGE = fileURLToPath(new URL("../bridge/clo_mcp_bridge.py", import.meta.url));

/**
 * Copy the bridge script next to the state file, so the path users load in
 * CLO stays the same when the plugin updates and its install folder moves.
 */
function installBridge() {
  const target = path.join(path.dirname(STATE_FILE), "clo_mcp_bridge.py");
  try {
    const source = fs.readFileSync(BUNDLED_BRIDGE);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    if (!fs.existsSync(target) || !fs.readFileSync(target).equals(source)) fs.writeFileSync(target, source, { mode: 0o600 });
    return target;
  } catch {
    return BUNDLED_BRIDGE;
  }
}

export const BRIDGE_SCRIPT = installBridge();

/** On macOS, also install the script that starts the bridge by driving CLO's editor. */
function installStarter() {
  if (process.platform !== "darwin") return null;
  const target = path.join(path.dirname(STATE_FILE), "start-bridge.sh");
  try {
    const source = fs.readFileSync(fileURLToPath(new URL("../scripts/start-bridge-macos.sh", import.meta.url)));
    if (!fs.existsSync(target) || !fs.readFileSync(target).equals(source)) fs.writeFileSync(target, source, { mode: 0o700 });
    return target;
  } catch {
    return null;
  }
}

export const STARTER_SCRIPT = installStarter();

/** One line to paste into CLO's Python Script editor to start the bridge. */
export const BRIDGE_LOADER = `exec(open(r"${BRIDGE_SCRIPT}").read())`;

export class BridgeError extends Error {}

function notRunningMessage(detail) {
  return (
    `The CLO bridge is not reachable (${detail}).\n` +
    `Ask the user to start it inside CLO: open Edit > Python Script, paste this line and press Run:\n` +
    `  ${BRIDGE_LOADER}\n` +
    `The editor's output should print "[clo-mcp] Bridge ... listening". It must be started again each time CLO is launched.` +
    (STARTER_SCRIPT
      ? `\nOn macOS you can start it yourself instead by running this in a shell (it launches CLO if needed, and needs Accessibility permission for the terminal):\n  bash "${STARTER_SCRIPT}"`
      : "")
  );
}

function readState() {
  let raw;
  try {
    raw = fs.readFileSync(STATE_FILE, "utf8");
  } catch {
    throw new BridgeError(notRunningMessage("no bridge state file"));
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new BridgeError(notRunningMessage("unreadable bridge state file"));
  }
}

let nextId = 1;

/** Send one request to the bridge and resolve with its response object. */
export function request(payload, { timeoutMs = 120_000 } = {}) {
  const state = readState();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: state.host || "127.0.0.1", port: state.port });
    let buf = "";
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      fn(value);
    };
    const timer = setTimeout(() => {
      finish(
        reject,
        new BridgeError(
          `CLO did not answer within ${Math.round(timeoutMs / 1000)}s. It may still be busy ` +
            `(simulating, exporting, or waiting on a dialog inside CLO).`,
        ),
      );
    }, timeoutMs);
    sock.setEncoding("utf8");
    sock.on("connect", () => {
      sock.write(JSON.stringify({ ...payload, id, token: state.token }) + "\n");
    });
    sock.on("data", (chunk) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      try {
        finish(resolve, JSON.parse(buf.slice(0, nl)));
      } catch (err) {
        finish(reject, new BridgeError(`Bad response from bridge: ${err.message}`));
      }
    });
    sock.on("error", (err) => finish(reject, new BridgeError(notRunningMessage(err.code || err.message))));
    sock.on("close", () => finish(reject, new BridgeError("The bridge closed the connection without answering.")));
  });
}

/**
 * Fail fast when CLO cannot answer. The bridge runs on CLO's main thread, so
 * it goes silent while CLO is busy or showing a modal dialog.
 */
async function ensureResponsive() {
  try {
    await request({ op: "ping" }, { timeoutMs: 3000 });
  } catch (err) {
    if (/did not answer/.test(err.message)) {
      throw new BridgeError(
        "CLO is not responding. It is either still busy with an earlier request or showing a dialog. " +
          "Ask the user to close any open dialog in CLO, then try again.",
      );
    }
    throw err;
  }
}

/** Run Python inside CLO. Resolves with { result, stdout }; throws on error. */
export async function exec(code, opts) {
  await ensureResponsive();
  const resp = await request({ op: "exec", code }, opts);
  if (!resp.ok) {
    const err = new BridgeError(resp.error || "CLO reported an error");
    err.stdout = resp.stdout || "";
    throw err;
  }
  return { result: resp.result, stdout: resp.stdout || "" };
}

/** Render a JS value as a Python literal. */
export function py(value) {
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Non-finite number");
    return String(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(py).join(", ") + "]";
  if (typeof value === "object") {
    return "{" + Object.entries(value).map(([k, v]) => `${py(k)}: ${py(v)}`).join(", ") + "}";
  }
  throw new Error(`Cannot convert ${typeof value} to Python`);
}
