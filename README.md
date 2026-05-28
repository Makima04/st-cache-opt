# ST Cache Opt / DeepSeek 缓存优化器

SillyTavern native extension for DeepSeek/NewAPI prompt cache optimization.

## Install from SillyTavern

Use SillyTavern's built-in extension installer and enter this repository URL:

```text
https://github.com/Makima04/st-cache-opt
```

After installation, reload the browser tab and enable `DeepSeek 缓存优化器` in Extensions.

## Manual install

Copy this repository folder to:

```text
SillyTavern/public/scripts/extensions/st-cache-opt
```

Restart SillyTavern or reload the browser tab.

## What it does

The extension listens to `CHAT_COMPLETION_PROMPT_READY`, after SillyTavern has expanded presets, character fields, world info, examples, and chat history into OpenAI-compatible `messages`.

It then runs a local Prompt Analyzer and reorders movable pre-history blocks for the current request:

- stable character/preset prompts first
- stable role/world/format rules next
- variable update schema before variable values
- dynamic state, local recall, and current variables later
- chat history and the latest user message stay in their semantic position

It does not modify saved presets, world books, character cards, or chat history.

## Rich format / front-end cards

Some character cards include HTML/CSS panels, diaries, stat screens, `<details>` blocks, or Markdown code fences that render as a front-end page. These blocks should be treated as atomic content.

The `Protect rich HTML/CSS message blocks` option detects likely rich-format blocks and pins them in place. The optimizer will not split, merge, summarize, or move those blocks independently.

For best results, keep the whole UI block in one message or one world info entry. Avoid mixing a large HTML/CSS panel with unrelated lore text in the same entry.

## Why

DeepSeek context cache hits require a stable token prefix. In SillyTavern, world info and extension prompts can appear before stable character information, which can cause a small change in activated lore to invalidate the remaining prefix. Moving stable content earlier improves the chance that DeepSeek can reuse cached prefix tokens.

## Notes

The default setting only runs when Chat Completion source is DeepSeek. Use `Debug log reordered messages` to inspect the final message order in the browser console.

## Backend usage

The panel can show backend `usage` when SillyTavern emits `CHAT_COMPLETION_RESPONSE_USAGE`.

For OpenAI-compatible NewAPI routes:

- non-stream responses normally include `usage`
- stream responses need `stream_options: { include_usage: true }`
- cache hits are commonly reported as `usage.prompt_tokens_details.cached_tokens`
- some gateways use `usage.prompt_cache_hit_tokens` and `usage.prompt_cache_miss_tokens`

The local prefix diagnostics are character-based and are only a cache-stability hint. Backend `usage` remains the authority for billing tokens and cache hits.

## Local memory recall without vectors

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

For cache stability, keep recalled item count and character budget small. The dynamic memory block is inserted after the stable prompt prefix, so the stable prefix can still hit cache.

## LLM memory extraction

The extension can optionally use a separate LLM to extract structured memories:

- default mode reuses SillyTavern's backend connection and stored API key
- direct mode lets the user enter an OpenAI-compatible API URL, API key, and model
- extracted records are stored in browser IndexedDB
- recall remains local and deterministic; the chat generation model is not used for background extraction

The extractor expects JSON with `events`, `states`, `goals`, `relationships`, `rules`, and `obsolete_memory_ids`.

Direct API keys are stored in extension settings in the browser. For shared or public deployments, prefer the SillyTavern backend mode.
