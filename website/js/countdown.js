// Countdown timers for The Crypt.
//
// Every element with a data-countdown attribute (an ISO date, e.g.
// data-countdown="2027-01-26T23:59:59Z") counts down to it: the big timer on a
// biopsy page and the small one on each Death Row tile. One interval drives
// them all.
//
// Each biopsy tile / case-file timer section is a [data-biopsy="N"] container
// holding both states (.when-pending / .when-expired; CSS shows one). The page
// ships the generated default deadline; on load (and every few minutes) the
// live deadlines come from /api/public/biopsies, where the operator may have
// changed them. The server also decides "released", which is what unlocks the
// dump download (nginx enforces it; this only updates what the page shows).
// Without JS, or if the API is unreachable, the generated state stays.
//
// Also fills in the footer year (#year), so pages need no inline script.

(function () {
    var year = document.getElementById("year");
    if (year) year.textContent = new Date().getFullYear();

    var timers = [];
    var interval = null;
    var offset = 0;                 // server clock minus client clock (ms)
    var REFRESH_MS = 120000;
    var refreshing = false;

    function containerOf(el) {
        return el.closest("[data-biopsy]");
    }

    function setExpired(el, expired) {
        el.classList.toggle("expired", expired);
        var box = containerOf(el);
        if (box) box.classList.toggle("expired", expired);
        if (expired) el.textContent = "Time's up!";
    }

    function format(left) {
        var d = Math.floor(left / 86400000);
        var h = Math.floor((left % 86400000) / 3600000);
        var m = Math.floor((left % 3600000) / 60000);
        var s = Math.floor((left % 60000) / 1000);
        return d + "d " + h + "h " + m + "m " + s + "s";
    }

    // (Re)build the timer list from the data-countdown attributes.
    function collect() {
        timers = [];
        document.querySelectorAll("[data-countdown]").forEach(function (el) {
            var target = new Date(el.dataset.countdown).getTime();
            if (isNaN(target)) {
                el.textContent = "No date set";
                return;
            }
            timers.push({ el: el, target: target });
        });
    }

    // initial: true on the first tick after (re)collecting, when a timer that
    // is already at zero must not trigger another refresh (that would loop).
    function tick(initial) {
        var now = Date.now() + offset;
        var ranOut = false;
        timers = timers.filter(function (t) {
            var left = t.target - now;
            if (left <= 0) {
                setExpired(t.el, true);
                ranOut = true;
                return false;
            }
            setExpired(t.el, false);
            t.el.textContent = format(left);
            return true;
        });
        if (!timers.length) {
            clearInterval(interval);
            interval = null;
        }
        // A timer just hit zero: ask the server (its clock and its deadline
        // decide whether the dump is out).
        if (ranOut && initial !== true) refresh();
    }

    function start() {
        collect();
        if (interval) clearInterval(interval);
        interval = null;
        tick(true);
        if (timers.length && !interval) interval = setInterval(tick, 1000);
    }

    function apply(data) {
        var serverNow = new Date(data.now).getTime();
        if (!isNaN(serverNow)) offset = serverNow - Date.now();
        (data.biopsies || []).forEach(function (b) {
            document.querySelectorAll('[data-biopsy="' + Number(b.n) + '"]').forEach(function (box) {
                box.querySelectorAll("[data-countdown]").forEach(function (el) {
                    el.dataset.countdown = b.deadline;
                });
                box.classList.toggle("expired", !!b.released);
            });
        });
        start();
    }

    function refresh() {
        if (refreshing || !window.fetch || !document.querySelector("[data-biopsy]")) return;
        refreshing = true;
        fetch("/api/public/biopsies", { credentials: "omit", cache: "no-store" })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (data) { if (data) apply(data); })
            .catch(function () { /* keep the generated state */ })
            .then(function () { refreshing = false; });
    }

    start();
    refresh();
    setInterval(refresh, REFRESH_MS);
})();
