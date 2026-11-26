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

export interface ExtractedCitations {
  body: string;
  sources: CitationSource[];
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
