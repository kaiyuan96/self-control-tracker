'use strict';
/* ============================================================
   AI 预案推荐端点（代理模式，转发到定时 Worker 的 /suggest）
   POST /api/suggest-plan  body {code}
   返回 {ok, suggestions:[{ifText, thenText}]}
   ============================================================ */

const REPORT_WORKER_URL = 'https://abstinence-report.kaixinyike06.workers.dev/suggest';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

export async function onRequestPost(context) {
  const { request } = context;
  try {
    const body = await request.json();
    const code = String(body.code || '').trim().toUpperCase();
    if (!code || code.length < 6) return json({ ok: false, error: '访问码无效' }, 400);

    const res = await fetch(REPORT_WORKER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code })
    });
    const data = await res.json().catch(() => ({ ok: false, error: '上游返回异常' }));
    return json(data, res.status);
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204 });
}
