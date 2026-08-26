'use strict';

/* ============================================================
   自律打卡 · 应用逻辑
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
    goal: { name: '自律计划', startedAt: new Date().toISOString(), updatedAt: Date.now() },
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
  /* 旧版本默认目标名迁移为中性词 */
  if (state.goal.name === '禁欲计划') { state.goal.name = '自律计划'; state.goal.updatedAt = Date.now(); }
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
  if (!Array.isArray(state.diaries)) state.diaries = []; /* 心情日记 [{id,time,mood,content,updatedAt}] */
  state.diaries = state.diaries.map(normalizeDiary);
  if (!Array.isArray(state.plans)) state.plans = []; /* 预案卡 [{id,ifText,thenText,source,createdAt,updatedAt,used,missed}] */
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
  const diaryDays = new Set(state.diaries.map(d => (d.time || '').slice(0, 10)));
  list.innerHTML = sorted.map(r => `
    <div class="history-item">
      <div class="hi-main">
        <div class="hi-time">⏱ ${fmtDateTime(r.time)}${diaryDays.has(localDayKey(r.time)) ? ' <span class="hi-diary-mark" title="这天写了心情日记">📝</span>' : ''}</div>
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
    if (pull && pull.ok) {
      mergeWithCloud(pull);
      if (pull.aiReport !== undefined) state.aiReport = pull.aiReport;
      if (Array.isArray(pull.diaries)) mergeDiariesFromCloud(pull.diaries);
      if (Array.isArray(pull.plans)) mergePlansFromCloud(pull.plans);
    }

    const res = await fetch(SYNC_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, goal: state.goal, relapses: state.relapses, diaries: state.diaries, plans: state.plans, deleted: state.deleted })
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || '同步失败');
    mergeWithCloud(data);
    if (data.aiReport !== undefined) {
      state.aiReport = data.aiReport; /* {content, week} 或 null */
    }
    if (Array.isArray(data.diaries)) mergeDiariesFromCloud(data.diaries);
    if (Array.isArray(data.plans)) mergePlansFromCloud(data.plans);

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

/* 云端日记合并进本地（updatedAt 新者胜，剔除已删除，旧格式归一化） */
function mergeDiariesFromCloud(cloudDiaries) {
  const map = new Map();
  const touch = raw => {
    const d = normalizeDiary(raw);
    if (!d || !d.id) return;
    const ts = state.deleted[d.id];
    if (ts != null && ts >= (d.updatedAt || 0)) return; /* 已被删除 */
    const cur = map.get(d.id);
    if (!cur || (d.updatedAt || 0) > (cur.updatedAt || 0)) map.set(d.id, d);
  };
  for (const d of state.diaries) touch(d);
  for (const d of cloudDiaries) touch(d);
  state.diaries = [...map.values()];
}

/* 云端预案合并进本地（updatedAt 新者胜，剔除已删除） */
function mergePlansFromCloud(cloudPlans) {
  const map = new Map();
  const touch = raw => {
    const p = raw && typeof raw === 'object' ? raw : null;
    if (!p || !p.id) return;
    const ts = state.deleted[p.id];
    if (ts != null && ts >= (p.updatedAt || 0)) return;
    const cur = map.get(p.id);
    if (!cur || (p.updatedAt || 0) > (cur.updatedAt || 0)) map.set(p.id, p);
  };
  for (const p of state.plans) touch(p);
  for (const p of cloudPlans) touch(p);
  state.plans = [...map.values()];
}

/* ---------------- 预案卡（如果-那么） ---------------- */

const PLAN_ACTIONS = [
  '🚪 立刻离开当前位置，换个房间或出门走两分钟',
  '🧊 用冷水洗脸 / 冲手腕 30 秒',
  '💪 做 20 个俯卧撑或深蹲到发酸',
  '🔔 给朋友发条消息，或大声读一段文字',
  '⏳ 设 10 分钟倒计时，等冲动峰值过去',
  '🫁 4-7-8 呼吸 5 轮（吸4秒-屏7秒-呼8秒）'
];
let editingPlanId = null;

function renderPlans() {
  const card = $('planCard');
  if (!state.plans.length) {
    /* 未连接云端也能建预案，但 AI 推荐需要数据；始终显示入口引导 */
    card.style.display = 'block';
    $('planList').innerHTML = '<div class="diary-empty">提前把"如果…我就…"定好，冲动来时不用临场硬扛。先建一张兜底预案吧</div>';
    return;
  }
  card.style.display = 'block';
  const sorted = [...state.plans].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  $('planList').innerHTML = sorted.map(p => {
    const stat = (p.missed || p.used)
      ? `<span class="plan-stat">关联破戒 ${(p.missed || 0) + (p.used || 0)} 次 · 执行 ${p.used || 0} 次</span>`
      : '<span class="plan-stat">尚未实战过</span>';
    return `<div class="plan-item">
      <div class="plan-if"><b>如果</b> ${esc(p.ifText)}</div>
      <div class="plan-then"><b>那么</b> ${esc(p.thenText)}</div>
      <div class="plan-foot">${stat}
        <span class="hi-actions">
          <button class="chip-btn" data-pedit="${p.id}">编辑</button>
          <button class="chip-btn hi-del" data-pdel="${p.id}">✕</button>
        </span></div>
    </div>`;
  }).join('');
}

function openPlanModal(plan) {
  editingPlanId = plan ? plan.id : null;
  $('planIf').value = plan ? plan.ifText : '';
  $('planThen').value = plan ? plan.thenText : '';
  $('planActionChips').innerHTML = PLAN_ACTIONS.map(a => `<button type="button" class="chip-opt" data-action="${esc(a)}">${esc(a.split(' ')[0])}</button>`).join('');
  $('planModal').classList.remove('hidden');
}

function closePlanModal() {
  $('planModal').classList.add('hidden');
}

function savePlan() {
  const ifText = $('planIf').value.trim();
  const thenText = $('planThen').value.trim();
  if (!ifText) { toast('请填写触发情境'); return; }
  if (!thenText) { toast('请填写要执行的动作'); return; }
  if (editingPlanId) {
    const rec = state.plans.find(p => p.id === editingPlanId);
    if (rec) { rec.ifText = ifText; rec.thenText = thenText; rec.updatedAt = Date.now(); }
  } else {
    state.plans.push({ id: 'p' + Date.now().toString(36), ifText, thenText, source: 'manual', createdAt: Date.now(), updatedAt: Date.now(), used: 0, missed: 0 });
  }
  save();
  markDirty();
  renderPlans();
  closePlanModal();
  toast('预案已保存 🛡️');
}

async function aiSuggestPlans() {
  if (!state.cloud.connected || !state.cloud.code) { toast('请先在设置页连接云端同步'); return; }
  const btn = $('btnAiPlan');
  btn.disabled = true;
  btn.textContent = '✨ AI 思考中…';
  try {
    const res = await fetch(SYNC_API.replace('/sync', '/suggest-plan'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: state.cloud.code })
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || '生成失败');
    showPlanSuggestions(data.suggestions);
  } catch (e) {
    toast('AI 推荐失败：' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '✨ AI 推荐';
  }
}

function showPlanSuggestions(list) {
  $('planSuggestList').innerHTML = list.map((s, i) => `
    <div class="plan-item">
      <div class="plan-if"><b>如果</b> ${esc(s.ifText)}</div>
      <div class="plan-then"><b>那么</b> ${esc(s.thenText)}</div>
      <div class="modal-actions" style="margin-top:8px">
        <button class="chip-btn" data-adopt="${i}">✔ 采用这张</button>
      </div>
    </div>`).join('');
  window.__planSuggestions = list;
  $('planSuggestModal').classList.remove('hidden');
}

function adoptPlan(idx) {
  const s = (window.__planSuggestions || [])[idx];
  if (!s) return;
  state.plans.push({ id: 'p' + Date.now().toString(36), ifText: s.ifText, thenText: s.thenText, source: 'ai', createdAt: Date.now(), updatedAt: Date.now(), used: 0, missed: 0 });
  save();
  markDirty();
  renderPlans();
  $('planSuggestModal').classList.add('hidden');
  toast('预案已采用 🛡️');
}

/* 破戒保存后的预案复盘 */
let reviewRelapseId = null;
function openRelapseReview(relapseId) {
  reviewRelapseId = relapseId || null;
  if (!state.plans.length) return; /* 没有预案不打扰 */
  $('reviewPlanList').innerHTML = state.plans.map(p => `
    <div class="review-plan">
      <div class="plan-if"><b>如果</b> ${esc(p.ifText)}</div>
      <div class="review-btns">
        <button class="chip-btn" data-review="${p.id}:used">执行了但没拦住</button>
        <button class="chip-btn" data-review="${p.id}:missed">没来得及执行</button>
      </div>
    </div>`).join('');
  $('reviewModal').classList.remove('hidden');
}

function applyReview(pair) {
  const [planId, outcome] = pair.split(':');
  const rec = state.plans.find(p => p.id === planId);
  if (rec) {
    rec[outcome === 'used' ? 'used' : 'missed'] = (rec[outcome === 'used' ? 'used' : 'missed'] || 0) + 1;
    rec.updatedAt = Date.now();
    save();
    markDirty();
    renderPlans();
  }
  $('reviewModal').classList.add('hidden');
  toast('已记录，预案会越来越准 📊');
}

/* ---------------- 心情日记 ---------------- */

const MOODS = ['😊', '🙂', '😐', '😞', '😫', '😡'];
let editingDiaryId = null;

/* 归一化：兼容旧版仅日期的数据（date → time 当日 12:00） */
function normalizeDiary(d) {
  if (!d || typeof d !== 'object') return { id: 'd' + Math.random().toString(36).slice(2), time: toLocalInput(new Date()), mood: '', content: '', updatedAt: 0 };
  if (!d.time && d.date) d.time = d.date + 'T12:00';
  return d;
}

/* 任意时间 → 本地自然日 key（YYYY-MM-DD），用于日记与破戒按天关联 */
function localDayKey(v) {
  const d = v instanceof Date ? v : new Date(v);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/* 按天索引破戒记录：{ 'YYYY-MM-DD': [relapse...] } */
function relapsesByDay() {
  const map = {};
  for (const r of state.relapses) {
    const key = localDayKey(r.time);
    (map[key] = map[key] || []).push(r);
  }
  return map;
}

function renderDiaries() {
  const list = $('diaryList');
  const today = toLocalInput(new Date()).slice(0, 10);
  const btn = $('btnNewDiary');
  const hasToday = state.diaries.some(d => (d.time || '').slice(0, 10) === today);
  btn.textContent = hasToday ? '✏️ 编辑今天的' : '✏️ 写今天';

  if (!state.diaries.length && !state.relapses.length) {
    list.innerHTML = '<div class="diary-empty">记下今天的心情和经历，AI 周报会更懂你</div>';
    return;
  }
  const byDay = relapsesByDay();
  /* 时间线 = 日记 ∪ 有破戒的日子，合并展示 */
  const dayKeys = new Set([
    ...state.diaries.map(d => (d.time || '').slice(0, 10)),
    ...Object.keys(byDay)
  ]);
  const days = [...dayKeys].sort((a, b) => a < b ? 1 : -1).slice(0, 30);
  const pad2 = n => String(n).padStart(2, '0');
  list.innerHTML = days.map(key => {
    const dayRelapses = [...(byDay[key] || [])].sort((a, b) => new Date(a.time) - new Date(b.time));
    const diaries = state.diaries.filter(d => (d.time || '').slice(0, 10) === key);

    /* 破戒摘要块 */
    const relapseHtml = dayRelapses.length ? `
      <div class="diary-relapses">
        <div class="relapse-badge">⚠️ 这天破戒 ${dayRelapses.length} 次</div>
        ${dayRelapses.map(r => {
          const d = new Date(r.time);
          return `<div class="diary-relapse-row">${pad2(d.getHours())}:${pad2(d.getMinutes())} · ${'★'.repeat(r.severity || 0)}${(r.triggers || []).length ? ' · ' + esc(r.triggers.join('/')) : ''}${r.note ? ' · <i>' + esc(r.note) + '</i>' : ''}</div>`;
        }).join('')}
      </div>` : '';

    /* 日记块（可能多篇，一般一篇） */
    const diaryHtml = diaries.map(d => {
      const t = d.time || '';
      const dt = new Date(t);
      const hm = `${pad2(dt.getHours())}:${pad2(dt.getMinutes())}`;
      return `
      <div class="diary-text-head"><span>${d.mood || '📝'} ${hm}</span>
        <span class="hi-actions">
          <button class="chip-btn diary-edit" data-dedit="${d.id}">编辑</button>
          <button class="chip-btn hi-del" data-ddel="${d.id}">✕</button>
        </span></div>
      <div class="diary-text">${esc(d.content).replace(/\n/g, '<br>')}</div>`;
    }).join('');

    /* 当天无日记但有破戒 → 占位引导 */
    const emptyDiaryHtml = !diaries.length ? `
      <div class="diary-text-head"><span>📝 未写日记</span>
        <span class="hi-actions"><button class="chip-btn diary-edit" data-dadd="${key}">补写这天</button></span></div>` : '';

    const dt = new Date(key + 'T12:00:00');
    const weekName = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][dt.getDay()];
    const isToday = key === today;
    return `<div class="diary-item">
      <div class="diary-day">${dt.getMonth() + 1}月${dt.getDate()}日 · ${weekName}${isToday ? ' · 今天' : ''}</div>
      ${relapseHtml}
      ${emptyDiaryHtml}
      ${diaryHtml}
    </div>`;
  }).join('');
}

function openDiaryModal(dateStr) {
  editingDiaryId = null;
  const nowInput = toLocalInput(new Date());
  const target = dateStr ? dateStr + 'T12:00' : nowInput; /* 补记某天 → 默认当天中午 */
  $('diaryTime').value = target;
  $('diaryContent').value = '';
  let mood = null;
  const existing = state.diaries.find(d => editingByDate(d, target));
  if (existing) {
    editingDiaryId = existing.id;
    $('diaryTime').value = existing.time;
    $('diaryContent').value = existing.content;
    mood = existing.mood || null;
  }
  $('diaryMoods').innerHTML = MOODS.map(m => `<button type="button" class="chip-opt${m === mood ? ' sel' : ''}" data-mood="${m}">${m}</button>`).join('');
  $('diaryModal').classList.remove('hidden');
}

/* 判断某篇日记是否属于目标日期（按日比较） */
function editingByDate(d, datetimeLocal) {
  return (d.time || '').slice(0, 10) === String(datetimeLocal).slice(0, 10);
}

function closeDiaryModal() {
  $('diaryModal').classList.add('hidden');
}

function saveDiary() {
  const content = $('diaryContent').value.trim();
  if (!content) { toast('写点什么再保存吧'); return; }
  const timeVal = $('diaryTime').value;
  if (!timeVal) { toast('请选择时间'); return; }
  const moodEl = document.querySelector('#diaryMoods .chip-opt.sel');
  const mood = moodEl ? moodEl.dataset.mood : '';

  if (editingDiaryId) {
    const rec = state.diaries.find(d => d.id === editingDiaryId);
    if (rec) { rec.time = timeVal; rec.mood = mood; rec.content = content; rec.updatedAt = Date.now(); }
  } else {
    /* 同一天已有日记则覆盖更新那篇 */
    const existing = state.diaries.find(d => editingByDate(d, timeVal));
    if (existing) {
      existing.time = timeVal; existing.mood = mood; existing.content = content; existing.updatedAt = Date.now();
    } else {
      state.diaries.push({ id: 'd' + Date.now().toString(36), time: timeVal, mood, content, updatedAt: Date.now() });
    }
  }
  save();
  markDirty();
  renderDiaries();
  closeDiaryModal();
  toast('日记已保存 📝');
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
  renderDiaries();
  renderPlans();
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
      const newId = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      state.relapses.push({
        id: newId,
        createdAt: new Date().toISOString(),
        ...payload
      });
      toast('已记录，重新开始 💪');
      setTimeout(() => openRelapseReview(newId), 400); /* 预案复盘：仅新建时 */
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
    const name = $('setGoalName').value.trim() || '自律计划';
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

  /* 心情日记 */
  $('btnNewDiary').addEventListener('click', () => openDiaryModal());
  $('btnDiarySave').addEventListener('click', saveDiary);
  $('btnDiaryClose').addEventListener('click', closeDiaryModal);
  $('diaryModal').addEventListener('click', e => { if (e.target === $('diaryModal')) closeDiaryModal(); });

  /* 预案卡 */
  $('btnNewPlan').addEventListener('click', () => openPlanModal(null));
  $('btnAiPlan').addEventListener('click', aiSuggestPlans);
  $('btnPlanSave').addEventListener('click', savePlan);
  $('btnPlanClose').addEventListener('click', closePlanModal);
  $('planModal').addEventListener('click', e => { if (e.target === $('planModal')) closePlanModal(); });
  $('planActionChips').addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const cur = $('planThen').value.trim();
    const act = btn.dataset.action.replace(/^\S+\s/, ''); /* 去掉 emoji 前缀 */
    if (cur && !cur.endsWith('，') && !cur.endsWith(';') && !cur.endsWith('；')) act && ($('planThen').value = cur + '，' + act);
    else if (!cur) $('planThen').value = act;
  });
  $('planList').addEventListener('click', e => {
    const editBtn = e.target.closest('[data-pedit]');
    if (editBtn) {
      const rec = state.plans.find(p => p.id === editBtn.dataset.pedit);
      if (rec) openPlanModal(rec);
      return;
    }
    const delBtn = e.target.closest('[data-pdel]');
    if (delBtn) {
      const rec = state.plans.find(p => p.id === delBtn.dataset.pdel);
      if (!rec) return;
      if (!confirm('删除这张预案卡？')) return;
      state.plans = state.plans.filter(p => p.id !== rec.id);
      state.deleted[rec.id] = Date.now();
      save();
      markDirty();
      renderPlans();
      toast('已删除');
    }
  });
  $('planSuggestList').addEventListener('click', e => {
    const adoptBtn = e.target.closest('[data-adopt]');
    if (adoptBtn) adoptPlan(parseInt(adoptBtn.dataset.adopt, 10));
  });
  $('btnPlanSuggestClose').addEventListener('click', () => $('planSuggestModal').classList.add('hidden'));
  $('planSuggestModal').addEventListener('click', e => { if (e.target === $('planSuggestModal')) $('planSuggestModal').classList.add('hidden'); });

  /* 预案复盘 */
  $('reviewPlanList').addEventListener('click', e => {
    const btn = e.target.closest('[data-review]');
    if (btn) applyReview(btn.dataset.review);
  });
  $('btnReviewSkip').addEventListener('click', () => $('reviewModal').classList.add('hidden'));
  $('reviewModal').addEventListener('click', e => { if (e.target === $('reviewModal')) $('reviewModal').classList.add('hidden'); });
  $('btnDiarySave').addEventListener('click', saveDiary);
  $('diaryMoods').addEventListener('click', e => {
    const btn = e.target.closest('[data-mood]');
    if (!btn) return;
    document.querySelectorAll('#diaryMoods .chip-opt').forEach(b => b.classList.remove('sel'));
    btn.classList.add('sel');
  });
  $('diaryList').addEventListener('click', e => {
    const editBtn = e.target.closest('[data-dedit]');
    if (editBtn) {
      const rec = state.diaries.find(d => d.id === editBtn.dataset.dedit);
      if (rec) openDiaryModal(rec.time.slice(0, 10));
      return;
    }
    const addBtn = e.target.closest('[data-dadd]');
    if (addBtn) {
      openDiaryModal(addBtn.dataset.dadd);
      return;
    }
    const delBtn = e.target.closest('[data-ddel]');
    if (delBtn) {
      const rec = state.diaries.find(d => d.id === delBtn.dataset.ddel);
      if (!rec) return;
      if (!confirm('删除这篇日记？')) return;
      state.diaries = state.diaries.filter(d => d.id !== rec.id);
      state.deleted[rec.id] = Date.now();
      save();
      markDirty();
      renderDiaries();
      toast('已删除');
    }
  });

  /* 首次引导 */
  $('btnOnboard').addEventListener('click', () => {
    const name = $('obGoalName').value.trim() || '自律计划';
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
