'use strict';
/* ============================================================
   AI 分析手动生成端点（与 cron worker 的生成逻辑保持一致）
   POST /api/generate-report  body {code}
   返回 {ok, report:{content, week, count}}
   注意：本文件与 ai-report/worker.js 需同步维护
   ============================================================ */

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

let schemaReady = null;
function ensureSchema(env) {
  if (!schemaReady) {
    schemaReady = env.abstinence_db
      .prepare(
        'CREATE TABLE IF NOT EXISTS accounts (' +
        'code TEXT PRIMARY KEY, goal TEXT, relapses TEXT, deleted TEXT, updated_at INTEGER, ' +
        'ai_report TEXT, ai_report_week TEXT)'
      )
      .run()
      .then(() => true)
      .catch(e => { schemaReady = null; throw e; });
  }
  return schemaReady;
}

function lastWeekRange() {
  const bj = new Date(Date.now() + 8 * 3600000);
  const day = (bj.getUTCDay() + 6) % 7;
  const thisMonUtcMs = Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate()) - day * 86400000 - 8 * 3600000;
  const lastMonUtcMs = thisMonUtcMs - 7 * 86400000;
  const labelStart = new Date(lastMonUtcMs + 8 * 3600000);
  const labelEnd = new Date(thisMonUtcMs + 8 * 3600000);
  const pad = n => String(n).padStart(2, '0');
  const f = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  return { start: lastMonUtcMs, end: thisMonUtcMs, weekLabel: `${f(labelStart)} ~ ${f(labelEnd)}` };
}

/* 全历史统计摘要（压缩数据，不含逐条原文） */
function buildHistorySummary(allRecords) {
  if (!allRecords.length) return '暂无任何历史记录。';
  const sorted = [...allRecords].sort((a, b) => new Date(a.time) - new Date(b.time));
  const pad = n => String(n).padStart(2, '0');
  const f = iso => { const d = new Date(iso); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

  /* 近 8 周趋势 */
  const bj = new Date(Date.now() + 8 * 3600000);
  const day = (bj.getUTCDay() + 6) % 7;
  let thisMonUtcMs = Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate()) - day * 86400000 - 8 * 3600000;
  const trend = [];
  for (let i = 7; i >= 0; i--) {
    const s = thisMonUtcMs - i * 7 * 86400000;
    const e = s + 7 * 86400000;
    const c = sorted.filter(r => { const t = new Date(r.time).getTime(); return t >= s && t < e; }).length;
    trend.push(c);
  }

  /* 诱因累计 & 时段分布 */
  const tf = {}; const segs = {};
  for (const r of sorted) {
    for (const t of (r.triggers || [])) tf[t] = (tf[t] || 0) + 1;
    const h = new Date(r.time).getHours();
    const seg = h < 6 ? '凌晨' : h < 12 ? '上午' : h < 18 ? '下午' : '晚上';
    segs[seg] = (segs[seg] || 0) + 1;
  }
  const topTf = Object.entries(tf).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([t, c]) => `${t}×${c}`).join('、') || '未填';

  /* 最长连续 */
  const goalStart = sorted.length ? null : null;
  let prev = Date.now(), best = 0;
  /* 从最早的记录反推：用记录间最大间隔近似 */
  prev = new Date(sorted[0].time).getTime();
  for (const r of sorted) { const t = new Date(r.time).getTime(); if (t - prev > best) best = t - prev; prev = t; }
  if (Date.now() - prev > best) best = Date.now() - prev;

  return [
    `总破戒 ${sorted.length} 次，首次记录于 ${f(sorted[0].time)}。`,
    `近 8 周趋势（从旧到新）：[${trend.join(', ')}]。`,
    `诱因累计排名：${topTf}。`,
    `时段分布：${Object.entries(segs).map(([k, v]) => `${k}${v}次`).join('、')}。`,
    `最长连续坚持约 ${(best / 86400000).toFixed(1)} 天，当前距上次破戒 ${((Date.now() - new Date(sorted[sorted.length - 1].time).getTime()) / 86400000).toFixed(1)} 天。`
  ].join('\n');
}

function buildPrompt(goal, weekRecords, range, allRecords) {
  const lines = [
    '你是一位温暖、专业的自律习惯教练。用户在使用一款「禁欲打卡」应用（帮助戒除不良习惯、坚持自律生活）。',
    '',
    '== 第一部分：用户的全历史统计摘要（压缩数据，用于长期视角） ==',
    buildHistorySummary(allRecords),
    goal.name ? `目标名称：${goal.name}；计划开始于 ${goal.startedAt}。` : '',
    '',
    `== 第二部分：上一周（${range.weekLabel}）的逐条明细 ==`,
    JSON.stringify(weekRecords),
    '字段说明：time=发生时间(ISO)，triggers=诱因标签数组，severity=严重程度1-5，note=用户当时写下的备注原文。',
    '',
    '请结合长期摘要与本周明细，输出一份中文周报，严格使用以下结构：',
    '【本周概览】2-3 句话总结次数与趋势',
    '【模式洞察】时段规律、诱因关联；如备注里有情绪描述，请具体回应它',
    '【长期观察】结合全历史数据指出进步、恶化或反复的轨迹（如无可略写）',
    '【下周建议】3 条具体可执行的小行动，每条一行，以 · 开头',
    '',
    '要求：语气像理解他的朋友，不说教不评判；总长不超过 400 字；直接输出内容，不要寒暄。'
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

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    await ensureSchema(env);
    const body = await request.json();
    const code = String(body.code || '').trim().toUpperCase();
    if (!code || code.length < 6) return json({ ok: false, error: '访问码无效' }, 400);

    const row = await env.abstinence_db
      .prepare('SELECT goal, relapses FROM accounts WHERE code = ?')
      .bind(code).first();
    if (!row) return json({ ok: false, error: '账号不存在' }, 404);

    let all = [];
    try { all = JSON.parse(row.relapses || '[]'); } catch (e) {}
    const goal = (() => { try { return JSON.parse(row.goal || '{}'); } catch (e) { return {}; } })();

    const range = lastWeekRange();
    const mapped = all
      .map(r => ({ time: r.time, triggers: r.triggers || [], severity: r.severity || 0, note: r.note || '' }));
    const weekRecords = mapped
      .filter(r => { const t = new Date(r.time).getTime(); return t >= range.start && t < range.end; })
      .sort((a, b) => new Date(a.time) - new Date(b.time));

    const content = await callDeepSeek(env, buildPrompt(goal, weekRecords, range, mapped));
    await env.abstinence_db
      .prepare('UPDATE accounts SET ai_report = ?, ai_report_week = ? WHERE code = ?')
      .bind(content, range.weekLabel, code)
      .run();

    return json({ ok: true, report: { content, week: range.weekLabel, count: weekRecords.length } });
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204 });
}
