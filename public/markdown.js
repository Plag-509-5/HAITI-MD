/**
 * Mini moteur Markdown (sans dépendance) orienté chat :
 * code fences + bouton copier, titres, listes, citations, tableaux,
 * gras/italique/barré, code inline et liens.
 * Tolère un bloc de code non fermé (utile pendant le streaming).
 */
(function (global) {
  'use strict';

  const escapeHtml = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function inline(raw) {
    const codes = [];
    let s = String(raw).replace(/`([^`\n]+)`/g, (_, code) => {
      codes.push(code);
      return `\u0000${codes.length - 1}\u0000`;
    });

    s = escapeHtml(s);

    s = s
      .replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(«"])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/(^|[\s(«"])_([^_\n]+)_/g, '$1<em>$2</em>')
      .replace(/~~([^~]+)~~/g, '<del>$1</del>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
      .replace(/(^|[\s])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');

    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code class="inline">${escapeHtml(codes[Number(i)])}</code>`);
  }

  function codeBlock(code, lang, closed) {
    const label = (lang || 'code').replace(/[^a-z0-9+#-]/gi, '');
    return (
      `<div class="code ${closed ? '' : 'code-open'}">` +
      `<div class="code-head"><span class="code-lang">${escapeHtml(label)}</span>` +
      `<button type="button" class="copy-code" aria-label="Copier le code">Copier</button></div>` +
      `<pre><code>${escapeHtml(code)}</code></pre>` +
      `</div>`
    );
  }

  function isTableSeparator(line) {
    return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line);
  }

  function splitRow(line) {
    return line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim());
  }

  function render(markdown) {
    const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let i = 0;

    const paragraph = [];
    const flushParagraph = () => {
      if (!paragraph.length) return;
      out.push(`<p>${inline(paragraph.join('\n')).replace(/\n/g, '<br>')}</p>`);
      paragraph.length = 0;
    };

    let listType = null;
    let listItems = [];
    const flushList = () => {
      if (!listItems.length) return;
      out.push(`<${listType}>${listItems.map((item) => `<li>${inline(item)}</li>`).join('')}</${listType}>`);
      listItems = [];
      listType = null;
    };

    const flushAll = () => {
      flushParagraph();
      flushList();
    };

    while (i < lines.length) {
      const line = lines[i];

      /* --- bloc de code --- */
      const fence = /^\s*```([\w+#.-]*)\s*$/.exec(line);
      if (fence) {
        flushAll();
        const lang = fence[1] || '';
        const buffer = [];
        i += 1;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
          buffer.push(lines[i]);
          i += 1;
        }
        const closed = i < lines.length;
        if (closed) i += 1;
        out.push(codeBlock(buffer.join('\n'), lang, closed));
        continue;
      }

      /* --- titre --- */
      const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
      if (heading) {
        flushAll();
        const level = Math.min(heading[1].length + 1, 6);
        out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
        i += 1;
        continue;
      }

      /* --- séparateur --- */
      if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
        flushAll();
        out.push('<hr>');
        i += 1;
        continue;
      }

      /* --- tableau --- */
      if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
        flushAll();
        const head = splitRow(line);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
          rows.push(splitRow(lines[i]));
          i += 1;
        }
        out.push(
          '<div class="table-wrap"><table><thead><tr>' +
            head.map((c) => `<th>${inline(c)}</th>`).join('') +
            '</tr></thead><tbody>' +
            rows
              .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
              .join('') +
            '</tbody></table></div>'
        );
        continue;
      }

      /* --- citation --- */
      if (/^\s{0,3}>\s?/.test(line)) {
        flushAll();
        const buffer = [];
        while (i < lines.length && /^\s{0,3}>\s?/.test(lines[i])) {
          buffer.push(lines[i].replace(/^\s{0,3}>\s?/, ''));
          i += 1;
        }
        out.push(`<blockquote>${inline(buffer.join('\n')).replace(/\n/g, '<br>')}</blockquote>`);
        continue;
      }

      /* --- listes --- */
      const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
      const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
      if (bullet || numbered) {
        const type = bullet ? 'ul' : 'ol';
        flushParagraph();
        if (listType && listType !== type) flushList();
        listType = type;
        listItems.push((bullet || numbered)[1]);
        i += 1;
        continue;
      }

      /* --- ligne vide --- */
      if (!line.trim()) {
        flushAll();
        i += 1;
        continue;
      }

      /* --- paragraphe --- */
      flushList();
      paragraph.push(line);
      i += 1;
    }

    flushAll();
    return out.join('');
  }

  global.PlagMarkdown = { render, escapeHtml };
})(window);
