// claudeClient 事件冒烟测试:验证它能驱动 bridge 事件流。
// 用法: AI_BACKEND=claude npx tsx scripts/claude-backend-smoke.mjs
import { claudeClient } from '../src/claude/client.ts';

const fired = { messageUpdated: 0, text: 0, reasoning: 0, tool: 0, permissionRequest: 0, sessionIdle: 0, sessionError: 0 };

claudeClient.on('messageUpdated', () => { fired.messageUpdated++; });
claudeClient.on('messagePartUpdated', (e) => {
  const t = e?.part?.type;
  if (t === 'text') { fired.text++; process.stdout.write(e.delta || ''); }
  else if (t === 'reasoning') fired.reasoning++;
  else if (t === 'tool') { fired.tool++; console.log(`\n[tool] ${e.part.tool ?? ''} status=${e.part.state?.status}`); }
});
claudeClient.on('permissionRequest', (e) => {
  fired.permissionRequest++;
  console.log(`\n[permissionRequest] tool=${e.tool} id=${e.permissionId} desc=${e.description}`);
  // 模拟用户在飞书点「允许」
  setTimeout(() => claudeClient.respondToPermission(e.sessionId, e.permissionId, true), 50);
});
claudeClient.on('sessionIdle', () => { fired.sessionIdle++; });
claudeClient.on('sessionError', (e) => { fired.sessionError++; console.error('\n[sessionError]', e?.error?.message); });

const ok = await claudeClient.connect();
console.log('connect:', ok);
if (!ok) process.exit(1);

const session = await claudeClient.createSession('smoke test');
console.log('session:', session.id);

await claudeClient.sendMessageAsync(session.id, '用 Bash 执行 `echo bridge-ok` 并告诉我输出。');

// 等事件流自然结束(sessionIdle)
await new Promise((r) => {
  const iv = setInterval(() => { if (fired.sessionIdle > 0) { clearInterval(iv); r(); } }, 200);
  setTimeout(() => { clearInterval(iv); r(); }, 90000);
});

console.log('\n\n=== 事件统计 ===');
console.log(fired);
const pass = fired.messageUpdated > 0 && fired.text > 0 && fired.tool > 0 && fired.permissionRequest > 0 && fired.sessionIdle > 0;
console.log('判定:', pass ? '✅ claudeClient 事件链路通' : '⚠️ 有事件未触发');
claudeClient.disconnect();
process.exit(pass ? 0 : 1);
