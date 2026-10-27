import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const server = fs.readFileSync(new URL("../server/index.js", import.meta.url), "utf8");
const ui = fs.readFileSync(new URL("../src/main.jsx", import.meta.url), "utf8");
const styles = fs.readFileSync(new URL("../src/style.css", import.meta.url), "utf8");
const envExample = fs.readFileSync(new URL("../.env.example", import.meta.url), "utf8");

test("agent declares exactly the eight implemented workspace tools", () => {
  const block = server.match(/const AGENT_TOOLS = \[(.*?)\n\];/s)?.[1];
  assert.ok(block, "AGENT_TOOLS definition should exist");
  const names = [...block.matchAll(/name: "([a-z_]+)"/g)].map(match => match[1]);
  assert.deepEqual(names, ["list_files", "read_file", "search_files", "check_code", "write_file", "delete_file", "run_command", "create_task"]);
});

test("mutating and command tools require an approval checkpoint", () => {
  assert.match(server, /const approvalTools = new Set\(\["write_file", "delete_file", "run_command", "create_task"\]\)/);
  assert.match(server, /ENABLE_WORKSPACE_COMMANDS !== "true"/);
  assert.match(envExample, /ENABLE_WORKSPACE_COMMANDS=false/);
});

test("diagnostics are authenticated API requests and check local tools plus provider capability", () => {
  assert.match(server, /app\.post\("\/api\/diagnostics\/run"/);
  for (const marker of ["check_code", "basic_chat", "function_calling", "thinking_low", "thinking_medium", "thinking_high", "thinking_xhigh", "deep_analysis_mode", "long_response_mode"]) {
    assert.ok(server.includes(marker), `missing diagnostic check: ${marker}`);
  }
  assert.match(server, /"web_search"[\s\S]*"not_implemented"/);
  assert.match(server, /"mcp_servers"[\s\S]*"not_implemented"/);
  assert.match(server, /"lsp_diagnostics"[\s\S]*"not_implemented"/);
});

test("UI shows actual tool traces and an explicit diagnostic runner", () => {
  assert.match(ui, /TOOLS USED IN THIS TURN/);
  assert.match(ui, /Run full diagnostics/);
  assert.match(ui, /Reasoning mode · Thinking level/);
  assert.match(styles, /\.tool-trace/);
  assert.match(styles, /\.diagnostic-results/);
});
