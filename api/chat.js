// POST /api/chat
// Body: { conversationId: string|null, message: string }
// Header: Authorization: Bearer <supabase access token>
//
// Verifies the caller, enforces the per-user daily message cap, calls the
// Anthropic Messages API server-side (the only place ANTHROPIC_API_KEY is
// ever read), streams the reply back as plain text, and persists both the
// user's message and the assistant's reply to Supabase.
const Anthropic = require('@anthropic-ai/sdk');
const { getSupabaseAdmin } = require('../lib/supabaseAdmin');
const { verifyUser } = require('../lib/verifyUser');

const SYSTEM_PROMPT =
  'You are the assistant inside MirrorEdu, a chat product. Be helpful, clear, and concise. ' +
  'You have a web search tool - use it when the user asks about current events, recent ' +
  'information, or anything you should verify or cite with a source. ' +
  'Your replies are rendered as Markdown, so format freely and use whatever structure ' +
  'best organizes the answer: headings (#, ##) for sections, bullet or numbered lists, ' +
  '**bold**/*italics* for emphasis, `code` or fenced code blocks for code, and tables ' +
  'where they help. Use mathematical and other unicode symbols directly in text ' +
  '(e.g. √, π, ≈, ×, ÷, ², ³, ≤, ≥, →) rather than spelling them out or using LaTeX.';

// Basic (non-dynamic-filtering) variant - the newer web_search_20260209 tool
// relies on programmatic tool calling, which Haiku 4.5 doesn't support.
const TOOLS = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }];

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const model = process.env.ANTHROPIC_MODEL;
  const dailyLimit = parseInt(process.env.DAILY_MESSAGE_LIMIT || '50', 10);

  if (!apiKey) {
    res.status(500).json({
      error:
        'ANTHROPIC_API_KEY is not set in Vercel. Add it in Project Settings -> Environment Variables and redeploy.',
    });
    return;
  }
  if (!model) {
    res.status(500).json({
      error:
        'ANTHROPIC_MODEL is not set in Vercel. Add it in Project Settings -> Environment Variables and redeploy.',
    });
    return;
  }

  const { user, error: authError } = await verifyUser(req);
  if (!user) {
    res.status(401).json({ error: authError });
    return;
  }

  const { conversationId, message } = req.body || {};
  if (!message || typeof message !== 'string' || !message.trim()) {
    res.status(400).json({ error: 'Message is required.' });
    return;
  }

  const supabaseAdmin = getSupabaseAdmin();

  // Atomically check-and-increment today's usage. See increment_usage() in
  // sql/schema.sql - this can't be gamed by the client since it only ever
  // runs here, with the service role key.
  const { data: allowed, error: usageError } = await supabaseAdmin.rpc('increment_usage', {
    p_user_id: user.id,
    p_limit: dailyLimit,
  });

  if (usageError) {
    res.status(500).json({ error: `Failed to check usage limit: ${usageError.message}` });
    return;
  }
  if (!allowed) {
    res.status(429).json({
      error: `You've reached today's limit of ${dailyLimit} messages. Try again tomorrow.`,
    });
    return;
  }

  // Resolve or create the conversation, and load prior turns for context.
  let activeConversationId = conversationId;
  let history = [];

  if (activeConversationId) {
    const { data: existing, error: convError } = await supabaseAdmin
      .from('conversations')
      .select('id')
      .eq('id', activeConversationId)
      .eq('user_id', user.id)
      .maybeSingle();

    if (convError || !existing) {
      res.status(404).json({ error: 'Conversation not found.' });
      return;
    }

    const { data: priorMessages, error: messagesError } = await supabaseAdmin
      .from('messages')
      .select('role, content')
      .eq('conversation_id', activeConversationId)
      .order('created_at', { ascending: true });

    if (messagesError) {
      res.status(500).json({ error: `Failed to load conversation history: ${messagesError.message}` });
      return;
    }
    history = priorMessages || [];
  } else {
    const title = message.trim().slice(0, 60);
    const { data: newConversation, error: createError } = await supabaseAdmin
      .from('conversations')
      .insert({ user_id: user.id, title })
      .select('id')
      .single();

    if (createError) {
      res.status(500).json({ error: `Failed to create conversation: ${createError.message}` });
      return;
    }
    activeConversationId = newConversation.id;
  }

  const { error: insertUserMessageError } = await supabaseAdmin.from('messages').insert({
    conversation_id: activeConversationId,
    user_id: user.id,
    role: 'user',
    content: message,
  });
  if (insertUserMessageError) {
    res.status(500).json({ error: `Failed to save message: ${insertUserMessageError.message}` });
    return;
  }

  const { data: memoryRow } = await supabaseAdmin
    .from('user_memory')
    .select('content')
    .eq('user_id', user.id)
    .maybeSingle();

  const systemPrompt = memoryRow?.content
    ? `${SYSTEM_PROMPT}\n\nBackground context on this specific user, from their prior history. Use it naturally when relevant; don't recite it or mention that you were given it unless asked:\n\n${memoryRow.content}`
    : SYSTEM_PROMPT;

  const client = new Anthropic({ apiKey });

  // Prompt caching: every turn otherwise resends the whole conversation at
  // full price. Marking the end of prior history as a cache breakpoint means
  // only the newest message costs full input price - everything before it is
  // billed as a 0.1x cache read. 1h TTL because chat replies are often more
  // than 5 minutes apart.
  const historyMessages = history.map((m) => ({ role: m.role, content: m.content }));
  const lastHistoryMessage = historyMessages[historyMessages.length - 1];
  if (lastHistoryMessage) {
    lastHistoryMessage.content = [
      {
        type: 'text',
        text: lastHistoryMessage.content,
        cache_control: { type: 'ephemeral', ttl: '1h' },
      },
    ];
  }
  const anthropicMessages = [...historyMessages, { role: 'user', content: message }];

  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'X-Conversation-Id': activeConversationId,
    'Cache-Control': 'no-cache',
  });

  let fullText = '';
  let messages = anthropicMessages;
  try {
    // Server-side web search can span multiple searches within one turn; if
    // Claude hits the tool's internal iteration cap mid-search, the API
    // returns stop_reason "pause_turn" instead of finishing. Resume by
    // sending the paused turn back until it actually completes.
    for (;;) {
      const stream = client.messages.stream({
        model,
        max_tokens: 4096,
        system: [
          { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral', ttl: '1h' } },
        ],
        messages,
        tools: TOOLS,
      });

      stream.on('text', (delta) => {
        fullText += delta;
        res.write(delta);
      });

      const finalMessage = await stream.finalMessage();
      if (finalMessage.stop_reason !== 'pause_turn') break;
      messages = [...messages, { role: 'assistant', content: finalMessage.content }];
    }
  } catch (error) {
    let errorMessage;
    if (error instanceof Anthropic.AuthenticationError) {
      errorMessage =
        "\n\n[MirrorEdu error: Anthropic rejected the API key. Check ANTHROPIC_API_KEY in Vercel.]";
    } else if (error instanceof Anthropic.RateLimitError) {
      errorMessage = '\n\n[MirrorEdu error: Anthropic rate limit hit. Please try again shortly.]';
    } else if (error instanceof Anthropic.APIError) {
      errorMessage = `\n\n[MirrorEdu error: Anthropic API error (${error.status}): ${error.message}]`;
    } else {
      errorMessage = `\n\n[MirrorEdu error: ${error.message}]`;
    }
    res.write(errorMessage);
    fullText += errorMessage;
  }

  if (fullText.trim()) {
    await supabaseAdmin.from('messages').insert({
      conversation_id: activeConversationId,
      user_id: user.id,
      role: 'assistant',
      content: fullText,
    });
    await supabaseAdmin
      .from('conversations')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', activeConversationId);
  }

  res.end();
};
