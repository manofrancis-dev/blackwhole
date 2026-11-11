/* Minimal, safe markdown renderer for chat messages.
   Renders: headings, bold/italic, inline code, fenced code blocks (with copy),
   lists, blockquotes, hr, tables, links. All user/model text is HTML-escaped. */
(function () {
  "use strict";

  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
           .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function inline(s) {
    let out = escapeHtml(s);
    out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
    out = out.replace(/\*\*\*([^*]+)\*\*\*/g, "<strong><em>$1</em></strong>");
    out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    out = out.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, "$1<em>$2</em>");
    out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    out = out.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g,
      '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
    return out;
  }

  function codeBlockHtml(lang, code) {
    const safeCode = escapeHtml(code);
    const encoded = encodeURIComponent(code);
    return '<div class="code-block">' +
      '<div class="code-head"><span class="code-lang">' + escapeHtml(lang || "code") + "</span>" +
      '<button class="code-copy" data-code="' + encoded + '">' +
      '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>Copy</button></div>' +
      "<pre><code>" + safeCode + "</code></pre></div>";
  }

  function tableHtml(rows) {
    // rows: array of arrays of cell strings
    let html = "<table><thead><tr>";
    rows[0].forEach(c => { html += "<th>" + inline(c) + "</th>"; });
    html += "</tr></thead><tbody>";
    for (let i = 1; i < rows.length; i++) {
      html += "<tr>";
      rows[i].forEach(c => { html += "<td>" + inline(c) + "</td>"; });
      html += "</tr>";
    }
    return html + "</tbody></table>";
  }

  function splitRow(line) {
    return line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map(c => c.trim());
  }

  function renderMarkdown(text) {
    if (!text) return "";
    const src = text.replace(/\r\n/g, "\n");

    // Pull out fenced code blocks so block parsing ignores them.
    const blocks = [];
    let body = src.replace(/```([\w+-]*)\n([\s\S]*?)(?:```|$)/g, (_, lang, code) => {
      blocks.push(codeBlockHtml(lang.trim(), code));
      return "\u0000B" + (blocks.length - 1) + "\u0000";
    });

    const lines = body.split("\n");
    let html = "", i = 0;

    const isBlank = () => !lines[i] || !lines[i].trim();

    while (i < lines.length) {
      const line = lines[i];

      if (isBlank()) { i++; continue; }

      // Placeholder line (code block extracted above)
      const ph = line.match(/^\u0000B(\d+)\u0000$/);
      if (ph) { html += blocks[+ph[1]]; i++; continue; }

      // Headings
      const h = line.match(/^(#{1,4})\s+(.*)$/);
      if (h) { html += `<h${h[1].length}>` + inline(h[2]) + `</h${h[1].length}>`; i++; continue; }

      // Horizontal rule
      if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) { html += "<hr>"; i++; continue; }

      // Blockquote
      if (/^\s*>/.test(line)) {
        const q = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) { q.push(lines[i].replace(/^\s*>\s?/, "")); i++; }
        html += "<blockquote>" + renderMarkdown(q.join("\n")) + "</blockquote>";
        continue;
      }

      // Unordered list
      if (/^\s*[-*+]\s+/.test(line)) {
        html += "<ul>";
        while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
          let item = lines[i].replace(/^\s*[-*+]\s+/, ""); i++;
          while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*[-*+]\s+/.test(lines[i])) {
            item += " " + lines[i].trim(); i++;
          }
          html += "<li>" + inline(item) + "</li>";
        }
        html += "</ul>"; continue;
      }

      // Ordered list
      if (/^\s*\d+[.)]\s+/.test(line)) {
        html += "<ol>";
        while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
          let item = lines[i].replace(/^\s*\d+[.)]\s+/, ""); i++;
          while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*\d+[.)]\s+/.test(lines[i])) {
            item += " " + lines[i].trim(); i++;
          }
          html += "<li>" + inline(item) + "</li>";
        }
        html += "</ol>"; continue;
      }

      // Table: header row + separator row
      if (line.includes("|") && i + 1 < lines.length &&
          /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(lines[i + 1])) {
        const rows = [splitRow(line)];
        i += 2;
        while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
          rows.push(splitRow(lines[i])); i++;
        }
        html += tableHtml(rows); continue;
      }

      // Paragraph: gather until blank line or block start
      const para = [line]; i++;
      while (i < lines.length && !isBlank() &&
             !/^(#{1,4})\s/.test(lines[i]) &&
             !/^\s*[-*+]\s+/.test(lines[i]) &&
             !/^\s*\d+[.)]\s+/.test(lines[i]) &&
             !/^\s*>/.test(lines[i]) &&
             !/^\u0000B\d+\u0000$/.test(lines[i])) {
        // stop early if next line is a table header candidate
        if (lines[i].includes("|") && i + 1 < lines.length &&
            /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(lines[i + 1])) break;
        para.push(lines[i]); i++;
      }
      html += "<p>" + para.map(inline).join("<br>") + "</p>";
    }

    return html;
  }

  window.Markdown = { render: renderMarkdown };
})();
