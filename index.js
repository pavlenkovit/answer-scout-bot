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
  EDIT_APP: "edit_app",
};

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// --- Prompt builders ---

const {
  buildSystemPrompt,
  buildRelevancePrompt,
  buildSearchQuerySetsPrompt,
} = require("./prompts");

function extractFirstJsonObject(text) {
  const s = String(text || "").trim();
  const firstBrace = s.indexOf("{");
  const lastBrace = s.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace)
    return null;
  const candidate = s.slice(firstBrace, lastBrace + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

function flattenAndDedupeQueries(querySets) {
  const flat = [];
  for (const set of Array.isArray(querySets) ? querySets : []) {
    for (const q of Array.isArray(set) ? set : []) {
      const qq = String(q || "").trim();
      if (!qq) continue;
      if (qq.length > 200) continue;
      flat.push(qq);
    }
  }
  // Deduplicate case-insensitively, keep first.
  const seen = new Set();
  const out = [];
  for (const q of flat) {
    const key = q.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(q);
  }
  // Apify loops queries and can be slow; keep it bounded.
  return out.slice(0, 12);
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

async function generateSearchQuerySets(appContext) {
  const prompt = buildSearchQuerySetsPrompt(appContext);

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
    },
    body: JSON.stringify({
      model: "google/gemini-2.5-flash",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 500,
      temperature: 0.2,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(
      `OpenRouter search query generation error: ${res.status} ${text}`,
    );
    return { sets: [] };
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content || "";
  const json = extractFirstJsonObject(content);

  const sets = json?.sets;
  if (!Array.isArray(sets)) {
    console.error("OpenRouter search query generation: invalid JSON", {
      content,
    });
    return { sets: [] };
  }

  const normalizedSets = sets
    .slice(0, 2)
    .map((set) => (Array.isArray(set) ? set : []))
    .map((set) =>
      set
        .map((q) => String(q || "").trim())
        .filter(Boolean)
        .map((q) => (q.length > 120 ? q.slice(0, 120) : q)),
    );

  while (normalizedSets.length < 2) normalizedSets.push([]);

  return { sets: normalizedSets.slice(0, 2) };
}

// --- Telegram ---

const TG_BASE = () =>
  `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

function mainMenuMarkup() {
  return JSON.stringify({
    inline_keyboard: [
      [{ text: "🔍 Найти новые вопросы", callback_data: "scan" }],
      [{ text: "🚀 Информация о продукте", callback_data: "edit_app" }],
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
    if (now - v.at > PENDING_INVOICE_TTL_MS)
      pendingScanInvoices.delete(payload);
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
      title: "Поиск и генерация ответов для Reddit",
      description: `Один запуск поиска и генерации ответов — ${SCAN_PRICE_STARS} ⭐`,
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

  const used = Math.max(
    0,
    Math.floor(Number(profile.completed_scan_count) || 0),
  );
  if (FREE_SCANS > 0 && used < FREE_SCANS) {
    void runScan(chatId);
    return;
  }

  await sendScanStarsInvoice(chatId);
}

function onboardingInstruction(step) {
  switch (step) {
    case PROMPTS.ONBOARD_APP:
      return (
        "Опиши свой продукт одним сообщением: название, ссылки (сайт, App Store, Google Play при наличии), чем полезен, какая проблема решалась и как создавался продукт. Чем больше информацции, тем релевантнее будут найденные посты и тем лучше будут ответы на них.\n\n" +
        "Поисковые запросы и стиль ответов подберутся автоматически."
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

async function handleCancel(chatId) {
  const row = await db.getBotUser(chatId);
  if (!row) {
    await sendTelegram(chatId, "Нечего отменять. /start");
    return;
  }
  if (!row.pending_prompt) {
    await sendTelegram(chatId, "Нет активного ввода. /start");
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
    await sendTelegram(chatId, "Нажми /start.");
    return;
  }

  const p = row.pending_prompt;

  if (p === PROMPTS.ONBOARD_APP) {
    await db.updateBotUser(chatId, {
      app_context: text,
      pending_prompt: null,
      setup_complete: true,
    });
    await sendTelegram(
      chatId,
      "Готово! Поисковые запросы подберутся автоматически при первом поиске.",
      { reply_markup: mainMenuMarkup() },
    );
    return;
  }

  if (p === PROMPTS.EDIT_APP) {
    await db.updateBotUser(chatId, {
      app_context: text,
      search_queries: [],
      search_queries_app_hash: null,
      pending_prompt: null,
    });
    await sendTelegram(chatId, "Описание приложения обновлено.", {
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

  if (data === "edit_app") {
    const row = await db.getBotUser(chatId);
    if (!row?.setup_complete) {
      await sendTelegram(chatId, "Сначала /start и полная настройка.");
      return;
    }
    const pending = PROMPTS.EDIT_APP;
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

  const appContext = String(profile.app_context || "").trim();
  if (!appContext) {
    await sendTelegram(chatId, "Нет описания продукта — пройди /start снова.");
    return;
  }

  const appHash = crypto.createHash("sha256").update(appContext).digest("hex");
  const hasExistingQueries =
    Array.isArray(profile.search_queries) && profile.search_queries.length > 0;
  const storedHash = profile.search_queries_app_hash || null;
  const shouldGenerate =
    !hasExistingQueries || (storedHash && storedHash !== appHash);

  let queries;
  if (shouldGenerate) {
    await sendTelegram(
      chatId,
      "Подбираю поисковые запросы по описанию продукта...",
    );
    const generated = await generateSearchQuerySets(appContext);
    queries = flattenAndDedupeQueries(generated.sets);
    if (queries.length === 0) {
      await sendTelegram(
        chatId,
        "Не удалось сгенерировать поисковые запросы. Попробуй позже.",
      );
      return;
    }
    await db.updateBotUser(chatId, {
      search_queries: queries,
      search_queries_app_hash: appHash,
    });
  } else {
    queries = Array.isArray(profile.search_queries)
      ? profile.search_queries
      : [];
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
    const MAX_POSTS_PER_SCAN = 10;
    let sentCount = 0;
    let relevantCount = 0;
    let alreadySeenCount = 0;

    const posts = await fetchPostsViaApify(queries);

    for (const post of posts) {
      if (sentCount >= MAX_POSTS_PER_SCAN) break;
      if (seen[post.id]) {
        alreadySeenCount++;
        continue;
      }
      if (!isRelevantPost(post)) continue;

      console.log(`  New post: "${post.title}" in r/${post.subreddit}`);

      const relevant = await checkRelevance(post, profile);
      if (!relevant) {
        console.log(`    Skipped (not relevant)`);
        continue;
      }

      relevantCount++;

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
        `Ниже ответ на пост:`,
      ].join("\n");

      await sendTelegram(chatId, info, { parse_mode: "HTML" });
      await sendTelegram(chatId, reply);
      sentCount++;

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
      (sentCount > 0
        ? `✅ Готово! Отправлено постов: ${sentCount}`
        : `😴 Новых подходящих постов не найдено. Возможно, вы недавно уже искали — повторите позже, когда появятся новые посты.`) +
        scanQuotaHint,
      { reply_markup: mainMenuMarkup() },
    );

    console.log(
      `Done. sent=${sentCount} relevant=${relevantCount} alreadySeen=${alreadySeenCount} chat=${chatId}`,
    );
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
        if (cmd === "/cancel") {
          await handleCancel(chatId);
          continue;
        }
        if (text.startsWith("/")) {
          await sendTelegram(
            chatId,
            "Неизвестная команда. Доступны: /start /cancel",
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
