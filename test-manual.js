'use strict';
/* 临时：测试手动分析（新窗口 + 新 prompt） */
(async () => {
  const code = 'TVZDU3BK';
  const res = await fetch('https://abstinence-tracker.pages.dev/api/generate-report', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code })
  });
  const data = await res.json();
  if (!data.ok) { console.log('失败:', JSON.stringify(data)); return; }
  console.log('区间:', data.report.week, '| 区间内记录数:', data.report.count, '| 会话期数:', data.report.historyCount);
  console.log('\n--- 内容 ---\n' + data.report.content);
  console.log('\n--- 检查 ---');
  console.log('是否还套固定结构（【本周概览】等）:', /【本周概览】|【模式洞察】|【下周建议】/.test(data.report.content) ? '❌ 仍是模板' : '✅ 已放开');
  console.log('字数:', data.report.content.length);
})();
