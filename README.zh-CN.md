# pi-dsv4-booster

<p align="center">
  <img src="docs/social-preview.jpg" alt="pi-dsv4-booster banner" width="100%">
</p>

> **为 pi 中的 DeepSeek V4 (DSv4) 模型提速** —— 首轮请求锚定在 DeepSeek Harness
> **Minimal** 条件上，首次持久工具调用后晋升为完整工具目录。

[English](./README.md) | **中文**

DeepSeek Harness 社区 preset
[`xiaobright/dsh-anchored-standard`](https://github.com/xiaobright/dsh-anchored-standard)
的 pi 移植（并融合 dbydd/pi-anchored-tool-for-dspro 的 payload 层方案）。
目标：让 DSv4 模型在 pi 里也吃到 RL 训练对齐的 **Minimal 轨迹红利**，同时不损失
任何工具能力。

## 为什么

DeepSeek V4 系模型会强烈依赖**首轮请求中可见的工具目录与 system prompt** 选择执行轨迹
（modeltest 触发机制实验，issue #11）：

| 条件 | 首轮轨迹 | Project2 分数 |
|---|---|---|
| Standard（25 工具 + 完整 prompt） | `Let me...` standard-like | 91 |
| PTC | `Let me` | 92 |
| **Minimal（2 工具 + 一句话 persona）** | `We need...` minimal-like | **99 / 96** |
| **Anchored（先 Minimal 后晋升）** | 先 `We need`，晋升后不回归 | **98 / 99** |

工具目录是**轨迹选择器**：它本该只告诉模型"有什么工具可用"，在 DSv4 上却顺带决定了
"用哪种脑子思考"。本插件用工程手段把这两个被 RL 绑定的变量重新拆开——**首轮锚定
Minimal 轨迹，晋升后恢复完整能力**。

## 机制

```
用户第一条消息（新会话）
        │
        ▼
┌ 请求 #1 ─ bootstrap 阶段 ────────────────────────────┐
│ 工具   : bash + str_replace_editor                   │
│          （与官方 minimal preset 逐字节同名；          │
│            str_replace_editor 为本插件注册的官方      │
│            schema 完整实现）                          │
│ prompt : Minimal persona 整体覆盖                     │
│          "You are a helpful software engineer         │
│           assistant."（DSH 原文，勿改写）             │
│ 注入   : AGENTS.md / 技能目录 不进入 prompt           │
│ 预算   : bootstrapMaxTokens（可选）                   │
└───────────────────────────────────────────────────────┘
        │ 首次持久 tool/call 或首次 assistant/message
        ▼ 晋升（从持久 session entries 推导，resume 安全）
┌ 请求 #2 起 ─ promoted 阶段 ──────────────────────────┐
│ 工具   : 完整 active set（内置 + 全部扩展工具，        │
│          含 Agent/subagent/web_search 等）            │
│ prompt : Minimal persona 全程保持                     │
│          （DSH complete: true 语义，仅工具目录晋升）   │
└───────────────────────────────────────────────────────┘
```

### 三个杠杆（全部对齐 DSH）

1. **工具 schema** —— 首轮真实暴露 Minimal 工具对（`bash` + `str_replace_editor`），
   与官方 minimal preset 名称逐字节一致
2. **persona** —— 首轮起 system prompt 整体替换为 DSH Minimal 原文
   （`complete: true` 语义：全程保持，只有工具目录晋升）。modeltest 证明**改写
   persona 会破坏 `We need` 风格**，故文本不可配置（`bootstrapPersona` 仅供覆盖
   为 null 退回剥离模式）
3. **注入剥离** —— AGENTS.md（`<project_context>`）与技能目录
   （`<available_skills>`）不进 prompt；用户主动 `/skill:` 手势不受影响

### 晋升信号

- `promoteOn: "either"`（默认）：首次持久工具执行 **或** 首次 assistant 消息，先到者为准
- `promoteOn: "tool-call"`：仅工具调用晋升（纯文字首答不晋升）
- `promoteOn: "assistant-message"`：仅消息晋升
- `promoteOn: "never"`：**纯 minimal 档**——永不晋升（DSH 最高分档 99/96，代价是
  只有两个工具）

### 子代理（Agent 工具）自动继承 ✅

pi-subagents 的 append 模式把父 agent 的 system prompt 原样嵌入子代理前缀；且
子代理是**独立 session + 独立扩展实例 + 独立 phase**，因此每次 spawn 都是一次完整
的 anchored 会话：bootstrap（首轮同样只有 bash + str_replace_editor）→ 晋升 →
全量。实测确认（debug 日志）：子代理首轮 payload 被过滤为 `[bash, str_replace_editor]`，
首次工具调用后恢复全量。比 DSH 的 includeSubagents 更强——**零额外锚定轮成本**。

对于使用 `prompt_mode: replace` 的自定义子代理（例如带自身角色指令的
`Reviewer`），插件会检测到子会话 + 自定义 prompt，**保留原 system prompt 并把
Minimal persona 前置**，而不是整体替换；首轮工具过滤仍然生效。这样专业角色子代理
既能吃到锚定轨迹，又不会丢失自己的角色说明。

## 安装

```sh
pi install git:github.com/GY-Bai/pi-dsv4-booster
# 或带版本 pin：pi install git:github.com/GY-Bai/pi-dsv4-booster@v0.1.0
```

重启 pi 或 `/reload`，然后 `/new` 新开会话体验 bootstrap → 晋升流程。
（旧版 anchored-tools 全局扩展若已安装，建议移除避免双份：`rm -rf ~/.pi/agent/extensions/anchored-tools`）

## 配置

`~/.pi/agent/settings.json`（全局 base）或受信任项目的 `.pi/settings.json`
（deep-merge 覆盖：嵌套合并、数组整体替换、项目优先）。**每个事件重读，改配置即时生效**。

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
    "preserveCustomPrompt": false,
    "debug": false
  }
}
```

> 兼容：旧键 `anchoredTools` 仍被识别（`piDsv4Booster` 优先）。

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `models` | `[]` | glob 目标模型（`"deepseek/*"`、`"*/deepseek-v4-pro"`、裸 `"deepseek-v4-pro"`）；`[]` = 全部模型（注意：dbydd 原版 `[]` = 不锚定任何模型，本插件取相反语义） |
| `bootstrapTools` | `["bash","str_replace_editor"]` | 请求 #1 工具——与 DSH Minimal 逐字节同名；缺失时 fail-safe 跳过限制 |
| `bootstrapPersona` | `"You are a helpful software engineer assistant."` | Minimal persona（DSH 原文，勿改写）；`null` 退回仅剥离模式 |
| `bootstrapCwdLine` | `true` | persona 后追加 `Current working directory: <cwd>` |
| `personaMode` | `"session"` | `session`（persona 全程）/ `bootstrap-only`（晋升后恢复宿主 prompt） |
| `minimalSystemPrompt` | `true` | dbydd 兼容键；`false` 且项目层未显式设 `bootstrapPersona` 时禁用 persona 并保持宿主 prompt 完全不动 |
| `promoteOn` | `"either"` | `either` / `tool-call` / `assistant-message` / `never`（纯 minimal 档） |
| `suppressContextSources` | `["contextFiles","skills"]` | 剥离模式下的注入段；`[]` 关闭 |
| `bootstrapMaxTokens` | `null` | 请求 #1 可选输出封顶（改写 `max_tokens`） |
| `notify` | `true` | 晋升时 TUI 通知 |
| `preserveCustomPrompt` | `false` | 保留自定义/子代理 system prompt，并将 Minimal persona 前置而不是整体替换；对带自定义 prompt 的持久子会话自动启用 |
| `debug` | `false` | console 诊断日志（session/phase/payload 过滤前后） |

## 命令

- `/pi-dsv4-booster` —— 显示 phase、配置、模型匹配、active tools
- `/pi-dsv4-booster promote` —— 手动晋升
- 旧别名：`/anchored`、`/anchored-tools`

## str_replace_editor（DSH Minimal 第二工具）

`bootstrapTools` 中的 `str_replace_editor` 由本插件注册，**名称、参数 schema、描述、
语义与官方 `@deepseek-ai/dsh-tool-str-replace-editor` 一致**（minimal preset）：

- 参数：`command`（`view`/`create`/`str_replace`/`insert`）、`path`、`file_text`、
  `old_str`、`new_str`、`insert_line`、`view_range`
- `view`：`cat -n` 格式（6 位行号 + Tab）；目录列出非隐藏项最多 2 层；支持行范围
- `str_replace`：**唯一匹配**才替换；多匹配报错并列出冲突行号；零匹配报错
- `insert`：在 `insert_line` 行后插入
- `create`：已存在报错
- 输出 16000 字符截断（`<response clipped>`）
- 错误消息格式与官方一致（`did not appear verbatim` / `Multiple occurrences...`）

## 实测数据（pi 0.84.2 + deepseek-v4-flash + xhigh）

| 组 | 条件 | 首轮 thinking 首行 | we | let me |
|---|---|---|---|---|
| Booster ON | bash+str_replace_editor + Minimal persona | `We need modify file. Need inspect.` | **1** | **0** |
| OFF | 全工具 + pi 标准 prompt | `Let me first read the file to understand the structure.` | 0 | 1 |

- 中文/英文任务均锚定 `We need`，全轮 `let me` = 0（对照 OFF ≥1），与 DSH 文档
  记载（we 1.4 / let me 0.0）逐字吻合
- **关键结论：仅工具瘦身或仅剥离注入都不够，必须 persona 整体覆盖**（三杠杆缺一不可）
- 晋升后：完整工具恢复（web_search/Agent 实测可用）、任务质量与 OFF 等价（6/6 用例）、
  子代理自动继承完整流程
- 产物验证与官方 sre 行为测试见 `tests/`

## 测试

```sh
node tests/run.mjs      # 扩展逻辑：bootstrap/晋升/resume/models 过滤/payload 层/兼容键
node tests/sre-run.mjs  # str_replace_editor 行为：view/replace/insert/create/错误语义
```

本仓库两套测试均通过（33 项扩展逻辑断言 + 9 项 `str_replace_editor` 行为断言）。

## 与上游差异

| | dsh-anchored-standard | pi-dsv4-booster |
|---|---|---|
| 宿主 | DeepSeek Harness (Cordis) | pi (ExtensionAPI) |
| 钩子层 | system-prompt/assemble | setActiveTools + before_agent_start + before_provider_request 三重 |
| 阶段来源 | session.events | sessionManager entries（resume/reload 安全） |
| 工具 | bash + str_replace_editor | 同名同 schema（str_replace_editor 为本插件实现） |
| 子代理 | includeSubagents 可选（多一次锚定轮） | **自动继承，零额外成本** |
| 配置 | preset YAML | pi settings.json 多级覆盖，每事件重读 |

## 已知限制

- 首轮确实没有 web_search/Agent 等重工具（设计使然；首次工具调用即晋升）
- `promoteOn: "never"` 是真实能力受限的纯 minimal 档（DSH 最高分档，但只适合
  单任务评测场景）
- 晋升后 thinking 风格词有轻微回退（`Need...`，`we` 保持、`let me` 不回归）——
  与 DSH 观测一致，属恢复能力的可控代价
- Flash 与 Pro 的触发敏感性不同（modeltest：Flash 跟随 persona 为主，Pro 还受
  工具目录影响）；本插件对两者均生效，但"风格切换 ≠ 分数提升"在 Flash 上无证据

## 使用提示

- **新会话才能吃到完整锚定。** 带历史 resume 的会话会被判定为已晋升。想要完整
  bootstrap 效果时，请用 `/new` 新开。
- 若希望首轮就带更多工具，可调整 `bootstrapTools`——但保持 DSH Minimal 原对
  （`bash` + `str_replace_editor`）才是逐字节一致的 Minimal 条件。

## License

MIT。概念移植自 [`xiaobright/dsh-anchored-standard`](https://github.com/xiaobright/dsh-anchored-standard)
(MIT) 与 [`dbydd/pi-anchored-tool-for-dspro`](https://github.com/dbydd/pi-anchored-tool-for-dspro) (MIT)，
`str_replace_editor` 定义源自 DeepSeek Harness（MIT），见上游项目原始声明。
本插件与 DeepSeek / pi 官方无隶属或背书关系。
