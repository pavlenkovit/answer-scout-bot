-- Run this in Supabase: SQL Editor → New query → paste → Run.
-- Then copy Project URL and API key into .env (see .env.example).

create table if not exists public.bot_users (
  telegram_chat_id bigint primary key,
  telegram_user_id bigint,
  app_context text not null default '',
  writing_context text not null default '',
  search_queries jsonb not null default '[]'::jsonb,
  setup_complete boolean not null default false,
  pending_prompt text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists bot_users_setup_idx on public.bot_users (setup_complete);

create table if not exists public.seen_reddit_posts (
  telegram_chat_id bigint not null,
  reddit_post_id text not null,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (telegram_chat_id, reddit_post_id)
);

create index if not exists seen_reddit_posts_chat_created_idx
  on public.seen_reddit_posts (telegram_chat_id, created_at);

-- This bot runs on a trusted server. Prefer SUPABASE_SERVICE_ROLE_KEY in .env
-- (Dashboard → Project Settings → API → service_role). Never expose that key
-- in a browser or mobile app.
-- If you only use SUPABASE_ANON_KEY, add RLS policies so each row is scoped
-- to the bot backend (typical serverless pattern), or the anon key will be blocked.
