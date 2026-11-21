/* Blackwhole — chat UI, conversation storage, streaming, settings.
   Includes: live chat search, message editing, and an animated intro. */
(function () {
  "use strict";

  /* ---------- Storage & state ---------- */
  const SETTINGS_KEY = "blackwhole.settings";
  const CHATS_KEY = "blackwhole.chats";
  const THEME_KEY = "blackwhole.theme";

  const $ = (id) => document.getElementById(id);
  function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  // The AI runs through Blackwhole's own server-side proxy (see js/api.js
  // PROXY_URL and worker/). No API key lives in this bundle, so it can never
  // leak on GitHub or be revoked by a provider scan again.
  let settings = {
    provider: "blackwhole",
    apiKey: "",
    model: "openai/gpt-oss-120b",
    baseUrl: "",
    systemPrompt: "You are Blackwhole, a helpful, friendly AI assistant created by Mano Francis. Answer clearly and concisely, using markdown formatting when useful. Never invent the current date, time, or weather — always rely on the provided real-time context and tools instead.",
    temperature: 0.7,
  };
  let chats = [];               // [{id, title, createdAt, messages:[{role,content}]}]
  let currentId = null;         // active conversation
  let streaming = false;
  let abortCtrl = null;
  let searchQuery = "";
  const SOUND_KEY = "blackwhole.sound";
  let soundEnabled = (localStorage.getItem(SOUND_KEY) !== "off");

  /* ---------- Sound effects (Web Audio) ---------- */
  let audioCtx = null;
  function getAudioCtx() {
    if (!audioCtx) {
      try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch { audioCtx = null; }
    }
    return audioCtx;
  }
  function playTone(freq, dur, type, gain) {
    if (!soundEnabled) return;
    const ctx = getAudioCtx();
    if (!ctx) return;
    try {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = type || "sine";
      osc.frequency.value = freq;
      g.gain.value = gain || 0.08;
      osc.connect(g); g.connect(ctx.destination);
      osc.start();
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
      osc.stop(ctx.currentTime + dur);
    } catch { /* ignore */ }
  }
  function soundSend() { playTone(660, 0.08, "sine", 0.06); }
  function soundReceive() { playTone(880, 0.12, "sine", 0.05); setTimeout(() => playTone(1100, 0.1, "sine", 0.04), 120); }

  /* ---------- Favicon animation while streaming ---------- */
  const originalFavicon = document.querySelector('link[rel="icon"][sizes="32x32"]')?.href || "assets/icons/favicon-32x32.png";
  let faviconAnim = null;
  function startFaviconAnim() {
    const link = document.querySelector('link[rel="icon"][sizes="32x32"]') || document.querySelector('link[rel="icon"]');
    if (!link) return;
    const canvas = document.createElement("canvas");
    canvas.width = 32; canvas.height = 32;
    const ctx = canvas.getContext("2d");
    let angle = 0;
    faviconAnim = setInterval(() => {
      ctx.clearRect(0, 0, 32, 32);
      ctx.fillStyle = "#06060e";
      ctx.fillRect(0, 0, 32, 32);
      ctx.strokeStyle = "#a78bfa";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(16, 16, 10, angle, angle + Math.PI * 1.5);
      ctx.stroke();
      link.href = canvas.toDataURL("image/png");
      angle += 0.15;
    }, 80);
  }
  function stopFaviconAnim() {
    if (faviconAnim) { clearInterval(faviconAnim); faviconAnim = null; }
    const link = document.querySelector('link[rel="icon"][sizes="32x32"]') || document.querySelector('link[rel="icon"]');
    if (link) link.href = originalFavicon;
  }

  function loadState() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch {}

    // Settings v4: default moved back to Blackwhole (Groq) — Pollinations
    // turned out to be unreliable (404/429, 1 request at a time per IP).
    // Older saved settings are discarded once, cleanly.
    if (saved && saved.settingsVersion === 4) {
      Object.assign(settings, saved);
    }
    settings.settingsVersion = 4;

    try { chats = JSON.parse(localStorage.getItem(CHATS_KEY)) || []; } catch { chats = []; }
    if (!Array.isArray(chats)) chats = [];
  }
  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); return true; }
    catch (e) { try { toast("Could not save settings (storage blocked or full)", true); } catch {} return false; }
  }
  function saveChats() {
    try { localStorage.setItem(CHATS_KEY, JSON.stringify(chats)); return true; }
    catch (e) { try { toast("Could not save chats (storage blocked or full)", true); } catch {} return false; }
  }

  function currentChat() { return chats.find(c => c.id === currentId) || null; }
  function provider() { return AI.PROVIDERS[settings.provider] || AI.PROVIDERS.openai; }
  function modelName() { return settings.model || provider().defaultModel || "custom model"; }
  function hasKey() {
    // noKey providers (blackwhole proxy, Pollinations) need no key.
    return (provider() && provider().noKey) || !!settings.apiKey || settings.provider === "custom";
  }
  function uid() { return "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  /* ---------- Intro splash (cinematic, click/key to skip) ---------- */
  (function initIntro() {
    const intro = $("intro");
    if (!intro) return;

    const statusEl = $("introStatus");
    const canvas = $("introCanvas");
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // Shorter splash so the chat feels instant (ChatGPT-like) while keeping
    // the cinematic intro.
    const DURATION = reduce ? 500 : 1400;

    let finished = false;
    let raf = null;
    let cleanupCanvas = null;

    const phases = [
      [0, "INITIALIZING INTERFACE"],
      [350, "CALIBRATING NEURAL CORE"],
      [700, "SYNCING KNOWLEDGE"],
      [1050, "READY"],
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

  function applySoundState() {
    const icon = $("soundIcon");
    if (icon) {
      icon.innerHTML = soundEnabled
        ? '<path d="M11 5L6 9H2v6h4l5 4V5zM15.5 8.5a4.5 4.5 0 0 1 0 7M19 5a8 8 0 0 1 0 14"/>'
        : '<path d="M11 5L6 9H2v6h4l5 4V5zM23 9l-6 6M17 9l6 6"/>';
    }
    const btn = $("soundToggle");
    if (btn) btn.title = soundEnabled ? "Sound effects on" : "Sound effects off";
  }
  applySoundState();
  $("soundToggle").addEventListener("click", () => {
    soundEnabled = !soundEnabled;
    localStorage.setItem(SOUND_KEY, soundEnabled ? "on" : "off");
    applySoundState();
    if (soundEnabled) soundSend();
  });

  /* ---------- Sidebar ---------- */
  const mobileQuery = window.matchMedia("(max-width: 820px), (max-height: 560px) and (orientation: landscape)");
  function isMobile() { return mobileQuery.matches; }
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

  // Rotation or a window resize can cross the drawer breakpoint. Reset to the
  // correct default instead of leaving a fixed drawer floating over the chat.
  if (mobileQuery.addEventListener) {
    mobileQuery.addEventListener("change", (e) => {
      if (e.matches) closeSidebar();
      else { $("sidebar").classList.remove("collapsed"); document.body.classList.remove("sidebar-open"); }
    });
  }

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
    if (String(c.title || "").toLowerCase().includes(q)) return true;
    return (c.messages || []).some(m => String(m.content || "").toLowerCase().includes(q));
  }
  function chatSnippet(c, q) {
    const m = (c.messages || []).find(m => String(m.content || "").toLowerCase().includes(q));
    if (!m) return "";
    const text = String(m.content || "").replace(/\s+/g, " ").trim();
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
    el._md.innerHTML = '<div class="typing-dots"><span></span><span></span><span></span></div><span class="typing-label">Thinking…</span>';
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
    // Cap the box so the composer never swallows the message area on phones.
    const viewportH = (window.visualViewport && window.visualViewport.height) || window.innerHeight;
    const limit = Math.min(200, Math.max(96, Math.round(viewportH * 0.32)));
    input.style.height = Math.min(input.scrollHeight, limit) + "px";
  }
  input.addEventListener("input", () => { autoGrow(); updateSendBtn(); });

  // Phone keyboards and rotation resize the viewport: resync the app height,
  // re-measure the input and keep the newest message visible.
  function syncAppHeight() {
    const h = (window.visualViewport && window.visualViewport.height) || window.innerHeight;
    if (h > 200) {
      document.documentElement.style.setProperty("--app-height", Math.round(h) + "px");
    }
  }
  function onViewportChange() {
    syncAppHeight();
    autoGrow();
    autoScroll();
  }
  syncAppHeight();
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", onViewportChange);
  }
  window.addEventListener("orientationchange", () => setTimeout(onViewportChange, 250));
  window.addEventListener("resize", onViewportChange);

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

  /* ---------- Offline queue ---------- */
  const OFFLINE_Q_KEY = "blackwhole.offlineQueue";
  function offlineQueue() {
    try { return JSON.parse(localStorage.getItem(OFFLINE_Q_KEY) || "[]"); } catch { return []; }
  }
  function saveOfflineQueue(q) {
    try { localStorage.setItem(OFFLINE_Q_KEY, JSON.stringify(q)); } catch {}
  }
  function enqueueOffline(text) {
    const q = offlineQueue();
    q.push({ text, ts: Date.now() });
    saveOfflineQueue(q);
    toast("You're offline. Message queued — will send when back online.", true);
  }
  async function flushOfflineQueue() {
    const q = offlineQueue();
    if (!q.length) return;
    saveOfflineQueue([]);
    for (const item of q) {
      try { sendMessage(item.text); await new Promise(r => setTimeout(r, 300)); } catch {}
    }
    toast("Sent " + q.length + " queued message(s).");
  }
  window.addEventListener("online", flushOfflineQueue);
  // Try flushing on load if there are queued messages.
  setTimeout(() => { if (navigator.onLine) flushOfflineQueue(); }, 1500);
  sendBtn.addEventListener("click", () => { streaming ? stopStreaming() : send(); });

  function stopStreaming() {
    if (abortCtrl) abortCtrl.abort();
  }

  function send() {
    const text = input.value.trim();
    if (!text || streaming) return;
    if (!navigator.onLine) { enqueueOffline(text); input.value = ""; autoGrow(); updateSendBtn(); return; }
    soundSend();
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

  /* Fresh, accurate real-time facts injected into every request, so the
     model never guesses the date, time or timezone (it cannot know them —
     its training data is months old). Built at send time. */
  function realtimeContext() {
    const now = new Date();
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown";
    let local;
    try {
      local = new Intl.DateTimeFormat("en-GB", {
        weekday: "long", day: "numeric", month: "long", year: "numeric",
        hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short",
      }).format(now);
    } catch { local = now.toString(); }
    const off = -now.getTimezoneOffset();
    const oh = String(Math.floor(Math.abs(off) / 60)).padStart(2, "0");
    const om = String(Math.abs(off) % 60).padStart(2, "0");
    return [
      "REAL-TIME CONTEXT (captured just now — trust this over your training data):",
      "- User's local date & time: " + local + " (" + tz + ", UTC" +
        (off >= 0 ? "+" : "-") + oh + ":" + om + ")",
      "- UTC now: " + now.toUTCString(),
      "- Rule: never guess or invent the current date, time or weather. For",
      "  time questions use the context above (or the get_current_datetime",
      "  tool for other cities); for weather always call the get_weather tool.",
    ].join("\n");
  }

  /* Long-term memory facts (Fix 4a), stored by the remember/forget tools
     in localStorage and injected into every request so past chats carry
     forward. Zero API change — rides on clientContext. */
  function memoryContext() {
    const mem = (window.AI.memoryFacts && window.AI.memoryFacts()) || [];
    if (!mem.length) return "";
    const lines = mem.map((f, i) => (i + 1) + ". " + f.fact);
    return [
      "LONG-TERM MEMORY (facts remembered from past conversations — use them",
      "naturally when relevant, e.g. the user's name; do not recite this list):",
      lines.join("\n"),
    ].join("\n");
  }

  async function runAssistant(conv) {
    streaming = true;
    abortCtrl = new AbortController();
    updateSendBtn();
    startFaviconAnim();

    const shell = addAssistantShell();
    autoScroll(true);
    let full = "";
    let partial = "";
    let gotFirst = false;
    let abortedEmpty = false;

    const paint = (text) => {
      if (!gotFirst) { shell._md.innerHTML = ""; gotFirst = true; soundReceive(); }
      shell._md.innerHTML = Markdown.render(text);
      shell._md.classList.add("streaming-cursor");
      autoScroll();
    };

    try {
      full = await AI.streamChat(
        { ...settings, clientContext: [realtimeContext(), memoryContext()].filter(Boolean).join("\n\n"), tools: AI.toolkit() },
        conv.messages,
        {
          onDelta: (_delta, all) => { partial = all; paint(all); },
          onRetry: (sec, attempt, reason) => {
            const label = reason === "reconnect" ? "Connection hiccup — reconnecting"
              : reason === "server" ? "AI service busy"
              : "Free-tier limit hit";
            shell._md.innerHTML =
              '<p class="retry-note">⏳ ' + escapeHtml(label) + " — retrying in <b>" + Number(sec) + 's</b>… <span class="retry-attempt">(attempt ' + Number(attempt) + ")</span></p>";
            autoScroll();
          },
          onContinue: () => {
            shell._md.innerHTML =
              '<p class="retry-note">⏳ Continuing the answer…</p>';
            autoScroll();
          },
          onToolCall: (name) => {
            const label = name === "get_weather" ? "🌦️ Checking live weather…"
              : name === "get_current_datetime" ? "🕒 Checking the exact time…"
              : name === "web_search" ? "🔎 Searching the web…"
              : name === "read_webpage" ? "📄 Reading the page…"
              : name === "count_text" ? "🔢 Verifying the counts…"
              : name === "remember" ? "🧠 Saving to long-term memory…"
              : name === "forget" ? "🧠 Updating long-term memory…"
              : "🛠️ Using a tool…";
            shell._md.innerHTML = '<p class="retry-note">' + label + "</p>";
            autoScroll();
          },
          onTruncated: () => {
            toast('Reply may be incomplete — send "continue" to keep going.');
          },
          signal: abortCtrl.signal,
        }
      );
      conv.messages.push({ role: "assistant", content: full });
      saveChats();
    } catch (err) {
      if (err.name === "AbortError") {
        const kept = err.partial || partial || full;
        if (kept) {
          conv.messages.push({ role: "assistant", content: kept + "\n\n*(stopped)*" });
          saveChats();
        } else {
          abortedEmpty = true;
          shell._md.innerHTML = '<p style="color:var(--text-dim)">*Stopped.*</p>';
        }
      } else if (partial) {
        // Something interrupted the stream after text arrived: keep what the
        // model already wrote instead of replacing it with a bare error.
        conv.messages.push({ role: "assistant", content: partial });
        saveChats();
        toast(err.message || "Response interrupted", true);
      } else {
        // Dead end after all automatic retries: keep the user's message
        // intact and offer a one-tap retry so nothing needs retyping.
        const msg = err.message || "Something went wrong.";
        shell._md.innerHTML =
          '<p class="error-text">⚠️ ' + escapeHtml(msg) + "</p>" +
          '<button class="retry-btn" type="button">↻ Try again</button>';
        const btn = shell._md.querySelector(".retry-btn");
        if (btn) btn.addEventListener("click", () => { if (!streaming) regenerateLast(); });
        toast(msg, true);
      }
    } finally {
      streaming = false;
      abortCtrl = null;
      stopFaviconAnim();
      const stillExists = chats.some(c => c.id === conv.id);
      const last = stillExists && conv.messages.length ? conv.messages[conv.messages.length - 1] : null;
      const text = last && last.role === "assistant" ? last.content : (partial || full);
      if (gotFirst && text) shell._md.innerHTML = Markdown.render(text);
      shell._md.classList.remove("streaming-cursor");
      if (!abortedEmpty && (text || "").trim()) addActions(shell, text || "", { regenerate: true });
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
    $("providerHint").textContent = p.noKey
      ? "Using Blackwhole's free built-in AI service — no key or setup needed."
      : "Using the built-in free Groq key — no setup needed.";
  }
  $("providerSelect").addEventListener("change", syncProviderUI);
  $("tempInput").addEventListener("input", () => { $("tempValue").textContent = $("tempInput").value; });

  $("settingsSave").addEventListener("click", () => {
    settings.provider = $("providerSelect").value || "blackwhole";
    settings.apiKey = $("apiKeyInput").value.trim();
    settings.model = $("modelInput").value.trim() ||
      (AI.PROVIDERS[settings.provider] || {}).defaultModel || "openai/gpt-oss-120b";
    settings.baseUrl = $("baseUrlInput").value.trim();
    settings.systemPrompt = $("systemPromptInput").value;
    settings.temperature = parseFloat($("tempInput").value) || 0.7;
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
