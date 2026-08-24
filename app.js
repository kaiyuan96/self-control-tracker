'use strict';

/* ============================================================
   禁欲打卡 · 应用逻辑
   - 数据保存在浏览器 localStorage（离线可用）
   - 可选云端同步（访问码认证）
   ============================================================ */

const STORAGE_KEY = 'abstinence-app:v1';
/* 同域名 API：与页面同源，无需代理、无跨域 */
const SYNC_API = '/api/sync';

/* 预置诱因标签（可在记录弹窗中自定义添加） */
const PRESET_TRIGGERS = [
  '无聊', '压力大', '焦虑', '情绪低落', '熬夜', '独处',
  '刷手机', '看了不该看的', '冲动', '习惯性动作', '饮酒',
  '社交场合', '饥饿', '其他'
];

/* ---------------- 数据层 ---------------- */

function defaultState() {
  return {
    version: 2,
    onboarded: false,
    goal: { name: '禁欲计划', startedAt: new Date().toISOString(), updatedAt: Date.now() },
    customTriggers: [],
    relapses: [],
    deleted: {},                       /* 已删除记录 id -> 删除时间戳（用于云同步） */
    cloud: { code: '', connected: false, lastSyncAt: null }
  };
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

let state = load();
if (!state) { state = defaultState(); save(); }

/* 兼容旧版本数据：补齐新增字段 */
function normalizeState() {
  if (typeof state !== 'object' || !state) state = defaultState();
  if (!state.goal || typeof state.goal !== 'object') state.goal = defaultState().goal;
  if (!state.goal.updatedAt) state.goal.updatedAt = Date.now();
  if (!Array.isArray(state.relapses)) state.relapses = [];
  state.relapses.forEach(r => {
    if (!r.updatedAt) r.updatedAt = r.createdAt ? new Date(r.createdAt).getTime() : 0;
  });
  if (!Array.isArray(state.customTriggers)) state.customTriggers = [];
  if (!state.deleted || typeof state.deleted !== 'object') state.deleted = {};
  if (!state.cloud || typeof state.cloud !== 'object') {
    state.cloud = { code: '', connected: false, lastSyncAt: null };
  }
  state.cloud.code = state.cloud.code || '';
  state.cloud.connected = !!state.cloud.connected;
  state.cloud.lastSyncAt = state.cloud.lastSyncAt || null;
  if (!Array.isArray(state.reportSeenKeys)) state.reportSeenKeys = []; /* 已看过周报的周标识 */
  if (!state.aiReport || typeof state.aiReport !== 'object') state.aiReport = null; /* AI 周报 {content, week} */
}

/* ---------------- 工具函数 ---------------- */

const pad = n => String(n).padStart(2, '0');
const $ = id => document.getElementById(id);

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtDateTime(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function toLocalInput(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* 周一 00:00 为一周起点 */
function startOfWeek(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  const day = (x.getDay() + 6) % 7;
  x.setDate(x.getDate() - day);
  return x;
}

function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }

function fmtDuration(ms) {
  ms = Math.max(0, ms);
  const sec = Math.floor(ms / 1000);
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (d > 0) return `${d}天 ${pad(h)}:${pad(m)}:${pad(s)}`;
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function fmtDays(ms) { return Math.floor(ms / 86400000); }

/* ---------------- 统计计算 ---------------- */

function countInRange(relapses, from, to) {
  const f = from.getTime(), t = to.getTime();
  return relapses.filter(r => { const x = new Date(r.time).getTime(); return x >= f && x < t; }).length;
}

function weekCount(ref = new Date()) {
  const s = startOfWeek(ref);
  return countInRange(state.relapses, s, addDays(s, 7));
}

function monthCount(ref = new Date()) {
  const s = startOfMonth(ref);
  return countInRange(state.relapses, s, new Date(ref.getFullYear(), ref.getMonth() + 1, 1));
}

function sortedRelapses() {
  return [...state.relapses].sort((a, b) => new Date(a.time) - new Date(b.time));
}

/* 最长连续坚持（两次破戒之间的最大间隔，含进行中的） */
function longestStreakMs() {
  const sorted = sortedRelapses();
  let prev = new Date(state.goal.startedAt).getTime();
  let best = 0;
  for (const r of sorted) {
    const t = new Date(r.time).getTime();
    if (t - prev > best) best = t - prev;
    prev = t;
  }
  if (Date.now() - prev > best) best = Date.now() - prev;
  return best;
}

/* 平均破戒间隔（天） */
function avgIntervalDays() {
  const sorted = sortedRelapses();
  if (sorted.length < 2) return null;
  const span = new Date(sorted[sorted.length - 1].time) - new Date(sorted[0].time);
  return span / 86400000 / (sorted.length - 1);
}

/* 当前这段坚持的起点 */
function currentStreakStart() {
  const sorted = sortedRelapses();
  if (!sorted.length) return new Date(state.goal.startedAt);
  return new Date(sorted[sorted.length - 1].time);
}

/* 最近一次破戒（或 null） */
function lastRelapse() {
  const sorted = sortedRelapses();
  return sorted.length ? sorted[sorted.length - 1] : null;
}

/* 诱因频次统计 */
function triggerFreq() {
  const map = {};
  for (const r of state.relapses) {
    for (const t of (r.triggers || [])) map[t] = (map[t] || 0) + 1;
  }
  return Object.entries(map).sort((a, b) => b[1] - a[1]);
}

/* 时段分布：凌晨/上午/下午/晚上 */
function hourFreq() {
  const segs = [['凌晨', 0], ['上午', 0], ['下午', 0], ['晚上', 0]];
  for (const r of state.relapses) {
    const h = new Date(r.time).getHours();
    if (h < 6) segs[0][1]++;
    else if (h < 12) segs[1][1]++;
    else if (h < 18) segs[2][1]++;
    else segs[3][1]++;
  }
  return segs;
}

/* ---------------- 渲染：状态页 ---------------- */

function renderHome() {
  const goal = state.goal;
  $('goalName').textContent = goal.name;
  $('goalSub').textContent = '自 ' + fmtDateTime(goal.startedAt) + ' 开始';

  const start = currentStreakStart();
  $('streakSub').textContent = lastRelapse()
    ? '本次坚持从破戒后重新计算：' + fmtDateTime(start.toISOString())
    : '从计划开始至今从未破戒';

  /* 本周进度：周一 00:00 至今，扣掉破戒造成的"重置" */
  const now = new Date();
  const wkStart = startOfWeek(now);
  const wkBase = start > wkStart ? start : wkStart;
  const days = Math.min(7, (now - wkBase) / 86400000);
  $('weekBarFill').style.width = (days / 7 * 100).toFixed(1) + '%';
  $('weekBarText').textContent = `本周已坚持 ${days.toFixed(1)} 天（${Math.round(days / 7 * 100)}%）`;

  const last = lastRelapse();
  const lastEl = $('lastRelapse');
  if (last) {
    const agoDays = (Date.now() - new Date(last.time).getTime()) / 86400000;
    lastEl.innerHTML = `<span class="bad">上次破戒：${fmtDateTime(last.time)}（${agoDays < 1 ? '不到 1 天前' : agoDays.toFixed(1) + ' 天前'}）</span>`;
  } else {
    lastEl.innerHTML = '<span class="ok">✅ 自开始以来 0 次破戒</span>';
  }

  $('qsWeek').textContent = weekCount();
  $('qsMonth').textContent = monthCount();
  $('qsTotal').textContent = state.relapses.length;
  $('qsBest').textContent = fmtDays(longestStreakMs());

  renderTip();
  renderAI();
}

/* AI 分析卡片 */
function renderAI() {
  const card = $('aiCard');
  const r = state.aiReport;
  if (!r || !r.content) { card.style.display = 'none'; return; }
  card.style.display = 'block';
  $('aiMeta').textContent = r.week ? `· ${r.week}` : '';
  $('aiBody').textContent = r.content;
}

async function regenerateAI() {
  if (!state.cloud.connected || !state.cloud.code) { toast('请先在设置页连接云端同步'); return; }
  const btn = $('btnRegenAI');
  btn.disabled = true;
  btn.textContent = '🤔 AI 正在分析…';
  try {
    const res = await fetch(SYNC_API.replace('/sync', '/generate-report'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: state.cloud.code })
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || '生成失败');
    state.aiReport = { content: data.report.content, week: data.report.week };
    save();
    renderAI();
    toast('AI 分析已更新 ✨');
  } catch (e) {
    toast('生成失败：' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '🔄 让 AI 重新分析';
  }
}

function renderTip() {
  const el = $('tipBody');
  const tips = [];
  if (state.relapses.length === 0) {
    tips.push('继续保持！当前 0 次破戒，你已经走在正确的路上。');
  } else {
    const hf = hourFreq().sort((a, b) => b[1] - a[1])[0];
    if (hf && hf[1] > 0) tips.push(`你的破戒多发生在【${hf[0]}】时段（${hf[1]} 次），这个时段要格外警惕，提前安排别的事做。`);
    const tf = triggerFreq();
    if (tf.length) tips.push(`最常诱发你破戒的是「${esc(tf[0][0])}」（${tf[0][1]} 次），建议提前设防、回避触发场景。`);
  }
  const wk = weekCount();
  if (wk === 0 && state.relapses.length > 0) tips.push('本周 0 次破戒，干得漂亮！');
  const best = fmtDays(longestStreakMs());
  if (best >= 7) tips.push(`你最长连续坚持过 ${best} 天，说明你完全做得到！`);
  tips.push('破戒不是失败，记录并复盘，下次会更久。');
  el.innerHTML = tips.map(t => `<div>· ${t}</div>`).join('');
}

/* ---------------- 渲染：统计页 ---------------- */

function renderStats() {
  const now = new Date();

  /* 本周 vs 上周 */
  const wk = weekCount(now);
  const wkStart = startOfWeek(now);
  const lastWk = countInRange(state.relapses, addDays(wkStart, -7), wkStart);
  $('statWeek').textContent = wk;
  renderDiff('statWeekDiff', wk, lastWk);

  /* 本月 vs 上月 */
  const mo = monthCount(now);
  const moStart = startOfMonth(now);
  const lastMoStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastMo = countInRange(state.relapses, lastMoStart, moStart);
  $('statMonth').textContent = mo;
  renderDiff('statMonthDiff', mo, lastMo);

  /* 最长连续 & 当前连续 */
  $('statBest').innerHTML = fmtDays(longestStreakMs()) + '<small> 天</small>';
  const curDays = (Date.now() - currentStreakStart().getTime()) / 86400000;
  $('statBestDate').textContent = `当前连续 ${curDays.toFixed(1)} 天`;

  /* 平均间隔 */
  const avg = avgIntervalDays();
  $('statAvg').textContent = avg == null ? '—' : avg.toFixed(1) + '<small> 天</small>';
  $('statAvgSub').textContent = state.relapses.length ? `共 ${state.relapses.length} 次破戒` : '暂无破戒';

  renderWeekChart(now);
  renderMonthChart(now);
  renderTriggerChart();
  renderHourChart();
}

function renderDiff(elId, cur, prev) {
  const el = $(elId);
  if (prev === 0 && cur === 0) { el.textContent = '与上期持平'; el.className = 'stat-diff'; return; }
  if (prev === 0) { el.textContent = `较上期 +${cur}`; el.className = 'stat-diff up'; return; }
  const delta = cur - prev;
  el.textContent = (delta >= 0 ? '↑ ' : '↓ ') + Math.abs(delta) + ' 较上期';
  el.className = 'stat-diff ' + (delta > 0 ? 'up' : 'down');
}

/* 近 12 周柱状图 */
function renderWeekChart(now) {
  const weeks = [];
  const thisWk = startOfWeek(now);
  for (let i = 11; i >= 0; i--) {
    const s = addDays(thisWk, -7 * i);
    weeks.push({ start: s, count: countInRange(state.relapses, s, addDays(s, 7)) });
  }
  renderBars('chartWeeks', weeks.map((w, i) => ({
    label: `${w.start.getMonth() + 1}/${w.start.getDate()}`,
    value: w.count,
    hot: i === weeks.length - 1
  })));
}

/* 近 6 个月柱状图 */
function renderMonthChart(now) {
  const months = [];
  const thisMo = startOfMonth(now);
  for (let i = 5; i >= 0; i--) {
    const s = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const e = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
    months.push({ start: s, count: countInRange(state.relapses, s, e) });
  }
  renderBars('chartMonths', months.map((m, i) => ({
    label: `${m.start.getFullYear()}/${m.start.getMonth() + 1}`,
    value: m.count,
    hot: i === months.length - 1
  })));
}

function renderBars(containerId, items) {
  const el = $(containerId);
  const max = Math.max(1, ...items.map(i => i.value));
  el.innerHTML = items.map(it => `
    <div class="bar-col${it.hot ? ' hot' : ''}">
      <div class="bar-val">${it.value}</div>
      <div class="bar" style="height:${Math.max(3, it.value / max * 100)}%"></div>
      <div class="bar-label">${esc(it.label)}</div>
    </div>`).join('');
}

/* 诱因横向条 */
function renderTriggerChart() {
  const el = $('chartTriggers');
  const freq = triggerFreq().slice(0, 8);
  if (!freq.length) { el.innerHTML = '<div class="chart-empty">暂无数据，破戒记录后这里会展示高频诱因</div>'; return; }
  const max = freq[0][1];
  el.innerHTML = freq.map(([t, c]) => `
    <div class="h-row">
      <div class="h-label">${esc(t)}</div>
      <div class="h-track"><div class="h-fill" style="width:${c / max * 100}%"></div></div>
      <div class="h-count">${c}</div>
    </div>`).join('');
}

/* 时段横向条 */
function renderHourChart() {
  const el = $('chartHours');
  const segs = hourFreq();
  if (state.relapses.length === 0) { el.innerHTML = '<div class="chart-empty">暂无数据</div>'; return; }
  const max = Math.max(1, ...segs.map(s => s[1]));
  el.innerHTML = segs.map(([name, c]) => `
    <div class="h-row">
      <div class="h-label">${esc(name)}</div>
      <div class="h-track"><div class="h-fill" style="width:${c / max * 100}%"></div></div>
      <div class="h-count">${c}</div>
    </div>`).join('');
}

/* ---------------- 渲染：记录页 ---------------- */

function renderHistory() {
  const list = $('historyList');
  const empty = $('historyEmpty');
  const sorted = sortedRelapses().reverse();
  $('historyCount').textContent = `共 ${sorted.length} 条`;
  empty.style.display = sorted.length ? 'none' : 'block';
  list.innerHTML = sorted.map(r => `
    <div class="history-item">
      <div class="hi-main">
        <div class="hi-time">⏱ ${fmtDateTime(r.time)}</div>
        ${(r.triggers || []).length ? `<div class="hi-triggers">${r.triggers.map(t => `<span class="chip">${esc(t)}</span>`).join('')}</div>` : ''}
        ${r.severity ? `<div class="hi-sev">${'★'.repeat(r.severity)}${'☆'.repeat(5 - r.severity)}</div>` : ''}
        ${r.note ? `<div class="hi-note">${esc(r.note)}</div>` : ''}
      </div>
      <div class="hi-actions">
        <button class="hi-del" data-edit="${r.id}" title="修改这条记录">✏️</button>
        <button class="hi-del" data-del="${r.id}" title="删除这条记录">✕</button>
      </div>
    </div>`).join('');
}

/* ---------------- 渲染：设置页 ---------------- */

function renderSettings() {
  $('setGoalName').value = state.goal.name;
  $('setStartAt').value = toLocalInput(new Date(state.goal.startedAt));
  renderSyncUi();
}

/* ---------------- 破戒记录弹窗 ---------------- */

let selectedTriggers = [];
let severity = 3;
let editingRelapseId = null; /* 非空 = 编辑模式，记录正在修改的 id */

function openRelapseModal(rec) {
  editingRelapseId = rec ? rec.id : null;
  $('triggerInput').value = '';
  if (rec) {
    /* 编辑模式：预填该记录 */
    selectedTriggers = [...(rec.triggers || [])];
    severity = rec.severity || 3;
    $('relapseTime').value = toLocalInput(new Date(rec.time));
    $('relapseNote').value = rec.note || '';
    $('modalTitle').textContent = '修改破戒记录';
    $('btnSubmitRelapse').textContent = '保存修改';
  } else {
    /* 新建模式 */
    selectedTriggers = [];
    severity = 3;
    $('relapseTime').value = toLocalInput(new Date());
    $('relapseNote').value = '';
    $('modalTitle').textContent = '记录一次破戒';
    $('btnSubmitRelapse').textContent = '确认记录';
  }
  document.querySelectorAll('#quickTimes .chip-opt').forEach(b => b.classList.remove('sel'));
  renderTriggerChips();
  renderSelectedTriggers();
  renderStars();
  $('relapseModal').classList.remove('hidden');
}

function closeRelapseModal() {
  $('relapseModal').classList.add('hidden');
}

function allTriggers() {
  return [...PRESET_TRIGGERS, ...(state.customTriggers || [])];
}

function renderTriggerChips() {
  const wrap = $('triggerChips');
  wrap.innerHTML = allTriggers().map(t =>
    `<button class="chip-opt" data-trigger="${esc(t)}">${esc(t)}</button>`).join('');
}

function renderSelectedTriggers() {
  const wrap = $('selectedTriggers');
  wrap.innerHTML = selectedTriggers.map((t, i) =>
    `<span class="st-chip">${esc(t)}<button data-remove="${i}" title="移除">✕</button></span>`).join('');
}

function renderStars() {
  const wrap = $('severityStars');
  const labels = ['', '轻微', '较轻', '一般', '较重', '严重'];
  wrap.innerHTML = [1, 2, 3, 4, 5].map(n =>
    `<span class="star${n <= severity ? ' on' : ''}" data-star="${n}">★</span>`).join('')
    + `<span class="star-label" id="starLabel">${labels[severity]}</span>`;
}

/* ---------------- 云端同步 ---------------- */

let syncInFlight = false;
let syncTimer = null;

function setSyncStatus(msg) { $('syncStatus').textContent = msg; }
function setSyncError(msg) { $('syncError').textContent = msg || ''; }

function renderSyncUi() {
  const connected = state.cloud.connected && state.cloud.code;
  $('syncDisconnected').style.display = connected ? 'none' : 'block';
  $('syncConnected').style.display = connected ? 'block' : 'none';
  setSyncStatus(connected
    ? (state.cloud.lastSyncAt ? '已连接 · 最近同步 ' + fmtDateTime(new Date(state.cloud.lastSyncAt).toISOString()) : '已连接 · 尚未同步')
    : '未连接云端（数据仅存本机）');
  if (connected) {
    $('syncMyCode').textContent = fmtCode(state.cloud.code);
    $('syncLast').textContent = state.cloud.lastSyncAt
      ? '上次同步：' + fmtDateTime(new Date(state.cloud.lastSyncAt).toISOString())
      : '上次同步：—';
  } else {
    $('syncCodeInput').value = state.cloud.code ? fmtCode(state.cloud.code) : '';
  }
}

/* 访问码生成：8 位，去掉易混淆字符 */
function genAccessCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

/* 显示格式：K7D2-9F4M */
function fmtCode(c) { return c.length === 8 ? c.slice(0, 4) + '-' + c.slice(4) : c; }

/* 本地数据变更后，防抖自动同步 */
function markDirty() {
  if (!state.cloud || !state.cloud.connected || !state.cloud.code) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => syncNow(true), 1500);
}

/* 将云端数据合并进本地（记录按 updatedAt 取新，删除按时间戳裁决） */
function mergeWithCloud(cloud) {
  if (cloud.goal && cloud.goal.updatedAt && (!state.goal.updatedAt || cloud.goal.updatedAt > state.goal.updatedAt)) {
    state.goal = { ...state.goal, ...cloud.goal };
  }
  const map = new Map();
  for (const r of state.relapses) map.set(r.id, r);
  for (const r of (cloud.relapses || [])) {
    const cur = map.get(r.id);
    if (!cur || (r.updatedAt || 0) > (cur.updatedAt || 0)) map.set(r.id, r);
  }
  const del = { ...(state.deleted || {}) };
  for (const [id, ts] of Object.entries(cloud.deleted || {})) {
    if (del[id] == null || ts > del[id]) del[id] = ts;
  }
  const out = [];
  for (const rec of map.values()) {
    const ts = del[rec.id];
    if (ts != null && ts >= (rec.updatedAt || 0)) continue;
    out.push(rec);
  }
  state.relapses = out;
  state.deleted = del;
}

/* 同步一次：先拉取云端 → 合并 → 上传 → 再合并响应 */
async function syncNow(quiet = false) {
  if (syncInFlight) return false;
  const code = state.cloud.code;
  if (!code) return false;
  syncInFlight = true;
  try {
    setSyncStatus('同步中…');
    if (!quiet) setSyncError('');
    let pull = null;
    try {
      const res = await fetch(SYNC_API + '?code=' + encodeURIComponent(code));
      if (res.status === 404) pull = null; /* 云端还没有此账号 */
      else pull = await res.json();
    } catch (e) {
      throw new Error('网络错误：无法连接同步服务器（可能需要代理）');
    }
    if (pull && pull.ok) mergeWithCloud(pull);

    const res = await fetch(SYNC_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, goal: state.goal, relapses: state.relapses, deleted: state.deleted })
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || '同步失败');
    mergeWithCloud(data);
    if (data.aiReport !== undefined) {
      state.aiReport = data.aiReport; /* {content, week} 或 null */
    }

    state.cloud.lastSyncAt = Date.now();
    save();
    setSyncStatus('已连接 · 最近同步 ' + fmtDateTime(new Date(state.cloud.lastSyncAt).toISOString()));
    setSyncError('');
    reRenderAll();
    return true;
  } catch (e) {
    setSyncStatus(state.cloud.connected ? '已连接 · 上次同步失败' : '连接失败');
    setSyncError(e.message);
    if (!quiet) toast('同步失败：' + e.message);
    return false;
  } finally {
    syncInFlight = false;
  }
}

function doConnect(codeStr) {
  const c = String(codeStr || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (c.length < 6) { toast('访问码无效（应为 8 位）'); return; }
  state.cloud.code = c;
  state.cloud.connected = true;
  save();
  renderSyncUi();
  syncNow(false);
}

function doNewCode() {
  const code = genAccessCode();
  state.cloud.code = code;
  state.cloud.connected = true;
  state.cloud.lastSyncAt = null;
  save();
  renderSyncUi();
  syncNow(false);
  toast('新访问码：' + fmtCode(code) + '，请妥善保存！');
}

function doDisconnect() {
  state.cloud.connected = false;
  save();
  renderSyncUi();
  toast('已断开云端连接（本地数据保留）');
}

/* ---------------- 每周总结（周报） ---------------- */

function weekKey(monday) {
  return `${monday.getFullYear()}-${pad(monday.getMonth() + 1)}-${pad(monday.getDate())}`;
}

/* 打开应用时检查：新的一周是否还没看过上周总结 */
function checkWeeklyReport() {
  const now = new Date();
  const thisMon = startOfWeek(now);
  const lastMon = addDays(thisMon, -7);
  const key = weekKey(lastMon);
  if (state.reportSeenKeys.includes(key)) return;

  const cnt = countInRange(state.relapses, lastMon, thisMon);
  /* 上周无记录且全库无历史 → 新用户，不打扰 */
  if (cnt === 0 && state.relapses.length === 0) return;
  openWeeklyReport(lastMon);
}

function buildReportBody(lastMon) {
  const thisMon = addDays(lastMon, 7);
  const prevMon = addDays(lastMon, -7);
  const inR = (r, a, b) => { const t = new Date(r.time).getTime(); return t >= a.getTime() && t < b.getTime(); };
  const cur = sortedRelapses().filter(r => inR(r, lastMon, thisMon));
  const prev = sortedRelapses().filter(r => inR(r, prevMon, lastMon));

  /* 上周内最长"干净"天数：从周一到最后一次破戒前；无破戒则整周 */
  const lastRelapseDay = cur.length ? new Date(cur[cur.length - 1].time) : null;
  let cleanDays;
  if (!cur.length) cleanDays = 7;
  else {
    cleanDays = Math.max(0, Math.floor((lastRelapseDay - lastMon) / 86400000));
    if (!inR({ time: lastRelapseDay.toISOString() }, lastMon, thisMon)) cleanDays = 7;
  }

  /* 对比文案 */
  let cmpText, cmpClass;
  if (prev.length === 0 && cur.length === 0) { cmpText = '持续保持零破戒'; cmpClass = 'good'; }
  else if (cur.length === 0) { cmpText = '🎉 零破戒！完美一周'; cmpClass = 'good'; }
  else if (prev.length === 0) { cmpText = `出现 ${cur.length} 次`; cmpClass = 'bad'; }
  else if (cur.length > prev.length) { cmpText = `↑ 比前一周多 ${cur.length - prev.length} 次`; cmpClass = 'bad'; }
  else if (cur.length < prev.length) { cmpText = `↓ 比前一周少 ${prev.length - cur.length} 次`; cmpClass = 'good'; }
  else { cmpText = '与前一周持平'; cmpClass = 'flat'; }

  /* 诱因 Top3 */
  const tf = {};
  for (const r of cur) for (const t of (r.triggers || [])) tf[t] = (tf[t] || 0) + 1;
  const topTriggers = Object.entries(tf).sort((a, b) => b[1] - a[1]).slice(0, 3);

  /* 时段分布 */
  const segs = {};
  for (const r of cur) segs[SEG_NAMES[Math.floor(new Date(r.time).getHours() / 6)]] = (segs[SEG_NAMES[Math.floor(new Date(r.time).getHours() / 6)]] || 0) + 1;
  const topSeg = Object.entries(segs).sort((a, b) => b[1] - a[1])[0];

  /* 建议 */
  let tip;
  if (cur.length === 0) tip = '上周零破戒，把这套节奏保持下去——记录让你更清醒。';
  else if (topSeg && topSeg[1] >= Math.ceil(cur.length / 2)) tip = `你的破戒集中在【${topSeg[0]}】时段，下周这个时段提前安排别的事，避开触发场景。`;
  else if (topTriggers.length) tip = `高频诱因是「${topTriggers[0][0]}」，下次它冒头时先离开现场 10 分钟。`;
  else tip = '破戒不是失败，记录并复盘，趋势会越来越好。';

  return `
    <div class="report-grid">
      <div class="report-cell">
        <div class="report-num ${cmpClass}">${cur.length}<small> 次</small></div>
        <div class="report-label">上周破戒 · ${cmpText}</div>
      </div>
      <div class="report-cell">
        <div class="report-num">${cleanDays}<small> 天</small></div>
        <div class="report-label">上周最长干净纪录</div>
      </div>
    </div>
    ${cur.length ? `<div class="report-sec"><b>诱因：</b>${topTriggers.length ? topTriggers.map(([t, c]) => `<span class="chip">${esc(t)} ×${c}</span>`).join(' ') : '<span class="report-dim">未填写</span>'}</div>` : ''}
    <div class="report-tip">${esc(tip)}</div>`;
}

const SEG_NAMES = ['凌晨', '上午', '下午', '晚上'];

function openWeeklyReport(lastMon) {
  const thisMon = addDays(lastMon, 7);
  $('reportRange').textContent = `${lastMon.getFullYear()}年${lastMon.getMonth() + 1}月${lastMon.getDate()}日 ~ ${thisMon.getMonth() + 1}月${thisMon.getDate()}日`;
  $('reportBody').innerHTML = buildReportBody(lastMon);
  $('reportModal').classList.remove('hidden');
}

function closeWeeklyReport(lastMon) {
  const key = weekKey(lastMon);
  if (!state.reportSeenKeys.includes(key)) {
    state.reportSeenKeys.push(key);
    if (state.reportSeenKeys.length > 8) state.reportSeenKeys = state.reportSeenKeys.slice(-8);
    save();
  }
  $('reportModal').classList.add('hidden');
}

/* ---------------- 其他 UI ---------------- */

function toast(msg) {
  let t = $('toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    t.style.cssText = 'position:fixed;left:50%;bottom:32px;transform:translateX(-50%);background:#232834;color:#fff;border:1px solid var(--border);padding:10px 20px;border-radius:999px;font-size:14px;z-index:999;box-shadow:0 8px 30px rgba(0,0,0,.4);opacity:0;transition:opacity .25s;pointer-events:none';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.opacity = '1';
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.style.opacity = '0'; }, 2200);
}

function reRenderAll() {
  renderHome();
  renderStats();
  renderHistory();
  renderSettings();
}

/* ---------------- 事件绑定 ---------------- */

function bindEvents() {
  /* Tab 切换 */
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
      btn.classList.add('active');
      $('view-' + btn.dataset.view).classList.add('active');
      if (btn.dataset.view === 'stats') renderStats();
      if (btn.dataset.view === 'history') renderHistory();
    });
  });

  /* 破戒弹窗 */
  $('btnRelapse').addEventListener('click', openRelapseModal);
  $('btnCancelRelapse').addEventListener('click', closeRelapseModal);
  $('relapseModal').addEventListener('click', e => { if (e.target === $('relapseModal')) closeRelapseModal(); });

  /* 诱因选择（事件委托） */
  $('triggerChips').addEventListener('click', e => {
    const btn = e.target.closest('.chip-opt');
    if (!btn) return;
    const t = btn.dataset.trigger;
    if (selectedTriggers.includes(t)) selectedTriggers = selectedTriggers.filter(x => x !== t);
    else selectedTriggers.push(t);
    renderTriggerChips(); renderSelectedTriggers();
  });

  $('btnAddTrigger').addEventListener('click', () => {
    const inp = $('triggerInput');
    const t = inp.value.trim();
    if (!t) return;
    if (!selectedTriggers.includes(t)) selectedTriggers.push(t);
    if (!state.customTriggers.includes(t) && !PRESET_TRIGGERS.includes(t)) {
      state.customTriggers.push(t);
      save();
    }
    inp.value = '';
    renderTriggerChips(); renderSelectedTriggers();
  });
  $('triggerInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); $('btnAddTrigger').click(); }
  });

  $('selectedTriggers').addEventListener('click', e => {
    const btn = e.target.closest('[data-remove]');
    if (!btn) return;
    selectedTriggers.splice(Number(btn.dataset.remove), 1);
    renderSelectedTriggers(); renderTriggerChips();
  });

  /* 严重程度 */
  $('severityStars').addEventListener('click', e => {
    const star = e.target.closest('[data-star]');
    if (!star) return;
    severity = Number(star.dataset.star);
    renderStars();
  });

  /* 快捷时间：补记破戒 */
  $('quickTimes').addEventListener('click', e => {
    const btn = e.target.closest('[data-quick]');
    if (!btn) return;
    const q = btn.dataset.quick;
    const d = new Date();
    if (q === 'now') { /* 保持当前时间 */ }
    else if (q === '1h') d.setHours(d.getHours() - 1);
    else if (q === '3h') d.setHours(d.getHours() - 3);
    else if (q === 'yesterday') d.setDate(d.getDate() - 1);
    else if (q === '2d') d.setDate(d.getDate() - 2);
    else if (q === '7d') d.setDate(d.getDate() - 7);
    $('relapseTime').value = toLocalInput(d);
    document.querySelectorAll('#quickTimes .chip-opt').forEach(b => b.classList.remove('sel'));
    btn.classList.add('sel');
  });

  /* 手动修改时间时清除快捷高亮 */
  $('relapseTime').addEventListener('input', () => {
    document.querySelectorAll('#quickTimes .chip-opt').forEach(b => b.classList.remove('sel'));
  });

  /* 提交破戒 / 保存修改 */
  $('btnSubmitRelapse').addEventListener('click', () => {
    const timeVal = $('relapseTime').value;
    if (!timeVal) { toast('请选择破戒时间'); return; }
    const payload = {
      time: new Date(timeVal).toISOString(),
      triggers: [...selectedTriggers],
      severity,
      note: $('relapseNote').value.trim(),
      updatedAt: Date.now()
    };
    if (editingRelapseId) {
      /* 编辑模式：更新原记录 */
      const idx = state.relapses.findIndex(r => r.id === editingRelapseId);
      if (idx >= 0) {
        state.relapses[idx] = { ...state.relapses[idx], ...payload };
        toast('已保存修改');
      } else {
        toast('记录不存在，可能已被删除');
      }
    } else {
      /* 新建模式 */
      state.relapses.push({
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
        createdAt: new Date().toISOString(),
        ...payload
      });
      toast('已记录，重新开始 💪');
    }
    save();
    closeRelapseModal();
    reRenderAll();
    markDirty();
  });

  /* 修改/删除记录（事件委托） */
  $('historyList').addEventListener('click', e => {
    const editBtn = e.target.closest('[data-edit]');
    if (editBtn) {
      const rec = state.relapses.find(r => r.id === editBtn.dataset.edit);
      if (rec) openRelapseModal(rec);
      return;
    }
    const btn = e.target.closest('[data-del]');
    if (!btn) return;
    const id = btn.dataset.del;
    if (!confirm('确定删除这条破戒记录吗？')) return;
    state.relapses = state.relapses.filter(r => r.id !== id);
    state.deleted[id] = Date.now(); /* 记录删除标记，云端同步用 */
    save();
    reRenderAll();
    toast('已删除');
    markDirty();
  });

  /* 设置保存 */
  $('btnSaveGoal').addEventListener('click', () => {
    const name = $('setGoalName').value.trim() || '禁欲计划';
    const startVal = $('setStartAt').value;
    state.goal.name = name;
    if (startVal) state.goal.startedAt = new Date(startVal).toISOString();
    state.goal.updatedAt = Date.now();
    save();
    reRenderAll();
    toast('设置已保存');
    markDirty();
  });

  /* 导出 */
  $('btnExport').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `abstinence-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('已导出备份文件');
  });

  /* 导入 */
  $('fileImport').addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!data || typeof data !== 'object' || !data.goal || !Array.isArray(data.relapses)) {
          throw new Error('格式不正确');
        }
        if (!confirm('导入将覆盖当前所有数据，确定继续吗？')) return;
        state = {
          version: 2,
          onboarded: true,
          goal: data.goal,
          customTriggers: Array.isArray(data.customTriggers) ? data.customTriggers : [],
          relapses: data.relapses,
          deleted: (data.deleted && typeof data.deleted === 'object') ? data.deleted : {},
          cloud: (data.cloud && typeof data.cloud === 'object') ? data.cloud : { code: '', connected: false, lastSyncAt: null }
        };
        normalizeState();
        save();
        reRenderAll();
        toast('导入成功');
      } catch (err) {
        toast('导入失败：文件格式不正确');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  });

  /* 清空 */
  $('btnClear').addEventListener('click', () => {
    if (!confirm('确定清空所有破戒记录吗？此操作不可恢复！')) return;
    if (!confirm('再次确认：真的要清空吗？')) return;
    const now = Date.now();
    state.relapses.forEach(r => { state.deleted[r.id] = now; }); /* 云端同步删除 */
    state.relapses = [];
    save();
    reRenderAll();
    toast('已清空所有记录');
    markDirty();
  });

  /* 云端同步 */
  $('btnSyncConnect').addEventListener('click', () => doConnect($('syncCodeInput').value));
  $('btnSyncNewCode').addEventListener('click', doNewCode);
  $('btnSyncNow').addEventListener('click', () => syncNow(false));
  $('btnSyncDisconnect').addEventListener('click', doDisconnect);
  $('btnCopyCode').addEventListener('click', () => {
    navigator.clipboard.writeText(state.cloud.code).then(
      () => toast('访问码已复制：' + fmtCode(state.cloud.code)),
      () => toast('复制失败，请手动复制')
    );
  });
  $('syncCodeInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') doConnect(e.target.value);
  });

  /* AI 分析 */
  $('btnRegenAI').addEventListener('click', regenerateAI);

  /* 首次引导 */
  $('btnOnboard').addEventListener('click', () => {
    const name = $('obGoalName').value.trim() || '禁欲计划';
    const startVal = $('obStartAt').value;
    state.goal.name = name;
    if (startVal) state.goal.startedAt = new Date(startVal).toISOString();
    state.goal.updatedAt = Date.now();
    state.onboarded = true;
    save();
    $('onboardModal').classList.add('hidden');
    reRenderAll();
    toast('计划开始，加油！🛡️');
  });
}

/* ---------------- 启动 ---------------- */

function init() {
  normalizeState();

  /* 首次使用引导 */
  if (!state.onboarded) {
    $('obGoalName').value = state.goal.name;
    $('obStartAt').value = toLocalInput(new Date());
    $('onboardModal').classList.remove('hidden');
  }

  bindEvents();
  reRenderAll();
  tick();
  setInterval(tick, 1000);

  /* 跨天时刷新静态数据 */
  setInterval(() => {
    if (new Date().getDate() !== lastRenderedDate) reRenderAll();
  }, 60000);

  /* 已连接云端 → 启动时静默同步一次 */
  if (state.cloud.connected && state.cloud.code) {
    setTimeout(() => syncNow(true), 800);
  }

  /* 每周总结：新的一周首次打开时弹出上周总结（等云同步完成后再查，数据更全） */
  $('btnReportClose').addEventListener('click', () => {
    const now = new Date();
    const lastMon = addDays(startOfWeek(now), -7);
    closeWeeklyReport(lastMon);
  });
  if (state.onboarded) setTimeout(checkWeeklyReport, state.cloud.connected ? 2500 : 600);
}

let lastRenderedDate = new Date().getDate();

function tick() {
  const start = currentStreakStart();
  $('streakTime').textContent = fmtDuration(Date.now() - start.getTime());
  lastRenderedDate = new Date().getDate();
}

init();
