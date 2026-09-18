/**
 * markdown.js —— 极简、安全的 Markdown 渲染
 *
 * 设计取舍：先整体 HTML 转义，再做受控的标签替换 —— 因此用户/模型内容
 * 不可能注入 HTML。支持：围栏代码块、行内代码、粗体/斜体/删除线、
 * 链接、标题、有序/无序/嵌套列表、引用、表格、分割线、段落。
 */

import { escapeHtml } from './util.js';

const FENCE = '\u0000F';
const INLINE_CODE = '\u0000C';

/** 行内元素（输入必须是已转义的文本） */
function inline(t) {
  const codes = [];
  // 行内代码先摘出来，避免其内容被后续规则改写
  t = t.replace(/`([^`]+)`/g, (_, c) => {
    codes.push(c);
    return INLINE_CODE + (codes.length - 1) + '\u0000';
  });

  t = t
    // 图片：除了 http(s)，还必须认 data:image/... —— api_server 在回复送出去之前会把
    // 回复里的 `MEDIA:<图片路径>` 就地内联成 data URL（`_resolve_media_to_data_urls`，
    // 仅 png/jpg/jpeg/gif/webp/bmp 且 ≤5MB）。不认它的话会把几 MB 的 base64 当文字显示出来。
    .replace(/!\[([^\]]*)\]\((data:image\/[a-z0-9+.-]+;base64,[A-Za-z0-9+/=]+)\)/gi,
      '<img src="$2" alt="$1" loading="lazy" decoding="async">')
    .replace(/!\[([^\]]*)\]\((https?:[^)\s]+)[^)]*\)/g,
      '<img src="$2" alt="$1" loading="lazy" decoding="async">')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+|mailto:[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(（[，。；：])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    // 裸链接（排除已在 href/属性里的）
    .replace(/(^|[\s(（])(https?:\/\/[^\s<>"'）)]+)/g,
      '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');

  return t.replace(new RegExp(INLINE_CODE + '(\\d+)\\u0000', 'g'),
    (_, i) => `<code>${codes[+i]}</code>`);
}

/** 表格分隔行：| --- | :--: | */
const isTableSep = (s) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(s);

function splitRow(line) {
  return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
}

export function render(src) {
  const blocks = [];
  let s = escapeHtml(String(src ?? ''));

  // ① 围栏代码块
  s = s.replace(/```([^\n`]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const l = lang.trim().replace(/[^\w+#.-]/g, '').slice(0, 20);
    blocks.push(
      `<div class="codeblock"><div class="codeblock-head">` +
      `<span class="lang">${l || 'text'}</span>` +
      `<button class="copy" type="button" data-code="${blocks.length}">复制</button>` +
      `</div><pre><code>${code.replace(/\n$/, '')}</code></pre></div>`
    );
    return `\n${FENCE}${blocks.length - 1}\u0000\n`;
  });

  // ② 缩进代码块（保留但简单处理）
  s = s.replace(/(?:^|\n)((?: {4}[^\n]*\n?)+)/g, (m, body) => {
    const code = body.replace(/^ {4}/gm, '').replace(/\n$/, '');
    blocks.push(
      `<div class="codeblock"><div class="codeblock-head"><span class="lang">text</span>` +
      `<button class="copy" type="button" data-code="${blocks.length}">复制</button></div>` +
      `<pre><code>${code}</code></pre></div>`
    );
    return `\n${FENCE}${blocks.length - 1}\u0000\n`;
  });

  const lines = s.split('\n');
  const out = [];
  let i = 0;

  const closeList = (stack) => { while (stack.length) out.push(`</${stack.pop()}>`); };

  let listStack = [];
  let inQuote = false;

  const flush = () => { closeList(listStack); if (inQuote) { out.push('</blockquote>'); inQuote = false; } };

  while (i < lines.length) {
    const line = lines[i];
    const t = line.trim();

    // 代码块占位
    const fence = t.match(new RegExp('^' + FENCE + '(\\d+)\\u0000$'));
    if (fence) { flush(); out.push(blocks[+fence[1]]); i++; continue; }

    // 空行
    if (!t) { flush(); i++; continue; }

    // 分割线
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) { flush(); out.push('<hr>'); i++; continue; }

    // 表格
    if (t.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      flush();
      const head = splitRow(t);
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      out.push(
        '<table><thead><tr>' + head.map((h) => `<th>${inline(h)}</th>`).join('') + '</tr></thead><tbody>' +
        rows.map((r) => '<tr>' + head.map((_, k) => `<td>${inline(r[k] ?? '')}</td>`).join('') + '</tr>').join('') +
        '</tbody></table>'
      );
      continue;
    }

    // 标题
    const h = t.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flush();
      const lv = Math.min(h[1].length, 4);
      out.push(`<h${lv}>${inline(h[2])}</h${lv}>`);
      i++; continue;
    }

    // 引用
    const q = line.match(/^\s*&gt;\s?(.*)$/);
    if (q) {
      closeList(listStack);
      if (!inQuote) { out.push('<blockquote>'); inQuote = true; }
      out.push(`<p>${inline(q[1])}</p>`);
      i++; continue;
    }
    if (inQuote) { out.push('</blockquote>'); inQuote = false; }

    // 列表（支持一层嵌套）
    const ul = line.match(/^(\s*)[-*+]\s+(.*)$/);
    const ol = line.match(/^(\s*)\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      const kind = ul ? 'ul' : 'ol';
      const depth = Math.min(Math.floor((ul || ol)[1].replace(/\t/g, '    ').length / 2), 1) + 1;
      while (listStack.length > depth) out.push(`</${listStack.pop()}>`);
      if (listStack.length < depth) { out.push(`<${kind}>`); listStack.push(kind); }
      else if (listStack[listStack.length - 1] !== kind) {
        out.push(`</${listStack.pop()}>`); out.push(`<${kind}>`); listStack.push(kind);
      }
      out.push(`<li>${inline((ul || ol)[2])}</li>`);
      i++; continue;
    }
    closeList(listStack);

    // 段落（连续行合并）
    const para = [line];
    i++;
    while (i < lines.length) {
      const nx = lines[i];
      if (!nx.trim()) break;
      if (/^(#{1,6})\s/.test(nx.trim())) break;
      if (/^(\s*)[-*+]\s+/.test(nx)) break;
      if (/^(\s*)\d+[.)]\s+/.test(nx)) break;
      if (/^\s*&gt;/.test(nx)) break;
      if (nx.trim().startsWith(FENCE)) break;
      para.push(nx);
      i++;
    }
    out.push(`<p>${inline(para.join('\n')).replace(/\n/g, '<br>')}</p>`);
  }

  flush();
  return out.join('\n');
}

/** 取出代码块原文，供「复制」按钮使用 */
export function extractCode(root, index) {
  const all = root.querySelectorAll('.codeblock code');
  const node = all[index];
  return node ? node.textContent : '';
}

export const plainText = (md) =>
  String(md ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_~#>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
