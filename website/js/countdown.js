// Countdown Timer Script
// Each page sets its own deadline via a data-target attribute on the
// countdown element, e.g.:  <div id="countdown" data-target="2027-01-26T23:59:59">
// This one shared script then drives whatever date that page declares.

(function () {
    const el = document.getElementById("countdown");
    if (!el) return; // no countdown on this page

    const target = new Date(el.dataset.target).getTime();
    if (isNaN(target)) {
        el.innerText = "No date set";
        return;
    }

    function updateCountdown() {
        const timeLeft = target - Date.now();

        if (timeLeft <= 0) {
            el.innerText = "Time's up!";
            clearInterval(countdownInterval);
            return;
        }

        const days = Math.floor(timeLeft / (1000 * 60 * 60 * 24));
        const hours = Math.floor((timeLeft % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
        const minutes = Math.floor((timeLeft % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((timeLeft % (1000 * 60)) / 1000);

        el.innerText = `${days}d ${hours}h ${minutes}m ${seconds}s`;
    }

    const countdownInterval = setInterval(updateCountdown, 1000);
    updateCountdown(); // initial call to display immediately
})();
