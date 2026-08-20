import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapabilityRuntime } from "../dist/capability-runtime.js";

const source = process.env.DEVSPACE_CAPABILITY_GATE_SOURCE || "https://github.com/oceanbase/powermem.git";
const root = await mkdtemp(join(tmpdir(), "devspace-capability-git-gate-"));
const pluginsDir = join(root, "plugins");
const registryPath = join(pluginsDir, "registry.json");
const runtime = new CapabilityRuntime({ enabled: true, pluginsDir, registryPath, pluginPaths: [] });
try {
  await runtime.ready;
  const installed = await runtime.install({ source, enable: false, trust: false });
  const plugin = installed.plugin;
  assert.equal(plugin.enabled, false);
  assert.equal(plugin.trusted, false);
  assert.equal(plugin.detectedFormats.includes("claude-plugin"), true, `Expected Claude plugin metadata in ${source}`);
  assert.equal(plugin.detectedFormats.includes("agent-skills"), true, `Expected Agent Skills in ${source}`);
  assert.equal(plugin.skills.length > 0, true);
  assert.equal(plugin.mcpServers.some((server) => server.sourcePath?.toLowerCase().endsWith(".mcp.json")), true, `Expected MCP configuration/profile in ${source}`);
  assert.equal(plugin.mcpServers.some((server) => server.sourcePath?.toLowerCase().endsWith(".mcp.json")), true, `Expected a discoverable MCP profile in ${source}; discovered ${JSON.stringify(plugin.mcpServers.map((server) => ({id:server.id, sourcePath:server.sourcePath, type:server.type})))}`);
  assert.equal(plugin.claudeHooks.length > 0, true, `Expected Claude hook metadata in ${source}`);
  const removed = await runtime.uninstall(plugin.id);
  assert.equal(removed.removed, true);
  console.log(JSON.stringify({
    ok: true,
    source,
    pluginId: plugin.id,
    version: plugin.version,
    detectedFormats: plugin.detectedFormats,
    skills: plugin.skills.length,
    mcpServers: plugin.mcpServers.map((server) => ({ id: server.id, type: server.type, sourcePath: server.sourcePath })),
    claudeCommands: plugin.claudeCommands.length,
    claudeAgents: plugin.claudeAgents.length,
    claudeHooks: plugin.claudeHooks.length,
    installWithoutExecution: "PASS",
    uninstall: "PASS",
  }));
}
finally {
  await runtime.close();
  await rm(root, { recursive: true, force: true });
}
