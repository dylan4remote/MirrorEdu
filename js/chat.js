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

  userEmailEl.textContent = currentSession.user.email || '';
  userEmailEl.title = currentSession.user.email || '';

  let activeConversationId = null;

  function showBanner(message) {
    bannerEl.textContent = message;
    bannerEl.classList.add('visible');
  }

  function hideBanner() {
    bannerEl.classList.remove('visible');
  }

  function renderEmptyState() {
    messageListInnerEl.innerHTML = '<div class="empty-state">Start a new conversation below.</div>';
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
    contentEl.className = role === 'user' ? 'message-content bubble' : 'message-content';
    contentEl.textContent = content;
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
      const item = document.createElement('div');
      item.className = 'conversation-item';
      item.textContent = conv.title || 'New chat';
      item.dataset.id = conv.id;
      if (conv.id === activeConversationId) item.classList.add('active');
      item.addEventListener('click', () => openConversation(conv.id));
      conversationListEl.appendChild(item);
    });
  }

  async function openConversation(id) {
    activeConversationId = id;
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
        assistantEl.textContent = fullText;
        if (shouldFollow) scrollToBottom(false);
        updateScrollButton();
      }

      if (isNewConversation) {
        await loadConversations();
        document.querySelectorAll('.conversation-item').forEach((el) => {
          el.classList.toggle('active', el.dataset.id === activeConversationId);
        });
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
