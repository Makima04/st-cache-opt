import {
    eventSource,
    event_types,
    getRequestHeaders,
    name1,
    name2,
    saveSettingsDebounced,
} from '/script.js';
import { extension_settings } from '/scripts/extensions.js';
import { POPUP_TYPE, callGenericPopup } from '/scripts/popup.js';
import { getGroupNames } from '/scripts/group-chats.js';

const MODULE_NAME = 'deepseek_cache_optimizer';
const EXTENSION_FOLDER_NAME = 'st-cache-opt';
const SETTINGS_VERSION = 1;

const defaultSettings = {
    settingsVersion: SETTINGS_VERSION,
    enabled: true,
    strategy: 'balanced',
    moveWorldInfoAfter: true,
    moveJailbreakAfterHistory: false,
    protectRichFormat: true,
    minPrefixMessages: 2,
    adaptiveStableReorder: true,
    adaptiveSampleSize: 3,
    adaptiveHitRateThreshold: 20,
    debug: false,
    diagnosticsEnabled: false,
    recordRequestHistory: false,
    mergedDiagnostics: false,
};

const HISTORY_DB_NAME = 'dco-request-history';
const HISTORY_DB_VERSION = 1;
const HISTORY_STORE = 'snapshots';
const HISTORY_MAX = 30;

const stableContentPatterns = [
    /write .+ next reply/i,
    /fictional chat/i,
    /character sheet/i,
    /personality/i,
    /scenario/i,
    /description/i,
];

const hardDynamicBlockPatterns = [
    /<status_current_variables>/i,
    /<\/status_current_variables>/i,
    /stat_data\./i,
    /getvar\("stat_data\./i,
    /当前事件标记/,
    /当前所想/,
    /内心想法/,
    /当前位置/,
    /月事状态/,
    /奖励点数/,
    /惩罚点数/,
    /反抗意志/,
    /调教值/,
    /爱意值/,
    /记忆扭曲度/,
    /UpdateVariable/i,
    /_.set\('/,
    /path_of_changed_variable/,
];

const stableInstructionPatterns = [
    /核心指导/,
    /核心风格/,
    /创作准则/,
    /输出模板/,
    /段落安排/,
    /对白分离/,
    /角色表现准则/,
    /人称准则/,
    /字数准则/,
    /语言准则/,
    /rule:\s*$/i,
    /format:\s*\|-/i,
    /example:\s*\|-/i,
];

const richFormatPatterns = [
    /<style[\s>]/i,
    /<\/style>/i,
    /<script[\s>]/i,
    /<\/script>/i,
    /<details[\s>]/i,
    /<summary[\s>]/i,
    /<div[\s>][\s\S]*class\s*=/i,
    /<section[\s>]/i,
    /style\s*=\s*["'][^"']{20,}/i,
    /```(?:html|css|javascript|js)\b/i,
];

let lastStats = {
    moved: 0,
    total: 0,
    skipped: '尚未运行',
    protected: 0,
    rawPrefixChars: 0,
    rawPrefixPercent: 0,
    rawInputPercent: 0,
    pluginImpact: 0,
    firstChangedMessage: null,
    firstMessageHash: '',
};

let previousSerializedPrompt = '';
let previousRawContent = '';
let previousRawInput = '';
let previousMessageSignatures = [];
let lastBackendUsage = null;
let lastGenerationSettings = null;
let promptRunCounter = 0;
let usageHistory = [];
let requestHistory = [];
let lastPromptAnalysis = [];
let previousMergedContent = '';
let previousMergedSignatures = [];
let mergeAwareAvailable = true;
let lastUpdateCheck = null;
let updateRunning = false;
let backendBodyRecords = [];
let fetchPatched = false;
let backendDebugUnavailable = false;
let adaptivePromptSamples = [];
let adaptiveStableHashes = [];
let adaptiveStableHashSet = new Set();
let adaptiveStableOrder = new Map();
let adaptivePlanLocked = false;
let adaptivePlanReason = '等待 3 次请求样本';

const promptCategoryLabels = {
    stable_rule: '稳定规则',
    adaptive_stable: '自适应稳定',
    character_static: '角色静态',
    world_static: '世界静态',
    format_rule: '格式规则',
    variable_schema: '变量规则',
    dynamic_state: '动态状态',
    history_marker: '历史标记',
    chat_history: '聊天历史',
    latest_input: '最新输入',
    rich_format: '富格式',
    unsafe_to_move: '不移动',
    unknown_stable: '未知稳定',
    empty: '空消息',
};

function getSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = {};
    }

    if (extension_settings[MODULE_NAME].settingsVersion !== SETTINGS_VERSION) {
        extension_settings[MODULE_NAME] = { ...defaultSettings };
        saveSettingsDebounced();
    }

    for (const [key, value] of Object.entries(defaultSettings)) {
        if (extension_settings[MODULE_NAME][key] === undefined) {
            extension_settings[MODULE_NAME][key] = value;
        }
    }

    return extension_settings[MODULE_NAME];
}

function getMessageText(message) {
    if (!message) {
        return '';
    }

    if (typeof message.content === 'string') {
        return message.content;
    }

    if (Array.isArray(message.content)) {
        return message.content
            .map(part => typeof part?.text === 'string' ? part.text : '')
            .join('\n');
    }

    return '';
}

function normalizeText(text) {
    return String(text || '')
        .replace(/\s+/g, ' ')
        .trim();
}

function hashString(value) {
    let hash = 2166136261;
    const text = String(value || '');

    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }

    return (hash >>> 0).toString(16).padStart(8, '0');
}

function serializeMessage(message) {
    return JSON.stringify({
        role: message?.role ?? '',
        name: message?.name ?? '',
        content: message?.content ?? '',
        tool_calls: message?.tool_calls ?? null,
        tool_call_id: message?.tool_call_id ?? '',
    });
}

function serializeRawContent(messages) {
    return messages.map(msg => getMessageText(msg)).join('\n');
}

function serializeMessagesAsJson(messages) {
    const formatted = messages.map(msg => {
        const obj = { role: msg.role || '', content: msg.content ?? '' };
        if (msg.name) obj.name = msg.name;
        if (msg.tool_calls) obj.tool_calls = msg.tool_calls;
        if (msg.tool_call_id) obj.tool_call_id = msg.tool_call_id;
        return obj;
    });
    return JSON.stringify({ messages: formatted });
}

function getCommonPrefixLength(a, b) {
    const max = Math.min(a.length, b.length);
    let index = 0;

    while (index < max && a.charCodeAt(index) === b.charCodeAt(index)) {
        index++;
    }

    return index;
}

function getMessageSignatures(messages) {
    return messages.map((message, index) => {
        const text = getMessageText(message);
        return {
            index,
            role: message?.role ?? '',
            length: text.length,
            hash: hashString(serializeMessage(message)),
            rich: isRichFormatMessage(message),
            preview: normalizeText(text).slice(0, 80),
        };
    });
}

let historyDbPromise = null;
function openHistoryDb() {
    if (historyDbPromise) return historyDbPromise;
    historyDbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(HISTORY_DB_NAME, HISTORY_DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(HISTORY_STORE)) {
                db.createObjectStore(HISTORY_STORE, { keyPath: 'id' });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
    return historyDbPromise;
}

async function saveSnapshotToDb(record) {
    try {
        const db = await openHistoryDb();
        const messages = (record.messages || []).map((msg, i) => ({
            index: i,
            role: msg?.role ?? '',
            name: msg?.name ?? '',
            content: getMessageText(msg),
            hash: hashString(serializeMessage(msg)),
        }));
        const snapshot = {
            id: record.id,
            at: record.at,
            model: record.model,
            source: record.source,
            stream: record.stream,
            type: record.type,
            status: record.status,
            recordPath: record.recordPath,
            usagePath: record.usagePath,
            usage: record.usage,
            stats: record.stats,
            messageCount: messages.length,
            messages,
        };
        await new Promise((resolve, reject) => {
            const tx = db.transaction(HISTORY_STORE, 'readwrite');
            tx.objectStore(HISTORY_STORE).put(snapshot);
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
        });
        // Trim old entries
        const all = await new Promise((resolve, reject) => {
            const tx = db.transaction(HISTORY_STORE, 'readwrite');
            const store = tx.objectStore(HISTORY_STORE);
            const req = store.getAllKeys();
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
        if (all.length > HISTORY_MAX) {
            const toDelete = all.slice(0, all.length - HISTORY_MAX);
            const tx = db.transaction(HISTORY_STORE, 'readwrite');
            const store = tx.objectStore(HISTORY_STORE);
            for (const key of toDelete) store.delete(key);
        }
    } catch (e) {
        console.warn('[DCO] saveSnapshotToDb failed:', e);
    }
}

async function loadSnapshotsFromDb() {
    try {
        const db = await openHistoryDb();
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(HISTORY_STORE, 'readonly');
            const req = tx.objectStore(HISTORY_STORE).getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
        });
    } catch {
        return [];
    }
}

async function exportAllSnapshots() {
    const snapshots = await loadSnapshotsFromDb();
    if (!snapshots.length) {
        toastr.warning('没有已保存的快照');
        return;
    }
    const blob = new Blob([JSON.stringify(snapshots, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `dco-all-snapshots-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toastr.success(`已导出 ${snapshots.length} 条快照`);
}

function getRequestSettingsSignature(settingsRecord = lastGenerationSettings) {
    if (!settingsRecord) {
        return '';
    }

    return hashString(JSON.stringify({
        source: settingsRecord.source || '',
        model: settingsRecord.model || '',
        stream: Boolean(settingsRecord.stream),
        stream_options: settingsRecord.stream_options || null,
    }));
}

function formatNumber(value) {
    return Number.isFinite(Number(value)) ? Number(value).toLocaleString() : '无';
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function getCachedTokens(usage) {
    return usage?.prompt_tokens_details?.cached_tokens
        ?? usage?.prompt_cache_hit_tokens
        ?? usage?.input_token_details?.cache_read
        ?? usage?.cache_read_input_tokens
        ?? 0;
}

function getCacheMissTokens(usage) {
    return usage?.prompt_cache_miss_tokens
        ?? usage?.input_token_details?.cache_creation
        ?? usage?.cache_creation_input_tokens
        ?? Math.max((usage?.prompt_tokens ?? usage?.input_tokens ?? 0) - getCachedTokens(usage), 0);
}

function getPromptTokens(usage) {
    return usage?.prompt_tokens ?? usage?.input_tokens ?? 0;
}

function getCompletionTokens(usage) {
    return usage?.completion_tokens ?? usage?.output_tokens ?? 0;
}

function getCacheHitPercent(usage) {
    const promptTokens = getPromptTokens(usage);
    if (!promptTokens) {
        return 0;
    }

    return Math.round((getCachedTokens(usage) / promptTokens) * 10000) / 100;
}

function getUsageMetrics(usage) {
    return {
        promptTokens: getPromptTokens(usage),
        completionTokens: getCompletionTokens(usage),
        cachedTokens: getCachedTokens(usage),
        missTokens: getCacheMissTokens(usage),
        hitPercent: getCacheHitPercent(usage),
    };
}

function getBackendUsageMetrics() {
    return getUsageMetrics(lastBackendUsage?.usage);
}

function clonePromptMessages(messages) {
    return (messages || []).map(message => JSON.parse(JSON.stringify({
        role: message?.role ?? '',
        name: message?.name ?? '',
        content: message?.content ?? '',
        tool_calls: message?.tool_calls ?? null,
        tool_call_id: message?.tool_call_id ?? '',
    })));
}

function makeRequestRecord({ messages, stats, analysis, serializedPrompt, mergedMessages: merged }) {
    const signatures = getMessageSignatures(messages);
    return {
        id: `REQ-${String(promptRunCounter).padStart(4, '0')}`,
        runId: promptRunCounter,
        at: new Date(),
        status: '等待 usage',
        usageReceived: false,
        source: lastGenerationSettings?.source || '',
        model: lastGenerationSettings?.model || '',
        stream: Boolean(lastGenerationSettings?.stream),
        type: lastGenerationSettings?.type || '',
        stats: structuredClone(stats),
        analysis: structuredClone(analysis || []),
        messages: clonePromptMessages(messages),
        messageSignatures: signatures,
        serializedPrompt,
        usage: null,
        recordPath: 'event_prompt_ready',
        usagePath: '',
        mergedMessageSignatures: merged ? getMessageSignatures(merged) : null,
        mergedMessageCount: merged?.length ?? null,
    };
}

function getGenerateRequestMessages(requestJson = {}) {
    return Array.isArray(requestJson?.messages) ? requestJson.messages : [];
}

function areMessageSignaturesEqual(left = [], right = []) {
    if (left.length !== right.length) {
        return false;
    }

    return left.every((item, index) => {
        const other = right[index];
        return item?.role === other?.role && item?.hash === other?.hash;
    });
}

function rememberRequestRecord(record) {
    const settings = getSettings();
    if (!settings.diagnosticsEnabled || !settings.recordRequestHistory) {
        return;
    }

    requestHistory.unshift(record);
    requestHistory = requestHistory.slice(0, 50);
    saveSnapshotToDb(record);
}

function rememberRequestRecordFromFetch(requestBody, requestJson = {}) {
    const settings = getSettings();
    if (!settings.diagnosticsEnabled || !settings.recordRequestHistory) {
        return null;
    }

    const messages = getGenerateRequestMessages(requestJson);
    if (!messages.length) {
        return null;
    }

    const messageSignatures = getMessageSignatures(messages);
    const latest = requestHistory[0] || null;
    const source = requestJson.chat_completion_source || lastGenerationSettings?.source || '';
    const model = requestJson.model || lastGenerationSettings?.model || '';
    const type = requestJson.type || lastGenerationSettings?.type || '';
    const stream = Boolean(requestJson.stream ?? lastGenerationSettings?.stream);
    const settingsSignature = getRequestSettingsSignature({
        source,
        model,
        stream,
        type,
        stream_options: requestJson.stream_options || lastGenerationSettings?.stream_options,
    });

    if (latest && !latest.usageReceived && areMessageSignaturesEqual(latest.messageSignatures || [], messageSignatures)) {
        latest.source = source || latest.source;
        latest.model = model || latest.model;
        latest.stream = stream;
        latest.type = type || latest.type;
        latest.settingsSignature = settingsSignature;
        latest.requestBodyHash = hashString(typeof requestBody === 'string' ? requestBody : '');
        latest.recordPath = latest.recordPath === 'event_prompt_ready' ? 'event_plus_fetch' : (latest.recordPath || 'fetch_generate');
        saveSnapshotToDb(latest);
        return latest;
    }

    promptRunCounter += 1;
    const rawContentAfter = serializeRawContent(messages);
    const rawPrefixChars = previousRawContent ? getCommonPrefixLength(previousRawContent, rawContentAfter) : 0;
    const rawPrefixPercent = previousRawContent
        ? Math.round((rawPrefixChars / Math.max(rawContentAfter.length, 1)) * 10000) / 100
        : 0;
    const firstChangedMessage = previousMessageSignatures.length
        ? getFirstChangedMessage(messageSignatures, previousMessageSignatures)
        : null;
    const stableMessagePrefixCount = Number.isInteger(firstChangedMessage) ? firstChangedMessage : messageSignatures.length;
    const stableMessagePrefixChars = messageSignatures
        .slice(0, stableMessagePrefixCount)
        .reduce((sum, item) => sum + Number(item.length || 0), 0);

    const fallbackStats = {
        ...lastStats,
        moved: 0,
        total: messages.length,
        skipped: '由实际生成请求记录',
        rawPrefixChars,
        rawPrefixPercent,
        firstChangedMessage,
        stableMessagePrefixCount,
        stableMessagePrefixChars,
        firstMessageHash: messageSignatures[0]?.hash ?? '',
        firstMessageLength: messageSignatures[0]?.length ?? 0,
        messageSignatures,
        promptAnalysis: [],
        runId: promptRunCounter,
        requestSettingsSignature: settingsSignature,
        requestType: type,
    };
    lastStats = fallbackStats;

    const record = makeRequestRecord({
        messages,
        stats: fallbackStats,
        analysis: [],
        serializedPrompt: messages.map(serializeMessage).join('\n'),
        mergedMessages: null,
    });
    record.status = '已捕获请求';
    record.source = source;
    record.model = model;
    record.stream = stream;
    record.type = type;
    record.settingsSignature = settingsSignature;
    record.requestBodyHash = hashString(typeof requestBody === 'string' ? requestBody : '');
    record.recordPath = 'fetch_generate';

    rememberRequestRecord(record);

    previousSerializedPrompt = record.serializedPrompt;
    previousRawContent = rawContentAfter;
    previousRawInput = rawContentAfter;
    previousMessageSignatures = messageSignatures;
    try {
        localStorage.setItem('dco_prevRawContent', rawContentAfter);
        localStorage.setItem('dco_prevRawInput', rawContentAfter);
    } catch { /* quota exceeded */ }

    updateStats();
    return record;
}

function updateLatestRequestWithUsage(eventData) {
    const record = requestHistory.find(item => {
        if (item.usageReceived) {
            return false;
        }
        if (eventData.model && item.model && eventData.model !== item.model) {
            return false;
        }
        if (eventData.source && item.source && eventData.source !== item.source) {
            return false;
        }
        return true;
    }) || requestHistory.find(item => !item.usageReceived);
    if (!record) {
        return null;
    }

    record.usage = eventData.usage;
    record.usageReceived = true;
    record.status = '已收到 usage';
    record.source = eventData.source || record.source;
    record.model = eventData.model || record.model;
    record.stream = Boolean(eventData.stream);
    record.type = eventData.type || record.type;
    record.usagePath = eventData.usagePath || eventData.path || 'unknown';
    record.usageAt = new Date();
    record.settingsSignature = getRequestSettingsSignature(lastGenerationSettings);
    return record;
}

function updateLatestRequestWithGenerationSettings(settingsRecord = lastGenerationSettings) {
    const record = requestHistory.find(item => !item.usageReceived);
    if (!record || !settingsRecord) {
        return null;
    }

    record.source = settingsRecord.source || record.source;
    record.model = settingsRecord.model || record.model;
    record.stream = Boolean(settingsRecord.stream);
    record.type = settingsRecord.type || record.type;
    record.settingsSignature = getRequestSettingsSignature(settingsRecord);
    saveSnapshotToDb(record);
    return record;
}

function maybeHandleUsageFromResponse(data, requestInfo = {}) {
    if (!data?.usage) {
        return;
    }

    handleBackendUsage({
        usage: data.usage,
        source: requestInfo.source || lastGenerationSettings?.source || '',
        model: requestInfo.model || data.model || lastGenerationSettings?.model || '',
        stream: Boolean(requestInfo.stream ?? lastGenerationSettings?.stream),
        type: requestInfo.type || lastGenerationSettings?.type || '',
        usagePath: requestInfo.usagePath || 'fetch_json_response',
    });
}

function maybeHandleUsageFromStreamText(text, requestInfo = {}) {
    const lines = String(text || '').split(/\r?\n/);
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) {
            continue;
        }

        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') {
            continue;
        }

        try {
            const data = JSON.parse(payload);
            if (data?.usage) {
                maybeHandleUsageFromResponse(data, {
                    ...requestInfo,
                    usagePath: requestInfo.usagePath || 'fetch_stream_text',
                });
                return;
            }
        } catch {
            // Ignore non-JSON event chunks.
        }
    }
}

function getRequestOptionRows(selectedId = '') {
    return requestHistory.map(record => {
        const metrics = getUsageMetrics(record.usage);
        const label = [
            record.id,
            record.at?.toLocaleTimeString?.() || '',
            record.model || '未知模型',
            record.stream ? '流式' : '非流式',
            record.usageReceived ? `命中 ${formatNumber(metrics.cachedTokens)}` : '未收到 usage',
        ].filter(Boolean).join(' / ');
        return `<option value="${escapeHtml(record.id)}" ${record.id === selectedId ? 'selected' : ''}>${escapeHtml(label)}</option>`;
    }).join('');
}

function getRecordPathMeta(path = '') {
    const map = {
        event_prompt_ready: { label: '事件记录', className: 'success', title: 'CHAT_COMPLETION_PROMPT_READY 创建请求快照，说明 SillyTavern 事件链路有效。' },
        fetch_generate: { label: 'fetch 兜底', className: 'warn', title: '从实际 /generate HTTP 请求体创建快照，说明事件记录链路未创建或未命中。' },
        event_plus_fetch: { label: '事件+fetch', className: 'success', title: '事件先创建快照，fetch 又用真实请求体补齐模型/来源等字段，是当前最完整链路。' },
    };
    return map[path] || { label: path || '未知', className: 'muted', title: '未知记录链路，需要查看快照 JSON。' };
}

function getUsagePathMeta(path = '') {
    const map = {
        fetch_json_response: { label: 'JSON usage', className: 'success', title: 'fetch 观察器从非流式 JSON 响应捕获 usage，是真实有效链路。' },
        fetch_stream_text: { label: '流式 usage', className: 'success', title: 'fetch 观察器从流式 SSE 文本捕获 usage，是真实有效链路。' },
        st_event_usage: { label: 'ST usage 事件', className: 'success', title: 'SillyTavern 原生 CHAT_COMPLETION_RESPONSE_USAGE 事件返回 usage。当前本地版本可能没有该事件。' },
        unknown: { label: '未知 usage', className: 'muted', title: '收到了 usage，但来源没有标记。' },
    };
    return map[path] || { label: path || '未收到', className: path ? 'muted' : 'danger', title: path ? '未知 usage 链路。' : '本次请求还没有收到后端 usage。' };
}

function renderPathBadge(meta) {
    return `<span class="dco-path-badge dco-path-badge--${escapeHtml(meta.className)}" title="${escapeHtml(meta.title || '')}">${escapeHtml(meta.label)}</span>`;
}

function getRequestById(id) {
    return requestHistory.find(record => record.id === id) || null;
}

function getDefaultCompareIds() {
    return {
        leftId: requestHistory[1]?.id || requestHistory[0]?.id || '',
        rightId: requestHistory[0]?.id || '',
    };
}

function getMessageDiffReport(leftId = '', rightId = '') {
    const left = getRequestById(leftId) || requestHistory[1] || null;
    const right = getRequestById(rightId) || requestHistory[0] || null;
    if (!left || !right) {
        return '至少需要两条请求记录才能对比。';
    }

    const leftSignatures = left.messageSignatures || getMessageSignatures(left.messages || []);
    const rightSignatures = right.messageSignatures || getMessageSignatures(right.messages || []);
    const firstChanged = getFirstChangedMessage(rightSignatures, leftSignatures);
    const max = Math.max(leftSignatures.length, rightSignatures.length);
    const changed = [];

    for (let index = 0; index < max; index++) {
        const a = leftSignatures[index];
        const b = rightSignatures[index];
        if (!a || !b || a.hash !== b.hash || a.role !== b.role) {
            changed.push({ index, before: a, after: b });
        }
        if (changed.length >= 12) break;
    }

    const leftMetrics = getUsageMetrics(left.usage);
    const rightMetrics = getUsageMetrics(right.usage);
    const lines = [
        `对比：${left.id} -> ${right.id}`,
        `时间：${left.at?.toLocaleString?.() || ''} -> ${right.at?.toLocaleString?.() || ''}`,
        `模型：${left.model || '未知'} -> ${right.model || '未知'}；模式：${left.stream ? '流式' : '非流式'} -> ${right.stream ? '流式' : '非流式'}`,
        `记录链路：${getRecordPathMeta(left.recordPath).label} -> ${getRecordPathMeta(right.recordPath).label}`,
        `usage 链路：${getUsagePathMeta(left.usagePath).label} -> ${getUsagePathMeta(right.usagePath).label}`,
        `usage：${left.usageReceived ? '已收到' : '未收到'} -> ${right.usageReceived ? '已收到' : '未收到'}`,
        `后端命中：${formatNumber(leftMetrics.cachedTokens)} / ${formatNumber(leftMetrics.promptTokens)} -> ${formatNumber(rightMetrics.cachedTokens)} / ${formatNumber(rightMetrics.promptTokens)}`,
        `最终前缀：${left.stats?.rawPrefixPercent ?? 0}% -> ${right.stats?.rawPrefixPercent ?? 0}%`,
        `插件影响：${left.stats?.pluginImpact ?? 0}% -> ${right.stats?.pluginImpact ?? 0}%`,
        `第一条变化消息：${firstChanged === null ? '无' : firstChanged}`,
        '',
        '变化消息摘要：',
    ];

    if (!changed.length) {
        lines.push('未发现消息级 hash 差异。');
    } else {
        for (const item of changed) {
            lines.push(`- #${item.index}`);
            lines.push(`  前：${item.before ? `${item.before.role} len=${item.before.length} hash=${item.before.hash} ${item.before.preview}` : '<不存在>'}`);
            lines.push(`  后：${item.after ? `${item.after.role} len=${item.after.length} hash=${item.after.hash} ${item.after.preview}` : '<不存在>'}`);
        }
    }

    return lines.join('\n');
}

function getRequestJson(record = requestHistory[0]) {
    if (!record) {
        return '';
    }

    return JSON.stringify({
        id: record.id,
        at: record.at,
        model: record.model,
        stream: record.stream,
        status: record.status,
        source: record.source,
        type: record.type,
        recordPath: record.recordPath,
        usagePath: record.usagePath,
        usage: record.usage,
        stats: record.stats,
        messages: record.messages,
    }, null, 2);
}

function exportPromptSnapshot(record) {
    const rec = record || requestHistory[0];
    if (!rec) {
        toastr.warning('没有可导出的请求记录');
        return;
    }

    const messages = (rec.messages || []).map((msg, i) => ({
        index: i,
        role: msg?.role ?? '',
        name: msg?.name ?? '',
        content: getMessageText(msg),
        hash: hashString(serializeMessage(msg)),
    }));
    const payload = {
        id: rec.id,
        at: rec.at,
        model: rec.model,
        usage: rec.usage,
        stats: rec.stats,
        messageCount: messages.length,
        messages,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `dco-prompt-${rec.id || 'unknown'}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toastr.success(`已导出 ${messages.length} 条消息`);
}

async function fetchMergedMessages(messages) {
    try {
        const cloned = clonePromptMessages(messages);
        const response = await fetch('/api/backends/chat-completions/process', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                messages: cloned,
                type: 'semi_tools',
                char_name: name2 || '',
                user_name: name1 || '',
                group_names: getGroupNames(),
            }),
        });
        if (!response.ok) {
            console.warn('[DCO] /process endpoint returned HTTP', response.status);
            return null;
        }
        const data = await response.json();
        return Array.isArray(data?.messages) ? data.messages : null;
    } catch (error) {
        console.warn('[DCO] fetchMergedMessages failed:', error);
        return null;
    }
}

async function refreshBackendBodyRecords() {
    if (backendDebugUnavailable) {
        return backendBodyRecords;
    }

    const response = await fetch('/api/backends/chat-completions/dco-debug-bodies', {
        headers: getRequestHeaders(),
    });

    if (!response.ok) {
        if (response.status === 404) {
            backendDebugUnavailable = true;
            return backendBodyRecords;
        }
        throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    backendBodyRecords = Array.isArray(data?.records) ? data.records : [];
    return backendBodyRecords;
}

async function clearBackendBodyRecords() {
    if (backendDebugUnavailable) {
        backendBodyRecords = [];
        return;
    }

    const response = await fetch('/api/backends/chat-completions/dco-debug-clear', {
        method: 'POST',
        headers: getRequestHeaders(),
    });

    if (!response.ok) {
        if (response.status === 404) {
            backendDebugUnavailable = true;
            backendBodyRecords = [];
            return;
        }
        throw new Error(`HTTP ${response.status}`);
    }

    backendBodyRecords = [];
}

function rememberBackendBodyFromFetch(body, requestJson = {}) {
    const settings = getSettings();
    if (!settings.diagnosticsEnabled) {
        return;
    }

    const bodyText = typeof body === 'string' ? body : '';
    if (!bodyText) {
        return;
    }

    const previous = backendBodyRecords[0] || null;
    const firstDiffChar = previous ? getCommonPrefixLength(previous.body || '', bodyText) : -1;
    const identical = previous ? firstDiffChar === previous.body.length && previous.body.length === bodyText.length : false;
    const record = {
        id: `BODY-${String(backendBodyRecords.length + 1).padStart(4, '0')}`,
        at: new Date().toISOString(),
        model: requestJson?.model || lastGenerationSettings?.model || '',
        stream: Boolean(requestJson?.stream ?? lastGenerationSettings?.stream),
        body: bodyText,
        charLength: bodyText.length,
        byteLength: new TextEncoder().encode(bodyText).length,
        hash: hashString(bodyText),
        diffFromPrevious: previous ? {
            identical,
            firstDiffChar: identical ? -1 : firstDiffChar,
            firstDiffByte: identical ? -1 : findFirstByteDiff(previous.body || '', bodyText),
        } : null,
        messageDiffFromPrevious: null,
    };

    if (previous) {
        try {
            record.messageDiffFromPrevious = getFirstBodyMessageDiff(JSON.parse(previous.body || '{}'), requestJson || {});
        } catch {
            record.messageDiffFromPrevious = null;
        }
    }

    backendBodyRecords.unshift(record);
    backendBodyRecords = backendBodyRecords.slice(0, HISTORY_MAX);
}

function getBackendBodyById(id) {
    return backendBodyRecords.find(record => record.id === id) || null;
}

function getDefaultBackendBodyCompareIds() {
    return {
        leftId: backendBodyRecords[1]?.id || backendBodyRecords[0]?.id || '',
        rightId: backendBodyRecords[0]?.id || '',
    };
}

function getBackendBodyOptionRows(selectedId = '') {
    return backendBodyRecords.map(record => {
        const label = [
            record.id,
            record.at ? new Date(record.at).toLocaleTimeString() : '',
            record.model || '未知模型',
            record.stream ? '流式' : '非流式',
            `${formatNumber(record.byteLength)} bytes`,
            record.hash,
        ].filter(Boolean).join(' / ');
        return `<option value="${escapeHtml(record.id)}" ${record.id === selectedId ? 'selected' : ''}>${escapeHtml(label)}</option>`;
    }).join('');
}

function getBackendBodyRows() {
    return backendBodyRecords.map(record => {
        const diff = record.diffFromPrevious;
        const messageDiff = record.messageDiffFromPrevious;
        return `
            <tr>
                <td>${escapeHtml(record.id)}</td>
                <td>${record.at ? escapeHtml(new Date(record.at).toLocaleTimeString()) : ''}</td>
                <td>${escapeHtml(record.model || '')}</td>
                <td>${record.stream ? '流式' : '非流式'}</td>
                <td>${formatNumber(record.charLength)}</td>
                <td>${formatNumber(record.byteLength)}</td>
                <td>${escapeHtml(record.hash || '')}</td>
                <td>${diff ? (diff.identical ? '完全一致' : `${formatNumber(diff.firstDiffChar)} 字符 / ${formatNumber(diff.firstDiffByte)} 字节`) : '本页首次'}</td>
                <td>${messageDiff ? `#${escapeHtml(messageDiff.index)} ${escapeHtml(messageDiff.leftRole || '')}->${escapeHtml(messageDiff.rightRole || '')}` : '-'}</td>
            </tr>
        `;
    }).join('');
}

function findFirstByteDiff(left, right) {
    const leftBytes = new TextEncoder().encode(left);
    const rightBytes = new TextEncoder().encode(right);
    const max = Math.min(leftBytes.length, rightBytes.length);

    for (let index = 0; index < max; index++) {
        if (leftBytes[index] !== rightBytes[index]) {
            return index;
        }
    }

    return leftBytes.length === rightBytes.length ? -1 : max;
}

function getJsonPathDiff(leftValue, rightValue, path = '$') {
    if (Object.is(leftValue, rightValue)) {
        return null;
    }

    const leftIsArray = Array.isArray(leftValue);
    const rightIsArray = Array.isArray(rightValue);
    if (leftIsArray || rightIsArray) {
        if (!leftIsArray || !rightIsArray) return path;
        const max = Math.max(leftValue.length, rightValue.length);
        for (let index = 0; index < max; index++) {
            if (!(index in leftValue) || !(index in rightValue)) return `${path}[${index}]`;
            const child = getJsonPathDiff(leftValue[index], rightValue[index], `${path}[${index}]`);
            if (child) return child;
        }
        return null;
    }

    const leftIsObject = leftValue && typeof leftValue === 'object';
    const rightIsObject = rightValue && typeof rightValue === 'object';
    if (leftIsObject || rightIsObject) {
        if (!leftIsObject || !rightIsObject) return path;
        const keys = Array.from(new Set([...Object.keys(leftValue), ...Object.keys(rightValue)]));
        for (const key of keys) {
            if (!(key in leftValue) || !(key in rightValue)) return `${path}.${key}`;
            const child = getJsonPathDiff(leftValue[key], rightValue[key], `${path}.${key}`);
            if (child) return child;
        }
        return null;
    }

    return path;
}

function getBodyContext(body, index, radius = 180) {
    if (index < 0) {
        return '';
    }

    const start = Math.max(0, index - radius);
    const end = Math.min(body.length, index + radius);
    return body.slice(start, end);
}

function getBackendBodyDiffReport(leftId = '', rightId = '') {
    const left = getBackendBodyById(leftId) || backendBodyRecords[1] || null;
    const right = getBackendBodyById(rightId) || backendBodyRecords[0] || null;
    if (!left || !right) {
        return '至少需要两条后端最终请求体记录才能对比。修改后端代码后需要重启 SillyTavern，随后生成两次。';
    }

    const leftBody = String(left.body || '');
    const rightBody = String(right.body || '');
    const firstDiffChar = getCommonPrefixLength(leftBody, rightBody);
    const identical = firstDiffChar === leftBody.length && leftBody.length === rightBody.length;
    const firstDiffByte = identical ? -1 : findFirstByteDiff(leftBody, rightBody);
    let leftJson = {};
    let rightJson = {};
    try {
        leftJson = JSON.parse(leftBody || '{}');
        rightJson = JSON.parse(rightBody || '{}');
    } catch {
        leftJson = {};
        rightJson = {};
    }
    const jsonPath = getJsonPathDiff(leftJson, rightJson) || '无';
    const leftMessageCount = Array.isArray(leftJson.messages) ? leftJson.messages.length : 0;
    const rightMessageCount = Array.isArray(rightJson.messages) ? rightJson.messages.length : 0;
    const messageDiff = getFirstBodyMessageDiff(leftJson, rightJson);

    const lines = [
        `对比最终 HTTP body：${left.id} -> ${right.id}`,
        `时间：${left.at ? new Date(left.at).toLocaleString() : ''} -> ${right.at ? new Date(right.at).toLocaleString() : ''}`,
        `模型：${left.model || '未知'} -> ${right.model || '未知'}；模式：${left.stream ? '流式' : '非流式'} -> ${right.stream ? '流式' : '非流式'}`,
        `body 长度：${formatNumber(left.charLength)} 字符 / ${formatNumber(left.byteLength)} 字节 -> ${formatNumber(right.charLength)} 字符 / ${formatNumber(right.byteLength)} 字节`,
        `body hash：${left.hash || ''} -> ${right.hash || ''}`,
        `messages 数：${leftMessageCount} -> ${rightMessageCount}`,
        identical ? '结论：两个最终 HTTP body 完全一致。' : `第一处不同：第 ${formatNumber(firstDiffChar)} 个 UTF-16 字符，第 ${formatNumber(firstDiffByte)} 个 UTF-8 字节。`,
        `第一处 JSON 路径：${jsonPath}`,
    ];

    if (messageDiff) {
        lines.push(
            '',
            `第一条不同 message：#${messageDiff.index}`,
            `旧：${messageDiff.leftRole || '<无>'} len=${formatNumber(messageDiff.leftLength)} ${messageDiff.leftPreview}`,
            `新：${messageDiff.rightRole || '<无>'} len=${formatNumber(messageDiff.rightLength)} ${messageDiff.rightPreview}`,
        );
    }

    if (!identical) {
        lines.push(
            '',
            '旧 body 首差异附近：',
            getBodyContext(leftBody, firstDiffChar),
            '',
            '新 body 首差异附近：',
            getBodyContext(rightBody, firstDiffChar),
        );
    }

    return lines.join('\n');
}

function getFirstBodyMessageDiff(leftJson, rightJson) {
    const leftMessages = Array.isArray(leftJson?.messages) ? leftJson.messages : [];
    const rightMessages = Array.isArray(rightJson?.messages) ? rightJson.messages : [];
    const max = Math.max(leftMessages.length, rightMessages.length);

    for (let index = 0; index < max; index++) {
        const leftMessage = leftMessages[index];
        const rightMessage = rightMessages[index];
        const leftText = JSON.stringify(leftMessage ?? null);
        const rightText = JSON.stringify(rightMessage ?? null);
        if (leftText !== rightText) {
            const leftContent = typeof leftMessage?.content === 'string' ? leftMessage.content : leftText;
            const rightContent = typeof rightMessage?.content === 'string' ? rightMessage.content : rightText;
            return {
                index,
                leftRole: leftMessage?.role ?? '',
                rightRole: rightMessage?.role ?? '',
                leftLength: leftContent.length,
                rightLength: rightContent.length,
                leftPreview: normalizeText(leftContent).slice(0, 120),
                rightPreview: normalizeText(rightContent).slice(0, 120),
            };
        }
    }

    return null;
}

function getBackendBodyJson(record = backendBodyRecords[0]) {
    if (!record) {
        return '';
    }

    try {
        return JSON.stringify(JSON.parse(record.body || '{}'), null, 2);
    } catch {
        return String(record.body || '');
    }
}

async function copyTextToClipboard(text, successMessage = '已复制') {
    if (!text) {
        toastr.warning('没有可复制的内容。');
        return;
    }

    try {
        await navigator.clipboard.writeText(text);
        toastr.success(successMessage);
    } catch (error) {
        console.warn('[DeepSeek Cache Optimizer] Clipboard failed', error);
        toastr.error('复制失败，请打开浏览器控制台手动复制。');
    }
}

function getUsageSummaryText(record = lastBackendUsage) {
    if (!record?.usage) {
        return getBackendUsageText();
    }

    const metrics = getUsageMetrics(record.usage);
    return [
        `来源：${record.source || '未知'} / ${record.model || '未知模型'} / ${record.stream ? '流式' : '非流式'} / ${record.type || '主请求'}`,
        `时间：${record.at?.toLocaleString?.() || '未知'}`,
        `prompt_tokens：${formatNumber(metrics.promptTokens)}`,
        `completion_tokens：${formatNumber(metrics.completionTokens)}`,
        `cached_tokens：${formatNumber(metrics.cachedTokens)}`,
        `miss_tokens：${formatNumber(metrics.missTokens)}`,
        `缓存命中率：${metrics.hitPercent}%`,
    ].join('\n');
}

function getBackendUsageText() {
    if (!lastBackendUsage?.usage) {
        const streamState = lastGenerationSettings
            ? `最近请求：${lastGenerationSettings.source || '未知源'} / ${lastGenerationSettings.model || '未知模型'} / ${lastGenerationSettings.stream ? '流式' : '非流式'}`
            : '还没有捕获到最近请求设置。';
        const streamOptionsState = lastGenerationSettings?.stream_options
            ? `stream_options：${JSON.stringify(lastGenerationSettings.stream_options)}`
            : 'stream_options：未发送或当前源不支持自动发送。';
        return [
            '暂无后端 usage。',
            streamState,
            streamOptionsState,
            '这表示前端还没有收到上游返回的 usage 字段，不代表缓存命中为 0。',
            '如果你当前使用流式输出，请确认 NewAPI 实际把最后一个 usage chunk 转发出来；也可以临时关闭流式输出测试非流式 usage。',
        ].join('\n');
    }

    return getUsageSummaryText(lastBackendUsage);
}

function getCacheDiagnosisText(stats = lastStats, usage = lastBackendUsage?.usage) {
    if (!usage) {
        return '后端 usage 尚未返回，暂时只能看本地共同前缀。';
    }

    const metrics = getUsageMetrics(usage);
    const notes = [];

    if (metrics.cachedTokens <= 0 && Number(stats.rawPrefixPercent || 0) >= 70) {
        notes.push('本地原始前缀较高但后端没有命中：说明本地字符级比较和后端 token 缓存口径不同，或上游没有复用同一缓存会话。');
    } else if (metrics.hitPercent < 20 && Number(stats.rawPrefixPercent || 0) >= 70) {
        notes.push('本地原始前缀较高但后端命中偏低：后端可能按 token 边界、模型参数、网关路由或缓存 TTL 判断，而不是按前端字符前缀判断。');
    }

    if (Number(stats.stableMessagePrefixChars || 0) > 0 && metrics.cachedTokens > 0) {
        notes.push(`当前第一处消息变化前约 ${formatNumber(stats.stableMessagePrefixChars)} 文本字符；后端报告命中 ${formatNumber(metrics.cachedTokens)} tokens。两者单位不同，但可用来判断命中是否大致落在首变之前。`);
    }

    if (Number(stats.runId || 0) <= 1) {
        notes.push('这是当前页面捕获到的第一个主请求；本地前缀只能和本页之后的请求稳定比较。');
    }

    const requestSignature = getRequestSettingsSignature(lastGenerationSettings);
    if (stats.requestSettingsSignature && requestSignature && stats.requestSettingsSignature !== requestSignature) {
        notes.push('最近请求配置签名发生过变化，模型、源、流式或 stream_options 变化都可能让后端缓存失效。');
    }

    if (lastGenerationSettings?.stream && !lastGenerationSettings?.stream_options?.include_usage) {
        notes.push('当前为流式请求，但没有看到 stream_options.include_usage；部分网关可能不会稳定返回最终 usage。');
    }

    if (!notes.length) {
        notes.push('后端 usage 已捕获。本地前缀只用于看趋势，最终以 cached_tokens / prompt_cache_hit_tokens 为准。');
    }

    return notes.join('\n');
}

function handleBackendUsage(eventData) {
    if (!eventData?.usage) {
        return;
    }

    lastBackendUsage = {
        ...eventData,
        at: new Date(),
    };
    lastStats = {
        ...lastStats,
        requestSettingsSignature: getRequestSettingsSignature(lastGenerationSettings),
        requestType: lastGenerationSettings?.type || eventData.type || '',
    };
    const record = updateLatestRequestWithUsage({
        usagePath: 'st_event_usage',
        ...eventData,
    });
    if (record) {
        record.stats = structuredClone(lastStats);
        saveSnapshotToDb(record);
    }
    usageHistory = requestHistory.filter(item => item.usageReceived).slice(0, 20);

    updateStats();
}

function installFetchObserver() {
    if (fetchPatched || typeof window === 'undefined' || typeof window.fetch !== 'function') {
        return;
    }

    const originalFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
        const response = await originalFetch(...args);
        try {
            const input = args[0];
            const init = args[1] || {};
            const url = typeof input === 'string' ? input : input?.url || '';
            if (!String(url).includes('/api/backends/chat-completions/generate')) {
                return response;
            }

            let requestBody = init?.body;
            if (requestBody === undefined && input instanceof Request) {
                try {
                    requestBody = await input.clone().text();
                } catch {
                    requestBody = '';
                }
            }

            let requestJson = {};
            if (typeof requestBody === 'string' && requestBody) {
                try {
                    requestJson = JSON.parse(requestBody);
                } catch {
                    requestJson = {};
                }
            }

            handleGenerationSettings(requestJson);
            rememberRequestRecordFromFetch(requestBody, requestJson);
            rememberBackendBodyFromFetch(requestBody, requestJson);

            const contentType = response.headers?.get?.('content-type') || '';
            if (response.ok && contentType.includes('application/json')) {
                response.clone().json()
                    .then(data => maybeHandleUsageFromResponse(data, {
                        source: requestJson.chat_completion_source,
                        model: requestJson.model,
                        stream: requestJson.stream,
                        type: requestJson.type,
                        usagePath: 'fetch_json_response',
                    }))
                    .catch(() => {});
            } else if (response.ok && requestJson?.stream) {
                response.clone().text()
                    .then(text => maybeHandleUsageFromStreamText(text, {
                        source: requestJson.chat_completion_source,
                        model: requestJson.model,
                        stream: requestJson.stream,
                        type: requestJson.type,
                        usagePath: 'fetch_stream_text',
                    }))
                    .catch(() => {});
            }
        } catch (error) {
            console.warn('[DeepSeek Cache Optimizer] fetch observer failed:', error);
        }

        return response;
    };
    fetchPatched = true;
}

function handleGenerationSettings(generateData) {
    lastGenerationSettings = {
        at: new Date(),
        type: generateData?.type,
        source: generateData?.chat_completion_source,
        model: generateData?.model,
        stream: Boolean(generateData?.stream),
        stream_options: generateData?.stream_options,
    };
    updateLatestRequestWithGenerationSettings(lastGenerationSettings);

    updateStats();
}

function getFirstChangedMessage(current, previous) {
    const max = Math.max(current.length, previous.length);

    for (let index = 0; index < max; index++) {
        if (!current[index] || !previous[index]) {
            return index;
        }

        if (current[index].hash !== previous[index].hash || current[index].role !== previous[index].role) {
            return index;
        }
    }

    return null;
}

function hasPattern(patterns, text) {
    return patterns.some(pattern => pattern.test(text));
}

function isVariableSchemaMessage(message) {
    const text = getMessageText(message);
    if (!text || isRichFormatMessage(message)) {
        return false;
    }

    const hasVariableApi = /UpdateVariable|_.set\(|getvar\(|stat_data\.|path_of_changed_variable/i.test(text);
    const hasCurrentValues = /<status_current_variables>|当前所想|内心想法|当前位置|当前事件标记/i.test(text);
    return hasVariableApi && !hasCurrentValues;
}

function isWorldStaticMessageText(text) {
    return /world info|lore|相关信息|世界书|data bank|relevant information|related information/i.test(text);
}

function isStablePromptLikeMessage(message) {
    const text = getMessageText(message);
    const normalized = normalizeText(text);
    if (!normalized || isRichFormatMessage(message)) {
        return false;
    }

    return isVariableSchemaMessage(message)
        || isHistoryMarkerMessage(message)
        || hasPattern(stableInstructionPatterns, normalized)
        || hasPattern(stableContentPatterns, normalized)
        || isWorldStaticMessageText(normalized);
}

function isAdaptiveCandidate(message, index, messages) {
    const text = getMessageText(message);
    if (!text || isRichFormatMessage(message) || isHardDynamicMessage(message) || isHistoryMarkerMessage(message)) {
        return false;
    }

    if (message?.tool_calls || message?.tool_call_id) {
        return false;
    }

    const role = message?.role || '';
    if (role === 'assistant' || role === 'tool') {
        return false;
    }

    if (role === 'user') {
        return index !== getLatestUserMessageIndex(messages);
    }

    return role === 'system' || role === 'developer';
}

function getAdaptiveStableOrder(hash) {
    return adaptiveStableOrder.has(hash) ? adaptiveStableOrder.get(hash) : 240;
}

function classifyPromptMessage(message, index, messages) {
    const text = getMessageText(message);
    const normalized = normalizeText(text);
    const rich = isRichFormatMessage(message);
    const role = message?.role || '';
    const lastUserIndex = getLatestUserMessageIndex(messages);

    if (!normalized) {
        return {
            index,
            role,
            category: 'empty',
            stability: 'stable',
            movable: true,
            order: 10,
            reason: '空消息',
            length: text.length,
            hash: hashString(serializeMessage(message)),
            preview: '',
        };
    }

    if (rich) {
        return {
            index,
            role,
            category: 'rich_format',
            stability: 'pinned',
            movable: false,
            order: 900,
            reason: '检测到 HTML/CSS/前端页面块，原位保护',
            length: text.length,
            hash: hashString(serializeMessage(message)),
            preview: normalized.slice(0, 80),
        };
    }

    const messageHash = hashString(serializeMessage(message));
    if (adaptiveStableHashSet.has(messageHash) && isAdaptiveCandidate(message, index, messages)) {
        return {
            index,
            role,
            category: 'adaptive_stable',
            stability: 'stable',
            movable: true,
            order: getAdaptiveStableOrder(messageHash),
            reason: '连续 3 次请求内容相同且低命中率触发，锁定为自适应稳定块',
            length: text.length,
            hash: messageHash,
            preview: normalized.slice(0, 80),
        };
    }

    if (isVariableSchemaMessage(message)) {
        return {
            index,
            role,
            category: 'variable_schema',
            stability: 'stable',
            movable: true,
            order: 360,
            reason: '变量更新规则/脚本格式较稳定，放在动态变量值之前',
            length: text.length,
            hash: hashString(serializeMessage(message)),
            preview: normalized.slice(0, 80),
        };
    }

    if (isHardDynamicMessage(message)) {
        return {
            index,
            role,
            category: 'dynamic_state',
            stability: 'dynamic',
            movable: true,
            order: 560,
            reason: '当前状态/变量值会频繁变化，后移以保护公共前缀',
            length: text.length,
            hash: hashString(serializeMessage(message)),
            preview: normalized.slice(0, 80),
        };
    }

    if (isHistoryMarkerMessage(message)) {
        return {
            index,
            role,
            category: 'history_marker',
            stability: 'medium',
            movable: true,
            order: 590,
            reason: '历史分隔标记，保持靠近聊天历史',
            length: text.length,
            hash: hashString(serializeMessage(message)),
            preview: normalized.slice(0, 80),
        };
    }

    if (role === 'assistant' || role === 'tool' || message?.tool_calls || message?.tool_call_id) {
        return {
            index,
            role,
            category: 'chat_history',
            stability: 'dynamic',
            movable: false,
            order: 1000,
            reason: '聊天历史不能参与前缀重排',
            length: text.length,
            hash: hashString(serializeMessage(message)),
            preview: normalized.slice(0, 80),
        };
    }

    if (hasPattern(stableInstructionPatterns, normalized)) {
        const category = /输出|format|模板|段落|对白|字数|语言/i.test(normalized) ? 'format_rule' : 'stable_rule';
        return {
            index,
            role,
            category,
            stability: 'stable',
            movable: true,
            order: category === 'format_rule' ? 320 : 100,
            reason: '稳定预设/格式规则，适合前置形成缓存前缀',
            length: text.length,
            hash: hashString(serializeMessage(message)),
            preview: normalized.slice(0, 80),
        };
    }

    if (hasPattern(stableContentPatterns, normalized)) {
        return {
            index,
            role,
            category: 'character_static',
            stability: 'stable',
            movable: true,
            order: 180,
            reason: '角色卡/人物设定通常稳定，适合前置',
            length: text.length,
            hash: hashString(serializeMessage(message)),
            preview: normalized.slice(0, 80),
        };
    }

    if (isWorldStaticMessageText(normalized)) {
        return {
            index,
            role,
            category: 'world_static',
            stability: 'medium',
            movable: true,
            order: 420,
            reason: '世界书内容本身稳定但激活集合会变，放在核心静态设定之后',
            length: text.length,
            hash: hashString(serializeMessage(message)),
            preview: normalized.slice(0, 80),
        };
    }

    if (role === 'user' && index === lastUserIndex) {
        return {
            index,
            role,
            category: 'latest_input',
            stability: 'dynamic',
            movable: false,
            order: 1100,
            reason: '最新用户输入必须保持在末尾语义位置',
            length: text.length,
            hash: hashString(serializeMessage(message)),
            preview: normalized.slice(0, 80),
        };
    }

    if (role === 'user') {
        return {
            index,
            role,
            category: 'chat_history',
            stability: 'dynamic',
            movable: false,
            order: 1000,
            reason: '普通 user 消息按聊天历史处理',
            length: text.length,
            hash: hashString(serializeMessage(message)),
            preview: normalized.slice(0, 80),
        };
    }

    if (hasPattern(stableInstructionPatterns, normalized)) {
        const category = /输出|format|模板|段落|对白|字数|语言/i.test(normalized) ? 'format_rule' : 'stable_rule';
        return {
            index,
            role,
            category,
            stability: 'stable',
            movable: true,
            order: category === 'format_rule' ? 320 : 100,
            reason: '稳定预设/格式规则，适合前置形成缓存前缀',
            length: text.length,
            hash: hashString(serializeMessage(message)),
            preview: normalized.slice(0, 80),
        };
    }

    if (hasPattern(stableContentPatterns, normalized)) {
        return {
            index,
            role,
            category: 'character_static',
            stability: 'stable',
            movable: true,
            order: 180,
            reason: '角色卡/人物设定通常稳定，适合前置',
            length: text.length,
            hash: hashString(serializeMessage(message)),
            preview: normalized.slice(0, 80),
        };
    }

    if (isWorldStaticMessageText(normalized)) {
        return {
            index,
            role,
            category: 'world_static',
            stability: 'medium',
            movable: true,
            order: 420,
            reason: '世界书内容本身稳定但激活集合会变，放在核心静态设定之后',
            length: text.length,
            hash: hashString(serializeMessage(message)),
            preview: normalized.slice(0, 80),
        };
    }

    if (role === 'system') {
        return {
            index,
            role,
            category: 'unknown_stable',
            stability: 'medium',
            movable: true,
            order: 260,
            reason: '普通 system 块，按策略参与稳定前缀排序',
            length: text.length,
            hash: hashString(serializeMessage(message)),
            preview: normalized.slice(0, 80),
        };
    }

    return {
        index,
        role,
        category: 'unsafe_to_move',
        stability: 'pinned',
        movable: false,
        order: 950,
        reason: '无法确认语义边界，保持原位',
        length: text.length,
        hash: hashString(serializeMessage(message)),
        preview: normalized.slice(0, 80),
    };
}

function isRichFormatMessage(message) {
    const text = getMessageText(message);
    if (!text) {
        return false;
    }

    const htmlTagCount = (text.match(/<\/?[a-z][\w:-]*(?:\s+[^>]*)?>/gi) || []).length;
    const cssRuleCount = (text.match(/[.#][\w-]+\s*\{[^}]+\}/g) || []).length;

    return htmlTagCount >= 4
        || cssRuleCount >= 2
        || richFormatPatterns.some(pattern => pattern.test(text));
}

function getLatestUserMessageIndex(messages) {
    for (let index = messages.length - 1; index >= 0; index--) {
        if (messages[index]?.role === 'user' && !isHardDynamicMessage(messages[index]) && !isHistoryMarkerMessage(messages[index])) {
            return index;
        }
    }

    return -1;
}

function isHardDynamicMessage(message) {
    const text = getMessageText(message);
    if (!text) {
        return false;
    }

    return hardDynamicBlockPatterns.some(pattern => pattern.test(text));
}

function isHistoryMarkerMessage(message) {
    const text = getMessageText(message);
    return /<\/?互动历史>|<最新互动>|<\/?核心指导>|<｜User｜>|<\|User\|>/i.test(text);
}

function getAnalyzerBoundary(analysis) {
    const hardBoundary = analysis.find(item => item.category === 'chat_history' || item.category === 'latest_input');
    return hardBoundary ? hardBoundary.index : analysis.length;
}

function shouldAnalyzerMove(item, settings) {
    if (!item.movable || item.category === 'rich_format') {
        return false;
    }

    if (settings.strategy === 'conservative') {
        return ['stable_rule', 'adaptive_stable', 'character_static', 'format_rule', 'variable_schema', 'dynamic_state', 'history_marker'].includes(item.category);
    }

    return ['stable_rule', 'adaptive_stable', 'character_static', 'world_static', 'format_rule', 'variable_schema', 'dynamic_state', 'history_marker', 'unknown_stable', 'empty'].includes(item.category);
}

function shouldPromoteAcrossHistory(item, settings) {
    if (!shouldAnalyzerMove(item, settings)) {
        return false;
    }

    return ['stable_rule', 'adaptive_stable', 'character_static', 'world_static', 'format_rule', 'variable_schema', 'unknown_stable'].includes(item.category);
}

function shouldMoveDynamicAfterHistory(item, settings) {
    if (!shouldAnalyzerMove(item, settings)) {
        return false;
    }

    return item.category === 'dynamic_state';
}

function getAdaptiveSampleSignatures(messages) {
    return messages
        .map((message, index) => ({
            index,
            hash: hashString(serializeMessage(message)),
            role: message?.role || '',
            textLength: getMessageText(message).length,
            candidate: isAdaptiveCandidate(message, index, messages),
        }))
        .filter(item => item.candidate);
}

function resetAdaptiveStablePlan(reason = '等待 3 次请求样本') {
    adaptivePromptSamples = [];
    adaptiveStableHashes = [];
    adaptiveStableHashSet = new Set();
    adaptiveStableOrder = new Map();
    adaptivePlanLocked = false;
    adaptivePlanReason = reason;
}

function getRecentBackendHitRate() {
    const metrics = getBackendUsageMetrics();
    if (metrics.promptTokens > 0) {
        return metrics.hitPercent;
    }

    const recent = usageHistory.find(item => item?.usage);
    return recent ? getUsageMetrics(recent.usage).hitPercent : null;
}

function updateAdaptiveStablePlan(messages, settings) {
    if (!settings.adaptiveStableReorder) {
        adaptivePlanReason = '自适应稳定块识别已关闭';
        return;
    }

    if (adaptivePlanLocked) {
        return;
    }

    const sampleSize = Math.max(2, Number(settings.adaptiveSampleSize || defaultSettings.adaptiveSampleSize));
    adaptivePromptSamples.push(getAdaptiveSampleSignatures(messages));
    adaptivePromptSamples = adaptivePromptSamples.slice(-sampleSize);

    if (adaptivePromptSamples.length < sampleSize) {
        adaptivePlanReason = `采样中：${adaptivePromptSamples.length}/${sampleSize}`;
        return;
    }

    const hitRate = getRecentBackendHitRate();
    const threshold = Number(settings.adaptiveHitRateThreshold ?? defaultSettings.adaptiveHitRateThreshold);
    if (hitRate !== null && hitRate >= threshold) {
        adaptivePlanReason = `后端命中率 ${hitRate}% 已达到 ${threshold}%，暂不启用自适应前置`;
        return;
    }

    const counts = new Map();
    const firstSeen = new Map();
    for (const sample of adaptivePromptSamples) {
        const seenInSample = new Set();
        for (const item of sample) {
            if (seenInSample.has(item.hash)) {
                continue;
            }
            seenInSample.add(item.hash);
            counts.set(item.hash, (counts.get(item.hash) || 0) + 1);
            if (!firstSeen.has(item.hash)) {
                firstSeen.set(item.hash, item.index);
            }
        }
    }

    adaptiveStableHashes = [...counts.entries()]
        .filter(([, count]) => count >= sampleSize)
        .map(([hash]) => hash)
        .sort((a, b) => (firstSeen.get(a) ?? 9999) - (firstSeen.get(b) ?? 9999));
    adaptiveStableHashSet = new Set(adaptiveStableHashes);
    adaptiveStableOrder = new Map(adaptiveStableHashes.map((hash, index) => [hash, 220 + index]));
    adaptivePlanLocked = adaptiveStableHashes.length > 0;
    adaptivePlanReason = adaptivePlanLocked
        ? `已锁定 ${adaptiveStableHashes.length} 个连续 ${sampleSize} 次相同的稳定块；触发命中率：${hitRate ?? '未知'}%`
        : `连续 ${sampleSize} 次没有发现可安全前置的相同块`;
}

function reorderWithAnalyzer(messages, settings) {
    const analysis = messages.map((message, index) => classifyPromptMessage(message, index, messages));
    updateAdaptiveStablePlan(messages, settings);
    const promotable = analysis.filter(item => shouldPromoteAcrossHistory(item, settings));
    const minPrefixMessages = Number(settings.minPrefixMessages || defaultSettings.minPrefixMessages);
    const effectivePromotable = promotable.length >= minPrefixMessages ? promotable : [];
    const dynamicTail = analysis.filter(item => shouldMoveDynamicAfterHistory(item, settings));
    if (!effectivePromotable.length && !dynamicTail.length) {
        return { changed: false, messages, moved: 0, protected: analysis.filter(item => item.category === 'rich_format').length, analysis };
    }

    const movedIndexes = new Set([...effectivePromotable, ...dynamicTail].map(item => item.index));
    const orderedPromoted = effectivePromotable
        .slice()
        .sort((a, b) => a.order - b.order || a.index - b.index)
        .map(item => messages[item.index]);
    const orderedDynamicTail = dynamicTail
        .slice()
        .sort((a, b) => a.index - b.index)
        .map(item => messages[item.index]);
    const remaining = analysis
        .filter(item => !movedIndexes.has(item.index))
        .map(item => ({ item, message: messages[item.index] }));
    const stableInsertAt = remaining.findIndex(({ item }) => item.category === 'chat_history' || item.category === 'latest_input');
    const stableInsertionIndex = stableInsertAt === -1 ? remaining.length : stableInsertAt;
    const withStablePrefix = [
        ...remaining.slice(0, stableInsertionIndex).map(entry => entry.message),
        ...orderedPromoted,
        ...remaining.slice(stableInsertionIndex).map(entry => entry.message),
    ];
    const dynamicInsertAt = withStablePrefix.findIndex(message => {
        const item = analysis.find(entry => messages[entry.index] === message);
        return item?.category === 'latest_input';
    });
    const dynamicInsertionIndex = dynamicInsertAt === -1 ? withStablePrefix.length : dynamicInsertAt;
    const reordered = [
        ...withStablePrefix.slice(0, dynamicInsertionIndex),
        ...orderedDynamicTail,
        ...withStablePrefix.slice(dynamicInsertionIndex),
    ];
    const changed = reordered.some((message, index) => message !== messages[index]);
    const nextAnalysis = reordered.map((message, index) => {
        const original = analysis.find(item => messages[item.index] === message);
        return {
            ...classifyPromptMessage(message, index, reordered),
            originalIndex: original?.index ?? index,
            moved: (original?.index ?? index) !== index,
            reason: original?.reason || '',
        };
    });

    return {
        changed,
        messages: changed ? reordered : messages,
        moved: changed ? nextAnalysis.filter(item => item.moved).length : 0,
        protected: analysis.filter(item => item.category === 'rich_format').length,
        analysis: nextAnalysis,
    };
}

async function optimizeChatCompletionPrompt(eventData) {
    const settings = getSettings();
    const diagnosticsEnabled = Boolean(settings.diagnosticsEnabled);

    if (eventData?.dryRun) {
        return;
    }

    if (!Array.isArray(eventData?.chat)) {
        lastStats = { moved: 0, total: 0, skipped: '没有聊天请求数据', protected: 0, rawPrefixChars: 0, rawPrefixPercent: 0, rawInputPercent: 0, pluginImpact: 0, firstChangedMessage: null, firstMessageHash: '' };
        updateStats();
        return;
    }

    // Serialize raw content only when diagnostics are enabled; this can be large.
    const rawContentBefore = diagnosticsEnabled ? serializeRawContent(eventData.chat) : '';

    promptRunCounter += 1;

    // Reordering: only runs if explicitly enabled
    let totalMoved = 0;
    let totalProtected = 0;
    if (settings.enabled) {
        const result = reorderWithAnalyzer(eventData.chat, settings);
        if (result.changed) {
            eventData.chat.splice(0, eventData.chat.length, ...result.messages);
        }
        totalMoved = result.moved;
        totalProtected = result.protected;
        lastPromptAnalysis = result.analysis || eventData.chat.map((message, index) => classifyPromptMessage(message, index, eventData.chat));
    } else {
        lastPromptAnalysis = diagnosticsEnabled
            ? eventData.chat.map((message, index) => classifyPromptMessage(message, index, eventData.chat))
            : [];
    }

    // --- Merge-aware stability (calls server /process endpoint) ---
    let mergedMessages = null;
    let mergedContentAfter = '';
    let mergedPrefixPercent = null;
    let mergedPrefixChars = null;
    let mergedSignatures = [];
    let mergedMessagePrefixCount = null;
    let mergedFirstChangedMessage = null;

    if (diagnosticsEnabled && settings.mergedDiagnostics && mergeAwareAvailable) {
        mergedMessages = await fetchMergedMessages(eventData.chat);
        if (mergedMessages) {
            mergedContentAfter = serializeMessagesAsJson(mergedMessages);
            mergedSignatures = getMessageSignatures(mergedMessages);
            const len = previousMergedContent
                ? getCommonPrefixLength(previousMergedContent, mergedContentAfter)
                : 0;
            mergedPrefixChars = len;
            mergedPrefixPercent = previousMergedContent
                ? Math.round((len / Math.max(mergedContentAfter.length, 1)) * 10000) / 100
                : 0;
            mergedFirstChangedMessage = previousMergedSignatures.length
                ? getFirstChangedMessage(mergedSignatures, previousMergedSignatures)
                : null;
            mergedMessagePrefixCount = Number.isInteger(mergedFirstChangedMessage)
                ? mergedFirstChangedMessage
                : mergedSignatures.length;
        } else {
            mergeAwareAvailable = false;
            console.warn('[DCO] /process endpoint unavailable, falling back to raw stability only');
        }
    }

    const serializedPrompt = diagnosticsEnabled ? eventData.chat.map(serializeMessage).join('\n') : '';
    const rawContentAfter = diagnosticsEnabled ? serializeRawContent(eventData.chat) : '';
    const messageSignatures = diagnosticsEnabled ? getMessageSignatures(eventData.chat) : [];

    // Raw input prefix: ST natural stability (current raw vs previous raw)
    const rawInputChars = diagnosticsEnabled && previousRawInput
        ? getCommonPrefixLength(previousRawInput, rawContentBefore)
        : 0;
    const rawInputPercent = diagnosticsEnabled && previousRawInput
        ? Math.round((rawInputChars / Math.max(rawContentBefore.length, 1)) * 10000) / 100
        : 0;

    // Final prefix: actual cache metric (current final vs previous final)
    const rawPrefixChars = diagnosticsEnabled && previousRawContent
        ? getCommonPrefixLength(previousRawContent, rawContentAfter)
        : 0;
    const rawPrefixPercent = diagnosticsEnabled && previousRawContent
        ? Math.round((rawPrefixChars / Math.max(rawContentAfter.length, 1)) * 10000) / 100
        : 0;

    // Plugin impact: how much the plugin breaks the prefix
    const pluginImpact = diagnosticsEnabled && previousRawContent
        ? Math.round((rawInputPercent - rawPrefixPercent) * 100) / 100
        : 0;

    const firstChangedMessage = diagnosticsEnabled && previousMessageSignatures.length
        ? getFirstChangedMessage(messageSignatures, previousMessageSignatures)
        : null;
    const stableMessagePrefixCount = Number.isInteger(firstChangedMessage) ? firstChangedMessage : messageSignatures.length;
    const stableMessagePrefixChars = messageSignatures
        .slice(0, stableMessagePrefixCount)
        .reduce((sum, item) => sum + Number(item.length || 0), 0);

    lastStats = {
        moved: totalMoved,
        total: eventData.chat.length,
        skipped: settings.enabled ? (totalMoved > 0 ? `${totalMoved} 条已重排` : '无需重排') : '重排已关闭',
        protected: totalProtected,
        rawPrefixChars,
        rawPrefixPercent,
        rawInputPercent,
        pluginImpact,
        firstChangedMessage,
        stableMessagePrefixCount,
        stableMessagePrefixChars,
        firstMessageHash: messageSignatures[0]?.hash ?? '',
        firstMessageLength: messageSignatures[0]?.length ?? 0,
        messageSignatures,
        promptAnalysis: lastPromptAnalysis,
        dynamicMoved: lastPromptAnalysis.filter(item => item.category === 'dynamic_state' && item.moved).length,
        adaptiveStableCount: adaptiveStableHashes.length,
        adaptivePlanLocked,
        adaptivePlanReason,
        runId: promptRunCounter,
        requestSettingsSignature: '',
        requestType: '',
        mergedPrefixChars,
        mergedPrefixPercent,
        mergedMessagePrefixCount,
        mergedFirstChangedMessage,
        mergedTotalMessages: mergedMessages?.length ?? null,
    };

    if (diagnosticsEnabled) {
        previousSerializedPrompt = serializedPrompt;
        previousRawContent = rawContentAfter;
        previousRawInput = rawContentBefore;
        previousMessageSignatures = messageSignatures;
        try {
            localStorage.setItem('dco_prevRawContent', rawContentAfter);
            localStorage.setItem('dco_prevRawInput', rawContentBefore);
        } catch { /* quota exceeded */ }
    }
    if (mergedMessages) {
        previousMergedContent = mergedContentAfter;
        previousMergedSignatures = mergedSignatures;
        try { localStorage.setItem('dco_prevMergedContent', mergedContentAfter); } catch {}
    }
    if (diagnosticsEnabled && settings.recordRequestHistory) {
        rememberRequestRecord(makeRequestRecord({
            messages: eventData.chat,
            stats: lastStats,
            analysis: lastPromptAnalysis,
            serializedPrompt,
            mergedMessages,
        }));
    }
    if (settings.debug) {
        console.debug('[DeepSeek Cache Optimizer]', lastStats, eventData.chat);
    }

    updateStats();
}

function updateStats() {
    const stats = $('#dco_stats');
    if (!stats.length) {
        return;
    }

    const skipped = lastStats.skipped ? ` (${lastStats.skipped})` : '';
    stats.text(`上次运行：移动 ${lastStats.moved} / ${lastStats.total} 条消息，动态块后移 ${lastStats.dynamicMoved || 0} 条，保护富格式 ${lastStats.protected || 0} 条${skipped}`);

    const diagnostics = $('#dco_diagnostics');
    if (!diagnostics.length) {
        return;
    }

    const firstChanged = lastStats.firstChangedMessage === null
        ? '无 / 首次运行'
        : String(lastStats.firstChangedMessage);
    const firstChangedSignature = Number.isInteger(lastStats.firstChangedMessage)
        ? lastStats.messageSignatures?.[lastStats.firstChangedMessage]
        : null;
    const firstChangedText = firstChangedSignature
        ? `\n变化消息：#${firstChangedSignature.index} ${firstChangedSignature.role}，长度=${firstChangedSignature.length}，hash=${firstChangedSignature.hash}\n预览：${firstChangedSignature.preview}`
        : '';

    diagnostics.text([
        `最终前缀：${lastStats.rawPrefixChars || 0} 字符（${lastStats.rawPrefixPercent || 0}%）`,
        `ST自然前缀：${lastStats.rawInputPercent || 0}%`,
        `插件影响量：${lastStats.pluginImpact || 0}%`,
        `第一条发生变化的消息：${firstChanged}`,
        `稳定消息前缀：${lastStats.stableMessagePrefixCount ?? 0} 条，约 ${lastStats.stableMessagePrefixChars ?? 0} 文本字符`,
        `合并后前缀：${lastStats.mergedPrefixChars ?? 'N/A'} 字符（${lastStats.mergedPrefixPercent ?? 'N/A'}%）`,
        `合并后稳定消息：${lastStats.mergedMessagePrefixCount ?? 'N/A'} / ${lastStats.mergedTotalMessages ?? 'N/A'} 条`,
        `第一条消息：长度=${lastStats.firstMessageLength || 0}，hash=${lastStats.firstMessageHash || 'n/a'}`,
        `动态块后移：${lastStats.dynamicMoved || 0} 条`,
        `自适应稳定块：${lastStats.adaptiveStableCount || 0} 条；${lastStats.adaptivePlanReason || adaptivePlanReason}`,
        `扩展更新：${getUpdateStatusText()}`,
        '',
        '缓存诊断：',
        getCacheDiagnosisText(),
        '',
        getBackendUsageText(),
        firstChangedText.trim(),
    ].filter(Boolean).join('\n'));

    const updateStatus = $('#dco_update_status');
    if (updateStatus.length) {
        updateStatus.text(getUpdateStatusText());
    }
    $('#dco_update_extension').prop('disabled', updateRunning);
    $('#dco_check_update').prop('disabled', updateRunning);

    // Update sidebar quick stats
    const sidebarStats = $('#dco_sidebar_stats');
    if (sidebarStats.length) {
        const usage = getBackendUsageMetrics();
        sidebarStats.find('.dco-sidebar-stat:eq(0) b').text(`${usage.hitPercent || 0}%`);
        sidebarStats.find('.dco-sidebar-stat:eq(1) b').text(`${lastStats.rawPrefixPercent || 0}%`);
    }
}

function getTokenEstimateText() {
    return [
        'Token 说明：',
        '当前面板里的长度/共同前缀使用的是请求 JSON 字符数和消息文本长度，不等于模型真实 token。',
        '共同前缀高只代表前端消息文本相似，不保证 DeepSeek/NewAPI 后端缓存命中。',
        '后端缓存还可能受模型名、路由节点、请求参数、缓存 TTL、token 边界、账号和上游是否启用缓存影响。',
        'SillyTavern 的本地 token 估算依赖 tokenizer；如果 DeepSeek tokenizer 下载失败，会回退到 llama3 tokenizer，和后端统计会明显对不上。',
        '后端返回的 usage 才是计费与缓存命中的权威数据。',
        'NewAPI 的 OpenAI 兼容返回通常把缓存命中放在 usage.prompt_tokens_details.cached_tokens；有些中转会使用 prompt_cache_hit_tokens / prompt_cache_miss_tokens。',
        '若使用流式输出，上游必须支持并返回最后一个 usage chunk；本地已为 Custom 和 DeepSeek 源发送 stream_options.include_usage=true。',
        '如果面板仍显示"暂无后端 usage"，先临时关闭流式输出测一次；非流式有 usage 而流式没有，问题就在 NewAPI/上游的流式 usage 转发。',
    ].join('\n');
}

function getHistoryRows() {
    return requestHistory.map((record, index) => {
        const metrics = getUsageMetrics(record.usage);
        const stats = record.stats || {};
        const recordPath = renderPathBadge(getRecordPathMeta(record.recordPath));
        const usagePath = renderPathBadge(getUsagePathMeta(record.usagePath));
        return `
            <tr>
                <td>${escapeHtml(record.id || `#${requestHistory.length - index}`)}</td>
                <td>${escapeHtml(record.at?.toLocaleTimeString?.() || '')}</td>
                <td>${recordPath}</td>
                <td>${usagePath}</td>
                <td>${escapeHtml(record.model || '')}</td>
                <td>${record.stream ? '流式' : '非流式'}</td>
                <td>${formatNumber(metrics.promptTokens)}</td>
                <td>${formatNumber(metrics.cachedTokens)}</td>
                <td>${formatNumber(metrics.missTokens)}</td>
                <td>${record.usageReceived ? `${metrics.hitPercent}%` : '未收到 usage'}</td>
                <td>${stats.rawPrefixPercent ?? 0}%</td>
                <td>${stats.pluginImpact ?? 0}%</td>
                <td>${stats.runId && stats.runId <= 1 ? '本页首次' : (stats.firstChangedMessage ?? '无')}</td>
            </tr>
        `;
    }).join('');
}

function getAnalysisRows(limit = 80) {
    return (lastPromptAnalysis || [])
        .slice(0, limit)
        .map(item => `
            <tr class="${item.moved ? 'dco-row-moved' : ''}">
                <td>#${item.index}</td>
                <td>${item.originalIndex !== undefined ? `#${item.originalIndex}` : ''}</td>
                <td>${escapeHtml(item.role)}</td>
                <td>${escapeHtml(promptCategoryLabels[item.category] || item.category)}</td>
                <td>${escapeHtml(item.stability)}</td>
                <td>${item.moved ? '是' : '否'}</td>
                <td>${item.length}</td>
                <td class="dco-preview">${escapeHtml(item.reason || '')}</td>
                <td class="dco-preview">${escapeHtml(item.preview || '')}</td>
            </tr>
        `).join('');
}

async function callExtensionUpdateApi(endpoint, { global = false } = {}) {
    const response = await fetch(`/api/extensions/${endpoint}`, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            extensionName: EXTENSION_FOLDER_NAME,
            global,
        }),
    });

    const text = await response.text();
    let data = null;
    try {
        data = text ? JSON.parse(text) : null;
    } catch {
        data = null;
    }

    if (!response.ok) {
        throw new Error(text || response.statusText || '扩展更新接口请求失败');
    }

    return data;
}

async function callExtensionUpdateApiAuto(endpoint) {
    try {
        const data = await callExtensionUpdateApi(endpoint, { global: false });
        return { ...data, installScope: 'local' };
    } catch (localError) {
        const localMessage = localError.message || String(localError);
        if (!/Directory does not exist|does not exist/i.test(localMessage)) {
            throw localError;
        }
        const data = await callExtensionUpdateApi(endpoint, { global: true });
        return { ...data, installScope: 'global' };
    }
}

function formatCommit(value) {
    return value ? String(value).slice(0, 7) : '未知';
}

async function checkSelfUpdate({ quiet = false } = {}) {
    try {
        const data = await callExtensionUpdateApiAuto('version');
        lastUpdateCheck = {
            at: new Date(),
            ...data,
        };
        const status = data?.isUpToDate === false
            ? `发现更新：当前 ${formatCommit(data.currentCommitHash)}，远程有新提交。`
            : `已是最新：${formatCommit(data?.currentCommitHash)}。`;
        if (!quiet) {
            (data?.isUpToDate === false ? toastr.info : toastr.success)(status);
        }
        updateStats();
        return data;
    } catch (error) {
        lastUpdateCheck = { at: new Date(), error: error.message || String(error) };
        if (!quiet) {
            toastr.error(`检查更新失败：${lastUpdateCheck.error}`);
        }
        updateStats();
        return null;
    }
}

async function updateSelfExtension() {
    if (updateRunning) {
        return;
    }

    updateRunning = true;
    updateStats();

    try {
        const data = await callExtensionUpdateApiAuto('update');
        lastUpdateCheck = {
            at: new Date(),
            ...data,
        };
        if (data?.isUpToDate) {
            toastr.success(`扩展已是最新：${formatCommit(data.shortCommitHash)}`);
        } else {
            toastr.success(`扩展已更新到 ${formatCommit(data.shortCommitHash)}，请刷新页面生效。`);
        }
    } catch (error) {
        lastUpdateCheck = { at: new Date(), error: error.message || String(error) };
        toastr.error(`更新失败：${lastUpdateCheck.error}`);
    } finally {
        updateRunning = false;
        updateStats();
    }
}

function getUpdateStatusText() {
    if (updateRunning) {
        return '正在更新扩展...';
    }

    if (!lastUpdateCheck) {
        return '尚未检查。';
    }

    if (lastUpdateCheck.error) {
        return `上次检查失败：${lastUpdateCheck.error}`;
    }

    const time = lastUpdateCheck.at?.toLocaleString?.() || '未知时间';
    const branch = lastUpdateCheck.currentBranchName || '未知分支';
    const commit = formatCommit(lastUpdateCheck.currentCommitHash || lastUpdateCheck.shortCommitHash);
    const scope = lastUpdateCheck.installScope ? `；位置：${lastUpdateCheck.installScope}` : '';
    const remote = lastUpdateCheck.remoteUrl ? `；来源：${lastUpdateCheck.remoteUrl}` : '';
    const state = lastUpdateCheck.isUpToDate === false ? '有可用更新' : '已是最新';
    return `${state}；${branch}-${commit}${scope}；检查时间：${time}${remote}`;
}

async function openPanel(activeTab = 'optimizer') {
    const settings = getSettings();

    const stats = lastStats;
    const usageMetrics = getBackendUsageMetrics();
    const diagnosticsEnabled = Boolean(settings.diagnosticsEnabled);
    const analysisRows = diagnosticsEnabled ? getAnalysisRows() : '';
    const historyRows = diagnosticsEnabled ? getHistoryRows() : '';
    const rawUsage = lastBackendUsage?.usage ? JSON.stringify(lastBackendUsage.usage, null, 2) : '';
    const defaultCompare = getDefaultCompareIds();
    const compareReport = diagnosticsEnabled ? getMessageDiffReport(defaultCompare.leftId, defaultCompare.rightId) : '请求诊断未启用。';
    const requestOptionsLeft = diagnosticsEnabled ? getRequestOptionRows(defaultCompare.leftId) : '';
    const requestOptionsRight = diagnosticsEnabled ? getRequestOptionRows(defaultCompare.rightId) : '';
    if (diagnosticsEnabled && activeTab === 'compare') {
        try {
            await refreshBackendBodyRecords();
        } catch (error) {
            console.warn('[DeepSeek Cache Optimizer] Failed to refresh backend body records', error);
        }
    }
    const defaultBodyCompare = getDefaultBackendBodyCompareIds();
    const bodyCompareReport = diagnosticsEnabled ? getBackendBodyDiffReport(defaultBodyCompare.leftId, defaultBodyCompare.rightId) : '请求诊断未启用。';
    const bodyOptionsLeft = diagnosticsEnabled ? getBackendBodyOptionRows(defaultBodyCompare.leftId) : '';
    const bodyOptionsRight = diagnosticsEnabled ? getBackendBodyOptionRows(defaultBodyCompare.rightId) : '';
    const backendBodyRows = diagnosticsEnabled ? getBackendBodyRows() : '';
    const html = $(`
        <div class="dco-panel">
            <div class="dco-panel-header">
                <h2>DeepSeek Cache Optimizer</h2>
                <span class="dco-version">v0.6.4-local-a</span>
                <button id="dco_panel_refresh" class="menu_button" style="margin-left:auto;">刷新</button>
            </div>
            <nav class="dco-tabs">
                <label class="dco-tab${activeTab === 'optimizer' ? ' dco-tab--active' : ''}" data-tab="optimizer">缓存优化</label>
                <label class="dco-tab${activeTab === 'compare' ? ' dco-tab--active' : ''}" data-tab="compare">命中对比</label>
            </nav>
            <div class="dco-tab-content">
                <section class="dco-pane${activeTab === 'optimizer' ? ' dco-pane--active' : ''}" data-pane="optimizer">
                    <div class="dco-grid">
                        <section class="dco-card dco-rules-card">
                            <div class="dco-card-title">规则区</div>
                            <label class="checkbox_label dco-inline" for="dco_modal_enabled">
                                <input id="dco_modal_enabled" type="checkbox" ${settings.enabled ? 'checked' : ''} />
                                <span>启用 Prompt 消息重排</span>
                            </label>
                            <div id="dco_reorder_options" ${settings.enabled ? '' : 'style="display:none"'}>
                                <label class="checkbox_label dco-inline" for="dco_modal_protect">
                                    <input id="dco_modal_protect" type="checkbox" ${settings.protectRichFormat ? 'checked' : ''} />
                                    <span>保护 HTML/CSS 富格式块</span>
                                </label>
                                <label>
                                    <span>策略</span>
                                    <select id="dco_modal_strategy" class="text_pole">
                                        <option value="conservative" ${settings.strategy === 'conservative' ? 'selected' : ''}>保守</option>
                                        <option value="balanced" ${settings.strategy === 'balanced' ? 'selected' : ''}>均衡</option>
                                        <option value="aggressive" ${settings.strategy === 'aggressive' ? 'selected' : ''}>激进</option>
                                    </select>
                                </label>
                                <div class="dco-rule-flow">
                                    <div><span class="dco-dot blue"></span>稳定设定</div><b>→</b><div>尽量前置</div>
                                    <div><span class="dco-dot green"></span>普通规则</div><b>→</b><div>保持顺序</div>
                                    <div><span class="dco-dot amber"></span>动态状态</div><b>→</b><div>尽量后置</div>
                                    <div><span class="dco-dot gray"></span>富格式块</div><b>→</b><div>原位保护</div>
                                </div>
                            </div>
                            ${!settings.enabled ? '<div class="dco-muted" style="margin-top:0.5rem">重排已关闭。消息保持原始顺序。</div>' : ''}
                        </section>
                        <section class="dco-card">
                            <div class="dco-card-title">请求概览</div>
                            <div class="dco-metric-grid">
                                <div class="dco-metric"><span>消息数</span><b>${stats.total || 0}</b></div>
                                ${settings.enabled ? `
                                    <div class="dco-metric"><span>移动</span><b>${stats.moved || 0}</b></div>
                                    <div class="dco-metric warn"><span>动态后移</span><b>${stats.dynamicMoved || 0}</b></div>
                                    <div class="dco-metric"><span>保护</span><b>${stats.protected || 0}</b></div>
                                ` : ''}
                                <div class="dco-metric"><span>最终前缀</span><b>${stats.rawPrefixPercent || 0}%</b></div>
                                <div class="dco-metric success"><span>ST自然前缀</span><b>${stats.rawInputPercent || 0}%</b></div>
                                <div class="dco-metric${stats.pluginImpact > 3 ? ' warn' : ' success'}"><span>插件影响</span><b>${stats.pluginImpact || 0}%</b></div>
                            </div>
                            <pre class="dco-diagnostics dco-modal-diagnostics">${$('#dco_diagnostics').text() || '暂无请求记录。'}</pre>
                            ${!settings.diagnosticsEnabled ? '<div class="dco-muted">请求诊断未启用：跳过完整 Prompt 分析、后端合并分析和快照写入。</div>' : ''}
                            <div class="dco-card-title">后端真实 usage</div>
                            <div class="dco-metric-grid">
                                <div class="dco-metric accent"><span>Prompt tokens</span><b>${formatNumber(usageMetrics.promptTokens)}</b></div>
                                <div class="dco-metric success"><span>缓存命中 tokens</span><b>${formatNumber(usageMetrics.cachedTokens)}</b></div>
                                <div class="dco-metric warn"><span>未命中 tokens</span><b>${formatNumber(usageMetrics.missTokens)}</b></div>
                                <div class="dco-metric"><span>后端命中率</span><b>${usageMetrics.hitPercent || 0}%</b></div>
                            </div>
                            <div class="dco-card-title">Prompt 分析器</div>
                            <div class="dco-table-wrap">
                                <table class="dco-table">
                                    <thead><tr><th>现序</th><th>原序</th><th>角色</th><th>类别</th><th>稳定性</th><th>移动</th><th>长度</th><th>原因</th><th>预览</th></tr></thead>
                                    <tbody>${analysisRows || '<tr><td colspan="9">暂无数据，生成一次后再查看。</td></tr>'}</tbody>
                                </table>
                            </div>
                        </section>
                    </div>
                </section>
                <section class="dco-pane${activeTab === 'compare' ? ' dco-pane--active' : ''}" data-pane="compare">
                    <div class="dco-card-title">前缀分析</div>
                    <div class="dco-metric-grid dco-wide-metrics">
                        <div class="dco-metric success"><span>最终前缀</span><b>${stats.rawPrefixPercent || 0}%</b></div>
                        <div class="dco-metric success"><span>ST自然前缀</span><b>${stats.rawInputPercent || 0}%</b></div>
                        <div class="dco-metric${stats.pluginImpact > 3 ? ' warn' : ' success'}"><span>插件影响量</span><b>${stats.pluginImpact || 0}%</b></div>
                        <div class="dco-metric"><span>共同字符</span><b>${stats.rawPrefixChars || 0}</b></div>
                    </div>
                    <div class="dco-metric-grid dco-wide-metrics">
                        <div class="dco-metric"><span>第一处变化</span><b>${stats.firstChangedMessage ?? '无'}</b></div>
                        <div class="dco-metric"><span>稳定消息数</span><b>${stats.stableMessagePrefixCount ?? 0}</b></div>
                        <div class="dco-metric"><span>稳定字符</span><b>${formatNumber(stats.stableMessagePrefixChars || 0)}</b></div>
                        <div class="dco-metric"><span>消息数</span><b>${stats.total || 0}</b></div>
                    </div>
                    <div class="dco-card-title" style="margin-top:1rem">后端缓存</div>
                    <div class="dco-metric-grid dco-wide-metrics">
                        <div class="dco-metric accent"><span>Prompt tokens</span><b>${formatNumber(usageMetrics.promptTokens)}</b></div>
                        <div class="dco-metric success"><span>缓存命中</span><b>${formatNumber(usageMetrics.cachedTokens)}</b></div>
                        <div class="dco-metric warn"><span>未命中</span><b>${formatNumber(usageMetrics.missTokens)}</b></div>
                        <div class="dco-metric"><span>命中率</span><b>${usageMetrics.hitPercent || 0}%</b></div>
                    </div>
                    <section class="dco-card">
                        <div class="dco-card-title">后端返回 usage</div>
                        <pre class="dco-diagnostics dco-modal-diagnostics">${escapeHtml(getUsageSummaryText(lastBackendUsage))}</pre>
                        ${rawUsage ? `
                            <details class="dco-details">
                                <summary>查看原始 usage JSON</summary>
                                <pre class="dco-diagnostics dco-raw-json">${escapeHtml(rawUsage)}</pre>
                            </details>
                        ` : ''}
                    </section>
                    <section class="dco-card">
                        <div class="dco-card-title">每次请求记录</div>
                        <div class="dco-table-wrap dco-history-wrap">
                            <table class="dco-table">
                                <thead>
                                    <tr>
                                        <th>轮次</th><th>时间</th><th>记录链路</th><th>usage 链路</th><th>模型</th><th>模式</th><th>Prompt</th>
                                        <th>命中</th><th>未命中</th><th>后端命中率</th><th>最终前缀</th><th>插件影响</th><th>首变</th>
                                    </tr>
                                </thead>
                                <tbody>${historyRows || '<tr><td colspan="13">暂无请求。生成一次后会立刻记录；即使流式 usage 没返回也会保留。</td></tr>'}</tbody>
                            </table>
                        </div>
                    </section>
                    <section class="dco-card">
                        <div class="dco-card-title">请求差异对比</div>
                        <div class="dco-settings-grid">
                            <label>
                                <span>旧请求</span>
                                <select id="dco_compare_left" class="text_pole">${requestOptionsLeft || '<option value="">暂无请求</option>'}</select>
                            </label>
                            <label>
                                <span>新请求</span>
                                <select id="dco_compare_right" class="text_pole">${requestOptionsRight || '<option value="">暂无请求</option>'}</select>
                            </label>
                        </div>
                        <div class="dco-action-row">
                            <button id="dco_copy_diff" class="menu_button">复制差异报告</button>
                            <button id="dco_copy_left_request" class="menu_button">复制旧请求 JSON</button>
                            <button id="dco_copy_right_request" class="menu_button">复制新请求 JSON</button>
                        </div>
                        <pre id="dco_compare_report" class="dco-diagnostics dco-modal-diagnostics">${escapeHtml(compareReport)}</pre>
                    </section>
                    <section class="dco-card">
                        <div class="dco-card-title">后端最终 HTTP body</div>
                        <div class="dco-action-row">
                            <button id="dco_backend_body_refresh" class="menu_button">刷新后端最终请求体</button>
                            <button id="dco_backend_body_clear" class="menu_button danger_button">清空后端记录</button>
                        </div>
                        <div class="dco-table-wrap dco-history-wrap">
                            <table class="dco-table">
                                <thead>
                                    <tr>
                                        <th>ID</th><th>时间</th><th>模型</th><th>模式</th><th>字符</th><th>字节</th><th>Hash</th><th>相对上一条首差异</th><th>首变消息</th>
                                    </tr>
                                </thead>
                                <tbody>${backendBodyRows || '<tr><td colspan="9">暂无后端最终 body。后端代码改动后需要重启 SillyTavern，再生成一次。</td></tr>'}</tbody>
                            </table>
                        </div>
                        <div class="dco-settings-grid">
                            <label>
                                <span>旧 body</span>
                                <select id="dco_body_compare_left" class="text_pole">${bodyOptionsLeft || '<option value="">暂无记录</option>'}</select>
                            </label>
                            <label>
                                <span>新 body</span>
                                <select id="dco_body_compare_right" class="text_pole">${bodyOptionsRight || '<option value="">暂无记录</option>'}</select>
                            </label>
                        </div>
                        <div class="dco-action-row">
                            <button id="dco_copy_body_diff" class="menu_button">复制 body 差异报告</button>
                            <button id="dco_copy_left_body" class="menu_button">复制旧 body JSON</button>
                            <button id="dco_copy_right_body" class="menu_button">复制新 body JSON</button>
                        </div>
                        <pre id="dco_body_compare_report" class="dco-diagnostics dco-modal-diagnostics">${escapeHtml(bodyCompareReport)}</pre>
                    </section>
                    <details class="dco-card dco-details-card">
                        <summary class="dco-card-title">为什么和 LLM 后台 token 对不上</summary>
                        <pre class="dco-diagnostics dco-modal-diagnostics">${escapeHtml(getTokenEstimateText())}</pre>
                    </details>
                    <details class="dco-card dco-details-card">
                        <summary class="dco-card-title">当前诊断</summary>
                        <pre class="dco-diagnostics dco-modal-diagnostics">${escapeHtml($('#dco_diagnostics').text() || '暂无请求记录。')}</pre>
                    </details>
                </section>
            </div>
        </div>
    `);

    const persist = () => { saveSettingsDebounced(); bindSettings(); };

    // Tab switching
    html.find('.dco-tab').on('click', function () {
        const tab = $(this).data('tab');
        html.find('.dco-tab').removeClass('dco-tab--active');
        $(this).addClass('dco-tab--active');
        html.find('.dco-pane').removeClass('dco-pane--active');
        html.find(`.dco-pane[data-pane="${tab}"]`).addClass('dco-pane--active');
    });

    // Refresh
    html.find('#dco_panel_refresh').on('click', () => {
        const activeTab = html.find('.dco-tab--active').data('tab') || 'optimizer';
        openPanel(activeTab);
    });

    const refreshCompareReport = () => {
        const leftId = String(html.find('#dco_compare_left').val() || '');
        const rightId = String(html.find('#dco_compare_right').val() || '');
        html.find('#dco_compare_report').text(getMessageDiffReport(leftId, rightId));
    };
    html.find('#dco_compare_left, #dco_compare_right').on('change', refreshCompareReport);
    html.find('#dco_copy_diff').on('click', async () => {
        const leftId = String(html.find('#dco_compare_left').val() || '');
        const rightId = String(html.find('#dco_compare_right').val() || '');
        await copyTextToClipboard(getMessageDiffReport(leftId, rightId), '已复制差异报告');
    });
    html.find('#dco_copy_left_request').on('click', async () => {
        const record = getRequestById(String(html.find('#dco_compare_left').val() || ''));
        await copyTextToClipboard(getRequestJson(record), '已复制旧请求 JSON');
    });
    html.find('#dco_copy_right_request').on('click', async () => {
        const record = getRequestById(String(html.find('#dco_compare_right').val() || ''));
        await copyTextToClipboard(getRequestJson(record), '已复制新请求 JSON');
    });
    const refreshBodyCompareReport = () => {
        const leftId = String(html.find('#dco_body_compare_left').val() || '');
        const rightId = String(html.find('#dco_body_compare_right').val() || '');
        html.find('#dco_body_compare_report').text(getBackendBodyDiffReport(leftId, rightId));
    };
    html.find('#dco_body_compare_left, #dco_body_compare_right').on('change', refreshBodyCompareReport);
    html.find('#dco_backend_body_refresh').on('click', async () => {
        try {
            await refreshBackendBodyRecords();
            openPanel('compare');
        } catch (error) {
            console.warn('[DeepSeek Cache Optimizer] Failed to refresh backend body records', error);
            toastr.error('刷新后端最终请求体失败。若刚修改过后端，请先重启 SillyTavern。');
        }
    });
    html.find('#dco_backend_body_clear').on('click', async () => {
        try {
            await clearBackendBodyRecords();
            toastr.info('已清空后端最终请求体记录');
            openPanel('compare');
        } catch (error) {
            console.warn('[DeepSeek Cache Optimizer] Failed to clear backend body records', error);
            toastr.error('清空后端记录失败。');
        }
    });
    html.find('#dco_copy_body_diff').on('click', async () => {
        const leftId = String(html.find('#dco_body_compare_left').val() || '');
        const rightId = String(html.find('#dco_body_compare_right').val() || '');
        await copyTextToClipboard(getBackendBodyDiffReport(leftId, rightId), '已复制 body 差异报告');
    });
    html.find('#dco_copy_left_body').on('click', async () => {
        const record = getBackendBodyById(String(html.find('#dco_body_compare_left').val() || ''));
        await copyTextToClipboard(getBackendBodyJson(record), '已复制旧 body JSON');
    });
    html.find('#dco_copy_right_body').on('click', async () => {
        const record = getBackendBodyById(String(html.find('#dco_body_compare_right').val() || ''));
        await copyTextToClipboard(getBackendBodyJson(record), '已复制新 body JSON');
    });

    // Optimizer tab bindings
    html.find('#dco_modal_enabled').on('input', function () {
        settings.enabled = Boolean(this.checked);
        html.find('#dco_reorder_options').toggle(settings.enabled);
        persist();
    });
    html.find('#dco_modal_protect').on('input', function () { settings.protectRichFormat = Boolean(this.checked); persist(); });
    html.find('#dco_modal_strategy').on('change', function () { settings.strategy = String(this.value || defaultSettings.strategy); persist(); });

    callGenericPopup(html, POPUP_TYPE.DISPLAY, '', { wide: true, large: true, allowVerticalScrolling: true, leftAlign: true });
}

function bindSettings() {
    const settings = getSettings();

    $('#dco_enabled').prop('checked', settings.enabled);
    $('#dco_strategy').val(settings.strategy).closest('label').toggle(settings.enabled);
    $('#dco_protect_rich_format').prop('checked', settings.protectRichFormat).closest('label').toggle(settings.enabled);
    $('#dco_adaptive_stable_reorder').prop('checked', settings.adaptiveStableReorder).closest('label').toggle(settings.enabled);
    $('#dco_debug').prop('checked', settings.debug);
    $('#dco_diagnostics_enabled').prop('checked', settings.diagnosticsEnabled);
    $('#dco_record_request_history').prop('checked', settings.recordRequestHistory).closest('label').toggle(settings.diagnosticsEnabled);
    $('#dco_merged_diagnostics').prop('checked', settings.mergedDiagnostics).closest('label').toggle(settings.diagnosticsEnabled);

    $('#dco_enabled').on('input', function () {
        settings.enabled = Boolean(this.checked);
        $('#dco_strategy').closest('label').toggle(settings.enabled);
        $('#dco_protect_rich_format').closest('label').toggle(settings.enabled);
        saveSettingsDebounced();
    });
    $('#dco_strategy').on('change', function () {
        settings.strategy = String(this.value || defaultSettings.strategy);
        saveSettingsDebounced();
    });
    $('#dco_protect_rich_format').on('input', function () {
        settings.protectRichFormat = Boolean(this.checked);
        saveSettingsDebounced();
    });
    $('#dco_adaptive_stable_reorder').on('input', function () {
        settings.adaptiveStableReorder = Boolean(this.checked);
        if (!settings.adaptiveStableReorder) {
            resetAdaptiveStablePlan('自适应稳定块识别已关闭');
        }
        saveSettingsDebounced();
    });
    $('#dco_debug').on('input', function () {
        settings.debug = Boolean(this.checked);
        saveSettingsDebounced();
    });
    $('#dco_diagnostics_enabled').on('input', function () {
        settings.diagnosticsEnabled = Boolean(this.checked);
        $('#dco_record_request_history').closest('label').toggle(settings.diagnosticsEnabled);
        $('#dco_merged_diagnostics').closest('label').toggle(settings.diagnosticsEnabled);
        saveSettingsDebounced();
    });
    $('#dco_record_request_history').on('input', function () {
        settings.recordRequestHistory = Boolean(this.checked);
        saveSettingsDebounced();
    });
    $('#dco_merged_diagnostics').on('input', function () {
        settings.mergedDiagnostics = Boolean(this.checked);
        saveSettingsDebounced();
    });
    updateStats();
}

function renderSettings() {
    if ($('#deepseek_cache_optimizer_settings').length) {
        bindSettings();
        return;
    }

    const html = `
        <div id="deepseek_cache_optimizer_settings" class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>DeepSeek 缓存优化器</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <button id="dco_open_panel" class="menu_button dco-full-btn">打开控制面板</button>
                <div class="dco-update-row">
                    <button id="dco_check_update" class="menu_button"><i class="fa-solid fa-rotate"></i> 检查更新</button>
                    <button id="dco_update_extension" class="menu_button"><i class="fa-solid fa-download"></i> 更新扩展</button>
                </div>
                <div id="dco_update_status" class="dco-muted">${escapeHtml(getUpdateStatusText())}</div>
                <div id="dco_sidebar_stats" class="dco-sidebar-stats">
                    <div class="dco-sidebar-stat"><span>后端命中</span><b>${getBackendUsageMetrics().hitPercent || 0}%</b></div>
                    <div class="dco-sidebar-stat"><span>最终前缀</span><b>${lastStats.rawPrefixPercent || 0}%</b></div>
                </div>
                <details class="dco-section" open>
                    <summary class="dco-section-title">缓存优化</summary>
                    <label class="checkbox_label dco-inline" for="dco_enabled">
                        <input id="dco_enabled" type="checkbox" />
                        <span>启用 Prompt 消息重排</span>
                    </label>
                    <label for="dco_strategy">
                        <span>策略</span>
                        <select id="dco_strategy" class="text_pole">
                            <option value="conservative">保守</option>
                            <option value="balanced">均衡</option>
                            <option value="aggressive">激进</option>
                        </select>
                    </label>
                    <label class="checkbox_label dco-inline" for="dco_protect_rich_format">
                        <input id="dco_protect_rich_format" type="checkbox" />
                        <span>保护 HTML/CSS 富格式块</span>
                    </label>
                    <label class="checkbox_label dco-inline" for="dco_adaptive_stable_reorder">
                        <input id="dco_adaptive_stable_reorder" type="checkbox" />
                        <span>低命中率时采样 3 次并锁定相同稳定块</span>
                    </label>
                </details>
                <details class="dco-section">
                    <summary class="dco-section-title">调试</summary>
                    <label class="checkbox_label dco-inline" for="dco_debug">
                        <input id="dco_debug" type="checkbox" />
                        <span>浏览器控制台调试日志</span>
                    </label>
                    <label class="checkbox_label dco-inline" for="dco_diagnostics_enabled">
                        <input id="dco_diagnostics_enabled" type="checkbox" />
                        <span>启用请求诊断</span>
                    </label>
                    <label class="checkbox_label dco-inline" for="dco_record_request_history">
                        <input id="dco_record_request_history" type="checkbox" />
                        <span>保存请求快照</span>
                    </label>
                    <label class="checkbox_label dco-inline" for="dco_merged_diagnostics">
                        <input id="dco_merged_diagnostics" type="checkbox" />
                        <span>后端合并分析</span>
                    </label>
                    <button id="dco_export_prompt" class="menu_button dco-full-btn"><i class="fa-solid fa-file-export"></i> 导出所有快照</button>
                </details>
                <div class="dco-muted">
                    重排只修改本次请求，不修改已保存的预设、世界书、角色卡或聊天记录。
                </div>
                <div id="dco_stats" class="dco-stats"></div>
                <pre id="dco_diagnostics" class="dco-diagnostics"></pre>
            </div>
        </div>
    `;

    $('#extensions_settings2').append(html);
    $('#dco_open_panel').on('click', () => openPanel());
    $('#dco_check_update').on('click', () => checkSelfUpdate());
    $('#dco_update_extension').on('click', () => updateSelfExtension());
    $('#dco_export_prompt').on('click', () => exportAllSnapshots());
    bindSettings();
}

export async function init() {
    const settings = getSettings();
    installFetchObserver();
    renderSettings();
    window.dcoExportPrompt = () => exportPromptSnapshot();
    window.dcoExportAll = () => exportAllSnapshots();
    if (settings.diagnosticsEnabled) {
        try {
            previousRawContent = localStorage.getItem('dco_prevRawContent') || '';
            previousRawInput = localStorage.getItem('dco_prevRawInput') || '';
            previousMergedContent = localStorage.getItem('dco_prevMergedContent') || '';
        } catch { /* localStorage unavailable */ }
    } else {
        try { localStorage.removeItem('dco_prevRawContent'); localStorage.removeItem('dco_prevRawInput'); localStorage.removeItem('dco_prevMergedContent'); } catch { /* localStorage unavailable */ }
    }
    // Restore request history from IndexedDB
    if (settings.diagnosticsEnabled && settings.recordRequestHistory) {
        try {
            const snapshots = await loadSnapshotsFromDb();
            if (snapshots.length) {
                requestHistory = snapshots.map(snap => ({
                    id: snap.id,
                    at: snap.at,
                    model: snap.model,
                    source: snap.source || '',
                    stream: Boolean(snap.stream),
                    type: snap.type || '',
                    status: snap.status || (snap.usage ? '已收到 usage' : '来自历史'),
                    recordPath: snap.recordPath || 'unknown',
                    usagePath: snap.usagePath || '',
                    usageReceived: Boolean(snap.usage),
                    usage: snap.usage,
                    stats: snap.stats,
                    messages: snap.messages,
                    messageSignatures: snap.messages.map((m, i) => ({
                        index: i, role: m.role, length: (m.content || '').length,
                        hash: m.hash, rich: false, preview: (m.content || '').slice(0, 80),
                    })),
                }));
                usageHistory = requestHistory.filter(item => item.usageReceived).slice(0, 20);
                promptRunCounter = requestHistory.length;
            }
        } catch { /* IndexedDB unavailable */ }
    }
    eventSource.on(event_types.CHAT_CHANGED, () => {
        previousSerializedPrompt = '';
        previousRawContent = '';
        previousRawInput = '';
        previousMessageSignatures = [];
        previousMergedContent = '';
        previousMergedSignatures = [];
        mergeAwareAvailable = true;
        promptRunCounter = 0;
        resetAdaptiveStablePlan('聊天已切换，等待 3 次请求样本');
        try { localStorage.removeItem('dco_prevRawContent'); localStorage.removeItem('dco_prevRawInput'); localStorage.removeItem('dco_prevMergedContent'); } catch { /* localStorage unavailable */ }
    });
    eventSource.on(event_types.CHAT_COMPLETION_SETTINGS_READY, handleGenerationSettings);
    eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, optimizeChatCompletionPrompt);
    if (event_types.CHAT_COMPLETION_RESPONSE_USAGE) {
        eventSource.on(event_types.CHAT_COMPLETION_RESPONSE_USAGE, handleBackendUsage);
    }
}
