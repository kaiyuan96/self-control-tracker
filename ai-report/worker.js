'use strict';
/* ============================================================
   每周 AI 分析定时任务（Cloudflare Cron Worker + DeepSeek）
   - Cron：每周一 UTC 00:00（北京 08:00）为所有账号生成上周分析
   - 逻辑与 functions/api/generate-report.js 保持一致
     （两处需同步维护：generateReportForAccount / buildPrompt / lastWeekRange）
   ============================================================ */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400'
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS }
  });
}

let schemaReady = null;
function ensureSchema(env) {
  if (!schemaReady) {
    schemaReady = env.abstinence_db
      .prepare(
        'CREATE TABLE IF NOT EXISTS accounts (' +
        'code TEXT PRIMARY KEY, goal TEXT, relapses TEXT, deleted TEXT, updated_at INTEGER, ' +
        'ai_report TEXT, ai_report_week TEXT, diaries TEXT, plans TEXT)'
      )
      .run()
      .then(() => true)
      .catch(e => { schemaReady = null; throw e; });
  }
  return schemaReady;
}

/* 北京时间视角的"上周一 00:00 ~ 本周一 00:00"（返回 UTC 毫秒） */
function lastWeekRange() {
  const bj = new Date(Date.now() + 8 * 3600000);   // 北京时间
  const day = (bj.getUTCDay() + 6) % 7;            // 0=周一
  const thisMonUtcMs = Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate()) - day * 86400000 - 8 * 3600000;
  const lastMonUtcMs = thisMonUtcMs - 7 * 86400000;
  const labelStart = new Date(lastMonUtcMs + 8 * 3600000);
  const labelEnd = new Date(thisMonUtcMs + 8 * 3600000);
  const pad = n => String(n).padStart(2, '0');
  const f = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  return { start: lastMonUtcMs, end: thisMonUtcMs, weekLabel: `${f(labelStart)} ~ ${f(labelEnd)}` };
}

/* ISO → 北京时间字符串（AI 按字面阅读，必须给本地时间） */
function toBJStr(iso) {
  const d = new Date(new Date(iso).getTime() + 8 * 3600000);
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}
/* ISO → 北京小时数 */
function toBJHour(iso) {
  return new Date(new Date(iso).getTime() + 8 * 3600000).getUTCHours();
}

/* 全历史统计摘要（压缩数据，不含逐条原文） */
function buildHistorySummary(allRecords) {
  if (!allRecords.length) return '暂无任何历史记录。';
  const sorted = [...allRecords].sort((a, b) => new Date(a.time) - new Date(b.time));
  const f = iso => toBJStr(iso).slice(0, 10);

  const bj = new Date(Date.now() + 8 * 3600000);
  const day = (bj.getUTCDay() + 6) % 7;
  const thisMonUtcMs = Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate()) - day * 86400000 - 8 * 3600000;
  const trend = [];
  for (let i = 7; i >= 0; i--) {
    const s = thisMonUtcMs - i * 7 * 86400000;
    const e = s + 7 * 86400000;
    const c = sorted.filter(r => { const t = new Date(r.time).getTime(); return t >= s && t < e; }).length;
    trend.push(c);
  }

  const tf = {}; const segs = {};
  for (const r of sorted) {
    for (const t of (r.triggers || [])) tf[t] = (tf[t] || 0) + 1;
    const h = toBJHour(r.time); /* 时区修正后的北京小时 */
    const seg = h < 6 ? '凌晨' : h < 12 ? '上午' : h < 18 ? '下午' : '晚上';
    segs[seg] = (segs[seg] || 0) + 1;
  }
  const topTf = Object.entries(tf).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([t, c]) => `${t}×${c}`).join('、') || '未填';

  let prev = new Date(sorted[0].time).getTime(), best = 0;
  for (const r of sorted) { const t = new Date(r.time).getTime(); if (t - prev > best) best = t - prev; prev = t; }
  if (Date.now() - prev > best) best = Date.now() - prev;

  return [
    `总破戒 ${sorted.length} 次，首次记录于 ${f(sorted[0].time)}。`,
    `近 8 周趋势（从旧到新）：[${trend.join(', ')}]。`,
    `诱因累计排名：${topTf}。`,
    `时段分布：${Object.entries(segs).map(([k, v]) => `${k}${v}次`).join('、')}。`,
    `最长连续坚持约 ${(best / 86400000).toFixed(1)} 天，当前距上次破戒 ${((Date.now() - prev) / 86400000).toFixed(1)} 天。`
  ].join('\n');
}

function buildPrompt(goal, weekRecords, range, allRecords, weekDiaries, userPlans) {
  const lines = [
    '你是一位温暖、专业的自律习惯教练。用户在使用一款「禁欲打卡」应用（帮助戒除不良习惯、坚持自律生活）。',
    '',
    '== 第一部分：用户的全历史统计摘要（压缩数据，用于长期视角） ==',
    buildHistorySummary(allRecords),
    goal.name ? `目标名称：${goal.name}；计划开始于 ${goal.startedAt}。` : '',
    '',
    `== 第二部分：上一周（${range.weekLabel}）的破戒记录逐条明细 ==`,
    JSON.stringify(weekRecords),
    '字段说明：time=发生时间（北京时间 YYYY-MM-DD HH:mm），triggers=诱因标签数组，severity=严重程度1-5，note=用户当时写下的备注原文。',
    '',
    '== 第三部分：上一周的日记原文 ==',
    weekDiaries.length ? JSON.stringify(weekDiaries) : '（上周未写日记）',
    '字段说明：time=记录时间（北京时间 YYYY-MM-DD HH:mm，精确到分），mood=当天心情标记(😊开心 🙂不错 😐一般 😞低落 😫疲惫 😡烦躁)，content=用户亲笔写下的当日心情与经历。',
    '',
    '== 第四部分：用户的"如果-那么"预案卡及使用情况 ==',
    (userPlans && userPlans.length) ? JSON.stringify(userPlans) : '（用户还没有建立任何预案）',
    '字段说明：if=触发情境，then=预定动作，missed=破戒时没执行该预案的次数，used=执行了但未拦住的次数。',
    '',
    '请结合长期摘要、本周明细、日记原文与预案使用情况，输出一份中文周报，严格使用以下结构：',
    '【本周概览】2-3 句话总结次数与趋势',
    '【模式洞察】时段规律、诱因关联；请把日记里的情绪线索与破戒记录相互印证——注意对比每篇日记的记录时间与破戒发生时间的先后顺序：日记先于破戒出现说明该情绪可能是前兆信号，破戒之后才写的日记则更多是事后感受与反思；如备注或日记里有情绪描述，请具体回应它',
    '【长期观察】结合全历史数据指出进步、恶化或反复的轨迹（如无可略写）',
    '【下周建议】3 条具体可执行的小行动，每条一行，以 · 开头；若用户已有预案，请结合 missed/used 数据评估哪张需要修改；若没有预案，第 1 条建议改为引导建立第一张兜底预案（离开现场+等待10分钟）',
    '',
    '要求：语气像理解他的朋友，不说教不评判；总长不超过 450 字；直接输出内容，不要寒暄。'
  ];
  return lines.filter(Boolean).join('\n');
}

async function callDeepSeek(env, prompt) {
  if (!env.DEEPSEEK_API_KEY) throw new Error('未配置 DEEPSEEK_API_KEY');
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.DEEPSEEK_API_KEY },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      max_tokens: 800
    })
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error('DeepSeek API 错误 ' + res.status + ': ' + t.slice(0, 200));
  }
  const data = await res.json();
  const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!text) throw new Error('AI 返回为空');
  return text.trim();
}

async function generateReportForAccount(env, code) {
  await ensureSchema(env);
  const row = await env.abstinence_db
    .prepare('SELECT goal, relapses, diaries FROM accounts WHERE code = ?')
    .bind(code).first();
  if (!row) throw new Error('账号不存在');

  let all = [];
  try { all = JSON.parse(row.relapses || '[]'); } catch (e) {}
  const goal = (() => { try { return JSON.parse(row.goal || '{}'); } catch (e) { return {}; } })();
  let allDiaries = [];
  try { allDiaries = JSON.parse(row.diaries || '[]'); } catch (e) {}

  const range = lastWeekRange();
  /* 先按原始 ISO 过滤上周，再把时间转成北京时间字符串给 AI */
  const weekRaw = all.filter(r => { const t = new Date(r.time).getTime(); return t >= range.start && t < range.end; });
  const weekRecords = weekRaw
    .map(r => ({ time: toBJStr(r.time), triggers: r.triggers || [], severity: r.severity || 0, note: (r.note || '').slice(0, 300) }))
    .sort((a, b) => a.time < b.time ? -1 : 1);
  const mapped = all.map(r => ({ time: r.time, triggers: r.triggers || [], severity: r.severity || 0, note: r.note || '' }));

  const weekDiaries = allDiaries
    .map(d => {
      /* 兼容旧格式（仅 date）→ 归一化为北京时间 time 字符串 */
      const t = d.time || (d.date ? d.date + ' 12:00' : '');
      return { time: t, mood: d.mood || '', content: (d.content || '').slice(0, 500) };
    })
    .filter(d => d.time)
    .map(d => ({ ...d, _ts: new Date(d.time.replace(' ', 'T') + '+08:00').getTime() }))
    .filter(d => { const t = d._ts; return t >= range.start && t < range.end; })
    .sort((a, b) => a.time < b.time ? -1 : 1)
    .map(({ _ts, ...d }) => d);

  /* 上周零记录：也生成一份简短鼓励报告 */
  let userPlans = [];
  try { userPlans = JSON.parse(row.plans || '[]'); } catch (e) {}
  const planData = userPlans.map(p => ({ if: p.ifText, then: p.thenText, missed: p.missed || 0, used: p.used || 0 }));
  const content = await callDeepSeek(env, buildPrompt(goal, weekRecords, range, mapped, weekDiaries, planData));

  await env.abstinence_db
    .prepare('UPDATE accounts SET ai_report = ?, ai_report_week = ? WHERE code = ?')
    .bind(content, range.weekLabel, code)
    .run();

  return { content, week: range.weekLabel, count: weekRecords.length };
}

async function runWeeklyReports(env) {
  await ensureSchema(env);
  const rows = await env.abstinence_db.prepare('SELECT code FROM accounts').all();
  for (const r of rows.results) {
    try {
      await generateReportForAccount(env, r.code);
      console.log('report ok:', r.code.slice(0, 3) + '***');
    } catch (e) {
      console.error('report failed:', r.code.slice(0, 3) + '***', e.message);
    }
  }
}

/* AI 预案推荐：基于账号历史诱因/时段生成 3 条 if-then 预案候选 */
async function suggestPlansForAccount(env, code) {
  await ensureSchema(env);
  const row = await env.abstinence_db
    .prepare('SELECT goal, relapses, diaries, plans FROM accounts WHERE code = ?')
    .bind(code).first();
  if (!row) throw new Error('账号不存在');

  let all = [];
  try { all = JSON.parse(row.relapses || '[]'); } catch (e) {}
  let plans = [];
  try { plans = JSON.parse(row.plans || '[]'); } catch (e) {}
  const goal = (() => { try { return JSON.parse(row.goal || '{}'); } catch (e) { return {}; } })();

  /* 高频诱因与高危时段（北京时间） */
  const tf = {}; const segs = {};
  for (const r of all) {
    for (const t of (r.triggers || [])) tf[t] = (tf[t] || 0) + 1;
    const h = toBJHour(r.time);
    const seg = h < 6 ? '凌晨' : h < 12 ? '上午' : h < 18 ? '下午' : '晚上';
    segs[seg] = (segs[seg] || 0) + 1;
  }
  const topTf = Object.entries(tf).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([t, c]) => `${t}(${c}次)`);
  const topSegs = Object.entries(segs).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}${v}次`);
  const existingPlans = plans.map(p => ({ if: p.ifText, then: p.thenText }));

  const prompt = [
    '你是一位自律习惯教练。用户在用一款「禁欲打卡」应用，需要建立"如果-那么"执行意图预案卡来应对冲动。',
    goal.name ? `目标：${goal.name}。` : '',
    `历史高频诱因：${topTf.length ? topTf.join('、') : '暂无记录'}；高危时段：${topSegs.length ? topSegs.join('、') : '暂无记录'}。`,
    existingPlans.length ? `已有预案：${JSON.stringify(existingPlans)}（新建议须与它们不同）。` : '尚无预案。',
    '',
    '请生成 3 条预案候选，严格输出 JSON 数组（不要任何其他文字、不要 markdown 代码块标记）：',
    '[{"if":"具体情境（含时间/地点/状态，20字内）","then":"立刻可执行的具体动作（30字内，从物理离开现场/冷刺激/身体消耗/注意力切换/延迟等待/呼吸调节中选择组合）"}]',
    '要求：每条针对不同诱因场景；动作必须 10 秒内能开始执行；语气平实不说教。'
  ].filter(Boolean).join('\n');

  const text = await callDeepSeek(env, prompt);
  /* 容错解析 JSON 数组 */
  const start = text.indexOf('['); const end = text.lastIndexOf(']');
  if (start === -1 || end === -1) throw new Error('AI 返回格式异常');
  const arr = JSON.parse(text.slice(start, end + 1));
  const suggestions = (Array.isArray(arr) ? arr : [])
    .filter(s => s && s.if && s.then)
    .slice(0, 3)
    .map(s => ({ ifText: String(s.if).slice(0, 60), thenText: String(s.then).slice(0, 100) }));
  if (!suggestions.length) throw new Error('AI 未返回有效预案');
  return { suggestions };
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runWeeklyReports(env));
  },
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/suggest') {
      try {
        const body = await request.json();
        const code = String(body.code || '').trim().toUpperCase();
        if (!code) return json({ ok: false, error: '缺少访问码' }, 400);
        const data = await suggestPlansForAccount(env, code);
        return json({ ok: true, ...data });
      } catch (e) {
        return json({ ok: false, error: e.message }, 500);
      }
    }
    /* 手动触发端点：POST /  body {code} → 立即为该账号生成分析 */
    if (request.method === 'POST' && url.pathname === '/') {
      try {
        const body = await request.json();
        const code = String(body.code || '').trim().toUpperCase();
        if (!code) return json({ ok: false, error: '缺少访问码' }, 400);
        const report = await generateReportForAccount(env, code);
        return json({ ok: true, report });
      } catch (e) {
        return json({ ok: false, error: e.message }, 500);
      }
    }
    return json({ ok: false, error: 'Not Found' }, 404);
  }
};
