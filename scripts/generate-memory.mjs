#!/usr/bin/env node
// One-time (or re-runnable) script: reads a claude.ai conversations.json
// export, asks Claude to distill it into a compact, durable "memory"
// document, and stores that in the user_memory table. api/chat.js prepends
// this to the system prompt on every request, so MirrorEdu's assistant has
// background context on the user without replaying raw transcripts or
// showing them as browsable threads.
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... ANTHROPIC_API_KEY=... ANTHROPIC_MODEL=claude-sonnet-5 \
//     node scripts/generate-memory.mjs --file ./conversations.json --user-id <uuid>

import fs from 'fs';
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--file') args.file = argv[++i];
    else if (argv[i] === '--user-id') args.userId = argv[++i];
  }
  return args;
}

function extractText(message) {
  if (typeof message.text === 'string' && message.text.trim()) return message.text;
  if (Array.isArray(message.content)) {
    const parts = message.content
      .filter((b) => b && (b.type === 'text' || typeof b.text === 'string'))
      .map((b) => b.text || '')
      .filter(Boolean);
    if (parts.length > 0) return parts.join('\n\n');
  }
  return null;
}

function normalizeRole(message) {
  const raw = (message.sender || message.role || '').toLowerCase();
  if (raw === 'human' || raw === 'user') return 'user';
  if (raw === 'assistant' || raw === 'ai') return 'assistant';
  return null;
}

const MEMORY_PROMPT = `You will be given the full transcripts of someone's past conversations with an AI assistant. Distill them into a single, compact background-memory document that a *different* assistant can use to understand who this person is and what's relevant about their life, without ever having seen these conversations.

Write it as organized notes (markdown headings are fine), covering things like:
- Who they are and their current context (school, work, projects, etc.)
- Ongoing goals or things they're actively working toward
- Durable preferences (how they like help given, tone, level of detail)
- Important recurring topics or interests
- Anything a helpful assistant would be embarrassed not to already know on a new conversation

Leave out one-off trivia, anything time-sensitive that's likely already stale, and anything sensitive (financial account numbers, exact addresses, etc.) beyond what's needed for general context. Be concise - aim for roughly 800-1500 words. Write it in third person ("The user is...") since it will be silently inserted into another assistant's system prompt.`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file || !args.userId) {
    console.error('Usage: node scripts/generate-memory.mjs --file <conversations.json> --user-id <uuid>');
    process.exit(1);
  }

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY, ANTHROPIC_MODEL } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !ANTHROPIC_API_KEY || !ANTHROPIC_MODEL) {
    console.error(
      'Set SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY, and ANTHROPIC_MODEL in your environment first.',
    );
    process.exit(1);
  }

  const conversations = JSON.parse(fs.readFileSync(args.file, 'utf-8'));
  const transcriptParts = [];

  for (const conv of conversations) {
    const lines = [];
    for (const m of conv.chat_messages || []) {
      const role = normalizeRole(m);
      const text = extractText(m);
      if (!role || !text) continue;
      lines.push(`${role === 'user' ? 'Human' : 'Assistant'}: ${text}`);
    }
    if (lines.length > 0) {
      transcriptParts.push(`## ${conv.name || 'Untitled conversation'}\n${lines.join('\n\n')}`);
    }
  }

  const fullTranscript = transcriptParts.join('\n\n---\n\n');
  console.log(`Built transcript from ${transcriptParts.length} conversations (${fullTranscript.length} chars).`);

  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  console.log('Asking Claude to distill this into a memory document...');

  const response = await client.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: 4096,
    system: MEMORY_PROMPT,
    messages: [{ role: 'user', content: fullTranscript }],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  const memory = textBlock ? textBlock.text : '';

  if (!memory.trim()) {
    console.error('Claude returned no text. Aborting without writing anything.');
    process.exit(1);
  }

  const outPath = './memory-preview.md';
  fs.writeFileSync(outPath, memory);
  console.log(`Wrote a local preview to ${outPath} (${memory.length} chars). Review it, then re-run with --confirm to save it.`);

  if (!process.argv.includes('--confirm')) {
    console.log('\nDry run only - nothing was saved to Supabase. Re-run with --confirm once you\'ve reviewed the preview.');
    return;
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { error } = await supabase
    .from('user_memory')
    .upsert({ user_id: args.userId, content: memory, updated_at: new Date().toISOString() });

  if (error) {
    console.error('Failed to save memory:', error.message);
    process.exit(1);
  }

  console.log('Saved to user_memory for', args.userId);
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
