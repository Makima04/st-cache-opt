# ST Cache Opt / DeepSeek 缓存优化器

中文 | [English](README.en.md)

SillyTavern 原生扩展，用于优化 DeepSeek / NewAPI 的 Prompt 缓存命中率。

## 从 SillyTavern 安装

在 SillyTavern 的扩展安装器中输入本仓库地址：

```text
https://github.com/Makima04/st-cache-opt
```

安装完成后刷新浏览器页面，并在扩展面板中启用 `DeepSeek 缓存优化器`。

## 手动安装

将本仓库文件夹复制到：

```text
SillyTavern/public/scripts/extensions/st-cache-opt
```

然后重启 SillyTavern 或刷新浏览器页面。

## 功能

扩展会监听 `CHAT_COMPLETION_PROMPT_READY`。此时 SillyTavern 已经把预设、角色卡、世界书、示例对话和聊天历史展开成 OpenAI-compatible `messages`。

扩展会运行本地 Prompt Analyzer，并只重排当前请求中可安全移动的历史前块：

- 稳定角色卡和预设尽量前置
- 稳定规则、世界设定、格式规则靠前
- 变量更新规则放在变量值之前
- 当前状态、本地召回、动态变量值尽量后移
- 聊天历史和最新用户输入保持语义位置

扩展不会修改已保存的预设、世界书、角色卡或聊天记录。

## 富格式 / 前端角色卡保护

部分角色卡会包含 HTML/CSS 面板、日记、状态栏、`<details>` 块或 Markdown 代码块。这类内容应该视为一个整体。

`保护 HTML/CSS 富格式消息块` 选项会检测这类内容，并将其原位保护。优化器不会拆分、合并、总结或单独移动这些块。

建议把完整 UI 块放在同一条消息或同一个世界书条目中，避免把大型 HTML/CSS 页面和无关设定混在同一个条目里。

## 为什么能提高缓存命中

DeepSeek 的上下文缓存依赖稳定 token 前缀。SillyTavern 中，世界书、扩展提示词和动态状态有时会排在稳定角色设定之前，导致一点世界书激活变化就让后续大段前缀失效。

本扩展的目标是把更稳定的内容放到更靠前的位置，把频繁变化的内容放到稳定前缀之后，从而提高 DeepSeek 复用缓存前缀的概率。

## 后端 usage 与真实缓存 tokens

面板可以显示后端 `usage`，但前提是 SillyTavern 或上游能返回并暴露该字段。

OpenAI-compatible / NewAPI 常见情况：

- 非流式响应通常直接包含 `usage`
- 流式响应通常需要发送 `stream_options: { include_usage: true }`
- 缓存命中常见字段是 `usage.prompt_tokens_details.cached_tokens`
- 部分中转使用 `usage.prompt_cache_hit_tokens` / `usage.prompt_cache_miss_tokens`

本地共同前缀诊断是字符级估算，只用于判断稳定趋势。真实计费 token 和缓存命中以模型后台或 `usage` 为准。

## 无向量本地记忆召回

0.5 版本加入了可选的浏览器本地记忆召回层，默认关闭。

启用后，扩展会将当前角色/聊天的紧凑记忆记录存入 IndexedDB。它不会修改 SillyTavern 的聊天文件、预设、世界书或角色卡。

召回依据包括：

- 角色名和世界书 key 的实体匹配
- 聊天文本关键词匹配
- 世界书 key / 引用匹配
- 记忆类型优先级、重要度和近因权重

召回块会作为较短的 system message 插入到聊天历史之前：

```text
[长期记忆召回]
- event / 第42轮 / 相关度8.5: ...
```

为了保持缓存稳定，建议控制召回条数和字符上限。动态记忆块会插入在稳定 Prompt 前缀之后。

## 独立 LLM 记忆抽取

扩展可以使用单独的 LLM 做结构化长期记忆抽取：

- 默认模式复用 SillyTavern 后端连接和已保存 API key
- 直接模式允许用户填写 OpenAI-compatible API URL、API key 和模型名
- 抽取结果存储在浏览器 IndexedDB
- 召回仍然是本地确定性逻辑；聊天正文模型不会被用于后台记忆抽取

抽取器期望 JSON 包含：

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

直接填写的 API key 会保存在浏览器扩展设置中。多人或公网部署时，建议优先使用复用 SillyTavern 后端密钥的模式。

