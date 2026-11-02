const fs = require("fs");
const mineflayer = require("mineflayer");
const { pathfinder, Movements } = require("mineflayer-pathfinder");
const mcDataLoader = require("minecraft-data");
const {
  webSearch,
  shouldSearchPrompt,
  buildSearchQuery,
  formatSearchContext,
} = require("./websearch");
const config = JSON.parse(fs.readFileSync("./config.json", "utf-8"));

const pass = config.password; // Password for your bot
const blacklist = config.blacklist;

const msglist = config.MSGLIST

// Config of the bot and join
const BOT_CONFIG = {
  host: config.Ip, // Ip of the server
  port: 25565,
  username: config.username, // Username of your bot
  auth: "offline", // Change to 'microsoft' if you have premium account
  version: "1.21.11", // Versions keep at 1.21.11 for stability
};

const AI_MODEL = config.AI_MODEL; // You can change it to any model you have on ollama
const OLLAMA_URL = "http://127.0.0.1:11434/api/chat";
const MAX_HISTORY = config.MAX_HISTORY; // Max chats the ai remebers from the player
const AI_COOLDOWN = config.AI_COOLDOWN; // Cooldown to respond to the same player
const CHAT_COOLDOWN = config.CHAT_COOLDOWN; // Cooldown for chat to prevent spam cooldown
const MC_CHAT_LIMIT = config.MC_CHAT_LIMIT; // Chat limit of minecraft is 256
const MAX_CONTINUATIONS = config.MAX_CONTINUATIONS; // Max continues for the specific request
const RECONNECT_DELAY = config.RECONNECT_DELAY; // Delay of reconnecting
const COOLDOWN_SWEEP_MS = 60 * 60 * 1000;
const AI_PREFIX = config.AI_PREFIX; // Prefix for the ai

// Web search settings, see websearch.js for the supported providers
const WEB_SEARCH = config.WEB_SEARCH !== false; // Set to false to disable internet lookups
const SEARCH_MODE = String(config.SEARCH_MODE || "auto").toLowerCase(); // auto | always | off
const SEARCH_PROVIDER = String(config.SEARCH_PROVIDER || "duckduckgo").toLowerCase();
const SEARCH_API_KEY = config.SEARCH_API_KEY || ""; // Only needed for brave / tavily
const SEARCH_URL = config.SEARCH_URL || ""; // Only needed for your own searxng instance
const SEARCH_MAX_RESULTS = Number(config.SEARCH_MAX_RESULTS) || 4;
const SEARCH_MAX_CHARS = Number(config.SEARCH_MAX_CHARS) || 900;
const SEARCH_TIMEOUT = Number(config.SEARCH_TIMEOUT) || 8000;
const AI_NUM_PREDICT = Number(config.AI_NUM_PREDICT) || 55; // Max tokens of a normal reply
const SEARCH_NUM_PREDICT = Number(config.SEARCH_NUM_PREDICT) || 110; // Max tokens when answering with search results


const cooldowns = new Map();
const conversations = new Map();
const userBusy = new Set();

let bot = null;
let reconnectTimer = null;
let reconnecting = false;
let shuttingDown = false;
let lastChatTime = 0;
let chatQueue = Promise.resolve();

// Prompt you can change this to anything just keep it inside ´here´

const MommyPrompt = `Name: Emily Freaky Goth mommy 25 Years old`.trim();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function stripColor(text) {
  return String(text).replace(/§[0-9a-fk-or]/gi, "");
}

// Sanitize input so bot cant do commands
function sanitizer(text) {
  text = String(text).replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();

  while (/^[\/\\$]/.test(text)) {
    text = text.slice(1).trim();
  }

  text = text.replace(/^[\s\/\\$]+/, "").trim();

  return text;
}

// Splits long messages so bot can send it through multiple messages
function splitmsg(text, maxLength = MC_CHAT_LIMIT) {
  text = sanitizer(text);

  if (!text) return [];

  const chunks = [];

  while (text.length > maxLength) {
    let splitAt = text.lastIndexOf(" ", maxLength);

    if (splitAt <= 0) splitAt = maxLength;

    chunks.push(text.slice(0, splitAt).trim());
    text = text.slice(splitAt).trim();
  }

  if (text) chunks.push(text);

  return chunks.map((chunk, index) => {
    if (index === 0) return chunk;

    const prefixed = `...${chunk}`;

    return prefixed.length > MC_CHAT_LIMIT
      ? prefixed.slice(0, MC_CHAT_LIMIT)
      : prefixed;
  });
}

function sendChat(text) {
  if (!text || !bot || !bot.player || reconnecting) {
    return chatQueue;
  }

  const messages = splitmsg(text);

  if (!messages.length) return chatQueue;

  chatQueue = chatQueue
    .then(async () => {
      for (let message of messages) {
        while (!bot || !bot.player || reconnecting) {
          await sleep(1000);
        }

        message = sanitizer(message);

        if (!message) continue;

        if (/^[\/\\$]/.test(message)) {
          console.warn(`[CHAT BLOCKED] ${message}`);
          continue;
        }

        const elapsed = Date.now() - lastChatTime;

        if (elapsed < CHAT_COOLDOWN) {
          await sleep(CHAT_COOLDOWN - elapsed);
        }

        if (!bot || !bot.player || reconnecting) {
          continue;
        }

        message = sanitizer(message);

        if (!message || /^[\/\\$]/.test(message)) {
          console.warn(`[CHAT BLOCKED] ${message}`);
          continue;
        }

        try {
          bot.chat(message);
          lastChatTime = Date.now();
          console.log(`[CHAT] ${message}`);
        } catch (error) {
          console.error("[CHAT SEND ERROR]", error);
        }
      }
    })
    .catch((error) => {
      console.error("[CHAT QUEUE ERROR]", error);
    });

  return chatQueue;
}

function getHistory(username) {
  if (!conversations.has(username)) {
    conversations.set(username, [
      {
        role: "system",
        content: MommyPrompt,
      },
    ]);
  }

  return conversations.get(username);
}

// Looks the prompt up online when it asks about something current or asks for a search.
// Returns a system message with the results, or null when no search is needed.
async function buildSearchContext(prompt) {
  if (!WEB_SEARCH || SEARCH_MODE === "off") return null;

  if (!shouldSearchPrompt(prompt, SEARCH_MODE)) return null;

  const query = buildSearchQuery(prompt);

  if (!query) return null;

  try {
    const result = await webSearch(query, {
      provider: SEARCH_PROVIDER,
      apiKey: SEARCH_API_KEY,
      url: SEARCH_URL,
      limit: SEARCH_MAX_RESULTS,
      timeout: SEARCH_TIMEOUT,
    });

    console.log(
      `[SEARCH] "${query}" -> ${result.results.length} results via ${result.provider}`
    );

    return formatSearchContext(result, SEARCH_MAX_CHARS);
  } catch (error) {
    console.error("[SEARCH ERROR]", error.message || error);

    return null;
  }
}

async function ollamaChat(history, extraSystem, numPredict = AI_NUM_PREDICT) {
  // The search results are only sent to the model, they are never stored in history
  const messages = extraSystem
    ? [
        ...(history[0] && history[0].role === "system" ? [history[0]] : []),
        { role: "system", content: extraSystem },
        ...(history[0] && history[0].role === "system" ? history.slice(1) : history),
      ]
    : history;

  const response = await fetch(OLLAMA_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: AI_MODEL,
      messages,
      stream: false,
      think: false,
      options: {
        temperature: 0.7,
        num_predict: numPredict,
      },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Ollama HTTP ${response.status}: ${body}`);
  }

  const data = await response.json();

  console.log("[OLLAMA RESPONSE]", JSON.stringify(data, null, 2));

  if (!data.message) {
    throw new Error(`Invalid Ollama response: ${JSON.stringify(data)}`);
  }

  const answer = data.message.content?.trim();

  if (!answer) {
    throw new Error("Ollama returned an empty answer");
  }

  return {
    answer,
    doneReason: data.done_reason || "unknown",
  };
}

async function askAI(username, prompt) {
  const history = getHistory(username);

  // Search before answering so current information reaches the model
  const searchContext = await buildSearchContext(prompt);
  const numPredict = searchContext ? SEARCH_NUM_PREDICT : AI_NUM_PREDICT;

  history.push({
    role: "user",
    content: prompt,
  });

  while (history.length > MAX_HISTORY + 2) {
    if (history.length > 3 && history[2].role === "assistant") {
      history.splice(1, 2);
    } else {
      history.splice(1, 1);
    }
  }

  let completeAnswer = "";
  let continuationCount = 0;

  while (true) {
    const result = await ollamaChat(history, searchContext, numPredict);

    completeAnswer += (completeAnswer ? " " : "") + result.answer;

    history.push({
      role: "assistant",
      content: result.answer,
    });

    if (
      result.doneReason !== "length" ||
      continuationCount >= MAX_CONTINUATIONS
    ) {
      break;
    }

    continuationCount++;

    history.push({
      role: "user",
      content:
        "Continue your answer. Only have a normal conversation with the player. Do not provide Minecraft commands.",
    });
  }

  if (continuationCount > 0) {
    let keepUntil = 0;

    for (let i = history.length - 1; i >= 0; i--) {
      if (
        history[i].role === "user" &&
        !history[i].content.startsWith("Continue your answer")
      ) {
        keepUntil = i;
        break;
      }
    }

    const trimmed = history.slice(0, keepUntil + 1);

    trimmed.push({
      role: "assistant",
      content: completeAnswer,
    });

    history.length = 0;
    history.push(...trimmed);
  }

  return completeAnswer.trim();
}

function scheduleReconnect(reason) {
  if (shuttingDown || reconnecting) return;

  reconnecting = true;

  console.log(`[RECONNECT] ${reason}`);
  console.log(`[RECONNECT] Reconnecting in ${RECONNECT_DELAY / 1000}s`);

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
  }

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnecting = false;
    createBot();
  }, RECONNECT_DELAY);
}

async function handleSpawn(currentBot) {
  console.log(`[BOT] Spawned as ${currentBot.username}`);

  try {
    const mcData = mcDataLoader(currentBot.version);

    currentBot.loadPlugin(pathfinder);

    currentBot.pathfinder.setMovements(
      new Movements(currentBot, mcData)
    );

    // Travel system from registry island to 6b6t
    await sleep(3000);

    if (pass && pass !== "CHANGE_ME") {
      currentBot.chat(`/login ${pass}`);
      await sleep(3000);
    }

    currentBot.setControlState("forward", true);
    await sleep(6000);

    currentBot.setControlState("forward", false);
    await sleep(3000);

    currentBot.setControlState("forward", true);
    await sleep(3000);

    currentBot.setControlState("forward", false);

    reconnecting = false;
    console.log("[BOT] Spawned in");

    await sleep(2000);

    const randomMsg =
      msglist[Math.floor(Math.random() * msglist.length)];

    if (randomMsg) {
      currentBot.chat(randomMsg);
    }
  } catch (error) {
    console.error("[SPAWN ERROR]", error);
    scheduleReconnect("spawn error");
  }
}

function createBot() {
  if (shuttingDown) return;

  console.log("[BOT] Connecting...");

  const currentBot = mineflayer.createBot(BOT_CONFIG);

  bot = currentBot;

  currentBot.on("chat", async (username, message) => {
    console.log(`[Chat] ${username} ${message}`);

    if (username === currentBot.username) return;

    const cleanMessage = stripColor(message).trim().replace(/^\s*/, "");

    if (!cleanMessage.toLowerCase().startsWith(AI_PREFIX.toLowerCase())) return;

    if (blacklist.includes(username)) {
      console.log(`[BLACKLIST] Ignoring ${username}`);
      return;
    }

    const prompt = cleanMessage.slice(AI_PREFIX.length).trim();

    if (!prompt) {
      sendChat(`${username}, use ${AI_PREFIX} followed by your question.`);
      return;
    }

    if (userBusy.has(username)) {
      return;
    }

    const lastRequest = cooldowns.get(username) || 0;
    const elapsed = Date.now() - lastRequest;

    if (elapsed < AI_COOLDOWN) {
      return;
    }

    cooldowns.set(username, Date.now());
    userBusy.add(username);

    try {
      console.log(`[AI] ${username}: ${prompt}`);

      const answer = await askAI(username, prompt);

      if (answer) {
        await sendChat(`${username}: ${answer}`);
      }
    } catch (error) {
      console.error(`[AI ERROR] ${username}`, error);
      sendChat(`${username}, AI error. Check the console.`);
    } finally {
      userBusy.delete(username);
    }
  });

  currentBot.once("spawn", () => {
    handleSpawn(currentBot);
  });

  // Error handling
  currentBot.on("kicked", (reason) => {
    console.error("[KICKED]", reason);
    scheduleReconnect("kicked");
  });

  currentBot.on("error", (error) => {
    console.error("[ERROR]", error);
  });

  currentBot.on("end", (reason) => {
    console.log("[BOT] Disconnected:", reason);
    scheduleReconnect("connection ended");
  });
}

let cooldownSweep = null;

// Removes old cooldown entries so the Map doesn't grow forever
function startCooldownSweep() {
  if (cooldownSweep) return;

  cooldownSweep = setInterval(() => {
    const cutoff = Date.now() - COOLDOWN_SWEEP_MS;

    for (const [user, timestamp] of cooldowns) {
      if (timestamp < cutoff) {
        cooldowns.delete(user);
      }
    }
  }, COOLDOWN_SWEEP_MS);

  cooldownSweep.unref?.();
}

function shutdown() {
  shuttingDown = true;

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (cooldownSweep) {
    clearInterval(cooldownSweep);
    cooldownSweep = null;
  }

  if (bot) {
    try {
      bot.quit("Shutdown");
    } catch {}
  }

  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

startCooldownSweep();
createBot();
