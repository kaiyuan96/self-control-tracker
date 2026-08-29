'use strict';
/* ============================================================
   自律打卡 · 云端同步 API
   端点：
     GET  /api/sync?code=XXXX  拉取该访问码的数据
     POST /api/sync            上传并合并数据
   存储：单账号一行，goal + relapses(JSON) + deleted(JSON)
   合并：按记录 updatedAt 取新版本，删除以时间戳裁决
   ============================================================ */

/* 同源请求无需 CORS，保留头部以便未来扩展移动端 */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400'
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS }
  });
}

/* 按 id 合并记录，updatedAt 新者胜出 */
function mergeRecords(clientList, serverList) {
  const map = new Map();
  const touch = rec => {
    const cur = map.get(rec.id);
    if (!cur || (rec.updatedAt || 0) > (cur.updatedAt || 0)) map.set(rec.id, rec);
  };
  for (const r of clientList) touch(r);
  for (const r of serverList) touch(r);
  return [...map.values()];
}

/* 删除标记合并：取更大的时间戳 */
function mergeDeleted(clientDel, serverDel) {
  const del = {};
  for (const [id, ts] of Object.entries(clientDel || {})) del[id] = ts;
  for (const [id, ts] of Object.entries(serverDel || {})) {
    if (del[id] == null || ts > del[id]) del[id] = ts;
  }
  return del;
}

/* 应用删除标记：删除时间不早于记录最后修改 → 剔除 */
function applyDeleted(relapses, deleted) {
  return relapses.filter(rec => {
    const ts = deleted[rec.id];
    return !(ts != null && ts >= (rec.updatedAt || 0));
  });
}

let schemaReady = null;
function ensureSchema(env) {
  if (!schemaReady) {
    schemaReady = env.abstinence_db
      .prepare(
        'CREATE TABLE IF NOT EXISTS accounts (' +
        'code TEXT PRIMARY KEY, goal TEXT, relapses TEXT, deleted TEXT, updated_at INTEGER, ' +
        'ai_report TEXT, ai_report_week TEXT, diaries TEXT, plans TEXT, helps TEXT)'
      )
      .run()
      .then(() => env.abstinence_db.prepare('ALTER TABLE accounts ADD COLUMN helps TEXT').run())
      .catch(() => {}) /* helps 列已存在时忽略 */
      .then(() => true);
  }
  return schemaReady;
}

async function handleSync(request, env) {
  const url = new URL(request.url);
  try {
    await ensureSchema(env);

    if (request.method === 'GET') {
      const code = (url.searchParams.get('code') || '').trim().toUpperCase();
      if (!code) return json({ ok: false, error: '缺少访问码' }, 400);
      const row = await env.abstinence_db
        .prepare('SELECT goal, relapses, deleted, ai_report, ai_report_week, diaries, plans, helps FROM accounts WHERE code = ?')
        .bind(code).first();
      if (!row) return json({ ok: false, error: '访问码不存在' }, 404);
      const relapses = JSON.parse(row.relapses || '[]');
      const deleted = JSON.parse(row.deleted || '{}');
      let diaries = [];
      try { diaries = applyDeleted(JSON.parse(row.diaries || '[]'), deleted); } catch (e) {}
      let plans = [];
      try { plans = applyDeleted(JSON.parse(row.plans || '[]'), deleted); } catch (e) {}
      let helps = [];
      try { helps = applyDeleted(JSON.parse(row.helps || '[]'), deleted); } catch (e) {}
      return json({
        ok: true,
        goal: JSON.parse(row.goal),
        relapses: applyDeleted(relapses, deleted),
        deleted,
        diaries,
        plans,
        helps,
        aiReport: row.ai_report ? { content: row.ai_report, week: row.ai_report_week || '' } : null,
        serverTime: Date.now()
      });
    }

    if (request.method === 'POST') {
      const body = await request.json();
      const code = String(body.code || '').trim().toUpperCase();
      if (!code || code.length < 6) return json({ ok: false, error: '访问码无效' }, 400);

      const clientGoal = body.goal || null;
      const clientRelapses = Array.isArray(body.relapses) ? body.relapses : [];
      const clientDiaries = Array.isArray(body.diaries) ? body.diaries : [];
      const clientPlans = Array.isArray(body.plans) ? body.plans : [];
      const clientHelps = Array.isArray(body.helps) ? body.helps : [];
      const clientDeleted = body.deleted || {};
      const row = await env.abstinence_db
        .prepare('SELECT goal, relapses, deleted, diaries, plans, helps FROM accounts WHERE code = ?')
        .bind(code).first();

      let mergedGoal, mergedRelapses, mergedDeleted, mergedDiaries, mergedPlans, mergedHelps;

      if (row) {
        const serverGoal = JSON.parse(row.goal);
        const serverRelapses = JSON.parse(row.relapses || '[]');
        const serverDeleted = JSON.parse(row.deleted || '{}');
        let serverDiaries = [];
        try { serverDiaries = JSON.parse(row.diaries || '[]'); } catch (e) {}
        let serverPlans = [];
        try { serverPlans = JSON.parse(row.plans || '[]'); } catch (e) {}
        let serverHelps = [];
        try { serverHelps = JSON.parse(row.helps || '[]'); } catch (e) {}
        mergedGoal = !clientGoal ? serverGoal
          : !serverGoal ? clientGoal
          : (clientGoal.updatedAt || 0) >= (serverGoal.updatedAt || 0) ? clientGoal : serverGoal;
        const allDeleted = mergeDeleted(clientDeleted, serverDeleted);
        mergedRelapses = applyDeleted(mergeRecords(clientRelapses, serverRelapses), allDeleted);
        mergedDiaries = applyDeleted(mergeRecords(clientDiaries, serverDiaries), allDeleted);
        mergedPlans = applyDeleted(mergeRecords(clientPlans, serverPlans), allDeleted);
        mergedHelps = applyDeleted(mergeRecords(clientHelps, serverHelps), allDeleted);
        mergedDeleted = allDeleted;
      } else {
        mergedGoal = clientGoal;
        mergedRelapses = clientRelapses;
        mergedDiaries = clientDiaries;
        mergedPlans = clientPlans;
        mergedHelps = clientHelps;
        mergedDeleted = mergeDeleted(clientDeleted, {});
        mergedRelapses = applyDeleted(mergedRelapses, mergedDeleted);
      }

      const now = Date.now();
      await env.abstinence_db
        .prepare(
          'INSERT INTO accounts (code, goal, relapses, deleted, updated_at, diaries, plans, helps) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ' +
          'ON CONFLICT(code) DO UPDATE SET goal = excluded.goal, relapses = excluded.relapses, deleted = excluded.deleted, updated_at = excluded.updated_at, diaries = excluded.diaries, plans = excluded.plans, helps = excluded.helps'
        )
        .bind(code, JSON.stringify(mergedGoal), JSON.stringify(mergedRelapses), JSON.stringify(mergedDeleted), now, JSON.stringify(mergedDiaries), JSON.stringify(mergedPlans), JSON.stringify(mergedHelps))
        .run();

      /* 回传最新 AI 报告（如有），客户端同步时一并拿到 */
      const after = await env.abstinence_db
        .prepare('SELECT ai_report, ai_report_week FROM accounts WHERE code = ?')
        .bind(code).first();

      return json({
        ok: true,
        goal: mergedGoal,
        relapses: mergedRelapses,
        deleted: mergedDeleted,
        diaries: mergedDiaries,
        plans: mergedPlans,
        helps: mergedHelps,
        aiReport: after && after.ai_report ? { content: after.ai_report, week: after.ai_report_week || '' } : null,
        serverTime: now
      });
    }

    return json({ ok: false, error: 'Method Not Allowed' }, 405);
  } catch (err) {
    return json({ ok: false, error: '服务器错误: ' + err.message }, 500);
  }
}

export async function onRequestGet(context) {
  return handleSync(context.request, context.env);
}

export async function onRequestPost(context) {
  return handleSync(context.request, context.env);
}

export async function onRequestOptions() {
  return new Response(null, { headers: CORS });
}
