require('dotenv').config();
const fs = require('fs');
const path = require('path');

const SEARCH_QUERIES = [
  'words learning app',
  'learn language app',
];

const SEEN_FILE = path.join(__dirname, 'seen_posts.json');

const SYSTEM_PROMPT = `You are a helpful member of the Reddit community who genuinely loves helping people learn languages. You also happen to be the creator of VibeLing — a vocabulary builder app.

About VibeLing:
- Website: https://vibeling.app/
- iOS: https://apps.apple.com/us/app/vibeling-vocabulary-builder/id6753818507
- Android: https://play.google.com/store/apps/details?id=com.vitalypavlenko.vibeling
- Background story (in Russian): https://habr.com/ru/articles/1012012/
- VibeLing helps learn vocabulary through contextual examples, spaced repetition, and a clean minimal UI
- It supports multiple languages and focuses on learning words in natural context rather than isolated flashcards

YOUR RULES:
1. FIRST AND FOREMOST — be genuinely helpful. Answer the person's question fully and thoughtfully.
2. Share practical advice, personal experience, and useful tips that actually help.
3. ALWAYS mention VibeLing in your reply — but do it naturally and briefly, like a casual recommendation. For example: "I've been using VibeLing for this and it worked well for me" or "You might also check out VibeLing".
4. Never be pushy or salesy. The goal is to be a valued community member first, but always find a way to naturally weave in VibeLing.
5. Keep the response concise — 3-6 sentences max. Reddit users don't read walls of text.
6. Write in the same language as the original post (usually English).
7. Sound like a real person, not a bot. Be warm but not over-the-top.`;

// --- Helpers ---

function loadSeen() {
  try {
    return JSON.parse(fs.readFileSync(SEEN_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function saveSeen(seen) {
  fs.writeFileSync(SEEN_FILE, JSON.stringify(seen, null, 2));
}

async function fetchPostsViaApify() {
  const token = process.env.APIFY_API_TOKEN;
  let allPosts = [];

  for (const query of SEARCH_QUERIES) {
    console.log(`Apify search: "${query}"`);

    const res = await fetch(
      `https://api.apify.com/v2/acts/automation-lab~reddit-scraper/run-sync-get-dataset-items?token=${token}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          searchQuery: query,
          sort: 'relevance',
          timeFilter: 'day',
          maxPostsPerSource: 20,
          includeComments: false,
          deduplicatePosts: true,
        }),
        signal: AbortSignal.timeout(290000),
      }
    );

    if (!res.ok) {
      const text = await res.text();
      console.error(`  Apify error for "${query}": ${res.status} ${text}`);
      continue;
    }

    const items = await res.json();
    const posts = items.filter((item) => item.type === 'post');
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
    title: item.title || '',
    text: item.selfText || '',
    subreddit: item.subreddit || '',
    url: item.url || '',
    permalink: item.permalink || '',
    postedDate: item.createdAt ? new Date(item.createdAt) : null,
    votes: item.score || 0,
    numComments: item.numComments || 0,
    author: item.author || '',
  }));
}

async function checkRelevance(post) {
  const prompt = `Is this Reddit post relevant for someone who could recommend a language/vocabulary learning app?

Title: ${post.title}
Subreddit: r/${post.subreddit}
Body: ${(post.text || '').slice(0, 500)}

Reply with ONLY "yes" or "no" and a short reason (one sentence).
"yes" = the post is related to language learning AND either:
  - mentions one of these languages: English, Spanish, German, French, Romanian, Serbian, Russian
  - OR does not mention any specific language at all (general language learning discussion)
"no" = ONLY if the post explicitly focuses on a language NOT in the list (Chinese, Japanese, Korean, Latin, Arabic, Hindi, etc.), OR has nothing to do with language learning at all.
When in doubt, say yes.`;

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'google/gemini-2.5-flash',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 100,
      temperature: 0,
    }),
  });

  if (!res.ok) {
    console.error(`    Relevance check error: ${res.status}`);
    return false;
  }

  const data = await res.json();
  const answer = (data?.choices?.[0]?.message?.content || '').toLowerCase();
  console.log(`    Relevance: ${answer.trim()}`);
  return answer.startsWith('yes');
}

async function generateReply(post) {
  const prompt = `Here is a Reddit post I want you to reply to:

Subreddit: r/${post.subreddit}
Title: ${post.title}
Body: ${post.text || '(no body)'}
URL: ${post.url}

Write a helpful Reddit comment reply. Follow your rules strictly.`;

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'google/gemini-2.5-flash',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt },
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

const TG_BASE = () => `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;
const CHAT_ID = () => process.env.TELEGRAM_CHAT_ID;

async function sendTelegram(text, opts = {}) {
  const res = await fetch(`${TG_BASE()}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHAT_ID(),
      text,
      disable_web_page_preview: true,
      ...opts,
    }),
  });

  const data = await res.json();
  if (!data.ok) {
    console.error('Telegram error:', data);
  }
  return data;
}

async function sendMenuButton() {
  await sendTelegram('👋 Бот запущен! Нажми кнопку чтобы найти новые вопросы.', {
    reply_markup: JSON.stringify({
      inline_keyboard: [[
        { text: '🔍 Найти новые вопросы', callback_data: 'scan' },
      ]],
    }),
  });
}

async function answerCallback(callbackQueryId) {
  await fetch(`${TG_BASE()}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId }),
  });
}

// --- Scan logic ---

function isRelevantPost(post) {
  if (!post.postedDate) return false;
  const ageHours = (Date.now() - post.postedDate.getTime()) / (1000 * 3600);
  if (ageHours > 24) return false;
  if (post.text === '[deleted]' || post.text === '[removed]') return false;
  return true;
}

let isScanning = false;

async function runScan() {
  if (isScanning) {
    await sendTelegram('⏳ Поиск уже идёт, подожди...');
    return;
  }

  isScanning = true;
  console.log(`[${new Date().toISOString()}] Starting scan...`);
  await sendTelegram('🔄 Ищу новые вопросы...');

  try {
    const seen = loadSeen();
    let newPostsCount = 0;

    const posts = await fetchPostsViaApify();

    for (const post of posts) {
      if (seen[post.id]) continue;
      if (!isRelevantPost(post)) {
        seen[post.id] = { skipped: true, ts: Date.now() };
        continue;
      }

      console.log(`  New post: "${post.title}" in r/${post.subreddit}`);

      const relevant = await checkRelevance(post);
      if (!relevant) {
        console.log(`    Skipped (not relevant)`);
        seen[post.id] = { skipped: true, ts: Date.now() };
        continue;
      }

      const reply = await generateReply(post);
      if (!reply) {
        console.error(`  Failed to generate reply, skipping`);
        continue;
      }

      const ageHours = ((Date.now() - post.postedDate.getTime()) / (1000 * 3600)).toFixed(1);

      const info = [
        `🔍 Новый пост для ответа`,
        ``,
        `📌 r/${post.subreddit}`,
        `📝 ${post.title}`,
        `⏰ ${ageHours}h ago | 💬 ${post.numComments} comments | ⬆️ ${post.votes}`,
        `🔗 ${post.url}`,
      ].join('\n');

      await sendTelegram(info);
      await sendTelegram(reply);
      newPostsCount++;

      seen[post.id] = { title: post.title, ts: Date.now() };
      await new Promise((r) => setTimeout(r, 2000));
    }

    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    for (const [id, entry] of Object.entries(seen)) {
      if (entry.ts < weekAgo) delete seen[id];
    }

    saveSeen(seen);

    await sendTelegram(
      newPostsCount > 0
        ? `✅ Готово! Найдено новых постов: ${newPostsCount}`
        : `😴 Новых подходящих постов не найдено`,
      {
        reply_markup: JSON.stringify({
          inline_keyboard: [[
            { text: '🔍 Найти новые вопросы', callback_data: 'scan' },
          ]],
        }),
      }
    );

    console.log(`Done. New posts found: ${newPostsCount}`);
  } catch (err) {
    console.error('Scan error:', err);
    await sendTelegram(`❌ Ошибка: ${err.message}`, {
      reply_markup: JSON.stringify({
        inline_keyboard: [[
          { text: '🔍 Попробовать снова', callback_data: 'scan' },
        ]],
      }),
    });
  } finally {
    isScanning = false;
  }
}

// --- Polling ---

async function pollUpdates() {
  let offset = 0;

  console.log('Bot is running. Send /start in Telegram to see the button.');

  while (true) {
    try {
      const res = await fetch(`${TG_BASE()}/getUpdates?offset=${offset}&timeout=30`);
      const data = await res.json();

      if (!data.ok) {
        console.error('Polling error:', data);
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }

      for (const update of data.result) {
        offset = update.update_id + 1;

        // Handle button click
        if (update.callback_query?.data === 'scan') {
          await answerCallback(update.callback_query.id);
          runScan(); // don't await — run in background
        }

        // Handle /start command
        if (update.message?.text === '/start') {
          await sendMenuButton();
        }
      }
    } catch (err) {
      console.error('Polling error:', err.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

pollUpdates();
