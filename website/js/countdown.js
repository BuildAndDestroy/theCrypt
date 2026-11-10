// Countdown timers for The Crypt.
//
// Every element with a data-countdown attribute (an ISO date, e.g.
// data-countdown="2027-01-26T23:59:59Z") counts down to it: the big timer on a
// biopsy page and the small one on each Death Row tile. One interval drives
// them all. When a deadline passes the element reads "Time's up!" and gets the
// .expired class (its tile too).
//
// Also fills in the footer year (#year), so pages need no inline script.

(function () {
    var year = document.getElementById("year");
    if (year) year.textContent = new Date().getFullYear();

    var timers = [];
    document.querySelectorAll("[data-countdown]").forEach(function (el) {
        var target = new Date(el.dataset.countdown).getTime();
        if (isNaN(target)) {
            el.textContent = "No date set";
            return;
        }
        timers.push({ el: el, target: target });
    });
    if (!timers.length) return;

    function expire(el) {
        el.textContent = "Time's up!";
        el.classList.add("expired");
        var tile = el.closest(".biopsy-tile");
        if (tile) tile.classList.add("expired");
    }

    function tick() {
        var now = Date.now();
        timers = timers.filter(function (t) {
            var left = t.target - now;
            if (left <= 0) {
                expire(t.el);
                return false;
            }
            var d = Math.floor(left / 86400000);
            var h = Math.floor((left % 86400000) / 3600000);
            var m = Math.floor((left % 3600000) / 60000);
            var s = Math.floor((left % 60000) / 1000);
            t.el.textContent = d + "d " + h + "h " + m + "m " + s + "s";
            return true;
        });
        if (!timers.length) clearInterval(interval);
    }

    var interval = setInterval(tick, 1000);
    tick();
})();
