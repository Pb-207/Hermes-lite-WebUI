/**
 * main.js —— 启动、状态机、事件接线
 *
 * 会话历史全在 Hermes 服务端 state.db（与桌面端 / CLI 共用）：
 *  - 侧栏 = GET /api/sessions
 *  - 打开 = GET /api/sessions/{id}/messages
 *  - 发送 = POST /v1/chat/completions + `X-Hermes-Session-Id`（历史由服务端载入，只发当轮那条）
 *  - 新建 = POST /api/sessions；改名 = PATCH；删除 = DELETE
 *
 * 多会话并发：每个会话各自维护一条独立的流（streams: Map<sid, Stream>），
 * 切走只是解绑 DOM 引用，fetch 继续跑；切回来按累积内容重绘。
 * 因此「一个会话在生成时」不再阻塞切换与新建。
 *
 * 本机 localStorage 只存连接配置、偏好和一份只读缓存。
 */

import { $, $$, el, download, fmtTime, rafThrottle } from './util.js';
import { config, prefs, cache, normalizeBase, summarize, exportAll } from './store.js';
import {
  streamChat, listModels, listSessions, getMessages, createSession,
  patchSession, deleteSession, ping, explainError,
  streamSessionChat, resolveApproval, stopRun, getRun,
} from './api.js';
import * as ui from './ui.js';
import { initSettings } from './settings.js';
import * as ntfy from './notify.js';

const APP_VERSION = '1.2.0';
const MSG_PAGE = 500;      // 单个会话一次拉多少条历史

/**
 * 每个会话的实时流状态：
 *   { controller, acc, tools, usage, startedAt, bubble, turn, paint, error, aborted }
 * bubble/turn 只在「该会话正在屏幕上」时有值，切走即置空 —— 这是"切走不影响后台继续跑"的关键。
 */
const streams = new Map();

/**
 * 事件到达日志（排查用）：记录浏览器**真正收到**的事件顺序，以及每个事件到达时累计正文的长度。
 * 判断"工具条位置不对"到底是服务端到达顺序变了、还是前端记错 at，看这一串就够了。
 */
let evLog = [];
function logEv(text) {
  if (evLog.length < 600) evLog.push(text);
}

/** 每个会话在内存里的行数据（切回来立刻能画，不必重新请求） */
const rowsBySid = new Map();

const state = {
  sessionId: null,
  list: [],                // 服务端会话行
  loading: false,
  switching: false,        // 正在切换会话（防连点竞态）
  view: 'chat',
  filter: '',
  connText: '未连接',
  lastModels: [],
};

const rowsOf = (sid) => (sid && rowsBySid.get(sid)) || [];
function setRows(sid, rows) {
  if (!sid) return;
  rowsBySid.set(sid, rows);
  cache.setMessages(sid, rows);
}
const isStreaming = (sid) => Boolean(sid && streams.has(sid));
const activeStream = () => (state.sessionId ? streams.get(state.sessionId) : null);
const hasAnyStream = () => streams.size > 0;

/* ══════════════ 主题 ══════════════ */

const mq = window.matchMedia('(prefers-color-scheme: light)');

function applyTheme(theme) {
  const resolved = theme === 'auto' ? (mq.matches ? 'light' : 'dark') : theme;
  document.documentElement.dataset.theme = resolved;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', resolved === 'light' ? '#f7f8fa' : '#0d1017');
}
mq.addEventListener('change', () => { if (prefs.get().theme === 'auto') applyTheme('auto'); });

/* ══════════════ 视图切换 ══════════════ */

function setView(v) {
  state.view = v;
  $('#view-chat').hidden = v !== 'chat';
  $('#view-stats').hidden = v !== 'stats';
  $$('#nav .nav-item').forEach((b) => b.setAttribute('aria-current', String(b.dataset.view === v)));
  if (v === 'stats') ui.renderStats(summarize(state.list), state.list);
  closeSidebar();
}

/* ══════════════ 侧栏（移动端抽屉） ══════════════ */

function openSidebar() {
  $('#sidebar').classList.add('open');
  const scrim = $('#scrim');
  scrim.hidden = false;
  requestAnimationFrame(() => scrim.classList.add('show'));
}
function closeSidebar() {
  $('#sidebar').classList.remove('open');
  const scrim = $('#scrim');
  scrim.classList.remove('show');
  setTimeout(() => { scrim.hidden = true; }, 180);
}

/* ══════════════ 会话列表 ══════════════ */

function filteredList() {
  const q = state.filter.trim().toLowerCase();
  if (!q) return state.list;
  return state.list.filter((s) =>
    (s.title || '').toLowerCase().includes(q) ||
    (s.preview || '').toLowerCase().includes(q) ||
    String(s.id).toLowerCase().includes(q));
}

function paintSidebar({ loading = false } = {}) {
  ui.renderSessions(filteredList(), state.sessionId, {
    loading: loading && !state.list.length,
    generating: new Set(streams.keys()),          // 哪些会话正在生成 → 列表上打转圈
    onPick: (id) => {
      if (id === state.sessionId) { closeSidebar(); return; }
      void openSession(id);
    },
    onDelete: (s) => void removeSession(s),
    onRename: (id, title) => void renameSession(id, title),
  });
}

async function loadList({ silent = false } = {}) {
  const c = config.get();
  if (!c.baseUrl || !c.key) return;
  state.loading = true;
  if (!silent) paintSidebar({ loading: true });
  try {
    const { data } = await listSessions(c.baseUrl, c.key, { limit: 80 });
    state.list = data;
    cache.setList(data);
    paintSidebar();
    if (state.view === 'stats') ui.renderStats(summarize(state.list), state.list);
    refreshChrome();
  } catch (e) {
    paintSidebar();
    const msg = explainError(e, e.status) || String(e.message || e);
    if (!silent) ui.toast('读不到会话列表：' + msg, 'err', 8000);
  } finally {
    state.loading = false;
  }
}

/**
 * 拉一个会话的历史。
 *
 * 服务端 /api/sessions/{id}/messages 的 limit 硬上限是 500，而且 pagination 里
 * **没有 total**，只有 {limit, offset, order, returned}。所以判断"还有更早的"只能靠
 * `returned == limit`，然后带 order=latest 加大 offset 往回翻（offset 是从末尾算起）。
 * 旧实现用了 pagination.total —— 那个字段不存在，判断永远不成立，于是超过 500 条的
 * 会话只会显示最旧的 500 条，最新的全丢。这是之前"历史不全"的真因。
 */
async function loadHistory(baseUrl, key, id, { pageSize = 500, maxPages = 8, isCancelled } = {}) {
  const pages = [];
  let truncated = false;
  for (let i = 0; i < maxPages; i++) {
    const { data, pagination } = await getMessages(baseUrl, key, id, {
      limit: pageSize, offset: i * pageSize, order: 'latest',
    });
    if (isCancelled && isCancelled()) return { data: [], cancelled: true };
    pages.push(data || []);
    const returned = (pagination && pagination.returned) ?? (data || []).length;
    if (returned < pageSize) break;              // 取完了
    if (i === maxPages - 1) truncated = true;    // 还有更早的，但不再翻了
  }
  // 每页内部是"旧→新"，往前翻得到的是更早的页，所以倒序拼接
  const data = pages.reverse().flat();
  return { data, truncated };
}

/**
 * 打开（或切到）一个会话。
 * 不再因"别处正在生成"而拒绝 —— 切走只是把当前会话的 DOM 引用置空。
 */
async function openSession(id, { force = false } = {}) {
  if (!id) return;

  // 离开当前会话：解绑它的 DOM 引用，让后台流继续但不碰已卸载的节点
  const leaving = activeStream();
  if (leaving) { leaving.bubble = null; leaving.turn = null; }

  state.sessionId = id;
  paintSidebar();
  closeSidebar();

  // ① 内存里有就直接画（含正在生成的那条），零延迟
  const inMem = rowsBySid.get(id);
  if (inMem && !force) {
    paintStream();
    ui.scrollToEnd(true);
    if (isStreaming(id)) return;      // 正在生成的会话，历史不用再拉
  }

  // ② 其次是 localStorage 缓存
  const cached = !force && cache.getMessages(id);
  if (cached) {
    setRows(id, cached);
    paintStream();
    ui.scrollToEnd(true);
  } else {
    paintStreamLoading();
  }

  // ③ 最后向服务端要最新的（order=latest：先拿最新一页，再往回翻）
  state.switching = true;
  const c = config.get();
  try {
    const { data, truncated } = await loadHistory(c.baseUrl, c.key, id, {
      isCancelled: () => state.sessionId !== id,   // 用户切走了就丢弃
    });
    if (state.sessionId !== id) return;
    if (truncated) {
      ui.toast(`这个会话很长，只加载了最近 ${data.length} 条`, 'warn', 6000);
    }
    // 正在生成的会话：服务端历史 + 本地累积的这条不能互相覆盖
    setRows(id, isStreaming(id) ? mergeLive(id, data) : data);
    if (!activeStream()) paintStream();          // 有流时 paintStream 由流自身驱动，避免覆盖
    ui.scrollToEnd(true);
  } catch (e) {
    if (state.sessionId === id && !cached) {
      paintStream();
      ui.note($('#stream').querySelector('.stream-inner'),
        '读不到历史：' + (explainError(e, e.status) || String(e.message || e)), 'err');
    }
  } finally {
    state.switching = false;
  }
}

/** 服务端最新历史 + 本地正在生成的那条尾巴（互不覆盖） */
function mergeLive(sid, serverRows) {
  const local = rowsBySid.get(sid) || [];
  const p = streams.get(sid);
  // 正在生成时：本地可能已经有 user 行 + 累积的 assistant 内容，服务端可能还没落这条
  const localTail = local.slice(-2);
  const lastServerTs = serverRows.length ? (serverRows[serverRows.length - 1].timestamp || 0) : 0;
  const extra = localTail.filter((r) => (r.timestamp || 0) > lastServerTs && r.role === 'user');
  return extra.length ? [...serverRows, ...extra] : serverRows;
}

async function newChat() {
  const c = config.get();
  if (!c.baseUrl || !c.key) { ui.toast('还没配置 Base URL / API Key', 'warn'); settings.open(); return; }
  try {
    const { id } = await createSession(c.baseUrl, c.key, { model: c.model });
    if (!id) throw new Error('服务端没有返回会话 id');
    rowsBySid.set(id, []);
    const leaving = activeStream();
    if (leaving) { leaving.bubble = null; leaving.turn = null; }
    state.sessionId = id;
    setView('chat');
    paintSidebar();
    paintStream();
    refreshChrome();
    closeSidebar();
    focusInput();
    void loadList({ silent: true });
  } catch (e) {
    ui.toast('新建会话失败：' + (explainError(e, e.status) || String(e.message || e)), 'err', 7000);
  }
}

async function removeSession(s) {
  const streaming = isStreaming(s.id);
  const src = ui.sourceLabel(s.source);
  const warn = [];
  if (streaming) warn.push('这个会话正在生成，删除会先中断它。');
  if (s.source !== 'api_server') warn.push(`⚠️ 这条来自「${src}」，删掉后桌面端 / CLI 里也会消失。`);
  warn.push('删除不可撤销。');
  // 无条件确认：以前只有 warn 非空才弹，网页自建的会话（source=api_server）且不在生成时
  // warn 是空的，于是点一下就直接删掉了 —— 不可撤销的操作必须每次都问。
  if (!confirm(`删除会话「${s.title || s.id}」？\n\n${warn.join('\n')}`)) return;

  if (streaming) abortStream(s.id, { silent: true });

  const c = config.get();
  try {
    await deleteSession(c.baseUrl, c.key, s.id);
    state.list = state.list.filter((x) => x.id !== s.id);
    cache.setList(state.list);
    rowsBySid.delete(s.id);
    if (state.sessionId === s.id) {
      const next = state.list.length ? state.list[0].id : null;
      state.sessionId = next;
      if (next) await openSession(next);
      else { paintStream(); }
    }
    paintSidebar();
    refreshChrome();
    ui.toast('已删除', 'ok', 2500);
  } catch (e) {
    ui.toast('删除失败：' + (explainError(e, e.status) || String(e.message || e)), 'err', 7000);
  }
}

async function renameSession(id, title) {
  const c = config.get();
  try {
    await patchSession(c.baseUrl, c.key, id, { title });
    const row = state.list.find((s) => s.id === id);
    if (row) row.title = title;
    cache.setList(state.list);
    paintSidebar();
    if (id === state.sessionId) refreshTopTitle();
    ui.toast('已改名（桌面端同步）', 'ok', 2500);
  } catch (e) {
    ui.toast('改名失败：' + (explainError(e, e.status) || String(e.message || e)), 'err', 7000);
  }
}

/* ══════════════ 渲染 ══════════════ */

function activeRow() { return state.list.find((s) => s.id === state.sessionId) || null; }

/**
 * 画当前会话：历史行 + （若有）正在生成的那条尾巴。
 * 尾巴必须显式 appendTurn —— ui.rowToTurn() 会滤掉空内容的 assistant 行。
 */
function paintStream() {
  const sid = state.sessionId;
  const p = sid ? streams.get(sid) : null;
  const handle = ui.renderStream(rowsOf(sid), {
    onPickPrompt: (text) => { $('#input').value = text; focusInput(); },
  });

  let liveTurn = null;
  if (p && handle && handle.inner) {
    liveTurn = ui.appendTurn(handle.inner, {
      role: 'assistant',
      content: p.acc,
      tools: p.tools,
      at: p.startedAt,
    });
    liveTurn.bubble.classList.add('streaming');
    // 重新绑定 DOM 引用，之后的增量直接画到这里
    p.bubble = liveTurn.bubble;
    p.turn = liveTurn.turn;
    if (p.acc || p.tools.length) ui.renderReplyInto(p.bubble, p.acc, p.tools);
  }

  refreshTopTitle();
  refreshStopButton();

  // 审批卡片：切走再切回来要能重建（状态在 streams 里，不在 DOM 里）
  if (p && p.approval && !p.approvalResolved && handle && handle.inner) {
    const choices = Array.isArray(p.approval.choices) && p.approval.choices.length
      ? p.approval.choices : ['once', 'deny'];
    const card = ui.approvalCard({
      approval: p.approval,
      choices,
      onChoose: (choice) => void chooseApproval(sid, p, choice),
    });
    handle.inner.append(card);
    p.approvalCard = card;
  }

  // 回复结尾的编号选项 → 可点回填（只在没有正在生成时给，避免抢答）
  if (!p && handle && handle.inner) {
    const lastAsst = [...handle.inner.querySelectorAll('.turn.assistant')].pop();
    if (lastAsst && !lastAsst.querySelector('.opt-chips')) {
      const lastRow = [...rowsOf(sid)].reverse().find((r) => r.role === 'assistant');
      const opts = ui.optionsFromText(ui.normContent(lastRow && lastRow.content));
      const chips = ui.optionChips(opts, (label) => { void send(label); });
      if (chips) lastAsst.append(chips);
    }
  }

  return liveTurn || handle;
}

/** 在流里插入/替换审批卡片 */
function showApprovalCard(sid, p, ev) {
  if (sid !== state.sessionId) { paintSidebar(); return; }   // 不在前台就不画，切回来时重建
  if (p.approvalCard) p.approvalCard.remove();
  const inner = $('#stream').querySelector('.stream-inner');
  if (!inner) return;
  const choices = Array.isArray(ev.choices) && ev.choices.length ? ev.choices : ['once', 'deny'];
  p.approvalCard = ui.approvalCard({
    approval: ev,
    choices,
    onChoose: (choice) => void chooseApproval(sid, p, choice),
  });
  inner.append(p.approvalCard);
  ui.scrollToEnd(true);
  refreshStopButton();
}

/** 提交审批选择给服务端 */
async function chooseApproval(sid, p, choice) {
  const c = config.get();
  const ev = p.approval || {};
  if (!p.runId) { ui.toast('这一步已经不在等了（run 已结束）', 'warn'); return; }
  const buttons = p.approvalCard ? [...p.approvalCard.querySelectorAll('.ap-actions .btn')] : [];
  buttons.forEach((b) => { b.disabled = true; });
  try {
    await resolveApproval(c.baseUrl, c.key, p.runId, { choice, requestId: ev.request_id });
    p.approvalResolved = choice;
    ui.settleApprovalCard(p.approvalCard, choice);
    ui.toast(choice === 'deny' ? '已拒绝，agent 会改走别的做法' : '已批准，继续执行…',
      choice === 'deny' ? 'warn' : 'ok', 3000);
  } catch (e) {
    buttons.forEach((b) => { b.disabled = false; });
    ui.toast('提交审批失败：' + (explainError(e, e.status) || String(e.message || e)), 'err', 7000);
  }
}

function paintStreamLoading() {
  const box = $('#stream');
  box.innerHTML = '';
  box.append(el('div', { class: 'stream-inner' }, [
    el('div', { class: 'empty' }, [el('p', { text: '正在读取历史…' })]),
  ]));
}

function refreshTopTitle() {
  const s = activeRow();
  $('#top-title').textContent = s ? (s.title || s.id) : (state.sessionId || '新对话');
  const bits = [];
  if (s) {
    bits.push(ui.sourceLabel(s.source));
    if (s.message_count) bits.push(`${s.message_count} 条`);
    const ts = (s.last_active || s.started_at) * 1000;
    if (ts) bits.push(fmtTime(ts));
  } else if (state.sessionId) {
    bits.push('新会话（尚未产生历史）');
  }
  if (isStreaming(state.sessionId)) bits.push('生成中…');
  $('#top-sub').textContent = bits.join(' · ');
}

/** 停止键只在「当前会话确实在生成」时出现 */
function refreshStopButton() {
  $('#stop-btn').hidden = !isStreaming(state.sessionId);
  $('#send').disabled = isStreaming(state.sessionId);
}

function refreshChrome() {
  const sum = summarize(state.list);
  const c = config.get();
  let host = '—';
  try { host = c.baseUrl ? new URL(c.baseUrl).host : '—'; } catch {}
  ui.renderStatusbar({
    conn: state.connText,
    model: c.model || 'hermes-agent',
    sessions: sum.sessions,
    messages: sum.messages,
    tokens: sum.input + sum.output,
    generating: streams.size,               // 全局有几个会话在跑
    version: `hermes-lite-webui v${APP_VERSION} · ${host}`,
  });
  $('#foot-name').textContent = c.baseUrl ? host : '未连接';
  const running = streams.size ? `　${streams.size} 个生成中` : '';
  $('#foot-sub').textContent = c.key ? `服务端会话 ${state.list.length} 个${running}　点此设置` : '点此填写 Key';
}

/* ══════════════ 连接检查 ══════════════ */

let pingSeq = 0;

async function checkConnection({ loud = false } = {}) {
  const c = config.get();
  if (!c.baseUrl || !c.key) { setConn('', '未连接'); return false; }
  const seq = ++pingSeq;
  if (!hasAnyStream()) setConn('busy', '检查中');
  try {
    const r = await ping(c.baseUrl, c.key);
    if (seq !== pingSeq) return false;
    state.lastModels = r.models || [];
    if (!hasAnyStream()) setConn('on', '已连接');
    if (loud) ui.toast('连接正常 ✓' + (state.lastModels.length ? '　模型：' + state.lastModels.join(', ') : ''), 'ok');
    return true;
  } catch (e) {
    if (seq !== pingSeq) return false;
    setConn('off', '连不上');
    if (loud) ui.toast(explainError(e, e.status) || String(e.message || e), 'err', 7000);
    return false;
  }
}

function setConn(cls, text) {
  state.connText = text;
  ui.setConn(hasAnyStream() ? 'busy' : cls, hasAnyStream() ? `${streams.size} 个生成中` : text);
  refreshChrome();
}

/* ══════════════ 图片 ══════════════ */

/**
 * 只存在内存里，不落 localStorage。
 *
 * 两个地址各有用途：`dataUrl` 发给服务端（api_server 接受 text / image_url 部件，
 * 且只认 http(s) 或 data:image/ 两种来源），`previewUrl`（blob:）给本地那条用户消息回显 ——
 * 本地行是要进 localStorage 缓存的，塞 base64 会直接把配额撑爆。
 */
const MAX_EDGE = 1600;      // 长边上限；服务端请求体总上限 10 MB，base64 还要 ×4/3
const JPEG_Q = 0.85;
let pendingImages = [];

async function shrinkImage(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';                 // PNG 透明底 → 白，避免转 JPEG 发黑
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  if (bitmap.close) bitmap.close();
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', JPEG_Q));
  if (!blob) throw new Error('canvas 出图失败');
  const dataUrl = await new Promise((res) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result));
    fr.readAsDataURL(blob);
  });
  return { dataUrl, previewUrl: URL.createObjectURL(blob), w, h, kb: Math.round(blob.size / 1024) };
}

async function addImages(files) {
  for (const f of files) {
    if (!f || !f.type || !f.type.startsWith('image/')) continue;
    try {
      const im = await shrinkImage(f);
      if (im.dataUrl.length > 7_000_000) {
        ui.toast(`「${f.name || '这张图'}」压完仍超过 7 MB，服务端最多收 10 MB，换一张吧`, 'warn', 6500);
        URL.revokeObjectURL(im.previewUrl);
        continue;
      }
      pendingImages.push({ name: f.name || '粘贴的图', ...im });
    } catch {
      ui.toast('这张图读不了（格式不支持？）', 'warn', 5000);
    }
  }
  paintThumbs();
}

function paintThumbs() {
  const box = $('#thumbs');
  if (!box) return;
  box.innerHTML = '';
  box.hidden = !pendingImages.length;
  pendingImages.forEach((im, i) => {
    box.append(el('div', { class: 'thumb', title: `${im.name} · ${im.w}×${im.h} · ${im.kb} KB` }, [
      el('img', { src: im.previewUrl, alt: im.name }),
      el('span', { class: 'nb', text: `${im.kb} KB` }),
      el('button', {
        class: 'rm', type: 'button', 'aria-label': '移除这张图', text: '×',
        onclick: () => {
          const gone = pendingImages.splice(i, 1)[0];
          if (gone) URL.revokeObjectURL(gone.previewUrl);
          paintThumbs();
        },
      }),
    ]));
  });
}

/** 发送那一刻才消费待发图片（提前取走的话，中途 return 就丢了） */
function takeImages() {
  const list = pendingImages;
  pendingImages = [];
  paintThumbs();
  return list;
}

/** 组装带图的多模态 message：text 部件 + image_url 部件 */
function withImageParts(text, images) {
  const parts = [];
  if (text) parts.push({ type: 'text', text });
  for (const im of images) parts.push({ type: 'image_url', image_url: { url: im.dataUrl } });
  return parts;
}

/* ══════════════ 发送 ══════════════ */

function focusInput() {
  const ta = $('#input');
  ta.focus();
  try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch {}
}

function autoGrow() {
  const ta = $('#input');
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, Math.round(window.innerHeight * 0.4)) + 'px';
}

function abortStream(sid, { silent = false } = {}) {
  const p = streams.get(sid);
  if (!p) return false;
  p.aborted = true;
  try { p.controller.abort(); } catch {}
  if (!silent) ui.toast('已停止生成', 'warn');
  return true;
}

async function send(text) {
  const body = String(text || '').trim();
  if (!body && !pendingImages.length) return;

  const c = config.get();
  if (!c.baseUrl || !c.key) { ui.toast('还没配置 Base URL / API Key', 'warn'); settings.open(); return; }

  // 没有会话就先建一个（历史归服务端）
  if (!state.sessionId) {
    try {
      const { id } = await createSession(c.baseUrl, c.key, { model: c.model });
      if (!id) throw new Error('服务端没有返回会话 id');
      rowsBySid.set(id, []);
      state.sessionId = id;
      paintSidebar();
    } catch (e) {
      ui.toast('新建会话失败：' + (explainError(e, e.status) || String(e.message || e)), 'err', 7000);
      return;
    }
  }
  const sid = state.sessionId;

  // 同一会话同一时刻只跑一轮
  if (isStreaming(sid)) { ui.toast('这个会话正在生成中，可以切到别的会话继续', 'warn', 4000); return; }

  const rows = rowsOf(sid);
  const images = takeImages();            // 到这步才消费：前面任何 return 都不会丢图
  rows.push({
    role: 'user',
    content: body,
    images: images.map((im) => ({ url: im.previewUrl, w: im.w, h: im.h })),   // blob: 预览地址，几个字节
    timestamp: Date.now() / 1000,
  });
  setRows(sid, rows);

  // 建立这条会话自己的流
  const p = {
    controller: new AbortController(),
    runId: null,
    status: 'running',
    acc: '',
    tools: [],
    toolSeq: 0,
    usage: null,
    startedAt: Date.now() / 1000,
    bubble: null, turn: null,
    approval: null, approvalResolved: null, approvalCard: null,
    error: null,
    aborted: false,
  };
  p.paint = rafThrottle(() => {
    const cur = streams.get(sid);
    if (!cur || cur !== p || !p.bubble) return;      // 已切走 → 不碰 DOM
    ui.renderReplyInto(p.bubble, p.acc, p.tools);    // 正文里按 at 交错着工具条
  });
  streams.set(sid, p);

  if (sid === state.sessionId) { paintStream(); ui.scrollToEnd(true); }
  paintSidebar();
  refreshChrome();
  setConn('busy', `${streams.size} 个生成中`);

  const showTools = prefs.get().showTools !== false;

  try {
    // ── 走会话内流式：唯一同时满足「共享桌面端历史」+「跨源可读」的端点
    //    （/v1/runs 不读会话历史，它的 SSE 又缺 ACAO —— 两条都实测过）
    p.toolSeq = 0;
    const res = await streamSessionChat(c.baseUrl, c.key, sid, {
      message: images.length ? withImageParts(body, images) : body,
      model: c.model || 'hermes-agent',
      signal: p.controller.signal,
      onEvent: (name, ev) => {
        logEv(name === 'assistant.delta' ? `delta+${(ev.delta || '').length}@${p.acc.length}`
          : (name === 'tool.started' || name === 'tool.completed' || name === 'tool.failed')
            ? `${name}:${ev.tool_name || ''}@${p.acc.length}`
            : `${name}@${p.acc.length}`);
        if (name === 'run.started') { p.runId = ev.run_id || null; return; }

        if (name === 'assistant.delta') {
          p.acc += ev.delta || '';
          p.paint();
          if (sid === state.sessionId) ui.scrollToEnd();
          return;
        }

        // tool.progress 是"思考中"的推理片段（tool_name 多为 _thinking），不当工具条渲染
        if (name === 'tool.progress') return;

        if (name === 'tool.started') {
          // at = 这个工具出现时正文已经流出了多少字 —— 交错渲染靠它定位
          if (showTools) {
            p.tools.push({
              tool: ev.tool_name || 'tool',
              label: ev.preview || '',
              toolCallId: 'ev' + (p.toolSeq++),
              status: 'running',
              at: p.acc.length,
            });
            p.paint();
          }
          if (sid === state.sessionId) ui.scrollToEnd();
          return;
        }

        if (name === 'tool.completed' || name === 'tool.failed') {
          // 事件不带 toolCallId，按"同名且仍在跑"的那条收尾
          const t = p.tools.find((x) => x.status === 'running' && x.tool === ev.tool_name)
                 || p.tools.find((x) => x.status === 'running');
          if (t) {
            t.status = 'completed';
            t.error = name === 'tool.failed';
            if (!t.label && ev.preview) t.label = ev.preview;
          }
          if (showTools) p.paint();
          if (sid === state.sessionId) ui.scrollToEnd();
          return;
        }

        // 这条路径不注册审批回调，approval.request 不会出现；留着以便日后换回 /v1/runs
        if (name === 'approval.request') {
          p.approval = ev;
          p.approvalResolved = null;
          showApprovalCard(sid, p, ev);
        }
      },
    });

    p.runId = res.runId || p.runId;
    if (res.content) p.acc = res.content;
    if (res.usage) p.usage = res.usage;
    p.status = res.status || 'completed';

    // 事件流可能被网络掐断（手机切网/锁屏）而 run 仍在跑 —— 这条 run 同样注册在 /v1/runs 里，用它兜底
    let final = { output: p.acc, usage: p.usage, session_id: res.sessionId || sid, status: p.status };
    if (!p.acc && p.runId) {
      try {
        const st = await getRun(c.baseUrl, c.key, p.runId);
        if (st && st.object === 'hermes.run') {
          final = {
            output: st.output || p.acc,
            usage: st.usage || p.usage,
            session_id: st.session_id || final.session_id,
            status: st.status || p.status,
          };
        }
      } catch { /* 查不到就用流里的 */ }
    }

    p.acc = final.output || p.acc;
    p.usage = final.usage || p.usage;
    p.status = final.status;

    // 这条会话正被另一个 turn 持有（桌面端在跑 / 另一个客户端在跑）时，服务端会以
    // 200 + 正文的形式回一句拒绝，不进异常通道 —— 必须单独识别，否则会被当成正常回复。
    const BUSY_MARK = 'Stopped waiting for another Hermes process';
    if (p.acc.includes(BUSY_MARK)) {
      p.status = 'busy';
      if (state.sessionId === sid) {
        ui.note($('#stream').querySelector('.stream-inner'),
          '这条会话正在别处运行（桌面端或另一个客户端），本轮没有执行。等它空下来再发一次即可。', 'warn');
      }
      ui.toast('会话被占用：这一轮没有执行', 'warn', 8000);
      ntfy.notifyEvent('error', {
        title: 'Hermes · 会话被占用',
        text: '这一轮没有执行：这条会话正在别处运行（桌面端或另一个客户端）。',
        tags: ['warning'],
      });
    }

    if (p.status === 'failed') throw new Error(res.error || '这一轮失败了');

    // 收尾：把这条尾巴落成正式行
    const target = final.session_id || sid;
    const finalRows = rowsBySid.get(target) || rows;
    finalRows.push({
      role: 'assistant',
      content: p.acc,
      timestamp: Date.now() / 1000,
      // at 必须带上：这条本地行把整轮（多段正文 + 多个工具）压成了一行，按行推算偏移会把
      // 所有工具都算到末尾 —— 流式期间记下的 at 才是真位置，重画时要沿用它。
      tool_calls: p.tools.map((t) => ({
        id: t.toolCallId, at: t.at, function: { name: t.tool, arguments: t.label || '' },
      })),
    });
    streams.delete(sid);
    if (target !== sid) streams.delete(target);
    setRows(target, finalRows);

    // 手机通知：这一轮完了（页面不在前台时才推；开关与判断都在 notify.js 里）
    ntfy.notifyEvent('done', {
      title: `Hermes · ${shortTitle(target)}`,
      text: p.acc || '(空回复)',
      tags: ['white_check_mark'],
    });

    if (!p.acc && !p.tools.length && p.status === 'completed') {
      ui.toast('回复是空的 —— 后端可能返回了非标准流', 'warn', 6000);
    }
    if (target !== state.sessionId) {
      ui.toast(`另一个会话的回复到了：${shortTitle(target)}`, 'ok', 5000);
    }
    if (state.sessionId === target) {
      paintStream();
      ui.scrollToEnd();
    }
  } catch (err) {
    streams.delete(sid);
    const human = explainError(err, err.status);
    // 通知独立于下面的 UI 分支：explainError 说不出人话时，手机上也该知道这轮挂了
    ntfy.notifyEvent('error', {
      title: 'Hermes · 出错',
      text: human || String((err && err.message) || err),
      tags: ['warning'],
    });
    if (human) {
      // 一条都没收到：撤掉这一轮的 user 行，不留空气泡
      const cur = rowsOf(sid);
      if (!p.acc) {
        const i = cur.lastIndexOf(cur.find((r) => r.role === 'user' && r.content === body));
        if (i >= 0) cur.splice(i, 1);
        setRows(sid, cur);
      } else {
        cur.push({
          role: 'assistant',
          content: p.acc,
          timestamp: Date.now() / 1000,
          tool_calls: p.tools.map((t) => ({ id: t.toolCallId, function: { name: t.tool, arguments: t.label || '' } })),
        });
        setRows(sid, cur);
      }
      if (state.sessionId === sid) {
        paintStream();
        ui.note($('#stream').querySelector('.stream-inner'), human, 'err');
      }
      ui.toast(human, 'err', 8000);
    }
  } finally {
    streams.delete(sid);
    paintSidebar();
    refreshTopTitle();
    refreshStopButton();
    setConn(hasAnyStream() ? 'busy' : 'on', hasAnyStream() ? `${streams.size} 个生成中` : '已连接');
    if (state.sessionId === sid) focusInput();
    // 列表里的 message_count / tokens / 首轮标题都是服务端算的，拉一次同步
    void loadList({ silent: true });
  }
}

function shortTitle(sid) {
  const s = state.list.find((x) => x.id === sid);
  const t = (s && s.title) || sid;
  return t.length > 24 ? t.slice(0, 24) + '…' : t;
}

/* ══════════════ 导出当前会话 ══════════════ */

async function exportChat() {
  const sid = state.sessionId;
  if (!sid) { ui.toast('还没有打开会话', 'warn'); return; }
  const c = config.get();
  let rows = rowsOf(sid);
  try {
    const { data, truncated } = await loadHistory(c.baseUrl, c.key, sid, { pageSize: 500, maxPages: 12 });
    rows = data;
    if (truncated) ui.toast(`会话太长，导出的是最近 ${data.length} 条`, 'warn', 6000);
  } catch { /* 用本地缓存兜底 */ }

  const s = activeRow();
  const lines = [
    `# ${(s && s.title) || sid}`,
    '',
    `> 会话 id \`${sid}\`　导出时间 ${new Date().toLocaleString()}　source: ${(s && s.source) || '?'}`,
    '',
  ];
  for (const r of rows) {
    if (r.role !== 'user' && r.role !== 'assistant') continue;
    const content = ui.normContent(r.content);
    const tools = r.role === 'assistant' ? ui.toolsFromRow(r) : [];
    if (!content && !tools.length) continue;
    const when = r.timestamp ? new Date(r.timestamp * 1000).toLocaleString() : '';
    lines.push(`### ${r.role === 'user' ? '你' : 'Hermes'}${when ? ' · ' + when : ''}`);
    if (tools.length) lines.push('', '_工具调用：' + tools.map((t) => `\`${t.tool}\``).join(', ') + '_');
    if (content) lines.push('', content);
    lines.push('');
  }
  const name = ((s && s.title) || sid || 'chat').replace(/[^\w\u4e00-\u9fa5-]+/g, '_').slice(0, 60);
  download(`${name}.md`, lines.join('\n'), 'text/markdown');
}

/* ══════════════ 首次配置 ══════════════ */

function showSetup(msg) {
  $('#setup').hidden = false;
  $('#app').hidden = true;
  const c = config.get();
  const fromUrl = new URLSearchParams(location.search).get('base');
  $('#s-base').value = c.baseUrl || fromUrl || '';
  $('#s-key').value = c.key || '';
  const m = $('#s-msg');
  m.className = 'msg' + (msg ? ' warn' : '');
  m.textContent = msg || '';
  setTimeout(() => $('#s-base').focus(), 60);
}

async function showApp() {
  $('#setup').hidden = true;
  $('#app').hidden = false;

  // 先用缓存秒开，再拉服务端
  const cachedList = cache.getList();
  if (cachedList.length) {
    state.list = cachedList;
    paintSidebar();
    if (!state.sessionId) {
      state.sessionId = cachedList[0].id;
      const cachedMsgs = cache.getMessages(state.sessionId);
      if (cachedMsgs) { rowsBySid.set(state.sessionId, cachedMsgs); paintStream(); ui.scrollToEnd(true); }
    }
  }
  refreshChrome();

  const ok = await checkConnection();
  if (!ok) { paintSidebar(); return; }

  await loadList();
  if (!state.sessionId && state.list.length) {
    await openSession(state.list[0].id);
  } else {
    paintStream();
  }
}

/* ══════════════ 接线 ══════════════ */

const settings = initSettings({
  onConfigChange: () => { refreshChrome(); void showApp(); },
  onThemeChange: applyTheme,
  onPrefsChange: () => paintStream(),
  onWipe: () => {
    for (const sid of streams.keys()) abortStream(sid, { silent: true });
    streams.clear();
    rowsBySid.clear();
    state.sessionId = null;
    state.list = [];
    setConn('', '未连接');
    showSetup('本机数据已清除（服务端会话仍在）。');
  },
});

function wire() {
  /* 配置页 */
  $('#setup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const base = normalizeBase($('#s-base').value);
    const key = $('#s-key').value.trim();
    const m = $('#s-msg');
    if (!base || !key) { m.className = 'msg err'; m.textContent = 'Base URL 和 API Key 都要填。'; return; }
    config.set({ baseUrl: base, key, model: config.get().model || 'hermes-agent' });
    m.className = 'msg ok'; m.textContent = '已保存，正在读取会话…';
    await showApp();
  });
  $('#s-reveal').addEventListener('click', () => {
    const i = $('#s-key');
    i.type = i.type === 'password' ? 'text' : 'password';
  });
  $('#s-test').addEventListener('click', async () => {
    const m = $('#s-msg');
    const base = normalizeBase($('#s-base').value);
    const key = $('#s-key').value.trim();
    if (!base || !key) { m.className = 'msg err'; m.textContent = 'Base URL 和 API Key 都要填。'; return; }
    m.className = 'msg'; m.textContent = '测试中…';
    try {
      const { models } = await listModels(base, key);
      let hist = '';
      try {
        const { data } = await listSessions(base, key, { limit: 1 });
        const s = data[0];
        hist = `　历史可读 ✓（最新：${s ? (s.title || s.id) : '暂无'}）`;
      } catch (e2) {
        hist = `　⚠️ 历史读不到：${explainError(e2, e2.status) || e2.message}`;
      }
      m.className = 'msg ok';
      m.textContent = '连接成功 ✓　模型：' + (models.join(', ') || '(未列出)') + hist;
    } catch (err) {
      m.className = 'msg err';
      m.textContent = explainError(err, err.status) || String(err.message || err);
    }
  });

  /* 侧栏 */
  $('#new-chat').addEventListener('click', () => void newChat());
  $('#side-open').addEventListener('click', openSidebar);
  $('#side-close').addEventListener('click', closeSidebar);
  $('#scrim').addEventListener('click', closeSidebar);
  $('#filter').addEventListener('input', (e) => { state.filter = e.target.value; paintSidebar(); });
  $('#nav').addEventListener('click', (e) => {
    const b = e.target.closest('.nav-item');
    if (b) setView(b.dataset.view);
  });
  const refreshBtn = $('#top-refresh');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', async () => {
      await loadList({ silent: true });
      if (state.sessionId && !isStreaming(state.sessionId)) {
        await openSession(state.sessionId, { force: true });
      }
      ui.toast('已从服务端刷新', 'ok', 2200);
    });
  }

  /* composer */
  const ta = $('#input');
  $('#composer').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = ta.value;
    if (!v.trim() && !pendingImages.length) return;      // 只发图片也允许
    if (prefs.get().clearAfter !== false) { ta.value = ''; autoGrow(); }
    void send(v);
  });
  /* 图片：文件选择 + 直接粘贴截图 */
  $('#pick-image')?.addEventListener('click', () => $('#image-input')?.click());
  $('#image-input')?.addEventListener('change', (e) => {
    void addImages([...e.target.files]);
    e.target.value = '';                                 // 清空才能连续选同一张
  });
  ta.addEventListener('paste', (e) => {
    const files = [...((e.clipboardData && e.clipboardData.files) || [])]
      .filter((f) => f.type && f.type.startsWith('image/'));
    if (!files.length) return;                           // 纯文本粘贴照旧
    e.preventDefault();
    void addImages(files);
  });
  ta.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    // 移动端软键盘 Enter 换行；桌面端 Enter 发送
    const isTouch = window.matchMedia('(hover: none)').matches;
    if (isTouch && !e.metaKey && !e.ctrlKey) return;
    if (e.shiftKey || e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    $('#composer').requestSubmit();
  });
  ta.addEventListener('input', autoGrow);
  ta.addEventListener('focus', () => { setTimeout(() => { ui.scrollToEnd(); }, 260); });

  /* 停止：先让服务端停 run，再断本地事件流（只停当前会话） */
  $('#stop-btn').addEventListener('click', async () => {
    const p = activeStream();
    if (!p) { ui.toast('当前会话没有在生成', 'warn', 2500); return; }
    if (p.runId) {
      try { await stopRun(config.get().baseUrl, config.get().key, p.runId); }
      catch { /* run 可能刚好结束，忽略 */ }
    }
    abortStream(state.sessionId);
  });
  $('#export-chat').addEventListener('click', () => void exportChat());

  /* 全局快捷键 */
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if ($('#sidebar').classList.contains('open') || window.innerWidth >= 768) $('#filter').focus();
      else openSidebar();
      setTimeout(() => $('#filter').focus(), 60);
    }
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'r') {
      e.preventDefault();
      if (refreshBtn) refreshBtn.click();
    }
    if (e.key === 'Escape') closeSidebar();
  });

  /* 移动端：软键盘弹出时把 composer 顶上来（visualViewport 是唯一可靠信号） */
  const vv = window.visualViewport;
  if (vv) {
    const onVV = () => {
      const gap = window.innerHeight - vv.height;
      document.documentElement.style.setProperty('--kb', gap > 80 ? gap + 'px' : '0px');
      if (gap > 80) ui.scrollToEnd();
    };
    vv.addEventListener('resize', onVV);
    vv.addEventListener('scroll', onVV);
    onVV();
  }
  window.addEventListener('resize', () => autoGrow());
}

/* ══════════════ 启动 ══════════════ */

function boot() {
  applyTheme(prefs.get().theme);
  wire();
  ui.watchScroll();

  if (config.ok()) void showApp();
  else showSetup();

  const b = $('#boot');
  b.classList.add('gone');
  setTimeout(() => b.remove(), 240);

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register(new URL('./sw.js', location.href), { scope: './' })
      .then((reg) => {
        // 新 SW 接管后自动刷新一次：否则"部署 → 打开页面"看到的还是旧 css/js（要刷两次）。
        // 只在**本来就有 controller**（= 这是一次更新，不是首次安装）时刷，并用 sessionStorage
        // 兜一层，杜绝任何刷新循环。
        if (navigator.serviceWorker.controller) {
          navigator.serviceWorker.addEventListener('controllerchange', () => {
            if (sessionStorage.getItem('hlw-sw-reloaded') === '1') return;
            sessionStorage.setItem('hlw-sw-reloaded', '1');
            location.reload();
          });
        }
        void reg.update?.();
      })
      .catch(() => {});
  }

  // 从后台切回来：刷新连接与列表（别的设备/桌面端可能刚改了会话）
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !config.ok()) return;
    void checkConnection();
    void loadList({ silent: true });
  });
}

boot();

/* 全局可观测：便于排查（不含密钥） */
window.__hermesChat = {
  version: APP_VERSION,
  get state() {
    const { list, ...rest } = state;
    return {
      ...rest,
      list: list.length,
      rows: rowsBySid.get(state.sessionId)?.length || 0,
      streaming: [...streams.keys()],
    };
  },
  get sessions() { return state.list.map((s) => ({ id: s.id, source: s.source, title: s.title, messages: s.message_count })); },
  get rows() { return rowsBySid.get(state.sessionId) || []; },
  get streamAcc() { const p = activeStream(); return p ? p.acc : null; },
  // 调试用：当前流里每个工具条记录的 at（= 它出现时正文已流出的字数）
  get streamTools() { const p = activeStream(); return p ? p.tools.map((t) => ({ tool: t.tool, at: t.at, status: t.status })) : []; },
  /** 浏览器侧收到的事件顺序（含到达时的累计正文长度），排查工具条位置用 */
  get eventLog() { return evLog.slice(-120); },
  resetEventLog() { evLog = []; return true; },
  exportAll,
  openSession,
  loadList,
  newChat,
};
