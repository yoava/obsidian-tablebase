const EXTERNAL_URL = /^https?:\/\/(?:[^\s()\r\n]|\([^\s()\r\n]*\))+$/;

/** Wraps `text` in a backtick run longer than any run inside it. */
function toCodeSpan(text: string): string {
  const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longestRun + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

function anchorToMarkdown(anchor: HTMLAnchorElement): string {
  const text = anchor.textContent ?? "";

  const target = anchor.dataset.href;
  if (anchor.classList.contains("internal-link") && target && !/[\]|\r\n]/.test(target)) {
    if (text === target || !text) return `[[${target}]]`;
    if (!/[\]\r\n]/.test(text)) return `[[${target}|${text}]]`;
    return text;
  }

  const href = anchor.getAttribute("href") ?? "";
  if (!EXTERNAL_URL.test(href)) return text;
  if (!text || text === href) return href;
  if (/[[\]\r\n]/.test(text)) return `${text} ${href}`;
  return `[${text}](${href})`;
}

function nodeToMarkdown(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (!(node instanceof Element)) return "";
  if (node instanceof HTMLAnchorElement) return anchorToMarkdown(node);
  if (node.tagName === "CODE") return toCodeSpan(node.textContent ?? "");
  return Array.from(node.childNodes).map(nodeToMarkdown).join("");
}

/**
 * The cell's text with the links and code spans the renderer drew turned back
 * into Markdown, so a table rendered without a note behind it (a chat view, an
 * embed) keeps its links instead of flattening them to their labels.
 */
export function renderedCellToMarkdown(cell: Element): string {
  return Array.from(cell.childNodes).map(nodeToMarkdown).join("").trim();
}
