/* Blackwhole — chat UI, conversation storage, streaming, settings.
   Includes: live chat search, message editing, and an animated intro. */
(function () {
  "use strict";

  /* ---------- Storage & state ---------- */
  const SETTINGS_KEY = "blackwhole.settings";
  const CHATS_KEY = "blackwhole.chats";
  const THEME_KEY = "blackwhole.theme";

  const $ = (id) => document.getElementById(id);

  // Built-in Groq key: everyone uses this by default, so the API-key prompt
  // never appears. Replace it here if the key is rotated.
  const BUILT_IN_API_KEY = "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";

  let settings = {
    provider: "groq",
    apiKey: BUILT_IN_API_KEY,
    model: "openai/gpt-oss-120b",
    baseUrl: "",
    systemPrompt: "You are Blackwhole, a helpful, friendly AI assistant created by Mano Francis. Answer clearly and concisely, using markdown formatting when useful.",
    temperature: 0.7,
  };
  let chats = [];               // [{id, title, createdAt, messages:[{role,content}]}]
  let currentId = null;         // active conversation
  let streaming = false;
  let abortCtrl = null;
  let searchQuery = "";

  function loadState() {
    try { Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}); } catch {}

    // Pre-configured for Groq + openai/gpt-oss-120b with the built-in key.
    // Ignore any old/stale values so every user gets the same working setup.
    settings.provider = "groq";
    settings.apiKey = BUILT_IN_API_KEY;
    settings.model = "openai/gpt-oss-120b";
    settings.temperature = 0.7;

    try { chats = JSON.parse(localStorage.getItem(CHATS_KEY)) || []; } catch { chats = []; }
    if (!Array.isArray(chats)) chats = [];
  }
  function saveSettings() { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); }
  function saveChats() { localStorage.setItem(CHATS_KEY, JSON.stringify(chats)); }

  function currentChat() { return chats.find(c => c.id === currentId) || null; }
  function provider() { return AI.PROVIDERS[settings.provider] || AI.PROVIDERS.openai; }
  function modelName() { return settings.model || provider().defaultModel || "custom model"; }
  function hasKey() { return !!settings.apiKey || settings.provider === "custom"; }
  function uid() { return "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  /* ---------- Intro splash (cinematic, click/key to skip) ---------- */
  (function initIntro() {
    const intro = $("intro");
    if (!intro) return;

    const statusEl = $("introStatus");
    const canvas = $("introCanvas");
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const DURATION = reduce ? 900 : 3200;

    let finished = false;
    let raf = null;
    let cleanupCanvas = null;

    const phases = [
      [0, "INITIALIZING INTERFACE"],
      [800, "CALIBRATING NEURAL CORE"],
      [1600, "SYNCING KNOWLEDGE"],
      [2400, "READY"],
    ];
    const timers = phases.map(([t, txt]) => setTimeout(() => {
      if (statusEl && !finished) statusEl.textContent = txt;
    }, t));

    /* Star-warp canvas */
    if (canvas && !reduce && canvas.getContext) {
      const ctx = canvas.getContext("2d");
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      let w = 0, h = 0, stars = [], last = 0;

      const newStar = (spread) => ({
        x: (Math.random() - .5) * w * (spread ? 1 : .25),
        y: (Math.random() - .5) * h * (spread ? 1 : .25),
        z: Math.random() * w + 40,
        o: Math.random() * .5 + .28,
        tint: Math.random() < .14,
      });

      const seed = () => {
        stars = [];
        const count = Math.min(220, Math.round((w * h) / 12000));
        for (let i = 0; i < count; i++) stars.push(newStar(true));
      };

      const resize = () => {
        w = window.innerWidth;
        h = window.innerHeight;
        canvas.width = Math.floor(w * dpr);
        canvas.height = Math.floor(h * dpr);
        canvas.style.width = w + "px";
        canvas.style.height = h + "px";
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        seed();
      };

      const tick = (now) => {
        if (finished) return;
        const dt = Math.min(34, now - (last || now));
        last = now;
        ctx.clearRect(0, 0, w, h);
        const cx = w / 2, cy = h / 2;

        for (let i = 0; i < stars.length; i++) {
          const s = stars[i];
          s.z -= dt * 0.075;
          if (s.z < 12) { stars[i] = newStar(false); continue; }

          const k = 145 / s.z;
          const px = s.x * k + cx;
          const py = s.y * k + cy;
          if (px < -60 || px > w + 60 || py < -60 || py > h + 60) {
            stars[i] = newStar(false);
            continue;
          }

          const depth = 1 - Math.min(1, s.z / w);
          const size = Math.max(.5, depth * 1.8);
          const alpha = Math.min(1, s.o * (depth * 1.7 + .12));
          const col = s.tint ? "225,140,255" : "190,210,255";

          const k2 = 145 / (s.z + 12);
          ctx.strokeStyle = "rgba(" + col + "," + (alpha * .45) + ")";
          ctx.lineWidth = size;
          ctx.beginPath();
          ctx.moveTo(s.x * k2 + cx, s.y * k2 + cy);
          ctx.lineTo(px, py);
          ctx.stroke();

          ctx.fillStyle = "rgba(" + col + "," + alpha + ")";
          ctx.fillRect(px, py, size, size);
        }
        raf = requestAnimationFrame(tick);
      };

      resize();
      window.addEventListener("resize", resize);
      raf = requestAnimationFrame(tick);
      cleanupCanvas = () => {
        if (raf) cancelAnimationFrame(raf);
        window.removeEventListener("resize", resize);
      };
    }

    const finish = () => {
      if (finished) return;
      finished = true;
      timers.forEach(clearTimeout);
      window.removeEventListener("keydown", onKey);
      if (cleanupCanvas) cleanupCanvas();
      intro.classList.add("intro-out");
      window.setTimeout(() => {
        intro.remove();
        const inp = $("input");
        if (inp) inp.focus();
      }, reduce ? 60 : 720);
    };

    const onKey = (e) => { if (e.key) finish(); };
    intro.addEventListener("click", finish);
    window.addEventListener("keydown", onKey);
    window.setTimeout(finish, DURATION);
  })();

  /* ---------- Theme ---------- */
  const moonPath = '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/>';
  const sunPath = '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>';

  function applyTheme(t) {
    document.documentElement.dataset.theme = t;
    const icon = $("themeIcon");
    if (icon) icon.innerHTML = t === "dark" ? sunPath : moonPath;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", t === "dark" ? "#06060e" : "#f5f4fd");
    localStorage.setItem(THEME_KEY, t);
  }
  $("themeToggle").addEventListener("click", () => {
    applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
  });

  /* ---------- Sidebar ---------- */
  function isMobile() { return window.matchMedia("(max-width: 820px)").matches; }
  function openSidebar() {
    $("sidebar").classList.remove("collapsed");
    document.body.classList.add("sidebar-open");
  }
  function closeSidebar() {
    $("sidebar").classList.add("collapsed");
    document.body.classList.remove("sidebar-open");
  }
  $("sidebarOpen").addEventListener("click", () => {
    $("sidebar").classList.contains("collapsed") ? openSidebar() : closeSidebar();
  });
  $("sidebarClose").addEventListener("click", closeSidebar);
  $("sidebarOverlay").addEventListener("click", closeSidebar);

  /* ---------- Chat search ---------- */
  const searchInput = $("searchInput");
  const searchClear = $("searchClear");

  function setSearch(q, { focus } = {}) {
    searchQuery = q;
    if (searchInput && searchInput.value !== q) searchInput.value = q;
    if (searchClear) searchClear.classList.toggle("hidden", !q);
    renderChatList();
    if (focus && searchInput) { searchInput.focus(); searchInput.select(); }
  }

  if (searchInput) {
    searchInput.addEventListener("input", () => {
      searchQuery = searchInput.value.trim().toLowerCase();
      if (searchClear) searchClear.classList.toggle("hidden", !searchQuery);
      renderChatList();
    });
    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); setSearch("", { focus: true }); }
    });
  }
  if (searchClear) {
    searchClear.addEventListener("click", () => setSearch("", { focus: true }));
  }

  function chatMatches(c, q) {
    if (!q) return true;
    if ((c.title || "").toLowerCase().includes(q)) return true;
    return (c.messages || []).some(m => (m.content || "").toLowerCase().includes(q));
  }
  function chatSnippet(c, q) {
    const m = (c.messages || []).find(m => (m.content || "").toLowerCase().includes(q));
    if (!m) return "";
    const text = m.content.replace(/\s+/g, " ").trim();
    const i = text.toLowerCase().indexOf(q);
    if (i < 0) return "";
    const start = Math.max(0, i - 26);
    const end = Math.min(text.length, i + q.length + 42);
    return (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
  }
  function paintHighlight(el, text, q) {
    el.textContent = "";
    if (!q) { el.textContent = text; return; }
    const lower = text.toLowerCase();
    let from = 0, idx;
    while ((idx = lower.indexOf(q, from)) !== -1) {
      if (idx > from) el.appendChild(document.createTextNode(text.slice(from, idx)));
      const mark = document.createElement("mark");
      mark.textContent = text.slice(idx, idx + q.length);
      el.appendChild(mark);
      from = idx + q.length;
    }
    if (from < text.length) el.appendChild(document.createTextNode(text.slice(from)));
  }

  /* ---------- Chat list ---------- */
  function renderChatList() {
    const list = $("chatList");
    const countEl = $("chatCount");
    if (!list) return;
    list.innerHTML = "";

    const sorted = [...chats].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const visible = searchQuery ? sorted.filter(c => chatMatches(c, searchQuery)) : sorted;

    if (countEl) {
      countEl.textContent = searchQuery
        ? visible.length + "/" + chats.length
        : (chats.length ? String(chats.length) : "");
    }

    if (!visible.length) {
      const empty = document.createElement("div");
      empty.className = "chat-empty";
      empty.textContent = searchQuery ? "No matches found" : "No chats yet";
      list.appendChild(empty);
      return;
    }

    visible.forEach((c, i) => {
      const item = document.createElement("div");
      item.className = "chat-item" + (c.id === currentId ? " active" : "");
      item.style.animationDelay = Math.min(i * 18, 220) + "ms";
      item.innerHTML =
        '<span class="chat-text"><span class="chat-title"></span><span class="chat-snippet"></span></span>' +
        '<span class="chat-actions">' +
          '<button class="chat-rename" title="Rename chat" aria-label="Rename chat"><svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg></button>' +
          '<button class="chat-del" title="Delete chat" aria-label="Delete chat"><svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2m-9 0 1 14h8l1-14"/></svg></button>' +
        '</span>';

      const titleEl = item.querySelector(".chat-title");
      paintHighlight(titleEl, c.title || "New chat", searchQuery);

      const snippetEl = item.querySelector(".chat-snippet");
      if (searchQuery) {
        const snippet = chatSnippet(c, searchQuery);
        if (snippet) paintHighlight(snippetEl, snippet, searchQuery);
        else snippetEl.remove();
      } else {
        snippetEl.remove();
      }

      item.addEventListener("click", () => { selectChat(c.id); if (isMobile()) closeSidebar(); });
      item.querySelector(".chat-rename").addEventListener("click", (e) => {
        e.stopPropagation();
        beginRename(item, c);
      });
      item.querySelector(".chat-del").addEventListener("click", (e) => {
        e.stopPropagation();
        deleteChat(c.id);
      });
      list.appendChild(item);
    });
  }

  /* Rename a chat inline: Enter/blur saves, Escape cancels. */
  function beginRename(item, c) {
    if (item.classList.contains("editing")) return;
    item.classList.add("editing");

    const titleEl = item.querySelector(".chat-title");
    if (!titleEl) return;
    const oldTitle = c.title || "New chat";

    const input = document.createElement("input");
    input.className = "chat-title-input";
    input.type = "text";
    input.value = oldTitle;
    input.maxLength = 80;
    input.spellcheck = false;
    input.setAttribute("aria-label", "Chat name");
    titleEl.replaceWith(input);
    input.focus();
    input.select();

    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      const next = input.value.trim().replace(/\s+/g, " ");
      if (save && next && next !== oldTitle) {
        c.title = next.slice(0, 80);
        saveChats();
        if (c.id === currentId) $("chatTitle").textContent = c.title;
      }
      renderChatList();
    };

    input.addEventListener("click", (e) => e.stopPropagation());
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); finish(true); }
      else if (e.key === "Escape") { e.preventDefault(); finish(false); }
    });
    input.addEventListener("blur", () => finish(true));
  }

  function deleteChat(id) {
    if (streaming && id === currentId) stopStreaming();
    chats = chats.filter(c => c.id !== id);
    if (currentId === id) {
      const next = [...chats].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];
      currentId = next ? next.id : null;
      renderCurrentChat();
    }
    saveChats();
    renderChatList();
  }

  function newChat() {
    if (streaming) stopStreaming();
    currentId = null;
    setSearch("");
    renderCurrentChat();
    renderChatList();
    $("input").focus();
  }
  $("newChatBtn").addEventListener("click", newChat);

  function selectChat(id) {
    if (streaming) stopStreaming();
    currentId = id;
    renderCurrentChat();
    renderChatList();
  }

  /* ---------- Message rendering ---------- */
  const messagesEl = $("messages");
  let atBottom = true;

  messagesEl.addEventListener("scroll", () => {
    atBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 90;
  });
  function autoScroll(force) {
    if (atBottom || force) messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function buildMessage(role) {
    const wrap = document.createElement("div");
    wrap.className = "message msg-row " + (role === "user" ? "msg-user" : "msg-ai");

    if (role === "user") {
      const col = document.createElement("div");
      col.className = "user-col";
      const bubble = document.createElement("div");
      bubble.className = "user-bubble";
      const actions = document.createElement("div");
      actions.className = "msg-actions";
      col.appendChild(bubble);
      col.appendChild(actions);
      wrap.appendChild(col);
      wrap._bubble = bubble;
      wrap._actions = actions;
      wrap._col = col;
    } else {
      wrap.innerHTML = '<div class="ai-avatar blackhole"></div><div class="msg-content"><div class="md"></div></div>';
      wrap._md = wrap.querySelector(".md");
    }

    messagesEl.appendChild(wrap);
    return wrap;
  }

  function addUserMessage(text) {
    const el = buildMessage("user");
    el._bubble.textContent = text;
    return el;
  }

  function addAssistantShell() {
    const el = buildMessage("assistant");
    el._md.innerHTML = '<div class="typing-dots"><span></span><span></span><span></span></div>';
    return el;
  }

  function buildUserActions(el, idx, text) {
    const actions = el._actions;
    if (!actions) return;
    actions.innerHTML = "";

    const edit = document.createElement("button");
    edit.className = "icon-btn act-edit";
    edit.title = "Edit message";
    edit.setAttribute("aria-label", "Edit message");
    edit.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
    edit.addEventListener("click", () => startEdit(el, idx));
    actions.appendChild(edit);

    const copy = document.createElement("button");
    copy.className = "icon-btn act-copy";
    copy.title = "Copy message";
    copy.setAttribute("aria-label", "Copy message");
    copy.innerHTML = '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
    copy.addEventListener("click", async () => {
      (await copyText(text)) ? toast("Copied to clipboard") : toast("Copy failed", true);
    });
    actions.appendChild(copy);
  }

  function addActions(el, text, { regenerate } = {}) {
    const actions = document.createElement("div");
    actions.className = "msg-actions";
    actions.innerHTML =
      '<button class="icon-btn act-copy" title="Copy"><svg viewBox="0 0 24 24"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg></button>' +
      (regenerate ? '<button class="icon-btn act-retry" title="Regenerate"><svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-3-6.7M21 3v6h-6"/></svg></button>' : "");
    actions.querySelector(".act-copy").addEventListener("click", async () => {
      (await copyText(text)) ? toast("Copied to clipboard") : toast("Copy failed", true);
    });
    const retry = actions.querySelector(".act-retry");
    if (retry) retry.addEventListener("click", regenerateLast);
    el.querySelector(".msg-content").appendChild(actions);
  }

  function startEdit(wrap, idx) {
    if (streaming) { toast("Stop generating first", true); return; }
    if (wrap._editing) return;

    const conv = currentChat();
    if (!conv || !conv.messages[idx]) return;

    wrap._editing = true;
    const original = conv.messages[idx].content;

    wrap._bubble.style.display = "none";
    wrap._actions.style.display = "none";

    const box = document.createElement("div");
    box.className = "edit-box";
    box.innerHTML =
      '<textarea class="edit-textarea" spellcheck="false" aria-label="Edit message"></textarea>' +
      '<div class="edit-actions"><button class="btn-ghost edit-cancel">Cancel</button>' +
      '<button class="btn-primary edit-save">Save &amp; send</button></div>';

    const ta = box.querySelector(".edit-textarea");
    ta.value = original;
    wrap._col.appendChild(box);

    const grow = () => {
      ta.style.height = "auto";
      ta.style.height = Math.min(ta.scrollHeight, 260) + "px";
    };
    ta.addEventListener("input", grow);
    requestAnimationFrame(() => {
      grow();
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    });

    const close = () => {
      box.remove();
      wrap._bubble.style.display = "";
      wrap._actions.style.display = "";
      wrap._editing = false;
    };

    box.querySelector(".edit-cancel").addEventListener("click", close);
    box.querySelector(".edit-save").addEventListener("click", () => {
      const text = ta.value.trim();
      if (!text) { ta.focus(); return; }
      if (text === original) { close(); return; }

      conv.messages[idx].content = text;
      conv.messages = conv.messages.slice(0, idx + 1); // conversation diverges here
      if (idx === 0) {
        conv.title = text.length > 42 ? text.slice(0, 42).trim() + "…" : text;
        $("chatTitle").textContent = conv.title;
      }
      saveChats();
      renderCurrentChat();
      renderChatList();
      runAssistant(conv);
    });

    ta.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); close(); }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        box.querySelector(".edit-save").click();
      }
    });
  }

  function renderCurrentChat() {
    messagesEl.querySelectorAll(".message").forEach(m => m.remove());
    const conv = currentChat();
    const welcome = $("welcome");
    if (welcome) welcome.style.display = conv && conv.messages.length ? "none" : "flex";

    if (conv) {
      conv.messages.forEach((m, idx) => {
        if (m.role === "user") {
          const el = addUserMessage(m.content);
          buildUserActions(el, idx, m.content);
        } else {
          const el = buildMessage("assistant");
          el._md.innerHTML = Markdown.render(m.content);
          const isLastAssistant = idx === conv.messages.length - 1;
          if (isLastAssistant) addActions(el, m.content, { regenerate: true });
        }
      });
    }

    $("chatTitle").textContent = (conv && conv.title) || "New chat";
    atBottom = true;
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  /* ---------- Sending ---------- */
  const input = $("input");
  const sendBtn = $("sendBtn");
  const sendIcon = '<svg viewBox="0 0 24 24"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7Z"/></svg>';
  const stopIcon = '<svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>';

  function autoGrow() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 200) + "px";
  }
  input.addEventListener("input", () => { autoGrow(); updateSendBtn(); });

  function updateSendBtn() {
    if (streaming) {
      sendBtn.disabled = false;
      sendBtn.classList.add("stop");
      sendBtn.innerHTML = stopIcon;
      sendBtn.title = "Stop generating";
    } else {
      sendBtn.classList.remove("stop");
      sendBtn.innerHTML = sendIcon;
      sendBtn.title = "Send";
      sendBtn.disabled = !input.value.trim();
    }
  }

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!streaming) send();
    }
  });
  sendBtn.addEventListener("click", () => { streaming ? stopStreaming() : send(); });

  function stopStreaming() {
    if (abortCtrl) abortCtrl.abort();
  }

  function send() {
    const text = input.value.trim();
    if (!text || streaming) return;
    if (!hasKey()) {
      toast("Add your API key first", true);
      openSettings();
      return;
    }
    input.value = "";
    autoGrow();
    updateSendBtn();
    sendMessage(text);
  }

  function sendMessage(text) {
    $("welcome").style.display = "none";
    let conv = currentChat();
    if (!conv) {
      conv = { id: uid(), title: "New chat", createdAt: Date.now(), messages: [] };
      chats.push(conv);
      currentId = conv.id;
    }
    conv.messages.push({ role: "user", content: text });
    const idx = conv.messages.length - 1;

    // Auto-title from first user message
    if (conv.title === "New chat") {
      conv.title = text.length > 42 ? text.slice(0, 42).trim() + "…" : text;
      $("chatTitle").textContent = conv.title;
    }

    const el = addUserMessage(text);
    buildUserActions(el, idx, text);
    autoScroll(true);
    saveChats();
    renderChatList();
    runAssistant(conv);
  }

  async function runAssistant(conv) {
    streaming = true;
    abortCtrl = new AbortController();
    updateSendBtn();

    const shell = addAssistantShell();
    autoScroll(true);
    let full = "";
    let gotFirst = false;

    const paint = (text) => {
      if (!gotFirst) { shell._md.innerHTML = ""; gotFirst = true; }
      shell._md.innerHTML = Markdown.render(text);
      shell._md.classList.add("streaming-cursor");
      autoScroll();
    };

    try {
      full = await AI.streamChat(settings, conv.messages, {
        onDelta: (_delta, all) => paint(all),
        onRetry: (sec) => {
          shell._md.innerHTML =
            '<p class="retry-note">⏳ Free-tier limit hit — retrying in <b>' + sec + 's</b>…</p>';
          autoScroll();
        },
        signal: abortCtrl.signal,
      });
      conv.messages.push({ role: "assistant", content: full });
      saveChats();
    } catch (err) {
      if (err.name === "AbortError") {
        if (full) {
          conv.messages.push({ role: "assistant", content: full + "\n\n*(stopped)*" });
          saveChats();
        } else {
          shell._md.innerHTML = '<p style="color:var(--text-dim)">*Stopped.*</p>';
        }
      } else {
        shell._md.innerHTML =
          '<p class="error-text">⚠️ ' + (err.message || "Something went wrong.") + "</p>";
        toast(err.message || "Request failed", true);
      }
    } finally {
      streaming = false;
      abortCtrl = null;
      const last = conv.messages[conv.messages.length - 1];
      const text = last && last.role === "assistant" ? last.content : full;
      if (gotFirst && text) shell._md.innerHTML = Markdown.render(text);
      shell._md.classList.remove("streaming-cursor");
      addActions(shell, text || "", { regenerate: true });
      updateSendBtn();
      renderChatList();
      autoScroll();
    }
  }

  function regenerateLast() {
    if (streaming) return;
    const conv = currentChat();
    if (!conv || !conv.messages.length) return;
    if (conv.messages[conv.messages.length - 1].role === "assistant") conv.messages.pop();
    saveChats();
    renderCurrentChat();
    runAssistant(conv);
  }

  /* ---------- Clipboard helper ---------- */
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.cssText = "position:fixed;opacity:0;pointer-events:none";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
        return true;
      } catch { return false; }
    }
  }

  /* ---------- Code copy (event delegation) ---------- */
  messagesEl.addEventListener("click", (e) => {
    const btn = e.target.closest(".code-copy");
    if (!btn) return;
    copyText(decodeURIComponent(btn.dataset.code || "")).then(ok => {
      if (!ok) return toast("Copy failed", true);
      btn.textContent = "Copied!";
      setTimeout(() => {
        btn.innerHTML = '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>Copy';
      }, 1500);
    });
  });

  /* ---------- Suggestions ---------- */
  document.querySelectorAll(".suggestion").forEach(btn => {
    btn.addEventListener("click", () => {
      input.value = btn.dataset.prompt;
      autoGrow();
      updateSendBtn();
      send();
    });
  });

  /* ---------- Keyboard shortcuts ---------- */
  document.addEventListener("keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    const key = e.key.toLowerCase();
    if (key === "k") {
      e.preventDefault();
      openSidebar();
      setSearch("", { focus: true });
    } else if (key === "n") {
      e.preventDefault();
      newChat();
    }
  });

  /* ---------- Settings modal ---------- */
  const modal = $("settingsModal");
  function openSettings() {
    $("providerSelect").value = settings.provider;
    $("apiKeyInput").value = settings.apiKey;
    $("modelInput").value = settings.model;
    $("baseUrlInput").value = settings.baseUrl;
    $("systemPromptInput").value = settings.systemPrompt;
    $("tempInput").value = settings.temperature;
    syncProviderUI();
    modal.classList.remove("hidden");
    $("settingsClose").focus();
  }
  function closeSettings() { modal.classList.add("hidden"); }
  $("settingsBtn").addEventListener("click", () => { openSettings(); if (isMobile()) closeSidebar(); });
  $("settingsClose").addEventListener("click", closeSettings);
  $("settingsCancel").addEventListener("click", closeSettings);
  modal.addEventListener("click", (e) => { if (e.target === modal) closeSettings(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.classList.contains("hidden")) closeSettings();
  });

  function syncProviderUI() {
    const p = provider();
    const prov = $("providerSelect").value;
    $("modelInput").placeholder = p.defaultModel || "your-model-name";
    $("baseUrlField").classList.toggle("field-hidden", prov !== "custom");
    $("tempValue").textContent = $("tempInput").value;
    $("providerHint").textContent =
      "Using the built-in free Groq key — no setup needed.";
  }
  $("providerSelect").addEventListener("change", syncProviderUI);
  $("tempInput").addEventListener("input", () => { $("tempValue").textContent = $("tempInput").value; });

  $("settingsSave").addEventListener("click", () => {
    // Keep the working Groq setup pinned no matter what is in the DOM.
    settings.provider = "groq";
    settings.apiKey = BUILT_IN_API_KEY;
    settings.model = "openai/gpt-oss-120b";
    settings.baseUrl = "";
    settings.temperature = 0.7;
    saveSettings();
    closeSettings();
    updateKeyStatus();
    toast("Settings saved");
  });

  function updateKeyStatus() {
    const dot = $("keyDot"), txt = $("keyStatusText");
    if (hasKey()) {
      dot.className = "dot dot-on";
      txt.textContent = "Blackwhole · Online";
    } else {
      dot.className = "dot dot-off";
      txt.textContent = "No API key set";
    }
    $("modelBadge").textContent = "model/bw-m1-medium";
  }

  /* ---------- Toast ---------- */
  let toastTimer = null;
  function toast(msg, isError) {
    const t = $("toast");
    t.textContent = msg;
    t.className = "toast" + (isError ? " error" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add("hidden"), 3500);
  }

  /* ---------- Init ---------- */
  loadState();
  const savedTheme = localStorage.getItem(THEME_KEY);
  applyTheme(savedTheme || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
  if (isMobile()) closeSidebar();
  renderChatList();
  updateKeyStatus();
  updateSendBtn();
  autoGrow();
})();
