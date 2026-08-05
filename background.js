// Tab MRU Toggle
// 縦タブ（＝Chromeのタブ順序そのもの）を「元の順」と「最後に触った順（MRU）」で切り替える。
// MRUモード中はタブグループを解体し、全タブを並列に扱う。OFFで順序もグループも復元する。

const NO_GROUP = -1;
const BADGE_COLOR = '#2f5fd0';

// enable/disable の一括移動中に onActivated が連鎖しないようにするフラグ。
// service worker が再起動すると false に戻るが、一括移動は数百msで終わるため実害はない。
let busy = false;

async function getState() {
  const { enabled = false, snapshots = {}, newTabs = {} } =
    await chrome.storage.session.get(['enabled', 'snapshots', 'newTabs']);
  return { enabled, snapshots, newTabs };
}

// ── モード表示（アイコン色・バッジ・ツールチップ） ──────────
function drawIcon(enabled) {
  const images = {};
  for (const size of [16, 32]) {
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext('2d');
    const u = size / 16;
    ctx.strokeStyle = enabled ? '#2f5fd0' : '#7a828f';
    ctx.lineWidth = 2 * u;
    ctx.lineCap = 'round';
    // 右側: タブリストを表す3本のバー
    for (let i = 0; i < 3; i++) {
      const y = (4.5 + i * 3.5) * u;
      ctx.beginPath();
      ctx.moveTo(7 * u, y);
      ctx.lineTo(14 * u, y);
      ctx.stroke();
    }
    // 左側: 「最新が上へ」を表す上向き矢印
    ctx.beginPath();
    ctx.moveTo(3 * u, 12 * u);
    ctx.lineTo(3 * u, 5 * u);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(1.2 * u, 7 * u);
    ctx.lineTo(3 * u, 4.5 * u);
    ctx.lineTo(4.8 * u, 7 * u);
    ctx.stroke();
    images[size] = ctx.getImageData(0, 0, size, size);
  }
  return images;
}

function updateModeUi(enabled) {
  chrome.action.setIcon({ imageData: drawIcon(enabled) });
  chrome.action.setBadgeText({ text: enabled ? 'MRU' : '' });
  chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
  chrome.action.setTitle({
    title: enabled
      ? 'MRUモード中 — クリックで元の順に復元'
      : '元の順 — クリックでMRU順（最後に触った順）に切り替え',
  });
}

// SW再起動時にもアイコン表示を実状態に合わせる
getState().then((s) => updateModeUi(s.enabled));

async function pinnedCount(windowId) {
  return (await chrome.tabs.query({ windowId, pinned: true })).length;
}

// ユーザーがタブストリップをクリック/ドラッグしている間、Chromeは
// "Tabs cannot be edited right now (user may be dragging a tab)" で
// tabs.move / ungroup を一時的に拒否する。解除されるまでリトライする。
async function withRetry(fn, tries = 25, delayMs = 100) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const msg = String(e?.message ?? e);
      if (!/cannot be edited/i.test(msg) || i >= tries - 1) throw e;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

chrome.action.onClicked.addListener(toggle);
chrome.commands.onCommand.addListener((cmd) => {
  if (cmd === 'toggle-mru') toggle();
});

async function toggle() {
  if (busy) return;
  busy = true;
  try {
    const { enabled } = await getState();
    if (enabled) {
      await disableMru();
    } else {
      await enableMru();
    }
  } finally {
    busy = false;
  }
}

// ── MRUモード ON ──────────────────────────────────────────
// 1. 各ウィンドウの並び順とグループ構成をスナップショット
// 2. enabled フラグを先に保存（初期並べ替えが失敗してもモード自体は有効にする）
// 3. グループを全解体（全タブを並列に）→ lastAccessed 降順で初期MRU状態を作る
async function enableMru() {
  const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
  const snapshots = {};

  for (const win of windows) {
    const tabs = await chrome.tabs.query({ windowId: win.id, pinned: false });
    if (!tabs.length) continue;

    const groups = {};
    for (const g of await chrome.tabGroups.query({ windowId: win.id })) {
      groups[g.id] = { title: g.title, color: g.color, collapsed: g.collapsed };
    }
    snapshots[win.id] = {
      order: tabs.map((t) => ({ tabId: t.id, groupId: t.groupId })),
      groups,
    };
  }

  await chrome.storage.session.set({ enabled: true, snapshots, newTabs: {} });
  updateModeUi(true);
  console.log('[tab-mru] enabled. snapshot windows:', Object.keys(snapshots));

  for (const winIdStr of Object.keys(snapshots)) {
    const windowId = Number(winIdStr);
    try {
      const tabs = await chrome.tabs.query({ windowId, pinned: false });
      const groupedIds = tabs.filter((t) => t.groupId !== NO_GROUP).map((t) => t.id);
      if (groupedIds.length) await withRetry(() => chrome.tabs.ungroup(groupedIds));

      const sorted = [...tabs].sort(
        (a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0)
      );
      const top = await pinnedCount(windowId);
      await withRetry(() =>
        chrome.tabs.move(
          sorted.map((t) => t.id),
          { index: top }
        )
      );
      console.log('[tab-mru] initial sort done for window', windowId);
    } catch (e) {
      console.warn('[tab-mru] initial sort failed for window', windowId, e);
    }
  }
}

// ── MRUモード OFF（復元） ─────────────────────────────────
// スナップショットの順に並べ直し、グループを作り直す。
// モード中に開いた新規タブは opener の直後、なければ末尾へ。
async function disableMru() {
  const { snapshots, newTabs } = await getState();

  for (const [winIdStr, snap] of Object.entries(snapshots)) {
    const windowId = Number(winIdStr);
    let current;
    try {
      current = await chrome.tabs.query({ windowId, pinned: false });
    } catch {
      continue; // ウィンドウごと閉じられていた
    }
    if (!current.length) continue;
    const alive = new Set(current.map((t) => t.id));

    const order = [];
    const pending = Object.entries(newTabs)
      .map(([id, v]) => ({ tabId: Number(id), openerTabId: v.openerTabId }))
      .filter((t) => alive.has(t.tabId));

    const insertChildrenOf = (openerId) => {
      for (const nt of pending) {
        if (nt.openerTabId !== openerId || order.includes(nt.tabId)) continue;
        order.push(nt.tabId);
        insertChildrenOf(nt.tabId); // 新規タブから開かれた新規タブも連ねる
      }
    };

    for (const { tabId } of snap.order) {
      if (!alive.has(tabId)) continue;
      order.push(tabId);
      insertChildrenOf(tabId);
    }
    for (const nt of pending) {
      if (!order.includes(nt.tabId)) order.push(nt.tabId);
    }
    for (const t of current) {
      if (!order.includes(t.id)) order.push(t.id); // 他ウィンドウから移ってきた等
    }

    if (order.length) {
      const top = await pinnedCount(windowId);
      await withRetry(() => chrome.tabs.move(order, { index: top }));
    }

    // グループ復元。元の groupId は解体時に消滅しているため、新規グループとして
    // 作り直してタイトル・色・折りたたみ状態を書き戻す。
    const byGroup = new Map();
    for (const { tabId, groupId } of snap.order) {
      if (groupId === NO_GROUP || !alive.has(tabId)) continue;
      if (!byGroup.has(groupId)) byGroup.set(groupId, []);
      byGroup.get(groupId).push(tabId);
    }
    for (const [oldGroupId, tabIds] of byGroup) {
      const meta = snap.groups[oldGroupId];
      try {
        const newGroupId = await withRetry(() =>
          chrome.tabs.group({
            tabIds,
            createProperties: { windowId },
          })
        );
        if (meta) {
          await chrome.tabGroups.update(newGroupId, {
            title: meta.title,
            color: meta.color,
            collapsed: meta.collapsed, // アクティブタブを含むグループは折りたためず例外になる
          });
        }
      } catch {
        // collapsed 失敗などは順序復元より優先度が低いので握りつぶす
      }
    }
  }

  await chrome.storage.session.set({ enabled: false, snapshots: {}, newTabs: {} });
  updateModeUi(false);
}

// ── MRUモード中の挙動 ─────────────────────────────────────
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  if (busy) return;
  const { enabled } = await getState();
  if (!enabled) return;
  try {
    await withRetry(async () => {
      const tab = await chrome.tabs.get(tabId);
      // リトライ待ちの間に別タブへ移っていたら、新しい方のアクティブ化に譲る
      if (!tab.active || tab.pinned) return;
      if (tab.groupId !== NO_GROUP) await chrome.tabs.ungroup(tabId);
      const top = await pinnedCount(tab.windowId);
      if (tab.index !== top) {
        await chrome.tabs.move(tabId, { index: top });
        console.log('[tab-mru] moved tab', tabId, 'to top of window', tab.windowId);
      }
    });
  } catch (e) {
    console.warn('[tab-mru] onActivated failed for tab', tabId, e);
  }
});

chrome.tabs.onCreated.addListener(async (tab) => {
  const { enabled, newTabs } = await getState();
  if (!enabled) return;
  newTabs[tab.id] = { openerTabId: tab.openerTabId ?? null };
  await chrome.storage.session.set({ newTabs });
});

// ── 放置タブのマーク（💤） ─────────────────────────────────
// lastAccessed が STALE_MS 以上前のタブのタイトルに 💤 を付ける。
// タブストリップ自体を装飾するAPIはないため、content script で
// document.title を書き換える方式。chrome:// 等の保護ページと
// メモリセーバーで休止中（discarded）のタブには注入できない。
const STALE_PREFIX = '💤 ';
const DEFAULT_STALE_DAYS = 7; // options.js と合わせる
const STALE_ALARM = 'stale-check';

async function getStaleMs() {
  const { staleDays = DEFAULT_STALE_DAYS } = await chrome.storage.sync.get('staleDays');
  return staleDays * 24 * 60 * 60 * 1000;
}

chrome.runtime.onInstalled.addListener(initStaleCheck);
chrome.runtime.onStartup.addListener(initStaleCheck);

async function initStaleCheck() {
  // create し直すと周期タイマーがリセットされるので、無ければ作る
  if (!(await chrome.alarms.get(STALE_ALARM))) {
    chrome.alarms.create(STALE_ALARM, { periodInMinutes: 60 });
  }
  markStaleTabs();
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === STALE_ALARM) markStaleTabs();
});

// executeScript で注入される関数（ページ側で実行される）
function addStalePrefix(prefix) {
  if (!document.title.startsWith(prefix)) document.title = prefix + document.title;
}
function removeStalePrefix(prefix) {
  if (document.title.startsWith(prefix)) document.title = document.title.slice(prefix.length);
}

async function setStaleMark(tabId, stale) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: stale ? addStalePrefix : removeStalePrefix,
    args: [STALE_PREFIX],
  });
}

async function markStaleTabs() {
  const now = Date.now();
  const staleMs = await getStaleMs();
  let tabs;
  try {
    tabs = await chrome.tabs.query({});
  } catch {
    return;
  }
  for (const tab of tabs) {
    if (tab.active || tab.discarded) continue;
    if (!/^https?:/.test(tab.url ?? '')) continue;
    const stale = now - (tab.lastAccessed ?? now) >= staleMs;
    const marked = (tab.title ?? '').startsWith(STALE_PREFIX);
    if (stale === marked) continue;
    try {
      await setStaleMark(tab.id, stale);
    } catch {
      // 保護ページ・読み込み前・注入不可のタブはスキップ
    }
  }
}

// 閾値が変更されたら即座に付け直し（伸ばした場合の外しも markStaleTabs が行う）
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.staleDays) markStaleTabs();
});

// アクティブにした瞬間に 💤 を外す（lastAccessed も更新されるので再付与されない）
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    if ((tab.title ?? '').startsWith(STALE_PREFIX)) {
      await setStaleMark(tabId, false);
    }
  } catch {
    // タブが閉じられた等
  }
});
