'use strict';
/* ============================================================
   AI 分析服务（Cloudflare Worker + DeepSeek）
   端点：
     POST /       body {code}                  → 手动生成分析（唯一入口）
     POST /help   body {code,state,message,history} → 紧急求助干预
   - 无 Cron 定时任务：分析只在用户点击时生成
   - 分析区间 = 距上次分析以来（首次/久未分析则回溯 7 天）
   - 经 functions/api/generate-report.js 与 help.js 代理访问
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
        'ai_report TEXT, ai_report_week TEXT, diaries TEXT, plans TEXT, helps TEXT, ai_report_history TEXT)'
      )
      .run()
      .then(() => env.abstinence_db.prepare('ALTER TABLE accounts ADD COLUMN helps TEXT').run())
      .catch(() => {})
      .then(() => env.abstinence_db.prepare('ALTER TABLE accounts ADD COLUMN ai_report_history TEXT').run())
      .catch(() => {})
      .then(() => true);
  }
  return schemaReady;
}

/* 手动分析的时间窗口：从"上次分析的时刻"到现在
   （首次或久未分析则回溯 7 天；最少 1 天、最多 60 天，避免区间为空或过长） */
function analysisWindow(history) {
  const pad = n => String(n).padStart(2, '0');
  const f = ms => { const d = new Date(ms + 8 * 3600000); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };
  const now = Date.now();
  let start = now - 7 * 86400000;
  const stamps = (history || []).map(h => h.generatedAt || 0).filter(Boolean);
  if (stamps.length) {
    const last = Math.max(...stamps);
    if (now - last >= 1 * 86400000) start = Math.max(last, now - 60 * 86400000);
  }
  return { start, end: now, label: `${f(start)} ~ ${f(now)}` };
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

  /* 色情触发占比（全历史） */
  const rated = sorted.filter(r => typeof r.porn === 'boolean');
  const pornCnt = rated.filter(r => r.porn === true).length;
  const pornLine = rated.length
    ? `色情内容触发：有记录的 ${rated.length} 次中 ${pornCnt} 次伴随色情内容（占 ${Math.round((pornCnt / rated.length) * 100)}%），其余为纯生理冲动。`
    : '';

  return [
    `总破戒 ${sorted.length} 次，首次记录于 ${f(sorted[0].time)}。`,
    `近 8 周趋势（从旧到新）：[${trend.join(', ')}]。`,
    `诱因累计排名：${topTf}。`,
    `时段分布：${Object.entries(segs).map(([k, v]) => `${k}${v}次`).join('、')}。`,
    pornLine,
    `最长连续坚持约 ${(best / 86400000).toFixed(1)} 天，当前距上次破戒 ${((Date.now() - prev) / 86400000).toFixed(1)} 天。`
  ].filter(Boolean).join('\n');
}

function buildPrompt(goal, weekRecords, range, allRecords, weekDiaries, userPlans, reportHistory) {
  /* 预先统计上周时段分布，避免 AI 自己数错 */
  const segCount = { '凌晨(0-6点)': 0, '上午(6-12点)': 0, '下午(12-18点)': 0, '晚上(18-24点)': 0 };
  let weekPornYes = 0, weekPornNo = 0;
  for (const r of weekRecords) {
    const h = parseInt(String(r.time).slice(11, 13), 10);
    if (h < 6) segCount['凌晨(0-6点)']++;
    else if (h < 12) segCount['上午(6-12点)']++;
    else if (h < 18) segCount['下午(12-18点)']++;
    else segCount['晚上(18-24点)']++;
    if (r.porn === '看了色情内容') weekPornYes++;
    else if (r.porn === '没看色情(纯生理冲动)') weekPornNo++;
  }
  const segLine = weekRecords.length
    ? `上周时段分布（已统计好，直接采用，不要再自己数）：${Object.entries(segCount).map(([k, v]) => `${k} ${v}次`).join('、')}。`
    : '';
  const weekPornLine = (weekPornYes + weekPornNo)
    ? `上周色情情况（已统计好）：${weekPornYes} 次看了色情内容、${weekPornNo} 次没看。`
    : '';

  const lines = [
    '你是一位温暖、专业的自律习惯教练。用户在使用一款「自律打卡」应用（帮助戒除不良习惯、坚持自律生活）。',
    '',
    '== 第一部分：用户的全历史统计摘要（压缩数据，用于长期视角） ==',
    buildHistorySummary(allRecords),
    goal.name ? `目标名称：${goal.name}；计划开始于 ${goal.startedAt}。` : '',
    '',
    `== 第二部分：这一次要看的区间（${range.label}）内的破戒记录 ==`,
    JSON.stringify(weekRecords),
    '字段说明：time=发生时间（北京时间 YYYY-MM-DD HH:mm），triggers=诱因标签数组，severity=严重程度1-5，porn=这次破戒前是否看了色情内容（"看了色情内容"/"没看色情(纯生理冲动)"/"未填"），note=用户当时写下的备注原文。',
    segLine.replace('上周时段分布', '这段区间时段分布'),
    weekPornLine.replace('上周色情情况', '这段区间色情情况'),
    '',
    `== 第三部分：同一区间内的日记原文 ==`,
    weekDiaries.length ? JSON.stringify(weekDiaries) : '（这段区间没有写日记）',
    '字段说明：time=记录时间（北京时间 YYYY-MM-DD HH:mm，精确到分），mood=当天心情标记(😊开心 🙂不错 😐一般 😞低落 😫疲惫 😡烦躁)，content=用户亲笔写下的当日心情与经历。',
    weekDiaries.length ? '分析情绪线索时，可以对比日记时间与破戒时间的先后：日记先于破戒出现→该情绪可能是前兆信号；破戒之后才写→多是事后反思。' : '',
    '',
    '（以下只是可参考的角度，不必覆盖，也不必按顺序：时段与诱因的模式、porn 维度——若多数破戒伴随色情内容则"接触内容"才是起点；若多为纯生理冲动则重点在情绪与疲惫；本区间与全历史的差异；日记情绪与破戒的时序关联。）',
    '',
    (reportHistory && reportHistory.length
      ? '== 第四部分：你之前写给这位用户的报告（同一场连续对话，请接续它） ==\n' +
        reportHistory.map(h => `【${h.week}】\n${h.content}`).join('\n\n') + '\n' +
        '请注意：这是你与用户持续进行的对话。自然地接续之前的内容——之前你给过什么建议、指出过什么模式，这次的数据有没有印证或推翻它。如果之前的建议奏效就明确说出来，没奏效就换个思路。不要重复已经说过的话。'
      : ''),
    '',
    '== 现在，说你想说的 ==',
    '用户主动点了分析，想听你说说。你不必写"报告"——可以是一段话、几个观察、一个反问、只指出一件你觉得最重要的事，甚至可以先问他现在最关心什么。',
    '唯一的底线：',
    '· 基于数据说话，引用具体的次数、日期、时间点、日记原话。不要写放在谁身上都成立的空话。',
    '· 说点真的洞察——数据里别人看不出来的东西，尤其是"和之前比变了什么"。',
    '· 若在接续对话（见第四部分），接着上次的话说，不要像第一次见面那样重新开始。',
    '· 语气像理解他的朋友：不说教、不评判、不喊口号、不刻意煽情。',
    '· 想给建议就给，不想给也可以不给——不必为了凑数列行动清单。',
    '',
    '长度由你判断：该长则长，该短则短。直接输出内容，不要写"好的，以下是分析"这类开场白。'
  ];
  return lines.filter(Boolean).join('\n');
}

async function callDeepSeek(env, prompt, maxTokens = 800) {
  if (!env.DEEPSEEK_API_KEY) throw new Error('未配置 DEEPSEEK_API_KEY');
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.DEEPSEEK_API_KEY },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      max_tokens: maxTokens
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
    .prepare('SELECT goal, relapses, diaries, plans, ai_report_history FROM accounts WHERE code = ?')
    .bind(code).first();
  if (!row) throw new Error('账号不存在');

  let all = [];
  try { all = JSON.parse(row.relapses || '[]'); } catch (e) {}
  const goal = (() => { try { return JSON.parse(row.goal || '{}'); } catch (e) { return {}; } })();
  let allDiaries = [];
  try { allDiaries = JSON.parse(row.diaries || '[]'); } catch (e) {}
  /* 之前几期的报告（连续会话上下文） */
  let reportHistory = [];
  try { reportHistory = JSON.parse(row.ai_report_history || '[]'); } catch (e) {}
  const fullHistory = reportHistory;
  reportHistory = reportHistory.slice(-4); /* 只带最近 4 期，控制长度 */

  const range = analysisWindow(fullHistory);
  /* 是否看色情 → 可读标签（AI 按字面理解，用中文比布尔值更准） */
  const pornLabel = v => v === true ? '看了色情内容' : v === false ? '没看色情(纯生理冲动)' : '未填';
  /* 先按原始 ISO 过滤窗口内的记录，再把时间转成北京时间字符串给 AI */
  const weekRaw = all.filter(r => { const t = new Date(r.time).getTime(); return t >= range.start && t < range.end; });
  const weekRecords = weekRaw
    .map(r => ({ time: toBJStr(r.time), triggers: r.triggers || [], severity: r.severity || 0, porn: pornLabel(r.porn), note: (r.note || '').slice(0, 300) }))
    .sort((a, b) => a.time < b.time ? -1 : 1);
  const mapped = all.map(r => ({ time: r.time, triggers: r.triggers || [], severity: r.severity || 0, porn: pornLabel(r.porn), note: r.note || '' }));

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

  const content = await callDeepSeek(env, buildPrompt(goal, weekRecords, range, mapped, weekDiaries, null, reportHistory), 2000);

  /* 追加进会话历史（保留最近 12 期） */
  const history = [...fullHistory];
  history.push({ week: range.label, content, generatedAt: Date.now() });
  const trimmed = history.slice(-12);

  await env.abstinence_db
    .prepare('UPDATE accounts SET ai_report = ?, ai_report_week = ?, ai_report_history = ? WHERE code = ?')
    .bind(content, range.label, JSON.stringify(trimmed), code)
    .run();

  return { content, week: range.label, count: weekRecords.length, historyCount: trimmed.length };
}

/* ---------------- 紧急求助（IronMind 干预协议） ---------------- */

/* 状态路由：稳定 / 预警 / 冲动正浓 / 复发后 */
const URGE_STATES = {
  active_urge: '冲动正浓（active_urge）——正在渴望，语气紧迫',
  warning: '心神不宁（warning）——开始漂移，还没形成动力',
  stable: '平静（stable）——打卡或没有紧迫感',
  post_relapse: '刚破戒（post_relapse）——可能陷入羞耻或低落'
};

async function helpForAccount(env, code, state, message, history) {
  await ensureSchema(env);
  const row = await env.abstinence_db
    .prepare('SELECT goal, relapses, plans, diaries FROM accounts WHERE code = ?')
    .bind(code).first();
  if (!row) throw new Error('账号不存在');

  let all = [];
  try { all = JSON.parse(row.relapses || '[]'); } catch (e) {}
  const goal = (() => { try { return JSON.parse(row.goal || '{}'); } catch (e) { return {}; } })();
  let plans = [];
  try { plans = JSON.parse(row.plans || '[]'); } catch (e) {}
  let diaries = [];
  try { diaries = JSON.parse(row.diaries || '[]'); } catch (e) {}

  /* 当前连续与历史最长（天） */
  const sorted = [...all].sort((a, b) => new Date(a.time) - new Date(b.time));
  let prev = goal.startedAt ? new Date(goal.startedAt).getTime() : Date.now();
  let best = 0;
  for (const r of sorted) { const t = new Date(r.time).getTime(); if (t - prev > best) best = t - prev; prev = t; }
  if (Date.now() - prev > best) best = Date.now() - prev;
  const cur = Math.floor((Date.now() - prev) / 86400000);

  /* 最近诱因 */
  const tf = {};
  for (const r of all) for (const t of (r.triggers || [])) tf[t] = (tf[t] || 0) + 1;
  const topTf = Object.entries(tf).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([t]) => t).join('、') || '暂无记录';

  /* 最近 3 次破戒完整明细（北京时间，含诱因+备注+是否看色情） */
  const recentRelapses = sorted.slice(-3).reverse().map(r =>
    `${toBJStr(r.time)} 严重度${r.severity || '?'} 诱因[${(r.triggers || []).join(',') || '未填'}]` +
    `${r.porn === true ? ' 看了色情内容' : r.porn === false ? ' 未看色情(纯生理冲动)' : ''}` +
    `${r.note ? ' 备注「' + r.note + '」' : ''}`
  ).join('\n') || '（还没有破戒记录）';

  /* 色情触发占比 */
  const rated = all.filter(r => typeof r.porn === 'boolean');
  const pornCnt = rated.filter(r => r.porn === true).length;
  const pornLine = rated.length >= 3
    ? `有记录的 ${rated.length} 次破戒中，${pornCnt} 次伴随色情内容（${Math.round((pornCnt / rated.length) * 100)}%）。`
    : '';

  /* 最近 3 篇日记（情绪 + 内容） */
  const recentDiaries = [...diaries].sort((a, b) => (a.time || '') < (b.time || '') ? 1 : -1).slice(0, 3).map(d =>
    `${(d.time || '').slice(0, 16).replace('T', ' ')} ${d.mood || ''}「${(d.content || '').slice(0, 60)}」`
  ).join('\n') || '（还没写日记）';

  /* 当前北京时间，供 AI 计算"今天/昨天/前天"的相对时间 */
  const nowBJ = toBJStr(new Date().toISOString());

  const prompt = [
    '你是"刚守"式的自律教练——温暖、直接、务实。用户正处在戒除不良习惯的关键时刻，此刻 ta 需要的不是冷冰冰的方案，而是先被看见、再被拉一把。',
    '四条铁律：①绝不让用户感到羞耻——破戒是行为数据，不是道德失败；②不说教——不要解释这个行为为什么有害；③冲动状态下给身体指令用祈使句；④语言简短，别写成小作文，更不要用"别偷懒""你应该"这类评判性措辞。',
    '',
    `今天是：${nowBJ}（北京时间，现在是 ${new Date(new Date().getTime() + 8 * 3600000).getUTCHours()} 点）。`,
    '重要：当你引用用户的破戒时间时，务必根据"今天"这个日期来计算"今天/昨天/前天"的相对关系，不要臆断。如果拿不准，直接写具体日期（如"8月27日凌晨3点"），绝对不要猜成昨天。',
    '',
    '== 用户的历史数据（用于个性化共情，务必引用） ==',
    `目标「${goal.name || '自律'}」；当前已连续坚持 ${cur} 天，历史最长 ${Math.floor(best / 86400000)} 天。`,
    `近期高频诱因：${topTf}。`,
    pornLine,
    `最近破戒记录（北京时间）：\n${recentRelapses}`,
    `最近的日记心情：\n${recentDiaries}`,
    '',
    `当前状态：${URGE_STATES[state] || URGE_STATES.active_urge}`,
    `用户此刻说的话：${message ? '「' + message + '」' : '（ta 没说话，请根据最近日记的情绪和最近破戒的时段推断 ta 此刻的可能状态）'}`,
    history && history.length ? `\n== 本次对话历史（这是多轮对话，请自然接续，别再从头问起） ==\n${history.map(m => (m.role === 'user' ? '用户：' : '教练：') + m.content).join('\n')}` : '',
    '',
    '== 响应结构（务必严格遵循） ==',
    '第 0 步【先判疲惫】：如果用户提到"累、没睡好、困、精神不好、干了很久活、脑子转不动"等，说明 ta 是疲惫型冲动——此刻最该做的是休息，不是对抗。这种情况下：优先建议"现在躺下/闭眼/小睡 15-20 分钟/远离屏幕"这类恢复性动作，用关怀的语气，不要再让 ta 做深蹲或高强度脑力题。',
    '第一步【共情 · 所有状态都要先做】：用 1-2 句话让 ta 感到"你看见了我"。要同时做到：①呼应用户此刻说的话/情绪；②引用 ta 的一条具体数据建立联系（例如"你上次是在凌晨 3 点失眠时破戒的，现在又是深夜，难怪这么难熬"，或"你昨天日记写自己特别疲惫——疲惫正是意志力最容易失守的时候"）。禁止说空泛的"我理解你的感受"。',
    '第二步【按状态给行动】：',
    '- 冲动正浓（精力充沛型）：给一条身体动作（祈使句），再出一道"需要真正动脑、且有点意思"的题（逻辑谜/数字推理/回忆一件具体的事），不要出"1加到100"这种人人都会的题。',
    '- 心神不宁：点出 ta 在漂移，给一个立即行动。',
    '- 平静：简短肯定，问一个有用的问题。',
    '- 刚破戒：明确告诉 ta"这是一次数据点，不是判决"（结合历史最长连续，如"你曾连续 21 天，那不是运气"）；再给一句贴合情绪的历史人物语录；最后问"这件事发生在几点？告诉我，我在那个时段前提醒你。"',
    '第三步【邀请继续】：这是对话的一部分。可以自然地接上一句邀请（如"做完感觉怎么样？"或"如果冲动还在，就告诉我"），但不要问那种必须等回复才成立的话。',
    pornLine ? '注意：如果数据显示色情内容是 ta 的主要触发源，可以在共情时点出这个模式（"你的记录显示多半是看了内容之后发生的"），但不要说教。' : '',
    '',
    '整体要求：直接输出内容，不要解释你在做什么、不要加引号标题；总长不超过 220 字；语气像懂 ta 的朋友，温暖但不煽情。'
  ].filter(Boolean).join('\n');

  const text = await callDeepSeek(env, prompt, 600);
  return { reply: text, state, cur, best: Math.floor(best / 86400000) };
}

export default {
  /* 无定时任务：只有用户手动点"分析"时才会生成 */
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    /* 紧急求助：POST /help body {code, state, message} */
    if (request.method === 'POST' && url.pathname === '/help') {
      try {
        const body = await request.json();
        const code = String(body.code || '').trim().toUpperCase();
        if (!code) return json({ ok: false, error: '缺少访问码' }, 400);
        const state = ['active_urge', 'warning', 'stable', 'post_relapse'].includes(body.state) ? body.state : 'active_urge';
        const message = String(body.message || '').slice(0, 300);
        const history = Array.isArray(body.history) ? body.history.slice(-10).map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: String(m.content || '').slice(0, 400) })) : [];
        const data = await helpForAccount(env, code, state, message, history);
        return json({ ok: true, ...data });
      } catch (e) {
        return json({ ok: false, error: e.message }, 500);
      }
    }
    /* 手动分析端点：POST /  body {code} → 立即为该账号生成分析 */
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
