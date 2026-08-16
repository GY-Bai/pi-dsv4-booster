# pi-dsv4-booster

<p align="center">
  <img src="docs/social-preview.jpg" alt="pi-dsv4-booster banner" width="100%">
</p>

> **Boosts DeepSeek V4 (DSv4) models in pi** — anchors the first request on the
> DeepSeek Harness **Minimal** condition, then promotes to the full tool catalog
> after the first durable tool call.

🌐 **English** | [中文](./README.zh-CN.md)

A pi port of the DeepSeek Harness community preset
[`xiaobright/dsh-anchored-standard`](https://github.com/xiaobright/dsh-anchored-standard),
merged with the payload-layer approach from
[`dbydd/pi-anchored-tool-for-dspro`](https://github.com/dbydd/pi-anchored-tool-for-dspro).

The goal is to let DSv4 models in pi enjoy the RL-aligned **Minimal trajectory
benefit** without losing any tool capability.

---

## Why

DeepSeek V4 models strongly steer their execution trajectory from the **tool
catalog and system prompt visible in the first request** (modeltest trigger
experiments, issue #11):

| Condition | First-turn trajectory | Project2 score |
|---|---|---|
| Standard (25 tools + full prompt) | `Let me...` standard-like | 91 |
| PTC | `Let me` | 92 |
| **Minimal (2 tools + one-line persona)** | `We need...` minimal-like | **99 / 96** |
| **Anchored (Minimal first, then promote)** | `We need` first, no regression after promotion | **98 / 99** |

The tool catalog is a **trajectory selector**: it is supposed to tell the model
"what tools are available", but on DSv4 it also decides "which kind of thinking
to use". This extension separates those two RL-bound variables with an
engineering trick — **anchor the first request on the Minimal trajectory, then
restore full capability after promotion**.

## How it works

```
First user message (new session)
        │
        ▼
┌ Request #1 ─ bootstrap phase ─────────────────────────────┐
│ Tools  : bash + str_replace_editor                        │
│          (byte-identical names to the official minimal    │
│           preset; str_replace_editor is a full local      │
│           implementation registered by this extension)    │
│ Prompt : Minimal persona overrides the whole system prompt│
│          "You are a helpful software engineer assistant." │
│          (DSH original text — do not reword)              │
│ Inject : AGENTS.md / skill catalog stay out of the prompt │
│ Budget : bootstrapMaxTokens (optional)                    │
└───────────────────────────────────────────────────────────┘
        │ first durable tool call or first assistant message
        ▼ (derived from persisted session entries — resume safe)
┌ Request #2+ ─ promoted phase ─────────────────────────────┐
│ Tools  : full active set (built-in + all extension tools,  │
│          including Agent/subagent, web_search, etc.)       │
│ Prompt : Minimal persona is kept for the whole session     │
│          (DSH complete: true semantics; only the tool      │
│          catalog promotes)                                 │
└────────────────────────────────────────────────────────────┘
```

### Three levers (all aligned with DSH)

1. **Tool schema** — the first request really exposes the Minimal tool pair
   (`bash` + `str_replace_editor`), byte-identical to the official minimal
   preset names.
2. **Persona** — the system prompt is replaced by the DSH Minimal original from
   the first request (`complete: true` semantics: it stays for the whole
   session; only the tool catalog promotes). Modeltest showed that **rephrasing
   the persona breaks the `We need` style**, so the text is intentionally not
   configurable for rewording (`bootstrapPersona` may be set to `null` to fall
   back to strip-only mode).
3. **Injection stripping** — AGENTS.md (`<project_context>`) and the skill
   catalog (`<available_skills>`) do not enter the prompt. User-invoked
   `/skill:` gestures are not filtered.

### Promotion signals

- `promoteOn: "either"` (default): first durable tool execution **or** first
  assistant message, whichever comes first.
- `promoteOn: "tool-call"`: only a tool call promotes (a pure-text first answer
  does not).
- `promoteOn: "assistant-message"`: only a message promotes.
- `promoteOn: "never"`: **pure minimal mode** — never promotes (DSH highest
  score tier 99/96, at the cost of only two tools).

### Subagents automatically inherit ✅

pi-subagents' append mode embeds the parent agent's system prompt verbatim as
the subagent's prompt prefix. Each subagent is also an **independent session +
independent extension instance + independent phase**, so every spawn is a
complete anchored session: bootstrap (first request again limited to `bash` +
`str_replace_editor`) → promote → full tools. This has been verified with debug
logs: the subagent's first payload is filtered to
`[bash, str_replace_editor]`, then restored after its first tool call. This is
stronger than DSH's `includeSubagents` — **zero extra anchor-round cost**.

Custom subagents that use `prompt_mode: replace` (for example a `Reviewer`
agent with its own role instructions) keep their custom system prompt. In that
case the extension detects the child session + custom prompt and **prepends**
the Minimal persona instead of replacing the whole prompt, while still applying
the bootstrap tool filter. This lets specialized agents benefit from the
anchored trajectory without losing their role instructions.

## Installation

```sh
pi install git:github.com/GY-Bai/pi-dsv4-booster
# or with a version pin:
pi install git:github.com/GY-Bai/pi-dsv4-booster@v0.1.0
```

Restart pi or run `/reload`, then start a new session with `/new` to experience
the bootstrap → promote flow.

> If you previously installed the older `anchored-tools` global extension,
> remove it to avoid duplication:
> `rm -rf ~/.pi/agent/extensions/anchored-tools`

## Configuration

Settings are read from `~/.pi/agent/settings.json` (global base) or a trusted
project's `.pi/settings.json` (deep-merge override: nested objects merge,
arrays are replaced wholesale, project wins). **Config is re-read on every
event**, so edits take effect immediately.

```json
{
  "piDsv4Booster": {
    "enabled": true,
    "models": ["deepseek/*", "*/deepseek-*"],
    "bootstrapTools": ["bash", "str_replace_editor"],
    "bootstrapPersona": "You are a helpful software engineer assistant.",
    "bootstrapCwdLine": true,
    "personaMode": "session",
    "minimalSystemPrompt": true,
    "promoteOn": "either",
    "suppressContextSources": ["contextFiles", "skills"],
    "bootstrapMaxTokens": null,
    "notify": true,
    "preserveCustomPrompt": null,
    "agentOverrides": {
      "kernel-dev": {
        "preserveCustomPrompt": false,
        "personaMode": "bootstrap-only"
      },
      "reviewer": {
        "preserveCustomPrompt": false,
        "personaMode": "bootstrap-only"
      }
    },
    "debug": false
  }
}
```

> Compatibility: the legacy key `anchoredTools` is still recognized
> (`piDsv4Booster` takes precedence).

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch. |
| `models` | `[]` | Glob target models (`"deepseek/*"`, `"*/deepseek-v4-pro"`, bare `"deepseek-v4-pro"`); `[]` = all models. Note: this is the opposite of dbydd's original `[]` = no models. |
| `bootstrapTools` | `["bash","str_replace_editor"]` | Request #1 tools — byte-identical names to the DSH Minimal pair; missing tools fail safe and skip restriction. |
| `bootstrapPersona` | `"You are a helpful software engineer assistant."` | Minimal persona (DSH original, do not reword); `null` falls back to strip-only mode. |
| `bootstrapCwdLine` | `true` | Append `Current working directory: <cwd>` after the persona. |
| `personaMode` | `"session"` | `session` (persona stays for the whole session) / `bootstrap-only` (restore host prompt after promotion). |
| `minimalSystemPrompt` | `true` | dbydd-compatible key; when `false` and no explicit project `bootstrapPersona`, disables the persona and leaves the host prompt untouched. |
| `promoteOn` | `"either"` | `either` / `tool-call` / `assistant-message` / `never` (pure minimal). |
| `suppressContextSources` | `["contextFiles","skills"]` | Injection sections stripped in strip mode; `[]` disables. |
| `bootstrapMaxTokens` | `null` | Optional output cap for request #1 (rewrites `max_tokens`). |
| `notify` | `true` | Show a TUI notification on promotion. |
| `preserveCustomPrompt` | `null` | `true` always keep custom/subagent prompts and prepend the Minimal persona; `false` always replace with the Minimal persona; `null` auto — preserve for persisted child sessions with a custom prompt, replace elsewhere. |
| `agentOverrides` | `{}` | Per-agent overrides keyed by subagent type prefix (e.g. `kernel-dev`). Values are partial config keys merged for that agent only, useful for giving different subagent roles different persona strategies. |
| `debug` | `false` | Console diagnostics (session/phase/payload before/after filtering). |

## Commands

- `/pi-dsv4-booster` — show phase, config, model matching, and active tools.
- `/pi-dsv4-booster promote` — promote manually.
- Legacy aliases: `/anchored`, `/anchored-tools`.

## `str_replace_editor` (DSH Minimal's second tool)

`str_replace_editor` is registered by this extension. Its **name, parameter
schema, description, and semantics match the official
`@deepseek-ai/dsh-tool-str-replace-editor`** (minimal preset):

- Parameters: `command` (`view` / `create` / `str_replace` / `insert`),
  `path`, `file_text`, `old_str`, `new_str`, `insert_line`, `view_range`.
- `view`: `cat -n` formatting (6-digit line numbers + Tab); directories list
  non-hidden entries up to 2 levels deep; supports line ranges.
- `str_replace`: **unique-match only**; multiple matches error with conflicting
  line numbers; zero matches error.
- `insert`: inserts after `insert_line`.
- `create`: errors if the file already exists.
- Output is truncated at 16,000 chars (`<response clipped>`).
- Error messages follow the official format (`did not appear verbatim` /
  `Multiple occurrences... Please ensure it is unique`).

## Measured results

Environment: pi 0.84.2 + `deepseek-v4-flash` (opencode-go) + xhigh thinking.

| Group | Condition | First thinking line | we | let me |
|---|---|---|---|---|
| Booster ON | `bash` + `str_replace_editor` + Minimal persona | `We need modify file. Need inspect.` | **1** | **0** |
| OFF | full tools + pi standard prompt | `Let me first read the file to understand the structure.` | 0 | 1 |

- Chinese and English tasks both anchor on `We need`; the whole-turn `let me`
  count is 0 (OFF ≥ 1), matching the DSH documentation fingerprint
  (we 1.4 / let me 0.0).
- **Key conclusion:** tool slimming alone or injection stripping alone is not
  enough — the persona override is required (all three levers are necessary).
- After promotion: full tools are restored (`web_search` / `Agent` verified),
  task quality is equivalent to OFF (6/6 cases), and subagents automatically
  inherit the whole flow.

## Tests

```sh
node tests/run.mjs      # extension logic: bootstrap/promote/resume/models filtering/payload layer/compat keys
node tests/sre-run.mjs  # str_replace_editor behavior: view/replace/insert/create/error semantics
```

Both suites pass in this repository (33 extension-logic assertions + 9
`str_replace_editor` behavior assertions).

## Comparison with upstream

| | dsh-anchored-standard | pi-dsv4-booster |
|---|---|---|
| Host | DeepSeek Harness (Cordis) | pi (ExtensionAPI) |
| Hook layer | system-prompt/assemble | `setActiveTools` + `before_agent_start` + `before_provider_request` |
| Phase source | `session.events` | `sessionManager` entries (resume/reload safe) |
| Tools | `bash` + `str_replace_editor` | Same names and schema (`str_replace_editor` implemented by this extension) |
| Subagents | `includeSubagents` optional (extra anchor round) | **Automatic inheritance, zero extra cost** |
| Config | preset YAML | pi settings.json multi-level override, re-read per event |

## Known limitations

- The first request genuinely lacks `web_search` / `Agent` and other heavy
  tools (by design; the first durable tool call promotes).
- `promoteOn: "never"` is a real capability-limited pure minimal mode (DSH's
  highest score tier, but best suited for single-task evaluation).
- After promotion there is a mild thinking-style shift (`We need` → `Need`;
  `we` stays, `let me` does not regress) — this is also observed in DSH and is
  the controlled cost of restoring full capability.
- Flash and Pro have different trigger sensitivity (modeltest: Flash follows
  the persona more, Pro is also affected by the tool catalog). This extension
  works for both, but there is no evidence on Flash that "style switch"
  translates to a score gain.

## Notes on usage

- **New sessions get the full anchor.** A resumed session with history is
  detected as already promoted. Use `/new` when you want a fresh bootstrap.
- If you want the first request to already include more tools, adjust
  `bootstrapTools` — but keeping the DSH Minimal pair (`bash` +
  `str_replace_editor`) is what preserves the byte-identical Minimal condition.

## License

MIT. Concept ported from
[`xiaobright/dsh-anchored-standard`](https://github.com/xiaobright/dsh-anchored-standard)
(MIT) and
[`dbydd/pi-anchored-tool-for-dspro`](https://github.com/dbydd/pi-anchored-tool-for-dspro)
(MIT); the `str_replace_editor` definition originates from DeepSeek Harness
(MIT) — see upstream project notices.

This project is not affiliated with or endorsed by DeepSeek or pi.
