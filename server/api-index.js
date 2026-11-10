// Searchable index of CLO's Python API, built from the .pyi stub files that
// ship inside the CLO application (Resources/ApiStubFiles).

import fs from "node:fs";
import path from "node:path";

const MODULES = ["utility_api", "pattern_api", "fabric_api", "import_api", "export_api", "rest_api"];

function findStubDir() {
  const candidates = [];
  if (process.env.CLO_API_STUBS) candidates.push(process.env.CLO_API_STUBS);
  if (process.env.CLO_APP_PATH) {
    candidates.push(path.join(process.env.CLO_APP_PATH, "Contents", "Resources", "ApiStubFiles"));
    candidates.push(path.join(process.env.CLO_APP_PATH, "ApiStubFiles"));
  }
  if (process.platform === "darwin") {
    try {
      const apps = fs
        .readdirSync("/Applications")
        .filter((n) => /^CLO.*\.app$/i.test(n))
        .sort()
        .reverse();
      for (const app of apps) candidates.push(path.join("/Applications", app, "Contents", "Resources", "ApiStubFiles"));
    } catch {
      /* ignore */
    }
  }
  return candidates.find((dir) => fs.existsSync(path.join(dir, "pattern_api.pyi"))) || null;
}

function cleanDoc(doc) {
  return doc
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("@fn"))
    .join("\n");
}

let cache = null;

export function loadApiIndex() {
  if (cache) return cache;
  const dir = findStubDir();
  const entries = [];
  const types = {};
  if (dir) {
    for (const mod of MODULES) {
      let text;
      try {
        text = fs.readFileSync(path.join(dir, `${mod}.pyi`), "utf8");
      } catch {
        continue;
      }
      const re = /^[ \t]*def (\w+)\((.*?)\) -> (.*?):[ \t]*\r?\n[ \t]*"""([\s\S]*?)"""/gm;
      const seen = new Set();
      let m;
      while ((m = re.exec(text))) {
        const [, name, args, returns, doc] = m;
        // The *W variants are wide-string duplicates of the same function.
        if (/W$/.test(name) && text.includes(`def ${name.slice(0, -1)}(`)) continue;
        const signature = `${mod}.${name}(${args.replace(/\s*:\s*/g, ": ")}) -> ${returns.trim()}`;
        if (seen.has(signature)) continue;
        seen.add(signature);
        entries.push({ module: mod, name, signature, doc: cleanDoc(doc) });
      }
    }
    try {
      const text = fs.readFileSync(path.join(dir, "ApiTypes.pyi"), "utf8");
      const re = /^class (\w+):\r?\n((?:[ \t]+.*\r?\n?)*)/gm;
      let m;
      while ((m = re.exec(text))) {
        types[m[1]] = m[2].split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      }
    } catch {
      /* ignore */
    }
  }
  cache = { dir, entries, types };
  return cache;
}

/** Rank API functions against a free-text query. */
export function searchApi(query, { module, limit = 15 } = {}) {
  const { entries } = loadApiIndex();
  const terms = query.toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean);
  const scored = [];
  for (const e of entries) {
    if (module && e.module !== module) continue;
    const name = e.name.toLowerCase();
    const doc = e.doc.toLowerCase();
    const sig = e.signature.toLowerCase();
    let score = 0;
    let matched = 0;
    for (const t of terms) {
      let s = 0;
      if (name === t) s = 12;
      else if (name.includes(t)) s = 6;
      else if (sig.includes(t)) s = 3;
      else if (doc.includes(t)) s = 1;
      if (s) matched++;
      score += s;
    }
    if (!terms.length) score = 1;
    else if (matched < terms.length) score *= matched / terms.length / 2;
    if (score > 0) scored.push({ e, score });
  }
  scored.sort((a, b) => b.score - a.score || a.e.name.length - b.e.name.length);
  return scored.slice(0, limit).map((s) => s.e);
}
