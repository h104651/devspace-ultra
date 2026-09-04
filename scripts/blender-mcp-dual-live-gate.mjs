import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CapabilityRuntime } from "../dist/capability-runtime.js";

const OFFICIAL_SOURCE = "git+https://projects.blender.org/lab/blender_mcp.git@v1.0.0#subdirectory=mcp";
const EXPECTED_TOOLS = [
  "execute_blender_code",
  "execute_blender_code_for_cli",
  "get_blendfile_summary_datablocks",
  "get_blendfile_summary_datablocks_for_cli",
  "get_blendfile_summary_missing_files",
  "get_blendfile_summary_missing_files_for_cli",
  "get_blendfile_summary_of_linked_libraries",
  "get_blendfile_summary_of_linked_libraries_for_cli",
  "get_blendfile_summary_path_info",
  "get_blendfile_summary_path_info_for_cli",
  "get_blendfile_summary_usage_guess",
  "get_blendfile_summary_usage_guess_for_cli",
  "get_object_detail_summary",
  "get_objects_summary",
  "get_python_api_docs",
  "get_screenshot_of_area_as_image",
  "get_screenshot_of_window_as_image",
  "get_screenshot_of_window_as_json",
  "jump_to_tab_by_name",
  "jump_to_tab_by_space_type",
  "jump_to_view3d_object_by_name",
  "jump_to_view3d_object_data_by_name",
  "render_thumbnail_to_path",
  "render_viewport_to_path",
  "search_api_docs",
  "search_manual_docs",
];

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function assertFile(path) {
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`Expected file: ${path}`);
}

function waitForPort(port, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolveWait, rejectWait) => {
    const attempt = () => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      let settled = false;
      const retry = () => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (Date.now() >= deadline) {
          rejectWait(new Error(`Timed out waiting for Blender bridge port ${port}.`));
          return;
        }
        setTimeout(attempt, 250);
      };
      socket.setTimeout(750, retry);
      socket.once("error", retry);
      socket.once("connect", () => {
        if (settled) return;
        settled = true;
        socket.end();
        resolveWait();
      });
    };
    attempt();
  });
}

function launchBlender(blenderPath, port) {
  return spawn(blenderPath, [
    "--background",
    "--online-mode",
    "--command", "blender_mcp",
    "--host", "127.0.0.1",
    "--port", String(port),
  ], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32" && child.pid) {
    await new Promise((resolveStop) => {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      killer.once("close", () => resolveStop());
      killer.once("error", () => resolveStop());
    });
  }
  else {
    try { child.kill("SIGTERM"); } catch {}
  }
  await Promise.race([new Promise((resolveClose) => child.once("close", resolveClose)), sleep(3000)]).catch(() => {});
}

function mcpStructured(callResult) {
  const result = callResult?.result;
  if (result?.structuredContent && typeof result.structuredContent === "object") return result.structuredContent;
  for (const item of result?.content || []) {
    if (item?.type !== "text" || typeof item.text !== "string") continue;
    try {
      const parsed = JSON.parse(item.text);
      if (parsed && typeof parsed === "object") return parsed;
    }
    catch {}
  }
  return undefined;
}

function blenderValue(callResult) {
  const outer = mcpStructured(callResult);
  if (!outer) throw new Error(`Blender MCP call returned no structured data: ${JSON.stringify(callResult?.result)}`);
  if (outer.status && outer.status !== "ok") throw new Error(`Blender bridge returned ${outer.status}: ${outer.message || "unknown error"}`);
  return outer.result ?? outer;
}

function portable(path) {
  return path.replace(/\\/g, "/");
}

async function main() {
  const blenderPath = resolve(process.env.DEVSPACE_BLENDER_PATH || process.env.BLENDER_PATH || "E:\\3D\\blender.exe");
  const uvPath = resolve(process.env.DEVSPACE_UV_PATH || "C:\\Users\\enwong\\AppData\\Local\\Programs\\Python\\Python311\\Scripts\\uv.exe");
  await assertFile(blenderPath);
  await assertFile(uvPath);

  const portA = Number(process.env.DEVSPACE_BLENDER_TEST_PORT_A || 19876);
  const portB = Number(process.env.DEVSPACE_BLENDER_TEST_PORT_B || 19877);
  assert.notEqual(portA, portB);

  const root = await mkdtemp(join(tmpdir(), "devspace-blender-dual-live-"));
  const pluginSource = join(root, "blender-capability");
  const pluginsDir = join(root, "plugins");
  const registryPath = join(pluginsDir, "registry.json");
  const blendA = join(root, "DevSpace-Blender-A.blend");
  const blendB = join(root, "DevSpace-Blender-B.blend");
  await mkdir(pluginSource, { recursive: true });

  await writeFile(join(pluginSource, "devspace-plugin.json"), JSON.stringify({
    id: "blender-lab-v1",
    name: "Blender Lab MCP v1.0.0",
    version: "1.0.0",
    description: "Official Blender Lab MCP v1.0.0 used for DevSpace stateful-instance verification.",
    mcpServers: {
      blender: {
        command: uvPath,
        args: [
          "tool", "run",
          "--with", "mcp[cli]<2",
          "--from", OFFICIAL_SOURCE,
          "blender-mcp",
        ],
        connectTimeoutMs: 180000,
        env: {
          BLENDER_PATH: blenderPath,
          BLENDER_MCP_DISABLE_TELEMETRY: "true",
          ...(process.env.UV_CACHE_DIR ? { UV_CACHE_DIR: process.env.UV_CACHE_DIR } : {}),
          ...(process.env.UV_TOOL_DIR ? { UV_TOOL_DIR: process.env.UV_TOOL_DIR } : {}),
        },
      },
    },
  }, null, 2));

  const blenderA = launchBlender(blenderPath, portA);
  const blenderB = launchBlender(blenderPath, portB);
  let stderrA = "";
  let stderrB = "";
  blenderA.stderr?.on("data", (chunk) => { stderrA = (stderrA + String(chunk)).slice(-12000); });
  blenderB.stderr?.on("data", (chunk) => { stderrB = (stderrB + String(chunk)).slice(-12000); });

  const runtime = new CapabilityRuntime({
    enabled: true,
    pluginsDir,
    registryPath,
    pluginPaths: [],
  });
  let claimA;
  let claimB;
  try {
    await Promise.all([waitForPort(portA), waitForPort(portB)]);
    await runtime.ready;
    const installed = await runtime.install({ source: pluginSource, enable: true, trust: true });
    assert.equal(installed.plugin.id, "blender-lab-v1");

    claimA = await runtime.claimInstance({
      pluginId: "blender-lab-v1",
      serverId: "blender",
      instanceId: "project-a",
      ownerLabel: "Blender-Agent-A",
      env: { BLENDER_MCP_HOST: "127.0.0.1", BLENDER_MCP_PORT: String(portA) },
      leaseSeconds: 900,
    });
    claimB = await runtime.claimInstance({
      pluginId: "blender-lab-v1",
      serverId: "blender",
      instanceId: "project-b",
      ownerLabel: "Blender-Agent-B",
      env: { BLENDER_MCP_HOST: "127.0.0.1", BLENDER_MCP_PORT: String(portB) },
      leaseSeconds: 900,
    });

    await assert.rejects(() => runtime.claimInstance({
      pluginId: "blender-lab-v1",
      serverId: "blender",
      instanceId: "project-a",
      ownerLabel: "Competing-Agent",
      env: { BLENDER_MCP_PORT: String(portA) },
    }), /already claimed/);

    const [holderA, holderB] = await Promise.all([
      runtime.getMcpClient("blender-lab-v1", "blender", claimA.instanceToken),
      runtime.getMcpClient("blender-lab-v1", "blender", claimB.instanceToken),
    ]);
    assert.notEqual(holderA, holderB);

    const [listedA, listedB] = await Promise.all([
      holderA.client.listTools(undefined, { timeout: 180000 }),
      holderB.client.listTools(undefined, { timeout: 180000 }),
    ]);
    const toolsA = listedA.tools.map((tool) => tool.name);
    const toolsB = listedB.tools.map((tool) => tool.name);
    assert.deepEqual(toolsA, EXPECTED_TOOLS);
    assert.deepEqual(toolsB, EXPECTED_TOOLS);
    assert.deepEqual(listedA.tools, listedB.tools);

    const initCode = (label, marker, otherMarker, outputPath) => [
      "import bpy",
      `for n in ${JSON.stringify([marker, otherMarker])}:`,
      "    if bpy.data.objects.get(n):",
      "        bpy.data.objects.remove(bpy.data.objects[n], do_unlink=True)",
      `obj=bpy.data.objects.new(${JSON.stringify(marker)}, None)`,
      "bpy.context.scene.collection.objects.link(obj)",
      `bpy.context.scene['devspace_instance']=${JSON.stringify(label)}`,
      `bpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(portable(outputPath))})`,
      `result={'instance':bpy.context.scene.get('devspace_instance'),'file':bpy.data.filepath,'own':bpy.data.objects.get(${JSON.stringify(marker)}) is not None,'other':bpy.data.objects.get(${JSON.stringify(otherMarker)}) is not None}`,
    ].join("\n");

    const [writeA, writeB] = await Promise.all([
      runtime.call({
        pluginId: "blender-lab-v1", kind: "mcp", serverId: "blender", instanceToken: claimA.instanceToken,
        toolName: "execute_blender_code", arguments: { code: initCode("A", "DEVSPACE_A_ONLY", "DEVSPACE_B_ONLY", blendA) },
      }),
      runtime.call({
        pluginId: "blender-lab-v1", kind: "mcp", serverId: "blender", instanceToken: claimB.instanceToken,
        toolName: "execute_blender_code", arguments: { code: initCode("B", "DEVSPACE_B_ONLY", "DEVSPACE_A_ONLY", blendB) },
      }),
    ]);
    const writeValueA = blenderValue(writeA);
    const writeValueB = blenderValue(writeB);
    assert.deepEqual({ instance: writeValueA.instance, own: writeValueA.own, other: writeValueA.other }, { instance: "A", own: true, other: false });
    assert.deepEqual({ instance: writeValueB.instance, own: writeValueB.own, other: writeValueB.other }, { instance: "B", own: true, other: false });

    const verifyCode = [
      "import bpy",
      "result={'instance':bpy.context.scene.get('devspace_instance'),'file':bpy.data.filepath,'A':bpy.data.objects.get('DEVSPACE_A_ONLY') is not None,'B':bpy.data.objects.get('DEVSPACE_B_ONLY') is not None,'objects':[o.name for o in bpy.context.scene.objects]}",
    ].join("\n");
    const [verifyA, verifyB, summaryA, summaryB, datablocksA, datablocksB] = await Promise.all([
      runtime.call({ pluginId: "blender-lab-v1", kind: "mcp", serverId: "blender", instanceToken: claimA.instanceToken, toolName: "execute_blender_code", arguments: { code: verifyCode } }),
      runtime.call({ pluginId: "blender-lab-v1", kind: "mcp", serverId: "blender", instanceToken: claimB.instanceToken, toolName: "execute_blender_code", arguments: { code: verifyCode } }),
      runtime.call({ pluginId: "blender-lab-v1", kind: "mcp", serverId: "blender", instanceToken: claimA.instanceToken, toolName: "get_objects_summary", arguments: {} }),
      runtime.call({ pluginId: "blender-lab-v1", kind: "mcp", serverId: "blender", instanceToken: claimB.instanceToken, toolName: "get_objects_summary", arguments: {} }),
      runtime.call({ pluginId: "blender-lab-v1", kind: "mcp", serverId: "blender", instanceToken: claimA.instanceToken, toolName: "get_blendfile_summary_datablocks", arguments: {} }),
      runtime.call({ pluginId: "blender-lab-v1", kind: "mcp", serverId: "blender", instanceToken: claimB.instanceToken, toolName: "get_blendfile_summary_datablocks", arguments: {} }),
    ]);

    const valueA = blenderValue(verifyA);
    const valueB = blenderValue(verifyB);
    assert.equal(valueA.instance, "A");
    assert.equal(valueA.A, true);
    assert.equal(valueA.B, false);
    assert.equal(valueB.instance, "B");
    assert.equal(valueB.A, false);
    assert.equal(valueB.B, true);
    assert.equal(resolve(valueA.file), resolve(blendA));
    assert.equal(resolve(valueB.file), resolve(blendB));

    const summaryTextA = JSON.stringify(blenderValue(summaryA));
    const summaryTextB = JSON.stringify(blenderValue(summaryB));
    assert.match(summaryTextA, /DEVSPACE_A_ONLY/);
    assert.doesNotMatch(summaryTextA, /DEVSPACE_B_ONLY/);
    assert.match(summaryTextB, /DEVSPACE_B_ONLY/);
    assert.doesNotMatch(summaryTextB, /DEVSPACE_A_ONLY/);
    assert.ok(blenderValue(datablocksA));
    assert.ok(blenderValue(datablocksB));

    await Promise.all([assertFile(blendA), assertFile(blendB)]);
    const active = await runtime.listInstances({ pluginId: "blender-lab-v1", serverId: "blender" });
    assert.deepEqual(active.map((item) => item.instanceId), ["project-a", "project-b"]);
    assert.deepEqual(active.map((item) => item.envNames), [["BLENDER_MCP_HOST", "BLENDER_MCP_PORT"], ["BLENDER_MCP_HOST", "BLENDER_MCP_PORT"]]);

    console.log(JSON.stringify({
      ok: true,
      source: OFFICIAL_SOURCE,
      dependencyCompatibilityPin: "mcp[cli]<2",
      blenderPath,
      blenderVersionGate: "Blender 5.1 installed extension",
      instanceA: { port: portA, pid: blenderA.pid, blendFile: blendA, marker: "DEVSPACE_A_ONLY" },
      instanceB: { port: portB, pid: blenderB.pid, blendFile: blendB, marker: "DEVSPACE_B_ONLY" },
      fullToolCatalog: `${toolsA.length}/${EXPECTED_TOOLS.length} PASS`,
      sameToolCatalog: JSON.stringify(toolsA) === JSON.stringify(toolsB) ? "PASS" : "FAIL",
      fullToolSchemaParity: "PASS",
      isolatedMcpProcesses: holderA !== holderB ? "PASS" : "FAIL",
      exclusiveSameInstanceClaim: "PASS",
      projectIsolation: "PASS",
      highLevelObjectsSummary: "PASS",
      highLevelDatablocksSummary: "PASS",
      toolNames: toolsA,
    }));
  }
  catch (error) {
    if (stderrA) console.error(`Blender A stderr:\n${stderrA}`);
    if (stderrB) console.error(`Blender B stderr:\n${stderrB}`);
    throw error;
  }
  finally {
    if (claimA?.instanceToken) await runtime.releaseInstance(claimA.instanceToken).catch(() => {});
    if (claimB?.instanceToken) await runtime.releaseInstance(claimB.instanceToken).catch(() => {});
    await runtime.close().catch(() => {});
    await stopProcess(blenderA);
    await stopProcess(blenderB);
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

await main();
