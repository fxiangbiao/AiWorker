const FOCUS_SECONDS = 25 * 60;
const BREAK_SECONDS = 5 * 60;

const timeEl = document.getElementById("time");
const phaseEl = document.getElementById("phase");
const startBtn = document.getElementById("startBtn");
const resetBtn = document.getElementById("resetBtn");
const ringEl = document.getElementById("ring");
const roundsEl = document.getElementById("rounds");

let remaining = FOCUS_SECONDS;
let phase = "focus"; // focus | break
let timer = null;
let completed = 0;

function render() {
  const m = String(Math.floor(remaining / 60)).padStart(2, "0");
  const s = String(remaining % 60).padStart(2, "0");
  timeEl.textContent = `${m}:${s}`;
  phaseEl.textContent = phase === "focus" ? "专注" : "休息";
  ringEl.classList.toggle("break", phase === "break");
}

function tick() {
  remaining--;
  render();
  if (remaining <= 0) {
    if (phase === "focus") {
      completed++;
      roundsEl.textContent = `已完成 ${completed} 个番茄`;
      phase = "break";
      remaining = BREAK_SECONDS;
    } else {
      phase = "focus";
      remaining = FOCUS_SECONDS;
    }
    render();
  }
}

startBtn.addEventListener("click", () => {
  if (timer) {
    clearInterval(timer);
    timer = null;
    startBtn.textContent = "继续";
    return;
  }
  timer = setInterval(tick, 1000);
  startBtn.textContent = "暂停";
});

resetBtn.addEventListener("click", () => {
  if (timer) clearInterval(timer);
  timer = null;
  phase = "focus";
  remaining = FOCUS_SECONDS;
  startBtn.textContent = "开始";
  render();
});

render();
