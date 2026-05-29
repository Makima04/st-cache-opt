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
const DB_VERSION = 4;
const MEMORY_INJECTION_MARKER = '<记忆数据库>';

const TABLE_SCHEMAS = {
    global_state: {
        label: '当前状态',
        singleton: true,
        columns: ['location', 'time', 'scene', 'atmosphere'],
    },
    protagonist_info: {
        label: '角色信息',
        singleton: true,
        columns: ['name', 'appearance', 'personality', 'currentState', 'background', 'traits', 'abilities'],
    },
    user_info: {
        label: 'User角色',
        singleton: true,
        columns: ['name', 'appearance', 'personality', 'persona'],
    },
    important_characters: {
        label: '重要角色',
        singleton: false,
        keyColumn: 'name',
        columns: ['name', 'role', 'appearance', 'relationship', 'status', 'traits', 'lastInteraction'],
    },
    chronicle: {
        label: '编年史',
        singleton: false,
        keyColumn: 'amCode',
        columns: ['amCode', 'summary', 'entities', 'keywords', 'turn', 'importance'],
    },
    items: {
        label: '物品',
        singleton: false,
        keyColumn: 'name',
        columns: ['name', 'type', 'owner', 'description', 'location', 'status'],
    },
    relationships: {
        label: '关系',
        singleton: false,
        keyColumn: 'relKey',
        columns: ['relKey', 'fromChar', 'toChar', 'type', 'value', 'notes'],
    },
    world_lore: {
        label: '世界观',
        singleton: false,
        keyColumn: 'key',
        columns: ['key', 'category', 'content'],
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
    prefixChars: 0,
    prefixPercent: 0,
    firstChangedMessage: null,
    firstMessageHash: '',
};

let previousSerializedPrompt = '';
let previousHistoryOnlySerialized = '';
let previousMessageSignatures = [];
let lastBackendUsage = null;
let lastGenerationSettings = null;
let usageHistory = [];
let dbPromise = null;
let lastRecallResults = [];
let lastWorldInfoTerms = [];
let lastPromptAnalysis = [];
let memoryExtractorRunning = false;
let memoryExtractorStatus = '尚未运行';
let lastMemoryExtractorResult = null;
let lastUpdateCheck = null;
let updateRunning = false;

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
            if (db.objectStoreNames.contains('memories')) {
                db.deleteObjectStore('memories');
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

function buildMemoryExtractionPrompt(turns, worldTerms, tableData) {
    const transcript = turns.map(item => {
        const speaker = item.message?.is_user ? name1 || 'User' : name2 || 'Assistant';
        const raw = item.message?.mes || item.message?.message || item.message?.content || '';
        const text = stripExtractionNoise(raw);
        return text ? `#${item.index} ${speaker}: ${text}` : '';
    }).filter(Boolean).join('\n');

    const tableState = buildTableStateSnapshot(tableData);

    return [
        '你是【填表AI】，负责根据聊天片段对记忆数据库执行增删改操作。',
        '',
        '## 表结构',
        '- global_state: location(位置), time(时间), scene(场景), atmosphere(氛围)',
        '- protagonist_info: name(姓名), appearance(外貌描述), personality(性格), currentState(当前状态), background(背景), traits(特征逗号分隔), abilities(能力逗号分隔)',
        '- user_info: name(姓名), appearance(外貌描述), personality(性格), persona(人设描述)',
        '- important_characters: name(姓名), role(角色), appearance(外貌描述), relationship(与主角关系), status(状态), traits(特征逗号分隔), lastInteraction(最近互动摘要)',
        '- chronicle: summary(事件摘要≤50字), entities(相关人物逗号分隔), keywords(关键词逗号分隔), importance(0-1浮点)',
        '- items: name(名称), type(类型如武器/道具/食物), owner(持有者), description(描述), location(所在位置), status(状态如正常/损坏)',
        '- relationships: relKey(关系键如"A→B"), fromChar(角色A), toChar(角色B), type(关系类型), value(亲密度-1到1), notes(备注)',
        '- world_lore: key(关键词), category(类别如规则/地点/组织), content(内容描述)',
        '',
        '## 命令格式',
        '将所有命令写在 <tableEdit> 和 </tableEdit> 之间，每行一条：',
        '<tableEdit>',
        'insertRow("table_name", {"col":"val",...})',
        'updateRow("table_name", "key_value", {"col":"val",...})',
        'deleteRow("table_name", "key_value")',
        '</tableEdit>',
        '',
        '## 规则',
        '1. global_state、protagonist_info、user_info 始终用 updateRow("表名", "singleton", {...})',
        '2. important_characters、items、world_lore 用名称作为键值，新条目用 insertRow，已存在用 updateRow',
        '3. relationships 用 relKey 作为键值（格式："A→B"），新关系用 insertRow，已存在用 updateRow',
        '4. chronicle 只用 insertRow，不需要指定 amCode（自动生成）',
        '5. 外貌描写必须详细（发型、瞳色、体型、服饰、特征等），不能只写一个词',
        '6. summary 必须是简洁的一句话总结（≤50字），不是原文复制',
        '7. 只提取对后续剧情有持久影响的信息',
        '8. important_characters 必须包含 User 角色（扮演的用户身份，不是 AI 助手）',
        '',
        '## 示例输出',
        '<tableEdit>',
        'updateRow("global_state", "singleton", {"location":"酒馆二楼","time":"深夜","scene":"密谈","atmosphere":"紧张"})',
        'updateRow("protagonist_info", "singleton", {"appearance":"银发及腰，紫瞳，身材纤细，穿白色长裙","traits":"冷静,机智","abilities":"魔法感知"})',
        'insertRow("important_characters", {"name":"艾莉丝","role":"盟友","appearance":"金色短发，碧绿眼眸，精灵耳，穿皮革轻甲","relationship":"信任的伙伴","status":"在场","traits":"勇敢,忠诚"})',
        'insertRow("items", {"name":"月光匕首","type":"武器","owner":"主角","description":"散发淡蓝光芒的精灵匕首","location":"腰间","status":"正常"})',
        'insertRow("relationships", {"relKey":"主角→艾莉丝","fromChar":"主角","toChar":"艾莉丝","type":"盟友","value":0.8,"notes":"共同经历了多次冒险"})',
        'insertRow("world_lore", {"key":"空庭","category":"地点","content":"一个被魔法封锁的异空间，有严格的规则体系"})',
        'insertRow("chronicle", {"summary":"主角与艾莉丝达成秘密协议","entities":"主角,艾莉丝","keywords":"协议,密谋","importance":0.8})',
        '</tableEdit>',
        '',
        `当前角色：${name2 || '未知'}；用户：${name1 || '未知'}。`,
        `世界书关键词：${worldTerms.slice(0, 40).join(', ') || '无'}`,
        '',
        '## 当前数据库状态',
        tableState || '（空）',
        '',
        '--- 聊天片段 ---',
        transcript,
        '--- 片段结束 ---',
    ].join('\n');
}

function buildTableStateSnapshot(tableData) {
    if (!tableData) return '';
    const lines = [];
    const state = tableData.state?.[0];
    if (state) {
        const parts = [];
        if (state.location) parts.push(`位置：${state.location}`);
        if (state.time) parts.push(`时间：${state.time}`);
        if (state.scene) parts.push(`场景：${state.scene}`);
        if (state.atmosphere) parts.push(`氛围：${state.atmosphere}`);
        if (parts.length) lines.push(`[global_state] ${parts.join(' | ')}`);
    }
    const protag = tableData.protagonist?.[0];
    if (protag) {
        const parts = [];
        if (protag.name) parts.push(`姓名：${protag.name}`);
        if (protag.appearance) parts.push(`外貌：${protag.appearance}`);
        if (protag.currentState) parts.push(`状态：${protag.currentState}`);
        if (protag.personality) parts.push(`性格：${protag.personality}`);
        if (protag.background) parts.push(`背景：${protag.background}`);
        if (protag.traits) parts.push(`特征：${protag.traits}`);
        if (parts.length) lines.push(`[protagonist_info] ${parts.join(' | ')}`);
    }
    const userInfo = tableData.userInfo?.[0];
    if (userInfo) {
        const parts = [];
        if (userInfo.name) parts.push(`姓名：${userInfo.name}`);
        if (userInfo.appearance) parts.push(`外貌：${userInfo.appearance}`);
        if (userInfo.persona) parts.push(`人设：${userInfo.persona.slice(0, 100)}`);
        if (parts.length) lines.push(`[user_info] ${parts.join(' | ')}`);
    }
    if (tableData.characters?.length) {
        for (const c of tableData.characters) {
            const parts = [c.name];
            if (c.role) parts.push(c.role);
            if (c.relationship) parts.push(c.relationship);
            if (c.status) parts.push(c.status);
            if (c.traits) parts.push(`特征:${c.traits}`);
            lines.push(`[character] ${parts.join(' / ')}`);
        }
    }
    if (tableData.items?.length) {
        for (const item of tableData.items) {
            const parts = [item.name];
            if (item.type) parts.push(item.type);
            if (item.owner) parts.push(`持有:${item.owner}`);
            if (item.status) parts.push(item.status);
            lines.push(`[item] ${parts.join(' / ')}`);
        }
    }
    if (tableData.relationships?.length) {
        for (const r of tableData.relationships) {
            lines.push(`[relationship] ${r.relKey}: ${r.type}(${r.value}) ${r.notes || ''}`);
        }
    }
    if (tableData.worldLore?.length) {
        for (const w of tableData.worldLore) {
            lines.push(`[world_lore] ${w.key}(${w.category}): ${(w.content || '').slice(0, 60)}`);
        }
    }
    if (tableData.chronicle?.length) {
        for (const entry of tableData.chronicle.slice(-10)) {
            lines.push(`[${entry.amCode}] ${entry.summary}`);
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

async function executeTableCommands(commands) {
    let executed = 0;
    const chronicleRows = await getTable('chronicle');
    let nextAmCode = chronicleRows.reduce((max, r) => {
        const num = parseInt(String(r.amCode || '').replace('AM', ''), 10);
        return isNaN(num) ? max : Math.max(max, num);
    }, 0) + 1;

    for (const cmd of commands) {
        try {
            const schema = TABLE_SCHEMAS[cmd.table];
            if (!schema) continue;

            if (cmd.action === 'insertRow') {
                if (cmd.table === 'chronicle') {
                    cmd.data.amCode = `AM${String(nextAmCode++).padStart(4, '0')}`;
                    cmd.data.turn = chat.length;
                }
                await putRow(cmd.table, cmd.data);
                executed++;
            } else if (cmd.action === 'updateRow') {
                if (schema.singleton) {
                    cmd.data._key = 'singleton';
                    await putRow(cmd.table, cmd.data);
                } else {
                    const existing = await getTable(cmd.table);
                    const keyCol = schema.keyColumn;
                    const target = existing.find(r => r[keyCol] === cmd.keyValue);
                    if (target) {
                        Object.assign(target, cmd.data);
                        await putRow(cmd.table, target);
                    } else {
                        // Key not found, treat as insert
                        if (keyCol) cmd.data[keyCol] = cmd.keyValue;
                        await putRow(cmd.table, cmd.data);
                    }
                }
                executed++;
            } else if (cmd.action === 'deleteRow') {
                await deleteRow(cmd.table, cmd.keyValue);
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

async function callMemoryExtractorViaSt(prompt, settings) {
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
        messages: [
            { role: 'system', content: '你是一个助手，负责听从用户的指令完成你的工作。' },
            { role: 'user', content: prompt },
        ],
        model: getExtractorModel(settings),
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

async function callMemoryExtractorDirect(prompt, settings) {
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
            messages: [
                { role: 'system', content: '你是一个助手，负责听从用户的指令完成你的工作。' },
                { role: 'user', content: prompt },
            ],
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
            state: await getTable('global_state'),
            protagonist: await getTable('protagonist_info'),
            userInfo: await getTable('user_info'),
            characters: await getTable('important_characters'),
            chronicle: await getTable('chronicle'),
            items: await getTable('items'),
            relationships: await getTable('relationships'),
            worldLore: await getTable('world_lore'),
        };
        const prompt = buildMemoryExtractionPrompt(turns, worldTerms, tableData);
        const result = settings.memoryLlmProvider === 'direct'
            ? await callMemoryExtractorDirect(prompt, settings)
            : await callMemoryExtractorViaSt(prompt, settings);

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

    const state = (await getTable('global_state'))[0] || null;
    const protagonist = (await getTable('protagonist_info'))[0] || null;
    const allCharacters = await getTable('important_characters');
    const allChronicle = await getTable('chronicle');
    const allItems = await getTable('items');
    const allRelationships = await getTable('relationships');
    const allWorldLore = await getTable('world_lore');

    // Auto-inject User persona if user_info table is empty
    let userInfo = (await getTable('user_info'))[0] || null;
    if (!userInfo && power_user.persona_description) {
        userInfo = {
            _key: 'singleton',
            name: name1 || 'User',
            persona: power_user.persona_description,
        };
        await putRow('user_info', userInfo);
    }

    // Always inject all data (stable content for cache prefix)
    const maxChronicle = Number(settings.memoryMaxChronicle || defaultSettings.memoryMaxChronicle);
    const relevantChronicle = [...allChronicle]
        .sort((a, b) => Number(b.importance || 0) - Number(a.importance || 0))
        .slice(0, maxChronicle);

    lastRecallResults = relevantChronicle;
    return { state, protagonist, userInfo, activeCharacters: allCharacters, relevantChronicle, items: allItems, relationships: allRelationships, worldLore: allWorldLore };
}

function buildStructuredInjection(memory) {
    if (!memory) return '';
    const lines = [MEMORY_INJECTION_MARKER];

    if (memory.state) {
        lines.push('[当前状态]');
        const parts = [];
        if (memory.state.location) parts.push(`位置：${memory.state.location}`);
        if (memory.state.time) parts.push(`时间：${memory.state.time}`);
        if (memory.state.scene) parts.push(`场景：${memory.state.scene}`);
        if (memory.state.atmosphere) parts.push(`氛围：${memory.state.atmosphere}`);
        lines.push(parts.join(' | '));
    }

    if (memory.protagonist) {
        lines.push('[角色信息]');
        const p = memory.protagonist;
        const parts = [];
        if (p.name) parts.push(`${p.name}`);
        if (p.appearance) parts.push(`外貌：${p.appearance}`);
        if (p.currentState) parts.push(`状态：${p.currentState}`);
        if (p.personality) parts.push(`性格：${p.personality}`);
        if (p.background) parts.push(`背景：${p.background}`);
        if (p.traits) parts.push(`特征：${p.traits}`);
        if (p.abilities) parts.push(`能力：${p.abilities}`);
        lines.push(parts.join(' | '));
    }

    if (memory.userInfo) {
        lines.push('[User角色]');
        const u = memory.userInfo;
        const parts = [];
        if (u.name) parts.push(`${u.name}`);
        if (u.appearance) parts.push(`外貌：${u.appearance}`);
        if (u.personality) parts.push(`性格：${u.personality}`);
        if (u.persona) parts.push(`人设：${u.persona}`);
        lines.push(parts.join(' | '));
    }

    if (memory.activeCharacters?.length) {
        lines.push('[活跃角色]');
        for (const c of memory.activeCharacters) {
            const parts = [c.name];
            if (c.relationship) parts.push(c.relationship);
            if (c.status) parts.push(c.status);
            if (c.appearance) parts.push(c.appearance);
            if (c.traits) parts.push(`特征:${c.traits}`);
            lines.push(`- ${parts.join(' / ')}`);
        }
    }

    if (memory.items?.length) {
        lines.push('[物品]');
        for (const item of memory.items) {
            const parts = [item.name];
            if (item.type) parts.push(item.type);
            if (item.owner) parts.push(`持有:${item.owner}`);
            if (item.status) parts.push(item.status);
            lines.push(`- ${parts.join(' / ')}`);
        }
    }

    if (memory.relationships?.length) {
        lines.push('[关系]');
        for (const r of memory.relationships) {
            lines.push(`- ${r.relKey}: ${r.type}(${r.value})${r.notes ? ' ' + r.notes : ''}`);
        }
    }

    if (memory.worldLore?.length) {
        lines.push('[世界观]');
        for (const w of memory.worldLore) {
            lines.push(`- ${w.key}(${w.category}): ${w.content}`);
        }
    }

    if (memory.relevantChronicle?.length) {
        lines.push('[相关记忆]');
        for (const entry of memory.relevantChronicle) {
            lines.push(`${entry.amCode}: ${entry.summary}`);
        }
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

function getUsageSummaryText(record = lastBackendUsage) {
    if (!record?.usage) {
        return getBackendUsageText();
    }

    const metrics = getUsageMetrics(record.usage);
    return [
        `来源：${record.source || '未知'} / ${record.model || '未知模型'} / ${record.stream ? '流式' : '非流式'}`,
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

function handleBackendUsage(eventData) {
    if (!eventData?.usage) {
        return;
    }

    lastBackendUsage = {
        ...eventData,
        at: new Date(),
    };
    usageHistory.unshift({
        ...lastBackendUsage,
        stats: structuredClone(lastStats),
    });
    usageHistory = usageHistory.slice(0, 20);

    updateStats();
}

function handleGenerationSettings(generateData) {
    lastGenerationSettings = {
        at: new Date(),
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

    if (/world info|lore|相关信息|世界书|data bank|relevant information|related information/i.test(normalized)) {
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

function reorderWithAnalyzer(messages, settings) {
    const analysis = messages.map((message, index) => classifyPromptMessage(message, index, messages));
    const boundary = getAnalyzerBoundary(analysis);
    const prefix = messages.slice(0, boundary);
    const suffix = messages.slice(boundary);
    const prefixAnalysis = analysis.slice(0, boundary);
    const movable = [];
    const fixed = [];

    prefixAnalysis.forEach(item => {
        if (shouldAnalyzerMove(item, settings)) {
            movable.push(item);
        } else {
            fixed.push(item);
        }
    });

    if (movable.length < Number(settings.minPrefixMessages || defaultSettings.minPrefixMessages)) {
        return { changed: false, messages, moved: 0, protected: analysis.filter(item => item.category === 'rich_format').length, analysis };
    }

    const orderedMovable = movable
        .slice()
        .sort((a, b) => a.order - b.order || a.index - b.index)
        .map(item => ({ item, message: messages[item.index] }));
    const nextPrefix = [];
    let movableCursor = 0;

    for (let index = 0; index < prefix.length; index++) {
        const fixedItem = fixed.find(item => item.index === index);
        if (fixedItem) {
            nextPrefix.push(messages[fixedItem.index]);
        } else {
            nextPrefix.push(orderedMovable[movableCursor++].message);
        }
    }

    const reordered = [...nextPrefix, ...suffix];
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

    if (!settings.enabled) {
        lastStats = { moved: 0, total: 0, skipped: '已禁用', protected: 0, prefixChars: 0, prefixPercent: 0, firstChangedMessage: null, firstMessageHash: '' };
        updateStats();
        return;
    }

    if (!Array.isArray(eventData?.chat)) {
        lastStats = { moved: 0, total: 0, skipped: '没有聊天请求数据', protected: 0, prefixChars: 0, prefixPercent: 0, firstChangedMessage: null, firstMessageHash: '' };
        updateStats();
        return;
    }

    // Serialize history-only (before memory injection) for comparison
    const historyOnlySerialized = eventData.chat.map(serializeMessage).join('\n');

    const memoryInjection = buildStructuredInjection(await recallStructuredMemory(eventData.chat));
    if (memoryInjection) {
        eventData.chat.push({
            role: 'system',
            content: memoryInjection,
            name: 'local_memory_recall',
        });
    }

    const result = reorderWithAnalyzer(eventData.chat, settings);
    if (result.changed) {
        eventData.chat.splice(0, eventData.chat.length, ...result.messages);
    }
    const totalMoved = result.moved;
    const totalProtected = result.protected;
    lastPromptAnalysis = result.analysis || eventData.chat.map((message, index) => classifyPromptMessage(message, index, eventData.chat));

    const serializedPrompt = eventData.chat.map(serializeMessage).join('\n');
    const messageSignatures = getMessageSignatures(eventData.chat);

    // Total prefix (with memory injection)
    const prefixChars = previousSerializedPrompt
        ? getCommonPrefixLength(previousSerializedPrompt, serializedPrompt)
        : 0;
    const prefixPercent = previousSerializedPrompt
        ? Math.round((prefixChars / Math.max(serializedPrompt.length, 1)) * 10000) / 100
        : 0;

    // History-only prefix (without memory injection)
    const historyPrefixChars = previousHistoryOnlySerialized
        ? getCommonPrefixLength(previousHistoryOnlySerialized, historyOnlySerialized)
        : 0;
    const historyPrefixPercent = previousHistoryOnlySerialized
        ? Math.round((historyPrefixChars / Math.max(historyOnlySerialized.length, 1)) * 10000) / 100
        : 0;

    // Memory impact: positive means memory breaks cache, negative means memory helps
    const memoryImpact = previousHistoryOnlySerialized && previousSerializedPrompt
        ? Math.round((historyPrefixPercent - prefixPercent) * 100) / 100
        : 0;

    const firstChangedMessage = previousMessageSignatures.length
        ? getFirstChangedMessage(messageSignatures, previousMessageSignatures)
        : null;

    lastStats = {
        moved: totalMoved,
        total: eventData.chat.length,
        skipped: result.changed ? '' : '无需重排',
        protected: totalProtected,
        prefixChars,
        prefixPercent,
        historyPrefixChars,
        historyPrefixPercent,
        memoryImpact,
        firstChangedMessage,
        firstMessageHash: messageSignatures[0]?.hash ?? '',
        firstMessageLength: messageSignatures[0]?.length ?? 0,
        messageSignatures,
        promptAnalysis: lastPromptAnalysis,
        dynamicMoved: lastPromptAnalysis.filter(item => item.category === 'dynamic_state' && item.moved).length,
    };

    previousSerializedPrompt = serializedPrompt;
    previousHistoryOnlySerialized = historyOnlySerialized;
    previousMessageSignatures = messageSignatures;
    // Persist for cross-reload comparison
    try {
        localStorage.setItem('dco_prevSerialized', serializedPrompt);
        localStorage.setItem('dco_prevHistorySerialized', historyOnlySerialized);
    } catch { /* quota exceeded or unavailable */ }
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
        `总前缀（含记忆）：${lastStats.prefixChars || 0} 字符（${lastStats.prefixPercent || 0}%）`,
        `历史前缀（无记忆）：${lastStats.historyPrefixChars || 0} 字符（${lastStats.historyPrefixPercent || 0}%）`,
        `记忆破坏量：${lastStats.memoryImpact || 0}%`,
        `第一条发生变化的消息：${firstChanged}`,
        `第一条消息：长度=${lastStats.firstMessageLength || 0}，hash=${lastStats.firstMessageHash || 'n/a'}`,
        `动态块后移：${lastStats.dynamicMoved || 0} 条`,
        `本地记忆：本轮召回 ${lastRecallResults.length} 条`,
        `记忆抽取：${memoryExtractorStatus}`,
        `扩展更新：${getUpdateStatusText()}`,
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
}

function getTokenEstimateText() {
    return [
        'Token 说明：',
        '当前面板里的长度/共同前缀使用的是请求 JSON 字符数和消息文本长度，不等于模型真实 token。',
        'SillyTavern 的本地 token 估算依赖 tokenizer；如果 DeepSeek tokenizer 下载失败，会回退到 llama3 tokenizer，和后端统计会明显对不上。',
        '后端返回的 usage 才是计费与缓存命中的权威数据。',
        'NewAPI 的 OpenAI 兼容返回通常把缓存命中放在 usage.prompt_tokens_details.cached_tokens；有些中转会使用 prompt_cache_hit_tokens / prompt_cache_miss_tokens。',
        '若使用流式输出，上游必须支持并返回最后一个 usage chunk；本地已为 Custom 和 DeepSeek 源发送 stream_options.include_usage=true。',
        '如果面板仍显示"暂无后端 usage"，先临时关闭流式输出测一次；非流式有 usage 而流式没有，问题就在 NewAPI/上游的流式 usage 转发。',
    ].join('\n');
}

function getHistoryRows() {
    return usageHistory.map((record, index) => {
        const metrics = getUsageMetrics(record.usage);
        const stats = record.stats || {};
        return `
            <tr>
                <td>#${usageHistory.length - index}</td>
                <td>${escapeHtml(record.at?.toLocaleTimeString?.() || '')}</td>
                <td>${escapeHtml(record.model || '')}</td>
                <td>${record.stream ? '流式' : '非流式'}</td>
                <td>${formatNumber(metrics.promptTokens)}</td>
                <td>${formatNumber(metrics.cachedTokens)}</td>
                <td>${formatNumber(metrics.missTokens)}</td>
                <td>${metrics.hitPercent}%</td>
                <td>${stats.prefixPercent ?? 0}%</td>
                <td>${stats.historyPrefixPercent ?? 0}%</td>
                <td>${stats.memoryImpact ?? 0}%</td>
                <td>${stats.firstChangedMessage ?? '无'}</td>
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

function formatCommit(value) {
    return value ? String(value).slice(0, 7) : '未知';
}

async function checkSelfUpdate({ quiet = false } = {}) {
    try {
        const data = await callExtensionUpdateApi('version');
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
        const data = await callExtensionUpdateApi('update');
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
    const remote = lastUpdateCheck.remoteUrl ? `；来源：${lastUpdateCheck.remoteUrl}` : '';
    const state = lastUpdateCheck.isUpToDate === false ? '有可用更新' : '已是最新';
    return `${state}；${branch}-${commit}；检查时间：${time}${remote}`;
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
    const extractorModels = await fetchExtractorModels(settings);
    const currentModel = String(settings.memoryLlmModel || '').trim();
    const useManualMode = currentModel && !extractorModels.includes(currentModel);
    const modelOptions = extractorModels.map(m => `<option value="${escapeHtml(m)}" ${m === currentModel ? 'selected' : ''}>${escapeHtml(m)}</option>`).join('');

    const html = $(`
        <div class="dco-panel">
            <div class="dco-panel-header">
                <h2>DeepSeek Cache Optimizer</h2>
                <span class="dco-version">v0.5</span>
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
                                <span>启用请求级 Prompt 重排</span>
                            </label>
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
                        </section>
                        <section class="dco-card">
                            <div class="dco-card-title">请求概览</div>
                            <div class="dco-metric-grid">
                                <div class="dco-metric"><span>消息数</span><b>${stats.total || 0}</b></div>
                                <div class="dco-metric"><span>移动</span><b>${stats.moved || 0}</b></div>
                                <div class="dco-metric warn"><span>动态后移</span><b>${stats.dynamicMoved || 0}</b></div>
                                <div class="dco-metric"><span>保护</span><b>${stats.protected || 0}</b></div>
                                <div class="dco-metric"><span>共同前缀</span><b>${stats.prefixPercent || 0}%</b></div>
                                <div class="dco-metric success"><span>历史前缀</span><b>${stats.historyPrefixPercent || 0}%</b></div>
                                <div class="dco-metric${stats.memoryImpact > 5 ? ' warn' : ''}"><span>记忆破坏</span><b>${stats.memoryImpact || 0}%</b></div>
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
                    <div class="dco-metric-grid dco-wide-metrics">
                        <div class="dco-metric warn"><span>总前缀（含记忆）</span><b>${stats.prefixPercent || 0}%</b></div>
                        <div class="dco-metric success"><span>历史前缀（无记忆）</span><b>${stats.historyPrefixPercent || 0}%</b></div>
                        <div class="dco-metric${stats.memoryImpact > 5 ? ' warn' : ' success'}"><span>记忆破坏量</span><b>${stats.memoryImpact || 0}%</b></div>
                        <div class="dco-metric"><span>共同字符</span><b>${stats.prefixChars || 0}</b></div>
                    </div>
                    <div class="dco-metric-grid dco-wide-metrics">
                        <div class="dco-metric"><span>历史共同字符</span><b>${stats.historyPrefixChars || 0}</b></div>
                        <div class="dco-metric"><span>第一处变化</span><b>${stats.firstChangedMessage ?? '无'}</b></div>
                        <div class="dco-metric"><span>消息数</span><b>${stats.total || 0}</b></div>
                    </div>
                    <div class="dco-metric-grid dco-wide-metrics">
                        <div class="dco-metric accent"><span>后端 Prompt tokens</span><b>${formatNumber(usageMetrics.promptTokens)}</b></div>
                        <div class="dco-metric success"><span>后端缓存命中</span><b>${formatNumber(usageMetrics.cachedTokens)}</b></div>
                        <div class="dco-metric warn"><span>后端未命中</span><b>${formatNumber(usageMetrics.missTokens)}</b></div>
                        <div class="dco-metric"><span>后端命中率</span><b>${usageMetrics.hitPercent || 0}%</b></div>
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
                        <div class="dco-card-title">最近请求历史</div>
                        <div class="dco-table-wrap dco-history-wrap">
                            <table class="dco-table">
                                <thead>
                                    <tr>
                                        <th>轮次</th><th>时间</th><th>模型</th><th>模式</th><th>Prompt</th>
                                        <th>命中</th><th>未命中</th><th>后端命中率</th><th>总前缀</th><th>历史前缀</th><th>记忆破坏</th><th>首变</th>
                                    </tr>
                                </thead>
                                <tbody>${historyRows || '<tr><td colspan="12">暂无历史。生成一次并收到后端 usage 后会记录在这里。</td></tr>'}</tbody>
                            </table>
                        </div>
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
                    <div class="dco-action-row">
                        <button id="dco_memory_clear_all" class="menu_button danger_button">清空所有数据</button>
                        <span class="dco-muted">世界书索引词 ${lastWorldInfoTerms.length} 个</span>
                    </div>
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
                                <span>最大编年史召回条数</span>
                                <input id="dco_memory_max_chronicle_modal" class="text_pole" type="number" min="1" max="50" value="${Number(settings.memoryMaxChronicle || defaultSettings.memoryMaxChronicle)}" />
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
                    </section>
                    <section class="dco-card">
                        <div class="dco-card-title">当前状态 & 角色信息</div>
                        <div class="dco-muted" id="dco_table_state_summary">加载中...</div>
                    </section>
                    <section class="dco-card">
                        <div class="dco-card-title">活跃角色</div>
                        <div class="dco-table-wrap">
                            <table class="dco-table">
                                <thead><tr><th>姓名</th><th>角色</th><th>外貌</th><th>关系</th><th>状态</th><th>特征</th></tr></thead>
                                <tbody id="dco_characters_rows"><tr><td colspan="6">暂无数据。</td></tr></tbody>
                            </table>
                        </div>
                    </section>
                    <section class="dco-card">
                        <div class="dco-card-title">编年史</div>
                        <div class="dco-table-wrap">
                            <table class="dco-table">
                                <thead><tr><th>编号</th><th>事件摘要</th><th>相关人物</th><th>关键词</th><th>轮次</th><th>重要性</th></tr></thead>
                                <tbody id="dco_chronicle_rows"><tr><td colspan="6">暂无数据。</td></tr></tbody>
                            </table>
                        </div>
                    </section>
                    <section class="dco-card">
                        <div class="dco-card-title">物品</div>
                        <div class="dco-table-wrap">
                            <table class="dco-table">
                                <thead><tr><th>名称</th><th>类型</th><th>持有者</th><th>描述</th><th>位置</th><th>状态</th></tr></thead>
                                <tbody id="dco_items_rows"><tr><td colspan="6">暂无数据。</td></tr></tbody>
                            </table>
                        </div>
                    </section>
                    <section class="dco-card">
                        <div class="dco-card-title">关系</div>
                        <div class="dco-table-wrap">
                            <table class="dco-table">
                                <thead><tr><th>关系键</th><th>角色A</th><th>角色B</th><th>类型</th><th>亲密度</th><th>备注</th></tr></thead>
                                <tbody id="dco_relationships_rows"><tr><td colspan="6">暂无数据。</td></tr></tbody>
                            </table>
                        </div>
                    </section>
                    <section class="dco-card">
                        <div class="dco-card-title">世界观</div>
                        <div class="dco-table-wrap">
                            <table class="dco-table">
                                <thead><tr><th>关键词</th><th>类别</th><th>内容</th></tr></thead>
                                <tbody id="dco_world_lore_rows"><tr><td colspan="3">暂无数据。</td></tr></tbody>
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

    // Optimizer tab bindings
    html.find('#dco_modal_enabled').on('input', function () { settings.enabled = Boolean(this.checked); persist(); });
    html.find('#dco_modal_protect').on('input', function () { settings.protectRichFormat = Boolean(this.checked); persist(); });
    html.find('#dco_modal_strategy').on('change', function () { settings.strategy = String(this.value || defaultSettings.strategy); persist(); });

    // Memory tab bindings
    html.find('#dco_memory_enabled_modal').on('input', function () { settings.memoryEnabled = Boolean(this.checked); persist(); });
    html.find('#dco_memory_inject_modal').on('input', function () { settings.memoryInject = Boolean(this.checked); persist(); });
    html.find('#dco_memory_max_chronicle_modal').on('input', function () { settings.memoryMaxChronicle = Number(this.value || defaultSettings.memoryMaxChronicle); persist(); });
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
            const state = (await getTable('global_state'))[0];
            const protagonist = (await getTable('protagonist_info'))[0];
            const userInfo = (await getTable('user_info'))[0];
            const characters = await getTable('important_characters');
            const chronicle = await getTable('chronicle');
            const items = await getTable('items');
            const relationships = await getTable('relationships');
            const worldLore = await getTable('world_lore');

            const stateSummary = [];
            if (state) {
                if (state.location) stateSummary.push(`位置：${escapeHtml(state.location)}`);
                if (state.time) stateSummary.push(`时间：${escapeHtml(state.time)}`);
                if (state.scene) stateSummary.push(`场景：${escapeHtml(state.scene)}`);
                if (state.atmosphere) stateSummary.push(`氛围：${escapeHtml(state.atmosphere)}`);
            }
            if (protagonist) {
                if (protagonist.name) stateSummary.push(`角色：${escapeHtml(protagonist.name)}`);
                if (protagonist.appearance) stateSummary.push(`外貌：${escapeHtml(protagonist.appearance)}`);
                if (protagonist.currentState) stateSummary.push(`状态：${escapeHtml(protagonist.currentState)}`);
                if (protagonist.traits) stateSummary.push(`特征：${escapeHtml(protagonist.traits)}`);
            }
            if (userInfo) {
                if (userInfo.name) stateSummary.push(`User：${escapeHtml(userInfo.name)}`);
                if (userInfo.persona) stateSummary.push(`人设：${escapeHtml(userInfo.persona.slice(0, 80))}`);
            }
            html.find('#dco_table_state_summary').text(stateSummary.length ? stateSummary.join(' | ') : '暂无数据。');

            if (characters.length) {
                html.find('#dco_characters_rows').html(characters.map(c => `<tr><td>${escapeHtml(c.name || '')}</td><td>${escapeHtml(c.role || '')}</td><td>${escapeHtml(c.appearance || '')}</td><td>${escapeHtml(c.relationship || '')}</td><td>${escapeHtml(c.status || '')}</td><td>${escapeHtml(c.traits || '')}</td></tr>`).join(''));
            }
            if (chronicle.length) {
                html.find('#dco_chronicle_rows').html(chronicle.map(e => `<tr><td>${escapeHtml(e.amCode || '')}</td><td>${escapeHtml(e.summary || '')}</td><td>${escapeHtml(e.entities || '')}</td><td>${escapeHtml(e.keywords || '')}</td><td>${e.turn || ''}</td><td>${Number(e.importance || 0).toFixed(2)}</td></tr>`).join(''));
            }
            if (items.length) {
                html.find('#dco_items_rows').html(items.map(i => `<tr><td>${escapeHtml(i.name || '')}</td><td>${escapeHtml(i.type || '')}</td><td>${escapeHtml(i.owner || '')}</td><td>${escapeHtml(i.description || '')}</td><td>${escapeHtml(i.location || '')}</td><td>${escapeHtml(i.status || '')}</td></tr>`).join(''));
            }
            if (relationships.length) {
                html.find('#dco_relationships_rows').html(relationships.map(r => `<tr><td>${escapeHtml(r.relKey || '')}</td><td>${escapeHtml(r.fromChar || '')}</td><td>${escapeHtml(r.toChar || '')}</td><td>${escapeHtml(r.type || '')}</td><td>${r.value ?? ''}</td><td>${escapeHtml(r.notes || '')}</td></tr>`).join(''));
            }
            if (worldLore.length) {
                html.find('#dco_world_lore_rows').html(worldLore.map(w => `<tr><td>${escapeHtml(w.key || '')}</td><td>${escapeHtml(w.category || '')}</td><td>${escapeHtml(w.content || '')}</td></tr>`).join(''));
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
    $('#dco_strategy').val(settings.strategy);
    $('#dco_protect_rich_format').prop('checked', settings.protectRichFormat);
    $('#dco_debug').prop('checked', settings.debug);
    $('#dco_memory_enabled').prop('checked', settings.memoryEnabled);
    $('#dco_memory_llm_enabled').prop('checked', settings.memoryLlmEnabled);

    $('#dco_enabled').on('input', function () {
        settings.enabled = Boolean(this.checked);
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
                <details class="dco-section" open>
                    <summary class="dco-section-title">缓存优化</summary>
                    <label class="checkbox_label dco-inline" for="dco_enabled">
                        <input id="dco_enabled" type="checkbox" />
                        <span>启用请求级 Prompt 重排</span>
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
    bindSettings();
}

export function init() {
    getSettings();
    renderSettings();
    // Restore prefix tracking from localStorage (survives page reload)
    try {
        previousSerializedPrompt = localStorage.getItem('dco_prevSerialized') || '';
        previousHistoryOnlySerialized = localStorage.getItem('dco_prevHistorySerialized') || '';
    } catch { /* localStorage unavailable */ }
    eventSource.on(event_types.CHAT_CHANGED, () => {
        lastRecallResults = [];
        previousSerializedPrompt = '';
        previousHistoryOnlySerialized = '';
        try { localStorage.removeItem('dco_prevSerialized'); localStorage.removeItem('dco_prevHistorySerialized'); } catch { /* localStorage unavailable */ }
    });
    eventSource.on(event_types.MESSAGE_RECEIVED, () => {
        runMemoryLlmExtraction().catch(error => console.warn('[DeepSeek Cache Optimizer] Failed to run memory extraction', error));
    });
    eventSource.on(event_types.CHAT_COMPLETION_SETTINGS_READY, handleGenerationSettings);
    eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, optimizeChatCompletionPrompt);
    eventSource.on(event_types.CHAT_COMPLETION_RESPONSE_USAGE, handleBackendUsage);
}
