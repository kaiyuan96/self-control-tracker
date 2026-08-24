'use strict';
/* ============================================================
   云端打卡数据分析工具
   用法：
     node tools/analyze.js              # 分析全部账号，近 6 周
     node tools/analyze.js --weeks=12   # 指定趋势周数
   依赖：wrangler 已登录（npx wrangler whoami 验证）
   说明：数据全程在内存中处理，不落盘
   ============================================================ */

const { execSync } = require('child_process');

/* ---- 参数 ---- */
let weeks = 6;
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--weeks=(\d+)$/);
  if (m) weeks = Math.min(52, Math.max(1, parseInt(m[1], 10)));
}

/* ---- 导出（stdout 直接入内存）---- */
const CMD = 'npx wrangler d1 execute abstinence-db --remote --json --command "SELECT code, goal, relapses, deleted, updated_at FROM accounts"';
let out;
try {
  out = execSync(CMD, { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
} catch (e) {
  console.error('导出失败：请确认已 npx wrangler login 且网络可用');
  process.exit(1);
}
const raw = JSON.parse(out.slice(out.indexOf('[')));
const rows = raw[0].results;

if (!rows.length) { console.log('云端没有任何账号数据'); process.exit(0); }

/* ---- 工具 ---- */
const pad = n => String(n).padStart(2, '0');
const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const fmt = iso => { const d = new Date(iso); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} ${WEEK[d.getDay()]}`; };
const day = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };

function startOfWeek(d) { const x = day(d); x.setDate(x.getDate() - (x.getDay() + 6) % 7); return x; }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
const SEG = ['凌晨', '上午', '下午', '晚上'];

/* ---- 分析 ---- */
console.log(`账号数量: ${rows.length}\n`);

for (const row of rows) {
  const code = row.code;
  const masked = code.length > 4 ? code.slice(0, 2) + '****' + code.slice(-2) : code;
  let relapses = [];
  try { relapses = JSON.parse(row.relapses || '[]'); } catch (e) {}
  const goal = (() => { try { return JSON.parse(row.goal || '{}'); } catch (e) { return {}; } })();

  console.log('='.repeat(48));
  console.log(`账号: ${masked} | 记录数: ${relapses.length}`);
  console.log(`目标: ${goal.name || '—'} | 开始: ${goal.startedAt ? fmt(goal.startedAt) : '—'}`);
  if (!relapses.length) { console.log('(无记录)\n'); continue; }

  const sorted = [...relapses].sort((a, b) => new Date(a.time) - new Date(b.time));
  const now = new Date();
  const thisMon = startOfWeek(now);

  /* 趋势 */
  console.log(`\n📈 近 ${weeks} 周破戒次数:`);
  for (let i = weeks - 1; i >= 0; i--) {
    const s = addDays(thisMon, -7 * i);
    const e = addDays(s, 7);
    const c = sorted.filter(r => { const t = new Date(r.time).getTime(); return t >= s.getTime() && t < e.getTime(); }).length;
    const tag = i === 0 ? ' ←本周' : '';
    console.log(`  ${fmt(s.toISOString()).slice(0, 10)} 起: ${'█'.repeat(c) || '·'} ${c}${tag}`);
  }

  /* 上周详情 */
  const lastMon = addDays(thisMon, -7);
  const lastWeek = sorted.filter(r => { const t = new Date(r.time); return t >= lastMon && t < thisMon; });
  console.log(`\n📅 上周（${lastMon.getMonth() + 1}/${lastMon.getDate()} ~ ${addDays(thisMon, -1).getMonth() + 1}/${addDays(thisMon, -1).getDate()}）: ${lastWeek.length} 次`);
  for (const r of lastWeek) {
    const seg = SEG[Math.floor(new Date(r.time).getHours() / 6)];
    console.log(`  • ${fmt(r.time)} [${seg}] 诱因:${(r.triggers || []).join('/') || '未填'} 严重度:${'★'.repeat(r.severity || 0)}${r.note ? ' 备注:' + r.note : ''}`);
  }
  const thisWeek = sorted.filter(r => new Date(r.time) >= thisMon);
  console.log(`📅 本周至今: ${thisWeek.length} 次`);
  for (const r of thisWeek) {
    console.log(`  • ${fmt(r.time)} 诱因:${(r.triggers || []).join('/') || '未填'}${r.note ? ' 备注:' + r.note : ''}`);
  }

  /* 时段 & 诱因 */
  const segs = {}; const tf = {};
  for (const r of sorted) {
    const s = SEG[Math.floor(new Date(r.time).getHours() / 6)];
    segs[s] = (segs[s] || 0) + 1;
    for (const t of (r.triggers || [])) tf[t] = (tf[t] || 0) + 1;
  }
  console.log('\n⏰ 时段分布:', Object.entries(segs).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join('  '));
  console.log('🎯 诱因 Top:', Object.entries(tf).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([t, c]) => `${t}:${c}`).join('  ') || '无');

  /* 连续 */
  let prev = goal.startedAt ? new Date(goal.startedAt).getTime() : 0;
  let best = 0, ongoing = false;
  for (const r of sorted) {
    const t = new Date(r.time).getTime();
    if (t - prev > best) best = t - prev;
    prev = t;
  }
  if (Date.now() - prev > best) { best = Date.now() - prev; ongoing = true; }
  console.log(`\n🏆 最长连续: ${(best / 86400000).toFixed(1)} 天${ongoing ? '（进行中）' : ''}`);
  console.log(`⏳ 当前连续: ${((Date.now() - prev) / 86400000).toFixed(1)} 天\n`);
}
