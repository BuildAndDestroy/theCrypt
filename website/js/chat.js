// Customer chat: register with a key or sign in, then poll for messages.
"use strict";

(function () {
  const api = window.CryptApi;
  const POLL_MS = 4000;
  let lastId = null;
  const seen = new Set();

  const messagesEl = document.getElementById("messages");

  function renderMessage(m) {
    if (seen.has(m.id)) return;
    seen.add(m.id);
    document.getElementById("emptyState")?.remove();
    const mine = m.from === "customer";
    messagesEl.appendChild(
      api.el("div", { class: "chat-msg " + (mine ? "chat-msg-out" : "chat-msg-in") },
        api.el("div", { class: "chat-bubble" }, m.body),
        api.el("div", { class: "chat-meta" }, (mine ? "You" : "Operator") + " · " + api.fmtTime(m.createdAt)),
      ),
    );
    lastId = m.id;
  }

  function nearBottom() {
    return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
  }

  async function fetchNew() {
    const q = lastId ? "?after=" + encodeURIComponent(lastId) : "";
    try {
      const { messages } = await api.get("/chat/messages" + q);
      const stick = nearBottom();
      messages.forEach(renderMessage);
      if (messages.length && stick) messagesEl.scrollTop = messagesEl.scrollHeight;
      document.getElementById("connState").textContent = "connected";
    } catch (e) {
      document.getElementById("connState").textContent = e.status === 0 ? "reconnecting…" : "";
      throw e;
    }
  }

  const poll = api.poller(fetchNew, POLL_MS);

  function enterChat(user) {
    api.show("loadingView", false);
    api.show("authView", false);
    api.show("chatView", true);
    const who = document.getElementById("whoami");
    who.textContent = user.email;
    who.classList.remove("d-none");
    api.show("logoutBtn", true);
    poll.start();
    document.getElementById("sendBody").focus();
  }

  function showAuth() {
    api.show("loadingView", false);
    api.show("chatView", false);
    api.show("authView", true);
  }

  // ---- register
  document.getElementById("registerForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const btn = f.querySelector("button[type=submit]");
    api.setError("registerError", "");
    btn.disabled = true;
    try {
      const { user } = await api.post("/auth/register", {
        key: f.key.value,
        email: f.email.value,
        phone: f.phone.value || undefined,
        password: f.password.value,
      });
      f.reset();
      enterChat(user);
    } catch (e) {
      api.setError("registerError", e.message);
    } finally {
      btn.disabled = false;
    }
  });

  // ---- sign in
  document.getElementById("loginForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const btn = f.querySelector("button[type=submit]");
    api.setError("loginError", "");
    btn.disabled = true;
    try {
      const { user } = await api.post("/auth/login", { email: f.email.value, password: f.password.value });
      if (user.role !== "customer") {
        location.href = "/admin/";
        return;
      }
      f.reset();
      enterChat(user);
    } catch (e) {
      api.setError("loginError", e.message);
    } finally {
      btn.disabled = false;
    }
  });

  // ---- send
  const sendForm = document.getElementById("sendForm");
  const sendBody = document.getElementById("sendBody");
  sendForm.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const body = sendBody.value.trim();
    if (!body) return;
    api.setError("sendError", "");
    sendBody.disabled = true;
    try {
      const { message } = await api.post("/chat/messages", { body });
      sendBody.value = "";
      // Pull anything that arrived before ours first, so ordering holds.
      await fetchNew().catch(() => {});
      renderMessage(message);
      messagesEl.scrollTop = messagesEl.scrollHeight;
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
      sendForm.requestSubmit();
    }
  });

  document.getElementById("logoutBtn").addEventListener("click", async () => {
    poll.stop();
    await api.post("/auth/logout").catch(() => {});
    location.reload();
  });

  // ---- boot: resume an existing session if there is one
  api.get("/auth/me")
    .then(({ user }) => (user.role === "customer" ? enterChat(user) : (location.href = "/admin/")))
    .catch(showAuth);
})();
