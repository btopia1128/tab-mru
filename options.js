const DEFAULT_STALE_DAYS = 7; // background.js と合わせる

const input = document.getElementById('staleDays');
const status = document.getElementById('status');
let statusTimer;

chrome.storage.sync.get('staleDays').then(({ staleDays = DEFAULT_STALE_DAYS }) => {
  input.value = staleDays;
});

input.addEventListener('change', async () => {
  let days = Math.round(Number(input.value));
  if (!Number.isFinite(days)) days = DEFAULT_STALE_DAYS;
  days = Math.min(365, Math.max(1, days));
  input.value = days;
  await chrome.storage.sync.set({ staleDays: days });
  status.classList.add('show');
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => status.classList.remove('show'), 1500);
});
