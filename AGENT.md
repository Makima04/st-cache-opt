# SillyTavern Cache Optimization 编码代理提示词

你是接手本插件项目的 AI 编码代理。你的任务是在本仓库内排查、修复并适度重构 SillyTavern 前端扩展，使它可靠完成 Prompt 缓存优化、请求快照记录和诊断展示。

## 项目目标

本项目是 SillyTavern 原生前端扩展。核心目标是在 SillyTavern 向 LLM 发送 OpenAI-compatible 请求前，对 `messages` 上下文进行安全重排：

- 稳定内容尽量前置，例如角色静态设定、稳定规则、格式规则、世界静态信息。
- 动态内容尽量后置，例如当前状态、动态变量、临时世界书命中；当前状态/动态变量值应优先放到聊天历史之后、最新用户输入之前。
- 聊天历史、最新用户输入、工具调用相关消息必须保持语义位置。
- 富格式 HTML/CSS、前端面板、`<details>`、Markdown 代码块等原子内容必须保护，不能拆分、合并、摘要或错误移动。
- 保留请求诊断和请求快照记录能力；即使后端没有返回 `usage`，也要记录本次请求快照。

最终目标是提升 DeepSeek / NewAPI 等支持 prompt cache 的后端对稳定 token 前缀的复用概率，同时不修改用户保存的角色卡、预设、世界书和聊天记录。

## 硬约束

- 只允许修改插件项目目录：`D:\Program\SillyTavern_cache_optimization`。
- 严禁修改本地 SillyTavern 测试目录中的任何代码或资源：`D:\Program\SillyTavern\SillyTavern-release`。
- 可以读取 `D:\Program\SillyTavern\SillyTavern-release` 的源码作为 API/事件参考。
- 可以启动本地 SillyTavern 做运行验证，但测试过程中不得写入或改动它的源码文件。
- 发现用户已有改动时，不要回滚；在现有内容基础上继续工作。

## 当前状态线索

- `index.js` 中重排逻辑曾被 `if (false && settings.enabled)` 永久禁用，当前应保持为 `if (settings.enabled)`。
- 当前 SillyTavern 存在 `CHAT_COMPLETION_PROMPT_READY` 事件，可作为重排入口。
- 当前只读搜索未发现 `CHAT_COMPLETION_RESPONSE_USAGE`、`dco-debug-bodies`、`dco-debug-clear`、`chat-completions/process` 等接口/事件时，应做兼容性检测和降级，不能影响主流程。
- 已加入 fetch 观察逻辑，用于捕获 `/api/backends/chat-completions/generate` 请求体，以及非流式/流式响应中的 `usage`。
- 本构建已经删除浏览器本地记忆召回和独立 LLM 记忆抽取系统。不要重新引入记忆召回、记忆抽取、记忆 IndexedDB 表或相关 UI，除非用户明确要求恢复。

## 修复优先级

1. 确保插件能被 SillyTavern 正常加载，面板能打开，控制台无阻断性错误。
2. 恢复并验证 Prompt 重排主路径：监听 `CHAT_COMPLETION_PROMPT_READY`，在安全边界内修改 `eventData.chat`。
3. 确保请求快照记录可用：开启诊断和记录后，每次生成至少保留消息快照；`usage` 未返回时状态应清楚显示为未收到或等待中。
4. 后端 `usage` 捕获、合并诊断、调试接口属于增强能力。不可用时应自动降级，不得阻断生成、重排或快照记录。
5. 核心功能恢复后再做适度重构：减少重复逻辑、隔离兼容层、改善命名和错误处理，但不要引入与目标无关的大改。

## 实现原则

- 优先沿用现有设置项、UI 文案、数据结构和 IndexedDB 请求历史存储方式。
- 重排只能作用于当前请求内可安全移动的消息，不得修改 SillyTavern 保存的数据源。
- 对未知消息类型保持保守：不能确认安全时不要移动。
- 对工具调用、富格式块、历史边界、最新用户输入保持保守。
- 诊断逻辑要轻量：诊断关闭时避免大规模序列化和额外网络请求。
- 对不存在的 SillyTavern API 做 feature detection 或 try/catch 降级，并在控制台给出清晰但不刷屏的警告。

## 验证要求

完成修改后至少执行：

- 静态检查 `manifest.json`、插件入口、事件绑定和浏览器控制台潜在错误。
- 对照只读 SillyTavern 源码确认事件名、导入路径和数据结构仍然匹配。
- 启动本地 SillyTavern 做手动验证：
  - 插件可加载并显示设置面板。
  - 生成请求时触发 `CHAT_COMPLETION_PROMPT_READY`。
  - 开启重排后，稳定内容确实前置，动态内容确实后置。
  - 开启诊断和请求记录后，请求快照出现。
  - 后端 `usage` 不返回时，快照仍保留且主流程不报错。
  - 开启合并诊断但相关接口不存在时，插件自动降级，不影响生成。
- 验证测试过程中 `D:\Program\SillyTavern\SillyTavern-release` 没有被修改。

## 汇报要求

向用户汇报时使用中文，简洁说明：

- 修复或删除了什么。
- 修改了哪些插件文件。
- 如何验证。
- 哪些能力依赖当前 SillyTavern 或后端是否提供 `usage` / 调试接口。
- 如果有未完成项，明确说明原因和下一步。
