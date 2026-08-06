/* ==========================================================================
   Iceland 2026 — live document client.

   Three ways to change the page, one underlying operation (replace a block):
     · click the text and type
     · hover a block, leave a comment, Claude rewrites it
     · ask in the chat panel, Claude edits wherever it needs to

   Everything lands for everyone over one WebSocket.
   ========================================================================== */

(() => {
  "use strict";

  const $  = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  /* Which document this page is. Two live on the same site — the trip plan at
     / and the packing list at /packing — and each is its own Durable Object,
     so every socket and API call has to say which one it means. */
  const DOC = document.querySelector('meta[name="x-doc"]')?.content || "iceland";
  const q   = (path) => `${path}${path.includes("?") ? "&" : "?"}doc=${encodeURIComponent(DOC)}`;

  const state = {
    blocks: new Map(),        // id -> {id, section, ord, html, layout, rev, updated_by}
    ws: null,
    connected: false,
    backoff: 500,
    me: ($("#whoami")?.textContent || "someone").trim(),
    /** Block currently focused locally. Incoming updates for it are held, not applied. */
    editingId: null,
    held: new Map(),          // id -> incoming payload withheld while you type
    saveTimer: null,
    menuFor: null,
    failures: 0,
    signedOut: false,
  };

  /**
   * Distinguishes "the network hiccuped" from "you are no longer signed in".
   * The second is silent and permanent, so it gets a visible, honest dead end
   * rather than a status dot that stays orange forever.
   */
  async function checkSession() {
    if (state.signedOut) return;
    try {
      const res = await fetch(q("/api/export"), { method: "GET" });
      if (res.status !== 401) return;
    } catch { return; }   // genuinely offline — keep retrying, say nothing
    state.signedOut = true;
    const bar = $("#statusbar");
    if (bar) {
      bar.innerHTML =
        `<span class="dot"></span><strong>Signed out</strong>` +
        `<span class="sep">·</span><span>your word changed, or it's been 30 days</span>` +
        `<span class="spacer"></span><a href="/">Sign in again</a>`;
    }
  }

  /* ------------------------------------------------------------------ ws */

  function connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}${q("/ws")}`);
    state.ws = ws;

    ws.onopen = () => {
      state.connected = true;
      state.backoff = 500;
      state.failures = 0;
      setConn(true);
      send({ t: "hello" });
    };

    ws.onclose = () => {
      state.connected = false;
      setConn(false);
      state.failures++;
      // A cookie that stopped being valid — expired, or the crew words were
      // rotated — looks exactly like a network blip from here, except it never
      // recovers. After a few straight failures, ask the server which it is.
      if (state.failures >= 3) { checkSession(); state.failures = 0; }
      setTimeout(connect, state.backoff);
      state.backoff = Math.min(state.backoff * 2, 15000);
    };

    ws.onerror = () => ws.close();
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      handle(m);
    };
  }

  function send(obj) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(obj));
  }

  function setConn(on) {
    const dot = $("#conn");
    if (dot) {
      dot.classList.toggle("on", on);
      dot.title = on ? "live" : "reconnecting…";
    }
  }

  function handle(m) {
    switch (m.t) {
      case "sync":
        state.blocks.clear();
        for (const b of m.blocks) state.blocks.set(b.id, b);
        renderAll();
        break;

      case "block":
        // Never overwrite the block under your own cursor. On blur we
        // reconcile — see finishEdit().
        if (state.editingId === m.id) { state.held.set(m.id, m); return; }
        // The wire calls it `by`; the row calls it `updated_by`. Map it, or the
        // margin note keeps showing whoever touched the block two edits ago.
        state.blocks.set(m.id, {
          ...(state.blocks.get(m.id) || {}),
          ...m,
          html: m.html,
          updated_by: m.by,
        });
        renderSection(m.section, m.id);
        break;

      case "gone":
        if (state.blocks.has(m.id)) {
          const sec = state.blocks.get(m.id).section;
          state.blocks.delete(m.id);
          renderSection(sec);
        }
        break;

      case "moved": {
        const b = state.blocks.get(m.id);
        if (!b) return;
        const from = b.section;
        b.section = m.section; b.ord = m.ord;
        renderSection(from);
        if (from !== m.section) renderSection(m.section);
        break;
      }

      case "reject":
        showConflict(m.id, m.html, m.rev);
        break;

      case "presence": {
        const others = m.here.filter((n) => n !== state.me);
        const el = $("#presence");
        if (el) el.textContent = others.length ? `with ${others.join(", ")}` : "on your own";
        break;
      }
    }
  }

  /* -------------------------------------------------------------- render */

  function sectionBlocks(section) {
    return [...state.blocks.values()]
      .filter((b) => b.section === section)
      .sort((a, b) => a.ord - b.ord);
  }

  function blockEl(b) {
    const el = document.createElement("div");
    el.className = "blk";
    el.dataset.id = b.id;
    el.dataset.rev = b.rev;

    const body = document.createElement("div");
    body.className = "blk-body";
    body.innerHTML = b.html;
    el.appendChild(body);

    const by = document.createElement("span");
    by.className = "by" + (b.updated_by === "claude" ? " ai" : "");
    by.textContent = b.updated_by ? (b.updated_by === "claude" ? "Claude" : b.updated_by) : "";
    el.appendChild(by);

    return el;
  }

  function renderAll() {
    for (const host of $$(".blocks")) renderSection(host.dataset.section);
  }

  function renderSection(section, flashId) {
    const host = $(`.blocks[data-section="${section}"]`);
    if (!host) return;

    const rows = sectionBlocks(section);
    host.textContent = "";

    // Rebuild the original side-by-side card layout by wrapping consecutive
    // grid2 blocks. They are separate blocks so two people can edit them at
    // once; they still need to look like one row.
    let run = null;
    for (const b of rows) {
      const el = blockEl(b);
      if (b.layout === "grid2") {
        if (!run) { run = document.createElement("div"); run.className = "grid2"; host.appendChild(run); }
        run.appendChild(el);
      } else {
        run = null;
        host.appendChild(el);
      }
      if (b.id === flashId) {
        el.classList.add("landed");
        setTimeout(() => el.classList.remove("landed"), 1700);
      }
    }
  }

  /* ------------------------------------------------------- direct editing */

  document.addEventListener("click", (e) => {
    if (e.target.closest("a, #chat, #blockmenu, #commentbox, #statusbar, .toast, summary, .secbar")) return;
    const blk = e.target.closest(".blk");
    if (!blk) { finishEdit(); return; }
    if (blk.dataset.id !== state.editingId) {
      finishEdit();
      beginEdit(blk);
    }
  });

  function beginEdit(blk) {
    const body = $(".blk-body", blk);
    if (!body) return;
    state.editingId = blk.dataset.id;
    blk.classList.add("editing");
    body.contentEditable = "true";
    body.spellcheck = false;
    body.focus();
    body.addEventListener("input", onInput);
  }

  function onInput() {
    clearTimeout(state.saveTimer);
    // Flush 2s after typing stops. Blur-only loses a sentence when a phone
    // browser is backgrounded mid-thought, which will happen at an airport.
    state.saveTimer = setTimeout(saveCurrent, 2000);
  }

  function saveCurrent() {
    const id = state.editingId;
    if (!id) return;
    const blk = $(`.blk[data-id="${id}"]`);
    const body = blk && $(".blk-body", blk);
    if (!body) return;

    const html = body.innerHTML.trim();
    const known = state.blocks.get(id);
    if (!known || html === known.html) return;

    send({ t: "edit", id, html, baseRev: known.rev });
  }

  function finishEdit() {
    const id = state.editingId;
    if (!id) return;
    clearTimeout(state.saveTimer);

    const blk = $(`.blk[data-id="${id}"]`);
    const body = blk && $(".blk-body", blk);
    state.editingId = null;

    if (body) {
      body.removeEventListener("input", onInput);
      body.contentEditable = "false";
      blk?.classList.remove("editing");

      const mine = body.innerHTML.trim();
      const known = state.blocks.get(id);
      const incoming = state.held.get(id);
      state.held.delete(id);

      if (incoming && mine !== known?.html) {
        // Both of you changed the same block. Show both; throw away neither.
        showConflict(id, incoming.html, incoming.rev, mine);
        return;
      }
      if (incoming) {
        state.blocks.set(id, { ...known, ...incoming });
        renderSection(incoming.section, id);
        return;
      }
      if (known && mine !== known.html) send({ t: "edit", id, html: mine, baseRev: known.rev });
    }
  }

  // Save on the ways a phone actually leaves a page.
  document.addEventListener("visibilitychange", () => { if (document.hidden) { saveCurrent(); finishEdit(); } });
  window.addEventListener("pagehide", () => { saveCurrent(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { saveCurrent(); finishEdit(); closeComment(); }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { saveCurrent(); finishEdit(); }
  });

  /* Paste is where a shared document gets wrecked — everything here arrives
     from a confirmation email or an Airbnb page. Keep the words, drop the
     fonts and background colours. */
  document.addEventListener("paste", (e) => {
    if (!state.editingId) return;
    e.preventDefault();
    const html = e.clipboardData.getData("text/html");
    const text = e.clipboardData.getData("text/plain");
    if (html && !e.shiftKey) {
      const tmp = document.createElement("div");
      tmp.innerHTML = html;
      tmp.querySelectorAll("*").forEach((n) => {
        if (/^(SCRIPT|STYLE|IFRAME|LINK|META)$/.test(n.tagName)) { n.remove(); return; }
        [...n.attributes].forEach((a) => {
          if (!["href", "colspan", "rowspan"].includes(a.name.toLowerCase())) n.removeAttribute(a.name);
        });
      });
      document.execCommand("insertHTML", false, tmp.innerHTML);
    } else {
      document.execCommand("insertText", false, text);
    }
  });

  /* --------------------------------------------------------- hover handles */

  const menu = $("#blockmenu");

  /** Place a fixed-position popover against a block, kept fully on screen. */
  function placeAt(el, rect, { below = false, gap = 4 } = {}) {
    el.hidden = false;
    const w = el.offsetWidth, h = el.offsetHeight;
    // Some embedded/headless contexts report a 0x0 window; clamping against
    // that pins everything to the top-left corner. Fall back to the document.
    const vw = innerWidth  || document.documentElement.clientWidth  || 1024;
    const vh = innerHeight || document.documentElement.clientHeight || 768;
    const left = below ? rect.left : rect.right - w - gap;
    const top  = below ? rect.bottom + gap : rect.top - gap;
    el.style.left = `${Math.max(8, Math.min(left, vw - w - 8))}px`;
    el.style.top  = `${Math.max(8, Math.min(top,  vh - h - 8))}px`;
  }

  document.addEventListener("mouseover", (e) => {
    const blk = e.target.closest(".blk");
    if (!blk) return;
    if (state.menuFor === blk) return;
    state.menuFor = blk;
    placeAt(menu, blk.getBoundingClientRect());
  });

  addEventListener("scroll", () => {
    if (!menu.hidden) { menu.hidden = true; state.menuFor = null; }
  }, { passive: true });

  document.addEventListener("mouseout", (e) => {
    if (e.relatedTarget?.closest("#blockmenu, .blk")) return;
    menu.hidden = true;
    state.menuFor = null;
  });

  // Touch: hover doesn't exist. Long-press opens the same handles.
  let pressTimer = null;
  document.addEventListener("touchstart", (e) => {
    const blk = e.target.closest(".blk");
    if (!blk) return;
    pressTimer = setTimeout(() => {
      state.menuFor = blk;
      placeAt(menu, blk.getBoundingClientRect());
    }, 400);
  }, { passive: true });
  document.addEventListener("touchend", () => clearTimeout(pressTimer));
  document.addEventListener("touchmove", () => clearTimeout(pressTimer), { passive: true });

  menu.addEventListener("click", (e) => {
    const act = e.target.closest("button")?.dataset.act;
    const blk = state.menuFor;
    if (!act || !blk) return;
    const id = blk.dataset.id;
    const b = state.blocks.get(id);
    if (!b) return;

    if (act === "comment") openComment(blk);
    if (act === "add")     send({ t: "insert", section: b.section, afterId: id, html: "<p>…</p>" });
    if (act === "del")     doDelete(b);
    if (act === "up" || act === "down") {
      const rows = sectionBlocks(b.section);
      const i = rows.findIndex((r) => r.id === id);
      if (act === "up" && i > 0) {
        send({ t: "move", id, section: b.section, afterId: i >= 2 ? rows[i - 2].id : null });
      }
      if (act === "down" && i < rows.length - 1) {
        send({ t: "move", id, section: b.section, afterId: rows[i + 1].id });
      }
    }
  });

  function doDelete(b) {
    send({ t: "delete", id: b.id });
    toast(`Deleted a block in ${b.section.replace(/-/g, " ")}.`, "Undo", () => {
      fetch(q("/api/undo"), { method: "POST" });
    });
  }

  /* ----------------------------------------------------- comment → Claude */

  const cbox = $("#commentbox");
  let commentTarget = null;

  function openComment(blk) {
    commentTarget = blk.dataset.id;
    placeAt(cbox, blk.getBoundingClientRect(), { below: true, gap: 8 });
    $("#cb-target").textContent = commentTarget;
    $("#cb-text").value = "";
    $("#cb-text").focus();
    menu.hidden = true;
  }

  function closeComment() { cbox.hidden = true; commentTarget = null; }
  $("#cb-cancel").addEventListener("click", closeComment);

  $("#cb-send").addEventListener("click", async () => {
    const text = $("#cb-text").value.trim();
    if (!text || !commentTarget) return;
    const id = commentTarget;
    const blk = $(`.blk[data-id="${id}"]`);
    closeComment();
    blk?.classList.add("busy");

    logMsg("me", `💬 on <code>${id}</code>: ${escapeHtml(text)}`);
    openChat();

    try {
      const res = await fetch(q("/api/comment"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instruction: text, blockId: id }),
      });
      if (res.status === 401) { logMsg("err", "You're signed out — reload and enter your word."); checkSession(); return; }
      const data = await res.json();
      logMsg("bot", escapeHtml(data.reply), data.applied);
      updateBudget(data.budgetLeft);
    } catch (err) {
      logMsg("err", `Couldn't reach Claude: ${escapeHtml(String(err))}`);
    } finally {
      blk?.classList.remove("busy");
    }
  });

  /* --------------------------------------------------------------- chat */

  const chat = $("#chat");
  const chatLog = $("#log");

  function openChat()  { chat.hidden = false; $("#chatToggle").hidden = true; }
  function closeChat() { chat.hidden = true;  $("#chatToggle").hidden = false; }

  $("#chatToggle").addEventListener("click", () => { openChat(); $("#chatInput").focus(); });
  $("#chatClose").addEventListener("click", closeChat);

  $("#chatForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = $("#chatInput");
    const text = input.value.trim();
    if (!text) return;

    input.value = "";
    $("#chatSend").disabled = true;
    logMsg("me", escapeHtml(text));
    const thinking = logMsg("bot", "<em class='dim'>thinking…</em>");

    try {
      const res = await fetch(q("/api/chat"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instruction: text }),
      });
      thinking.remove();
      if (res.status === 401) { logMsg("err", "You're signed out — reload and enter your word."); checkSession(); return; }
      const data = await res.json();
      logMsg("bot", escapeHtml(data.reply), data.applied);
      updateBudget(data.budgetLeft);
    } catch (err) {
      thinking.remove();
      logMsg("err", `Couldn't reach Claude: ${escapeHtml(String(err))}`);
    } finally {
      $("#chatSend").disabled = false;
      input.focus();
    }
  });

  $("#chatInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#chatForm").requestSubmit(); }
  });

  function logMsg(kind, html, applied) {
    const el = document.createElement("div");
    el.className = `msg ${kind}`;
    const who = kind === "bot" ? `<span class="who">Claude</span>` : kind === "err" ? `<span class="who">Failed</span>` : "";
    const note = applied ? `<div class="applied">${applied} block${applied === 1 ? "" : "s"} changed</div>` : "";
    el.innerHTML = `${who}<p>${html}</p>${note}`;
    chatLog.appendChild(el);
    chatLog.scrollTop = chatLog.scrollHeight;
    return el;
  }

  function updateBudget(left) {
    if (typeof left !== "number") return;
    $("#budget").textContent = `${left} AI edits left today`;
  }

  /* ------------------------------------------------------------ conflict */

  function showConflict(id, theirs, theirRev, mine) {
    const blk = $(`.blk[data-id="${id}"]`);
    if (!blk) return;
    const known = state.blocks.get(id) || {};
    const yours = mine ?? $(".blk-body", blk)?.innerHTML ?? "";

    const box = document.createElement("div");
    box.className = "conflict";
    box.innerHTML = `
      <h5>Someone else changed this while you were typing</h5>
      <div class="side"><div class="lbl">Yours</div>${yours}</div>
      <div class="side"><div class="lbl">Theirs</div>${theirs}</div>
      <div class="actions">
        <button data-keep="mine">Keep mine</button>
        <button data-keep="theirs">Keep theirs</button>
      </div>`;
    blk.after(box);

    box.addEventListener("click", (e) => {
      const keep = e.target.dataset.keep;
      if (!keep) return;
      if (keep === "mine") {
        send({ t: "edit", id, html: yours, baseRev: theirRev });
        state.blocks.set(id, { ...known, html: yours, rev: theirRev });
      } else {
        state.blocks.set(id, { ...known, html: theirs, rev: theirRev });
      }
      box.remove();
      renderSection(known.section, id);
    });
  }

  /* -------------------------------------------------------------- toasts */

  const toasts = document.createElement("div");
  toasts.id = "toasts";
  document.body.appendChild(toasts);

  function toast(text, actionLabel, onAction, ms = 6000) {
    const el = document.createElement("div");
    el.className = "toast";
    el.innerHTML = `<span>${escapeHtml(text)}</span>`;
    if (actionLabel) {
      const b = document.createElement("button");
      b.textContent = actionLabel;
      b.onclick = () => { onAction(); el.remove(); };
      el.appendChild(b);
    }
    toasts.appendChild(el);
    setTimeout(() => el.remove(), ms);
  }

  $("#undoBtn").addEventListener("click", async () => {
    const res = await fetch(q("/api/undo"), { method: "POST" });
    const data = await res.json();
    toast(data.ok ? `Undid the last ${data.kind}.` : data.message);
  });

  /* --------------------------------------------------------------- util */

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  connect();
})();
