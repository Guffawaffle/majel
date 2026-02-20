/**
 * renderMarkdown — lightweight Markdown → HTML renderer.
 *
 * Ported 1:1 from vanilla client views/chat/chat.js L234-L359.
 * Applied only to `model` role messages; user/system/error messages
 * are HTML-escaped plaintext.
 */

/** HTML-escape a string (for user input / plain text). */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Convert Markdown text to safe HTML. */
export function renderMarkdown(text: string | null | undefined): string {
  if (text == null) return "<em>(no response)</em>";

  // Escape HTML first
  let html = escapeHtml(text);

  // Code blocks (``` ... ```)
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, _lang, code) => {
    return `<pre><code>${(code as string).trim()}</code></pre>`;
  });

  // Inline code (`...`)
  html = html.replace(/`([^`\n]+)`/g, "<code>$1</code>");

  // Bold (**...**)
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

  // Italic (*...*)
  html = html.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<em>$1</em>");

  // Headers (## ... at start of line)
  html = html.replace(/^### (.+)$/gm, '<p><strong class="md-h3">$1</strong></p>');
  html = html.replace(/^## (.+)$/gm, '<p><strong class="md-h2">$1</strong></p>');
  html = html.replace(/^# (.+)$/gm, '<p><strong class="md-h1">$1</strong></p>');

  // Blockquotes (> ...)
  html = html.replace(/^&gt; (.+)$/gm, "<blockquote>$1</blockquote>");

  // Unordered lists (- ... or * ...)
  html = html.replace(/^[-*] (.+)$/gm, "<li>$1</li>");

  // Wrap consecutive <li> in <ul>
  {
    const lines = html.split("\n");
    const out: string[] = [];
    let inList = false;
    for (const line of lines) {
      if (line.trim().startsWith("<li>") && line.trim().endsWith("</li>")) {
        if (!inList) { out.push("<ul>"); inList = true; }
        out.push(line);
      } else {
        if (inList) { out.push("</ul>"); inList = false; }
        out.push(line);
      }
    }
    if (inList) out.push("</ul>");
    html = out.join("\n");
  }

  // Ordered lists (1. ...)
  html = html.replace(/^\d+\. (.+)$/gm, "<li>$1</li>");

  // Wrap consecutive <li> not inside <ul> in <ol>
  {
    const lines = html.split("\n");
    const out: string[] = [];
    let inOl = false;
    let insideUl = false;
    for (const line of lines) {
      const t = line.trim();
      if (t === "<ul>") {
        insideUl = true;
        if (inOl) { out.push("</ol>"); inOl = false; }
        out.push(line);
      } else if (t === "</ul>") {
        insideUl = false;
        out.push(line);
      } else if (t.startsWith("<li>") && t.endsWith("</li>") && !insideUl) {
        if (!inOl) { out.push("<ol>"); inOl = true; }
        out.push(line);
      } else {
        if (inOl && t) { out.push("</ol>"); inOl = false; }
        out.push(line);
      }
    }
    if (inOl) out.push("</ol>");
    html = out.join("\n");
  }

  // Tables (| ... | ... |)
  html = html.replace(/((?:^\|.+\|\n?)+)/gm, (tableBlock) => {
    const rows = tableBlock.trim().split("\n").filter((r) => r.trim());
    if (rows.length < 2) return tableBlock;

    let table = "<table>";
    rows.forEach((row, i) => {
      // Skip separator row (|---|---| etc.)
      if (/^\|[-\s:|]+\|$/.test(row.trim())) return;
      const cells = row.split("|").filter((c) => c.trim() !== "");
      const tag = i === 0 ? "th" : "td";
      if (i === 0) table += "<thead>";
      if (i === 1) table += "</thead><tbody>";
      table += "<tr>" + cells.map((c) => `<${tag}>${c.trim()}</${tag}>`).join("") + "</tr>";
    });
    table += "</tbody></table>";
    return table;
  });

  // Paragraphs: split on double newlines
  html = html
    .split(/\n\n+/)
    .map((block) => {
      const b = block.trim();
      if (!b) return "";
      if (/^<(pre|ul|ol|blockquote|table|h[1-6]|p|div)/.test(b)) return b;
      return `<p>${b.replace(/\n/g, "<br>")}</p>`;
    })
    .join("");

  return html;
}
