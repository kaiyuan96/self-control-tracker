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
        'ai_report TEXT, ai_report_week TEXT)'
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

function buildPrompt(goal, weekRecords, range) {
  const lines = [
    '你是一位温暖、专业的自律习惯教练。用户在使用一款「禁欲打卡」应用（帮助戒除不良习惯、坚持自律生活）。',
    `以下是用户上一周（${range.weekLabel}）的破戒记录 JSON 数组：`,
    JSON.stringify(weekRecords),
    '字段说明：time=发生时间(ISO)，triggers=诱因标签数组，severity=严重程度1-5，note=用户当时写下的备注原文。',
    goal.name ? `目标名称：${goal.name}；计划开始于 ${goal.startedAt}。` : '',
    '',
    '请输出一份中文周报，严格使用以下结构：',
    '【本周概览】用 2-3 句话总结次数与趋势',
    '【模式洞察】指出时段规律、诱因关联；如备注里有情绪描述，请具体回应它',
    '【下周建议】给出 3 条具体可执行的小行动，每条一行，以 · 开头',
    '',
    '要求：语气像理解他的朋友，不说教不评判；总长不超过 350 字；直接输出内容，不要寒暄。'
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
    .prepare('SELECT goal, relapses FROM accounts WHERE code = ?')
    .bind(code).first();
  if (!row) throw new Error('账号不存在');

  let all = [];
  try { all = JSON.parse(row.relapses || '[]'); } catch (e) {}
  const goal = (() => { try { return JSON.parse(row.goal || '{}'); } catch (e) { return {}; } })();

  const range = lastWeekRange();
  const weekRecords = all
    .map(r => ({
      time: r.time,
      triggers: r.triggers || [],
      severity: r.severity || 0,
      note: r.note || ''
    }))
    .filter(r => { const t = new Date(r.time).getTime(); return t >= range.start && t < range.end; })
    .sort((a, b) => new Date(a.time) - new Date(b.time));

  /* 上周零记录：也生成一份简短鼓励报告 */
  const content = await callDeepSeek(env, buildPrompt(goal, weekRecords, range));

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

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runWeeklyReports(env));
  },
  async fetch(request, env) {
    /* 手动触发端点：POST /  body {code} → 立即为该账号生成分析 */
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(request.url);
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
