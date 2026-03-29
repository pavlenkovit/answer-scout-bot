const { createClient } = require("@supabase/supabase-js");

let _client;

function getSupabase() {
  if (_client) return _client;
  const url = process.env.SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error(
      "Missing Supabase env: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (recommended) or SUPABASE_ANON_KEY. See .env.example and supabase/schema.sql.",
    );
  }
  _client = createClient(url, key);
  return _client;
}

async function getBotUser(chatId) {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("bot_users")
    .select("*")
    .eq("telegram_chat_id", chatId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function getOrCreateBotUser(chatId, userId) {
  const existing = await getBotUser(chatId);
  if (existing) return existing;

  const sb = getSupabase();
  const { data, error } = await sb
    .from("bot_users")
    .insert({
      telegram_chat_id: chatId,
      telegram_user_id: userId,
      app_context: "",
      writing_context: "",
      search_queries: [],
      setup_complete: false,
      pending_prompt: "onboard_app",
    })
    .select()
    .single();

  if (!error) return data;
  if (error.code === "23505") {
    const again = await getBotUser(chatId);
    if (again) return again;
  }
  throw error;
}

async function updateBotUser(chatId, patch) {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("bot_users")
    .update({
      ...patch,
      updated_at: new Date().toISOString(),
    })
    .eq("telegram_chat_id", chatId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function loadSeenMap(chatId, sinceIso) {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("seen_reddit_posts")
    .select("reddit_post_id, meta")
    .eq("telegram_chat_id", chatId)
    .gte("created_at", sinceIso);
  if (error) throw error;
  const map = Object.create(null);
  for (const row of data || []) {
    map[row.reddit_post_id] = row.meta || {};
  }
  return map;
}

async function saveSeenPost(chatId, postId, meta) {
  const sb = getSupabase();
  const { error } = await sb.from("seen_reddit_posts").upsert(
    {
      telegram_chat_id: chatId,
      reddit_post_id: postId,
      meta,
      created_at: new Date().toISOString(),
    },
    { onConflict: "telegram_chat_id,reddit_post_id" },
  );
  if (error) throw error;
}

async function pruneSeenBefore(chatId, beforeIso) {
  const sb = getSupabase();
  const { error } = await sb
    .from("seen_reddit_posts")
    .delete()
    .eq("telegram_chat_id", chatId)
    .lt("created_at", beforeIso);
  if (error) throw error;
}

module.exports = {
  getSupabase,
  getBotUser,
  getOrCreateBotUser,
  updateBotUser,
  loadSeenMap,
  saveSeenPost,
  pruneSeenBefore,
};
