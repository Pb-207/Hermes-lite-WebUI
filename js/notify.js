/**
 * notify.js —— 把 Hermes 的动静推到手机通知栏
 *
 * 两个通道，默认用第一个：
 *
 *  ① 'browser' —— **浏览器自带的通知，不需要任何第三方**。
 *     页面本来就通过 gateway 流式收着这一轮，跑完直接 `showNotification` 弹一条系统通知。
 *     事件源就是那个已连着的 gateway，没有中转、没有额外服务。
 *     代价是物理性的：**页面关掉就没了** —— 浏览器不提供"服务端唤醒已关闭页面"的通道
 *     （那正是 Web Push 存在的理由，而它需要一个持有订阅的发送方，静态站拿不出来）。
 *
 *  ② 'ntfy' —— 第三方推送服务（开源、可自托管、有 Android/iOS App）。
 *     它能覆盖"页面关着也能收到"，但**前提是 Hermes 主机那侧也配了**
 *     （hook + `hermes send --to ntfy`；Hermes 自带 `plugins/platforms/ntfy/adapter.py`）。
 *     光靠这个页面发，一样是"页面活着才行" —— 别把它当成"离线推送"。
 *     实测 ntfy 的跨源预检回 `Access-Control-Allow-Origin: *`，所以纯静态页面能直发，
 *     topic/token 只在这个浏览器里，本站不经手。
 *
 * 选 ntfy 的另一个理由是"别的客户端 / 别的会话的动静也要推" —— 那些事件这个页面看不到，
 * 只能由主机侧发。页面能看到的事件，目前只有它自己发起的那一轮。
 */

import { config } from './store.js';

/** 当前通知配置（已带默认值） */
export function cfg() {
  return config.get().notify || {};
}

/** 通道选择（兼容老配置：没写 channel 但填了 topic 的，当成 ntfy） */
export function channel() {
  const n = cfg();
  if (n.channel === 'ntfy' || n.channel === 'both' || n.channel === 'browser') return n.channel;
  return String(n.topic || '').trim() ? 'ntfy' : 'browser';
}

export function useBrowser() { const c = channel(); return c === 'browser' || c === 'both'; }
export function useNtfy() { const c = channel(); return c === 'ntfy' || c === 'both'; }

/* ══════════ 通道 ①：浏览器系统通知 ══════════ */

export function browserSupported() { return typeof Notification !== 'undefined'; }
export function permState() { return browserSupported() ? Notification.permission : 'unsupported'; }

/** 请求通知权限（设置页按钮） */
export async function requestPerm() {
  if (!browserSupported()) return 'unsupported';
  try {
    if (Notification.permission === 'default') return await Notification.requestPermission();
    return Notification.permission;
  } catch { return Notification.permission; }
}

/**
 * 弹一条系统通知。
 * 手机上必须走 Service Worker —— 页面上下文的 `new Notification()` 在移动端 Chrome 会抛
 * `Illegal constructor`；桌面端才允许。所以先试 SW，不行再退化。
 */
export async function browserPush({ title, body, tag = 'hermes-event' } = {}) {
  if (!browserSupported()) return { ok: false, error: '这个浏览器不支持通知' };
  if (Notification.permission === 'default') await requestPerm();
  if (Notification.permission !== 'granted') {
    return {
      ok: false,
      error: Notification.permission === 'denied'
        ? '通知权限被拒绝（要在浏览器/系统设置里放行）'
        : '还没授予通知权限',
    };
  }
  const opts = {
    body: excerpt(body, 200),
    tag,                      // 同一个 tag 只保留最新一条，避免刷屏
    icon: './icon.svg',
    badge: './icon.svg',
    requireInteraction: false,
  };
  try {
    const reg = navigator.serviceWorker ? await navigator.serviceWorker.getRegistration() : null;
    if (reg && reg.showNotification) {
      await reg.showNotification(title || 'Hermes', opts);
      return { ok: true, via: 'sw' };
    }
    new Notification(title || 'Hermes', opts);
    return { ok: true, via: 'page' };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/* ══════════ 通道 ②：ntfy ══════════ */

export function ntfyReady() {
  const n = cfg();
  return Boolean(String(n.server || '').trim() && String(n.topic || '').trim());
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
export function subscribeUrl() { return endpoint(); }

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
  const t = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')          // 代码块
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')     // 图片
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')  // 链接留文字
    .replace(/[*_`>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/**
 * 发一条 ntfy 推送。
 * 任何失败都吞掉（通知发不出去不该影响对话），但把原因返回给调用方 —— 设置页要用它显示结果。
 * @returns {Promise<{ok:boolean, status?:number, error?:string}>}
 */
export async function push({ title, body, tags = [], priority = 3, click, timeout = 10000 } = {}) {
  const url = endpoint();
  if (!url) return { ok: false, error: 'ntfy 的 Topic 还没填' };

  const n = cfg();
  const headers = {
    'Content-Type': 'text/plain; charset=utf-8',
    Title: rfc2047(title || 'Hermes'),
    Priority: String(priority),
  };
  // tags 只放 ASCII（ntfy 认 emoji 短代码，如 white_check_mark / warning）
  const tagStr = (Array.isArray(tags) ? tags : String(tags).split(',')).filter(Boolean).join(',');
  if (tagStr) headers.Tags = tagStr;
  headers.Click = click || location.href;
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

/**
 * 按当前通道把一条通知发出去。返回 [[通道名, 结果], …]，设置页用它显示结果。
 */
export async function send({ title, body, tags = [], priority = 3 } = {}) {
  const out = [];
  if (useBrowser()) out.push(['浏览器', await browserPush({ title, body })]);
  if (useNtfy()) out.push(['ntfy', await push({ title, body, tags, priority })]);
  if (!out.length) out.push(['无', { ok: false, error: '没有启用任何通道' }]);
  return out;
}

/** 设置页的"发送测试通知" */
export function test() {
  return send({
    title: 'Hermes Lite WebUI 测试',
    body: `通道已通（${channel()}）。以后 Hermes 回复完成时会推到这里。`,
    tags: ['white_check_mark'],
    priority: 3,
  });
}

/* ══════════ 事件分发 ══════════ */

/**
 * 该不该在这时候推。
 * @param {'done'|'error'} kind
 */
export function should(kind) {
  const n = cfg();
  if (!n.enabled) return false;
  if (kind === 'done' && n.onDone === false) return false;
  if (kind === 'error' && n.onError === false) return false;
  const b = useBrowser();
  const t = useNtfy();
  if (b && !browserSupported()) return false;
  if (t && !b && !ntfyReady()) return false;
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
  void send({
    title,
    body: text,
    tags: tags || (kind === 'error' ? ['warning'] : ['white_check_mark']),
    priority: priority || (kind === 'error' ? 4 : 3),
  });
}

export { excerpt };
