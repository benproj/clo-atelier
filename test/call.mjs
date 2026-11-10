// Call one MCP tool from the command line: node test/call.mjs <tool> '<json args>'
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const client = new Client({ name: "call", version: "0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, "server", "index.js")] }));
const res = await client.callTool({ name: process.argv[2], arguments: JSON.parse(process.argv[3] || "{}") }, undefined, { timeout: 900_000 });
if (res.isError) console.log("ERROR");
for (const c of res.content) console.log(c.type === "text" ? c.text : `<${c.type} ${c.mimeType}>`);
await client.close();
