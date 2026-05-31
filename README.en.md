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

If you installed this extension with SillyTavern's extension installer, use `Check for updates` / `Update extension` inside the extension panel. Reload the page after an update.

If you installed it manually, download the repository again and overwrite the old files.

## Manual Install

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
- current state and dynamic variables after chat history and before the latest user input
- chat history and the latest user input stay in their semantic positions

It does not modify saved presets, world books, character cards, or chat history.

## Request Recording And Diagnostics

When diagnostics and request history are enabled, the extension records request snapshots in browser IndexedDB. Snapshots are still retained when the backend does not return `usage`.

Backend `usage` is used only when SillyTavern or the upstream gateway returns and exposes it. Missing usage or missing debug endpoints must not block generation or prompt reordering.

For OpenAI-compatible / NewAPI routes:

- non-stream responses usually include `usage`
- stream responses usually need `stream_options: { include_usage: true }`
- cache hits are commonly reported as `usage.prompt_tokens_details.cached_tokens`
- some gateways use `usage.prompt_cache_hit_tokens` / `usage.prompt_cache_miss_tokens`

Local common-prefix diagnostics are character-based and only indicate cache-stability trends. Backend `usage` or the model provider dashboard remains the authority for billing tokens and cache hits.

## Rich Format / Front-End Cards

Some character cards include HTML/CSS panels, diaries, stat screens, `<details>` blocks, or Markdown code fences that render as a front-end page. These blocks should be treated as atomic content.

The `Protect rich HTML/CSS message blocks` option detects likely rich-format blocks and pins them in place. The optimizer will not split, merge, summarize, or move those blocks independently.

For best results, keep the whole UI block in one message or one world info entry. Avoid mixing a large HTML/CSS panel with unrelated lore text in the same entry.

## Memory System Removed

The browser-local memory recall and independent LLM memory extraction features have been removed from this build. The extension now focuses on prompt reordering, diagnostics, backend usage capture, and request snapshot recording.
