// Simulated end-to-end test of anchored-tools extension logic.
// Mocks ExtensionAPI + ExtensionContext, replays the event flow of a fresh session.
import { createJiti } from "/Users/bgy/.nvm/versions/node/v22.23.1/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  alias: {
    "@earendil-works/pi-coding-agent": "/Users/bgy/.nvm/versions/node/v22.23.1/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js",
    "typebox": "/Users/bgy/.nvm/versions/node/v22.23.1/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/typebox/build/index.mjs",
  },
});
const mod = await jiti.import("/Users/bgy/Downloads/pi-dsv4-booster/src/index.ts");
const factory = mod.default ?? mod;

// ---- mock session state ----
const entries = []; // persisted entries (messages)
let activeTools = ["read", "bash", "str_replace_editor", "edit", "write", "grep", "find", "ls",
  "web_search", "Agent", "get_subagent_result", "steer_subagent", "bash_background",
  "monitor", "memory_search", "memory_save"];
const ALL_TOOLS = () => [...new Set([...activeTools, ...registeredTools.map((t) => t.name)])];
const allToolsMeta = [];
const appended = [];
const statuses = new Map();
const notifies = [];
let systemPromptOverride = null;

const handlers = new Map();
const registeredTools = [];
const api = {
  on: (ev, fn) => handlers.set(ev, fn),
  registerTool: (def) => { registeredTools.push(def); },
  getAllTools: () => [...allToolsMeta],
  getActiveTools: () => [...activeTools],
  setActiveTools: (names) => { activeTools = [...names]; },
  appendEntry: (type, data) => { appended.push({ type, data }); },
  registerCommand: (name, def) => { commands[name] = def; },
};
const commands = {};

// Boot the extension against the mock API
factory(api);
for (const name of ALL_TOOLS()) allToolsMeta.push({ name, description: `tool ${name}`, parameters: {}, promptSnippet: name });
const ui = {
  notify: (msg) => notifies.push(msg),
  setStatus: (k, v) => statuses.set(k, v),
};
const ctx = {
  cwd: "/tmp/anchor-ab-test",
  hasUI: true,
  ui,
  model: { provider: "opencode-go", id: "deepseek-v4-flash" },
  isProjectTrusted: () => true,
  sessionManager: { getEntries: () => entries, getSessionId: () => "sess-1", buildContextEntries: () => entries, getHeader: () => null },
};
const childCtx = {
  ...ctx,
  sessionManager: { getEntries: () => entries, getSessionId: () => "sess-child", buildContextEntries: () => entries, getHeader: () => ({ parentSession: "/tmp/anchor-ab-test/parent.jsonl" }) },
};

// ---- event emission helper ----
async function emit(ev, event, c = ctx) {
  const fn = handlers.get(ev);
  if (!fn) return undefined;
  return fn(event, c);
}

const BASE_PROMPT = `You are an expert coding assistant operating inside pi, a coding agent harness.

Available tools:
- bash: Execute bash commands
- read: Read the contents of a file

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
- Be concise in your responses

Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: /path/README.md

<project_context>

Project-specific instructions and guidelines:

<project_instructions path="AGENTS.md">
do not touch X
</project_instructions>

</project_context>

The following skills provide specialized instructions for specific tasks.
Use the read tool to load a skill's file when the task matches its description.

<available_skills>
  <skill>
    <name>m0-commander</name>
    <description>M0 orchestration</description>
    <location>/Users/bgy/.pi/agent/skills/m0-commander/SKILL.md</location>
  </skill>
</available_skills>

Current working directory: /Users/bgy/Downloads/M3-fightbox`;

let failures = 0;
function check(name, cond, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  " + extra}`);
  if (!cond) failures++;
}

// ---- scenario 1: fresh session bootstrap ----
console.log("\n=== Scenario 1: fresh session → bootstrap ===");
await emit("session_start", { reason: "startup" });
check("active tools == [bash, str_replace_editor]", JSON.stringify(activeTools) === JSON.stringify(["bash", "str_replace_editor"]), JSON.stringify(activeTools));
check("status shows bootstrap", statuses.get("pi-dsv4-booster")?.startsWith("bootstrap"));

// before_agent_start strips injections
const r1 = await emit("before_agent_start", { systemPrompt: BASE_PROMPT, systemPromptOptions: {} });
check("first prompt = minimal persona", r1 && r1.systemPrompt.includes("You are a helpful software engineer assistant."), r1 && r1.systemPrompt);
check("first prompt has NO pi identity", r1 && !r1.systemPrompt.includes("expert coding assistant"), r1 && r1.systemPrompt);
check("first prompt has NO tools list", r1 && !r1.systemPrompt.includes("Available tools:"), r1 && r1.systemPrompt);
check("first prompt has NO project_context", r1 && !r1.systemPrompt.includes("<project_context>"));
check("first prompt has NO skills", r1 && !r1.systemPrompt.includes("<available_skills>"));
check("first prompt keeps cwd line", r1 && r1.systemPrompt.includes("Current working directory:"));

// ---- scenario 2: promotion via tool execution ----
console.log("\n=== Scenario 2: first tool execution → promote ===");
await emit("tool_execution_end", { toolCallId: "c1", toolName: "bash", result: "ok", isError: false });
check("phase promoted via tool-call", appended.some((e) => e.data?.phase === "promoted" && e.data.via === "tool-call"), JSON.stringify(appended));
check("full tools restored after promote", JSON.stringify([...activeTools].sort()) === JSON.stringify(ALL_TOOLS().sort()), JSON.stringify(activeTools));
const r2 = await emit("before_agent_start", { systemPrompt: BASE_PROMPT, systemPromptOptions: {} });
check("post-promote persona STILL applied (session mode)", r2 && r2.systemPrompt.includes("You are a helpful software engineer assistant."), r2 && r2.systemPrompt);
check("post-promote persona has no project_context", r2 && !r2.systemPrompt.includes("<project_context>"));
check("post-promote full tools active", JSON.stringify([...activeTools].sort()) === JSON.stringify(ALL_TOOLS().sort()));

// ---- scenario 3: fresh session that already has assistant msg (resume) ----
console.log("\n=== Scenario 3: resume with history → promoted immediately ===");
entries.push({ type: "message", message: { role: "assistant", content: "hi" } });
activeTools = [...ALL_TOOLS()];
await emit("session_start", { reason: "resume" });
check("resumed session starts promoted", JSON.stringify([...activeTools].sort()) === JSON.stringify(ALL_TOOLS().sort()), JSON.stringify(activeTools));
check("status shows promoted", statuses.get("pi-dsv4-booster")?.startsWith("promoted"));

// ---- scenario 4: promoteOn assistant-message (pure text first reply) ----
console.log("\n=== Scenario 4: pure-text first reply promotes ===");
// fresh state
entries.length = 0; appended.length = 0;
activeTools = [...ALL_TOOLS()];
await emit("session_start", { reason: "new" });
// set config via settings file? skip — use default either; simulate message_end
await emit("message_end", { message: { role: "assistant", content: "hello", toolCalls: undefined } });
check("assistant message promoted", appended.some((e) => e.data?.phase === "promoted" && e.data.via === "assistant-message"), JSON.stringify(appended));

// toolResult message_end must NOT promote anything new (already promoted — no crash)
await emit("message_end", { message: { role: "toolResult", toolName: "bash" } });

// ---- scenario 5: compaction entry means promoted ----
console.log("\n=== Scenario 5: compaction in history → promoted ===");
entries.length = 0;
entries.push({ type: "compaction", summary: "..." });
activeTools = [...ALL_TOOLS()];
await emit("session_start", { reason: "resume" });
check("compaction implies promoted", JSON.stringify([...activeTools].sort()) === JSON.stringify(ALL_TOOLS().sort()));

// ---- scenario 6: promoteOn "never" = minimal-only mode ----
console.log("\n=== Scenario 6: promoteOn never → stays minimal ===");
entries.length = 0; appended.length = 0;
activeTools = [...ALL_TOOLS()];
await emit("session_start", { reason: "new" });
// override config via settings file simulation: set promoteOn never by editing the loaded config through the settings file
import { writeFileSync, rmSync, mkdirSync } from "node:fs";
mkdirSync("/tmp/anchor-ab-test/.pi", { recursive: true });
writeFileSync("/tmp/anchor-ab-test/.pi/settings.json", JSON.stringify({ anchoredTools: { promoteOn: "never" } }));
await emit("session_start", { reason: "new" });
check("starts bootstrap", JSON.stringify(activeTools) === JSON.stringify(["bash", "str_replace_editor"]));
await emit("tool_execution_end", { toolCallId: "c1", toolName: "bash", result: "ok", isError: false });
await emit("message_end", { message: { role: "assistant", content: "hi" } });
check("never promotes on tool call", appended.length === 0, JSON.stringify(appended));
check("tools stay minimal", JSON.stringify(activeTools) === JSON.stringify(["bash", "str_replace_editor"]), JSON.stringify(activeTools));
rmSync("/tmp/anchor-ab-test/.pi/settings.json", { force: true });

// ---- scenario 7: models targeting (dbydd semantics) ----
console.log("\n=== Scenario 7: models filter — non-target model untouched ===");
entries.length = 0; appended.length = 0;
writeFileSync("/tmp/anchor-ab-test/.pi/settings.json", JSON.stringify({ anchoredTools: { models: ["claude-*"], enabled: true } }));
activeTools = [...ALL_TOOLS()];
await emit("session_start", { reason: "new" });
check("non-target model NOT restricted", JSON.stringify([...activeTools].sort()) === JSON.stringify(ALL_TOOLS().sort()), JSON.stringify(activeTools));
// payload untouched for non-target
const pay = { tools: ALL_TOOLS().map((n) => ({ name: n, type: "function", function: { name: n } })), messages: [{ role: "system", content: "pi default" }] };
const r7 = await emit("before_provider_request", { payload: pay });
check("non-target payload untouched", r7 === undefined, JSON.stringify(r7));
rmSync("/tmp/anchor-ab-test/.pi/settings.json", { force: true });

// ---- scenario 8: payload-layer fallback (dbydd) ----
console.log("\n=== Scenario 8: payload layer — tools filtered + persona rewrite ===");
entries.length = 0; appended.length = 0;
await emit("session_start", { reason: "new" });  // default config: all models
const pay8 = {
  tools: ALL_TOOLS().map((n) => ({ name: n, type: "function", function: { name: n } })),
  messages: [{ role: "system", content: "You are an expert coding assistant operating inside pi" }],
};
check("str_replace_editor registered in catalog", api.getAllTools().some((t) => t.name === "str_replace_editor"));
const r8 = await emit("before_provider_request", { payload: pay8 });
check("payload tools narrowed to bootstrap", r8 && JSON.stringify(r8.tools.map((t) => t.function.name).sort()) === JSON.stringify(["bash", "str_replace_editor"]), JSON.stringify(r8?.tools));
check("payload system rewritten to persona", r8 && r8.messages[0].content.includes("You are a helpful software engineer assistant."), r8 && r8.messages[0].content);

// ---- scenario 9: bootstrapMaxTokens via payload ----
console.log("\n=== Scenario 9: bootstrapMaxTokens cap ===");
writeFileSync("/tmp/anchor-ab-test/.pi/settings.json", JSON.stringify({ anchoredTools: { bootstrapMaxTokens: 1024 } }));
entries.length = 0;
await emit("session_start", { reason: "new" });
const pay9 = { tools: [], max_tokens: 256000, messages: [{ role: "system", content: "x" }] };
const r9 = await emit("before_provider_request", { payload: pay9 });
check("max_tokens capped at 1024", r9 && r9.max_tokens === 1024, JSON.stringify(r9));
rmSync("/tmp/anchor-ab-test/.pi/settings.json", { force: true });

// ---- scenario 10: dbydd compat config keys ----
console.log("\n=== Scenario 10: dbydd config keys (minimalSystemPrompt/notify) ===");
writeFileSync("/tmp/anchor-ab-test/.pi/settings.json", JSON.stringify({ piDsv4Booster: { minimalSystemPrompt: false, notify: false } }));
entries.length = 0;
await emit("session_start", { reason: "new" });
const r10 = await emit("before_agent_start", { systemPrompt: BASE_PROMPT, systemPromptOptions: {} });
check("minimalSystemPrompt:false keeps host prompt", r10 === undefined || r10.systemPrompt === undefined, JSON.stringify(r10));
rmSync("/tmp/anchor-ab-test/.pi/settings.json", { force: true });
// ---- scenario 11: legacy anchoredTools key still honored ----
console.log("\n=== Scenario 11: legacy anchoredTools config key ===");
entries.length = 0;
writeFileSync("/tmp/anchor-ab-test/.pi/settings.json", JSON.stringify({ anchoredTools: { promoteOn: "never" } }));
await emit("session_start", { reason: "new" });
check("legacy key honored (bootstrap)", JSON.stringify(activeTools) === JSON.stringify(["bash", "str_replace_editor"]), JSON.stringify(activeTools));
await emit("tool_execution_end", { toolCallId: "c1", toolName: "bash", result: "ok", isError: false });
check("legacy key honored (never promotes)", appended.length === 0, JSON.stringify(appended));
rmSync("/tmp/anchor-ab-test/.pi/settings.json", { force: true });
// ---- scenario 12: custom subagent prompt is preserved + persona prepended ----
console.log("\n=== Scenario 12: custom subagent prompt preserved ===");
entries.length = 0; appended.length = 0;
await emit("session_start", { reason: "new" }, childCtx);
const customPrompt = "You are an independent reviewer.\nNever modify files.";
const r12 = await emit("before_agent_start", { systemPrompt: customPrompt, systemPromptOptions: { customPrompt } }, childCtx);
check("subagent keeps custom role text", r12 && r12.systemPrompt.includes("You are an independent reviewer."), JSON.stringify(r12));
check("subagent gets minimal persona prefix", r12 && r12.systemPrompt.startsWith("You are a helpful software engineer assistant."), JSON.stringify(r12));
const pay12 = { tools: ALL_TOOLS().map((n) => ({ name: n, type: "function", function: { name: n } })), messages: [{ role: "system", content: customPrompt }] };
const r12b = await emit("before_provider_request", { payload: pay12 }, childCtx);
check("subagent payload keeps custom prompt", r12b && r12b.messages[0].content.includes("You are an independent reviewer."), JSON.stringify(r12b));
check("subagent payload prepends persona", r12b && r12b.messages[0].content.startsWith("You are a helpful software engineer assistant."), JSON.stringify(r12b));

// restore default state
await emit("session_start", { reason: "new" });

console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : failures + " FAILURES"}`);
process.exit(failures === 0 ? 0 : 1);
