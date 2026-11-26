/**
 * Parses trailing markdown citation blocks (`Sources:` / `References:` / `来源：`)
 * into structured sources so GUI and TUI can render them quietly while keeping
 * full compatibility with persisted Markdown transcripts and raw CLI output.
 */

export interface CitationSource {
  id?: number;
  title: string;
  url: string;
  domain: string;
}

export interface ElicitationItem {
  label: string;
  query: string;
}

export interface ElicitationsGroup {
  message?: string;
  items: ElicitationItem[];
}

export interface ExtractedCitations {
  body: string;
  sources: CitationSource[];
}

export interface ExtractedElicitations {
  body: string;
  elicitations: ElicitationsGroup | null;
}

export interface ParsedReply {
  body: string;
  sources: CitationSource[];
  elicitations: ElicitationsGroup | null;
}

const ELICITATIONS_GROUP_RE =
  /<ElicitationsGroup\b([^>]*)>([\s\S]*?)<\/ElicitationsGroup>/gi;

const ELICITATION_ITEM_RE =
  /<Elicitation\b([^>]*?)(?:\/>|>([\s\S]*?)<\/Elicitation>)/gi;

const XML_ATTR_RE = /\b([A-Za-z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function decodeXmlEntities(text: string): string {
  return text
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function normalizeAttrText(raw: string): string {
  const decoded = decodeXmlEntities(raw).trim();
  // Collapse wrapped lines inside attribute values without inserting awkward
  // spaces between CJK characters.
  return decoded
    .replace(
      /([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])[ \t]*\r?\n[ \t]*([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])/gu,
      "$1$2",
    )
    .replace(/\s*\r?\n\s*/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function parseXmlAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  XML_ATTR_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = XML_ATTR_RE.exec(raw)) !== null) {
    const key = match[1]?.toLowerCase();
    const value = match[2] ?? match[3] ?? "";
    if (key) attrs[key] = normalizeAttrText(value);
  }
  return attrs;
}

/**
 * Extracts Gemini `<ElicitationsGroup>` follow-up suggestions from prose.
 * Returns the cleaned body plus parsed follow-up items (if any).
 */
export function extractElicitations(text: string): ExtractedElicitations {
  if (!text || !/<ElicitationsGroup\b/i.test(text)) {
    return { body: text, elicitations: null };
  }

  let message: string | undefined;
  const items: ElicitationItem[] = [];
  const seen = new Set<string>();

  const cleaned = text.replace(
    ELICITATIONS_GROUP_RE,
    (_full, groupAttrsRaw: string, inner: string) => {
      const groupAttrs = parseXmlAttrs(groupAttrsRaw);
      if (!message && groupAttrs.message) message = groupAttrs.message;

      ELICITATION_ITEM_RE.lastIndex = 0;
      let itemMatch: RegExpExecArray | null;
      while ((itemMatch = ELICITATION_ITEM_RE.exec(inner)) !== null) {
        const attrs = parseXmlAttrs(itemMatch[1] ?? "");
        const fallback = normalizeAttrText(itemMatch[2] ?? "");
        const label = attrs.label || attrs.query || fallback;
        const query = attrs.query || attrs.label || fallback;
        if (!label || !query) continue;
        const key = `${label}\0${query}`;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push({ label, query });
      }
      return "";
    },
  );

  if (items.length === 0) {
    // Still strip empty/malformed ElicitationsGroup shells cleanly.
    return { body: cleaned.trimEnd(), elicitations: null };
  }

  return {
    body: cleaned.replace(/\n{3,}/g, "\n\n").trimEnd(),
    elicitations: { message, items },
  };
}

/**
 * Parses both trailing `Sources:` blocks and `<ElicitationsGroup>` follow-ups
 * in either order so GUI and TUI render clean prose plus quiet interactive UI.
 */
export function parseReplyContent(markdown: string): ParsedReply {
  if (!markdown) return { body: "", sources: [], elicitations: null };
  const firstCitations = extractCitations(markdown);
  const elicited = extractElicitations(firstCitations.body);
  if (firstCitations.sources.length > 0) {
    return {
      body: elicited.body,
      sources: firstCitations.sources,
      elicitations: elicited.elicitations,
    };
  }
  const secondCitations = extractCitations(elicited.body);
  return {
    body: secondCitations.body,
    sources: secondCitations.sources,
    elicitations: elicited.elicitations,
  };
}

const TRAILING_SOURCES_BLOCK =
  /\n+(?:---+\s*\n+)?(?:Sources|References|来源)[:：]\s*\n((?:[ \t]*[-*]\s+.+(?:\n|$))+)\s*$/i;

const BULLET_LINK_RE =
  /^[ \t]*[-*]\s+(?:\[(\d+)\]\s+)?\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)\s*$/;

const BULLET_BARE_URL_RE =
  /^[ \t]*[-*]\s+(?:\[(\d+)\]\s+)?(https?:\/\/\S+)\s*$/;

const INLINE_CITE_RE = /\[cite:\s*([0-9,\s]+)\]/gi;

export function domainOfUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return url;
  }
}

function parseBulletLine(line: string): CitationSource | null {
  const mdMatch = BULLET_LINK_RE.exec(line);
  if (mdMatch) {
    const id = mdMatch[1] ? Number(mdMatch[1]) : undefined;
    const rawTitle = mdMatch[2]?.trim() ?? "";
    const url = mdMatch[3]?.trim() ?? "";
    if (!url) return null;
    const domain = domainOfUrl(url);
    return {
      id: id && Number.isFinite(id) ? id : undefined,
      title: rawTitle || domain,
      url,
      domain,
    };
  }
  const bareMatch = BULLET_BARE_URL_RE.exec(line);
  if (bareMatch) {
    const id = bareMatch[1] ? Number(bareMatch[1]) : undefined;
    const url = bareMatch[2]?.trim() ?? "";
    if (!url) return null;
    const domain = domainOfUrl(url);
    return {
      id: id && Number.isFinite(id) ? id : undefined,
      title: domain,
      url,
      domain,
    };
  }
  return null;
}

export function extractCitations(markdown: string): ExtractedCitations {
  if (!markdown) return { body: "", sources: [] };
  const match = TRAILING_SOURCES_BLOCK.exec(markdown);
  if (!match) return { body: markdown, sources: [] };

  const rawLines = (match[1] ?? "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  if (rawLines.length === 0) return { body: markdown, sources: [] };

  const sources: CitationSource[] = [];
  const seenUrls = new Set<string>();
  const byId = new Map<number, CitationSource>();

  for (const line of rawLines) {
    const parsed = parseBulletLine(line);
    // Strict guard: if any bullet is not a real URL citation, leave prose untouched.
    if (!parsed) return { body: markdown, sources: [] };
    if (parsed.id !== undefined && !byId.has(parsed.id)) {
      byId.set(parsed.id, parsed);
    }
    if (seenUrls.has(parsed.url)) continue;
    seenUrls.add(parsed.url);
    sources.push(parsed);
  }

  let body = markdown.slice(0, match.index).trimEnd();
  if (byId.size > 0 && INLINE_CITE_RE.test(body)) {
    body = body.replace(INLINE_CITE_RE, (full, list: string) => {
      const links = list
        .split(",")
        .map((part) => part.trim())
        .filter((part) => /^\d+$/.test(part))
        .map((part) => {
          const num = Number(part);
          const found = byId.get(num);
          return found ? `[${num}](${found.url})` : `[${num}]`;
        });
      return links.length > 0 ? links.join(" ") : full;
    });
  }

  return { body, sources };
}

export function mergeCitations(lists: CitationSource[][]): CitationSource[] {
  const merged: CitationSource[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    for (const item of list) {
      if (seen.has(item.url)) continue;
      seen.add(item.url);
      merged.push(item);
    }
  }
  return merged;
}
