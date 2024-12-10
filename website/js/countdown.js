// Countdown Timer Script
// Set the date and time for the countdown (editable)
const targetDate = new Date("12/31/2024 23:59:59").getTime();

function updateCountdown() {
    const now = new Date().getTime();
    const timeLeft = targetDate - now;

    if (timeLeft <= 0) {
        document.getElementById("countdown").innerText = "Time's up!";
        clearInterval(countdownInterval);
        return;
    }

    const days = Math.floor(timeLeft / (1000 * 60 * 60 * 24));
    const hours = Math.floor((timeLeft % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((timeLeft % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((timeLeft % (1000 * 60)) / 1000);

    document.getElementById("countdown").innerText = 
        `${days}d ${hours}h ${minutes}m ${seconds}s`;
}

// Update the countdown every second
const countdownInterval = setInterval(updateCountdown, 1000);
updateCountdown(); // Initial call to display immediately