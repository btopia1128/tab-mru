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

// ── 💤タブの一括クローズ ──────────────────────────────────
// アイコン右クリックメニューと設定ページのボタンから実行。
// 「💤が実際に付いているタブ」だけを対象にする（＝ユーザーが見ている通りに閉じる）。
// 保護ページや休止中タブはそもそもマークされないので巻き込まれない。
// ピン留めタブはタイトルが見えず💤に気付けないため、安全側で除外する。
const CLOSE_STALE_MENU = 'close-stale-tabs';

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: CLOSE_STALE_MENU,
      title: '💤 が付いたタブをすべて閉じる',
      contexts: ['action'],
    });
  });
});

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === CLOSE_STALE_MENU) closeStaleTabs();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== CLOSE_STALE_MENU) return;
  closeStaleTabs().then((count) => sendResponse({ count }));
  return true; // 非同期で sendResponse する
});

async function closeStaleTabs() {
  const tabs = await chrome.tabs.query({});
  const targets = tabs.filter(
    (t) => !t.active && !t.pinned && (t.title ?? '').startsWith(STALE_PREFIX)
  );
  if (targets.length) {
    await chrome.tabs.remove(targets.map((t) => t.id));
  }
  flashBadge(String(targets.length));
  console.log('[tab-mru] closed stale tabs:', targets.length);
  return targets.length;
}

// 閉じた件数をバッジに一時表示し、その後モード表示に戻す
let badgeTimer;
function flashBadge(text) {
  clearTimeout(badgeTimer);
  chrome.action.setBadgeText({ text });
  badgeTimer = setTimeout(async () => {
    const { enabled } = await getState();
    chrome.action.setBadgeText({ text: enabled ? 'MRU' : '' });
  }, 2000);
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

// ── ローカル環境タブの目印（🟢） ──────────────────────────
// localhost / 127.0.0.1 / 192.168.x.x / *.local / *.test などローカル環境の URL を
// 開いているタブのタイトル先頭に 🟢 を付け、本番環境のタブと見分けられるようにする。
// 判定は URL のホスト名のみ（ページ内容は読まない）。組み込みの判定に加えて、
// 設定ページで追加のホスト名パターン（*.dev.example.com 等）を登録できる。
// 実際のタイトル書き換えは [ラベル] と同じ refreshTitles() の中でまとめて行う。
const DEFAULT_LOCAL_MARK = true; // options.js と合わせる
const DEFAULT_LOCAL_EMOJI = '🟢'; // options.js と合わせる
const LEGACY_LOCAL_PREFIXES = ['🏠 ']; // 以前の既定値。再読み込みで記録が消えていても剥がせるように
const BUILTIN_LOCAL_SUFFIXES = ['.localhost', '.local', '.test', '.internal', '.home.arpa'];

async function getLocalSettings() {
  const {
    localMark = DEFAULT_LOCAL_MARK,
    localEmoji = DEFAULT_LOCAL_EMOJI,
    localHosts = '',
  } = await chrome.storage.sync.get(['localMark', 'localEmoji', 'localHosts']);
  const emoji = String(localEmoji).trim() || DEFAULT_LOCAL_EMOJI;
  const patterns = String(localHosts)
    .split('\n')
    .map((l) => l.trim().toLowerCase())
    .filter((l) => l && !l.startsWith('#'));
  return { enabled: localMark, prefix: emoji + ' ', patterns };
}

function isPrivateIpv4(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return (
    a === 127 || // loopback
    a === 0 || // 0.0.0.0
    a === 10 || // private
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 168) || // private
    (a === 169 && b === 254) // link-local
  );
}

// URL.hostname は IPv6 だと "[::1]" のように括弧付きになる
function isPrivateIpv6(host) {
  if (!host.startsWith('[')) return false;
  const ip = host.slice(1, -1).toLowerCase();
  return ip === '::1' || ip === '::' || /^f[cd]/.test(ip) || /^fe[89ab]/.test(ip);
}

// pattern: "example.com"（完全一致）/ "*.example.com"（サブドメイン含む）/ "host:port"
function hostMatches(u, pattern) {
  const target = pattern.includes(':') && !pattern.startsWith('[') ? u.host : u.hostname;
  const host = target.toLowerCase();
  if (pattern.startsWith('*.')) {
    const base = pattern.slice(2);
    return host === base || host.endsWith('.' + base);
  }
  return host === pattern;
}

function isLocalUrl(url, patterns) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (!/^https?:$/.test(u.protocol)) return false;
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || BUILTIN_LOCAL_SUFFIXES.some((s) => h.endsWith(s))) return true;
  if (isPrivateIpv4(h) || isPrivateIpv6(h)) return true;
  return patterns.some((p) => hostMatches(u, p));
}

// ── 同名タブの区別ラベル（[ラベル]） ────────────────────────
// 同じウィンドウ内に同じタイトルのタブが複数あるとき、URL の「最初に違う要素」
// （ホスト名 → パス各段 → クエリ → ハッシュ の順）をタイトル先頭に [ラベル] として付ける。
// URL まで完全に同じなら [#1] [#2] … の連番。💤 と同じ document.title 書き換え方式で、
// 🟢 や 💤 と併用時は「💤 🟢 [ラベル] タイトル」の順になる。
// 自分が付けたラベル・🟢 は storage.local に記録し、それだけを厳密に剥がす
// （ページ本来のタイトルが "[PATCH] …" 等で始まっていても壊さない）。
const DEFAULT_DEDUPE = true; // options.js と合わせる
const LABEL_MAX = 24;

function labelPrefix(label) {
  return `[${label}] `;
}

async function getDedupeEnabled() {
  const { dedupeTitles = DEFAULT_DEDUPE } = await chrome.storage.sync.get('dedupeTitles');
  return dedupeTitles;
}

function decodePart(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// URL を比較用の要素列に分解する
function urlParts(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return [];
  }
  const parts = [u.hostname.replace(/^www\./, '')];
  for (const seg of u.pathname.split('/')) if (seg) parts.push(decodePart(seg));
  for (const [k, v] of u.searchParams) parts.push(v ? `${k}=${v}` : k);
  if (u.hash.length > 1) parts.push(decodePart(u.hash.slice(1)));
  return parts;
}

function shorten(part) {
  if (/^[0-9a-f-]{20,}$/i.test(part)) return part.slice(0, 8); // UUID 等の ID は先頭8文字
  return part.length > LABEL_MAX ? part.slice(0, LABEL_MAX - 1) + '…' : part;
}

// items: [{ id, parts }] — parts[0..depth-1] が全て共通なグループにラベルを割り当てる
function assignLabels(items, depth, out) {
  const byKey = new Map();
  for (const it of items) {
    const key = it.parts[depth] ?? '';
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(it);
  }
  for (const [key, sub] of byKey) {
    if (sub.length === 1) {
      if (byKey.size === 1) return; // ありえないが保険
      const it = sub[0];
      // 短い URL 側（例: github.com と github.com/foo の前者）は最後の要素で表す
      out.set(it.id, shorten(key || it.parts[it.parts.length - 1] || ''));
    } else if (key === '') {
      // ここまで全要素が同じで、かつ全員 URL が尽きた＝完全に同じ URL
      sub.forEach((it, i) => out.set(it.id, `#${i + 1}`));
    } else {
      assignLabels(sub, depth + 1, out);
    }
  }
}

// ── タイトル接頭辞の一括更新（🟢 と [ラベル]） ─────────────────
// executeScript で注入される関数（ページ側で実行される）。
// 💤 はそのまま残し、古い 🟢 / [ラベル] を剥がして新しいものに付け替える。
function applyTitlePrefixes(stalePrefix, oldLocal, newLocal, oldLabel, newLabel) {
  let t = document.title;
  let stale = '';
  if (t.startsWith(stalePrefix)) {
    stale = stalePrefix;
    t = t.slice(stalePrefix.length);
  }
  if (oldLocal && t.startsWith(oldLocal)) t = t.slice(oldLocal.length);
  if (oldLabel && t.startsWith(oldLabel)) t = t.slice(oldLabel.length);
  document.title = stale + newLocal + newLabel + t;
}

function isInjectable(tab) {
  return /^https?:/.test(tab.url ?? '') && !tab.discarded;
}

// タイトルを常時書き戻してくるページと無限に張り合わないための抑制
// （1分に6回まで。超えたら次のイベント／定期チェックまで放置）
const applyLog = new Map();
function isThrottled(tabId) {
  const now = Date.now();
  const recent = (applyLog.get(tabId) ?? []).filter((t) => now - t < 60_000);
  applyLog.set(tabId, recent);
  return recent.length >= 6;
}
function recordApply(tabId) {
  (applyLog.get(tabId) ?? applyLog.set(tabId, []).get(tabId)).push(Date.now());
}

async function refreshTitles() {
  const dedupeEnabled = await getDedupeEnabled();
  const local = await getLocalSettings();
  // 記録は storage.local に置く（storage.session だと拡張の再読み込みで消え、
  // 付けた接頭辞を剥がせなくなって "🟢 🏠 タイトル" のように二重になる）
  const { dupLabels = {}, localMarks = {} } = await chrome.storage.local.get([
    'dupLabels',
    'localMarks',
  ]);
  let tabs;
  try {
    tabs = await chrome.tabs.query({});
  } catch {
    return;
  }

  // 現在のタイトルから 💤・自分が付けた 🟢（旧既定値の 🏠 含む）・自分が付けたラベルを剥がして「素のタイトル」を得る
  const info = [];
  for (const tab of tabs) {
    let t = tab.title ?? '';
    if (t.startsWith(STALE_PREFIX)) t = t.slice(STALE_PREFIX.length);
    // 記録した接頭辞を優先しつつ、記録が無くても（再読み込み直後など）
    // 現在の目印と過去の既定値なら自分が付けたものとみなして剥がす
    // 続く限り剥がす（"🟢 🏠 タイトル" のように二重になっていても1回で直す）
    let appliedLocal = '';
    const localCands = [localMarks[tab.id] ?? '', local.prefix, ...LEGACY_LOCAL_PREFIXES];
    for (let hit = true; hit; ) {
      hit = false;
      for (const cand of localCands) {
        if (cand && t.startsWith(cand)) {
          appliedLocal += cand;
          t = t.slice(cand.length);
          hit = true;
        }
      }
    }
    const known = dupLabels[tab.id] ?? '';
    let applied = '';
    if (known && t.startsWith(labelPrefix(known))) {
      applied = known;
      t = t.slice(labelPrefix(known).length);
    }
    const wantLocal = local.enabled && isLocalUrl(tab.url ?? '', local.patterns) ? local.prefix : '';
    info.push({ tab, applied, appliedLocal, wantLocal, base: t });
  }

  const desired = new Map();
  if (dedupeEnabled) {
    const groups = new Map();
    for (const { tab, base } of info) {
      if (!base || tab.pinned) continue;
      const key = `${tab.windowId}\n${base}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ id: tab.id, parts: urlParts(tab.url ?? '') });
    }
    for (const items of groups.values()) {
      if (items.length < 2) continue;
      items.sort((a, b) => a.id - b.id); // 連番は作成順で安定させる（並べ替えの影響を受けない）
      assignLabels(items, 0, desired);
    }
  }

  const nextLabels = {};
  const nextLocal = {};
  for (const { tab, applied, appliedLocal, wantLocal } of info) {
    const want = desired.get(tab.id) ?? '';
    const keepOld = () => {
      if (dupLabels[tab.id]) nextLabels[tab.id] = dupLabels[tab.id];
      if (localMarks[tab.id]) nextLocal[tab.id] = localMarks[tab.id];
    };
    const record = () => {
      if (want) nextLabels[tab.id] = want;
      if (wantLocal) nextLocal[tab.id] = wantLocal;
    };
    if (applied === want && appliedLocal === wantLocal) {
      record();
      continue;
    }
    if (!isInjectable(tab) || isThrottled(tab.id)) {
      keepOld();
      continue;
    }
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: applyTitlePrefixes,
        args: [
          STALE_PREFIX,
          appliedLocal,
          wantLocal,
          applied ? labelPrefix(applied) : '',
          want ? labelPrefix(want) : '',
        ],
      });
      recordApply(tab.id);
      record();
    } catch {
      keepOld(); // 読み込み前・注入不可のタブは次回に持ち越す
    }
  }
  await chrome.storage.local.set({ dupLabels: nextLabels, localMarks: nextLocal });
}

// 自分のタイトル書き換えでも onUpdated が飛ぶので、debounce して1回にまとめる。
// 実行中に再要求が来たら終了後にもう一度だけ回す。
let refreshTimer;
let refreshRunning = false;
let refreshRerun = false;
function scheduleTitleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(runTitleRefresh, 300);
}
async function runTitleRefresh() {
  if (refreshRunning) {
    refreshRerun = true;
    return;
  }
  refreshRunning = true;
  try {
    await refreshTitles();
  } catch (e) {
    console.warn('[tab-mru] title refresh failed', e);
  } finally {
    refreshRunning = false;
    if (refreshRerun) {
      refreshRerun = false;
      scheduleTitleRefresh();
    }
  }
}

chrome.runtime.onInstalled.addListener(scheduleTitleRefresh);
chrome.runtime.onStartup.addListener(scheduleTitleRefresh);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === STALE_ALARM) scheduleTitleRefresh(); // 取りこぼしの定期回収
});
chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  if (
    changeInfo.title !== undefined ||
    changeInfo.url !== undefined ||
    changeInfo.status === 'complete'
  ) {
    scheduleTitleRefresh();
  }
});
chrome.tabs.onRemoved.addListener(scheduleTitleRefresh);
chrome.tabs.onAttached.addListener(scheduleTitleRefresh); // 別ウィンドウへ移動
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  // OFF 時は全ラベル／🟢 を外す。絵文字やホスト一覧の変更は付け替える
  if (changes.dedupeTitles || changes.localMark || changes.localEmoji || changes.localHosts) {
    scheduleTitleRefresh();
  }
});
