"use strict";

// Keyless AI fallback for AiChatBot.
// Asks Pollinations' public text API, which needs no account, API key or sign up.
// Used only when the local Ollama model fails or admits it does not know an answer.

const DEFAULT_URL = "https://text.pollinations.ai/openai";
const DEFAULT_MODEL = "openai";
const DEFAULT_TIMEOUT = 20000;
const DEFAULT_MAX_CHARS = 400;
// The anonymous Pollinations tier answers once per 45 seconds per IP
const DEFAULT_COOLDOWN = 45000;

// Set after a successful reply or a 402, so the bot stops asking too early
let blockedUntil = 0;

// The model gave up instead of answering
const REFUSAL_PATTERNS = [
  /\bi (?:really )?(?:do not|don't) know\b/i,
  /\bi (?:do not|don't) (?:actually )?know\b/i,
  /\b(?:have|has) no idea\b/i,
  /\bno idea\b/i,
  /\bi (?:could not|couldn't|cannot|can't) (?:find|answer|figure|help with)\b/i,
  /\bi (?:do not|don't) have (?:that|any|enough) information\b/i,
  /\bunable to (?:answer|find|help)\b/i,
  /\bmy knowledge (?:is limited|does not|doesn't|cuts off)\b/i,
  /\bi (?:do not|don't) have access to\b/i,
];

// The model is hedging, which only matters when there is nothing else in the reply
const HEDGE_PATTERNS = [
  /\bi(?:'m| am) not sure\b/i,
  /\bi(?:'m| am) unsure\b/i,
  /\bnot (?:entirely |really |quite )?sure\b/i,
  /\bnot (?:entirely |really |quite )?certain\b/i,
];

const UNCERTAIN_PATTERNS = [...REFUSAL_PATTERNS, ...HEDGE_PATTERNS];

function looksUnsure(answer) {
  const text = String(answer || "").trim();

  if (!text) return true;

  // "I don't know" plus a long explanation is still worth sending
  if (REFUSAL_PATTERNS.some((pattern) => pattern.test(text))) {
    return text.length < 240;
  }

  // "I'm not sure, but ..." with a real answer after it is not a dead end
  if (HEDGE_PATTERNS.some((pattern) => pattern.test(text))) {
    return text.length < 120;
  }

  return false;
}

// Keeps the chat message short and free of markdown the game cannot show
function cleanAnswer(text, maxChars = DEFAULT_MAX_CHARS) {
  let value = String(text || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^[^:]{0,40}:\s*(?=\S)/, "")
    .replace(/[*_`#>|]+/g, "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  value = value.replace(/^["']|["']$/g, "").trim();

  if (value.length <= maxChars) return value;

  const cut = value.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(" ");

  return `${(lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

async function askFreeAI(options = {}) {
  const url = options.url || DEFAULT_URL;
  const model = options.model || DEFAULT_MODEL;
  const timeout = Number(options.timeout) || DEFAULT_TIMEOUT;
  const maxChars = Number(options.maxChars) || DEFAULT_MAX_CHARS;
  const cooldown = Number(options.cooldown) || DEFAULT_COOLDOWN;
  const question = String(options.question || "").trim();

  if (!question) throw new Error("No question to ask");

  const waitMs = blockedUntil - Date.now();

  if (waitMs > 0) {
    throw new Error(`Free AI cooling down for ${Math.ceil(waitMs / 1000)}s`);
  }

  const messages = [
    {
      role: "system",
      content:
        options.system ||
        "You are a friendly Minecraft player chatting in game.",
    },
  ];

  if (options.context) {
    messages.push({ role: "system", content: String(options.context) });
  }

  for (const turn of options.history || []) {
    if (!turn || !turn.role || !turn.content) continue;
    if (turn.role === "system") continue;

    messages.push({ role: turn.role, content: String(turn.content) });
  }

  messages.push({
    role: "user",
    content:
      `${question}\n\n` +
      "Reply with one or two short sentences that fit in a Minecraft chat box. " +
      "Plain text only, no markdown, no links, no slashes at the start.",
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  let data;

  try {
    const response = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: 220,
        temperature: 0.7,
        referrer: "aichatbot-minecraft",
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      const retrySeconds = /retry after (\d+)\s*s/i.exec(body);

      if (response.status === 402) {
        blockedUntil =
          Date.now() + (retrySeconds ? Number(retrySeconds[1]) * 1000 : cooldown);

        throw new Error("Free AI free tier limit reached, cooling down");
      }

      throw new Error(`HTTP ${response.status} from ${new URL(url).host}`);
    }

    data = await response.json();

    // Hold off until the next free slot instead of collecting 402s
    blockedUntil = Date.now() + cooldown;
  } finally {
    clearTimeout(timer);
  }

  const raw = data && data.choices && data.choices[0] && data.choices[0].message;

  if (!raw || !raw.content) {
    throw new Error(`Unexpected answer from ${new URL(url).host}`);
  }

  const answer = cleanAnswer(raw.content, maxChars);

  if (!answer) throw new Error("The free AI returned an empty answer");

  return answer;
}

module.exports = {
  askFreeAI,
  looksUnsure,
  cleanAnswer,
  UNCERTAIN_PATTERNS,
};
