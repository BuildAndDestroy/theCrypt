// Operator console: inbox (polled), replies, access-key management.
"use strict";

(function () {
  const api = window.CryptApi;
  const el = api.el;
  const LIST_POLL_MS = 5000;
  const CHAT_POLL_MS = 3000;

  let conversations = [];
  let current = null;          // selected conversation object
  let lastId = null;
  const seen = new Set();

  const messagesEl = document.getElementById("messages");
  const sendBody = document.getElementById("sendBody");

  // ------------------------------------------------------------- inbox
  function renderConversations() {
    const list = document.getElementById("convList");
    list.replaceChildren();
    if (!conversations.length) {
      list.appendChild(el("div", { class: "p-3 text-secondary small" }, "No customers yet. Issue a key, then share it."));
    }
    let totalUnread = 0;
    for (const c of conversations) {
      totalUnread += c.unread;
      const preview = c.lastMessage
        ? (c.lastMessage.from === "operator" ? "You: " : "") + c.lastMessage.body
        : "No messages yet";
      const item = el("button", {
        type: "button",
        class: "list-group-item list-group-item-action conv-item" + (current && current.customerId === c.customerId ? " active" : "") + (c.active ? "" : " conv-disabled"),
      },
        el("div", { class: "d-flex justify-content-between align-items-center gap-2" },
          el("span", { class: "conv-email text-truncate" }, c.email),
          c.unread ? el("span", { class: "badge bg-danger" }, String(c.unread)) : null,
        ),
        el("div", { class: "small text-secondary text-truncate" }, c.keyLabel ? "[" + c.keyLabel + "] " : "", preview),
      );
      item.addEventListener("click", () => selectConversation(c.customerId));
      list.appendChild(item);
    }
    const badge = document.getElementById("unreadTotal");
    badge.textContent = String(totalUnread);
    badge.classList.toggle("d-none", totalUnread === 0);
    document.title = (totalUnread ? "(" + totalUnread + ") " : "") + "The Crypt — Operator";
  }

  async function refreshConversations() {
    const data = await api.get("/admin/conversations");
    conversations = data.conversations;
    if (current) {
      const updated = conversations.find((c) => c.customerId === current.customerId);
      if (updated) { current = updated; renderHeader(); }
    }
    renderConversations();
  }

  function renderHeader() {
    document.getElementById("convTitle").textContent = current.email;
    document.getElementById("convTitle").classList.remove("text-secondary");
    const details = [];
    if (current.phone) details.push("☎ " + current.phone);
    if (current.keyLabel) details.push("key: " + current.keyLabel + " (…" + current.keyHint + ")");
    details.push("joined " + api.fmtTime(current.registeredAt));
    if (!current.active) details.push("DISABLED");
    document.getElementById("convDetails").textContent = details.join(" · ");
    const btn = document.getElementById("toggleActiveBtn");
    btn.textContent = current.active ? "Disable account" : "Re-enable account";
    btn.className = "btn btn-sm ms-auto " + (current.active ? "btn-outline-danger" : "btn-outline-success");
  }

  function renderMessage(m) {
    if (seen.has(m.id)) return;
    seen.add(m.id);
    const mine = m.from === "operator";
    messagesEl.appendChild(
      el("div", { class: "chat-msg " + (mine ? "chat-msg-out" : "chat-msg-in") },
        el("div", { class: "chat-bubble" }, m.body),
        el("div", { class: "chat-meta" }, (mine ? "You" : current.email) + " · " + api.fmtTime(m.createdAt)),
      ),
    );
    lastId = m.id;
  }

  async function fetchMessages() {
    if (!current) return;
    const id = current.customerId;
    const q = lastId ? "?after=" + encodeURIComponent(lastId) : "";
    const { messages } = await api.get("/admin/conversations/" + id + "/messages" + q);
    if (!current || current.customerId !== id) return; // switched meanwhile
    const stick = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
    messages.forEach(renderMessage);
    if (messages.length && stick) messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  const listPoll = api.poller(refreshConversations, LIST_POLL_MS);
  const chatPoll = api.poller(fetchMessages, CHAT_POLL_MS);

  async function selectConversation(customerId) {
    current = conversations.find((c) => c.customerId === customerId);
    if (!current) return;
    lastId = null;
    seen.clear();
    messagesEl.replaceChildren();
    renderHeader();
    api.show("toggleActiveBtn", true);
    sendBody.disabled = false;
    document.getElementById("sendBtn").disabled = false;
    api.setError("sendError", "");
    renderConversations();
    chatPoll.start();
    // The unread badge clears once the open conversation has been fetched.
    setTimeout(() => listPoll.now(), 500);
    sendBody.focus();
  }

  document.getElementById("sendForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const body = sendBody.value.trim();
    if (!body || !current) return;
    api.setError("sendError", "");
    sendBody.disabled = true;
    try {
      const { message } = await api.post("/admin/conversations/" + current.customerId + "/messages", { body });
      sendBody.value = "";
      await fetchMessages().catch(() => {});
      renderMessage(message);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      listPoll.now();
    } catch (e) {
      api.setError("sendError", e.message);
    } finally {
      sendBody.disabled = false;
      sendBody.focus();
    }
  });
  sendBody.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      document.getElementById("sendForm").requestSubmit();
    }
  });

  document.getElementById("toggleActiveBtn").addEventListener("click", async () => {
    if (!current) return;
    const enable = !current.active;
    if (!enable && !confirm("Disable " + current.email + "? They are signed out and cannot sign back in.")) return;
    try {
      await api.post("/admin/conversations/" + current.customerId + "/active", { active: enable });
      await refreshConversations();
    } catch (e) {
      api.setError("sendError", e.message);
    }
  });

  // -------------------------------------------------------------- keys
  function keyStatus(k) {
    if (k.revokedAt) return el("span", { class: "badge bg-secondary" }, "revoked");
    if (k.redeemedAt) return el("span", { class: "badge bg-success" }, "redeemed by " + k.redeemedBy);
    return el("span", { class: "badge bg-warning text-dark" }, "unused");
  }

  async function loadKeys() {
    const { keys } = await api.get("/admin/keys");
    const tbody = document.getElementById("keyTable");
    tbody.replaceChildren();
    if (!keys.length) {
      tbody.appendChild(el("tr", null, el("td", { colspan: "5", class: "text-secondary" }, "No keys yet.")));
    }
    for (const k of keys) {
      let action = null;
      if (!k.revokedAt && !k.redeemedAt) {
        action = el("button", { type: "button", class: "btn btn-sm btn-outline-danger" }, "Revoke");
        action.addEventListener("click", async () => {
          if (!confirm("Revoke key …" + k.hint + "? It can no longer be used to register.")) return;
          try { await api.post("/admin/keys/" + k.id + "/revoke"); await loadKeys(); }
          catch (e) { api.setError("keyError", e.message); }
        });
      }
      tbody.appendChild(el("tr", null,
        el("td", { class: "font-monospace" }, "…" + k.hint),
        el("td", null, k.label || "—"),
        el("td", { class: "text-secondary small" }, api.fmtTime(k.createdAt)),
        el("td", null, keyStatus(k)),
        el("td", { class: "text-end" }, action),
      ));
    }
  }

  document.getElementById("keyForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    api.setError("keyError", "");
    try {
      const { key } = await api.post("/admin/keys", { label: f.label.value || undefined });
      document.getElementById("newKeyValue").textContent = key;
      api.show("newKey", true);
      f.reset();
      await loadKeys();
    } catch (e) {
      api.setError("keyError", e.message);
    }
  });

  document.getElementById("copyKeyBtn").addEventListener("click", async () => {
    const code = document.getElementById("newKeyValue");
    try {
      await navigator.clipboard.writeText(code.textContent);
    } catch (e) {
      const range = document.createRange();
      range.selectNodeContents(code);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
  });

  document.getElementById("keysTab").addEventListener("shown.bs.tab", () => {
    loadKeys().catch((e) => api.setError("keyError", e.message));
  });

  // -------------------------------------------------------- countdowns
  const pad = (x) => String(x).padStart(2, "0");

  // ISO -> "2026-12-09 00:00" (UTC) for display.
  function utcText(iso) {
    const d = new Date(iso);
    return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate()) +
      " " + pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes());
  }
  // ISO -> "2026-12-09T00:00" for <input type="datetime-local"> (value is UTC wall-clock).
  const utcInput = (iso) => utcText(iso).replace(" ", "T");

  function remaining(iso, now) {
    const left = new Date(iso).getTime() - now;
    if (left <= 0) return null;
    const d = Math.floor(left / 86400000);
    const h = Math.floor((left % 86400000) / 3600000);
    const m = Math.floor((left % 3600000) / 60000);
    return d ? d + "d " + h + "h" : h ? h + "h " + m + "m" : m + "m";
  }

  let maxUploadBytes = 64 * 1024 * 1024;

  function fmtBytes(n) {
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
    return (n / 1048576).toFixed(1) + " MB";
  }

  async function saveDeadline(b, iso) {
    api.setError("timerError", "");
    try {
      await api.post("/admin/biopsies/" + b.n, { deadline: iso });
      await loadTimers();
    } catch (e) {
      api.setError("timerError", e.message);
    }
  }

  // Raw-body .zip upload (not JSON), so a dedicated fetch rather than CryptApi.
  async function uploadArchive(n, file) {
    if (!/\.zip$/i.test(file.name)) { api.setError("timerError", "Choose a .zip file."); return; }
    if (file.size > maxUploadBytes) { api.setError("timerError", "That file is over the " + fmtBytes(maxUploadBytes) + " limit."); return; }
    api.setError("timerError", "");
    let res, data = {};
    try {
      res = await fetch("/api/admin/biopsies/" + n + "/archive", {
        method: "PUT",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "X-Crypt-Request": "1", "Content-Type": "application/zip", "X-Filename": file.name },
        body: file,
      });
      try { data = await res.json(); } catch (e) { /* empty */ }
    } catch (e) {
      api.setError("timerError", "Upload failed (connection).");
      return;
    }
    if (res.status === 401) { location.reload(); return; }
    if (!res.ok) { api.setError("timerError", data.error || "Upload failed (" + res.status + ")."); return; }
    await loadTimers();
  }

  function archiveCell(b) {
    const cell = el("td", null);
    if (b.upload) {
      cell.appendChild(el("div", { class: "small" },
        el("span", { class: "badge bg-info text-dark me-1" }, "custom"),
        b.upload.filename + " · " + fmtBytes(b.upload.size)));
    } else {
      cell.appendChild(el("div", { class: "small text-secondary" },
        "default · " + (b.defaultArchive || "—")));
    }
    const file = el("input", { type: "file", accept: ".zip,application/zip", class: "form-control form-control-sm mt-1 timer-file" });
    const up = el("button", { type: "button", class: "btn btn-sm btn-outline-primary mt-1" }, b.upload ? "Replace" : "Upload");
    up.addEventListener("click", () => {
      if (!file.files || !file.files[0]) { api.setError("timerError", "Pick a .zip file first."); return; }
      up.disabled = true;
      uploadArchive(b.n, file.files[0]).finally(() => { up.disabled = false; });
    });
    let remove = null;
    if (b.upload) {
      remove = el("button", { type: "button", class: "btn btn-sm btn-outline-secondary mt-1 ms-1" }, "Remove");
      remove.addEventListener("click", async () => {
        if (!confirm("Remove the custom archive for " + b.title + "? The generated default is restored.")) return;
        api.setError("timerError", "");
        try { await api.del("/admin/biopsies/" + b.n + "/archive"); await loadTimers(); }
        catch (e) { api.setError("timerError", e.message); }
      });
    }
    cell.appendChild(el("div", { class: "d-flex align-items-center gap-1 flex-wrap" }, file, up, remove));
    return cell;
  }

  function timerRow(b, now) {
    const input = el("input", {
      type: "datetime-local", class: "form-control form-control-sm timer-input",
      value: utcInput(b.deadline), step: "60",
    });
    const setBtn = el("button", { type: "button", class: "btn btn-sm btn-primary" }, "Set");
    setBtn.addEventListener("click", () => {
      if (!input.value) { api.setError("timerError", "Pick a date and time first."); return; }
      // The datetime-local value is a UTC wall-clock string; append Z.
      saveDeadline(b, input.value.length === 16 ? input.value + ":00Z" : input.value + "Z");
    });

    let resetBtn = null;
    if (b.overridden) {
      resetBtn = el("button", {
        type: "button", class: "btn btn-sm btn-outline-secondary",
        title: "Back to the generated default (" + utcText(b.defaultDeadline) + " UTC)",
      }, "Reset");
      resetBtn.addEventListener("click", async () => {
        if (!confirm("Reset " + b.title + " to its generated deadline (" + utcText(b.defaultDeadline) + " UTC)?")) return;
        api.setError("timerError", "");
        try { await api.post("/admin/biopsies/" + b.n + "/reset"); await loadTimers(); }
        catch (e) { api.setError("timerError", e.message); }
      });
    }

    const left = remaining(b.deadline, now);
    const status = b.released
      ? el("span", { class: "badge bg-danger" }, "published")
      : el("span", { class: "badge bg-warning text-dark" }, left + " left");
    const deadlineCell = el("td", { class: "font-monospace small" }, utcText(b.deadline));
    if (b.overridden) deadlineCell.appendChild(el("div", { class: "text-secondary" }, "default " + utcText(b.defaultDeadline)));

    return el("tr", null,
      el("td", { class: "text-secondary" }, String(b.n)),
      el("td", null, el("a", { href: "/biopsy-" + b.n + "/", target: "_blank", rel: "noopener" }, b.title)),
      deadlineCell,
      el("td", null, status),
      el("td", null, el("div", { class: "d-flex gap-2 align-items-center" }, input, setBtn)),
      archiveCell(b),
      el("td", { class: "text-end" }, resetBtn),
    );
  }

  async function loadTimers() {
    const data = await api.get("/admin/biopsies");
    if (typeof data.maxUploadBytes === "number") maxUploadBytes = data.maxUploadBytes;
    const now = new Date(data.now).getTime();
    const tbody = document.getElementById("timerTable");
    tbody.replaceChildren();
    if (!data.biopsies.length) {
      tbody.appendChild(el("tr", null, el("td", { colspan: "7", class: "text-secondary" },
        "No biopsies found — the API could not read /biopsies.json from the site.")));
      return;
    }
    for (const b of data.biopsies) tbody.appendChild(timerRow(b, now));
  }

  document.getElementById("timersTab").addEventListener("shown.bs.tab", () => {
    loadTimers().catch((e) => api.setError("timerError", e.message));
  });

  // ------------------------------------------------------------- auth
  function enterConsole(user) {
    if (!user.permissions.includes("chats:all")) {
      location.href = "/chat/";
      return;
    }
    api.show("loadingView", false);
    api.show("loginView", false);
    api.show("consoleView", true);
    api.show("adminNav", true);
    api.show("logoutBtn", true);
    api.show("keysTab", user.permissions.includes("keys:manage"));
    api.show("timersTab", user.permissions.includes("biopsies:manage"));
    const who = document.getElementById("whoami");
    who.textContent = user.email;
    who.classList.remove("d-none");
    listPoll.start();
  }

  document.getElementById("loginForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const btn = f.querySelector("button[type=submit]");
    api.setError("loginError", "");
    btn.disabled = true;
    try {
      const body = { email: f.email.value, password: f.password.value };
      if (f.totp.value) body.totp = f.totp.value;
      const { user } = await api.post("/auth/login", body);
      f.reset();
      enterConsole(user);
    } catch (e) {
      api.setError("loginError", e.message);
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById("logoutBtn").addEventListener("click", async () => {
    listPoll.stop();
    chatPoll.stop();
    await api.post("/auth/logout").catch(() => {});
    location.reload();
  });

  api.get("/auth/me")
    .then(({ user }) => enterConsole(user))
    .catch(() => {
      api.show("loadingView", false);
      api.show("loginView", true);
    });
})();
