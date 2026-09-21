/** settings.js —— 设置抽屉：连接、外观、手机通知、数据管理 */

import { $, download, fmtBytes } from './util.js';
import { config, prefs, cache, normalizeBase, exportAll, importAll, wipe, storageBytes, STORAGE_KEYS } from './store.js';
import { listModels, listSessions, explainError } from './api.js';
import { toast, setConn } from './ui.js';
import * as ntfy from './notify.js';

let onChange = () => {};

export function initSettings({ onConfigChange, onThemeChange, onWipe, onPrefsChange } = {}) {
  onChange = onConfigChange || (() => {});
  const sheet = $('#sheet');

  const open = () => {
    const c = config.get();
    const p = prefs.get();
    $('#g-base').value = c.baseUrl || '';
    $('#g-key').value = c.key || '';
    $('#g-model').value = c.model || '';
    $('#opt-tools').checked = p.showTools !== false;
    $('#opt-clearafter').checked = p.clearAfter !== false;
    const nt = c.notify || {};
    $('#ntf-on').checked = nt.enabled === true;
    $('#ntf-topic').value = nt.topic || '';
    $('#ntf-server').value = nt.server || 'https://ntfy.sh';
    $('#ntf-token').value = nt.token || '';
    $('#ntf-hidden').checked = nt.onlyHidden !== false;
    $('#ntf-done').checked = nt.onDone !== false;
    $('#ntf-error').checked = nt.onError !== false;
    $('#ntf-msg').textContent = '';
    $('#ntf-msg').className = 'msg';
    paintNotify();
    $('#theme-seg').querySelectorAll('button').forEach((b) =>
      b.setAttribute('aria-pressed', String(b.dataset.themeVal === p.theme)));
    $('#g-msg').textContent = '';
    $('#g-msg').className = 'msg';
    refreshStoreLine();
    sheet.hidden = false;
    document.body.style.overflow = 'hidden';
  };

  const close = () => {
    sheet.hidden = true;
    document.body.style.overflow = '';
  };

  const refreshStoreLine = () => {
    const el = $('#g-store');
    if (!el) return;
    const n = cache.getList().length;
    el.innerHTML =
      `本机只存连接配置与偏好：<b>${fmtBytes(storageBytes())}</b>` +
      `（缓存了 ${n} 条会话列表）` +
      `<br>会话历史存在 <b>Hermes 服务端 state.db</b>，与桌面端 / CLI 共用，不在这个浏览器里。`;
  };

  /* 打开/关闭 */
  $('#open-settings').addEventListener('click', open);
  $('#top-settings').addEventListener('click', open);
  sheet.querySelectorAll('[data-close]').forEach((n) => n.addEventListener('click', close));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !sheet.hidden) close();
  });

  /* 显示/隐藏密钥 */
  $('#g-reveal').addEventListener('click', () => {
    const i = $('#g-key');
    i.type = i.type === 'password' ? 'text' : 'password';
  });

  /* 测试连接：模型 + 会话数一起验，能立刻暴露"能对话但读不到历史"这种半通状态 */
  $('#g-test').addEventListener('click', async () => {
    const msg = $('#g-msg');
    const base = normalizeBase($('#g-base').value);
    const key = $('#g-key').value.trim();
    if (!base || !key) { msg.className = 'msg err'; msg.textContent = 'Base URL 和 API Key 都要填。'; return; }
    msg.className = 'msg'; msg.textContent = '测试中…';
    try {
      const { models } = await listModels(base, key);
      let hist = '';
      try {
        const { data } = await listSessions(base, key, { limit: 1 });
        const s = data[0];
        hist = `　历史会话可读 ✓（最新一条：${s ? (s.title || s.id) : '暂无'}）`;
      } catch (e2) {
        hist = `　⚠️ 历史读不到：${explainError(e2, e2.status) || e2.message}`;
      }
      msg.className = 'msg ok';
      msg.textContent = '连接成功 ✓　模型：' + (models.join(', ') || '(未列出)') + hist;
    } catch (e) {
      msg.className = 'msg err';
      msg.textContent = explainError(e, e.status) || String(e.message || e);
    }
  });

  /* 保存 */
  $('#g-save').addEventListener('click', () => {
    const base = normalizeBase($('#g-base').value);
    const key = $('#g-key').value.trim();
    const model = $('#g-model').value.trim() || 'hermes-agent';
    if (!base || !key) {
      const msg = $('#g-msg');
      msg.className = 'msg err';
      msg.textContent = 'Base URL 和 API Key 都要填。';
      return;
    }
    config.set({ baseUrl: base, key, model });
    $('#g-msg').className = 'msg ok';
    $('#g-msg').textContent = '已保存。';
    refreshStoreLine();
    onChange();
    setTimeout(close, 480);
  });

  /* 外观 */
  $('#theme-seg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-theme-val]');
    if (!b) return;
    const p = prefs.set({ theme: b.dataset.themeVal });
    $('#theme-seg').querySelectorAll('button').forEach((x) =>
      x.setAttribute('aria-pressed', String(x.dataset.themeVal === p.theme)));
    onThemeChange && onThemeChange(p.theme);
  });

  /* 开关 */
  $('#opt-tools').addEventListener('change', (e) => {
    prefs.set({ showTools: e.target.checked });
    onPrefsChange && onPrefsChange();
  });
  $('#opt-clearafter').addEventListener('change', (e) => {
    prefs.set({ clearAfter: e.target.checked });
  });

  /* ── 手机通知：改一项就存一项，不用点"保存" ── */
  const CHAN_HINT = {
    browser: '不需要任何第三方：页面自己弹系统通知，事件源就是已连着的 gateway。代价是页面关掉就收不到。',
    ntfy: '走 ntfy（手机装 ntfy App 并订阅同一个 topic）。页面关着也收得到 —— 但那半要在 Hermes 主机侧配 hook，光靠这个页面发一样是"页面活着才行"。',
    both: '两个通道都发：页面开着时弹浏览器通知，同时也往 ntfy 发一条。',
  };

  const chanSel = () => {
    const b = $('#ntf-chan').querySelector('button[aria-pressed="true"]');
    return (b && b.dataset.chan) || 'browser';
  };

  const paintNotify = () => {
    const ch = chanSel();
    $('#ntf-chan').querySelectorAll('button').forEach((b) =>
      b.setAttribute('aria-pressed', String(b.dataset.chan === ch)));
    $('#ntf-ntfy-fields').classList.toggle('off', ch === 'browser');
    const perm = ntfy.permState();
    const permTxt = perm === 'granted' ? '已授权' : perm === 'denied' ? '被拒绝（要在浏览器设置里放行）'
      : perm === 'unsupported' ? '这个浏览器不支持' : '未授权（点"请求通知权限"）';
    $('#ntf-chan-hint').textContent = CHAN_HINT[ch] + (ch === 'ntfy' ? '' : ` 通知权限：${permTxt}。`);
  };

  const saveNotify = () => {
    config.set({
      notify: {
        enabled: $('#ntf-on').checked,
        channel: chanSel(),
        topic: $('#ntf-topic').value.trim(),
        server: $('#ntf-server').value.trim() || 'https://ntfy.sh',
        token: $('#ntf-token').value.trim(),
        onlyHidden: $('#ntf-hidden').checked,
        onDone: $('#ntf-done').checked,
        onError: $('#ntf-error').checked,
      },
    });
    paintNotify();
  };

  ['#ntf-on', '#ntf-topic', '#ntf-server', '#ntf-token', '#ntf-hidden', '#ntf-done', '#ntf-error']
    .forEach((sel) => $(sel).addEventListener('change', saveNotify));
  $('#ntf-chan').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-chan]');
    if (!b) return;
    $('#ntf-chan').querySelectorAll('button').forEach((x) =>
      x.setAttribute('aria-pressed', String(x === b)));
    saveNotify();
  });

  $('#ntf-perm').addEventListener('click', async () => {
    const msg = $('#ntf-msg');
    const r = await ntfy.requestPerm();
    paintNotify();
    msg.className = r === 'granted' ? 'msg ok' : 'msg err';
    msg.textContent = r === 'granted' ? '已授权 ✓ 测试一下就知道了。'
      : r === 'denied' ? '被拒绝了：去浏览器/系统的通知设置里给这个站点放行。'
        : r === 'unsupported' ? '这个浏览器不支持系统通知。' : '没拿到权限（' + r + '）。';
  });

  $('#ntf-test').addEventListener('click', async () => {
    saveNotify();                                  // 可能刚打完 topic 就来点测试，别等 blur
    const msg = $('#ntf-msg');
    msg.className = 'msg';
    msg.textContent = '发送中…';
    const results = await ntfy.test();
    const okAll = results.every(([, r]) => r.ok);
    msg.className = okAll ? 'msg ok' : 'msg err';
    msg.textContent = results
      .map(([name, r]) => `${name}：${r.ok ? '已发出 ✓' : '失败 — ' + (r.error || '未知')}`)
      .join('　');
    if (okAll && ntfy.useBrowser()) msg.textContent += '　（看系统通知是不是弹出来了）';
  });

  $('#ntf-open').addEventListener('click', () => {
    saveNotify();
    const u = ntfy.subscribeUrl();
    if (!u) { toast('先把 ntfy 的 Topic 填上', 'warn'); return; }
    window.open(u, '_blank', 'noopener');
  });

  /* 导出（只导出配置，历史在服务端） */
  $('#g-export').addEventListener('click', () => {
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    download(`hermes-chat-config-${stamp}.json`, exportAll());
    toast('已导出连接配置（含 Key，妥善保管）。会话历史在服务端，用每篇的「导出」按钮存 Markdown。', 'warn', 7000);
  });

  /* 导入 */
  $('#g-import').addEventListener('click', () => $('#g-file').click());
  $('#g-file').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const res = importAll(await f.text(), { keepKey: true });
      toast(`导入完成：连接配置 ${res.config ? '✓' : '—'}　偏好 ${res.prefs ? '✓' : '—'}`, 'ok', 5000);
      refreshStoreLine();
      onChange();
    } catch (err) {
      toast('导入失败：' + (err.message || err), 'err', 6000);
    }
  });

  /* 清空本机数据（不动服务端会话） */
  $('#g-clear').addEventListener('click', () => {
    if (!confirm('清除本浏览器里保存的 API Key、偏好和缓存？\n\n服务端会话历史不受影响（那是桌面端共用的那份）。')) return;
    wipe();
    close();
    onWipe && onWipe();
  });

  return { open, close, refreshStoreLine, setConn };
}
