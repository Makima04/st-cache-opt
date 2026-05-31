# ST Cache Opt / DeepSeek 缓存优化器

中文 | [English](README.en.md)

SillyTavern 原生扩展，用于优化 DeepSeek / NewAPI 的 Prompt 缓存命中率。

## 从 SillyTavern 安装

在 SillyTavern 的扩展安装器中输入本仓库地址：

```text
https://github.com/Makima04/st-cache-opt
```

安装完成后刷新浏览器页面，并在扩展面板中启用 `DeepSeek 缓存优化器`。

## 更新

如果通过 SillyTavern 扩展安装器安装，可在扩展面板内使用 `检查更新` / `更新扩展`。更新完成后刷新页面生效。

如果是手动复制安装，请重新下载仓库并覆盖旧文件。

## 手动安装

将本仓库文件夹复制到：

```text
SillyTavern/public/scripts/extensions/st-cache-opt
```

然后重启 SillyTavern 或刷新浏览器页面。

## 功能

扩展会监听 `CHAT_COMPLETION_PROMPT_READY`。此时 SillyTavern 已经把预设、角色卡、世界书、示例对话和聊天历史展开成 OpenAI-compatible `messages`。

扩展会运行本地 Prompt Analyzer，并只重排当前请求中可安全移动的历史前内容块：

- 稳定角色卡和预设尽量前置
- 稳定规则、世界设定、格式规则靠前
- 变量更新规则放在变量值之前
- 当前状态和动态变量值尽量后移
- 聊天历史和最新用户输入保持语义位置

扩展不会修改已保存的预设、世界书、角色卡或聊天记录。

## 请求记录与诊断

开启诊断和请求记录后，扩展会把请求快照记录到浏览器 IndexedDB。即使后端没有返回 `usage`，请求快照也应保留。

后端 `usage` 只在 SillyTavern 或上游网关返回并暴露该字段时可用。缺少 `usage` 或缺少调试接口时，不能阻断生成或 Prompt 重排。

OpenAI-compatible / NewAPI 常见情况：

- 非流式响应通常直接包含 `usage`
- 流式响应通常需要发送 `stream_options: { include_usage: true }`
- 缓存命中常见字段是 `usage.prompt_tokens_details.cached_tokens`
- 部分中转使用 `usage.prompt_cache_hit_tokens` / `usage.prompt_cache_miss_tokens`

本地共同前缀诊断是字符级估算，只用于判断缓存稳定趋势。真实计费 token 和缓存命中以模型后台或后端 `usage` 为准。

## 富格式 / 前端角色卡保护

部分角色卡会包含 HTML/CSS 面板、日记、状态栏、`<details>` 块或 Markdown 代码块。这类内容应视为一个整体。

`保护 HTML/CSS 富格式消息块` 选项会检测这类内容，并将其原位保护。优化器不会拆分、合并、总结或单独移动这些块。

建议把完整 UI 块放在同一条消息或同一个世界书条目中，避免把大型 HTML/CSS 页面和无关设定混在同一个条目里。

## 记忆系统已删除

本构建已经删除浏览器本地记忆召回和独立 LLM 记忆抽取功能。扩展现在只聚焦 Prompt 重排、诊断、后端 usage 捕获和请求快照记录。
