require("dotenv").config();
const crypto = require("crypto");
const db = require("./db");
const dayjs = require("dayjs");
const relativeTime = require("dayjs/plugin/relativeTime");
require("dayjs/locale/ru");

dayjs.extend(relativeTime);
dayjs.locale("ru");

const PROMPTS = {
  ONBOARD_APP: "onboard_app",
  ONBOARD_WRITING: "onboard_writing",
  ONBOARD_SEARCHES: "onboard_searches",
  EDIT_APP: "edit_app",
  EDIT_WRITING: "edit_writing",
  EDIT_SEARCHES: "edit_searches",
};

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// --- Prompt builders ---

function buildSystemPrompt(profile) {
  return `You are a helpful member of the Reddit community who participates genuinely in discussions. You have a product or project you care about and may mention it naturally when it truly fits the conversation.

ABOUT YOUR APP / PROJECT (only state what is given below; do not invent features):
${profile.app_context?.trim() || "(not specified)"}

HOW TO WRITE REPLIES (follow closely):
${profile.writing_context?.trim() || "Be concise, helpful, and human. Mention the product only when it fits naturally."}

BASE RULES:
1. Be genuinely helpful first. Answer the question thoughtfully.
2. Do not be pushy or salesy. Community value comes first.
3. Keep replies roughly 3–6 sentences unless the instructions above say otherwise.
4. Write in the same language as the original post when reasonable.
5. Sound like a real person: warm, direct, not corporate.`;
}

function buildRelevancePrompt(post, profile) {
  const ctx = (profile.app_context || "").slice(0, 2500);
  return `You filter Reddit posts for someone who might plausibly participate in the thread and mention (when relevant) this product / project:

${ctx || "(no product description provided — be conservative and answer no)"}

Post title: ${post.title}
Subreddit: r/${post.subreddit}
Body (excerpt): ${(post.text || "").slice(0, 500)}

Reply with ONLY "yes" or "no" and one short reason.
"yes" = the post is in a topic area where this product could genuinely help or the discussion is clearly related.
"no" = off-topic, wrong niche, or mentioning the product would feel like spam.
When truly uncertain, say yes.`;
}

// --- Apify / LLM ---

async function fetchPostsViaApify(searchQueries) {
  const token = process.env.APIFY_API_TOKEN;
  const queries = Array.isArray(searchQueries)
    ? searchQueries.map((q) => String(q).trim()).filter(Boolean)
    : [];

  if (queries.length === 0) {
    console.warn("Apify: no search queries configured");
    return [];
  }

  let allPosts = [];

  for (const query of queries) {
    console.log(`Apify search: "${query}"`);

    const res = await fetch(
      `https://api.apify.com/v2/acts/automation-lab~reddit-scraper/run-sync-get-dataset-items?token=${token}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          searchQuery: query,
          sort: "relevance",
          timeFilter: "day",
          maxPostsPerSource: 20,
          includeComments: false,
          deduplicatePosts: true,
        }),
        signal: AbortSignal.timeout(290000),
      },
    );

    if (!res.ok) {
      const text = await res.text();
      console.error(`  Apify error for "${query}": ${res.status} ${text}`);
      continue;
    }

    const items = await res.json();
    const posts = items.filter((item) => item.type === "post");
    allPosts.push(...posts);
  }

  const unique = new Map();
  for (const item of allPosts) {
    if (item.id && !unique.has(item.id)) {
      unique.set(item.id, item);
    }
  }

  return [...unique.values()].map((item) => ({
    id: item.id,
    title: item.title || "",
    text: item.selfText || "",
    subreddit: item.subreddit || "",
    url: item.url || "",
    permalink: item.permalink || "",
    postedDate: item.createdAt ? new Date(item.createdAt) : null,
    votes: item.score || 0,
    numComments: item.numComments || 0,
    author: item.author || "",
  }));
}

async function checkRelevance(post, profile) {
  const prompt = buildRelevancePrompt(post, profile);

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
    },
    body: JSON.stringify({
      model: "google/gemini-2.5-flash",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 100,
      temperature: 0,
    }),
  });

  if (!res.ok) {
    console.error(`    Relevance check error: ${res.status}`);
    return false;
  }

  const data = await res.json();
  const answer = (data?.choices?.[0]?.message?.content || "").toLowerCase();
  console.log(`    Relevance: ${answer.trim()}`);
  return answer.startsWith("yes");
}

async function generateReply(post, profile) {
  const system = buildSystemPrompt(profile);
  const prompt = `Here is a Reddit post I want you to reply to:

Subreddit: r/${post.subreddit}
Title: ${post.title}
Body: ${post.text || "(no body)"}
URL: ${post.url}

Write a helpful Reddit comment reply. Follow your rules strictly.`;

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
    },
    body: JSON.stringify({
      model: "google/gemini-2.5-flash",
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
      max_tokens: 500,
      temperature: 0.7,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`OpenRouter error: ${res.status} ${text}`);
    return null;
  }

  const data = await res.json();
  return data?.choices?.[0]?.message?.content || null;
}

// --- Telegram ---

const TG_BASE = () =>
  `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

function mainMenuMarkup() {
  return JSON.stringify({
    inline_keyboard: [
      [{ text: "🔍 Найти новые вопросы", callback_data: "scan" }],
      [{ text: "⚙️ Настройки", callback_data: "open_settings" }],
    ],
  });
}

function settingsMarkup() {
  return JSON.stringify({
    inline_keyboard: [
      [{ text: "🚀 Информация о продукте", callback_data: "edit_app" }],
      [{ text: "💬 Как писать ответы", callback_data: "edit_writing" }],
      [{ text: "🔎 Критерии поиска вопросов", callback_data: "edit_searches" }],
      [{ text: "« В меню", callback_data: "back_menu" }],
    ],
  });
}

async function sendTelegram(chatId, text, opts = {}) {
  const bodyText = typeof text === "string" ? text.trim() : "";
  if (!bodyText) {
    console.warn("sendTelegram: skipped empty text", { chatId });
    return { ok: false, description: "empty text skipped" };
  }
  const res = await fetch(`${TG_BASE()}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: bodyText,
      disable_web_page_preview: true,
      ...opts,
    }),
  });

  const data = await res.json();
  if (!data.ok) {
    console.error("Telegram error:", data);
  }
  return data;
}

/** Native "typing…" in the chat bar; Telegram clears it after ~5s, so refresh for long work. */
async function sendTelegramChatAction(chatId, action = "typing") {
  const res = await fetch(`${TG_BASE()}/sendChatAction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action }),
  });
  const data = await res.json();
  if (!data.ok) {
    console.error("Telegram sendChatAction error:", data);
  }
  return data;
}

async function answerCallback(callbackQueryId) {
  await fetch(`${TG_BASE()}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId }),
  });
}

// --- Telegram Stars: один запуск поиска = N ⭐ (digital goods, валюта XTR) ---

const SCAN_PRICE_STARS = Math.max(
  1,
  Math.min(
    100_000,
    Number.parseInt(process.env.SCAN_COST_STARS || "5", 10) || 5,
  ),
);

/** Сколько первых успешных поисков без Stars (0 = сразу только платно). */
const FREE_SCANS = Math.max(
  0,
  Math.min(
    10_000,
    Number.parseInt(process.env.FREE_SCANS_COUNT || "3", 10) || 3,
  ),
);

const pendingScanInvoices = new Map(); // invoice payload -> { chatId, at }
const PENDING_INVOICE_TTL_MS = 60 * 60 * 1000;

function prunePendingScanInvoices() {
  const now = Date.now();
  for (const [payload, v] of pendingScanInvoices) {
    if (now - v.at > PENDING_INVOICE_TTL_MS) pendingScanInvoices.delete(payload);
  }
}

function registerPendingScanInvoice(chatId) {
  prunePendingScanInvoices();
  const token = crypto.randomBytes(12).toString("hex");
  const payload = `scan:${chatId}:${token}`;
  pendingScanInvoices.set(payload, { chatId, at: Date.now() });
  return payload;
}

async function answerPreCheckoutQuery(preCheckoutQueryId, ok, errorMessage) {
  const body = ok
    ? { pre_checkout_query_id: preCheckoutQueryId, ok: true }
    : {
        pre_checkout_query_id: preCheckoutQueryId,
        ok: false,
        error_message: errorMessage || "Платёж отклонён.",
      };
  const res = await fetch(`${TG_BASE()}/answerPreCheckoutQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) {
    console.error("answerPreCheckoutQuery error:", data);
  }
  return data;
}

async function sendScanStarsInvoice(chatId) {
  const payload = registerPendingScanInvoice(chatId);
  const res = await fetch(`${TG_BASE()}/sendInvoice`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      title: "Поиск на Reddit",
      description: `Один запуск поиска по твоим запросам — ${SCAN_PRICE_STARS} ⭐`,
      payload,
      provider_token: "",
      currency: "XTR",
      prices: [{ label: "Запуск поиска", amount: SCAN_PRICE_STARS }],
    }),
  });
  const data = await res.json();
  if (!data.ok) {
    pendingScanInvoices.delete(payload);
    console.error("sendInvoice error:", data);
    await sendTelegram(
      chatId,
      "Не удалось выставить счёт. В @BotFather → твой бот → Payments включи приём Stars для цифровых товаров.",
    );
  }
  return data;
}

async function handlePreCheckoutQuery(q) {
  const id = q.id;
  const payload = q.invoice_payload;
  const currency = q.currency;
  const total = q.total_amount;
  const fromId = q.from?.id;

  const fail = (msg) => answerPreCheckoutQuery(id, false, msg);

  prunePendingScanInvoices();
  if (currency !== "XTR" || total !== SCAN_PRICE_STARS) {
    await fail("Неверная сумма или валюта.");
    return;
  }
  const pending = pendingScanInvoices.get(payload);
  if (!pending || pending.chatId !== fromId) {
    await fail("Счёт устарел. Нажми «Найти новые вопросы» снова.");
    return;
  }
  await answerPreCheckoutQuery(id, true);
}

async function handleSuccessfulScanPayment(msg) {
  const sp = msg.successful_payment;
  if (!sp) return;
  const payload = sp.invoice_payload;
  const chatId = msg.chat.id;

  if (sp.currency !== "XTR" || sp.total_amount !== SCAN_PRICE_STARS) {
    console.warn("successful_payment: unexpected amount/currency", sp);
    return;
  }

  prunePendingScanInvoices();
  const pending = pendingScanInvoices.get(payload);
  if (!pending || pending.chatId !== chatId) {
    console.warn("successful_payment: unknown or stale payload");
    return;
  }
  pendingScanInvoices.delete(payload);
  void runScan(chatId);
}

/** Проверки как у runScan, затем счёт Stars; поиск стартует после successful_payment. */
async function requestPaidScan(chatId) {
  if (scanningByChat.get(chatId)) {
    await sendTelegram(chatId, "⏳ Поиск уже идёт, подожди...");
    return;
  }

  let profile;
  try {
    profile = await db.getBotUser(chatId);
  } catch (e) {
    console.error(e);
    await sendTelegram(
      chatId,
      "❌ Не удалось прочитать профиль из Supabase. Проверь SUPABASE_URL и ключ в переменных окружения хоста.",
    );
    return;
  }

  if (!profile?.setup_complete) {
    await sendTelegram(chatId, "Сначала закончи настройку: /start");
    return;
  }

  const queries = Array.isArray(profile.search_queries)
    ? profile.search_queries
    : [];
  if (queries.length === 0) {
    await sendTelegram(
      chatId,
      "Нет поисковых запросов. Открой ⚙️ Настройки → Поиски Reddit.",
    );
    return;
  }

  const used = Math.max(0, Math.floor(Number(profile.completed_scan_count) || 0));
  if (FREE_SCANS > 0 && used < FREE_SCANS) {
    void runScan(chatId);
    return;
  }

  await sendScanStarsInvoice(chatId);
}

function normSearchQueriesFromText(text) {
  return text
    .split(/\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function onboardingInstruction(step) {
  switch (step) {
    case PROMPTS.ONBOARD_APP:
      return (
        "Шаг 1/3 — приложение.\n\n" +
        "Опиши продукт одним сообщением: название, ссылки (сайт, App Store, Google Play при наличии), чем полезен.\n\n" +
        "Потом настроим тон ответов и поисковые запросы."
      );
    case PROMPTS.ONBOARD_WRITING:
      return (
        "Шаг 2/3 — как писать ответы.\n\n" +
        "Тон, нужно ли всегда упоминать продукт, на каких языках отвечать, чего избегать, длина абзацев — одним сообщением."
      );
    case PROMPTS.ONBOARD_SEARCHES:
      return (
        "Шаг 3/3 — поиск на Reddit.\n\n" +
        "Каждый запрос с новой строки (на английском обычно лучше)"
      );
    default:
      return "Продолжим настройку. Пришли текст в ответ на последний вопрос или нажми /start.";
  }
}

function editInstruction(field) {
  switch (field) {
    case PROMPTS.EDIT_APP:
      return (
        "Пришли новый текст одним сообщением — он полностью заменит сохранённое.\n" +
        "Можешь скопировать из сообщения выше, изменить и отправить сюда.\n" +
        "/cancel — отмена."
      );
    case PROMPTS.EDIT_WRITING:
      return (
        "Пришли новые инструкции одним сообщением — они полностью заменят сохранённые.\n" +
        "Можешь скопировать из сообщения выше, изменить и отправить сюда.\n" +
        "/cancel — отмена."
      );
    case PROMPTS.EDIT_SEARCHES:
      return (
        "Пришли новый список: каждый запрос с новой строки — он полностью заменит сохранённый.\n" +
        "Можешь скопировать из сообщения выше, изменить и отправить сюда.\n" +
        "/cancel — отмена."
      );
    default:
      return "Пришли текст одним сообщением или нажми /cancel.";
  }
}

const EDIT_SNAPSHOT_BODY_MAX = 3200;

/** Показать текущее значение перед редактированием (поле ввода в Telegram предзаполнить нельзя). */
function buildEditSnapshotMessage(field, row) {
  let heading;
  let body;
  switch (field) {
    case PROMPTS.EDIT_APP:
      heading = "🚀 Информация о продукте — сейчас сохранено:";
      body = String(row.app_context ?? "").trim() || "(пусто)";
      break;
    case PROMPTS.EDIT_WRITING:
      heading = "💬 Как писать ответы — сейчас сохранено:";
      body = String(row.writing_context ?? "").trim() || "(пусто)";
      break;
    case PROMPTS.EDIT_SEARCHES: {
      heading =
        "🔎 Критерии поиска вопросов — сейчас сохранено (одна строка = один запрос):";
      const q = Array.isArray(row.search_queries) ? row.search_queries : [];
      body = q.length
        ? q
            .map((s) => String(s).trim())
            .filter(Boolean)
            .join("\n")
        : "(пусто)";
      break;
    }
    default:
      return null;
  }
  let suffix = "";
  if (body.length > EDIT_SNAPSHOT_BODY_MAX) {
    body = body.slice(0, EDIT_SNAPSHOT_BODY_MAX);
    suffix =
      "\n\n… Показан только фрагмент — в новом сообщении пришли полный текст целиком.";
  }
  return `${heading}\n\n${body}${suffix}`;
}

async function sendMainMenu(chatId) {
  await sendTelegram(
    chatId,
    "Готово. Нажми кнопку, чтобы искать новые посты, или открой настройки.",
    { reply_markup: mainMenuMarkup() },
  );
}

async function sendOnboardingStep(chatId, step) {
  await sendTelegram(chatId, onboardingInstruction(step));
}

async function handleStart(chatId, userId) {
  let row = await db.getOrCreateBotUser(chatId, userId);
  if (!row.setup_complete) {
    if (!row.pending_prompt) {
      row = await db.updateBotUser(chatId, {
        pending_prompt: PROMPTS.ONBOARD_APP,
      });
    }
    await sendOnboardingStep(chatId, row.pending_prompt);
    return;
  }
  await sendMainMenu(chatId);
}

async function handleSettings(chatId) {
  const row = await db.getBotUser(chatId);
  if (!row) {
    await sendTelegram(chatId, "Сначала нажми /start и пройди настройку.");
    return;
  }
  if (!row.setup_complete) {
    await sendTelegram(chatId, "Сначала закончи первичную настройку: /start");
    return;
  }
  await sendTelegram(chatId, "Что изменить?", {
    reply_markup: settingsMarkup(),
  });
}

async function handleCancel(chatId) {
  const row = await db.getBotUser(chatId);
  if (!row) {
    await sendTelegram(chatId, "Нечего отменять. /start");
    return;
  }
  if (!row.pending_prompt) {
    await sendTelegram(chatId, "Нет активного ввода. /settings или /start");
    return;
  }
  await db.updateBotUser(chatId, { pending_prompt: null });
  if (row.setup_complete) {
    await sendTelegram(chatId, "Ок, отменено.", {
      reply_markup: mainMenuMarkup(),
    });
  } else {
    await sendTelegram(
      chatId,
      "Ввод отменён. Чтобы продолжить настройку — снова /start",
    );
  }
}

async function handlePlainText(chatId, text) {
  const row = await db.getBotUser(chatId);
  if (!row || !row.pending_prompt) {
    await sendTelegram(chatId, "Нажми /start или /settings.");
    return;
  }

  const p = row.pending_prompt;

  if (p === PROMPTS.ONBOARD_APP) {
    await db.updateBotUser(chatId, {
      app_context: text,
      pending_prompt: PROMPTS.ONBOARD_WRITING,
    });
    await sendOnboardingStep(chatId, PROMPTS.ONBOARD_WRITING);
    return;
  }

  if (p === PROMPTS.ONBOARD_WRITING) {
    await db.updateBotUser(chatId, {
      writing_context: text,
      pending_prompt: PROMPTS.ONBOARD_SEARCHES,
    });
    await sendOnboardingStep(chatId, PROMPTS.ONBOARD_SEARCHES);
    return;
  }

  if (p === PROMPTS.ONBOARD_SEARCHES) {
    const queries = normSearchQueriesFromText(text);
    if (queries.length === 0) {
      await sendTelegram(
        chatId,
        "Нужен хотя бы один непустой запрос (каждый с новой строки).",
      );
      return;
    }
    await db.updateBotUser(chatId, {
      search_queries: queries,
      pending_prompt: null,
      setup_complete: true,
    });
    await sendTelegram(
      chatId,
      "Настройка сохранена в Supabase. Можно менять данные в любой момент в ⚙️ Настройки.",
      { reply_markup: mainMenuMarkup() },
    );
    return;
  }

  if (p === PROMPTS.EDIT_APP) {
    await db.updateBotUser(chatId, {
      app_context: text,
      pending_prompt: null,
    });
    await sendTelegram(chatId, "Описание приложения обновлено.", {
      reply_markup: mainMenuMarkup(),
    });
    return;
  }

  if (p === PROMPTS.EDIT_WRITING) {
    await db.updateBotUser(chatId, {
      writing_context: text,
      pending_prompt: null,
    });
    await sendTelegram(chatId, "Инструкции по ответам обновлены.", {
      reply_markup: mainMenuMarkup(),
    });
    return;
  }

  if (p === PROMPTS.EDIT_SEARCHES) {
    const queries = normSearchQueriesFromText(text);
    if (queries.length === 0) {
      await sendTelegram(chatId, "Нужен хотя бы один запрос с новой строки.");
      return;
    }
    await db.updateBotUser(chatId, {
      search_queries: queries,
      pending_prompt: null,
    });
    await sendTelegram(chatId, "Поисковые запросы обновлены.", {
      reply_markup: mainMenuMarkup(),
    });
    return;
  }

  await sendTelegram(
    chatId,
    "Состояние настройки не распознано. Нажми /start.",
  );
}

async function handleCallbackQuery(q) {
  const chatId = q.message?.chat?.id;
  if (chatId == null) return;

  const data = q.data;
  await answerCallback(q.id);

  if (data === "scan") {
    await requestPaidScan(chatId);
    return;
  }

  if (data === "open_settings") {
    await handleSettings(chatId);
    return;
  }

  if (data === "back_menu") {
    const row = await db.getBotUser(chatId);
    if (row?.setup_complete) {
      await sendMainMenu(chatId);
    } else {
      await sendTelegram(chatId, "Сначала заверши настройку: /start");
    }
    return;
  }

  if (
    data === "edit_app" ||
    data === "edit_writing" ||
    data === "edit_searches"
  ) {
    const row = await db.getBotUser(chatId);
    if (!row?.setup_complete) {
      await sendTelegram(chatId, "Сначала /start и полная настройка.");
      return;
    }
    const map = {
      edit_app: PROMPTS.EDIT_APP,
      edit_writing: PROMPTS.EDIT_WRITING,
      edit_searches: PROMPTS.EDIT_SEARCHES,
    };
    const pending = map[data];
    await db.updateBotUser(chatId, { pending_prompt: pending });
    const snapshot = buildEditSnapshotMessage(pending, row);
    if (snapshot) {
      await sendTelegram(chatId, snapshot);
    }
    await sendTelegram(chatId, editInstruction(pending));
  }
}

// --- Scan ---

function formatPostedAgoRu(postedDate) {
  return dayjs(postedDate).fromNow();
}

/** «1 комментарий», «2 комментария», «5 комментариев», «11 комментариев», «21 комментарий» … */
function ruCommentsPhrase(count) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  const n10 = n % 10;
  const n100 = n % 100;
  let word;
  if (n100 >= 11 && n100 <= 14) word = "комментариев";
  else if (n10 === 1) word = "комментарий";
  else if (n10 >= 2 && n10 <= 4) word = "комментария";
  else word = "комментариев";
  return `${n} ${word}`;
}

function isRelevantPost(post) {
  if (!post.postedDate) return false;
  const ageHours = (Date.now() - post.postedDate.getTime()) / (1000 * 3600);
  if (ageHours > 24) return false;
  if (post.text === "[deleted]" || post.text === "[removed]") return false;
  return true;
}

const scanningByChat = new Map();

function weekAgoIso() {
  return new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
}

async function runScan(chatId) {
  if (scanningByChat.get(chatId)) {
    await sendTelegram(chatId, "⏳ Поиск уже идёт, подожди...");
    return;
  }

  let profile;
  try {
    profile = await db.getBotUser(chatId);
  } catch (e) {
    console.error(e);
    await sendTelegram(
      chatId,
      "❌ Не удалось прочитать профиль из Supabase. Проверь SUPABASE_URL и ключ в переменных окружения хоста.",
    );
    return;
  }

  if (!profile?.setup_complete) {
    await sendTelegram(chatId, "Сначала закончи настройку: /start");
    return;
  }

  const queries = Array.isArray(profile.search_queries)
    ? profile.search_queries
    : [];
  if (queries.length === 0) {
    await sendTelegram(
      chatId,
      "Нет поисковых запросов. Открой ⚙️ Настройки → Поиски Reddit.",
    );
    return;
  }

  scanningByChat.set(chatId, true);
  console.log(
    `[${new Date().toISOString()}] Starting scan for chat ${chatId}...`,
  );

  let typingInterval;
  try {
    await sendTelegramChatAction(chatId, "typing");
    typingInterval = setInterval(() => {
      void sendTelegramChatAction(chatId, "typing");
    }, 4500);

    const sinceIso = weekAgoIso();
    const seen = await db.loadSeenMap(chatId, sinceIso);
    let newPostsCount = 0;

    const posts = await fetchPostsViaApify(queries);

    for (const post of posts) {
      if (seen[post.id]) continue;
      if (!isRelevantPost(post)) {
        await db.saveSeenPost(chatId, post.id, {
          skipped: true,
          ts: Date.now(),
        });
        seen[post.id] = { skipped: true };
        continue;
      }

      console.log(`  New post: "${post.title}" in r/${post.subreddit}`);

      const relevant = await checkRelevance(post, profile);
      if (!relevant) {
        console.log(`    Skipped (not relevant)`);
        await db.saveSeenPost(chatId, post.id, {
          skipped: true,
          ts: Date.now(),
        });
        seen[post.id] = { skipped: true };
        continue;
      }

      const reply = await generateReply(post, profile);
      if (!reply || !String(reply).trim()) {
        console.error(`  Empty or missing reply from model, skipping`);
        continue;
      }

      const postedAgo = formatPostedAgoRu(post.postedDate);
      const commentsRu = ruCommentsPhrase(post.numComments);

      const info = [
        `r/${escapeHtml(post.subreddit)}`,
        `<b>${escapeHtml(post.title)}</b>`,
        `${escapeHtml(postedAgo)} · ${escapeHtml(commentsRu)} · ↑${post.votes}`,
        escapeHtml(post.url),
      ].join("\n");

      await sendTelegram(chatId, info, { parse_mode: "HTML" });
      await sendTelegram(chatId, reply);
      newPostsCount++;

      await db.saveSeenPost(chatId, post.id, {
        title: post.title,
        ts: Date.now(),
      });
      seen[post.id] = {};
      await new Promise((r) => setTimeout(r, 2000));
    }

    await db.pruneSeenBefore(chatId, sinceIso);

    await db.incrementCompletedScanCount(chatId);
    const afterRow = await db.getBotUser(chatId);
    const totalScans = Math.max(
      0,
      Math.floor(Number(afterRow?.completed_scan_count) || 0),
    );
    const freeLeft = Math.max(0, FREE_SCANS - totalScans);
    let scanQuotaHint = "";
    if (FREE_SCANS > 0 && freeLeft > 0) {
      scanQuotaHint = `\n\n🎁 Бесплатных поисков осталось: ${freeLeft}.`;
    } else if (FREE_SCANS > 0 && totalScans === FREE_SCANS) {
      scanQuotaHint = `\n\nДальше каждый поиск — ${SCAN_PRICE_STARS} ⭐.`;
    }

    await sendTelegram(
      chatId,
      (newPostsCount > 0
        ? `✅ Готово! Найдено новых постов: ${newPostsCount}`
        : `😴 Новых подходящих постов не найдено`) + scanQuotaHint,
      { reply_markup: mainMenuMarkup() },
    );

    console.log(`Done. New posts for ${chatId}: ${newPostsCount}`);
  } catch (err) {
    console.error("Scan error:", err);
    await sendTelegram(chatId, `❌ Ошибка: ${err.message}`, {
      reply_markup: mainMenuMarkup(),
    });
  } finally {
    if (typingInterval) clearInterval(typingInterval);
    scanningByChat.delete(chatId);
  }
}

// --- Polling ---

function normalizeCommand(text) {
  const first = text.trim().split(/\s+/)[0] || "";
  return first.split("@")[0].toLowerCase();
}

async function pollUpdates() {
  let offset = 0;

  try {
    db.getSupabase();
  } catch (e) {
    console.error(e.message);
    console.error(
      "На хостинге (Railway, Render, Fly и т.д.) добавь переменные SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY в панели Environment — локальный .env на сервер не подхватывается.",
    );
    process.exit(1);
  }

  console.log("Bot is running. Send /start in Telegram.");

  while (true) {
    try {
      const res = await fetch(
        `${TG_BASE()}/getUpdates?offset=${offset}&timeout=30`,
      );
      const data = await res.json();

      if (!data.ok) {
        if (data.error_code === 409) {
          console.error(
            "Telegram 409: с этим токеном уже опрашивается getUpdates (второй инстанс бота, локальный запуск или второй деплой). Оставь один процесс, replicas = 1.",
          );
        } else {
          console.error("Polling error:", data);
        }
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }

      for (const update of data.result) {
        offset = update.update_id + 1;

        if (update.pre_checkout_query) {
          await handlePreCheckoutQuery(update.pre_checkout_query);
          continue;
        }

        if (update.callback_query) {
          await handleCallbackQuery(update.callback_query);
          continue;
        }

        const msg = update.message;
        if (msg?.chat?.id != null && msg.successful_payment) {
          await handleSuccessfulScanPayment(msg);
          continue;
        }

        const text = msg?.text?.trim();
        if (!text || msg?.chat?.id == null) continue;

        const chatId = msg.chat.id;
        const userId = msg.from?.id ?? chatId;
        const cmd = normalizeCommand(text);

        if (cmd === "/start") {
          await handleStart(chatId, userId);
          continue;
        }
        if (cmd === "/settings") {
          await handleSettings(chatId);
          continue;
        }
        if (cmd === "/cancel") {
          await handleCancel(chatId);
          continue;
        }
        if (text.startsWith("/")) {
          await sendTelegram(
            chatId,
            "Неизвестная команда. Доступны: /start /settings /cancel",
          );
          continue;
        }

        await handlePlainText(chatId, text);
      }
    } catch (err) {
      console.error("Polling error:", err.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

pollUpdates();
