'use strict';
/* ============================================================
   AI 分析手动生成端点（代理模式）
   POST /api/generate-report  body {code}
   内部转发到定时 Worker 的生成端点（Cloudflare 内网直达，
   不经公网；DeepSeek 密钥仅存在于 Worker 侧，单点管理）
   ============================================================ */

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

/* 定时 Worker 的手动触发地址（与 ai-report/wrangler.toml 同名项目） */
const REPORT_WORKER_URL = 'https://abstinence-report.kaixinyike06.workers.dev/';

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
