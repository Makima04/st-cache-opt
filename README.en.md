# ST Cache Opt / DeepSeek Cache Optimizer

[中文](README.md) | English

A native SillyTavern extension for improving DeepSeek / NewAPI prompt cache stability.

## Install from SillyTavern

Use SillyTavern's built-in extension installer and enter this repository URL:

```text
https://github.com/Makima04/st-cache-opt
```

After installation, reload the browser tab and enable `DeepSeek 缓存优化器` in Extensions.

## Update

If you installed this extension with SillyTavern's extension installer, use `检查更新` / `更新扩展` inside the extension panel. Reload the page after an update.

If you installed it manually, download the repository again and overwrite the old files.

## Manual install

Copy this repository folder to:

```text
SillyTavern/public/scripts/extensions/st-cache-opt
```

Then restart SillyTavern or reload the browser tab.

## What It Does

The extension listens to `CHAT_COMPLETION_PROMPT_READY`, after SillyTavern has expanded presets, character fields, world info, example chats, and chat history into OpenAI-compatible `messages`.

It runs a local Prompt Analyzer and reorders only movable pre-history blocks for the current request:

- stable character and preset prompts first
- stable rules, world context, and format rules early
- variable update schema before variable values
- current state, local recall, and dynamic variables later
- chat history and the latest user input stay in their semantic positions

It does not modify saved presets, world books, character cards, or chat history.

## Rich Format / Front-End Cards

Some character cards include HTML/CSS panels, diaries, stat screens, `<details>` blocks, or Markdown code fences that render as a front-end page. These blocks should be treated as atomic content.

The `Protect rich HTML/CSS message blocks` option detects likely rich-format blocks and pins them in place. The optimizer will not split, merge, summarize, or move those blocks independently.

For best results, keep the whole UI block in one message or one world info entry. Avoid mixing a large HTML/CSS panel with unrelated lore text in the same entry.

## Why This Helps Cache Hits

DeepSeek context cache hits require a stable token prefix. In SillyTavern, world info, extension prompts, and dynamic state blocks can appear before stable character information, so a small change in activated lore may invalidate the remaining prefix.

This extension moves more stable content earlier and places frequently changing blocks after the stable prefix, improving the chance that DeepSeek can reuse cached prefix tokens.

## Backend Usage And Real Cached Tokens

The panel can show backend `usage` only when SillyTavern or the upstream gateway returns and exposes that field.

For OpenAI-compatible / NewAPI routes:

- non-stream responses usually include `usage`
- stream responses usually need `stream_options: { include_usage: true }`
- cache hits are commonly reported as `usage.prompt_tokens_details.cached_tokens`
- some gateways use `usage.prompt_cache_hit_tokens` / `usage.prompt_cache_miss_tokens`

Local common-prefix diagnostics are character-based and only indicate cache-stability trends. Backend `usage` or the model provider dashboard remains the authority for billing tokens and cache hits.

## Local Memory Recall Without Vectors

Version 0.5 adds an optional browser-local memory recall layer. It is off by default.

When enabled, the extension stores compact memory records for the current character/chat in IndexedDB. It does not modify SillyTavern chat files, presets, world books, or character cards.

Recall uses:

- exact entity matches from character names and world book keys
- keyword matches from message text
- world book key/reference matches
- memory type priority, importance, and recency

The recalled block is inserted as a short system message before chat history:

```text
[长期记忆召回]
- event / 第42轮 / 相关度8.5: ...
```

For cache stability, keep recalled item count and character budget small. The dynamic memory block is inserted after the stable prompt prefix.

## Independent LLM Memory Extraction

The extension can optionally use a separate LLM to extract structured long-term memories:

- default mode reuses SillyTavern's backend connection and stored API key
- direct mode lets the user enter an OpenAI-compatible API URL, API key, and model
- extracted records are stored in browser IndexedDB
- recall remains local and deterministic; the chat generation model is not used for background extraction

The extractor expects JSON with:

```json
{
  "events": [],
  "states": [],
  "goals": [],
  "relationships": [],
  "rules": [],
  "obsolete_memory_ids": []
}
```

Direct API keys are stored in extension settings in the browser. For shared or public deployments, prefer the SillyTavern backend mode.
