/**
 * notify.js —— 把 Hermes 的动静推到你手机的通知栏（ntfy）
 *
 * 为什么是 ntfy：
 *  - Hermes **自带 ntfy 平台适配器**（`plugins/platforms/ntfy/adapter.py`），
 *    所以同一条通道服务端也能用（`hermes send --to ntfy`、cron `deliver: ntfy`）——
 *    页面关着也能收到。纯浏览器推送（Web Push/VAPID）做不到这点：静态站没有服务端，
 *    而浏览器推送必须有个持有订阅的发送方。
 *  - ntfy 的发布接口就是"POST 一个 URL"，实测它的预检回
 *    `Access-Control-Allow-Origin: *` + `Access-Control-Allow-Headers: *` + 方法含 POST
 *    → **纯静态页面可以直发**，本站不经手，topic 与 token 只在这个浏览器里。
 *  - 服务端可自托管（ntfy 是开源的，App 支持 Android/iOS）：把 server 换成自己的地址即可。
 *
 * 收不到的情形要说清：页面关掉 / 手机没网 / 系统把 ntfy App 杀掉。要"离线也到"，
 * 得让 Hermes 服务端那条路来发（hooks + `hermes send --to ntfy`）。
 */

import { config } from './store.js';

/** 当前通知配置（已带默认值） */
export function cfg() {
  return config.get().notify || {};
}

/** 配置是否齐全到能发 */
export function ready() {
  const n = cfg();
  return Boolean(n.enabled && String(n.server || '').trim() && String(n.topic || '').trim());
}

/** 发布地址：<server>/<topic> */
export function endpoint() {
  const n = cfg();
  const server = String(n.server || '').trim().replace(/\/+$/, '');
  const topic = String(n.topic || '').trim().replace(/^\/+/, '');
  if (!server || !topic) return '';
  return server + '/' + encodeURIComponent(topic);
}

/** 手机订阅页（App 里点 + 输入 topic 也行，这里是给浏览器看的） */
export function subscribeUrl() {
  return endpoint();
}

/**
 * HTTP 头只能放 ASCII —— 中文标题会被浏览器直接拒发（fetch 抛 TypeError）。
 * ntfy 认 RFC 2047 编码字，所以非 ASCII 标题这样编码：=?UTF-8?B?<base64>?=
 */
function rfc2047(s) {
  const t = String(s == null ? '' : s);
  if (/^[\x20-\x7E]*$/.test(t)) return t;         // 全 ASCII，原样
  const bytes = new TextEncoder().encode(t);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return '=?UTF-8?B?' + btoa(bin) + '?=';
}

/** 正文截断：通知栏只需要一眼看懂，别把整篇回复塞进去 */
function excerpt(text, max = 160) {
  let t = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')          // 代码块
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')     // 图片
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')  // 链接留文字
    .replace(/[*_`>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length > max) t = t.slice(0, max - 1) + '…';
  return t;
}

/**
 * 发一条推送。
 * 任何失败都吞掉（通知发不出去不该影响对话），但把原因返回给调用方 —— 设置页要用它显示结果。
 * @returns {Promise<{ok:boolean, status?:number, error?:string}>}
 */
export async function push({ title, body, tags = [], priority = 3, click, timeout = 10000 } = {}) {
  const url = endpoint();
  if (!url) return { ok: false, error: 'not-configured' };

  const n = cfg();
  const headers = {
    'Content-Type': 'text/plain; charset=utf-8',
    Title: rfc2047(title || 'Hermes'),
    Priority: String(priority),
  };
  // tags 只放 ASCII（ntfy 认 emoji 短代码，如 white_check_mark / warning）
  const tagStr = (Array.isArray(tags) ? tags : String(tags).split(',')).filter(Boolean).join(',');
  if (tagStr) headers.Tags = tagStr;
  if (click || location.href) headers.Click = click || location.href;
  if (n.token) headers.Authorization = 'Bearer ' + String(n.token).trim();

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(url, { method: 'POST', headers, body: excerpt(body, 1200) || '(空)', signal: ctl.signal });
    if (!res.ok) {
      // ntfy 的错误正文是纯文本，带出来给人看
      let detail = '';
      try { detail = (await res.text()).slice(0, 120); } catch { /* 忽略 */ }
      return { ok: false, status: res.status, error: detail || `HTTP ${res.status}` };
    }
    return { ok: true, status: res.status };
  } catch (e) {
    return { ok: false, error: e && e.name === 'AbortError' ? '超时' : String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }
}

/** 设置页的"发送测试通知" */
export function test() {
  const n = cfg();
  return push({
    title: 'Hermes Lite WebUI 测试',
    body: `通道已通。topic: ${n.topic}\n以后 Hermes 回复完成时会推到这里。`,
    tags: ['white_check_mark'],
    priority: 3,
  });
}

/**
 * 该不该在这时候推。
 * @param {'done'|'error'} kind
 */
export function should(kind) {
  const n = cfg();
  if (!ready()) return false;
  if (kind === 'done' && n.onDone === false) return false;
  if (kind === 'error' && n.onError === false) return false;
  // 页面在前台时通常人就在看，默认不推
  if (n.onlyHidden !== false && !document.hidden) return false;
  return true;
}

/**
 * 对话事件 → 推送（fire-and-forget，绝不 await 到对话流程里）
 * @param {'done'|'error'} kind
 */
export function notifyEvent(kind, { title, text, tags, priority } = {}) {
  if (!should(kind)) return;
  void push({
    title,
    body: text,
    tags: tags || (kind === 'error' ? ['warning'] : ['white_check_mark']),
    priority: priority || (kind === 'error' ? 4 : 3),
  });
}

export { excerpt };
