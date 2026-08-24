'use strict';
/* ============================================================
   禁欲打卡 · 云端同步 API
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
        'code TEXT PRIMARY KEY, goal TEXT, relapses TEXT, deleted TEXT, updated_at INTEGER)'
      )
      .run()
      .then(() => true)
      .catch(e => { schemaReady = null; throw e; });
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
        .prepare('SELECT goal, relapses, deleted, ai_report, ai_report_week FROM accounts WHERE code = ?')
        .bind(code).first();
      if (!row) return json({ ok: false, error: '访问码不存在' }, 404);
      const relapses = JSON.parse(row.relapses || '[]');
      const deleted = JSON.parse(row.deleted || '{}');
      return json({
        ok: true,
        goal: JSON.parse(row.goal),
        relapses: applyDeleted(relapses, deleted),
        deleted,
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
      const clientDeleted = body.deleted || {};
      const row = await env.abstinence_db
        .prepare('SELECT goal, relapses, deleted FROM accounts WHERE code = ?')
        .bind(code).first();

      let mergedGoal, mergedRelapses, mergedDeleted;

      if (row) {
        const serverGoal = JSON.parse(row.goal);
        const serverRelapses = JSON.parse(row.relapses || '[]');
        const serverDeleted = JSON.parse(row.deleted || '{}');
        mergedGoal = !clientGoal ? serverGoal
          : !serverGoal ? clientGoal
          : (clientGoal.updatedAt || 0) >= (serverGoal.updatedAt || 0) ? clientGoal : serverGoal;
        mergedRelapses = mergeRecords(clientRelapses, serverRelapses);
        mergedDeleted = mergeDeleted(clientDeleted, serverDeleted);
        mergedRelapses = applyDeleted(mergedRelapses, mergedDeleted);
      } else {
        mergedGoal = clientGoal;
        mergedRelapses = clientRelapses;
        mergedDeleted = mergeDeleted(clientDeleted, {});
        mergedRelapses = applyDeleted(mergedRelapses, mergedDeleted);
      }

      const now = Date.now();
      await env.abstinence_db
        .prepare(
          'INSERT INTO accounts (code, goal, relapses, deleted, updated_at) VALUES (?, ?, ?, ?, ?) ' +
          'ON CONFLICT(code) DO UPDATE SET goal = excluded.goal, relapses = excluded.relapses, deleted = excluded.deleted, updated_at = excluded.updated_at'
        )
        .bind(code, JSON.stringify(mergedGoal), JSON.stringify(mergedRelapses), JSON.stringify(mergedDeleted), now)
        .run();

      return json({
        ok: true,
        goal: mergedGoal,
        relapses: mergedRelapses,
        deleted: mergedDeleted,
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
