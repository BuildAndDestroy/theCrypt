// Operator console: inbox (polled), replies, access keys, countdowns, users.
// What is shown follows the signed-in user's permissions; a read-only account
// sees every tab but no controls that change anything (the API enforces the
// same rules — this only keeps the UI honest).
"use strict";

(function () {
  const api = window.CryptApi;
  const el = api.el;
  const LIST_POLL_MS = 5000;
  const CHAT_POLL_MS = 3000;

  let perms = new Set();
  const may = (p) => perms.has(p);

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
    api.show("toggleActiveBtn", may("users:manage"));
    const canReply = may("chats:all");
    sendBody.disabled = !canReply;
    document.getElementById("sendBtn").disabled = !canReply;
    api.setError("sendError", "");
    renderConversations();
    chatPoll.start();
    // The unread badge clears once the open conversation has been fetched.
    setTimeout(() => listPoll.now(), 500);
    if (canReply) sendBody.focus();
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
      if (!k.revokedAt && !k.redeemedAt && may("keys:manage")) {
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
    const manage = may("biopsies:manage");
    if (b.upload) {
      cell.appendChild(el("div", { class: "small" },
        el("span", { class: "badge bg-info text-dark me-1" }, "custom"),
        b.upload.filename + " · " + fmtBytes(b.upload.size)));
    } else {
      cell.appendChild(el("div", { class: "small text-secondary" },
        "default · " + (b.defaultArchive || "—")));
    }
    if (!manage) return cell;
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
    const manage = may("biopsies:manage");
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
    if (b.overridden && manage) {
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
      el("td", null, manage ? el("div", { class: "d-flex gap-2 align-items-center" }, input, setBtn) : el("span", { class: "text-secondary small" }, "—")),
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

  // ------------------------------------------------------------- users
  const ROLE_LABEL = { admin: "Admin", readonly: "Read only", customer: "Customer" };

  function showTotp(email, totp) {
    if (!totp) return;
    document.getElementById("newTotpWho").textContent = email;
    document.getElementById("newTotpSecret").textContent = totp.secret;
    document.getElementById("newTotpUri").textContent = totp.uri;
    api.show("newTotp", true);
    api.show("userFormCard", true);
    document.getElementById("newTotp").scrollIntoView({ block: "nearest" });
  }

  async function userAction(fn) {
    api.setError("userError", "");
    try { await fn(); await loadUsers(); }
    catch (e) { api.setError("userError", e.message); }
  }

  function userRow(u) {
    const account = el("td", null,
      el("div", null, u.email,
        u.self ? el("span", { class: "badge bg-secondary ms-2" }, "you") : null,
        u.builtin ? el("span", { class: "badge bg-dark border border-secondary ms-2", title: "Predefined from the chat-admin Secret; can't be changed here" }, "predefined") : null),
      u.phone || u.keyHint
        ? el("div", { class: "small text-secondary" },
            [u.phone ? "☎ " + u.phone : "", u.keyHint ? "key …" + u.keyHint + (u.keyLabel ? " [" + u.keyLabel + "]" : "") : ""].filter(Boolean).join(" · "))
        : null);

    const locked = u.builtin || u.self || !may("users:manage");

    let roleCell;
    if (locked) {
      roleCell = el("td", null, ROLE_LABEL[u.role] || u.role);
    } else {
      const sel = el("select", { class: "form-select form-select-sm user-role" });
      for (const r of ["admin", "readonly", "customer"]) {
        sel.appendChild(el("option", { value: r, selected: r === u.role ? "selected" : null }, ROLE_LABEL[r]));
      }
      sel.addEventListener("change", () => {
        const to = sel.value;
        if (!confirm("Change " + u.email + " from " + ROLE_LABEL[u.role] + " to " + ROLE_LABEL[to] + "? They are signed out.")) {
          sel.value = u.role;
          return;
        }
        userAction(async () => {
          const { totp } = await api.post("/admin/users/" + u.id + "/role", { role: to });
          showTotp(u.email, totp);
        });
      });
      roleCell = el("td", null, sel);
    }

    const status = !u.active
      ? el("span", { class: "badge bg-danger" }, "disabled")
      : u.lockedUntil
        ? el("span", { class: "badge bg-warning text-dark", title: "Too many failed sign-ins" }, "locked until " + api.fmtTime(u.lockedUntil))
        : el("span", { class: "badge bg-success" }, "active");

    let twoFactor;
    if (u.role === "customer") twoFactor = el("span", { class: "text-secondary small" }, "—");
    else if (u.builtin) twoFactor = el("span", { class: "small text-secondary" }, "from Secret");
    else twoFactor = u.twoFactor ? el("span", { class: "badge bg-success" }, "on") : el("span", { class: "badge bg-danger" }, "missing");

    const actions = el("div", { class: "d-flex gap-1 justify-content-end flex-wrap" });
    if (!locked) {
      const toggle = el("button", { type: "button", class: "btn btn-sm " + (u.active ? "btn-outline-warning" : "btn-outline-success") },
        u.active ? "Disable" : "Enable");
      toggle.addEventListener("click", () => {
        if (u.active && !confirm("Disable " + u.email + "? They are signed out and cannot sign back in.")) return;
        userAction(() => api.post("/admin/users/" + u.id + "/active", { active: !u.active }));
      });
      actions.appendChild(toggle);

      const pw = el("button", { type: "button", class: "btn btn-sm btn-outline-secondary", title: "Set a new password for this account" }, "Password");
      pw.addEventListener("click", () => openPasswordReset(u));
      actions.appendChild(pw);

      if (u.role !== "customer") {
        const reset = el("button", { type: "button", class: "btn btn-sm btn-outline-secondary", title: "Issue a new authenticator secret (the old one stops working)" }, "Reset 2FA");
        reset.addEventListener("click", () => {
          if (!confirm("Issue a new authenticator secret for " + u.email + "? Their current one stops working and they are signed out.")) return;
          userAction(async () => {
            const { totp } = await api.post("/admin/users/" + u.id + "/totp");
            showTotp(u.email, totp);
          });
        });
        actions.appendChild(reset);
      }

      const del = el("button", { type: "button", class: "btn btn-sm btn-outline-danger" }, "Delete");
      del.addEventListener("click", () => {
        const what = u.role === "customer" ? " This also deletes their entire conversation." : "";
        if (!confirm("Permanently delete " + u.email + "?" + what + " This cannot be undone.")) return;
        userAction(async () => {
          await api.del("/admin/users/" + u.id);
          if (current && current.customerId === u.id) location.reload();
        });
      });
      actions.appendChild(del);
    }

    return el("tr", { class: u.active ? null : "text-secondary" },
      account,
      roleCell,
      el("td", null, status),
      el("td", null, twoFactor),
      el("td", { class: "text-secondary small" }, u.lastLoginAt ? api.fmtTime(u.lastLoginAt) : "never"),
      el("td", { class: "text-secondary small" }, api.fmtTime(u.createdAt)),
      el("td", { class: "text-end" }, actions),
    );
  }

  // Reset-password dialog. The admin types a password or generates one, then
  // hands it over; the API signs the account out everywhere.
  const pwModalEl = document.getElementById("pwModal");
  const pwInput = document.getElementById("pwNew");
  let pwModal = null;
  let pwTarget = null;

  function randomPassword() {
    // 20 chars from a 54-symbol alphabet without look-alikes: ~115 bits.
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
    const out = [];
    const buf = new Uint32Array(1);
    while (out.length < 20) {
      crypto.getRandomValues(buf);
      const limit = Math.floor(0x100000000 / alphabet.length) * alphabet.length;
      if (buf[0] < limit) out.push(alphabet[buf[0] % alphabet.length]); // no modulo bias
    }
    return out.join("");
  }

  function openPasswordReset(u) {
    pwTarget = u;
    document.getElementById("pwWho").textContent = u.email;
    pwInput.value = "";
    api.setError("pwError", "");
    pwModal = pwModal || new bootstrap.Modal(pwModalEl);
    pwModal.show();
  }
  pwModalEl.addEventListener("shown.bs.modal", () => pwInput.focus());
  // Don't leave a password sitting in the DOM after the dialog closes.
  pwModalEl.addEventListener("hidden.bs.modal", () => { pwInput.value = ""; pwTarget = null; });
  document.getElementById("pwGenerate").addEventListener("click", () => { pwInput.value = randomPassword(); pwInput.select(); });
  document.getElementById("pwCopy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(pwInput.value); } catch (e) { pwInput.select(); }
  });

  document.getElementById("pwForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (!pwTarget) return;
    const password = pwInput.value;
    if (password.length < 12) { api.setError("pwError", "Password must be at least 12 characters."); return; }
    const btn = ev.target.querySelector("button[type=submit]");
    btn.disabled = true;
    api.setError("pwError", "");
    try {
      await api.post("/admin/users/" + pwTarget.id + "/password", { password });
      pwModal.hide();
      await loadUsers();
    } catch (e) {
      api.setError("pwError", e.message);
    } finally {
      btn.disabled = false;
    }
  });

  async function loadUsers() {
    const { users } = await api.get("/admin/users");
    const tbody = document.getElementById("userTable");
    tbody.replaceChildren();
    for (const u of users) tbody.appendChild(userRow(u));
  }

  document.getElementById("userForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const btn = f.querySelector("button[type=submit]");
    api.setError("userError", "");
    api.show("newTotp", false);
    btn.disabled = true;
    try {
      const body = { email: f.email.value, password: f.password.value, role: f.role.value };
      if (f.phone.value.trim()) body.phone = f.phone.value;
      const { user, totp } = await api.post("/admin/users", body);
      f.reset();
      showTotp(user.email, totp);
      await loadUsers();
    } catch (e) {
      api.setError("userError", e.message);
    } finally {
      btn.disabled = false;
    }
  });

  async function copyText(id) {
    const node = document.getElementById(id);
    try { await navigator.clipboard.writeText(node.textContent); }
    catch (e) {
      const range = document.createRange();
      range.selectNodeContents(node);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }
  document.getElementById("copyTotpBtn").addEventListener("click", () => copyText("newTotpSecret"));
  document.getElementById("copyTotpUriBtn").addEventListener("click", () => copyText("newTotpUri"));

  document.getElementById("usersTab").addEventListener("shown.bs.tab", () => {
    loadUsers().catch((e) => api.setError("userError", e.message));
  });
  // Don't leave a TOTP secret on screen once the operator moves on.
  document.getElementById("usersTab").addEventListener("hidden.bs.tab", () => api.show("newTotp", false));

  // ------------------------------------------------------------- auth
  function enterConsole(user) {
    perms = new Set(user.permissions);
    if (!may("chats:read")) {
      location.href = "/chat/";
      return;
    }
    api.show("loadingView", false);
    api.show("loginView", false);
    api.show("consoleView", true);
    api.show("adminNav", true);
    api.show("logoutBtn", true);
    api.show("keysTab", may("keys:read"));
    api.show("keyFormCard", may("keys:manage"));
    api.show("timersTab", may("biopsies:read"));
    api.show("usersTab", may("users:read"));
    api.show("userFormCard", may("users:manage"));
    api.show("sendFooter", may("chats:all"));
    api.show("roBadge", !may("chats:all"));
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
