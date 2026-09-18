/**
 * store.js —— 本地只存「连接配置 + 偏好 + 只读缓存」
 *
 * ⚠️ 会话历史**不再存本地**：它是 Hermes 服务端 state.db 里那份，
 * 和桌面端 / CLI / dashboard 共用。这里只留一份只读缓存用于秒开与离线查看。
 * localStorage 里因此只有 3 个 key，且不含任何对话内容之外的东西。
 */

import { tryJson } from './util.js';

const NS = 'hermes-lite-webui';
const K = {
  config: `${NS}.config.v1`,
  prefs: `${NS}.prefs.v1`,
  cache: `${NS}.cache.v1`,
};

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const v = JSON.parse(raw);
    return v ?? fallback;
  } catch { return fallback; }
}
function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    // 配额溢出：把缓存丢掉再试一次（缓存可丢，配置不可丢）
    try {
      localStorage.removeItem(K.cache);
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch { return false; }
  }
}

/* ───────────── 连接配置（含密钥） ───────────── */

const DEFAULT_CONFIG = { baseUrl: '', key: '', model: 'hermes-agent' };

export const config = {
  get() { return { ...DEFAULT_CONFIG, ...(read(K.config, {}) || {}) }; },
  set(patch) {
    const next = { ...config.get(), ...patch };
    write(K.config, next);
    return next;
  },
  clear() { localStorage.removeItem(K.config); },
  ok() {
    const c = config.get();
    return Boolean(c.baseUrl && c.key);
  },
};

/** Base URL 归一化：补协议、补 /v1、去尾斜杠 */
export function normalizeBase(u) {
  let s = String(u || '').trim().replace(/\s+/g, '');
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  s = s.replace(/\/+$/, '');
  if (!/\/v1$/i.test(s)) s += '/v1';
  return s;
}

/* ───────────── 偏好 ───────────── */

const DEFAULT_PREFS = { theme: 'auto', showTools: true, clearAfter: true };

export const prefs = {
  get() { return { ...DEFAULT_PREFS, ...(read(K.prefs, {}) || {}) }; },
  set(patch) {
    const next = { ...prefs.get(), ...patch };
    write(K.prefs, next);
    return next;
  },
};

/* ───────────── 只读缓存（丢了不影响正确性） ───────────── */

const LIST_CAP = 100;        // 列表最多缓存多少条会话
const MSG_SESSIONS_CAP = 6;  // 缓存最近打开过的几个会话的消息

export const cache = {
  clear() { localStorage.removeItem(K.cache); },

  setList(list) {
    write(K.cache, { ...(read(K.cache, {}) || {}), list: { at: Date.now(), data: (list || []).slice(0, LIST_CAP) } });
  },
  getList() {
    const c = read(K.cache, {}) || {};
    return Array.isArray(c.list && c.list.data) ? c.list.data : [];
  },

  setMessages(id, data) {
    if (!id) return;
    const c = read(K.cache, {}) || {};
    const msgs = c.msgs || { byId: {}, order: [] };
    msgs.byId[id] = { at: Date.now(), data: (data || []).slice(-400) };
    msgs.order = [id, ...(msgs.order || []).filter((x) => x !== id)].slice(0, MSG_SESSIONS_CAP);
    for (const k of Object.keys(msgs.byId)) {
      if (!msgs.order.includes(k)) delete msgs.byId[k];
    }
    write(K.cache, { ...c, msgs });
  },
  getMessages(id) {
    const c = read(K.cache, {}) || {};
    const hit = c.msgs && c.msgs.byId && c.msgs.byId[id];
    return hit && Array.isArray(hit.data) ? hit.data : null;
  },

  bytes() {
    return (localStorage.getItem(K.cache) || '').length;
  },
};

/* ───────────── 统计（对服务端会话行求和，纯函数） ───────────── */

/**
 * @param {Array} rows GET /api/sessions 的 data
 * 服务端给的是该会话的累计值：message_count / tool_call_count / input_tokens …
 */
export function summarize(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : 0);
  let messages = 0, tools = 0, input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cost = 0;
  for (const s of list) {
    messages += num(s.message_count);
    tools += num(s.tool_call_count);
    input += num(s.input_tokens);
    output += num(s.output_tokens);
    cacheRead += num(s.cache_read_tokens);
    cacheWrite += num(s.cache_write_tokens);
    cost += num(s.actual_cost_usd || s.estimated_cost_usd);
  }
  return { sessions: list.length, messages, tools, input, output, cacheRead, cacheWrite, cost };
}

/* ───────────── 本地数据导入导出 / 清空 ───────────── */

export function storageBytes() {
  let n = 0;
  for (const key of Object.values(K)) n += (localStorage.getItem(key) || '').length;
  return n;
}

export function exportAll({ includeKey = true } = {}) {
  const c = config.get();
  return JSON.stringify({
    app: 'hermes-lite-webui',
    version: 2,
    exportedAt: new Date().toISOString(),
    note: '只含本机的连接配置与偏好；会话历史在 Hermes 服务端 state.db 里。',
    config: { ...c, key: includeKey ? c.key : '' },
    prefs: prefs.get(),
  }, null, 2);
}

export function importAll(text, { keepKey = true } = {}) {
  const d = tryJson(text);
  if (!d || typeof d !== 'object') throw new Error('不是合法的 JSON');
  const out = { config: false, prefs: false };

  if (d.config && typeof d.config === 'object') {
    const cur = config.get();
    config.set({
      baseUrl: d.config.baseUrl || cur.baseUrl,
      key: keepKey ? (d.config.key || cur.key) : cur.key,
      model: d.config.model || cur.model,
    });
    out.config = true;
  }
  if (d.prefs && typeof d.prefs === 'object') { prefs.set(d.prefs); out.prefs = true; }
  if (!out.config && !out.prefs) throw new Error('文件里没有 config / prefs');
  return out;
}

export function wipe() {
  for (const key of Object.values(K)) localStorage.removeItem(key);
}

export const STORAGE_KEYS = K;
