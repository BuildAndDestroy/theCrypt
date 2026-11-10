// Shared helpers for the chat + admin pages. Same-origin only: every request
// goes to /api on the onion itself (CSP default-src 'self' enforces this).
"use strict";

window.CryptApi = (function () {
  async function request(method, path, body) {
    const opts = {
      method,
      credentials: "same-origin",
      headers: { "X-Crypt-Request": "1" },
      cache: "no-store",
    };
    if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch("/api" + path, opts);
    } catch (e) {
      const err = new Error("Connection lost. Retrying…");
      err.status = 0;
      throw err;
    }
    let data = {};
    try { data = await res.json(); } catch (e) { /* empty body */ }
    if (!res.ok) {
      const err = new Error(data.error || "Request failed (" + res.status + ")");
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  // Build DOM nodes without ever parsing strings as HTML (no XSS from chat
  // content): el("div", {class: "x"}, "text", childNode, ...)
  function el(tag, attrs) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        if (attrs[k] === undefined || attrs[k] === null || attrs[k] === false) continue;
        if (k === "class") node.className = attrs[k];
        else if (k === "dataset") Object.assign(node.dataset, attrs[k]);
        else node.setAttribute(k, attrs[k]);
      }
    }
    for (let i = 2; i < arguments.length; i++) {
      const c = arguments[i];
      if (c === undefined || c === null) continue;
      node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return node;
  }

  function fmtTime(iso) {
    const d = new Date(iso);
    return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  function show(id, visible) {
    document.getElementById(id).classList.toggle("d-none", !visible);
  }

  function setError(id, msg) {
    const n = document.getElementById(id);
    n.textContent = msg || "";
    n.classList.toggle("d-none", !msg);
  }

  // Poll on an interval, backing off while the tab is hidden or on errors.
  function poller(fn, baseMs) {
    let timer = null, delay = baseMs, stopped = false;
    async function tick() {
      if (stopped) return;
      try {
        await fn();
        delay = document.hidden ? baseMs * 4 : baseMs;
      } catch (e) {
        if (e.status === 401) { stopped = true; location.reload(); return; }
        delay = Math.min(delay * 2, 30000);
      }
      timer = setTimeout(tick, delay);
    }
    return {
      start() { stopped = false; clearTimeout(timer); tick(); },
      stop() { stopped = true; clearTimeout(timer); },
      now() { clearTimeout(timer); tick(); },
    };
  }

  return {
    get: (p) => request("GET", p),
    post: (p, b) => request("POST", p, b === undefined ? {} : b),
    el, fmtTime, show, setError, poller,
  };
})();
