-- MirrorEdu database schema
-- Run this once in the Supabase SQL Editor (Project -> SQL Editor -> New query).

create extension if not exists "pgcrypto";

-- One row per chat thread.
create table if not exists conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default 'New chat',
  -- 'chat' = a real conversation, shown in the sidebar.
  -- 'import' = brought in from a claude.ai export; kept in the database and
  -- folded into user_memory (see below), but not shown as a browsable thread.
  source text not null default 'chat',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- A single, evolving block of background context per user, distilled from
-- their imported history (and anything else worth remembering). Prepended
-- to the system prompt on every /api/chat request instead of replaying raw
-- transcripts.
create table if not exists user_memory (
  user_id uuid primary key references auth.users(id) on delete cascade,
  content text not null default '',
  updated_at timestamptz not null default now()
);

alter table user_memory enable row level security;

create policy "select own memory" on user_memory
  for select using (auth.uid() = user_id);

-- One row per chat message (both user and assistant turns).
create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  created_at timestamptz not null default now()
);

-- Per-user, per-day message counter used to enforce the daily cap.
-- Only ever written by the server (service role), never by the client,
-- so a signed-in user cannot reset or fake their own usage.
create table if not exists usage_daily (
  user_id uuid not null references auth.users(id) on delete cascade,
  usage_date date not null default current_date,
  message_count integer not null default 0,
  primary key (user_id, usage_date)
);

create index if not exists idx_conversations_user on conversations(user_id, updated_at desc);
create index if not exists idx_messages_conversation on messages(conversation_id, created_at asc);

-- Row Level Security: every table is scoped to auth.uid().
alter table conversations enable row level security;
alter table messages enable row level security;
alter table usage_daily enable row level security;

-- Conversations and messages are written by the server via the service role
-- key (which bypasses RLS entirely), but the browser reads them directly
-- with the user's own session so the chat page can load history without an
-- extra API round trip.
create policy "select own conversations" on conversations
  for select using (auth.uid() = user_id);

create policy "select own messages" on messages
  for select using (auth.uid() = user_id);

-- Users can read their own usage row (handy for showing "X/50 messages
-- today" in the UI later) but cannot write it themselves.
create policy "select own usage" on usage_daily
  for select using (auth.uid() = user_id);

-- Atomically increments today's message count for a user, but refuses to
-- go past p_limit. Returns true if the message is allowed, false if the
-- daily cap has been reached. Using a single upsert avoids a
-- check-then-increment race between concurrent requests.
create or replace function increment_usage(p_user_id uuid, p_limit integer)
returns boolean
language plpgsql
as $$
declare
  new_count integer;
begin
  insert into usage_daily (user_id, usage_date, message_count)
  values (p_user_id, current_date, 1)
  on conflict (user_id, usage_date)
  do update set message_count = usage_daily.message_count + 1
    where usage_daily.message_count < p_limit
  returning message_count into new_count;

  return new_count is not null;
end;
$$;
