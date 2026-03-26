require('dotenv').config();
const fs = require('fs');
const path = require('path');

// --- Config ---
const SEARCH_QUERIES = [
  // Direct app recommendations
  'best app learn vocabulary',
  'app to learn new words',
  'vocabulary app recommendation',
  'flashcard app language',
  'anki alternative language',
  'best app memorize words',
  // Language learning general
  'how do you learn vocabulary',
  'how to memorize vocabulary',
  'struggling to learn vocabulary',
  'best way to learn words language',
  'spaced repetition language learning',
  // Specific subreddit-focused
  'subreddit:languagelearning vocabulary app',
  'subreddit:languagelearning best app',
  'subreddit:LearnJapanese vocabulary app',
  'subreddit:LearnJapanese anki alternative',
  'subreddit:Spanish vocabulary',
  'subreddit:French vocabulary app',
  'subreddit:German vocabulary app',
];

const SEEN_FILE = path.join(__dirname, 'seen_posts.json');
const REDDIT_USER_AGENT = 'reddit-scout-bot/1.0';

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
3. Only mention VibeLing if it's truly relevant to what they're asking about. If the post is about grammar, pronunciation, or something unrelated to vocabulary — do NOT mention VibeLing at all.
4. When you do mention VibeLing, do it naturally and briefly — like a casual recommendation, not an ad. For example: "I've been using VibeLing for this and it worked well for me" or "You might also check out VibeLing".
5. Never be pushy or salesy. The goal is to be a valued community member first.
6. Keep the response concise — 3-6 sentences max. Reddit users don't read walls of text.
7. Write in the same language as the original post (usually English).
8. Sound like a real person, not a bot. Be warm but not over-the-top.`;

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

async function fetchRedditSearch(query) {
  const url = `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=new&t=day&limit=10`;
  const res = await fetch(url, {
    headers: { 'User-Agent': REDDIT_USER_AGENT },
  });

  if (!res.ok) {
    console.error(`Reddit API error for "${query}": ${res.status}`);
    return [];
  }

  const data = await res.json();
  return (data?.data?.children || []).map((c) => c.data);
}

async function checkRelevance(post) {
  const prompt = `Is this Reddit post relevant for someone who could recommend a language/vocabulary learning app?

Title: ${post.title}
Subreddit: r/${post.subreddit}
Body: ${(post.selftext || '').slice(0, 500)}

Reply with ONLY "yes" or "no" and a short reason (one sentence).
"yes" = the post is related to language learning in ANY way: vocabulary, flashcards, spaced repetition, apps, methods, tips, struggles, motivation, resources, or even general questions about learning a new language. Be generous — if there's any angle where a language learner could chime in helpfully, say yes.
"no" = the post has absolutely nothing to do with language learning (coupons, resumes, gaming, coding, finance, etc.)`;

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
Body: ${post.selftext || '(no body)'}
URL: https://reddit.com${post.permalink}

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
  // Skip posts older than 24h
  const ageHours = (Date.now() / 1000 - post.created_utc) / 3600;
  if (ageHours > 24) return false;

  // Skip removed/deleted
  if (post.removed_by_category || post.selftext === '[deleted]') return false;

  // Skip posts with too many comments (already crowded)
  if (post.num_comments > 50) return false;

  return true;
}

// --- Main ---

async function main() {
  console.log(`[${new Date().toISOString()}] Starting Reddit scout...`);

  const seen = loadSeen();
  let newPostsCount = 0;

  for (const query of SEARCH_QUERIES) {
    console.log(`Searching: "${query}"`);

    const posts = await fetchRedditSearch(query);
    console.log(`  Found ${posts.length} posts`);

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

      const ageHours = ((Date.now() / 1000 - post.created_utc) / 3600).toFixed(1);

      const message = [
        `🔍 Новый пост для ответа`,
        ``,
        `📌 r/${post.subreddit}`,
        `📝 ${post.title}`,
        `⏰ ${ageHours}h ago | 💬 ${post.num_comments} comments | ⬆️ ${post.score}`,
        `🔗 https://reddit.com${post.permalink}`,
        ``,
        `--- Черновик ответа ---`,
        ``,
        reply,
      ].join('\n');

      await sendTelegram(message);
      newPostsCount++;

      seen[post.id] = { title: post.title, ts: Date.now() };

      // Small delay between posts to avoid rate limits
      await new Promise((r) => setTimeout(r, 3000));
    }

    // Delay between queries to avoid Reddit rate limit
    await new Promise((r) => setTimeout(r, 5000));
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
