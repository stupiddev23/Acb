"use strict";

// Web search helpers for AiChatBot.
// Uses only Node's built-in fetch (Node 18+), so no extra dependencies are needed.
//
// Providers:
//   "duckduckgo"  - DuckDuckGo results page, no API key needed (default)
//   "bing"        - Bing RSS feed, no API key needed
//   "wikipedia"   - Wikipedia search API, no API key needed
//   "searxng"     - your own SearXNG instance with format=json enabled (SEARCH_URL)
//   "brave"       - Brave Search API (SEARCH_API_KEY)
//   "tavily"      - Tavily Search API (SEARCH_API_KEY)

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";

const MAX_QUERY_CHARS = 200;

// Prompts that ask about things that change over time are worth a lookup.
const RECENCY_PATTERNS = [
  /\b(latest|newest|current|currently|today|tonight|tomorrow|yesterday|this (?:week|month|year)|right now|news|update[sd]?|release date|released|price|cost|how much|weather|forecast|score|scores|standings|stock|market|who won|how old is|population|election|president|ceo|owner of|earthquake)\b/i,
  /\b(19|20)\d{2}\b/,
];

// Prompts that explicitly ask the bot to look something up.
const EXPLICIT_PATTERNS = [
  /\b(web ?search|search the web|search online|search up|search for|look (?:it )?up|google it|find out|check online|on the internet|browse the (?:web|internet))\b/i,
];

// Triggers removed from the start of a prompt before it is used as a search query.
const QUERY_PREFIX_PATTERN =
  /^(?:(?:hey|ok|okay|yo|please|can you|could you|would you|do me a favor|for me)\s+)*(?:web ?search|search the web|search online|search up|search for|search|google it|google|look (?:it )?up|find out|check online|tell me)\b[:\s,-]*/i;

// Matches both the main DuckDuckGo results page (result__a / result__snippet)
// and the lite page (result-link / result-snippet), links and snippets alike.
const DDG_ENTRY_PATTERN =
  /<(a|td|div)\b([^>]*\bclass=["'][^"']*(?:result__a|result-link|result__snippet|result-snippet)[^"']*["'][^>]*)>([\s\S]*?)<\/\1>/gi;

function clampText(text, maxLength) {
  const value = String(text || "").replace(/\s+/g, " ").trim();

  if (value.length <= maxLength) return value;

  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function decodeEntities(text) {
  const named = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    hellip: "…",
    mdash: "—",
    ndash: "–",
    rsquo: "’",
    lsquo: "‘",
    rdquo: "”",
    ldquo: "“",
  };

  return String(text || "").replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    const key = entity.toLowerCase();

    if (key.startsWith("#x")) {
      const code = Number.parseInt(key.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }

    if (key.startsWith("#")) {
      const code = Number.parseInt(key.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }

    return Object.prototype.hasOwnProperty.call(named, key) ? named[key] : match;
  });
}

function stripHtml(text) {
  return decodeEntities(
    String(text || "")
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]*>/g, " ")
  )
    .replace(/\s+/g, " ")
    .trim();
}

function readTag(xml, tag) {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i").exec(xml);

  return match ? stripHtml(match[1]) : "";
}

async function fetchText(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        "user-agent": USER_AGENT,
        "accept-language": "en-US,en;q=0.9",
        ...(options.headers || {}),
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from ${new URL(url).host}`);
    }

    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, options = {}, timeoutMs = 8000) {
  const body = await fetchText(url, options, timeoutMs);

  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`Expected JSON from ${new URL(url).host}`);
  }
}

function normalizeResults(items, limit) {
  const seen = new Set();
  const results = [];

  for (const item of items) {
    const title = clampText(item.title, 120);
    const snippet = clampText(item.snippet, 320);
    const url = String(item.url || "").trim();

    if (!title && !snippet) continue;

    const key = (url || `${title}|${snippet}`).toLowerCase();

    if (seen.has(key)) continue;

    seen.add(key);
    results.push({ title, snippet, url });

    if (results.length >= limit) break;
  }

  return results;
}

// A bare site homepage ("https://www.cnn.com/") is almost never the answer a
// player asked for, and search engines fall back to those when they misread a query.
function isGenericHomepage(url) {
  try {
    const { pathname, search } = new URL(url);

    return (pathname === "/" || pathname === "") && !search;
  } catch {
    return false;
  }
}

// Drops homepage-only result sets so the next provider gets a chance instead of
// handing the model five unrelated news front pages.
function preferSpecificResults(results) {
  return results.filter((item) => item.url && !isGenericHomepage(item.url));
}

function isDuckDuckGoAdUrl(url) {
  try {
    const parsed = new URL(url);

    return (
      /(^|\.)duckduckgo\.com$/i.test(parsed.hostname) &&
      /\/(l\/)?y\.js$/i.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

// Turns a DuckDuckGo redirect (//duckduckgo.com/l/?uddg=...) into the real URL.
// Returns null for ad redirects so they can be skipped.
function decodeDuckDuckGoUrl(href) {
  const raw = decodeEntities(href).trim();

  if (!raw) return "";

  const absolute = raw.startsWith("//") ? `https:${raw}` : raw;

  try {
    const parsed = new URL(absolute);

    if (/(^|\.)duckduckgo\.com$/i.test(parsed.hostname)) {
      const target = parsed.searchParams.get("uddg");

      if (target) {
        let decoded = target;

        try {
          decoded = decodeURIComponent(target);
        } catch {
          decoded = target;
        }

        // y.js is DuckDuckGo's ad redirect, also reachable through uddg
        if (isDuckDuckGoAdUrl(decoded)) return null;

        return decoded;
      }

      if (isDuckDuckGoAdUrl(absolute)) return null;
    }

    return absolute;
  } catch {
    return raw;
  }
}

function parseDuckDuckGoHtml(html, limit) {
  const items = [];
  let current = null;

  for (const match of String(html).matchAll(DDG_ENTRY_PATTERN)) {
    const attributes = match[2];
    const inner = stripHtml(match[3]);

    if (/result__a|result-link/i.test(attributes)) {
      const hrefMatch = /href=["']([^"']*)["']/i.exec(attributes);
      const url = hrefMatch ? decodeDuckDuckGoUrl(hrefMatch[1]) : "";

      if (url === null) {
        current = null;
        continue;
      }

      current = { title: inner, snippet: "", url };
      items.push(current);
    } else if (current && inner) {
      current.snippet = current.snippet ? `${current.snippet} ${inner}` : inner;
    }
  }

  return normalizeResults(
    items.filter((item) => item.title || item.snippet),
    limit
  );
}

function parseBingRss(xml, limit) {
  const items = [...String(xml).matchAll(/<item>([\s\S]*?)<\/item>/gi)];

  return normalizeResults(
    items.map((match) => ({
      title: readTag(match[1], "title"),
      snippet: readTag(match[1], "description"),
      url: readTag(match[1], "link"),
    })),
    limit
  );
}

async function searchDuckDuckGo(query, { limit, timeout }) {
  const encoded = encodeURIComponent(query);
  const endpoints = [
    `https://html.duckduckgo.com/html/?q=${encoded}`,
    `https://lite.duckduckgo.com/lite/?q=${encoded}`,
  ];
  const errors = [];

  for (const endpoint of endpoints) {
    try {
      const results = parseDuckDuckGoHtml(await fetchText(endpoint, {}, timeout), limit);

      if (results.length) return results;

      errors.push(`${new URL(endpoint).host}: no results parsed`);
    } catch (error) {
      errors.push(`${new URL(endpoint).host}: ${error.message || error}`);
    }
  }

  // Some hosts (datacenter IPs) get an empty challenge page from DuckDuckGo.
  // The Jina reader fetches the same page from its own servers and returns the HTML.
  const proxyUrl = `https://r.jina.ai/${endpoints[1]}`;

  try {
    const results = parseDuckDuckGoHtml(
      await fetchText(proxyUrl, { headers: { "x-return-format": "html" } }, timeout),
      limit
    );

    if (results.length) return results;

    errors.push("r.jina.ai: no results parsed");
  } catch (error) {
    errors.push(`r.jina.ai: ${error.message || error}`);
  }

  throw new Error(errors.join("; "));
}

async function searchBing(query, { limit, timeout }) {
  const url =
    "https://www.bing.com/search?format=rss&count=" +
    `${Math.max(1, limit)}&q=${encodeURIComponent(query)}`;

  const results = parseBingRss(await fetchText(url, {}, timeout), limit);

  if (!results.length) throw new Error("Bing returned no usable results");

  return results;
}

async function searchWikipedia(query, { limit, timeout }) {
  const url =
    "https://en.wikipedia.org/w/api.php?action=query&list=search&format=json" +
    `&srlimit=${Math.max(1, limit)}&srsearch=${encodeURIComponent(query)}`;

  const data = await fetchJson(url, {}, timeout);
  const hits = (data.query && data.query.search) || [];

  const results = normalizeResults(
    hits.map((hit) => ({
      title: hit.title,
      snippet: hit.snippet,
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(
        String(hit.title || "").replace(/\s+/g, "_")
      )}`,
    })),
    limit
  );

  if (!results.length) throw new Error("Wikipedia returned no usable results");

  return results;
}

async function searchSearxng(query, { limit, timeout, url }) {
  if (!url) throw new Error("SEARCH_URL is required for the searxng provider");

  const endpoint =
    `${String(url).replace(/\/+$/, "")}/search?format=json&safesearch=1` +
    `&q=${encodeURIComponent(query)}`;

  const data = await fetchJson(endpoint, {}, timeout);

  const results = normalizeResults(
    (data.results || []).map((item) => ({
      title: item.title,
      snippet: item.content,
      url: item.url,
    })),
    limit
  );

  if (!results.length) throw new Error("SearXNG returned no usable results");

  return results;
}

async function searchBrave(query, { limit, timeout, apiKey }) {
  if (!apiKey) throw new Error("SEARCH_API_KEY is required for the brave provider");

  const url =
    `https://api.search.brave.com/res/v1/web/search?count=${Math.max(1, limit)}` +
    `&q=${encodeURIComponent(query)}`;

  const data = await fetchJson(
    url,
    {
      headers: {
        accept: "application/json",
        "x-subscription-token": apiKey,
      },
    },
    timeout
  );

  const results = normalizeResults(
    ((data.web && data.web.results) || []).map((item) => ({
      title: item.title,
      snippet: item.description,
      url: item.url,
    })),
    limit
  );

  if (!results.length) throw new Error("Brave returned no usable results");

  return results;
}

async function searchTavily(query, { limit, timeout, apiKey }) {
  if (!apiKey) throw new Error("SEARCH_API_KEY is required for the tavily provider");

  const data = await fetchJson(
    "https://api.tavily.com/search",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        max_results: Math.max(1, limit),
        search_depth: "basic",
      }),
    },
    timeout
  );

  const results = normalizeResults(
    (data.results || []).map((item) => ({
      title: item.title,
      snippet: item.content,
      url: item.url,
    })),
    limit
  );

  if (!results.length) throw new Error("Tavily returned no usable results");

  return results;
}

const PROVIDERS = {
  duckduckgo: searchDuckDuckGo,
  bing: searchBing,
  wikipedia: searchWikipedia,
  searxng: searchSearxng,
  brave: searchBrave,
  tavily: searchTavily,
};

const FALLBACK_CHAIN = ["duckduckgo", "bing", "wikipedia"];

function shouldSearchPrompt(prompt, mode = "auto") {
  const text = String(prompt || "").trim();

  if (!text) return false;

  if (mode === "off") return false;
  if (mode === "always") return true;

  if (EXPLICIT_PATTERNS.some((pattern) => pattern.test(text))) return true;

  // Very short small talk is not worth a lookup.
  if (text.length < 4) return false;

  return RECENCY_PATTERNS.some((pattern) => pattern.test(text));
}

function buildSearchQuery(prompt) {
  let query = String(prompt || "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(QUERY_PREFIX_PATTERN, "")
    .replace(/[?!.]+$/g, "")
    .trim();

  if (!query) query = String(prompt || "").trim();

  return clampText(query, MAX_QUERY_CHARS);
}

// Tries the configured provider first, then the keyless defaults.
// Resolves with { provider, query, results }. Rejects only when every provider fails.
async function webSearch(query, options = {}) {
  const totalTimeout = Number(options.timeout) || 8000;
  const deadline = Date.now() + totalTimeout;
  const settings = {
    limit: Number(options.limit) || 4,
    timeout: totalTimeout,
    apiKey: options.apiKey || "",
    url: options.url || "",
  };

  const primary = String(options.provider || "duckduckgo").toLowerCase();
  const order = [primary, ...FALLBACK_CHAIN.filter((name) => name !== primary)];
  const errors = [];

  for (const name of order) {
    const provider = PROVIDERS[name];

    if (!provider) {
      errors.push(`${name}: unknown provider`);
      continue;
    }

    const remaining = deadline - Date.now();

    if (remaining < 500) {
      errors.push(`${name}: skipped, search time budget used up`);
      continue;
    }

    try {
      const results = await provider(query, {
        ...settings,
        timeout: Math.min(settings.timeout, remaining),
      });
      const usable = preferSpecificResults(results);

      if (usable.length) return { provider: name, query, results: usable };

      errors.push(`${name}: only generic homepage results`);
    } catch (error) {
      errors.push(`${name}: ${error.message || error}`);
    }
  }

  throw new Error(errors.join("; "));
}

// Turns search results into a compact system message the model can use.
function formatSearchContext(result, maxChars = 900) {
  if (!result || !result.results || !result.results.length) {
    return clampText(
      "A web search was attempted but returned nothing useful. Answer from your own knowledge and say you are not sure if you do not know.",
      maxChars
    );
  }

  const header = `Web search results for "${result.query}" (source: ${result.provider}). Use them to answer, and mention that you looked it up online:`;
  const footer =
    "Answer from these results in one or two short sentences and do not invent facts they do not contain. If they do not actually answer the question, say you could not find a reliable answer.";

  // Keep room for header and footer so the instructions are never the part that gets cut.
  const budget = Math.max(160, maxChars - header.length - footer.length - 2);
  const lines = [];
  let used = 0;

  for (const [index, item] of result.results.entries()) {
    const head = `${index + 1}. ${item.title || "Result"}: `;
    const tail = item.url ? ` (${item.url})` : "";
    const room = budget - used - head.length - tail.length;

    if (room < 40) {
      if (lines.length) break;
    }

    // Always keep the first result, and always keep its title and URL:
    // only the snippet is shortened when the budget is tight.
    const snippet = clampText(item.snippet, Math.max(24, room));
    const line = `${head}${snippet}${tail}`.trim();

    lines.push(line);
    used += line.length + 1;
  }

  return [header, ...lines, footer].join(" ").trim().slice(0, Math.max(1, maxChars));
}

module.exports = {
  webSearch,
  shouldSearchPrompt,
  buildSearchQuery,
  formatSearchContext,
  // exported for tests
  parseDuckDuckGoHtml,
  parseBingRss,
  decodeDuckDuckGoUrl,
  isGenericHomepage,
  stripHtml,
  decodeEntities,
};
