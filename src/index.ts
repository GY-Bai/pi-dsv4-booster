/**
 * pi-dsv4-booster — "Anchored Standard" two-phase tool exposure for pi.
 *
 * Boosts DeepSeek V4 (DSv4) models in pi by porting the DeepSeek Harness
 * `dsh-anchored-standard` preset idea
 * (https://github.com/xiaobright/dsh-anchored-standard) to pi's extension API,
 * merged with the payload-layer approach of dbydd/pi-anchored-tool-for-dspro
 * (model targeting, fail-safe catalog filtering, per-request config reload).
 *
 * Problem: models (esp. DeepSeek V4 Pro) strongly steer their execution
 * trajectory from the tool catalog + persona visible in the FIRST request.
 * A fat tool list biases the first response toward "Let me..." tool-churn; a
 * minimal pair anchors it on "We need..." (DSH Project2: Standard 91/92 vs
 * Minimal 99/96 vs Anchored Standard 98/99). Staying minimal forever forfeits
 * the heavy tools, so the two-phase trick:
 *
 *   - Request #1 (bootstrap): only the DSH Minimal tool pair
 *     (bash + str_replace_editor) and the DSH Minimal persona
 *     ("You are a helpful software engineer assistant.",
 *     byte-identical, NOT reworded — the trajectory anchor). AGENTS.md
 *     project-context and the skill catalog never enter the prompt for
 *     target models. User-invoked skills (/skill:...) are NOT filtered —
 *     they arrive as messages and pass through untouched.
 *   - Promotion: the first durable tool execution (tool_execution_end) OR the
 *     first assistant message (message_end), whichever comes first
 *     (`promoteOn: either`), or never (`promoteOn: never` = pure minimal,
 *     the highest-scoring DSH configuration). Promotion restores the FULL
 *     active tool set for all subsequent requests; the minimal persona stays
 *     for the whole session (DSH `complete: true` semantics — only the tool
 *     catalog promotes).
 *   - Phase is derived from persisted session entries, so /resume and
 *     /reload do not lose state.
 *
 * Subagent sync: @tintinweb/pi-subagents embeds the parent's current system
 * prompt verbatim as the subagent's prompt prefix (append mode). Because the
 * bootstrap set has no Agent tool, a subagent can only ever be spawned after
 * promotion, so it inherits the minimal-persona prompt consistently. No extra
 * code needed.
 *
 * Implementation layers (belt and suspenders):
 *   - pi.setActiveTools() for the live active tool set (also drives the
 *     system prompt tool snippets and pi's deferred-loading logic).
 *   - before_provider_request payload rewrite as a hard fallback: narrows
 *     payload.tools to the bootstrap set while in bootstrap phase, applies
 *     bootstrapMaxTokens, and (in minimalSystemPrompt mode) rewrites the
 *     front system message to the DSH minimal persona for target models.
 *
 * Config lives in settings.json under the top-level `piDsv4Booster` key
 * (legacy `anchoredTools` key also accepted).
 * Global (~/.pi/agent/settings.json) is the base; a trusted project's
 * .pi/settings.json deep-merges over it (nested objects merge recursively,
 * arrays are replaced wholesale, project wins). Re-read on every event, so
 * edits take effect immediately.
 *
 *   {
 *     "piDsv4Booster": {
 *       "enabled": true,
 *       "models": [],                              // glob patterns; [] = all models
 *       "bootstrapTools": ["bash", "str_replace_editor"],
 *       "bootstrapPersona": "You are a helpful software engineer assistant.",
 *       "bootstrapCwdLine": true,
 *       "personaMode": "session",                  // "session" | "bootstrap-only"
 *       "minimalSystemPrompt": true,               // alias of personaMode: session
 *       "promoteOn": "either",                     // "either" | "tool-call" | "assistant-message" | "never"
 *       "suppressContextSources": ["contextFiles", "skills"],
 *       "bootstrapMaxTokens": null,                // optional first-request output cap
 *       "notify": true,                            // TUI notice on promotion
 *       "preserveCustomPrompt": false              // keep custom/subagent prompts and prepend persona
 *     }
 *   }
 */

import { readFileSync, existsSync } from "node:fs";
import { readFile, writeFile, readdir, stat, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { Type } from "typebox";
import {
  CONFIG_DIR_NAME,
  withFileMutationQueue,
  type BeforeAgentStartEvent,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

interface AnchoredConfig {
  enabled: boolean;
  /** Glob patterns against "provider/modelId" or bare modelId. [] = all models. */
  models: string[];
  bootstrapTools: string[];
  /** Minimal system prompt. null → strip-only mode. */
  bootstrapPersona: string | null;
  /** Append "Current working directory: <cwd>" to the bootstrap persona. */
  bootstrapCwdLine: boolean;
  /**
   * "session" (default, DSH semantics): persona permanent for the whole
   * session, only the tool catalog promotes.
   * "bootstrap-only": restore the host system prompt after promotion.
   */
  personaMode: "session" | "bootstrap-only";
  /** Alias kept for dbydd/pi-anchored-tool-for-dspro config compatibility. */
  minimalSystemPrompt: boolean;
  promoteOn: "either" | "tool-call" | "assistant-message" | "never";
  suppressContextSources: Array<"contextFiles" | "skills">;
  bootstrapMaxTokens: number | null;
  notify: boolean;
  /**
   * Keep custom/subagent system prompts and prepend the Minimal persona
   * instead of replacing the whole prompt.
   * - `true`: always preserve
   * - `false`: never preserve (replace with Minimal persona)
   * - `null`: auto — preserved for persisted child sessions with a custom
   *   prompt, replaced elsewhere
   */
  preserveCustomPrompt: boolean | null;
  /**
   * Per-agent overrides keyed by subagent type prefix (e.g. `kernel-dev`,
   * `reviewer`). Values are partial config keys merged over the base config
   * for that agent, letting different subagent roles use different persona
   * strategies.
   */
  agentOverrides: Record<string, Record<string, unknown>>;
  /** Console diagnostics for session-level behavior (subagent testing, etc). */
  debug: boolean;
}

const DEFAULT_CONFIG: AnchoredConfig = {
  enabled: true,
  models: [],
  // Byte-identical tool names to the official DeepSeek Harness minimal preset
  // (`bash` + `str_replace_editor`). `str_replace_editor` is registered by
  // this extension with the official schema + description.
  bootstrapTools: ["bash", "str_replace_editor"],
  // Official DeepSeek Harness Minimal persona (dsh-anchored-standard keeps it
  // byte-identical; `complete: true` means no harness identity/tool guidance
  // is appended — tool schemas live in the API payload only). The modeltest
  // trigger experiments showed paraphrasing it breaks the "We need" style.
  bootstrapPersona: "You are a helpful software engineer assistant.",
  bootstrapCwdLine: true,
  personaMode: "session",
  minimalSystemPrompt: true,
  promoteOn: "either",
  suppressContextSources: ["contextFiles", "skills"],
  bootstrapMaxTokens: null,
  notify: true,
  preserveCustomPrompt: null,
  agentOverrides: {},
  debug: false,
};

/** Keys that matter in the system prompt, keyed by their stable delimiters. */
const STRIP_PATTERNS: Record<string, RegExp> = {
  contextFiles:
    /\n{1,2}<project_context>[\s\S]*?<\/project_context>\n{0,2}/g,
  skills:
    /\n{1,2}The following skills provide specialized instructions[\s\S]*?<\/available_skills>\n{0,2}/g,
};

let config: AnchoredConfig = { ...DEFAULT_CONFIG };
let phase: "bootstrap" | "promoted" = "bootstrap";

// ---------------- config loading (pi multi-level override semantics) -------

function readSettingsJson(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function isMergeableObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deep merge with pi's settings semantics: nested objects merge, arrays replace. */
function deepMerge(base: unknown, overrides: unknown): unknown {
  if (!isMergeableObject(overrides)) {
    return overrides === undefined ? base : overrides;
  }
  if (!isMergeableObject(base)) {
    return structuredClone(overrides);
  }
  const result: Record<string, unknown> = { ...base };
  for (const key of Object.keys(overrides)) {
    const overrideValue = overrides[key];
    if (overrideValue === undefined) continue;
    result[key] =
      isMergeableObject(result[key]) && isMergeableObject(overrideValue)
        ? deepMerge(result[key], overrideValue)
        : overrideValue;
  }
  return result;
}

function extractRaw(root: Record<string, unknown> | undefined): Record<string, unknown> {
  // Primary key `piDsv4Booster`; legacy `anchoredTools` accepted as fallback.
  const value = root?.piDsv4Booster ?? root?.anchoredTools;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Global settings as base; trusted project settings deep-merge over it. */
function loadConfig(ctx: ExtensionContext): void {
  const globalRaw = extractRaw(readSettingsJson(join(homedir(), ".pi", "agent", "settings.json")));
  let projectRaw: Record<string, unknown> = {};
  if (ctx.isProjectTrusted()) {
    projectRaw = extractRaw(readSettingsJson(join(ctx.cwd, CONFIG_DIR_NAME, "settings.json")));
  }
  const merged = deepMerge(globalRaw, projectRaw) as Record<string, unknown>;
  const raw = merged as Partial<AnchoredConfig>;
  config = {
    ...DEFAULT_CONFIG,
    ...raw,
    models: Array.isArray(raw.models) ? [...new Set(raw.models)] : DEFAULT_CONFIG.models,
    bootstrapTools:
      Array.isArray(raw.bootstrapTools) && raw.bootstrapTools.length > 0
        ? [...new Set(raw.bootstrapTools)]
        : DEFAULT_CONFIG.bootstrapTools,
    bootstrapPersona:
      raw.bootstrapPersona === null || raw.bootstrapPersona === undefined
        ? DEFAULT_CONFIG.bootstrapPersona
        : raw.bootstrapPersona,
    personaMode:
      raw.personaMode === "bootstrap-only" ? "bootstrap-only" : "session",
    preserveCustomPrompt:
      typeof raw.preserveCustomPrompt === "boolean" ? raw.preserveCustomPrompt : null,
  };
  // minimalSystemPrompt compat: false disables the persona entirely
  // (keep pi's default system prompt) — unless bootstrapPersona was EXPLICITLY
  // configured in the winning (project) layer.
  const explicitProjectPersona = projectRaw.bootstrapPersona !== undefined;
  if (raw.minimalSystemPrompt === false && !explicitProjectPersona) {
    config.bootstrapPersona = null;
    // dbydd semantics: "keep pi's default system prompt" — also disable
    // strip-only filtering unless the project layer explicitly configured it.
    if (projectRaw.suppressContextSources === undefined) {
      config.suppressContextSources = [];
    }
  }

  // Per-agent overrides: pi-subagents name sessions like `kernel-dev#abc123`;
  // match the type prefix and merge partial config keys for that agent only.
  const agentName = ctx.sessionManager.getSessionName() ?? "";
  const agentKey = agentName.split("#")[0];
  const override = config.agentOverrides?.[agentKey];
  if (override && typeof override === "object") {
    config = {
      ...config,
      ...override,
      models: Array.isArray(override.models) ? [...new Set(override.models)] : config.models,
      bootstrapTools:
        Array.isArray(override.bootstrapTools) && override.bootstrapTools.length > 0
          ? [...new Set(override.bootstrapTools)]
          : config.bootstrapTools,
      bootstrapPersona:
        override.bootstrapPersona === null || override.bootstrapPersona === undefined
          ? config.bootstrapPersona
          : override.bootstrapPersona,
      personaMode:
        override.personaMode === "bootstrap-only" ? "bootstrap-only" : config.personaMode,
      suppressContextSources:
        Array.isArray(override.suppressContextSources)
          ? [...new Set(override.suppressContextSources)]
          : config.suppressContextSources,
      preserveCustomPrompt:
        typeof override.preserveCustomPrompt === "boolean"
          ? override.preserveCustomPrompt
          : config.preserveCustomPrompt,
    };
  }
}

// ---------------- model targeting (dbydd semantics) -------------------------

/** Minimal '*' glob match (case-insensitive). Non-glob patterns compare exactly. */
export function matchGlob(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  if (!pattern.includes("*")) return pattern.toLowerCase() === value.toLowerCase();
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(value);
}

/**
 * Does this model match any configured pattern?
 * Patterns containing "/" match "provider/modelId"; bare patterns match
 * "provider/modelId" or the bare modelId.
 */
export function modelMatches(modelId: string, provider: string, patterns: string[]): boolean {
  if (patterns.length === 0) return true; // [] = all models (this extension's default)
  const qualified = `${provider}/${modelId}`;
  return patterns.some((p) =>
    p.includes("/") ? matchGlob(p, qualified) : matchGlob(p, qualified) || matchGlob(p, modelId),
  );
}

function isTarget(ctx: ExtensionContext): boolean {
  if (!config.enabled) return false;
  if (!ctx.model) return false;
  return modelMatches(ctx.model.id, ctx.model.provider, config.models);
}

/** Persisted child sessions (pi-subagents, forks, etc.) carry a parentSession. */
function isChildSession(ctx: ExtensionContext): boolean {
  return Boolean(ctx.sessionManager.getHeader()?.parentSession);
}

/**
 * Whether to preserve the current custom system prompt and prepend the Minimal
 * persona instead of replacing the whole prompt.
 *
 * The default is NOT to preserve: every subagent starts with the pure Minimal
 * persona so the trajectory anchor is not diluted by a role prompt. Role
 * instructions are restored after promotion (bootstrap-only for children).
 * Set `preserveCustomPrompt: true` only for agents that must keep their role
 * text visible from the very first request.
 */
function shouldPreserveCustomPrompt(ctx: ExtensionContext, _customPrompt?: string): boolean {
  return config.preserveCustomPrompt === true;
}

/**
 * Persona lifetime for the current session.
 *
 * Subagents default to `bootstrap-only`: pure Minimal persona on request #1,
 * then the host/custom prompt is restored after promotion. The main agent
 * keeps the configured `personaMode` (default `session`).
 */
function effectivePersonaMode(ctx: ExtensionContext): "session" | "bootstrap-only" {
  if (config.personaMode === "bootstrap-only") return "bootstrap-only";
  if (isChildSession(ctx) && config.preserveCustomPrompt !== true) return "bootstrap-only";
  return "session";
}

/** Whether the Minimal persona should be applied for this request. */
function shouldApplyPersona(ctx: ExtensionContext): boolean {
  if (!config.bootstrapPersona) return false;
  if (effectivePersonaMode(ctx) === "bootstrap-only" && phase !== "bootstrap") return false;
  return true;
}

// ---------------- phase derivation (resume-safe) ----------------------------

/** Derive phase from persisted session entries (DSH-style, from durable events). */
function derivePhase(ctx: ExtensionContext): "bootstrap" | "promoted" {
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type === "compaction") return "promoted";
    if (entry.type !== "message") continue;
    const m = (entry as { message?: { role?: string; content?: unknown[] } }).message;
    if (!m) continue;
    if (m.role === "assistant" || m.role === "toolResult") return "promoted";
    // dbydd precision: assistant content with toolCall blocks also promotes.
    if (m.role === "assistant" && Array.isArray(m.content)) {
      if (m.content.some((c) => (c as { type?: string })?.type === "toolCall")) return "promoted";
    }
  }
  return "bootstrap";
}

/** Fail-safe: only restrict when every bootstrap tool exists in the catalog. */
function applyToolPhase(pi: ExtensionAPI): void {
  if (phase === "bootstrap") {
    const all = new Set(pi.getAllTools().map((t) => t.name));
    const missing = config.bootstrapTools.filter((n) => !all.has(n));
    if (missing.length > 0) {
      console.warn(
        `[pi-dsv4-booster] bootstrap tools missing from catalog: ${missing.join(", ")}; ` +
          `skipping tool restriction`,
      );
      return;
    }
    pi.setActiveTools([...config.bootstrapTools]);
  } else {
    const all = pi.getAllTools().map((t) => t.name);
    pi.setActiveTools([...all]);
  }
}

function stripInjected(systemPrompt: string): string {
  let out = systemPrompt;
  if (config.suppressContextSources.includes("contextFiles")) {
    out = out.replace(STRIP_PATTERNS.contextFiles, "\n");
  }
  if (config.suppressContextSources.includes("skills")) {
    out = out.replace(STRIP_PATTERNS.skills, "\n");
  }
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

function promote(pi: ExtensionAPI, ctx: ExtensionContext, via: string): void {
  if (phase !== "bootstrap") return;
  phase = "promoted";
  applyToolPhase(pi);
  try {
    pi.appendEntry("pi-dsv4-booster", { phase: "promoted", via, at: Date.now() });
  } catch {
    // non-fatal
  }
  if (config.notify && ctx.hasUI) {
    ctx.ui.notify(`pi-dsv4-booster: promoted (${via}) — full tools restored`, "info");
  }
}

// ---------------- payload-layer helpers (dbydd semantics) -------------------

interface ToolLike {
  name?: string;
  type?: string;
  function?: { name?: string };
  custom?: { name?: string };
}

function toolName(t: ToolLike): string | undefined {
  if (t.type === "function" && t.function?.name) return t.function.name;
  if (t.type === "custom" && t.custom?.name) return t.custom.name;
  return t.name;
}

/** Rewrite the front system/developer message to the minimal persona. */
function rewriteSystemPrompt(payload: Record<string, unknown>, text: string): boolean {
  if (typeof payload.system === "string" && payload.system !== text) {
    payload.system = text;
    return true;
  }
  const messages = payload.messages;
  if (!Array.isArray(messages) || messages.length === 0) return false;
  const first = messages[0];
  if (typeof first !== "object" || first === null) return false;
  const m = first as Record<string, unknown>;
  if (m.role !== "system" && m.role !== "developer") return false;
  if (typeof m.content !== "string" || m.content === text) return false;
  m.content = text;
  return true;
}

/** Prepend the Minimal persona to the existing system prompt (idempotent). */
function prependSystemPrompt(payload: Record<string, unknown>, text: string): boolean {
  const apply = (content: string): string => {
    if (content.startsWith(text)) return content;
    return `${text}\n\n${content}`;
  };

  if (typeof payload.system === "string") {
    const updated = apply(payload.system);
    if (updated !== payload.system) {
      payload.system = updated;
      return true;
    }
    return false;
  }

  const messages = payload.messages;
  if (!Array.isArray(messages) || messages.length === 0) return false;
  const first = messages[0];
  if (typeof first !== "object" || first === null) return false;
  const m = first as Record<string, unknown>;
  if (m.role !== "system" && m.role !== "developer") return false;
  if (typeof m.content !== "string") return false;
  const updated = apply(m.content);
  if (updated === m.content) return false;
  m.content = updated;
  return true;
}

// ---------------- str_replace_editor (DSH minimal's second tool) ------------
// Official definition from deepseek-ai/deepseek-harness
// packages/fs/tool-str-replace-editor/src/index.ts (minimal preset): same
// name, same parameter schema, same description, same semantics.

const STR_REPLACE_EDITOR_DESCRIPTION = `Custom editing tool for viewing, creating and editing files
* State is persistent across command calls and discussions with the user
* If \`path\` is a file, \`view\` displays the result of applying \`cat -n\`. If \`path\` is a directory, \`view\` lists non-hidden files and directories up to 2 levels deep
* The \`create\` command cannot be used if the specified \`path\` already exists as a file
* If a \`command\` generates a long output, it will be truncated and marked with \`<response clipped>\`

Notes for using the \`str_replace\` command:
* The \`old_str\` parameter should match EXACTLY one or more consecutive lines from the original file. Be mindful of whitespaces!
* If the \`old_str\` parameter is not unique in the file, the replacement will not be performed. Make sure to include enough context in \`old_str\` to make it unique
* The \`new_str\` parameter should contain the edited lines that should replace the \`old_str\``;

const MAX_OUTPUT_CHARS = 16_000; // official maxOutputChars

function maybeTruncate(content: string): string {
  return content.length <= MAX_OUTPUT_CHARS
    ? content
    : content.slice(0, MAX_OUTPUT_CHARS) + "\n<response clipped>";
}

/** Resolve a path (absolute or relative to cwd) and normalize. */
function resolveTarget(raw: string, cwd: string): string {
  return resolve(cwd, raw);
}

async function viewPath(target: string, viewRange: number[] | undefined, execCwd: string): Promise<string> {
  const st = await stat(target);
  if (st.isDirectory()) {
    const lines: string[] = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true });
      const visible = entries
        .filter((e) => !e.name.startsWith("."))
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const e of visible) {
        lines.push(`${e.name}${e.isDirectory() ? "/" : ""}`);
        if (e.isDirectory() && depth < 2) {
          await walk(join(dir, e.name), depth + 1);
        }
      }
    };
    await walk(target, 0);
    return maybeTruncate(lines.join("\n"));
  }
  const text = await readFile(target, "utf8");
  const lines = text.split("\n");
  let start = 1;
  let end = lines.length;
  if (viewRange && viewRange.length > 0) {
    start = Math.max(1, viewRange[0]);
    end = viewRange.length > 1 && viewRange[1] !== -1 ? Math.min(lines.length, viewRange[1]) : lines.length;
  }
  const numbered = lines
    .slice(start - 1, end)
    .map((l, i) => `${String(start + i).padStart(6)}\t${l}`)
    .join("\n");
  return maybeTruncate(numbered);
}

function findOffsets(haystack: string, needle: string): number[] {
  const offsets: number[] = [];
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    offsets.push(idx);
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return offsets;
}

function lineNumberAt(text: string, offset: number): number {
  return text.slice(0, offset).split("\n").length;
}

/**
 * Register the official `str_replace_editor` tool. Name/schema/description
 * mirror the DeepSeek Harness minimal preset; commands view/create/
 * str_replace/insert are implemented over pi's local filesystem with the
 * same failure semantics (unique-match-only replace, clipped output).
 */
function registerStrReplaceEditor(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "str_replace_editor",
    label: "Str Replace Editor",
    description: STR_REPLACE_EDITOR_DESCRIPTION,
    parameters: Type.Object({
      command: Type.String({
        description: "The commands to run. Allowed options are: `view`, `create`, `str_replace`, `insert`.",
      }),
      path: Type.String({
        description: "Absolute path to file or directory, e.g. `/repo/file.py` or `/repo`.",
      }),
      file_text: Type.Optional(
        Type.String({
          description: "Required parameter of `create` command, with the content of the file to be created.",
        }),
      ),
      insert_line: Type.Optional(
        Type.Integer({
          description: "Required parameter of `insert` command. The `new_str` will be inserted AFTER the line `insert_line` of `path`.",
        }),
      ),
      new_str: Type.Optional(
        Type.String({
          description:
            "Optional parameter of `str_replace` command containing the new string (if not given, no string will be added). Required parameter of `insert` command containing the string to insert.",
        }),
      ),
      old_str: Type.Optional(
        Type.String({
          description: "Required parameter of `str_replace` command containing the string in `path` to replace.",
        }),
      ),
      view_range: Type.Optional(
        Type.Array(Type.Integer(), {
          description:
            "Optional parameter of `view` command when `path` points to a file. If none is given, the full file is shown. If provided, the file will be shown in the indicated line number range, e.g. [11, 12] will show lines 11 and 12. Indexing at 1 to start. Setting `[start_line, -1]` shows all lines from `start_line` to the end of the file.",
        }),
      ),
    }),
    async execute(
      toolCallId,
      params: {
        command: string;
        path: string;
        file_text?: string;
        insert_line?: number;
        new_str?: string;
        old_str?: string;
        view_range?: number[];
      },
      _signal,
      _onUpdate,
      ctx,
    ) {
      const target = resolveTarget(params.path, ctx.cwd);
      const displayPath = target.replace(/\\/g, "/");
      const cmd = params.command;

      switch (cmd) {
        case "view": {
          const out = await viewPath(target, params.view_range, ctx.cwd);
          return { content: [{ type: "text", text: out }], details: {} };
        }
        case "create": {
          return withFileMutationQueue(target, async () => {
            if (existsSync(target)) {
              throw new Error(`cannot create \`${displayPath}\`: file already exists`);
            }
            await mkdir(dirname(target), { recursive: true });
            await writeFile(target, params.file_text ?? "", "utf8");
            return {
              content: [{ type: "text", text: `New file created successfully at: ${displayPath}` }],
              details: {},
            };
          });
        }
        case "str_replace": {
          if (params.old_str === undefined) {
            throw new Error("Parameter `old_str` is required for command: str_replace");
          }
          return withFileMutationQueue(target, async () => {
            const before = await readFile(target, "utf8");
            const offsets = findOffsets(before, params.old_str!);
            const offset = offsets[0];
            if (offset === undefined) {
              throw new Error(
                `No replacement was performed, old_str \`${params.old_str}\` did not appear verbatim in ${displayPath}.`,
              );
            }
            if (offsets.length > 1) {
              const lines = offsets.map((o) => lineNumberAt(before, o)).join(", ");
              throw new Error(
                `No replacement was performed. Multiple occurrences of old_str \`${params.old_str}\` in lines [${lines}]. Please ensure it is unique`,
              );
            }
            const newValue = params.new_str ?? "";
            await writeFile(target, before.slice(0, offset) + newValue + before.slice(offset + params.old_str!.length), "utf8");
            return {
              content: [{ type: "text", text: `The file ${displayPath} has been edited successfully.` }],
              details: {},
            };
          });
        }
        case "insert": {
          if (params.insert_line === undefined) {
            throw new Error("Parameter `insert_line` is required for command: insert");
          }
          if (params.new_str === undefined) {
            throw new Error("Parameter `new_str` is required for command: insert");
          }
          return withFileMutationQueue(target, async () => {
            const before = await readFile(target, "utf8");
            const lines = before.split("\n");
            const idx = Math.max(0, Math.min(lines.length, params.insert_line!));
            lines.splice(idx, 0, params.new_str!);
            await writeFile(target, lines.join("\n"), "utf8");
            return {
              content: [{ type: "text", text: `The file ${displayPath} has been edited successfully.` }],
              details: {},
            };
          });
        }
        default:
          throw new Error(
            `Invalid command \`${cmd}\`. Allowed options are: view, create, str_replace, insert.`,
          );
      }
    },
  });
}

// ============================================================================

export default function (pi: ExtensionAPI) {
  registerStrReplaceEditor(pi);
  pi.on("session_start", async (event, ctx) => {
    loadConfig(ctx);
    if (config.debug) {
      console.log(
        `[pi-dsv4-booster] session_start reason=${(event as { reason?: string }).reason} ` +
          `cwd=${ctx.cwd} model=${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "n/a"} ` +
          `entries=${ctx.sessionManager.getEntries().length}`,
      );
    }
    if (!config.enabled) return;
    phase = derivePhase(ctx);
    if (isTarget(ctx)) {
      applyToolPhase(pi);
    } else {
      const all = pi.getAllTools().map((t) => t.name);
      pi.setActiveTools([...all]);
    }
    if (config.debug) {
      console.log(
        `[pi-dsv4-booster]   -> phase=${phase} active=${pi.getActiveTools().join(",")}`,
      );
    }
    if (ctx.hasUI) {
      ctx.ui.setStatus(
        "pi-dsv4-booster",
        !isTarget(ctx)
          ? "not targeted"
          : phase === "bootstrap"
            ? `bootstrap: ${config.bootstrapTools.join("+")}`
            : "promoted: full tools",
      );
    }
  });

  pi.on("session_shutdown", () => {
    // Phase state is re-derived from session entries on the next session_start.
  });

  // Minimal persona for the whole session (DSH persona.complete:true
  // semantics — only the tool catalog promotes), or strip-only mode.
  pi.on("before_agent_start", async (event: BeforeAgentStartEvent, ctx) => {
    loadConfig(ctx);
    if (!config.enabled || !isTarget(ctx)) return;
    if (!shouldApplyPersona(ctx)) return;
    if (config.bootstrapPersona) {
      const persona = config.bootstrapPersona.trim();
      if (shouldPreserveCustomPrompt(ctx, event.systemPromptOptions.customPrompt)) {
        return { systemPrompt: `${persona}\n\n${event.systemPrompt}` };
      }
      const cwdLine = config.bootstrapCwdLine
        ? `\n\nCurrent working directory: ${ctx.cwd.replace(/\\/g, "/")}`
        : "";
      return { systemPrompt: persona + cwdLine };
    }
    if (phase !== "bootstrap") return;
    if (config.suppressContextSources.length === 0) return;
    const stripped = stripInjected(event.systemPrompt);
    if (stripped !== event.systemPrompt) {
      return { systemPrompt: stripped };
    }
    return;
  });

  // Promotion signal 1: first durable tool execution.
  pi.on("tool_execution_end", async (event, ctx) => {
    loadConfig(ctx);
    if (config.debug) {
      console.log(
        `[pi-dsv4-booster] tool_execution_end ${(event as { toolName?: string }).toolName} phase=${phase} enabled=${config.enabled}`,  
      );
    }
    if (!config.enabled || !isTarget(ctx) || phase !== "bootstrap") return;
    if (config.promoteOn === "assistant-message" || config.promoteOn === "never") return;
    promote(pi, ctx, "tool-call");
  });

  // Promotion signal 2: first assistant message (pure-text first reply).
  pi.on("message_end", async (event, ctx) => {
    loadConfig(ctx);
    if (!config.enabled || !isTarget(ctx) || phase !== "bootstrap") return;
    if (config.promoteOn === "tool-call" || config.promoteOn === "never") return;
    if (event.message.role !== "assistant") return;
    promote(pi, ctx, "assistant-message");
  });

  // Payload-layer hard fallback (dbydd approach) + optional bootstrap cap:
  //   - target models: rewrite front system message to the minimal persona
  //   - bootstrap phase: narrow payload.tools to the bootstrap set (fail-safe)
  //   - bootstrap phase: optional max_tokens cap
  pi.on("before_provider_request", (event, ctx) => {
    loadConfig(ctx);
    if (!config.enabled || !isTarget(ctx)) return;

    const payload = event.payload as Record<string, unknown> | null | undefined;
    if (!payload || typeof payload !== "object") return;
    let changed = false;

    if (config.debug) {
      const tools = (payload.tools as Array<{ type?: string; function?: { name?: string }; name?: string }> | undefined)
        ?.map((t) => t.function?.name ?? t.name)
        .join(",");
      console.log(
        `[pi-dsv4-booster] provider_request phase=${phase} tools=[${tools}] max_tokens=${payload.max_tokens}`,
      );
    }

    // Persona (only when no before_agent_start persona override is in play —
    // both paths converge on the same text, payload rewrite is the fallback).
    if (config.bootstrapPersona && shouldApplyPersona(ctx)) {
      if (shouldPreserveCustomPrompt(ctx)) {
        if (prependSystemPrompt(payload, config.bootstrapPersona)) changed = true;
      } else {
        if (rewriteSystemPrompt(payload, config.bootstrapPersona)) changed = true;
      }
    }

    const tools = payload.tools;
    if (Array.isArray(tools) && tools.length > 0 && phase === "bootstrap") {
      const available = new Set(tools.map((t) => toolName(t as ToolLike)));
      const missing = config.bootstrapTools.filter((n) => !available.has(n));
      if (missing.length === 0) {
        const filtered = (tools as ToolLike[]).filter((t) =>
          config.bootstrapTools.includes(toolName(t) ?? ""),
        );
        if (filtered.length !== tools.length) {
          payload.tools = filtered;
          changed = true;
        }
      } else {
        console.warn(
          `[pi-dsv4-booster] bootstrap tools missing from payload catalog: ${missing.join(", ")}; ` +
            `skipping tool filter`,
        );
      }
    }

    if (phase === "bootstrap" && config.bootstrapMaxTokens) {
      const hasTokens =
        typeof payload.max_tokens === "number" ||
        typeof payload.max_completion_tokens === "number";
      if (hasTokens && payload.max_tokens !== config.bootstrapMaxTokens) {
        payload.max_tokens = config.bootstrapMaxTokens;
        changed = true;
      }
    }

    if (config.debug) {
      const after = (payload.tools as Array<{ type?: string; function?: { name?: string }; name?: string }> | undefined)
        ?.map((t) => t.function?.name ?? t.name)
        .join(",");
      console.log(
        `[pi-dsv4-booster]   -> after phase=${phase} tools=[${after}] changed=${changed}`,
      );
    }

    return changed ? payload : undefined;
  });

  const showStatus = async (args: string, ctx: ExtensionContext) => {
    const arg = (args ?? "").trim().toLowerCase();
    if (arg === "promote") {
      promote(pi, ctx, "manual");
      ctx.ui.notify("pi-dsv4-booster: promoted manually", "info");
      return;
    }
    const matched = isTarget(ctx);
    const lines = [
      `pi-dsv4-booster: phase=${phase}`,
      `  enabled: ${config.enabled}`,
      `  target models: ${config.models.join(", ") || "(all models)"}`,
      `  current model: ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "n/a"} (matched: ${matched ? "yes" : "no"})`,
      `  bootstrapTools: ${config.bootstrapTools.join(", ")}`,
      `  bootstrapPersona: ${config.bootstrapPersona ? JSON.stringify(config.bootstrapPersona) : "(strip-only)"}`,
      `  personaMode: ${config.personaMode}`,
      `  promoteOn: ${config.promoteOn}`,
      `  suppressContextSources: ${config.suppressContextSources.join(", ") || "(none)"}`,
      `  bootstrapMaxTokens: ${config.bootstrapMaxTokens ?? "unset"}`,
      `  notify: ${config.notify}`,
      `  preserveCustomPrompt: ${config.preserveCustomPrompt}`,
      `  active: ${pi.getActiveTools().join(", ")}`,
    ];
    ctx.ui.notify(lines.join("\n"), "info");
  };

  pi.registerCommand("pi-dsv4-booster", {
    description: "pi-dsv4-booster: show phase / config, or promote manually",
    handler: showStatus,
  });
  // Legacy aliases (anchored-tools / dbydd naming).
  pi.registerCommand("anchored", {
    description: "pi-dsv4-booster (legacy alias): show phase / config",
    handler: showStatus,
  });
  pi.registerCommand("anchored-tools", {
    description: "pi-dsv4-booster (legacy alias): show phase / config",
    handler: showStatus,
  });
}
