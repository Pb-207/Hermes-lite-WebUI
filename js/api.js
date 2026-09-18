/**
 * api.js —— Hermes api_server 客户端（OpenAI 兼容面 + 原生会话面）
 *
 * 两条面：
 *  A. 会话（与桌面端 / CLI 共用同一个 state.db）
 *     GET    /api/sessions?limit=&offset=&source=   列表
 *     POST   /api/sessions                          新建（返回 id）
 *     GET    /api/sessions/{id}/messages            历史消息（含 tool / tool_calls 行）
 *     PATCH  /api/sessions/{id}                     改标题 / pinned / archived
 *     DELETE /api/sessions/{id}                     删除
 *  B. 对话
 *     GET  {base}/models                            探测 + 模型列表
 *     POST {base}/chat/completions                  stream:true 走 SSE
 *
 * 共享历史的关键：POST /v1/chat/completions 带上 `X-Hermes-Session-Id` 头，
 * 服务端就拿 state.db 里的历史「替换」请求体里的 messages（源码注释：
 * "continues an existing session (history from state.db, not the body)"），
 * 所以每次只发当轮那一条 user 消息即可。该头必须配合 API Key（否则 403）。
 *
 * Hermes 专有 SSE 事件（不渲染的话工具调用期间界面是空白）：
 *   event: hermes.tool.progress
 *   data: {"tool":"terminal","emoji":"💻","label":"date","toolCallId":"...","status":"running"|"completed"}
 */

import { normalizeBase } from './store.js';

/** 把 fetch/HTTP 失败翻译成用户能自己动手修的话 */
export function explainError(err, status) {
  const msg = String((err && err.message) || err || '');
  if (err && err.name === 'AbortError') return null;

  if (/Failed to fetch|NetworkError|Load failed|Network request failed/i.test(msg)) {
    return '连不上：地址写错了、网络不通，或者该地址没放行跨源（打开浏览器控制台会看到 CORS 报错）。'
         + '若页面是 https，接口也必须是 https。';
  }
  if (status === 401) return 'API Key 不对（401）。';
  if (status === 403) return '被拒绝（403）：来源未放行、该 Key 无权；也可能是服务端没配 API_SERVER_KEY —— 会话续写强制要求鉴权。';
  if (status === 404) return '路径不存在（404）：Base URL 可能多写或少写了 /v1，或该会话已被删除。';
  if (status === 429) return '触发限流（429），稍后再试。';
  if (status === 503) return '服务端不可用（503）：网关可能正在重启。';
  if (status >= 500) return `服务端错误（${status}），看对方网关日志。`;
  return msg || '请求失败';
}

async function readError(res) {
  const txt = await res.text().catch(() => '');
  let detail = txt.slice(0, 400);
  try {
    const j = JSON.parse(txt);
    detail = (j.error && (j.error.message || j.error)) || j.message || detail;
    if (typeof detail === 'object') detail = JSON.stringify(detail).slice(0, 400);
  } catch {}
  return detail;
}

function authHeaders(key) {
  return { Authorization: 'Bearer ' + key, Accept: 'application/json' };
}

/** 由对话 base（…/v1）推出站点根，用于 /api/sessions 这套原生路由 */
function siteRoot(baseUrl) {
  return normalizeBase(baseUrl).replace(/\/v1$/i, '');
}

async function req(url, { method = 'GET', key, body, signal } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      ...authHeaders(key),
      ...(body != null ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body != null ? JSON.stringify(body) : undefined,
    signal,
  });
  if (!res.ok) {
    const detail = await readError(res);
    const e = new Error(detail || `HTTP ${res.status}`);
    e.status = res.status;
    throw e;
  }
  const txt = await res.text();
  try { return JSON.parse(txt); } catch { return null; }
}

/* ══════════════ B. 探测 / 模型 ══════════════ */

export async function listModels(baseUrl, key, { signal } = {}) {
  const base = normalizeBase(baseUrl);
  const res = await fetch(base + '/models', { headers: authHeaders(key), signal });
  if (!res.ok) throw new Error(await readError(res));
  const body = await res.json().catch(() => null);
  const models = ((body && body.data) || []).map((m) => m && m.id).filter(Boolean);
  return { models, base };
}

export async function ping(baseUrl, key, { signal } = {}) {
  const root = siteRoot(baseUrl);
  // /health 无需鉴权；失败就退回 /models（那个能验证 Key）
  try {
    const res = await fetch(root + '/health', { signal });
    if (res.ok) return { ok: true, via: 'health' };
  } catch {}
  const { models } = await listModels(baseUrl, key, { signal });
  return { ok: true, via: 'models', models };
}

/* ══════════════ A. 会话面 ══════════════ */

/** 列表 → { data:[session], hasMore } */
export async function listSessions(baseUrl, key, { limit = 60, offset = 0, source, signal } = {}) {
  const q = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (source) q.set('source', source);
  const d = await req(`${siteRoot(baseUrl)}/api/sessions?${q}`, { key, signal });
  return { data: (d && d.data) || [], hasMore: Boolean(d && d.has_more), raw: d };
}

/** 历史消息 → { data:[message], pagination }
 *  order: 'latest' 从最新往回取（推荐）；'oldest' 从最旧往后取。
 *  注意 limit 服务端硬上限 500，且 pagination 里没有 total —— 判断"还有没有更早的"
 *  只能靠 returned == limit。 */
export async function getMessages(baseUrl, key, id, { limit = 500, offset = 0, order = 'latest', signal } = {}) {
  const q = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (order) q.set('order', order);
  const d = await req(
    `${siteRoot(baseUrl)}/api/sessions/${encodeURIComponent(id)}/messages?${q}`,
    { key, signal });
  return { data: (d && d.data) || [], pagination: d && d.pagination, raw: d };
}

export async function createSession(baseUrl, key, { title, model, signal } = {}) {
  const body = {};
  if (title) body.title = title;
  if (model) body.model = model;
  const d = await req(`${siteRoot(baseUrl)}/api/sessions`, { method: 'POST', key, body, signal });
  const s = (d && (d.session || d.data)) || d || {};
  return { id: s.id || s.session_id || null, raw: d };
}

export async function patchSession(baseUrl, key, id, patch, { signal } = {}) {
  return req(`${siteRoot(baseUrl)}/api/sessions/${encodeURIComponent(id)}`,
    { method: 'PATCH', key, body: patch, signal });
}

export async function deleteSession(baseUrl, key, id, { signal } = {}) {
  return req(`${siteRoot(baseUrl)}/api/sessions/${encodeURIComponent(id)}`,
    { method: 'DELETE', key, signal });
}

/* ══════════════ B. 流式对话（可续写会话） ══════════════ */

/**
 * @param {string} [sessionId] 带上 = 续写这个 Hermes 会话；历史由服务端从 state.db 载入
 * @returns {Promise<{content, usage, tools, aborted, sessionId}>}
 */
export async function streamChat({
  baseUrl, key, model = 'hermes-agent', messages, sessionId, signal,
  onDelta, onTool, onUsage, onOpen, onSessionId,
}) {
  const base = normalizeBase(baseUrl);
  const headers = {
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + key,
  };
  if (sessionId) headers['X-Hermes-Session-Id'] = sessionId;

  const res = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers,
    body: JSON.stringify({ model, stream: true, messages }),
    signal,
  });

  if (!res.ok) {
    const detail = await readError(res);
    const e = new Error(detail || `HTTP ${res.status}`);
    e.status = res.status;
    throw e;
  }
  // 服务端回显它实际绑定的会话 id（压缩轮换后可能与请求的不同），以后缀它为准
  const echoed = res.headers.get('X-Hermes-Session-Id');
  if (echoed && onSessionId) onSessionId(echoed);

  if (!res.body) throw new Error('该浏览器不支持流式读取（ReadableStream 缺失）');
  if (onOpen) onOpen();

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let eventName = '';
  let content = '';
  let usage = null;
  const tools = [];
  let aborted = false;

  const handleFrame = (frame) => {
    let ev = eventName;
    const dataLines = [];
    for (const raw of frame.split('\n')) {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      if (!line || line.startsWith(':')) continue;             // keepalive 注释
      if (line.startsWith('event:')) { ev = line.slice(6).trim(); continue; }
      if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    const data = dataLines.join('\n');
    if (!data || data === '[DONE]') return ev;

    let obj;
    try { obj = JSON.parse(data); } catch { return ev; }

    // Hermes 工具进度
    if (ev === 'hermes.tool.progress' || (obj && obj.tool && obj.status)) {
      const id = obj.toolCallId || '';
      let t = tools.find((x) => x.toolCallId === id);
      if (obj.status === 'running') {
        if (!t) {
          t = { tool: obj.tool, emoji: obj.emoji, label: obj.label, toolCallId: id, status: 'running' };
          tools.push(t);
        } else {
          t.status = 'running';
          t.label = obj.label || t.label;
          t.emoji = obj.emoji || t.emoji;
        }
      } else if (t) {
        t.status = 'completed';
      }
      if (onTool) onTool(tools, t);
      return '';
    }

    // 文本增量
    const choice = obj && obj.choices && obj.choices[0];
    if (choice && choice.delta) {
      const d = choice.delta;
      if (typeof d.content === 'string' && d.content) {
        content += d.content;
        if (onDelta) onDelta(content, d.content);
      }
    }
    if (obj && obj.usage) { usage = obj.usage; if (onUsage) onUsage(usage); }
    return ev;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      // SSE 帧以空行分隔；兼容 \n\n 与 \r\n\r\n
      while ((idx = buf.search(/\r?\n\r?\n/)) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + (buf[idx] === '\r' ? 4 : 2));
        eventName = handleFrame(frame);
      }
    }
    if (buf.trim()) handleFrame(buf);
  } catch (e) {
    if (e && e.name === 'AbortError') aborted = true;
    else throw e;
  }

  // 收尾：还挂着的工具标记完成（中断时也会走到这里）
  for (const t of tools) if (t.status === 'running') t.status = 'completed';

  return { content, usage, tools, aborted, sessionId: echoed || sessionId || null };
}

/* ══════════════ C. Runs 面（审批 / 停止 / steer 只能走这里） ══════════════
 *
 * /v1/chat/completions 没有任何审批处理逻辑；要能批准/拒绝工具执行，必须走 runs：
 *   POST /v1/runs                      { input, session_id?, model? } → { run_id, status }
 *   GET  /v1/runs/{id}/events          SSE：message.delta / tool.started / tool.completed /
 *                                       approval.request / run.completed / run.failed / run.cancelled
 *   GET  /v1/runs/{id}                 状态对象（waiting_for_approval 时带 approval 字段）
 *   POST /v1/runs/{id}/approval        { choice: once|session|always|deny, request_id?, all? }
 *   POST /v1/runs/{id}/stop
 *   POST /v1/runs/{id}/steer           { input }
 */

export async function startRun(baseUrl, key, { input, sessionId, model, signal } = {}) {
  const body = { input };
  if (sessionId) body.session_id = sessionId;
  if (model) body.model = model;
  const d = await req(`${siteRoot(baseUrl)}/v1/runs`, { method: 'POST', key, body, signal });
  return { runId: (d && d.run_id) || null, status: (d && d.status) || null, raw: d };
}

export async function getRun(baseUrl, key, runId, { signal } = {}) {
  return req(`${siteRoot(baseUrl)}/v1/runs/${encodeURIComponent(runId)}`, { key, signal });
}

export async function stopRun(baseUrl, key, runId, { signal } = {}) {
  return req(`${siteRoot(baseUrl)}/v1/runs/${encodeURIComponent(runId)}/stop`,
    { method: 'POST', key, body: {}, signal });
}

export async function steerRun(baseUrl, key, runId, input, { signal } = {}) {
  return req(`${siteRoot(baseUrl)}/v1/runs/${encodeURIComponent(runId)}/steer`,
    { method: 'POST', key, body: { input }, signal });
}

export async function resolveApproval(baseUrl, key, runId, { choice, requestId, all } = {}) {
  const body = { choice };
  if (requestId) body.request_id = requestId;
  if (all) body.all = true;
  return req(`${siteRoot(baseUrl)}/v1/runs/${encodeURIComponent(runId)}/approval`,
    { method: 'POST', key, body, signal: undefined });
}

/**
 * 订阅一个 run 的事件流。
 * 每帧形如 `data: {"event":"message.delta","run_id":...,"delta":"..."}`。
 * @returns {Promise<{output, usage, status, aborted}>}
 */
export async function streamRunEvents(baseUrl, key, runId, { signal, onEvent } = {}) {
  const res = await fetch(`${siteRoot(baseUrl)}/v1/runs/${encodeURIComponent(runId)}/events`, {
    headers: { Authorization: 'Bearer ' + key, Accept: 'text/event-stream' },
    signal,
  });
  if (!res.ok) {
    const detail = await readError(res);
    const e = new Error(detail || `HTTP ${res.status}`);
    e.status = res.status;
    throw e;
  }
  if (!res.body) throw new Error('该浏览器不支持流式读取（ReadableStream 缺失）');

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let output = '';
  let usage = null;
  let status = 'running';
  let aborted = false;

  const handleData = (data) => {
    if (!data || data === '[DONE]') return;
    let ev;
    try { ev = JSON.parse(data); } catch { return; }
    const name = ev.event || '';

    if (name === 'message.delta' && typeof ev.delta === 'string') output += ev.delta;
    else if (name === 'run.completed' || name === 'run.failed' || name === 'run.cancelled'
             || name === 'run.interrupted') {
      status = name.slice(4);
      if (typeof ev.output === 'string' && ev.output) output = ev.output;
      if (ev.usage) usage = ev.usage;
    }
    if (onEvent) onEvent(name, ev, { output, usage, status });
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.search(/\r?\n\r?\n/)) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + (buf[idx] === '\r' ? 4 : 2));
        for (const raw of frame.split('\n')) {
          const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
          if (!line || line.startsWith(':')) continue;
          if (line.startsWith('data:')) handleData(line.slice(5).replace(/^ /, ''));
        }
      }
    }
  } catch (e) {
    if (e && e.name === 'AbortError') aborted = true;
    else throw e;
  }

  return { output, usage, status, aborted };
}

/* ══════════════ D. 会话内流式（推荐：共享历史 + 跨源可读） ══════════════
 *
 * POST /api/sessions/{id}/chat/stream   body: { message, model? }
 *
 * 为什么选它（两条硬事实，都实测过）：
 *   1. 共享历史：服务端 `history = await self._conversation_history_for_session(session_id)`
 *      = `db.get_messages_as_conversation(id)`，读的就是 state.db 里那条会话；准入只查
 *      `db.get_session(id)`，不按 source 过滤 → 指向 source=desktop 的会话同样续写。
 *   2. CORS：这个端点在 `api_server.py` 里**手动补了** Access-Control-Allow-Origin
 *      （aiohttp 的 CORS 中间件给 StreamResponse 补头来不及，因为 prepare() 已 flush）。
 *
 * 反面例子：`/v1/runs` + `/v1/runs/{id}/events` —— 那个文件里 `get_messages_as_conversation`
 * 出现 0 次（历史只认请求体里的 conversation_history / previous_response_id），
 * 且它的 SSE 忘了补 CORS 头（`api_server_runs.py:780`）。
 *
 * ⚠️ 这条路径**不注册审批回调**（`register_gateway_notify` 只在 api_server_runs.py 里调用），
 * 所以永远不会产生 approval.request 事件 —— 要审批卡片就只能回 /v1/runs，两者不可兼得。
 *
 * 事件：run.started(run_id, user_message, runtime) / message.started /
 *       assistant.delta(message_id, delta) / tool.progress(message_id, tool_name, delta) /
 *       tool.started|completed|failed(message_id, tool_name, preview, args) /
 *       assistant.completed(session_id, message_id, content, runtime) /
 *       run.completed|failed|cancelled(messages, usage, session_id) / error / done
 */
export async function streamSessionChat(baseUrl, key, sessionId, { message, model, signal, onEvent } = {}) {
  const url = `${siteRoot(baseUrl)}/api/sessions/${encodeURIComponent(sessionId)}/chat/stream`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + key,
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(model ? { message, model } : { message }),
    signal,
  });

  if (!res.ok) {
    const detail = await readError(res);
    const e = new Error(detail || `HTTP ${res.status}`);
    e.status = res.status;
    throw e;
  }
  if (!res.body) throw new Error('该浏览器不支持流式读取（ReadableStream 缺失）');

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let eventName = '';
  let content = '';
  let usage = null;
  let status = 'running';
  let runId = null;
  let effectiveSid = sessionId;
  let error = null;
  let aborted = false;

  const handleFrame = (frame) => {
    let ev = eventName;
    const dataLines = [];
    for (const raw of frame.split('\n')) {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      if (!line || line.startsWith(':')) continue;      // keepalive 注释
      if (line.startsWith('event:')) { ev = line.slice(6).trim(); continue; }
      if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    const data = dataLines.join('\n');
    if (!data || data === '[DONE]') return ev;

    let obj;
    try { obj = JSON.parse(data); } catch { return ev; }

    if (ev === 'run.started') runId = obj.run_id || runId;
    else if (ev === 'assistant.delta') {
      content += obj.delta || '';
    } else if (ev === 'assistant.completed') {
      if (obj.session_id) effectiveSid = obj.session_id;
      // ⚠️ 别用它的 content 覆盖累积文本。实测（_tools/dump_stream.py 打原始帧）：
      // 这条端点把**整轮**正文都用同一个 message_id 的 deltas 流出来，而
      // assistant.completed.content 只有**最后一段** —— 一轮 17 字（"甲：准备 / 乙：读文件 / 丙：完成"）
      // 对应 completed 只有 4 字（"丙：完成"）。用后者覆盖就会把前面几段正文抹掉，
      // 工具条的 at 超过新长度再被钳到末尾 —— 症状就是"工具调用全挤在回复末尾"。
      // 只在完全没有增量时当兜底。
      if (typeof obj.content === 'string' && obj.content && !content) content = obj.content;
    } else if (ev === 'run.completed' || ev === 'run.failed' || ev === 'run.cancelled'
               || ev === 'run.interrupted') {
      status = ev.slice(4);
      if (obj.session_id) effectiveSid = obj.session_id;
      if (obj.usage) usage = obj.usage;
      if (typeof obj.error === 'string' && obj.error) error = obj.error;
    } else if (ev === 'error') {
      error = obj.message || 'stream error';
      status = 'failed';
    }

    if (onEvent) onEvent(ev, obj, { content, usage, status, runId, sessionId: effectiveSid });
    return ev;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.search(/\r?\n\r?\n/)) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + (buf[idx] === '\r' ? 4 : 2));
        eventName = handleFrame(frame);
      }
    }
    if (buf.trim()) handleFrame(buf);
  } catch (e) {
    if (e && e.name === 'AbortError') aborted = true;
    else throw e;
  }

  if (status === 'running') status = 'completed';
  return { content, usage, status, runId, sessionId: effectiveSid, error, aborted };
}
