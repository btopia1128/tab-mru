const DEFAULT_STALE_DAYS = 7; // background.js と合わせる
const DEFAULT_DEDUPE = true; // background.js と合わせる
const DEFAULT_LOCAL_MARK = true; // background.js と合わせる
const DEFAULT_LOCAL_EMOJI = '🟢'; // background.js と合わせる

const input = document.getElementById('staleDays');
const status = document.getElementById('status');
let statusTimer;

chrome.storage.sync.get('staleDays').then(({ staleDays = DEFAULT_STALE_DAYS }) => {
  input.value = staleDays;
});

const closeBtn = document.getElementById('closeStale');
const closeResult = document.getElementById('closeResult');
let closeResultTimer;

closeBtn.addEventListener('click', async () => {
  closeBtn.disabled = true;
  try {
    const { count } = await chrome.runtime.sendMessage({ type: 'close-stale-tabs' });
    closeResult.textContent =
      count > 0 ? `${count} 件のタブを閉じました` : '💤 が付いたタブはありません';
  } catch {
    closeResult.textContent = '実行に失敗しました';
  } finally {
    closeBtn.disabled = false;
  }
  clearTimeout(closeResultTimer);
  closeResultTimer = setTimeout(() => (closeResult.textContent = ''), 4000);
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

const dedupe = document.getElementById('dedupeTitles');
const dedupeStatus = document.getElementById('dedupeStatus');
let dedupeStatusTimer;

chrome.storage.sync.get('dedupeTitles').then(({ dedupeTitles = DEFAULT_DEDUPE }) => {
  dedupe.checked = dedupeTitles;
});

dedupe.addEventListener('change', async () => {
  await chrome.storage.sync.set({ dedupeTitles: dedupe.checked });
  dedupeStatus.classList.add('show');
  clearTimeout(dedupeStatusTimer);
  dedupeStatusTimer = setTimeout(() => dedupeStatus.classList.remove('show'), 1500);
});

// ── ローカル環境タブの目印 ──
const localMark = document.getElementById('localMark');
const localEmoji = document.getElementById('localEmoji');
const localHosts = document.getElementById('localHosts');
const localStatus = document.getElementById('localStatus');
let localStatusTimer;

function showLocalSaved() {
  localStatus.classList.add('show');
  clearTimeout(localStatusTimer);
  localStatusTimer = setTimeout(() => localStatus.classList.remove('show'), 1500);
}

chrome.storage.sync
  .get(['localMark', 'localEmoji', 'localHosts'])
  .then(({ localMark: on = DEFAULT_LOCAL_MARK, localEmoji: emoji = DEFAULT_LOCAL_EMOJI, localHosts: hosts = '' }) => {
    localMark.checked = on;
    localEmoji.value = emoji;
    localHosts.value = hosts;
  });

localMark.addEventListener('change', async () => {
  await chrome.storage.sync.set({ localMark: localMark.checked });
  showLocalSaved();
});

localEmoji.addEventListener('change', async () => {
  const emoji = localEmoji.value.trim() || DEFAULT_LOCAL_EMOJI;
  localEmoji.value = emoji;
  await chrome.storage.sync.set({ localEmoji: emoji });
  showLocalSaved();
});

localHosts.addEventListener('change', async () => {
  const hosts = localHosts.value
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');
  localHosts.value = hosts;
  await chrome.storage.sync.set({ localHosts: hosts });
  showLocalSaved();
});
