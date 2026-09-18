/**
 * ui.js —— 渲染层（会话列表 / 消息流 / 工具调用 / 状态条 / Toast）
 *
 * 数据形态来自 Hermes api_server 的原生会话面，所以这里有两件事和"纯本地版"不同：
 *  1. 会话行的字段是服务端的（title / source / message_count / last_active / input_tokens …）
 *  2. 历史消息里混着 role:"tool" 与带 tool_calls 的 assistant 行 —— 要映射成工具条，
 *     否则共享过来的桌面端对话会显示成一堆空气泡。
 */

import { $, el, icon, escapeHtml, fmtTime, fmtClock, copyText } from './util.js';
import { render as renderMd, extractCode, plainText } from './markdown.js';

const P = {
  chat: 'M4 4h16v12H7l-3 3V4Z',
  doc: 'M6 2h8l4 4v16H6V2Zm7 1.5V7h3.5L13 3.5Z',
  spark: 'M12 2.6 4.2 7.1v9.8L12 21.4l7.8-4.5V7.1L12 2.6Zm0 3.1 4.9 2.8v5.6L12 16.9l-4.9-2.8V8.5L12 5.7Z',
  warn: 'M12 3 1.5 21h21L12 3Zm-1 7h2v5h-2v-5Zm0 7h2v2h-2v-2Z',
  globe: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm6.9 6h-3a15 15 0 0 0-1.3-3.4A8 8 0 0 1 18.9 8ZM12 4.2c.7 1 1.4 2.3 1.8 3.8h-3.6C10.6 6.5 11.3 5.2 12 4.2ZM4.3 14a8 8 0 0 1 0-4h3.4a19 19 0 0 0 0 4H4.3Zm.8 2h3a15 15 0 0 0 1.3 3.4A8 8 0 0 1 5.1 16Zm3-8h-3a8 8 0 0 1 4.3-3.4A15 15 0 0 0 8.1 8ZM12 19.8c-.7-1-1.4-2.3-1.8-3.8h3.6c-.4 1.5-1.1 2.8-1.8 3.8ZM14.3 14H9.7a17 17 0 0 1 0-4h4.6a17 17 0 0 1 0 4Zm.3 5.4A15 15 0 0 0 15.9 16h3a8 8 0 0 1-4.3 3.4Zm1.7-5.4a19 19 0 0 0 0-4h3.4a8 8 0 0 1 0 4h-3.4Z',
  chip: 'M9 3h6v2h-1v3.2l4.6 8A2 2 0 0 1 16.9 20H7.1a2 2 0 0 1-1.7-2.8L10 8.2V5H9V3Z',
};

/* 历史工具行的 emoji 兜底（服务端只在实时事件里带 emoji） */
const TOOL_EMOJI = {
  terminal: '💻', shell: '💻', read_file: '📄', write_file: '✍️', patch: '🩹',
  search_files: '🔎', web_search: '🔍', browser_navigate: '🌐', browser_exec: '🌐',
  delegate_task: '🤖', memory: '🧠', skill_view: '📘', skills_list: '📚',
  todo_list: '☑️', cronjob_manage: '⏰', read_window_below: '🪟', vision_analyze: '👁️',
};

/* 会话来源 → 中文徽章（让用户一眼看出这条是桌面端来的还是网页来的） */
const SOURCE_LABEL = {
  desktop: '桌面端', api_server: '网页', cli: 'CLI', telegram: 'TG', discord: 'Discord',
  slack: 'Slack', weixin: '微信', wechat: '微信', whatsapp: 'WhatsApp', cron: '定时',
  tui: 'TUI', webhook: 'Webhook', kanban: '看板', relay: 'Relay', acp: 'IDE',
};

export const sourceLabel = (s) => SOURCE_LABEL[s] || s || '其他';

/* ══════════════ Toast ══════════════ */

export function toast(message, kind = '', ms = 4200) {
  const box = $('#toasts');
  const node = el('div', { class: 'toast' + (kind ? ' ' + kind : ''), text: message });
  box.append(node);
  const kill = () => {
    node.style.transition = 'opacity .18s';
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 200);
  };
  node.addEventListener('click', kill);
  setTimeout(kill, ms);
  return node;
}

/* ══════════════ 会话列表（服务端会话） ══════════════ */

function sessionMeta(s) {
  const bits = [];
  if (s.message_count) bits.push(`${s.message_count} 条`);
  else bits.push('空');
  if (s.tool_call_count) bits.push(`${s.tool_call_count} 工具`);
  const ts = (s.last_active || s.started_at) * 1000;
  if (ts) bits.push(fmtTime(ts));
  return bits.join(' · ');
}

export function renderSessions(list, activeId, { onPick, onDelete, onRename, loading, generating } = {}) {
  const box = $('#side-list');
  box.innerHTML = '';

  if (loading) {
    box.append(el('div', { class: 'side-empty', text: '加载中…' }));
    return;
  }
  if (!list.length) {
    box.append(el('div', { class: 'side-empty', text: '没有匹配的会话' }));
    return;
  }

  const busySet = generating instanceof Set ? generating : new Set();

  for (const s of list) {
    const isGen = busySet.has(s.id);
    const item = el('div', {
      class: 'side-item' + (s.id === activeId ? ' active' : '') + (isGen ? ' gen' : ''),
      role: 'button',
      tabIndex: 0,
      title: s.title || s.id,
      onclick: () => onPick(s.id),
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(s.id); } },
    }, [
      isGen ? el('span', { class: 'spinner', 'aria-label': '生成中' }) : icon(P.chat, 15),
      el('div', { class: 'body' }, [
        el('div', { class: 'ti', text: s.title || '(无标题)' }),
        el('div', { class: 'meta' }, [
          el('span', { class: 'src ', text: sourceLabel(s.source) + '　' }),
          document.createTextNode((isGen ? '生成中 · ' : '') + sessionMeta(s)),
        ]),
      ]),
      el('button', {
        class: 'del',
        type: 'button',
        title: '删除',
        'aria-label': '删除会话',
        onclick: (e) => { e.stopPropagation(); onDelete(s); },
      }, ['×']),
    ]);

    const ti = item.querySelector('.ti');
    const startRename = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const next = prompt('重命名会话（会同步到桌面端）', s.title || '');
      if (next != null && next.trim()) onRename(s.id, next.trim());
    };
    ti.addEventListener('dblclick', startRename);
    let holdTimer = null;
    item.addEventListener('touchstart', () => { holdTimer = setTimeout(startRename, 620); }, { passive: true });
    ['touchend', 'touchmove', 'touchcancel'].forEach((ev) =>
      item.addEventListener(ev, () => clearTimeout(holdTimer), { passive: true }));

    box.append(item);
  }
}

/* ══════════════ 消息流 ══════════════ */

/** 内容可能是字符串，也可能是多模态数组 —— 统一成纯文本 */
export function normContent(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.map((p) => {
      if (typeof p === 'string') return p;
      if (p && typeof p === 'object') {
        const t = String(p.type || '');
        // 图片部件单独画成缩略图，不进正文（否则会出现一行 "[image_url]"）
        if (t === 'image_url' || t === 'input_image') return '';
        return p.text || p.content || (p.type ? `[${p.type}]` : '');
      }
      return '';
    }).filter(Boolean).join('\n');
  }
  if (c && typeof c === 'object') return c.text || c.content || '';
  return '';
}

/** 从 assistant 行的 tool_calls 造出工具条数据 */
export function toolsFromRow(row) {
  const calls = Array.isArray(row.tool_calls) ? row.tool_calls : [];
  return calls.map((tc) => {
    const name = (tc && tc.function && tc.function.name) || (tc && tc.name) || 'tool';
    let args = (tc && tc.function && tc.function.arguments) || tc?.arguments || '';
    if (typeof args === 'object') args = JSON.stringify(args);
    const preview = String(args).replace(/\s+/g, ' ').slice(0, 80);
    return {
      tool: name,
      toolCallId: (tc && (tc.id || tc.call_id)) || '',
      emoji: TOOL_EMOJI[name] || '🔧',
      label: preview,
      status: 'completed',
      // 本地那条合并行会带上流式期间记下的 at；服务端行没有这个字段（那种情况由
      // renderStream 按行序推算），这里只做透传，别填默认值。
      at: (tc && Number.isFinite(tc.at)) ? tc.at : undefined,
    };
  });
}

/** 服务端行里的图片部件（用户发过的图） */
export function imagesFromRow(row) {
  const c = row && row.content;
  if (!Array.isArray(c)) return [];
  const out = [];
  for (const p of c) {
    if (!p || typeof p !== 'object') continue;
    const t = String(p.type || '');
    if (t !== 'image_url' && t !== 'input_image') continue;
    const ref = p.image_url;
    const url = typeof ref === 'string' ? ref : (ref && ref.url) || p.url || '';
    if (url) out.push({ url });
  }
  return out;
}

/** 服务端消息行 → 是否值得画成一条 turn */
export function rowToTurn(row) {
  const role = row.role;
  if (role !== 'user' && role !== 'assistant') return null;     // tool / system 行不单独画
  const content = normContent(row.content);
  const tools = role === 'assistant' ? toolsFromRow(row) : [];
  // 图片有两个来源：刚发出去那条本地行把预览地址放在 row.images 上；
  // 服务端历史回来的行则是 content 里的 image_url 部件。
  const images = role === 'user'
    ? [...(Array.isArray(row.images) ? row.images : []), ...imagesFromRow(row)]
    : [];
  if (!content && !tools.length && !images.length) return null;
  return {
    role,
    content,
    tools,
    images,
    at: row.timestamp ? row.timestamp * 1000 : null,
    tokens: typeof row.token_count === 'number' ? row.token_count : null,
  };
}

/**
 * 把服务端行画成消息流。
 *
 * 一条回复 = 从某个 assistant 行起、到下一个 user 行为止的所有 assistant 行（中间的 tool 结果行
 * 不打断）。按行序累积正文，每遇到一次工具调用就把它记在**当时的正文长度**上（`at`），
 * 交给 renderReply 交错渲染。这样"正文 → 工具 → 正文 → 工具"的真实次序就还原了。
 */
export function renderStream(rows, { onPickPrompt } = {}) {
  const box = $('#stream');
  box.innerHTML = '';
  const inner = el('div', { class: 'stream-inner' });
  box.append(inner);

  const list = rows || [];
  if (!list.length) {
    inner.append(emptyState(onPickPrompt));
    return { inner, bubble: null, count: 0 };
  }

  let last = null;
  for (let i = 0; i < list.length;) {
    const row = list[i];

    if (row.role === 'user') {
      const t = rowToTurn(row);
      if (t) last = appendTurn(inner, t);
      i += 1;
      continue;
    }
    if (row.role !== 'assistant') { i += 1; continue; }   // tool / system 行不单独画

    let content = '';
    const tools = [];
    let at = null;
    for (; i < list.length && list[i].role !== 'user'; i += 1) {
      const r = list[i];
      if (r.role !== 'assistant') continue;
      if (at === null) at = r.timestamp ? r.timestamp * 1000 : null;
      const chunk = normContent(r.content);
      if (chunk) content += chunk;      // 同一行里：正文先写、工具后调 → 工具落在正文之后
      for (const call of toolsFromRow(r)) {
        // 行里自带 at（本地合并行）就用它；服务端的多行历史没有 at，按当前累计长度推算
        tools.push({ ...call, at: Number.isFinite(call.at) ? call.at : content.length });
      }
    }
    if (!content && !tools.length) continue;             // 整段只有工具结果行 → 不画
    last = appendTurn(inner, { role: 'assistant', content, tools, at });
  }

  return { inner, ...(last || {}), count: list.length };
}

function emptyState(onPickPrompt) {
  const prompts = [
    '今天有什么安排？',
    '列一下当前目录的文件',
    '跑一下 date 看时间',
    '帮我把这段话翻译成英文',
  ];
  return el('div', { class: 'empty' }, [
    icon(P.spark, 46),
    el('h2', { text: '开始对话' }),
    el('p', { text: '会话与桌面端共用同一份历史。消息会发给你自己的 Hermes agent，它带完整工具能力：终端、文件、联网、技能、记忆。' }),
    el('div', { class: 'chips' }, prompts.map((p) =>
      el('button', { class: 'chip', type: 'button', text: p, onclick: () => onPickPrompt && onPickPrompt(p) }))),
  ]);
}

/** 把一条消息画成一个 turn，返回句柄供流式更新 */
export function appendTurn(inner, msg) {
  const isUser = msg.role === 'user';
  const turn = el('div', { class: 'turn ' + msg.role });

  turn.append(el('div', { class: 'turn-head' }, [
    el('span', { class: 'avatar' + (isUser ? ' you' : ''), text: isUser ? 'Y' : 'H' }),
    el('span', { class: 'who', text: isUser ? 'You' : 'Hermes' }),
    el('span', { class: 'when', text: msg.at ? fmtClock(msg.at) : '' }),
  ]));

  const bubble = el('div', { class: 'bubble' });
  if (isUser) paintBubble(bubble, msg);
  else renderReply(bubble, msg.content, msg.tools);   // 工具条按 at 交错在正文里

  turn.append(bubble);
  if (!isUser && msg.tokens) turn.append(el('div', { class: 'meta', text: `${msg.tokens.toLocaleString()} tokens` }));
  if (!isUser && msg.usage) turn.append(usageLine(msg.usage));

  inner.append(turn);
  return { turn, bubble };
}

function paintBubble(bubble, msg) {
  if (msg.role === 'user') {
    // 本地那条行 content 是字符串、图片在 msg.images（blob: 预览地址）；
    // 服务端历史回来的行 content 是多模态部件数组，图片走 imagesFromRow
    const imgs = msg.images || [];
    if (imgs.length) {
      bubble.append(el('div', { class: 'atts' }, imgs.map((im) =>
        el('img', { src: im.url, alt: '图片', title: im.w ? `${im.w}×${im.h}` : '' }))));
    }
    if (typeof msg.content === 'string' && msg.content) {
      bubble.append(document.createTextNode(msg.content));
    }
    return;
  }
  bubble.innerHTML = renderMd(msg.content || '');
  wireCodeCopy(bubble);
}

function wireCodeCopy(root) {
  root.querySelectorAll('.copy').forEach((btn) => {
    if (btn.dataset.wired) return;
    btn.dataset.wired = '1';
    btn.addEventListener('click', async () => {
      const ok = await copyText(extractCode(root, +btn.dataset.code));
      const old = btn.textContent;
      btn.textContent = ok ? '已复制' : '复制失败';
      setTimeout(() => { btn.textContent = old; }, 1400);
    });
  });
}

export function usageLine(usage) {
  const t = (n) => (typeof n === 'number' ? n.toLocaleString() : '?');
  return el('div', {
    class: 'meta',
    text: `tokens ${t(usage.prompt_tokens)} → ${t(usage.completion_tokens)}（共 ${t(usage.total_tokens)}）`,
  });
}

/* ══════════════ 工具调用 ══════════════ */

export function toolChip(t) {
  return el('div', {
    class: 'tool ' + (t.status === 'running' ? 'running' : 'done'),
    dataset: { tcid: t.toolCallId || '' },
    title: t.label ? `${t.tool} ${t.label}` : t.tool,
  }, [
    el('span', { class: 'spin' }),
    el('span', { class: 'em', text: t.emoji || '🔧' }),
    el('span', { class: 'lb', text: t.label ? `${t.tool}: ${t.label}` : (t.tool || 'tool') }),
  ]);
}

/**
 * 把一条回复画成"正文 / 工具条"交错的块序列。
 *
 * 服务端把一个回合存成多行，且 assistant 行常常「只有 tool_calls、content 为空」，所以工具在
 * 时间轴上的位置只能靠一个量还原：**它发生时正文已经流出了多少字**（`at`，正文里的字符偏移）。
 * 没有它就只有一条路可走 —— 把整条回复的工具全堆到正文前面，那就是用户报的 bug。
 *
 * 这个模型直接来自 Hermes-Lens 的同款修复（commit ddf69bd "interleave tool calls in streaming
 * reply"：`toolNotes: string[]` 换成 `toolMarks: {label, at}[]`，渲染时按 at 把正文切段与工具行
 * 交错输出）。这里保持一致，流式与历史走同一个渲染器。
 */
export function renderReply(container, content, tools) {
  container.innerHTML = '';
  const text = content || '';

  // 同一个 at 上的多个工具合成一块（一轮里常常并行调几个）
  const groups = new Map();
  for (const t of (tools || [])) {
    if (!t) continue;
    const at = Number.isFinite(t.at) ? Math.max(0, Math.min(t.at, text.length)) : text.length;
    if (!groups.has(at)) groups.set(at, []);
    groups.get(at).push(t);
  }

  const addText = (slice) => {
    if (!slice) return;
    const seg = el('div', { class: 'seg-text' });
    seg.innerHTML = renderMd(slice);
    wireCodeCopy(seg);
    container.append(seg);
  };

  let cursor = 0;
  for (const at of [...groups.keys()].sort((a, b) => a - b)) {
    addText(text.slice(cursor, at));
    cursor = at;
    container.append(el('div', { class: 'seg-tools' }, groups.get(at).map(toolChip)));
  }
  addText(text.slice(cursor));
}

/** 流式期间重画同一条回复（累积文本留在内存，不要每个 token 写 localStorage） */
export function renderReplyInto(bubble, content, tools) {
  renderReply(bubble, content, tools);
}

/* ══════════════ 连接状态 & 状态条 ══════════════ */

export function setConn(state, text) {
  const c = $('#conn');
  c.className = 'conn ' + state;
  $('#conn-text').textContent = text;
  c.title = text;
}

export function renderStatusbar({ conn, model, sessions, messages, tokens, generating, version }) {
  const bar = $('#statusbar');
  bar.innerHTML = '';
  const sep = () => el('span', { text: '·' });
  const push = (k, v) => bar.append(el('span', {}, [`${k} `, el('b', { text: String(v) })]), sep());

  push('状态', conn);
  push('模型', model || '—');
  push('会话', sessions);
  push('消息', messages);
  if (tokens) push('tokens', Number(tokens).toLocaleString());
  if (generating) push('生成中', generating);
  bar.lastChild && bar.lastChild.remove();
  bar.append(el('span', { class: 'spacer' }));
  bar.append(el('span', { class: 'st-ver', text: version || '', title: version || '' }));
}

/* ══════════════ 使用统计页 ══════════════ */

export function renderStats(sum, list) {
  const cards = $('#stat-cards');
  cards.innerHTML = '';
  const card = (k, v, s) => el('div', { class: 'card' }, [
    el('div', { class: 'k', text: k }),
    el('div', { class: 'v', text: String(v) }),
    s ? el('div', { class: 's', text: s }) : null,
  ]);
  const n = (x) => Number(x || 0).toLocaleString();
  cards.append(
    card('会话', sum.sessions, `服务端 state.db（含桌面端）`),
    card('消息', n(sum.messages), `${n(sum.tools)} 次工具调用`),
    card('tokens', n(sum.input + sum.output), `输入 ${n(sum.input)} · 输出 ${n(sum.output)}`),
    card('缓存读取', n(sum.cacheRead), sum.cost ? `累计 $${sum.cost.toFixed(3)}` : '无成本记录'),
  );

  const box = $('#stat-sessions');
  box.innerHTML = '';
  if (!list.length) {
    box.append(el('div', { class: 'side-empty', text: '还没有会话' }));
    return;
  }
  for (const s of list) {
    const ts = (s.last_active || s.started_at) * 1000;
    box.append(el('div', { class: 'stat-row' }, [
      el('span', { class: 'src', text: sourceLabel(s.source) }),
      el('span', { class: 'n', text: s.title || s.id }),
      el('span', {
        class: 'c',
        text: `${s.message_count || 0} 条 · ${Number(s.input_tokens || 0) + Number(s.output_tokens || 0)} tok · ${fmtTime(ts)}`,
      }),
    ]));
  }
}

/* ══════════════ 审批卡片 ══════════════ */

const CHOICE_LABEL = {
  once: '允许一次',
  session: '本会话都允许',
  always: '始终允许',
  deny: '拒绝',
};

/**
 * 审批请求卡片。approval 来自 runs 事件 `approval.request`
 * （字段视工具而定：command / description / tool / preview / request_id），
 * choices 由服务端给出（once | session | always | deny 的子集）。
 */
export function approvalCard({ approval = {}, choices = ['once', 'deny'], onChoose }) {
  const detail = approval.command || approval.description || approval.preview || '';
  const toolName = approval.tool || approval.tool_name || '';

  const card = el('div', { class: 'approval' }, [
    el('div', { class: 'ap-head' }, [
      icon(P.warn, 15),
      el('span', { text: 'Hermes 需要你批准这一步' }),
    ]),
    toolName ? el('div', { class: 'ap-tool', text: '工具：' + toolName }) : null,
    detail ? el('pre', { class: 'ap-cmd', text: String(detail) }) : null,
    el('div', { class: 'ap-actions' }, choices.map((c) => el('button', {
      class: 'btn ' + (c === 'deny' ? 'danger' : (c === 'once' ? 'primary' : '')),
      type: 'button',
      text: CHOICE_LABEL[c] || c,
      onclick: () => onChoose(c),
    }))),
    el('div', { class: 'ap-note', text: '看清楚再批。「拒绝」会让 agent 收到拒绝结果并改走别的做法。' }),
  ]);
  return card;
}

/** 批准后把卡片改成只读回执，避免重复点 */
export function settleApprovalCard(card, choice) {
  if (!card) return;
  card.classList.add('settled');
  const actions = card.querySelector('.ap-actions');
  if (actions) {
    actions.innerHTML = '';
    actions.append(el('span', {
      class: 'ap-done',
      text: '已选择：' + (CHOICE_LABEL[choice] || choice),
    }));
  }
}

/* ══════════════ 回复里的"选择项" ══════════════ */

/**
 * 从助手回复里认出编号/字母选项（Hermes 常用 "1. …" / "A) …" / "一、…" 列方案）。
 * 只在回复末尾连续出现 ≥2 条时才算，避免把正文里的列表误当选择题。
 * @returns {Array<{key:string, label:string}>}
 */
export function optionsFromText(text) {
  const lines = String(text || '').split('\n');
  const re = /^\s{0,3}(?:[-*]\s*)?(?:\*{0,2})(\(?(?:\d{1,2}|[A-Za-z]|[一二三四五六七八九十])\)?)\s*[.、:：)）]\s*\*{0,2}\s*(.{1,120}?)\s*$/;
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re);
    if (m) hits.push({ i, key: m[1].replace(/[()]/g, ''), label: m[2] });
  }
  if (hits.length < 2 || hits.length > 8) return [];
  // 必须是末尾一段连续的（中间最多隔 1 行空行）
  const last = hits[hits.length - 1];
  const tail = lines.slice(last.i + 1).filter((l) => l.trim());
  if (tail.length > 0) return [];
  for (let k = 1; k < hits.length; k++) {
    const gap = lines.slice(hits[k - 1].i + 1, hits[k].i).filter((l) => l.trim());
    if (gap.length > 1) return [];
  }
  return hits.map((h) => ({ key: h.key, label: h.label.replace(/^\*+|\*+$/g, '').trim() }));
}

/** 把选项画成可点的胶囊，点了就把它当回复发出去 */
export function optionChips(options, onPick) {
  if (!options || !options.length) return null;
  return el('div', { class: 'opt-chips' }, [
    el('span', { class: 'opt-lead', text: '点一个直接回复：' }),
    ...options.map((o) => el('button', {
      class: 'chip opt',
      type: 'button',
      title: o.label,
      onclick: () => onPick(o.label),
    }, [
      el('b', { text: o.key }),
      document.createTextNode(' ' + o.label),
    ])),
  ]);
}

/* ══════════════ 滚动 ══════════════ */

let pinned = true;

export function watchScroll() {
  const box = $('#stream');
  const update = () => { pinned = box.scrollHeight - box.scrollTop - box.clientHeight < 140; };
  box.addEventListener('scroll', update, { passive: true });
  update();
  return () => pinned;
}

export function scrollToEnd(force = false) {
  const box = $('#stream');
  if (!force && !pinned) return;
  box.scrollTop = box.scrollHeight;
}

export function isPinned() { return pinned; }

/* ══════════════ 杂项 ══════════════ */

export function note(inner, text, kind = '', { replace = true } = {}) {
  if (!inner) return null;
  if (replace) inner.querySelectorAll('.note.tmp').forEach((n) => n.remove());
  const n = el('div', { class: 'note tmp ' + kind }, [
    icon(P.warn, 14),
    el('span', { text }),
  ]);
  inner.append(n);
  scrollToEnd(true);
  return n;
}

export function sessionTitleFrom(text) {
  const t = plainText(text);
  return t.length > 30 ? t.slice(0, 30) + '…' : (t || '新对话');
}

export { escapeHtml };
