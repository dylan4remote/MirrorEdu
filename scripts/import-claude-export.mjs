#!/usr/bin/env node
// One-time importer: reads the conversations.json file from Claude's
// official data export (claude.ai -> Settings -> Privacy -> Export data)
// and inserts those conversations into MirrorEdu's Supabase tables under a
// specific user's account.
//
// This is a LOCAL script, not a web page or API route, because it needs the
// Supabase service role key, which must never run in a browser.
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//     node scripts/import-claude-export.mjs --file ./conversations.json --user-id <your-supabase-user-uuid> [--dry-run]
//
// Find your user id in the Supabase dashboard: Authentication -> Users ->
// copy the UUID next to your account's email.

import fs from 'fs';
import { createClient } from '@supabase/supabase-js';

function parseArgs(argv) {
  const args = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--file') args.file = argv[++i];
    else if (arg === '--user-id') args.userId = argv[++i];
    else if (arg === '--dry-run') args.dryRun = true;
  }
  return args;
}

function extractText(message) {
  if (typeof message.text === 'string' && message.text.trim()) {
    return message.text;
  }
  if (Array.isArray(message.content)) {
    const parts = message.content
      .filter((block) => block && (block.type === 'text' || typeof block.text === 'string'))
      .map((block) => block.text || '')
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

function chunk(array, size) {
  const out = [];
  for (let i = 0; i < array.length; i += size) out.push(array.slice(i, i + size));
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.file || !args.userId) {
    console.error(
      'Usage: node scripts/import-claude-export.mjs --file <conversations.json> --user-id <uuid> [--dry-run]',
    );
    process.exit(1);
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in your environment first.');
    process.exit(1);
  }

  if (!fs.existsSync(args.file)) {
    console.error(`File not found: ${args.file}`);
    process.exit(1);
  }

  const raw = JSON.parse(fs.readFileSync(args.file, 'utf-8'));
  const conversations = Array.isArray(raw) ? raw : raw.conversations;
  if (!Array.isArray(conversations)) {
    console.error(
      'Could not find a conversation array in this file. Expected the top level to be an array, or an object with a "conversations" array.',
    );
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: userCheck, error: userCheckError } = await supabase.auth.admin.getUserById(
    args.userId,
  );
  if (userCheckError || !userCheck?.user) {
    console.error(`No Supabase user found with id ${args.userId}. Double-check the UUID.`);
    process.exit(1);
  }
  console.log(`Importing into account: ${userCheck.user.email} (${args.userId})`);

  let importedConversations = 0;
  let importedMessages = 0;
  let skippedMessages = 0;

  for (const conv of conversations) {
    const rawMessages = conv.chat_messages || conv.messages || [];
    const rows = [];

    for (const m of rawMessages) {
      const role = normalizeRole(m);
      const text = extractText(m);
      if (!role || !text) {
        skippedMessages++;
        continue;
      }
      rows.push({
        role,
        content: text,
        created_at: m.created_at || undefined,
      });
    }

    if (rows.length === 0) continue;

    const title = (conv.name || conv.title || rows[0].content || 'Imported chat').slice(0, 60);
    const createdAt = conv.created_at || rows[0].created_at || new Date().toISOString();
    const updatedAt = conv.updated_at || rows[rows.length - 1].created_at || createdAt;

    console.log(`- "${title}" (${rows.length} messages)${args.dryRun ? ' [dry run]' : ''}`);

    if (args.dryRun) {
      importedConversations++;
      importedMessages += rows.length;
      continue;
    }

    const { data: newConversation, error: convError } = await supabase
      .from('conversations')
      .insert({
        user_id: args.userId,
        title,
        created_at: createdAt,
        updated_at: updatedAt,
      })
      .select('id')
      .single();

    if (convError) {
      console.error(`  Failed to create conversation "${title}": ${convError.message}`);
      continue;
    }

    const messageRows = rows.map((r) => ({
      conversation_id: newConversation.id,
      user_id: args.userId,
      role: r.role,
      content: r.content,
      ...(r.created_at ? { created_at: r.created_at } : {}),
    }));

    for (const batch of chunk(messageRows, 200)) {
      const { error: msgError } = await supabase.from('messages').insert(batch);
      if (msgError) {
        console.error(`  Failed to insert a batch of messages: ${msgError.message}`);
        continue;
      }
      importedMessages += batch.length;
    }

    importedConversations++;
  }

  console.log('');
  console.log(
    `${args.dryRun ? '[Dry run] Would import' : 'Imported'} ${importedConversations} conversations, ${importedMessages} messages.`,
  );
  if (skippedMessages > 0) {
    console.log(
      `Skipped ${skippedMessages} messages that had no recognizable role or text content.`,
    );
  }
}

main().catch((err) => {
  console.error('Import failed:', err);
  process.exit(1);
});
