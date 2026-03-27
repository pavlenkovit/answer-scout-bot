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

  // Deduplicate by id
  const unique = new Map();
  for (const item of allPosts) {
    if (item.id && !unique.has(item.id)) {
      unique.set(item.id, item);
    }
  }

  const result = [...unique.values()].map((item) => ({
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

  console.log(`Total unique posts: ${result.length}`);
  if (result.length > 0) {
    const sample = result[0];
    console.log(`  Sample normalized: date=${sample.postedDate}, title="${sample.title}", subreddit=${sample.subreddit}`);
  }
  return result;
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

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    }),
  });

  const data = await res.json();
  if (!data.ok) {
    console.error('Telegram error:', data);
  }
  return data;
}

function isRelevantPost(post) {
  // Skip posts without a date
  if (!post.postedDate) return false;

  // Skip posts older than 24h
  const ageHours = (Date.now() - post.postedDate.getTime()) / (1000 * 3600);
  if (ageHours > 24) return false;

  // Skip deleted posts
  if (post.text === '[deleted]' || post.text === '[removed]') return false;

  return true;
}

// --- Main ---

async function main() {
  console.log(`[${new Date().toISOString()}] Starting Reddit scout...`);

  const seen = loadSeen();
  let newPostsCount = 0;

  // Fetch all posts in one Apify call
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

    // Small delay between OpenRouter/Telegram calls
    await new Promise((r) => setTimeout(r, 2000));
  }

  // Clean up old entries (older than 7 days)
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const [id, entry] of Object.entries(seen)) {
    if (entry.ts < weekAgo) delete seen[id];
  }

  saveSeen(seen);
  console.log(`Done. New posts found: ${newPostsCount}`);
}

main().catch(console.error);
