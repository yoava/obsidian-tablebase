export interface LinkToken {
  type: "text" | "code" | "external" | "internal";
  text: string;
  href?: string;
  strong?: boolean;
  em?: boolean;
}

export interface LinkRenderCallbacks {
  onExternalClick?: (url: string, e: MouseEvent) => void;
  onInternalClick?: (path: string, e: MouseEvent) => void;
}

function trimTrailingUrlPunctuation(url: string): { url: string; trailing: string } {
  let cleanUrl = url;
  let trailing = "";
  let openCount = (url.match(/\(/g) || []).length;
  let closeCount = (url.match(/\)/g) || []).length;

  while (cleanUrl.length > 0 && /[.,;:!?)]$/.test(cleanUrl)) {
    if (cleanUrl.endsWith(")")) {
      if (closeCount <= openCount) {
        break;
      }
      closeCount -= 1;
    }
    trailing = cleanUrl.slice(-1) + trailing;
    cleanUrl = cleanUrl.slice(0, -1);
  }

  return { url: cleanUrl, trailing };
}

function appendTextToken(tokens: LinkToken[], text: string): void {
  if (!text) return;
  const lastToken = tokens[tokens.length - 1];
  if (lastToken && lastToken.type === "text") {
    lastToken.text += text;
  } else {
    tokens.push({ type: "text", text });
  }
}

/** Whether the character at `index` follows an odd run of backslashes. */
function isEscaped(input: string, index: number): boolean {
  let count = 0;
  for (let i = index - 1; i >= 0 && input[i] === "\\"; i--) count++;
  return count % 2 === 1;
}

/** The end of the backtick run starting at `index`. */
function backtickRunEnd(input: string, index: number): number {
  let end = index;
  while (input[end] === "`") end++;
  return end;
}

interface CodeSpan {
  start: number;
  end: number;
  text: string;
}

/** A code span's content: line endings become spaces, one space is stripped from each side. */
function codeContent(raw: string): string {
  const content = raw.replace(/\r\n|\r|\n/g, " ");
  if (content.length > 1 && content.startsWith(" ") && content.endsWith(" ") && /[^ ]/.test(content)) {
    return content.slice(1, -1);
  }
  return content;
}

/**
 * The first CommonMark code span at or after `from`: a backtick run opens a
 * span that the next run of the same length closes. An unmatched run, or a
 * backtick after a backslash, stays text.
 */
function findCodeSpan(input: string, from: number): CodeSpan | null {
  let i = from;
  while (i < input.length) {
    if (input[i] !== "`" || isEscaped(input, i)) {
      i++;
      continue;
    }
    const openEnd = backtickRunEnd(input, i);
    const length = openEnd - i;
    for (let j = openEnd; j < input.length; ) {
      if (input[j] !== "`") {
        j++;
        continue;
      }
      const runEnd = backtickRunEnd(input, j);
      if (runEnd - j === length) {
        return { start: i, end: runEnd, text: codeContent(input.slice(openEnd, j)) };
      }
      j = runEnd;
    }
    i = openEnd;
  }
  return null;
}

/** The value with each code span replaced by its content: "`Done`" becomes "Done". */
export function stripCodeSpans(input: string): string {
  let out = "";
  let pos = 0;
  for (let span = findCodeSpan(input, 0); span; span = findCodeSpan(input, pos)) {
    out += input.slice(pos, span.start) + span.text;
    pos = span.end;
  }
  return out + input.slice(pos);
}

const LINK_PATTERN =
  /(\[(?<mdLabel>[^\]\r\n]+)\]\((?<mdUrl>https?:\/\/(?:[^\s()\r\n]|\([^\s()\r\n]*\))+)\))|(\[\[(?<wikiTarget>[^\]|\r\n]+)(?:\|(?<wikiAlias>[^\]\r\n]+))?\]\])|(?<rawUrl>https?:\/\/(?:[^\s<>[\]()"']|\([^\s<>[\]()"']*\))+)/g;

export function parseLinkTokens(input: string): LinkToken[] {
  if (!input) return [];

  const linkRegex = new RegExp(LINK_PATTERN);
  const tokens: LinkToken[] = [];
  let pos = 0;

  while (pos < input.length) {
    linkRegex.lastIndex = pos;
    const link = linkRegex.exec(input);
    const code = findCodeSpan(input, pos);
    // A link that starts first keeps any code span inside it; otherwise code binds first.
    if (code && (!link || code.start < link.index)) {
      appendTextToken(tokens, input.slice(pos, code.start));
      tokens.push({ type: "code", text: code.text });
      pos = code.end;
    } else if (link) {
      appendTextToken(tokens, input.slice(pos, link.index));
      appendLinkToken(tokens, link);
      pos = link.index + link[0].length;
    } else {
      appendTextToken(tokens, input.slice(pos));
      break;
    }
  }

  return applyEmphasis(tokens);
}

interface Delimiter {
  token: number;
  offset: number;
  char: string;
  length: number;
  canOpen: boolean;
  canClose: boolean;
}

/** The character next to a delimiter, looking into the neighbouring token; "" at the edges. */
function neighbourChar(tokens: LinkToken[], tokenIndex: number, index: number): string {
  const token = tokens[tokenIndex];
  if (index >= 0 && index < token.text.length) return token.text[index];
  const neighbour = tokens[tokenIndex + (index < 0 ? -1 : 1)];
  if (!neighbour) return "";
  // Links and code spans count as word characters.
  if (neighbour.type !== "text") return "a";
  return index < 0 ? neighbour.text.slice(-1) : neighbour.text.charAt(0);
}

function findDelimiters(tokens: LinkToken[]): Delimiter[] {
  const delimiters: Delimiter[] = [];
  tokens.forEach((token, tokenIndex) => {
    if (token.type !== "text") return;
    const text = token.text;
    for (let i = 0; i < text.length; ) {
      const char = text[i];
      if ((char !== "*" && char !== "_") || isEscaped(text, i)) {
        i++;
        continue;
      }
      let end = i;
      while (text[end] === char) end++;
      const length = end - i;
      const before = neighbourChar(tokens, tokenIndex, i - 1);
      const after = neighbourChar(tokens, tokenIndex, end);
      let canOpen = after !== "" && !/\s/.test(after);
      let canClose = before !== "" && !/\s/.test(before);
      // Underscores inside a word (snake_case, URLs) are not emphasis.
      if (char === "_") {
        canOpen = canOpen && !/[\p{L}\p{N}]/u.test(before);
        canClose = canClose && !/[\p{L}\p{N}]/u.test(after);
      }
      if (length <= 3 && (canOpen || canClose)) {
        delimiters.push({ token: tokenIndex, offset: i, char, length, canOpen, canClose });
      }
      i = end;
    }
  });
  return delimiters;
}

/** Pairs each closing run with the nearest open run of the same character and length. */
function matchDelimiters(delimiters: Delimiter[]): Delimiter[] {
  const matched: Delimiter[] = [];
  const openers: Delimiter[] = [];
  for (const delimiter of delimiters) {
    const openerIndex = delimiter.canClose
      ? openers.map((o) => o.char === delimiter.char && o.length === delimiter.length).lastIndexOf(true)
      : -1;
    if (openerIndex >= 0) {
      matched.push(openers[openerIndex], delimiter);
      openers.length = openerIndex;
    } else if (delimiter.canOpen) {
      openers.push(delimiter);
    }
  }
  return matched;
}

function pushStyled(tokens: LinkToken[], token: LinkToken, strong: number, em: number): void {
  const styled: LinkToken = { ...token };
  if (strong > 0) styled.strong = true;
  if (em > 0) styled.em = true;
  const last = tokens[tokens.length - 1];
  if (
    styled.type === "text" &&
    last?.type === "text" &&
    Boolean(last.strong) === Boolean(styled.strong) &&
    Boolean(last.em) === Boolean(styled.em)
  ) {
    last.text += styled.text;
  } else if (styled.type !== "text" || styled.text) {
    tokens.push(styled);
  }
}

/**
 * Turns matched "**", "*", "__" and "_" runs into strong and em flags on the
 * tokens between them. A run may span links and code spans; unmatched runs
 * stay as text.
 */
function applyEmphasis(tokens: LinkToken[]): LinkToken[] {
  const matched = matchDelimiters(findDelimiters(tokens));
  if (matched.length === 0) return tokens;

  const opening = new Set(matched.filter((_, i) => i % 2 === 0));
  const out: LinkToken[] = [];
  let strong = 0;
  let em = 0;
  tokens.forEach((token, tokenIndex) => {
    if (token.type !== "text") {
      pushStyled(out, token, strong, em);
      return;
    }
    const runs = matched
      .filter((d) => d.token === tokenIndex)
      .sort((a, b) => a.offset - b.offset);
    let pos = 0;
    for (const run of runs) {
      pushStyled(out, { type: "text", text: token.text.slice(pos, run.offset) }, strong, em);
      const step = opening.has(run) ? 1 : -1;
      if (run.length >= 2) strong += step;
      if (run.length !== 2) em += step;
      pos = run.offset + run.length;
    }
    pushStyled(out, { type: "text", text: token.text.slice(pos) }, strong, em);
  });
  return out;
}

function appendLinkToken(tokens: LinkToken[], match: RegExpExecArray): void {
  const groups = match.groups;
  if (groups?.mdUrl) {
    tokens.push({
      type: "external",
      text: groups.mdLabel ? stripCodeSpans(groups.mdLabel) : groups.mdUrl,
      href: groups.mdUrl,
    });
  } else if (groups?.wikiTarget) {
    tokens.push({
      type: "internal",
      text: groups.wikiAlias || groups.wikiTarget,
      href: groups.wikiTarget.trim(),
    });
  } else if (groups?.rawUrl) {
    const { url, trailing } = trimTrailingUrlPunctuation(groups.rawUrl);
    if (url.length > 0) {
      tokens.push({
        type: "external",
        text: url,
        href: url,
      });
    }
    if (trailing.length > 0) {
      appendTextToken(tokens, trailing);
    }
  }
}

/**
 * The text a renderer would leave behind for this value: "[[Page|Alias]]"
 * becomes "Alias", "`code`" becomes "code", "**bold**" becomes "bold". Lets
 * callers tell a flattened link, code span or emphasis from plain text.
 */
export function toPlainText(input: string): string {
  return parseLinkTokens(input)
    .map((token) => token.text)
    .join("");
}

export function renderTextWithLinks(
  container: HTMLElement,
  text: string,
  callbacks?: LinkRenderCallbacks
): void {
  const tokens = parseLinkTokens(text);

  for (const token of tokens) {
    let target = container;
    if (token.strong) target = target.createEl("strong");
    if (token.em) target = target.createEl("em");
    renderToken(target, token, callbacks);
  }
}

function renderToken(
  container: HTMLElement,
  token: LinkToken,
  callbacks?: LinkRenderCallbacks
): void {
  if (token.type === "text") {
    if ("appendText" in container && typeof container.appendText === "function") {
      container.appendText(token.text);
    } else {
      container.appendChild(container.ownerDocument.createTextNode(token.text));
    }
  } else if (token.type === "code") {
    // A span, not `code`: plugins that act on inline code (queries, inputs)
    // must not run on cell text.
    container.createEl("span", { cls: "ms-cell-code", text: token.text });
  } else if (token.type === "external") {
    const linkEl = container.createEl("a", {
      cls: "ms-cell-link external-link",
      text: token.text,
      href: token.href,
    });
    linkEl.setAttribute("target", "_blank");
    linkEl.setAttribute("rel", "noopener noreferrer");

    if (callbacks?.onExternalClick) {
      linkEl.addEventListener("click", (e) => {
        e.preventDefault();
        callbacks.onExternalClick?.(token.href ?? "", e);
      });
      linkEl.addEventListener("dblclick", (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
    }
  } else if (token.type === "internal") {
    const linkEl = container.createEl("a", {
      cls: "ms-cell-link internal-link",
      text: token.text,
    });
    if (token.href) {
      linkEl.dataset.href = token.href;
    }

    if (callbacks?.onInternalClick) {
      linkEl.addEventListener("click", (e) => {
        e.preventDefault();
        callbacks.onInternalClick?.(token.href ?? "", e);
      });
      linkEl.addEventListener("dblclick", (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
    }
  }
}
