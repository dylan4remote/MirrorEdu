(async function () {
  const supabase = await getSupabaseClient();

  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session) {
    window.location.href = 'index.html';
    return;
  }

  let currentSession = session;
  supabase.auth.onAuthStateChange((_event, newSession) => {
    currentSession = newSession;
    if (!newSession) window.location.href = 'index.html';
  });

  const conversationListEl = document.getElementById('conversation-list');
  const messageListEl = document.getElementById('message-list');
  const messageListInnerEl = document.getElementById('message-list-inner');
  const scrollBottomBtn = document.getElementById('scroll-bottom-btn');
  const inputEl = document.getElementById('input');
  const sendBtn = document.getElementById('send-btn');
  const newChatBtn = document.getElementById('new-chat-btn');
  const signOutBtn = document.getElementById('sign-out-btn');
  const userEmailEl = document.getElementById('user-email');
  const bannerEl = document.getElementById('banner');
  const chatTitleEl = document.getElementById('chat-title');

  userEmailEl.textContent = currentSession.user.email || '';
  userEmailEl.title = currentSession.user.email || '';

  let activeConversationId = null;
  const conversationTitles = new Map();

  marked.setOptions({ breaks: true, gfm: true });

  function renderAssistantContent(el, text) {
    el.innerHTML = DOMPurify.sanitize(marked.parse(text));
  }

  function showBanner(message) {
    bannerEl.textContent = message;
    bannerEl.classList.add('visible');
  }

  function hideBanner() {
    bannerEl.classList.remove('visible');
  }

  function renderEmptyState() {
    messageListInnerEl.innerHTML = `
      <div class="empty-state">
        <span class="empty-kicker">// start here</span>
        <h2 class="empty-headline">What are we studying today?</h2>
        <p class="empty-sub">Ask a question, paste your notes, or pick a starting point.</p>
        <div class="suggestion-row">
          <button type="button" class="suggestion-chip" data-prompt="Explain this concept step by step: ">Explain a concept</button>
          <button type="button" class="suggestion-chip" data-prompt="Summarize this into clear bullet points: ">Summarize my notes</button>
          <button type="button" class="suggestion-chip" data-prompt="Walk me through solving this problem: ">Solve a problem</button>
          <button type="button" class="suggestion-chip" data-prompt="Quiz me with a few practice questions on: ">Quiz me</button>
        </div>
      </div>
    `;
    messageListInnerEl.querySelectorAll('.suggestion-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        inputEl.value = chip.dataset.prompt;
        autoGrow();
        updateSendButtonState();
        inputEl.focus();
        inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
      });
    });
  }

  // --- Scroll handling: only auto-follow new content when the user is
  // already near the bottom, and show a "jump to latest" pill otherwise.
  const NEAR_BOTTOM_THRESHOLD = 120;

  function isNearBottom() {
    return (
      messageListEl.scrollHeight - messageListEl.scrollTop - messageListEl.clientHeight <
      NEAR_BOTTOM_THRESHOLD
    );
  }

  function scrollToBottom(smooth) {
    messageListEl.scrollTo({ top: messageListEl.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }

  function updateScrollButton() {
    const scrolledUp = messageListEl.scrollHeight - messageListEl.scrollTop - messageListEl.clientHeight > 200;
    scrollBottomBtn.hidden = !scrolledUp;
  }

  messageListEl.addEventListener('scroll', updateScrollButton);
  scrollBottomBtn.addEventListener('click', () => scrollToBottom(true));

  function appendMessage(role, content, { animate = false } = {}) {
    const empty = messageListInnerEl.querySelector('.empty-state');
    if (empty) empty.remove();

    const row = document.createElement('div');
    row.className = `message-row ${role}`;
    if (animate) row.classList.add('enter');

    if (role === 'assistant') {
      const avatar = document.createElement('div');
      avatar.className = 'avatar';
      avatar.textContent = 'M';
      row.appendChild(avatar);
    }

    const contentEl = document.createElement('div');
    contentEl.className = role === 'user' ? 'message-content bubble' : 'message-content markdown';
    if (role === 'assistant' && content) {
      renderAssistantContent(contentEl, content);
    } else {
      contentEl.textContent = content;
    }
    row.appendChild(contentEl);

    messageListInnerEl.appendChild(row);

    const shouldFollow = isNearBottom();
    if (shouldFollow) scrollToBottom(false);
    updateScrollButton();

    return contentEl;
  }

  function setThinking(contentEl, isThinking) {
    if (isThinking) {
      contentEl.classList.add('thinking');
      contentEl.innerHTML = '<span class="thinking-dots"><span></span><span></span><span></span></span>';
    } else {
      contentEl.classList.remove('thinking');
      contentEl.innerHTML = '';
    }
  }

  async function loadConversations() {
    const { data, error } = await supabase
      .from('conversations')
      .select('id, title, updated_at')
      .eq('source', 'chat')
      .order('updated_at', { ascending: false });

    if (error) {
      showBanner(`Failed to load conversations: ${error.message}`);
      return;
    }

    conversationListEl.innerHTML = '';
    (data || []).forEach((conv) => {
      const title = conv.title || 'New chat';
      conversationTitles.set(conv.id, title);

      const item = document.createElement('div');
      item.className = 'conversation-item';
      item.dataset.id = conv.id;
      if (conv.id === activeConversationId) item.classList.add('active');

      const titleEl = document.createElement('span');
      titleEl.className = 'conversation-title';
      titleEl.textContent = title;
      item.appendChild(titleEl);

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'conversation-delete-btn';
      deleteBtn.setAttribute('aria-label', 'Delete chat');
      deleteBtn.innerHTML =
        '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M3 4h10M6.5 4V2.5a1 1 0 011-1h1a1 1 0 011 1V4M4.5 4l.5 9a1 1 0 001 1h4a1 1 0 001-1l.5-9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteConversation(conv.id, item);
      });
      item.appendChild(deleteBtn);

      item.addEventListener('click', () => openConversation(conv.id));
      conversationListEl.appendChild(item);
    });
  }

  async function deleteConversation(id, itemEl) {
    if (!window.confirm('Delete this chat? This cannot be undone.')) return;

    try {
      const response = await fetch('/api/conversation', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${currentSession.access_token}`,
        },
        body: JSON.stringify({ conversationId: id }),
      });

      if (!response.ok) {
        let errorMessage = `Failed to delete chat (${response.status}).`;
        try {
          const body = await response.json();
          if (body.error) errorMessage = body.error;
        } catch (_) {
          // response wasn't JSON; keep the default message
        }
        showBanner(errorMessage);
        return;
      }

      itemEl.remove();
      if (id === activeConversationId) startNewChat();
    } catch (err) {
      showBanner(`Network error: ${err.message}`);
    }
  }

  async function openConversation(id) {
    activeConversationId = id;
    chatTitleEl.textContent = conversationTitles.get(id) || 'Chat';
    document.querySelectorAll('.conversation-item').forEach((el) => {
      el.classList.toggle('active', el.dataset.id === id);
    });

    const { data, error } = await supabase
      .from('messages')
      .select('role, content')
      .eq('conversation_id', id)
      .order('created_at', { ascending: true });

    if (error) {
      showBanner(`Failed to load messages: ${error.message}`);
      return;
    }

    if (!data || data.length === 0) {
      renderEmptyState();
    } else {
      messageListInnerEl.innerHTML = '';
      data.forEach((m) => appendMessage(m.role, m.content));
      scrollToBottom(false);
      updateScrollButton();
    }
  }

  function startNewChat() {
    activeConversationId = null;
    chatTitleEl.textContent = 'MirrorEdu';
    document.querySelectorAll('.conversation-item').forEach((el) => el.classList.remove('active'));
    renderEmptyState();
  }

  function autoGrow() {
    inputEl.style.height = 'auto';
    inputEl.style.height = `${Math.min(inputEl.scrollHeight, 160)}px`;
  }

  function updateSendButtonState() {
    sendBtn.disabled = !inputEl.value.trim();
  }

  async function sendMessage() {
    const text = inputEl.value.trim();
    if (!text) return;

    hideBanner();
    inputEl.value = '';
    autoGrow();
    sendBtn.disabled = true;

    appendMessage('user', text, { animate: true });
    const assistantEl = appendMessage('assistant', '', { animate: true });
    setThinking(assistantEl, true);

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${currentSession.access_token}`,
        },
        body: JSON.stringify({ conversationId: activeConversationId, message: text }),
      });

      if (!response.ok) {
        let errorMessage = `Request failed (${response.status}).`;
        try {
          const body = await response.json();
          if (body.error) errorMessage = body.error;
        } catch (_) {
          // response wasn't JSON; keep the default message
        }
        assistantEl.classList.remove('thinking');
        assistantEl.classList.add('error');
        assistantEl.textContent = errorMessage;
        return;
      }

      const returnedConversationId = response.headers.get('X-Conversation-Id');
      const isNewConversation = !activeConversationId;
      if (returnedConversationId) activeConversationId = returnedConversationId;

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let fullText = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        fullText += decoder.decode(value, { stream: true });
        if (assistantEl.classList.contains('thinking')) setThinking(assistantEl, false);
        const shouldFollow = isNearBottom();
        renderAssistantContent(assistantEl, fullText);
        if (shouldFollow) scrollToBottom(false);
        updateScrollButton();
      }

      if (isNewConversation) {
        await loadConversations();
        document.querySelectorAll('.conversation-item').forEach((el) => {
          el.classList.toggle('active', el.dataset.id === activeConversationId);
        });
        chatTitleEl.textContent = conversationTitles.get(activeConversationId) || 'Chat';
      }
    } catch (err) {
      assistantEl.classList.remove('thinking');
      assistantEl.classList.add('error');
      assistantEl.textContent = `Network error: ${err.message}`;
    } finally {
      updateSendButtonState();
    }
  }

  newChatBtn.addEventListener('click', startNewChat);
  signOutBtn.addEventListener('click', async () => {
    await supabase.auth.signOut();
    window.location.href = 'index.html';
  });

  sendBtn.addEventListener('click', sendMessage);
  inputEl.addEventListener('input', () => {
    autoGrow();
    updateSendButtonState();
  });
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  await loadConversations();
})();
