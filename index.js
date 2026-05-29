import {
    characters,
    chat,
    eventSource,
    event_types,
    extractMessageFromData,
    getCurrentChatId,
    getRequestHeaders,
    name1,
    name2,
    saveSettingsDebounced,
    this_chid,
} from '/script.js';
import { extension_settings } from '/scripts/extensions.js';
import { chat_completion_sources, getChatCompletionModel, model_list, oai_settings } from '/scripts/openai.js';
import { POPUP_TYPE, callGenericPopup } from '/scripts/popup.js';
import {
    selected_world_info,
    world_info,
} from '/scripts/world-info.js';
import { power_user } from '/scripts/power-user.js';
import { getGroupNames } from '/scripts/group-chats.js';

const MODULE_NAME = 'deepseek_cache_optimizer';
const EXTENSION_FOLDER_NAME = 'st-cache-opt';

const defaultSettings = {
    enabled: true,
    strategy: 'balanced',
    moveWorldInfoAfter: true,
    moveMemoryAfterStatic: true,
    moveJailbreakAfterHistory: false,
    protectRichFormat: true,
    minPrefixMessages: 2,
    debug: false,
    memoryEnabled: false,
    memoryInject: true,
    memoryMaxChronicle: 10,
    memoryMaxCharacters: 6,
    memoryMaxItems: 6,
    memoryMaxRelationships: 6,
    memoryMaxWorldLore: 4,
    memoryMinImportance: 0.45,
    memoryRecentChronicle: 3,
    memoryLlmEnabled: false,
    memoryLlmSource: 'current',
    memoryLlmProvider: 'st',
    memoryLlmApiUrl: '',
    memoryLlmApiKey: '',
    memoryLlmModel: '',
    memoryLlmTemperature: 0.1,
    memoryLlmMaxTokens: 4000,
    memoryLlmTurns: 12,
    memoryLlmEveryTurns: 6,
    memoryLlmLastExtractedTurn: 0,
};

const DB_NAME = 'deepseek-cache-optimizer-memory';
const DB_VERSION = 5;
const HISTORY_DB_NAME = 'dco-request-history';
const HISTORY_DB_VERSION = 1;
const HISTORY_STORE = 'snapshots';
const HISTORY_MAX = 30;
const MEMORY_INJECTION_MARKER = '<记忆数据库>';

const TABLE_SCHEMAS = {
    scene_state: {
        label: '当前场景',
        singleton: true,
        columns: ['location', 'time', 'currentActivity', 'mood', 'activeEntities', 'openThreads'],
    },
    entities: {
        label: '实体',
        singleton: false,
        keyColumn: 'id',
        columns: ['id', 'type', 'canonicalName', 'aliases', 'description', 'status', 'importance', 'confidence', 'firstTurn', 'lastTurn'],
    },
    facts: {
        label: '事实',
        singleton: false,
        keyColumn: 'id',
        columns: ['id', 'subjectId', 'predicate', 'value', 'category', 'permanence', 'confidence', 'importance', 'sourceTurns'],
    },
    relationships: {
        label: '关系',
        singleton: false,
        keyColumn: 'id',
        columns: ['id', 'fromId', 'toId', 'type', 'value', 'stableSummary', 'recentChange', 'confidence'],
    },
    events: {
        label: '事件',
        singleton: false,
        keyColumn: 'id',
        columns: ['id', 'summary', 'participants', 'locationId', 'keywords', 'turnStart', 'turnEnd', 'importance', 'noveltyHash', 'mergedFrom', 'status'],
    },
    memory_audit: {
        label: '记忆审计',
        singleton: false,
        keyColumn: 'id',
        columns: ['id', 'turn', 'rawProposal', 'acceptedOps', 'rejectedOps', 'reason', 'createdAt'],
    },
};

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
let dbPromise = null;
let lastRecallResults = [];
let lastWorldInfoTerms = [];
let lastPromptAnalysis = [];
let memoryExtractorRunning = false;
let memoryExtractorStatus = '尚未运行';
let lastMemoryExtractorResult = null;
let previousMergedContent = '';
let previousMergedSignatures = [];
let mergeAwareAvailable = true;
let lastUpdateCheck = null;
let updateRunning = false;
let backendBodyRecords = [];

const promptCategoryLabels = {
    stable_rule: '稳定规则',
    character_static: '角色静态',
    world_static: '世界静态',
    format_rule: '格式规则',
    variable_schema: '变量规则',
    dynamic_state: '动态状态',
    memory_recall: '记忆召回',
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

function getMemoryScope() {
    const character = this_chid !== undefined ? characters[this_chid] : null;
    const characterId = character?.avatar || character?.name || name2 || 'unknown-character';
    const chatId = getCurrentChatId?.() || 'unknown-chat';
    const worlds = Array.isArray(selected_world_info) ? selected_world_info.slice().sort() : [];

    return {
        characterId,
        chatId,
        worlds,
        scopeKey: `${characterId}::${chatId}`,
    };
}

function openMemoryDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            for (const storeName of Array.from(db.objectStoreNames)) {
                db.deleteObjectStore(storeName);
            }
            for (const tableName of Object.keys(TABLE_SCHEMAS)) {
                if (!db.objectStoreNames.contains(tableName)) {
                    const schema = TABLE_SCHEMAS[tableName];
                    const keyPath = schema.singleton ? '_key' : schema.keyColumn;
                    const store = db.createObjectStore(tableName, { keyPath });
                    store.createIndex('scopeKey', 'scopeKey', { unique: false });
                }
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
    return dbPromise;
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

async function getTable(tableName) {
    const db = await openMemoryDb();
    const scope = getMemoryScope();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(tableName, 'readonly');
        const request = tx.objectStore(tableName).index('scopeKey').getAll(scope.scopeKey);
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
    });
}

async function putRow(tableName, row) {
    const db = await openMemoryDb();
    const scope = getMemoryScope();
    row.scopeKey = scope.scopeKey;
    row.updatedAt = Date.now();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(tableName, 'readwrite');
        tx.objectStore(tableName).put(row);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
    });
}

async function deleteRow(tableName, keyValue) {
    const db = await openMemoryDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(tableName, 'readwrite');
        tx.objectStore(tableName).delete(keyValue);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
    });
}

async function clearAllTables() {
    const db = await openMemoryDb();
    for (const tableName of Object.keys(TABLE_SCHEMAS)) {
        const rows = await getTable(tableName);
        const keys = rows.map(r => r[TABLE_SCHEMAS[tableName].singleton ? '_key' : TABLE_SCHEMAS[tableName].keyColumn]);
        if (keys.length) {
            await new Promise((resolve, reject) => {
                const tx = db.transaction(tableName, 'readwrite');
                const store = tx.objectStore(tableName);
                keys.forEach(k => store.delete(k));
                tx.oncomplete = resolve;
                tx.onerror = () => reject(tx.error);
            });
        }
    }
}

function splitTerms(text) {
    const normalized = normalizeText(text).toLowerCase();
    const asciiTerms = normalized.match(/[a-z0-9_@#.-]{2,}/g) || [];
    const cjkTerms = normalized.match(/[\u4e00-\u9fff]{2,8}/g) || [];
    return [...new Set([...asciiTerms, ...cjkTerms])]
        .filter(term => term.length >= 2 && !/^\d+$/.test(term))
        .slice(0, 80);
}

function getWorldInfoTerms() {
    const terms = new Set();
    const worlds = Array.isArray(selected_world_info) ? selected_world_info : [];

    for (const worldName of worlds) {
        const entries = Object.values(world_info?.[worldName]?.entries || {});
        for (const entry of entries) {
            [entry.comment, ...(entry.key || []), ...(entry.keysecondary || [])]
                .filter(Boolean)
                .forEach(value => {
                    splitTerms(value).forEach(term => terms.add(term));
                });
        }
    }

    lastWorldInfoTerms = [...terms].slice(0, 200);
    return lastWorldInfoTerms;
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

function rowText(row, fields = null) {
    if (!row) {
        return '';
    }

    const source = fields || Object.keys(row).filter(key => key !== '_key' && key !== 'scopeKey');
    return source.map(key => row[key]).filter(Boolean).join(' ');
}

function getRecentMessageText(messages, limit = 8) {
    if (!Array.isArray(messages)) {
        return '';
    }

    return messages
        .slice(-limit)
        .map(message => getMessageText(message))
        .filter(Boolean)
        .join('\n');
}

function buildMemoryQuery(messages, state, protagonist, userInfo) {
    return [
        getRecentMessageText(messages, 8),
        rowText(state, ['location', 'time', 'scene', 'atmosphere']),
        rowText(protagonist, ['name', 'currentState', 'traits', 'abilities']),
        rowText(userInfo, ['name', 'persona']),
        name1,
        name2,
    ].filter(Boolean).join('\n');
}

function scoreTextAgainstTerms(text, terms, weight = 1) {
    const haystack = normalizeText(text).toLowerCase();
    if (!haystack || !terms?.length) {
        return 0;
    }

    let score = 0;
    for (const term of terms) {
        if (!term) continue;
        if (haystack.includes(term)) {
            score += term.length >= 4 ? weight * 1.5 : weight;
        }
    }

    return score;
}

function isExplicitlyMentioned(value, terms, queryText) {
    const text = normalizeText(value).toLowerCase();
    if (!text) {
        return false;
    }

    if (text.length >= 2 && queryText.includes(text)) {
        return true;
    }

    return splitTerms(text).some(term => terms.includes(term));
}

function pickTopRows(rows, scorer, limit) {
    const max = Math.max(0, Number(limit || 0));
    if (!Array.isArray(rows) || max <= 0) {
        return [];
    }

    return rows
        .map((row, index) => ({ row, index, score: scorer(row) }))
        .filter(item => item.score > 0)
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .slice(0, max)
        .map(item => item.row);
}

function mergeUniqueRows(rows, keyField, limit) {
    const max = Math.max(0, Number(limit || 0));
    const seen = new Set();
    const merged = [];

    for (const row of rows || []) {
        const key = String(row?.[keyField] ?? row?._key ?? JSON.stringify(row));
        if (!key || seen.has(key)) {
            continue;
        }
        seen.add(key);
        merged.push(row);
        if (merged.length >= max) {
            break;
        }
    }

    return merged;
}

function slugifyIdPart(value, fallback = 'item') {
    const text = normalizeText(value).toLowerCase();
    const ascii = text.replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-+|-+$/g, '');
    return (ascii || fallback).slice(0, 80);
}

function makeMemoryId(prefix, ...parts) {
    return [prefix, ...parts.map(part => slugifyIdPart(part)).filter(Boolean)].join(':');
}

function parseListValue(value) {
    if (Array.isArray(value)) {
        return value.map(item => normalizeText(item)).filter(Boolean);
    }
    return String(value || '')
        .split(/[,，、|]/)
        .map(item => normalizeText(item))
        .filter(Boolean);
}

function clampNumber(value, min, max, fallback = min) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, number));
}

function isInvalidEntityName(value) {
    const text = normalizeText(value).toLowerCase();
    return !text || ['singleton', 'unknown', 'undefined', 'null', 'n/a'].includes(text);
}

function stripExtractionNoise(text) {
    return String(text || '')
        .replace(/<UpdateVariable>[\s\S]*?<\/UpdateVariable>/g, '')
        .replace(/<Analysis>[\s\S]*?<\/Analysis>/g, '')
        .replace(/<StatusPlaceHolderImpl\s*\/?>/g, '')
        .replace(/<\/?正文>/g, '')
        .replace(/<thinking>[\s\S]*?<\/thinking>/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function buildMemoryExtractionTranscript(turns) {
    return turns.map(item => {
        const speaker = item.message?.is_user ? name1 || 'User' : name2 || 'Assistant';
        const raw = item.message?.mes || item.message?.message || item.message?.content || '';
        const text = stripExtractionNoise(raw);
        return text ? `#${item.index} ${speaker}: ${text}` : '';
    }).filter(Boolean).join('\n');
}

function buildMemoryExtractionStaticMessages() {
    const rolePrompt = [
        '你是【长期记忆整理 AI】，负责把聊天片段整理成结构化长期记忆。',
        '你必须先抽取，再清洗、合并、降噪，最后只输出 <tableEdit>...</tableEdit> 命令块。',
        '不要输出解释、寒暄或 Markdown。不要把临时动作、样式代码、网页 UI、无长期影响的流水账写入长期记忆。',
    ].join('\n');

    const schemaPrompt = [
        '## 新记忆库结构',
        '- scene_state 单例: location, time, currentActivity, mood, activeEntities(逗号分隔), openThreads(逗号分隔)',
        '- entities: id, type(character/place/item/rule/concept/organization), canonicalName, aliases, description, status, importance(0-1), confidence(0-1), firstTurn, lastTurn',
        '- facts: id, subjectId, predicate, value, category(appearance/personality/background/rule/status/ability/lore/item/persona), permanence(stable/session/temporary), confidence(0-1), importance(0-1), sourceTurns',
        '- relationships: id, fromId, toId, type, value(0-1), stableSummary, recentChange, confidence(0-1)',
        '- events: id, summary, participants(实体id逗号分隔), locationId, keywords, turnStart, turnEnd, importance(0-1), noveltyHash, mergedFrom, status(active/merged/expired)',
        '- memory_audit: id, turn, rawProposal, acceptedOps, rejectedOps, reason, createdAt',
    ].join('\n');

    const commandPrompt = [
        '## 命令格式',
        '将所有命令写在 <tableEdit> 和 </tableEdit> 之间，每行一条：',
        '<tableEdit>',
        'insertRow(“table_name”, {“col”:”val”,...})',
        'updateRow(“table_name”, “key_value”, {“col”:”val”,...})',
        'deleteRow(“table_name”, “key_value”)',
        '</tableEdit>',
        '',
        '## 决策流程（必须严格遵守，这是最重要的规则）',
        '第一步：逐条阅读「当前数据库状态」中已有的实体、事实、关系、事件。',
        '第二步：对每条候选记忆，按以下顺序判断：',
        '  (a) 已有完全相同的实体/事实/关系？ → updateRow，使用已有的 id，只更新变化的字段',
        '  (b) 已有相同 subjectId + predicate 的事实？ → updateRow 覆盖旧值，不要 insertRow 新行',
        '  (c) 已有相同 fromId + toId 的关系？ → updateRow，不要 insertRow 新行',
        '  (d) 已过时、不再适用的数据？ → deleteRow',
        '  (e) 全新数据，数据库中不存在？ → insertRow',
        '  (f) 无变化？ → 不输出任何命令',
        '第三步：检查输出中是否有重复，同一 id 不得出现两次 insertRow。',
        '',
        '## 写入规则',
        '1. scene_state 始终用 updateRow(“scene_state”, “singleton”, {...})。',
        '2. 实体必须使用稳定 id：character:姓名、place:地点、item:物品、rule:规则名。禁止把 singleton/unknown/null 当成实体名。',
        '3. 同一人、同一地点、同一物品必须复用已有实体 id（从「当前数据库状态」中查找）；别名写 aliases，不要重复 insert。',
        '4. concept 类型仅用于抽象世界观概念（如魔法体系规则），禁止为 character/place/item 创建 concept:character:* 或 concept:place:* 副本。',
        '5. 角色外貌、性格、背景、能力、规则、稳定身份写 facts；当前姿势、表情、一次性动作不要写 facts。',
        '6. 同一 subjectId + predicate 的事实只能有一行。如果已有 character:浅野堇 predicate=personality 的事实，用 updateRow 更新它，不要新增。',
        '7. status 类事实：如果 permanence=session，新阶段开始时必须先 deleteRow 旧的 session status，再 insertRow 新的。',
        '8. 关系表只写稳定关系与最近变化，不要把完整事件流水塞进 stableSummary。',
        '9. events 只写有长期意义的事件。重复事件要 update 旧事件，合并 summary/turnEnd/mergedFrom，不要新增相似流水账。',
        '10. 日常训练、吃饭、洗澡、拥抱、奖励等若没有长期后果，importance 最高 0.45；规则变化、身份变化、关系转折、长期伏笔可为 0.7 以上。',
        '11. 已使用、已消耗、离开当前场景的临时物品写 temporary fact 或直接忽略，不要长期保留。',
        '12. 每次输出最后必须插入一条 memory_audit，记录本次接受/拒绝/合并原因。',
        '13. 如果没有值得写入的长期记忆，只输出 memory_audit，reason 写”无长期记忆变化”。',
    ].join('\n');

    const examplePrompt = [
        '## 示例（展示 updateRow 和 deleteRow 的正确用法）',
        '<tableEdit>',
        '// 更新已有场景（singleton 表始终 update）',
        'updateRow(“scene_state”, “singleton”, {“location”:”月泉浴室”,”time”:”夜晚”,”currentActivity”:”共浴后交谈”,”mood”:”放松但暧昧”,”activeEntities”:”character:时幼微,character:浅野堇,place:月泉”,”openThreads”:”浅野堇对依赖感仍嘴硬”})',
        '// 实体已存在 → updateRow 而不是 insertRow',
        'updateRow(“entities”, “character:时幼微”, {“description”:”三千年阅历的魔女，掌控欲强但温柔狡黠，目前在月泉”,”status”:”在场”,”lastTurn”:35})',
        '// 事实已存在（同一 subjectId+predicate）→ updateRow 覆盖',
        'updateRow(“facts”, “fact:character:时幼微:appearance”, {“value”:”墨色长发，紫罗兰色眼眸，常穿白色棉质T恤和运动短裙”,”confidence”:0.85,”sourceTurns”:”1-35”})',
        '// 删除过时的 session status',
        'deleteRow(“facts”, “fact:character:浅野堇:status”)',
        '// 新 session status',
        'insertRow(“facts”, {“id”:”fact:character:浅野堇:status”,”subjectId”:”character:浅野堇”,”predicate”:”status”,”value”:”刚结束共浴，全身放松”,”category”:”status”,”permanence”:”session”,”confidence”:0.9,”importance”:0.4,”sourceTurns”:”35”})',
        '// 关系已存在 → updateRow',
        'updateRow(“relationships”, “rel:character:时幼微->character:浅野堇”, {“value”:0.75,”stableSummary”:”时幼微主导关系，浅野堇开始主动亲近但仍嘴硬”,”recentChange”:”浅野堇训练后主动求抱，依赖感上升”,”confidence”:0.85})',
        '// 事件可以合并 → updateRow',
        'updateRow(“events”, “event:训练后主动求抱”, {“summary”:”浅野堇多次在训练后主动求抱，时幼微用拥抱和奖励回应，双方依赖感上升。”,”turnEnd”:35,”mergedFrom”:”AM0002,AM0003,AM0005”,”importance”:0.55})',
        '// 审计记录',
        'insertRow(“memory_audit”, {“id”:”audit:35”,”turn”:35,”rawProposal”:”抽取近期训练、共浴与关系变化”,”acceptedOps”:”更新场景;更新时幼微实体;更新外貌事实;删除旧status;新增新status;更新关系;合并事件”,”rejectedOps”:”未重复新增已存在实体;未保留临时动作”,”reason”:”已有数据用updateRow覆盖，旧session status已删除”,”createdAt”:”now”})',
        '</tableEdit>',
    ].join('\n');

    return [
        { role: 'system', content: rolePrompt },
        { role: 'system', content: schemaPrompt },
        { role: 'system', content: commandPrompt },
        { role: 'system', content: examplePrompt },
    ];
}

function buildMemoryExtractionDynamicMessage(turns, worldTerms, tableData) {
    const transcript = buildMemoryExtractionTranscript(turns);
    const tableState = buildTableStateSnapshot(tableData);

    return {
        role: 'user',
        content: [
            `当前角色：${name2 || '未知'}；用户：${name1 || '未知'}。`,
            `世界书关键词：${worldTerms.slice(0, 40).join(', ') || '无'}`,
            '',
            '## 当前数据库状态',
            tableState || '（空）',
            '',
            '--- 聊天片段 ---',
            transcript,
            '--- 片段结束 ---',
        ].join('\n'),
    };
}

function buildMemoryExtractionMessages(turns, worldTerms, tableData) {
    return [
        ...buildMemoryExtractionStaticMessages(),
        buildMemoryExtractionDynamicMessage(turns, worldTerms, tableData),
    ];
}

function buildTableStateSnapshot(tableData) {
    if (!tableData) return '';
    const lines = [];
    const scene = tableData.sceneState?.[0];
    if (scene) {
        const parts = [];
        if (scene.location) parts.push(`位置：${scene.location}`);
        if (scene.time) parts.push(`时间：${scene.time}`);
        if (scene.currentActivity) parts.push(`活动：${scene.currentActivity}`);
        if (scene.mood) parts.push(`氛围：${scene.mood}`);
        if (scene.activeEntities) parts.push(`活跃：${scene.activeEntities}`);
        if (scene.openThreads) parts.push(`悬念：${scene.openThreads}`);
        if (parts.length) lines.push(`[scene_state] ${parts.join(' | ')}`);
    }
    if (tableData.entities?.length) {
        for (const entity of tableData.entities.slice(0, 40)) {
            lines.push(`[entity] ${entity.id} ${entity.type || ''} ${entity.canonicalName || ''}: ${(entity.description || '').slice(0, 80)} status=${entity.status || ''}`);
        }
    }
    if (tableData.facts?.length) {
        for (const fact of tableData.facts.slice(0, 60)) {
            lines.push(`[fact] ${fact.id} ${fact.subjectId}.${fact.predicate}=${String(fact.value || '').slice(0, 90)} permanence=${fact.permanence || ''}`);
        }
    }
    if (tableData.relationships?.length) {
        for (const rel of tableData.relationships.slice(0, 30)) {
            lines.push(`[relationship] ${rel.id}: ${rel.type}(${rel.value}) ${rel.stableSummary || ''} ${rel.recentChange || ''}`);
        }
    }
    if (tableData.events?.length) {
        const events = [...tableData.events].sort((a, b) => Number(b.turnEnd || 0) - Number(a.turnEnd || 0));
        for (const event of events.slice(0, 30)) {
            lines.push(`[event] ${event.id} turn=${event.turnStart || ''}-${event.turnEnd || ''} importance=${event.importance || ''}: ${event.summary || ''}`);
        }
    }
    return lines.join('\n');
}

function parseTableCommands(llmOutput) {
    // Normalize curly quotes to straight quotes
    const normalized = llmOutput.replace(/[“”]/g, '"').replace(/[‘’]/g, '\'');
    // First try to extract from <tableEdit>...</tableEdit> tags
    const tagMatch = normalized.match(/<tableEdit>([\s\S]*?)<\/tableEdit>/i);
    const searchText = tagMatch ? tagMatch[1] : normalized;
    console.log('[DCO] parseTableCommands: input len=', llmOutput.length, 'tagMatch=', !!tagMatch, 'searchLen=', searchText.length);
    if (!tagMatch) console.log('[DCO] no <tableEdit> tag, first 200:', normalized.slice(0, 200));

    const commands = [];
    const regex = /(insertRow|updateRow|deleteRow)\("(\w+)"(?:\s*,\s*"([^"]*)")?\s*(?:,\s*(\{[^}]+\}))?\)/g;
    let match;
    while ((match = regex.exec(searchText)) !== null) {
        const [, action, table, keyValue, dataStr] = match;
        let data = {};
        if (dataStr) {
            try {
                data = JSON.parse(dataStr);
            } catch {
                const pairs = dataStr.match(/"([^"]+)"\s*:\s*"([^"]*)"/g) || [];
                for (const pair of pairs) {
                    const parsed = pair.match(/"([^"]+)"\s*:\s*"([^"]*)"/) || [];
                    if (parsed[1]) data[parsed[1]] = parsed[2] || '';
                }
            }
        }
        if (TABLE_SCHEMAS[table]) {
            commands.push({ action, table, keyValue, data });
        }
    }
    console.log('[DCO] parseTableCommands: found', commands.length, 'commands');
    return commands;
}

function normalizeMemoryRow(tableName, data, keyValue = '') {
    const row = { ...(data || {}) };
    const turn = chat.length;

    if (tableName === 'scene_state') {
        row._key = 'singleton';
        return row;
    }

    if (tableName === 'entities') {
        const name = row.canonicalName || keyValue || row.id;
        if (isInvalidEntityName(name)) return null;
        row.type = String(row.type || 'concept').toLowerCase();
        // Filter redundant concept entities that duplicate character/place/item
        if (row.type === 'concept' && /^concept:(character|place|item):/i.test(row.id || name)) {
            return null;
        }
        row.canonicalName = normalizeText(name);
        row.id = row.id || makeMemoryId(row.type, row.canonicalName);
        if (isInvalidEntityName(row.id)) return null;
        row.importance = clampNumber(row.importance, 0, 1, 0.5);
        row.confidence = clampNumber(row.confidence, 0, 1, 0.7);
        row.firstTurn = Number(row.firstTurn || turn);
        row.lastTurn = Number(row.lastTurn || turn);
        return row;
    }

    if (tableName === 'facts') {
        if (!row.subjectId || !row.predicate || !row.value) return null;
        row.predicate = slugifyIdPart(row.predicate, 'fact');
        row.id = row.id || makeMemoryId('fact', row.subjectId, row.predicate);
        row.permanence = ['stable', 'session', 'temporary'].includes(row.permanence) ? row.permanence : 'stable';
        row.confidence = clampNumber(row.confidence, 0, 1, 0.7);
        row.importance = clampNumber(row.importance, 0, 1, row.permanence === 'temporary' ? 0.25 : 0.55);
        row.sourceTurns = row.sourceTurns || String(turn);
        return row;
    }

    if (tableName === 'relationships') {
        if (!row.fromId || !row.toId) return null;
        row.id = row.id || keyValue || `rel:${row.fromId}->${row.toId}`;
        row.value = clampNumber(row.value, -1, 1, 0);
        row.confidence = clampNumber(row.confidence, 0, 1, 0.7);
        return row;
    }

    if (tableName === 'events') {
        if (!row.summary) return null;
        row.participants = parseListValue(row.participants).join(',');
        row.keywords = parseListValue(row.keywords).join(',');
        row.turnStart = Number(row.turnStart || turn);
        row.turnEnd = Number(row.turnEnd || row.turnStart || turn);
        row.importance = clampNumber(row.importance, 0, 1, 0.4);
        row.noveltyHash = row.noveltyHash || slugifyIdPart(`${row.summary} ${row.participants} ${row.keywords}`, 'event');
        row.id = row.id || makeMemoryId('event', row.noveltyHash);
        row.status = row.status || 'active';
        return row;
    }

    if (tableName === 'memory_audit') {
        row.turn = Number(row.turn || turn);
        row.id = row.id || makeMemoryId('audit', row.turn, Date.now());
        row.createdAt = row.createdAt === 'now' || !row.createdAt ? new Date().toISOString() : row.createdAt;
        return row;
    }

    return row;
}

function shouldMergeEvents(existing, incoming) {
    if (!existing || !incoming) return false;
    if (existing.id === incoming.id) return true;
    const existingHash = normalizeText(existing.noveltyHash).toLowerCase();
    const incomingHash = normalizeText(incoming.noveltyHash).toLowerCase();
    if (existingHash && incomingHash && existingHash === incomingHash) return true;
    const existingTerms = splitTerms(`${existing.summary} ${existing.keywords} ${existing.participants}`);
    const incomingText = normalizeText(`${incoming.summary} ${incoming.keywords} ${incoming.participants}`).toLowerCase();
    const overlap = existingTerms.filter(term => incomingText.includes(term)).length;
    return overlap >= Math.min(4, Math.max(2, existingTerms.length));
}

async function upsertMemoryRow(tableName, row, keyValue = '') {
    const schema = TABLE_SCHEMAS[tableName];
    if (!schema) return false;
    const normalized = normalizeMemoryRow(tableName, row, keyValue);
    if (!normalized) return false;

    if (schema.singleton) {
        normalized._key = 'singleton';
        await putRow(tableName, normalized);
        return true;
    }

    const keyCol = schema.keyColumn;
    const existing = await getTable(tableName);

    if (tableName === 'events') {
        const target = existing.find(item => shouldMergeEvents(item, normalized));
        if (target) {
            target.summary = normalized.summary || target.summary;
            target.participants = mergeListStrings(target.participants, normalized.participants);
            target.keywords = mergeListStrings(target.keywords, normalized.keywords);
            target.turnStart = Math.min(Number(target.turnStart || normalized.turnStart), Number(normalized.turnStart || target.turnStart));
            target.turnEnd = Math.max(Number(target.turnEnd || normalized.turnEnd), Number(normalized.turnEnd || target.turnEnd));
            target.importance = Math.max(Number(target.importance || 0), Number(normalized.importance || 0));
            target.mergedFrom = mergeListStrings(target.mergedFrom, normalized.mergedFrom || normalized.id);
            target.status = 'active';
            await putRow(tableName, target);
            return true;
        }
    }

    // Status auto-expiry: delete old session status facts for the same subject
    if (tableName === 'facts' && normalized.predicate === 'status' && normalized.permanence === 'session') {
        const stale = existing.filter(item =>
            item.subjectId === normalized.subjectId &&
            item.predicate === 'status' &&
            item.permanence === 'session' &&
            item.id !== normalized.id,
        );
        for (const item of stale) {
            await deleteRow(tableName, item.id);
        }
    }

    const key = normalized[keyCol] || keyValue;
    const target = existing.find(item => item[keyCol] === key);
    if (target) {
        await putRow(tableName, { ...target, ...normalized, [keyCol]: key });
    } else {
        await putRow(tableName, { ...normalized, [keyCol]: key });
    }
    return true;
}

function mergeListStrings(a, b) {
    return [...new Set([...parseListValue(a), ...parseListValue(b)])].join(',');
}

async function executeTableCommands(commands) {
    let executed = 0;
    // Cache existing rows per table to avoid repeated reads
    const existingCache = {};
    const getExisting = async (table) => {
        if (!existingCache[table]) existingCache[table] = await getTable(table);
        return existingCache[table];
    };

    for (const cmd of commands) {
        try {
            const schema = TABLE_SCHEMAS[cmd.table];
            if (!schema) continue;

            if (cmd.action === 'insertRow') {
                // Anti-duplicate: if key already exists, merge as update instead
                if (!schema.singleton && schema.keyColumn) {
                    const key = cmd.data?.[schema.keyColumn];
                    if (key) {
                        const existing = await getExisting(cmd.table);
                        const found = existing.find(row => row[schema.keyColumn] === key);
                        if (found) {
                            await putRow(cmd.table, { ...found, ...cmd.data });
                            executed++;
                            continue;
                        }
                    }
                }
                if (await upsertMemoryRow(cmd.table, cmd.data)) executed++;
            } else if (cmd.action === 'updateRow') {
                if (await upsertMemoryRow(cmd.table, cmd.data, cmd.keyValue)) executed++;
            } else if (cmd.action === 'deleteRow') {
                await deleteRow(cmd.table, cmd.keyValue);
                // Invalidate cache for this table
                delete existingCache[cmd.table];
                executed++;
            }
        } catch (e) {
            console.warn('[DeepSeek Cache Optimizer] Failed to execute command:', cmd, e);
        }
    }
    return executed;
}

function getExtractorModel(settings) {
    const explicitModel = String(settings.memoryLlmModel || '').trim();
    if (explicitModel) {
        return explicitModel;
    }

    const source = getExtractorSource(settings);
    if (source === chat_completion_sources.CUSTOM) return oai_settings.custom_model || getChatCompletionModel(oai_settings);
    if (source === chat_completion_sources.OPENAI) return oai_settings.openai_model || getChatCompletionModel(oai_settings);
    if (source === chat_completion_sources.OPENROUTER) return oai_settings.openrouter_model || getChatCompletionModel(oai_settings);
    return getChatCompletionModel(oai_settings) || 'deepseek-v4-flash';
}

function getExtractorSource(settings) {
    return settings.memoryLlmSource === 'current'
        ? oai_settings.chat_completion_source
        : settings.memoryLlmSource;
}

async function callMemoryExtractorViaSt(messages, settings) {
    const source = getExtractorSource(settings);
    // Build custom_include_body with thinking disabled (for DeepSeek via Custom/NewAPI)
    // mergeObjectWithYaml() expects a YAML/JSON *string*, not an object
    const extraBody = { thinking: { type: 'disabled' } };
    if (source === chat_completion_sources.CUSTOM && oai_settings.custom_include_body) {
        try {
            const existing = typeof oai_settings.custom_include_body === 'string'
                ? JSON.parse(oai_settings.custom_include_body) : oai_settings.custom_include_body;
            Object.assign(extraBody, existing);
        } catch { /* ignore parse errors */ }
    }
    const payload = {
        messages,
        model: getExtractorModel(settings),
        type: 'dco_memory_extraction',
        chat_completion_source: source,
        include_reasoning: false,
        max_tokens: Number(settings.memoryLlmMaxTokens || defaultSettings.memoryLlmMaxTokens),
        temperature: Number(settings.memoryLlmTemperature ?? defaultSettings.memoryLlmTemperature),
        stream: false,
        custom_url: source === chat_completion_sources.CUSTOM ? oai_settings.custom_url : undefined,
        custom_include_body: source === chat_completion_sources.CUSTOM ? JSON.stringify(extraBody) : undefined,
        custom_exclude_body: source === chat_completion_sources.CUSTOM ? oai_settings.custom_exclude_body : undefined,
        custom_include_headers: source === chat_completion_sources.CUSTOM ? oai_settings.custom_include_headers : undefined,
        custom_prompt_post_processing: oai_settings.custom_prompt_post_processing,
        reverse_proxy: oai_settings.reverse_proxy,
        proxy_password: oai_settings.proxy_password,
    };

    Object.keys(payload).forEach(key => payload[key] === undefined && delete payload[key]);

    const response = await fetch('/api/backends/chat-completions/generate', {
        method: 'POST',
        headers: getRequestHeaders(),
        cache: 'no-cache',
        body: JSON.stringify(payload),
    });

    const json = await response.json();
    if (!response.ok || json?.error) {
        throw new Error(String(json?.error?.message || json?.message || '记忆抽取请求失败'));
    }

    const content = extractMessageFromData(json, 'openai');
    const reasoning = json?.choices?.[0]?.message?.reasoning_content || '';
    console.log('[DeepSeek Cache Optimizer] Extraction content:', content?.slice(0, 200));
    console.log('[DeepSeek Cache Optimizer] Extraction reasoning length:', reasoning.length);
    // Commands may be in content or reasoning (when reasoning tokens exhaust the budget)
    return { content: content || '', reasoning: reasoning || '' };
}

async function callMemoryExtractorDirect(messages, settings) {
    const apiUrl = String(settings.memoryLlmApiUrl || '').trim().replace(/\/+$/, '');
    const apiKey = String(settings.memoryLlmApiKey || '').trim();
    const model = getExtractorModel(settings);
    if (!apiUrl || !apiKey || !model) {
        throw new Error('直接连接需要填写 API URL、API Key 和模型名。');
    }

    const response = await fetch(`${apiUrl}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            model,
            temperature: Number(settings.memoryLlmTemperature ?? defaultSettings.memoryLlmTemperature),
            max_tokens: Number(settings.memoryLlmMaxTokens || defaultSettings.memoryLlmMaxTokens),
            stream: false,
            thinking: { type: 'disabled' },
            messages,
        }),
    });

    const json = await response.json();
    if (!response.ok || json?.error) {
        throw new Error(String(json?.error?.message || json?.message || '直接记忆抽取请求失败'));
    }

    const directContent = json?.choices?.[0]?.message?.content || '';
    const directReasoning = json?.choices?.[0]?.message?.reasoning_content || '';
    console.log('[DeepSeek Cache Optimizer] Direct content:', directContent?.slice(0, 200));
    return { content: directContent, reasoning: directReasoning };
}

async function runMemoryLlmExtraction({ manual = false } = {}) {
    const settings = getSettings();
    if (!settings.memoryEnabled || !settings.memoryLlmEnabled || memoryExtractorRunning || !Array.isArray(chat)) {
        return;
    }

    const currentTurn = chat.length;
    const everyTurns = Number(settings.memoryLlmEveryTurns || defaultSettings.memoryLlmEveryTurns);
    if (!manual && currentTurn - Number(settings.memoryLlmLastExtractedTurn || 0) < everyTurns) {
        return;
    }

    const worldTerms = getWorldInfoTerms();
    const turnCount = Number(settings.memoryLlmTurns || defaultSettings.memoryLlmTurns);
    const turns = chat
        .map((message, index) => ({ message, index }))
        .filter(item => stripExtractionNoise(item.message?.mes || item.message?.message || item.message?.content || '').length >= 8)
        .slice(-turnCount);

    if (!turns.length) {
        memoryExtractorStatus = '没有可抽取的聊天内容。';
        updateStats();
        return;
    }

    memoryExtractorRunning = true;
    memoryExtractorStatus = '正在调用记忆抽取模型...';
    updateStats();
    toastr.info('正在抽取记忆...');

    try {
        const tableData = {
            sceneState: await getTable('scene_state'),
            entities: await getTable('entities'),
            facts: await getTable('facts'),
            relationships: await getTable('relationships'),
            events: await getTable('events'),
            audit: await getTable('memory_audit'),
        };
        const extractionMessages = buildMemoryExtractionMessages(turns, worldTerms, tableData);
        const result = settings.memoryLlmProvider === 'direct'
            ? await callMemoryExtractorDirect(extractionMessages, settings)
            : await callMemoryExtractorViaSt(extractionMessages, settings);

        // Try content first, fallback to reasoning (when reasoning tokens exhaust budget)
        let rawContent = result.content || '';
        if (!rawContent.trim() || rawContent === '<none>') {
            rawContent = result.reasoning || '';
        }

        if (!rawContent.trim() || rawContent === '<none>') {
            memoryExtractorStatus = '完成：模型未返回有效内容，未执行任何操作。';
            toastr.warning(memoryExtractorStatus);
            return;
        }

        const commands = parseTableCommands(rawContent);
        if (!commands.length) {
            memoryExtractorStatus = '完成：未识别到有效命令。';
            toastr.warning(memoryExtractorStatus);
            return;
        }

        const executed = await executeTableCommands(commands);
        settings.memoryLlmLastExtractedTurn = currentTurn;
        saveSettingsDebounced();
        lastMemoryExtractorResult = { at: new Date(), executed, commands, raw: rawContent };
        memoryExtractorStatus = `完成：执行 ${executed} 条命令。`;
        toastr.success(memoryExtractorStatus);
    } catch (error) {
        memoryExtractorStatus = `失败：${error.message || error}`;
        console.warn('[DeepSeek Cache Optimizer] Memory LLM extraction failed', error);
        toastr.error(memoryExtractorStatus);
    } finally {
        memoryExtractorRunning = false;
        updateStats();
    }
}

async function recallStructuredMemory(messages) {
    const settings = getSettings();
    if (!settings.memoryEnabled || !settings.memoryInject) {
        lastRecallResults = [];
        return null;
    }

    const sceneState = (await getTable('scene_state'))[0] || null;
    const allEntities = await getTable('entities');
    const allFacts = await getTable('facts');
    const allRelationships = await getTable('relationships');
    const allEvents = await getTable('events');

    const queryText = normalizeText([
        getRecentMessageText(messages, 8),
        rowText(sceneState),
        name1,
        name2,
    ].filter(Boolean).join('\n')).toLowerCase();
    const queryTerms = splitTerms(queryText);
    const worldTerms = getWorldInfoTerms();
    const activeEntityIds = new Set(parseListValue(sceneState?.activeEntities));

    for (const entity of allEntities) {
        const names = [entity.id, entity.canonicalName, entity.aliases].filter(Boolean).join(' ');
        if (isExplicitlyMentioned(names, queryTerms, queryText)) {
            activeEntityIds.add(entity.id);
        }
    }

    const stableEntities = pickTopRows(allEntities, entity => {
        const text = rowText(entity, ['id', 'type', 'canonicalName', 'aliases', 'description', 'status']);
        let score = Number(entity.importance || 0) * 2;
        score += scoreTextAgainstTerms(text, queryTerms, 1.4);
        score += scoreTextAgainstTerms(text, worldTerms, 0.35);
        if (activeEntityIds.has(entity.id)) score += 4;
        if (['character', 'rule', 'place'].includes(entity.type)) score += 0.75;
        return score;
    }, Number(settings.memoryMaxCharacters ?? defaultSettings.memoryMaxCharacters) + Number(settings.memoryMaxWorldLore ?? defaultSettings.memoryMaxWorldLore));

    for (const entity of stableEntities) {
        if (entity.id) activeEntityIds.add(entity.id);
    }

    const stableFacts = pickTopRows(allFacts, fact => {
        const text = rowText(fact, ['subjectId', 'predicate', 'value', 'category', 'permanence']);
        let score = Number(fact.importance || 0) * 2;
        score += scoreTextAgainstTerms(text, queryTerms, 1.2);
        score += scoreTextAgainstTerms(text, worldTerms, 0.3);
        if (activeEntityIds.has(fact.subjectId)) score += fact.permanence === 'stable' ? 3 : 1.5;
        if (fact.permanence === 'temporary') score -= 1.5;
        return score;
    }, 18);

    const relationships = pickTopRows(allRelationships, rel => {
        const text = rowText(rel, ['fromId', 'toId', 'type', 'stableSummary', 'recentChange']);
        let score = scoreTextAgainstTerms(text, queryTerms, 1.2) + Number(rel.confidence || 0);
        if (activeEntityIds.has(rel.fromId)) score += 2.5;
        if (activeEntityIds.has(rel.toId)) score += 2.5;
        return score;
    }, Number(settings.memoryMaxRelationships ?? defaultSettings.memoryMaxRelationships));

    const recentEventLimit = Number(settings.memoryRecentChronicle ?? defaultSettings.memoryRecentChronicle);
    const maxEvents = Number(settings.memoryMaxChronicle || defaultSettings.memoryMaxChronicle);
    const minImportance = Number(settings.memoryMinImportance ?? defaultSettings.memoryMinImportance);
    const activeEvents = allEvents.filter(event => event.status !== 'merged' && event.status !== 'expired');
    const recentEvents = [...activeEvents].sort((a, b) => Number(b.turnEnd || 0) - Number(a.turnEnd || 0)).slice(0, Math.max(0, recentEventLimit));
    const scoredEvents = activeEvents
        .map((event, index) => {
            const text = rowText(event, ['summary', 'participants', 'locationId', 'keywords']);
            const participants = parseListValue(event.participants);
            let score = Number(event.importance || 0) * 2;
            score += scoreTextAgainstTerms(text, queryTerms, 1.3);
            score += scoreTextAgainstTerms(text, worldTerms, 0.25);
            score += participants.filter(id => activeEntityIds.has(id)).length * 1.5;
            return { row: event, index, score };
        })
        .filter(item => item.score > 0 && (Number(item.row.importance || 0) >= minImportance || item.score >= 2.5))
        .sort((a, b) => b.score - a.score || Number(b.row.turnEnd || 0) - Number(a.row.turnEnd || 0) || a.index - b.index)
        .map(item => item.row);
    const events = mergeUniqueRows([...recentEvents, ...scoredEvents], 'id', maxEvents);

    lastRecallResults = [
        ...stableEntities.map(record => ({ type: 'entity', record })),
        ...stableFacts.map(record => ({ type: 'fact', record })),
        ...relationships.map(record => ({ type: 'relationship', record })),
        ...events.map(record => ({ type: 'event', record })),
    ];

    return { sceneState, entities: stableEntities, facts: stableFacts, relationships, events };
}

function buildStructuredInjection(memory) {
    if (!memory) return '';
    const lines = [MEMORY_INJECTION_MARKER];

    const entitiesById = new Map((memory.entities || []).map(entity => [entity.id, entity]));

    if (memory.entities?.length) {
        lines.push('[长期实体]');
        for (const entity of memory.entities) {
            const parts = [entity.canonicalName || entity.id, entity.type];
            if (entity.aliases) parts.push(`别名:${entity.aliases}`);
            if (entity.description) parts.push(entity.description);
            if (entity.status) parts.push(`状态:${entity.status}`);
            lines.push(`- ${parts.filter(Boolean).join(' / ')}`);
        }
    }

    if (memory.facts?.length) {
        lines.push('[稳定事实]');
        for (const fact of memory.facts) {
            const entity = entitiesById.get(fact.subjectId);
            const subject = entity?.canonicalName || fact.subjectId;
            lines.push(`- ${subject}.${fact.predicate}: ${fact.value}`);
        }
    }

    if (memory.relationships?.length) {
        lines.push('[关系状态]');
        for (const rel of memory.relationships) {
            const from = entitiesById.get(rel.fromId)?.canonicalName || rel.fromId;
            const to = entitiesById.get(rel.toId)?.canonicalName || rel.toId;
            const parts = [`${from} -> ${to}`, rel.type, String(rel.value ?? '')];
            if (rel.stableSummary) parts.push(rel.stableSummary);
            if (rel.recentChange) parts.push(`近期:${rel.recentChange}`);
            lines.push(`- ${parts.filter(Boolean).join(' / ')}`);
        }
    }

    if (memory.events?.length) {
        lines.push('[相关事件摘要]');
        for (const event of memory.events) {
            const turn = event.turnStart || event.turnEnd ? `#${event.turnStart || '?'}-${event.turnEnd || '?'}` : '';
            lines.push(`- ${turn} ${event.summary}`.trim());
        }
    }

    if (memory.sceneState) {
        lines.push('[当前场景]');
        const s = memory.sceneState;
        const parts = [];
        if (s.location) parts.push(`位置:${s.location}`);
        if (s.time) parts.push(`时间:${s.time}`);
        if (s.currentActivity) parts.push(`活动:${s.currentActivity}`);
        if (s.mood) parts.push(`氛围:${s.mood}`);
        if (s.openThreads) parts.push(`待续:${s.openThreads}`);
        lines.push(parts.join(' | '));
    }

    lines.push('</记忆数据库>');
    return lines.join('\n');
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
        mergedMessageSignatures: merged ? getMessageSignatures(merged) : null,
        mergedMessageCount: merged?.length ?? null,
    };
}

function rememberRequestRecord(record) {
    requestHistory.unshift(record);
    requestHistory = requestHistory.slice(0, 50);
    saveSnapshotToDb(record);
}

function updateLatestRequestWithUsage(eventData) {
    const record = requestHistory.find(item => !item.usageReceived);
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
    record.usageAt = new Date();
    record.settingsSignature = getRequestSettingsSignature(lastGenerationSettings);
    return record;
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
    const response = await fetch('/api/backends/chat-completions/dco-debug-bodies', {
        headers: getRequestHeaders(),
    });

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    backendBodyRecords = Array.isArray(data?.records) ? data.records : [];
    return backendBodyRecords;
}

async function clearBackendBodyRecords() {
    const response = await fetch('/api/backends/chat-completions/dco-debug-clear', {
        method: 'POST',
        headers: getRequestHeaders(),
    });

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }

    backendBodyRecords = [];
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

    if (lastRecallResults.length > 0 && Number(stats.pluginImpact || 0) > 3) {
        notes.push('记忆召回正在改变请求前缀；可降低召回条数、提高重要度阈值，或减少最近事件常驻数量。');
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

    if (eventData.type === 'dco_memory_extraction') {
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
    const record = updateLatestRequestWithUsage(eventData);
    if (record) {
        record.stats = structuredClone(lastStats);
    }
    usageHistory = requestHistory.filter(item => item.usageReceived).slice(0, 20);

    updateStats();
}

function handleGenerationSettings(generateData) {
    if (generateData?.type === 'dco_memory_extraction') {
        return;
    }

    lastGenerationSettings = {
        at: new Date(),
        type: generateData?.type,
        source: generateData?.chat_completion_source,
        model: generateData?.model,
        stream: Boolean(generateData?.stream),
        stream_options: generateData?.stream_options,
    };

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

    if (message?.name === 'local_memory_recall' || normalized.includes(MEMORY_INJECTION_MARKER)) {
        return {
            index,
            role,
            category: 'memory_recall',
            stability: 'stable',
            movable: false,
            order: 515,
            reason: '记忆注入块应保持位置稳定以维持缓存前缀',
            length: text.length,
            hash: hashString(serializeMessage(message)),
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

    if (message?.name === 'local_memory_recall') {
        return true;
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
        return ['stable_rule', 'character_static', 'format_rule', 'variable_schema', 'dynamic_state', 'memory_recall', 'history_marker'].includes(item.category);
    }

    return ['stable_rule', 'character_static', 'world_static', 'format_rule', 'variable_schema', 'dynamic_state', 'memory_recall', 'history_marker', 'unknown_stable', 'empty'].includes(item.category);
}

function shouldPromoteAcrossHistory(item, settings) {
    if (!shouldAnalyzerMove(item, settings)) {
        return false;
    }

    return ['stable_rule', 'character_static', 'world_static', 'format_rule', 'variable_schema', 'unknown_stable'].includes(item.category);
}

function reorderWithAnalyzer(messages, settings) {
    const analysis = messages.map((message, index) => classifyPromptMessage(message, index, messages));
    const promotable = analysis.filter(item => shouldPromoteAcrossHistory(item, settings));
    if (promotable.length < Number(settings.minPrefixMessages || defaultSettings.minPrefixMessages)) {
        return { changed: false, messages, moved: 0, protected: analysis.filter(item => item.category === 'rich_format').length, analysis };
    }

    const promotedIndexes = new Set(promotable.map(item => item.index));
    const orderedPromoted = promotable
        .slice()
        .sort((a, b) => a.order - b.order || a.index - b.index)
        .map(item => messages[item.index]);
    const remaining = analysis
        .filter(item => !promotedIndexes.has(item.index))
        .map(item => ({ item, message: messages[item.index] }));
    const insertAt = remaining.findIndex(({ item }) => item.category === 'chat_history' || item.category === 'latest_input');
    const insertionIndex = insertAt === -1 ? remaining.length : insertAt;
    const reordered = [
        ...remaining.slice(0, insertionIndex).map(entry => entry.message),
        ...orderedPromoted,
        ...remaining.slice(insertionIndex).map(entry => entry.message),
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

    if (eventData?.dryRun) {
        return;
    }

    if (!Array.isArray(eventData?.chat)) {
        lastStats = { moved: 0, total: 0, skipped: '没有聊天请求数据', protected: 0, rawPrefixChars: 0, rawPrefixPercent: 0, rawInputPercent: 0, pluginImpact: 0, firstChangedMessage: null, firstMessageHash: '' };
        updateStats();
        return;
    }

    // Serialize raw content (before plugin modifications) for prefix comparison
    const rawContentBefore = serializeRawContent(eventData.chat);

    promptRunCounter += 1;

    // Memory injection: always runs if enabled
    const memoryInjection = settings.memoryEnabled !== false
        ? buildStructuredInjection(await recallStructuredMemory(eventData.chat))
        : null;
    if (memoryInjection) {
        eventData.chat.push({
            role: 'system',
            content: memoryInjection,
            name: 'local_memory_recall',
        });
    }

    // Reordering: only runs if explicitly enabled
    let totalMoved = 0;
    let totalProtected = 0;
    if (false && settings.enabled) {
        const result = reorderWithAnalyzer(eventData.chat, settings);
        if (result.changed) {
            eventData.chat.splice(0, eventData.chat.length, ...result.messages);
        }
        totalMoved = result.moved;
        totalProtected = result.protected;
        lastPromptAnalysis = result.analysis || eventData.chat.map((message, index) => classifyPromptMessage(message, index, eventData.chat));
    } else {
        lastPromptAnalysis = eventData.chat.map((message, index) => classifyPromptMessage(message, index, eventData.chat));
    }

    // --- Merge-aware stability (calls server /process endpoint) ---
    let mergedMessages = null;
    let mergedContentAfter = '';
    let mergedPrefixPercent = null;
    let mergedPrefixChars = null;
    let mergedSignatures = [];
    let mergedMessagePrefixCount = null;
    let mergedFirstChangedMessage = null;

    if (mergeAwareAvailable) {
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

    const serializedPrompt = eventData.chat.map(serializeMessage).join('\n');
    const rawContentAfter = serializeRawContent(eventData.chat);
    const messageSignatures = getMessageSignatures(eventData.chat);

    // Raw input prefix: ST natural stability (current raw vs previous raw)
    const rawInputChars = previousRawInput
        ? getCommonPrefixLength(previousRawInput, rawContentBefore)
        : 0;
    const rawInputPercent = previousRawInput
        ? Math.round((rawInputChars / Math.max(rawContentBefore.length, 1)) * 10000) / 100
        : 0;

    // Final prefix: actual cache metric (current final vs previous final)
    const rawPrefixChars = previousRawContent
        ? getCommonPrefixLength(previousRawContent, rawContentAfter)
        : 0;
    const rawPrefixPercent = previousRawContent
        ? Math.round((rawPrefixChars / Math.max(rawContentAfter.length, 1)) * 10000) / 100
        : 0;

    // Plugin impact: how much the plugin breaks the prefix
    const pluginImpact = previousRawContent
        ? Math.round((rawInputPercent - rawPrefixPercent) * 100) / 100
        : 0;

    const firstChangedMessage = previousMessageSignatures.length
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
        runId: promptRunCounter,
        requestSettingsSignature: '',
        requestType: '',
        mergedPrefixChars,
        mergedPrefixPercent,
        mergedMessagePrefixCount,
        mergedFirstChangedMessage,
        mergedTotalMessages: mergedMessages?.length ?? null,
    };

    previousSerializedPrompt = serializedPrompt;
    previousRawContent = rawContentAfter;
    previousRawInput = rawContentBefore;
    previousMessageSignatures = messageSignatures;
    try {
        localStorage.setItem('dco_prevRawContent', rawContentAfter);
        localStorage.setItem('dco_prevRawInput', rawContentBefore);
    } catch { /* quota exceeded */ }
    if (mergedMessages) {
        previousMergedContent = mergedContentAfter;
        previousMergedSignatures = mergedSignatures;
        try { localStorage.setItem('dco_prevMergedContent', mergedContentAfter); } catch {}
    }
    rememberRequestRecord(makeRequestRecord({
        messages: eventData.chat,
        stats: lastStats,
        analysis: lastPromptAnalysis,
        serializedPrompt,
        mergedMessages,
    }));
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
    stats.text(`上次运行：移动 ${lastStats.moved} / ${lastStats.total} 条消息，动态块后移 ${lastStats.dynamicMoved || 0} 条，保护富格式 ${lastStats.protected || 0} 条，召回记忆 ${lastRecallResults.length} 条${skipped}`);

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
        `本地记忆：本轮召回 ${lastRecallResults.length} 条`,
        `记忆抽取：${memoryExtractorStatus}`,
        `扩展更新：${getUpdateStatusText()}`,
        '',
        '缓存诊断：',
        getCacheDiagnosisText(),
        '',
        getBackendUsageText(),
        firstChangedText.trim(),
    ].filter(Boolean).join('\n'));

    const extractorStatus = $('#dco_extractor_status');
    if (extractorStatus.length) {
        extractorStatus.text(memoryExtractorStatus);
        extractorStatus.css('color', memoryExtractorRunning ? '#fcee09' : '');
    }
    const extractorBtn = $('#dco_memory_llm_run');
    if (extractorBtn.length) {
        extractorBtn.prop('disabled', memoryExtractorRunning);
        extractorBtn.text(memoryExtractorRunning ? '运行中...' : '运行记忆抽取');
    }

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
        sidebarStats.find('.dco-sidebar-stat:eq(2) b').text(memoryExtractorStatus.length > 12 ? memoryExtractorStatus.slice(0, 12) + '...' : memoryExtractorStatus);
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
        return `
            <tr>
                <td>${escapeHtml(record.id || `#${requestHistory.length - index}`)}</td>
                <td>${escapeHtml(record.at?.toLocaleTimeString?.() || '')}</td>
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

async function fetchExtractorModels(settings) {
    try {
        const provider = settings.memoryLlmProvider || 'st';
        const source = getExtractorSource(settings);

        if (provider === 'direct') {
            const apiUrl = String(settings.memoryLlmApiUrl || '').trim().replace(/\/+$/, '');
            const apiKey = String(settings.memoryLlmApiKey || '').trim();
            if (!apiUrl || !apiKey) return [];
            const response = await fetch(`${apiUrl}/models`, {
                headers: { 'Authorization': `Bearer ${apiKey}` },
            });
            if (!response.ok) return [];
            const json = await response.json();
            const models = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
            return models.map(m => m?.id || m).filter(Boolean).sort();
        }

        if (source === 'current' || !source) {
            if (Array.isArray(model_list) && model_list.length) {
                return model_list.map(m => typeof m === 'string' ? m : m?.id || m?.value || '').filter(Boolean);
            }
            return [];
        }

        const data = {
            chat_completion_source: source,
            reverse_proxy: oai_settings.reverse_proxy || '',
            proxy_password: oai_settings.proxy_password || '',
            custom_url: oai_settings.custom_url || '',
        };
        const response = await fetch('/api/backends/chat-completions/status', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(data),
        });
        if (!response.ok) return [];
        const json = await response.json();
        const models = Array.isArray(json?.data) ? json.data : [];
        return models.map(m => typeof m === 'string' ? m : m?.id || m?.value || '').filter(Boolean);
    } catch (error) {
        console.warn('[DeepSeek Cache Optimizer] Failed to fetch extractor models', error);
        return [];
    }
}

async function openPanel(activeTab = 'optimizer') {
    const settings = getSettings();

    const stats = lastStats;
    const usageMetrics = getBackendUsageMetrics();
    const analysisRows = getAnalysisRows();
    const historyRows = getHistoryRows();
    const rawUsage = lastBackendUsage?.usage ? JSON.stringify(lastBackendUsage.usage, null, 2) : '';
    const defaultCompare = getDefaultCompareIds();
    const compareReport = getMessageDiffReport(defaultCompare.leftId, defaultCompare.rightId);
    const requestOptionsLeft = getRequestOptionRows(defaultCompare.leftId);
    const requestOptionsRight = getRequestOptionRows(defaultCompare.rightId);
    try {
        await refreshBackendBodyRecords();
    } catch (error) {
        console.warn('[DeepSeek Cache Optimizer] Failed to refresh backend body records', error);
    }
    const defaultBodyCompare = getDefaultBackendBodyCompareIds();
    const bodyCompareReport = getBackendBodyDiffReport(defaultBodyCompare.leftId, defaultBodyCompare.rightId);
    const bodyOptionsLeft = getBackendBodyOptionRows(defaultBodyCompare.leftId);
    const bodyOptionsRight = getBackendBodyOptionRows(defaultBodyCompare.rightId);
    const backendBodyRows = getBackendBodyRows();
    const extractorModels = await fetchExtractorModels(settings);
    const currentModel = String(settings.memoryLlmModel || '').trim();
    const useManualMode = currentModel && !extractorModels.includes(currentModel);
    const modelOptions = extractorModels.map(m => `<option value="${escapeHtml(m)}" ${m === currentModel ? 'selected' : ''}>${escapeHtml(m)}</option>`).join('');

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
                <label class="dco-tab${activeTab === 'memory' ? ' dco-tab--active' : ''}" data-tab="memory">记忆系统</label>
            </nav>
            <div class="dco-tab-content">
                <section class="dco-pane${activeTab === 'optimizer' ? ' dco-pane--active' : ''}" data-pane="optimizer">
                    <div class="dco-grid">
                        <section class="dco-card dco-rules-card">
                            <div class="dco-card-title">规则区</div>
                            <label class="checkbox_label dco-inline" for="dco_modal_enabled">
                                <input id="dco_modal_enabled" type="checkbox" ${settings.enabled ? 'checked' : ''} />
                                <span>启用 Prompt 消息重排（关闭后仅保留记忆注入）</span>
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
                            ${!settings.enabled ? '<div class="dco-muted" style="margin-top:0.5rem">重排已关闭。消息保持原始顺序，仅执行记忆注入。</div>' : ''}
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
                                        <th>轮次</th><th>时间</th><th>模型</th><th>模式</th><th>Prompt</th>
                                        <th>命中</th><th>未命中</th><th>后端命中率</th><th>最终前缀</th><th>插件影响</th><th>首变</th>
                                    </tr>
                                </thead>
                                <tbody>${historyRows || '<tr><td colspan="12">暂无请求。生成一次后会立刻记录；即使流式 usage 没返回也会保留。</td></tr>'}</tbody>
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
                <section class="dco-pane${activeTab === 'memory' ? ' dco-pane--active' : ''}" data-pane="memory">
                    <section class="dco-card">
                        <div class="dco-card-title">抽取状态</div>
                        <div class="dco-metric-grid">
                            <div class="dco-metric${memoryExtractorRunning ? ' accent' : ''}"><span>状态</span><b style="font-size:1rem">${escapeHtml(memoryExtractorStatus)}</b></div>
                            <div class="dco-metric"><span>上次抽取</span><b style="font-size:1rem">${lastMemoryExtractorResult ? escapeHtml(lastMemoryExtractorResult.at.toLocaleTimeString()) : '暂无'}</b></div>
                            <div class="dco-metric"><span>执行命令</span><b>${lastMemoryExtractorResult ? lastMemoryExtractorResult.executed : 0}</b></div>
                            <div class="dco-metric"><span>抽取间隔</span><b>${settings.memoryLlmEveryTurns || 3} 轮</b></div>
                        </div>
                        <div class="dco-action-row">
                            <button id="dco_memory_llm_run_top" class="menu_button"><i class="fa-solid fa-play"></i> 手动抽取</button>
                            <button id="dco_memory_clear_all" class="menu_button danger_button">清空所有数据</button>
                            <span class="dco-muted">世界书索引词 ${lastWorldInfoTerms.length} 个</span>
                        </div>
                    </section>
                    <section class="dco-card">
                        <div class="dco-card-title">开关</div>
                        <div class="dco-settings-grid">
                            <label class="checkbox_label dco-inline" for="dco_memory_enabled_modal">
                                <input id="dco_memory_enabled_modal" type="checkbox" ${settings.memoryEnabled ? 'checked' : ''} />
                                <span>启用本地记忆召回</span>
                            </label>
                            <label class="checkbox_label dco-inline" for="dco_memory_inject_modal">
                                <input id="dco_memory_inject_modal" type="checkbox" ${settings.memoryInject ? 'checked' : ''} />
                                <span>请求前注入召回块</span>
                            </label>
                        </div>
                        <div class="dco-settings-grid">
                            <label>
                                <span>最大事件召回条数</span>
                                <input id="dco_memory_max_chronicle_modal" class="text_pole" type="number" min="1" max="50" value="${Number(settings.memoryMaxChronicle || defaultSettings.memoryMaxChronicle)}" />
                            </label>
                            <label>
                                <span>最多实体召回条数</span>
                                <input id="dco_memory_max_characters_modal" class="text_pole" type="number" min="0" max="50" value="${Number(settings.memoryMaxCharacters ?? defaultSettings.memoryMaxCharacters)}" />
                            </label>
                            <label>
                                <span>事实召回调节</span>
                                <input id="dco_memory_max_items_modal" class="text_pole" type="number" min="0" max="50" value="${Number(settings.memoryMaxItems ?? defaultSettings.memoryMaxItems)}" />
                            </label>
                            <label>
                                <span>最多关系召回条数</span>
                                <input id="dco_memory_max_relationships_modal" class="text_pole" type="number" min="0" max="50" value="${Number(settings.memoryMaxRelationships ?? defaultSettings.memoryMaxRelationships)}" />
                            </label>
                            <label>
                                <span>世界/规则实体调节</span>
                                <input id="dco_memory_max_world_lore_modal" class="text_pole" type="number" min="0" max="30" value="${Number(settings.memoryMaxWorldLore ?? defaultSettings.memoryMaxWorldLore)}" />
                            </label>
                            <label>
                                <span>常保留最近事件</span>
                                <input id="dco_memory_recent_chronicle_modal" class="text_pole" type="number" min="0" max="20" value="${Number(settings.memoryRecentChronicle ?? defaultSettings.memoryRecentChronicle)}" />
                            </label>
                            <label>
                                <span>事件最低重要度</span>
                                <input id="dco_memory_min_importance_modal" class="text_pole" type="number" min="0" max="1" step="0.05" value="${Number(settings.memoryMinImportance ?? defaultSettings.memoryMinImportance)}" />
                            </label>
                        </div>
                        <div class="dco-muted">当前作用域：${escapeHtml(getMemoryScope().scopeKey)}。</div>
                    </section>
                    <section class="dco-card">
                        <div class="dco-card-title">LLM 结构化抽取</div>
                        <div class="dco-settings-grid">
                            <label class="checkbox_label dco-inline" for="dco_memory_llm_enabled_modal">
                                <input id="dco_memory_llm_enabled_modal" type="checkbox" ${settings.memoryLlmEnabled ? 'checked' : ''} />
                                <span>启用独立 LLM 抽取长期记忆</span>
                            </label>
                            <label>
                                <span>连接方式</span>
                                <select id="dco_memory_llm_provider_modal" class="text_pole">
                                    <option value="st" ${settings.memoryLlmProvider !== 'direct' ? 'selected' : ''}>复用 SillyTavern 后端密钥</option>
                                    <option value="direct" ${settings.memoryLlmProvider === 'direct' ? 'selected' : ''}>直接填写 OpenAI-compatible API</option>
                                </select>
                            </label>
                            <label>
                                <span>ST 后端源</span>
                                <select id="dco_memory_llm_source_modal" class="text_pole">
                                    <option value="current" ${settings.memoryLlmSource === 'current' ? 'selected' : ''}>跟随当前 Chat Completion 源</option>
                                    <option value="${chat_completion_sources.CUSTOM}" ${settings.memoryLlmSource === chat_completion_sources.CUSTOM ? 'selected' : ''}>Custom / NewAPI</option>
                                    <option value="${chat_completion_sources.OPENAI}" ${settings.memoryLlmSource === chat_completion_sources.OPENAI ? 'selected' : ''}>OpenAI</option>
                                    <option value="${chat_completion_sources.OPENROUTER}" ${settings.memoryLlmSource === chat_completion_sources.OPENROUTER ? 'selected' : ''}>OpenRouter</option>
                                </select>
                            </label>
                            <label>
                                <span>抽取模型</span>
                                <div class="dco-model-picker">
                                    <select id="dco_memory_llm_model_select" class="text_pole" ${useManualMode ? 'style="display:none"' : ''}>
                                        <option value="">选择模型...</option>
                                        ${modelOptions}
                                    </select>
                                    <input id="dco_memory_llm_model_modal" class="text_pole" type="text" value="${escapeHtml(currentModel)}" placeholder="${escapeHtml(getExtractorModel(settings))}" ${useManualMode ? '' : 'style="display:none"'} />
                                    <button id="dco_memory_llm_fetch_models" class="menu_button" title="刷新模型列表"><i class="fa-solid fa-arrows-rotate"></i></button>
                                    <label class="checkbox_label dco-inline dco-manual-toggle">
                                        <input id="dco_memory_llm_manual_mode" type="checkbox" ${useManualMode ? 'checked' : ''} />
                                        <span>手动</span>
                                    </label>
                                </div>
                            </label>
                            <label>
                                <span>直接 API URL</span>
                                <input id="dco_memory_llm_api_url_modal" class="text_pole" type="text" value="${escapeHtml(settings.memoryLlmApiUrl || '')}" placeholder="https://example.com/v1" />
                            </label>
                            <label>
                                <span>直接 API Key</span>
                                <input id="dco_memory_llm_api_key_modal" class="text_pole" type="password" value="${escapeHtml(settings.memoryLlmApiKey || '')}" placeholder="sk-..." />
                            </label>
                            <label>
                                <span>每次抽取最近轮数</span>
                                <input id="dco_memory_llm_turns_modal" class="text_pole" type="number" min="2" max="80" value="${Number(settings.memoryLlmTurns || defaultSettings.memoryLlmTurns)}" />
                            </label>
                            <label>
                                <span>自动抽取间隔</span>
                                <input id="dco_memory_llm_every_modal" class="text_pole" type="number" min="1" max="50" value="${Number(settings.memoryLlmEveryTurns || defaultSettings.memoryLlmEveryTurns)}" />
                            </label>
                            <label>
                                <span>最大输出 tokens</span>
                                <input id="dco_memory_llm_max_tokens_modal" class="text_pole" type="number" min="200" max="32000" step="100" value="${Number(settings.memoryLlmMaxTokens || defaultSettings.memoryLlmMaxTokens)}" />
                            </label>
                            <label>
                                <span>温度</span>
                                <input id="dco_memory_llm_temp_modal" class="text_pole" type="number" min="0" max="1" step="0.05" value="${Number(settings.memoryLlmTemperature ?? defaultSettings.memoryLlmTemperature)}" />
                            </label>
                        </div>
                        <div class="dco-action-row">
                            <button id="dco_memory_llm_run" class="menu_button">运行记忆抽取</button>
                            <span id="dco_extractor_status" class="dco-muted">${escapeHtml(memoryExtractorStatus)}</span>
                        </div>
                        <div class="dco-muted">最近结果：${lastMemoryExtractorResult ? `${escapeHtml(lastMemoryExtractorResult.at.toLocaleString())}，执行 ${lastMemoryExtractorResult.executed} 条命令` : '暂无'}</div>
                        <div class="dco-muted">直接填写 API Key 会保存在浏览器扩展设置中；多人或公网使用时建议复用 ST 后端密钥。</div>
                    </section>                    <section class="dco-card">
                        <div class="dco-card-title">当前场景</div>
                        <div class="dco-muted" id="dco_table_state_summary">加载中...</div>
                    </section>
                    <section class="dco-card">
                        <div class="dco-card-title">实体</div>
                        <div class="dco-table-wrap">
                            <table class="dco-table">
                                <thead><tr><th>ID</th><th>类型</th><th>名称</th><th>描述</th><th>状态</th><th>重要性</th></tr></thead>
                                <tbody id="dco_entities_rows"><tr><td colspan="6">暂无数据。</td></tr></tbody>
                            </table>
                        </div>
                    </section>
                    <section class="dco-card">
                        <div class="dco-card-title">事实</div>
                        <div class="dco-table-wrap">
                            <table class="dco-table">
                                <thead><tr><th>主体</th><th>属性</th><th>内容</th><th>类别</th><th>生命周期</th><th>重要性</th></tr></thead>
                                <tbody id="dco_facts_rows"><tr><td colspan="6">暂无数据。</td></tr></tbody>
                            </table>
                        </div>
                    </section>
                    <section class="dco-card">
                        <div class="dco-card-title">关系</div>
                        <div class="dco-table-wrap">
                            <table class="dco-table">
                                <thead><tr><th>ID</th><th>角色A</th><th>角色B</th><th>类型</th><th>值</th><th>摘要</th></tr></thead>
                                <tbody id="dco_relationships_rows"><tr><td colspan="6">暂无数据。</td></tr></tbody>
                            </table>
                        </div>
                    </section>
                    <section class="dco-card">
                        <div class="dco-card-title">事件</div>
                        <div class="dco-table-wrap">
                            <table class="dco-table">
                                <thead><tr><th>ID</th><th>摘要</th><th>参与者</th><th>关键词</th><th>轮次</th><th>重要性</th></tr></thead>
                                <tbody id="dco_events_rows"><tr><td colspan="6">暂无数据。</td></tr></tbody>
                            </table>
                        </div>
                    </section>
                    <section class="dco-card">
                        <div class="dco-card-title">整理审计</div>
                        <div class="dco-table-wrap">
                            <table class="dco-table">
                                <thead><tr><th>轮次</th><th>接受</th><th>拒绝</th><th>原因</th><th>时间</th></tr></thead>
                                <tbody id="dco_audit_rows"><tr><td colspan="5">暂无数据。</td></tr></tbody>
                            </table>
                        </div>
                    </section>
                    <section class="dco-card">
                        <div class="dco-card-title">操作</div>
                        <button id="dco_memory_clear" class="menu_button danger_button">清空当前聊天记忆</button>
                    </section>
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

    // Memory tab bindings
    html.find('#dco_memory_enabled_modal').on('input', function () { settings.memoryEnabled = Boolean(this.checked); persist(); });
    html.find('#dco_memory_inject_modal').on('input', function () { settings.memoryInject = Boolean(this.checked); persist(); });
    html.find('#dco_memory_max_chronicle_modal').on('input', function () { settings.memoryMaxChronicle = Number(this.value || defaultSettings.memoryMaxChronicle); persist(); });
    html.find('#dco_memory_max_characters_modal').on('input', function () { settings.memoryMaxCharacters = this.value === '' ? defaultSettings.memoryMaxCharacters : Number(this.value); persist(); });
    html.find('#dco_memory_max_items_modal').on('input', function () { settings.memoryMaxItems = this.value === '' ? defaultSettings.memoryMaxItems : Number(this.value); persist(); });
    html.find('#dco_memory_max_relationships_modal').on('input', function () { settings.memoryMaxRelationships = this.value === '' ? defaultSettings.memoryMaxRelationships : Number(this.value); persist(); });
    html.find('#dco_memory_max_world_lore_modal').on('input', function () { settings.memoryMaxWorldLore = this.value === '' ? defaultSettings.memoryMaxWorldLore : Number(this.value); persist(); });
    html.find('#dco_memory_recent_chronicle_modal').on('input', function () { settings.memoryRecentChronicle = this.value === '' ? defaultSettings.memoryRecentChronicle : Number(this.value); persist(); });
    html.find('#dco_memory_min_importance_modal').on('input', function () { settings.memoryMinImportance = this.value === '' ? defaultSettings.memoryMinImportance : Number(this.value); persist(); });
    html.find('#dco_memory_llm_enabled_modal').on('input', function () { settings.memoryLlmEnabled = Boolean(this.checked); persist(); });
    html.find('#dco_memory_llm_model_modal').on('input', function () { settings.memoryLlmModel = String(this.value || ''); persist(); });
    html.find('#dco_memory_llm_model_select').on('change', function () { settings.memoryLlmModel = String(this.value || ''); persist(); });
    html.find('#dco_memory_llm_manual_mode').on('input', function () {
        const manual = Boolean(this.checked);
        html.find('#dco_memory_llm_model_select').toggle(!manual);
        html.find('#dco_memory_llm_model_modal').toggle(manual);
        if (manual) {
            html.find('#dco_memory_llm_model_modal').trigger('input');
        } else {
            html.find('#dco_memory_llm_model_select').trigger('change');
        }
    });
    html.find('#dco_memory_llm_fetch_models').on('click', async () => {
        openPanel('memory');
    });
    html.find('#dco_memory_llm_provider_modal').on('change', function () {
        settings.memoryLlmProvider = String(this.value || defaultSettings.memoryLlmProvider);
        persist();
        openPanel('memory');
    });
    html.find('#dco_memory_llm_source_modal').on('change', function () {
        settings.memoryLlmSource = String(this.value || defaultSettings.memoryLlmSource);
        persist();
        openPanel('memory');
    });
    html.find('#dco_memory_llm_api_url_modal').on('input', function () { settings.memoryLlmApiUrl = String(this.value || ''); persist(); });
    html.find('#dco_memory_llm_api_key_modal').on('input', function () { settings.memoryLlmApiKey = String(this.value || ''); persist(); });
    html.find('#dco_memory_llm_turns_modal').on('input', function () { settings.memoryLlmTurns = Number(this.value || defaultSettings.memoryLlmTurns); persist(); });
    html.find('#dco_memory_llm_every_modal').on('input', function () { settings.memoryLlmEveryTurns = Number(this.value || defaultSettings.memoryLlmEveryTurns); persist(); });
    html.find('#dco_memory_llm_max_tokens_modal').on('input', function () { settings.memoryLlmMaxTokens = Number(this.value || defaultSettings.memoryLlmMaxTokens); persist(); });
    html.find('#dco_memory_llm_temp_modal').on('input', function () { settings.memoryLlmTemperature = Number(this.value || defaultSettings.memoryLlmTemperature); persist(); });
    html.find('#dco_memory_llm_run').on('click', async () => {
        settings.memoryEnabled = true;
        settings.memoryLlmEnabled = true;
        saveSettingsDebounced();
        await runMemoryLlmExtraction({ manual: true });
    });
    html.find('#dco_memory_llm_run_top').on('click', async () => {
        settings.memoryEnabled = true;
        settings.memoryLlmEnabled = true;
        saveSettingsDebounced();
        await runMemoryLlmExtraction({ manual: true });
        openPanel('memory');
    });
    html.find('#dco_memory_clear_all').on('click', async () => {
        await clearAllTables();
        toastr.info('已清空所有记忆数据');
        openPanel('memory');
    });
    html.find('#dco_memory_clear').on('click', async () => {
        await clearAllTables();
        toastr.info('已清空当前聊天记忆');
        openPanel('memory');
    });

    // Populate table data
    (async () => {
        try {
            const scene = (await getTable('scene_state'))[0];
            const entities = await getTable('entities');
            const facts = await getTable('facts');
            const relationships = await getTable('relationships');
            const events = await getTable('events');
            const audit = await getTable('memory_audit');

            const stateSummary = [];
            if (scene) {
                if (scene.location) stateSummary.push(`位置：${escapeHtml(scene.location)}`);
                if (scene.time) stateSummary.push(`时间：${escapeHtml(scene.time)}`);
                if (scene.currentActivity) stateSummary.push(`活动：${escapeHtml(scene.currentActivity)}`);
                if (scene.mood) stateSummary.push(`氛围：${escapeHtml(scene.mood)}`);
                if (scene.activeEntities) stateSummary.push(`活跃实体：${escapeHtml(scene.activeEntities)}`);
                if (scene.openThreads) stateSummary.push(`待续：${escapeHtml(scene.openThreads)}`);
            }
            html.find('#dco_table_state_summary').text(stateSummary.length ? stateSummary.join(' | ') : '暂无数据。');

            if (entities.length) {
                html.find('#dco_entities_rows').html(entities
                    .sort((a, b) => Number(b.importance || 0) - Number(a.importance || 0))
                    .map(e => `<tr><td>${escapeHtml(e.id || '')}</td><td>${escapeHtml(e.type || '')}</td><td>${escapeHtml(e.canonicalName || '')}</td><td>${escapeHtml(e.description || '')}</td><td>${escapeHtml(e.status || '')}</td><td>${Number(e.importance || 0).toFixed(2)}</td></tr>`).join(''));
            }
            if (facts.length) {
                html.find('#dco_facts_rows').html(facts
                    .sort((a, b) => Number(b.importance || 0) - Number(a.importance || 0))
                    .map(f => `<tr><td>${escapeHtml(f.subjectId || '')}</td><td>${escapeHtml(f.predicate || '')}</td><td>${escapeHtml(f.value || '')}</td><td>${escapeHtml(f.category || '')}</td><td>${escapeHtml(f.permanence || '')}</td><td>${Number(f.importance || 0).toFixed(2)}</td></tr>`).join(''));
            }
            if (relationships.length) {
                html.find('#dco_relationships_rows').html(relationships.map(r => `<tr><td>${escapeHtml(r.id || '')}</td><td>${escapeHtml(r.fromId || '')}</td><td>${escapeHtml(r.toId || '')}</td><td>${escapeHtml(r.type || '')}</td><td>${r.value ?? ''}</td><td>${escapeHtml([r.stableSummary, r.recentChange].filter(Boolean).join(' / '))}</td></tr>`).join(''));
            }
            if (events.length) {
                html.find('#dco_events_rows').html(events
                    .sort((a, b) => Number(b.turnEnd || 0) - Number(a.turnEnd || 0))
                    .map(e => `<tr><td>${escapeHtml(e.id || '')}</td><td>${escapeHtml(e.summary || '')}</td><td>${escapeHtml(e.participants || '')}</td><td>${escapeHtml(e.keywords || '')}</td><td>${escapeHtml(`${e.turnStart || ''}-${e.turnEnd || ''}`)}</td><td>${Number(e.importance || 0).toFixed(2)}</td></tr>`).join(''));
            }
            if (audit.length) {
                html.find('#dco_audit_rows').html(audit
                    .sort((a, b) => Number(b.turn || 0) - Number(a.turn || 0))
                    .slice(0, 20)
                    .map(a => `<tr><td>${a.turn || ''}</td><td>${escapeHtml(a.acceptedOps || '')}</td><td>${escapeHtml(a.rejectedOps || '')}</td><td>${escapeHtml(a.reason || '')}</td><td>${escapeHtml(a.createdAt || '')}</td></tr>`).join(''));
            }
        } catch (e) {
            console.warn('[DeepSeek Cache Optimizer] Failed to load table data for panel', e);
        }
    })();
    html.on('click', '.dco-memory-row', function () {
        $(this).next('.dco-memory-detail').toggle();
    });

    callGenericPopup(html, POPUP_TYPE.DISPLAY, '', { wide: true, large: true, allowVerticalScrolling: true, leftAlign: true });
}

function bindSettings() {
    const settings = getSettings();

    $('#dco_enabled').prop('checked', settings.enabled);
    $('#dco_strategy').val(settings.strategy).closest('label').toggle(settings.enabled);
    $('#dco_protect_rich_format').prop('checked', settings.protectRichFormat).closest('label').toggle(settings.enabled);
    $('#dco_debug').prop('checked', settings.debug);
    $('#dco_memory_enabled').prop('checked', settings.memoryEnabled);
    $('#dco_memory_llm_enabled').prop('checked', settings.memoryLlmEnabled);

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
    $('#dco_debug').on('input', function () {
        settings.debug = Boolean(this.checked);
        saveSettingsDebounced();
    });
    $('#dco_memory_enabled').on('input', function () {
        settings.memoryEnabled = Boolean(this.checked);
        saveSettingsDebounced();
    });
    $('#dco_memory_llm_enabled').on('input', function () {
        settings.memoryLlmEnabled = Boolean(this.checked);
        if (settings.memoryLlmEnabled) {
            settings.memoryEnabled = true;
            $('#dco_memory_enabled').prop('checked', true);
        }
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
                    <div class="dco-sidebar-stat"><span>记忆</span><b>${escapeHtml(memoryExtractorStatus.length > 12 ? memoryExtractorStatus.slice(0, 12) + '...' : memoryExtractorStatus)}</b></div>
                </div>
                <details class="dco-section" open>
                    <summary class="dco-section-title">缓存优化</summary>
                    <label class="checkbox_label dco-inline" for="dco_enabled">
                        <input id="dco_enabled" type="checkbox" />
                        <span>启用 Prompt 消息重排（关闭后仅保留记忆注入）</span>
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
                </details>
                <details class="dco-section">
                    <summary class="dco-section-title">记忆系统</summary>
                    <label class="checkbox_label dco-inline" for="dco_memory_enabled">
                        <input id="dco_memory_enabled" type="checkbox" />
                        <span>启用本地记忆召回</span>
                    </label>
                    <label class="checkbox_label dco-inline" for="dco_memory_llm_enabled">
                        <input id="dco_memory_llm_enabled" type="checkbox" />
                        <span>启用 LLM 记忆抽取</span>
                    </label>
                </details>
                <details class="dco-section">
                    <summary class="dco-section-title">调试</summary>
                    <label class="checkbox_label dco-inline" for="dco_debug">
                        <input id="dco_debug" type="checkbox" />
                        <span>浏览器控制台调试日志</span>
                    </label>
                    <button id="dco_export_prompt" class="menu_button dco-full-btn"><i class="fa-solid fa-file-export"></i> 导出所有快照</button>
                </details>
                <div class="dco-muted">
                    重排只修改本次请求；本地记忆使用浏览器 IndexedDB，不修改已保存的预设、世界书、角色卡或聊天记录。
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
    getSettings();
    renderSettings();
    window.dcoExportPrompt = () => exportPromptSnapshot();
    window.dcoExportAll = () => exportAllSnapshots();
    try {
        previousRawContent = localStorage.getItem('dco_prevRawContent') || '';
        previousRawInput = localStorage.getItem('dco_prevRawInput') || '';
        previousMergedContent = localStorage.getItem('dco_prevMergedContent') || '';
    } catch { /* localStorage unavailable */ }
    // Restore request history from IndexedDB
    try {
        const snapshots = await loadSnapshotsFromDb();
        if (snapshots.length) {
            requestHistory = snapshots.map(snap => ({
                id: snap.id,
                at: snap.at,
                model: snap.model,
                stream: false,
                status: snap.usage ? '已收到 usage' : '来自历史',
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
    eventSource.on(event_types.CHAT_CHANGED, () => {
        lastRecallResults = [];
        previousSerializedPrompt = '';
        previousRawContent = '';
        previousRawInput = '';
        previousMessageSignatures = [];
        previousMergedContent = '';
        previousMergedSignatures = [];
        mergeAwareAvailable = true;
        promptRunCounter = 0;
        try { localStorage.removeItem('dco_prevRawContent'); localStorage.removeItem('dco_prevRawInput'); localStorage.removeItem('dco_prevMergedContent'); } catch { /* localStorage unavailable */ }
    });
    eventSource.on(event_types.MESSAGE_RECEIVED, () => {
        runMemoryLlmExtraction().catch(error => console.warn('[DeepSeek Cache Optimizer] Failed to run memory extraction', error));
    });
    eventSource.on(event_types.CHAT_COMPLETION_SETTINGS_READY, handleGenerationSettings);
    eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, optimizeChatCompletionPrompt);
    eventSource.on(event_types.CHAT_COMPLETION_RESPONSE_USAGE, handleBackendUsage);
}








