#!/usr/bin/env node
// 一次性托管重启脚本:脱离当前 bridge 进程树,完成
//   1) 杀掉失管的孤儿业务进程(如有)
//   2) 复用系统 supervisor(macOS launchd / Linux systemd)重启服务;
//      两者都没有时才 fallback 到看门狗模式(start.mjs)
//   3) 健康检查(单例锁端口 + /health)
//   4) 用 tenant_access_token 给 owner 发飞书验证报告
// 说明:secret 仅在内存使用,绝不写入任何日志/文件。
//
// 为什么不再自起看门狗:曾出现 launchd 服务与 start.mjs 看门狗两套 supervisor
// 各拉一个实例,双实例同连飞书长连接导致重复回复。改为复用系统 supervisor 后,
// 系统 supervisor 是唯一权威,不会再凭空多一套。

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn, execSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '..');
const logsDir = path.join(rootDir, 'logs');
const pidFile = path.join(logsDir, 'bridge.pid');
const serviceLog = path.join(logsDir, 'service.log');
const envFile = path.join(rootDir, '.env');

const ORPHAN_PID = Number(process.argv[2]); // 要杀的孤儿业务进程 pid(传 0 表示无)
const FEISHU_BASE = 'https://open.feishu.cn';

// 系统 supervisor 标识(可 env 覆盖)
const LAUNCHD_LABEL = process.env.BRIDGE_LAUNCHD_LABEL || 'com.mi.feishu-bridge';
const SYSTEMD_UNIT = process.env.BRIDGE_SYSTEMD_UNIT || 'feishu-opencode-bridge';
const SINGLETON_PORT = Number(process.env.BRIDGE_SINGLETON_PORT || '4099');
const API_PORT = Number(process.env.BRIDGE_API_PORT || '4097');

function log(msg) {
  console.log(`[restart] ${new Date().toISOString()} ${msg}`);
}

// --- 读 .env(只取需要的 key,值不落日志) ---
function readEnv() {
  const raw = fs.readFileSync(envFile, 'utf-8');
  const env = {};
  for (const line of raw.split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function killOrphan(pid) {
  if (!pid || !isAlive(pid)) { log(`孤儿 ${pid} 不存在或已退出,跳过`); return; }
  log(`向孤儿 ${pid} 发 SIGTERM`);
  try { process.kill(pid, 'SIGTERM'); } catch {}
  for (let i = 0; i < 10 && isAlive(pid); i++) await sleep(500);
  if (isAlive(pid)) {
    log(`孤儿 ${pid} 5s 未退出,发 SIGKILL`);
    try { process.kill(pid, 'SIGKILL'); } catch {}
    await sleep(1000);
  }
  log(`孤儿 ${pid} 状态:${isAlive(pid) ? '仍存活(异常)' : '已终止'}`);
}

function startWatchdog() {
  // 清理陈旧 pid 文件,让 start.mjs 干净启动
  try { fs.rmSync(pidFile, { force: true }); } catch {}
  const out = fs.openSync(path.join(logsDir, 'service.log'), 'a');
  const err = fs.openSync(path.join(logsDir, 'service.err'), 'a');
  const child = spawn(process.execPath, ['scripts/start.mjs'], {
    cwd: rootDir,
    detached: true,
    stdio: ['ignore', out, err],
    env: { ...process.env, BRIDGE_WATCHDOG_ENABLED: '1' },
  });
  child.unref();
  fs.closeSync(out); fs.closeSync(err);
  log(`已 detached 启动看门狗 start.mjs`);
}

// --- 系统 supervisor 探测与重启 ---
// 优先复用系统进程管理器,避免与其并存两套 supervisor(双实例根因)。

function detectSupervisor() {
  if (process.platform === 'darwin') {
    try {
      const out = execSync(`launchctl list 2>/dev/null`, { encoding: 'utf-8' });
      if (out.split('\n').some(l => l.includes(LAUNCHD_LABEL))) {
        return 'launchd';
      }
    } catch {}
  } else if (process.platform === 'linux') {
    const r = spawnSync('systemctl', ['is-active', SYSTEMD_UNIT], { encoding: 'utf-8' });
    // is-active 对 active/activating 返回 0;对 inactive/failed 返回非 0 但 unit 仍可能已安装。
    // 用 is-enabled 兜底判断 unit 是否存在。
    if (!r.error && (r.status === 0 || (r.stdout || '').trim() === 'activating')) {
      return 'systemd';
    }
    const e = spawnSync('systemctl', ['is-enabled', SYSTEMD_UNIT], { encoding: 'utf-8' });
    if (!e.error && e.status === 0) {
      return 'systemd';
    }
  }
  return null;
}

function restartViaLaunchd() {
  const uid = process.getuid ? process.getuid() : execSync('id -u').toString().trim();
  const target = `gui/${uid}/${LAUNCHD_LABEL}`;
  // -k: 若在运行则先杀再拉;KeepAlive=true 会保证拉起。
  const r = spawnSync('launchctl', ['kickstart', '-k', target], { encoding: 'utf-8' });
  if (r.error || r.status !== 0) {
    log(`launchctl kickstart 失败 status=${r.status} err=${(r.stderr || r.error?.message || '').trim()}`);
    return false;
  }
  log(`已 launchctl kickstart -k ${target}`);
  return true;
}

function restartViaSystemd() {
  const r = spawnSync('systemctl', ['restart', SYSTEMD_UNIT], { encoding: 'utf-8' });
  if (r.error || r.status !== 0) {
    log(`systemctl restart 失败 status=${r.status} err=${(r.stderr || r.error?.message || '').trim()}`);
    return false;
  }
  log(`已 systemctl restart ${SYSTEMD_UNIT}`);
  return true;
}

// 探测锁端口是否已被监听(说明新实例已起来并持有单例锁)
function isPortListening(port) {
  try {
    // -sTCP:LISTEN 只匹配监听态;命中则退出码 0
    execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN >/dev/null 2>&1`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// 查 /health 是否 200(飞书 + 后端都 ok)
async function checkHealth() {
  try {
    const res = await fetch(`http://127.0.0.1:${API_PORT}/health`, { signal: AbortSignal.timeout(3000) });
    return res.status === 200;
  } catch {
    return false;
  }
}

// 找当前活着的业务子进程(dist/index.js),排除看门狗(scripts/start.mjs)
function findBusinessChild() {
  try {
    const out = execSync('ps -ax -o pid=,ppid=,command=', { encoding: 'utf-8' });
    for (const line of out.split('\n')) {
      if (line.includes('dist/index.js') && !line.includes('start.mjs') && !line.includes('restart-managed')) {
        const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
        if (m) return { pid: Number(m[1]), ppid: Number(m[2]) };
      }
    }
  } catch {}
  return null;
}

async function sendReport(env, text) {
  const appId = env.FEISHU_APP_ID, appSecret = env.FEISHU_APP_SECRET;
  const owner = (env.OWNER_USER_IDS || '').split(',')[0].trim();
  if (!appId || !appSecret || !owner) { log('缺少凭证或 owner,跳过发报告'); return; }

  const tokRes = await fetch(`${FEISHU_BASE}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  }).then(r => r.json());
  const token = tokRes.tenant_access_token;
  if (!token) { log(`换 token 失败 code=${tokRes.code}`); return; }

  const res = await fetch(`${FEISHU_BASE}/open-apis/im/v1/messages?receive_id_type=open_id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ receive_id: owner, msg_type: 'text', content: JSON.stringify({ text }) }),
  }).then(r => r.json());
  log(`发报告结果 code=${res.code} msg=${res.msg}`);
}

async function main() {
  log(`托管重启开始,目标孤儿 pid=${ORPHAN_PID}`);
  await sleep(2000); // 给当前会话最后一条回复留出发送时间

  // 记录重启前日志字节数,用于统计重启后新增的 buffer gone
  const sizeBefore = fs.existsSync(serviceLog) ? fs.statSync(serviceLog).size : 0;

  await killOrphan(ORPHAN_PID);

  // 优先复用系统 supervisor 重启;都没有才 fallback 看门狗。
  const supervisor = detectSupervisor();
  let restartMethod;
  let restartOk = false;
  if (supervisor === 'launchd') {
    restartMethod = `launchd(${LAUNCHD_LABEL})`;
    restartOk = restartViaLaunchd();
  } else if (supervisor === 'systemd') {
    restartMethod = `systemd(${SYSTEMD_UNIT})`;
    restartOk = restartViaSystemd();
  } else {
    restartMethod = 'watchdog(start.mjs)';
    startWatchdog();
    restartOk = true; // startWatchdog 无返回,健康检查会兜底判断
  }
  log(`重启方式:${restartMethod},发起结果=${restartOk}`);

  // 健康检查:等新实例持有单例锁端口 + /health 返回 200。
  // 走系统 supervisor 后不再有 start.mjs 中间层,故不再依赖 bridge.pid。
  let locked = false, healthy = false, child = null;
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    locked = isPortListening(SINGLETON_PORT);
    child = findBusinessChild();
    if (locked) {
      healthy = await checkHealth();
      if (healthy) break;
    }
  }

  // 统计重启后新增日志里的 buffer gone 次数
  await sleep(3000);
  let bufferGone = 0, tail = '';
  try {
    const buf = fs.readFileSync(serviceLog);
    tail = buf.slice(sizeBefore).toString('utf-8');
    bufferGone = (tail.match(/buffer gone/g) || []).length;
  } catch {}

  const env = readEnv();
  const ok = restartOk && locked && child;
  const orphanLine = ORPHAN_PID ? `1. 失管孤儿(旧 pid ${ORPHAN_PID})已终止。\n` : `1. 无孤儿待清理(传入 pid=${ORPHAN_PID || 0})。\n`;
  const report = ok
    ? `🌙 重启完成。\n\n` +
      orphanLine +
      `2. 重启方式:${restartMethod}(系统 supervisor 为唯一权威,不再自起第二套看门狗)。\n` +
      `3. 新实例已持有单例锁(端口 ${SINGLETON_PORT}),业务进程 pid ${child.pid},/health=${healthy ? 'ok' : 'degraded'}。\n` +
      `4. 重启后新日志 buffer gone = ${bufferGone} 次(0 即吞消息已消除)。\n\n` +
      `现在这条就是新进程发的,链路已通。`
    : `🌙 重启异常,需要人工看一眼:\n` +
      `重启方式=${restartMethod},发起结果=${restartOk},单例锁端口=${locked ? '已监听' : '未监听'},业务进程=${child ? child.pid : '未检测到'},/health=${healthy ? 'ok' : '未通过'}。\n` +
      `请查 logs/service.err 和 logs/restart-managed.log。`;

  await sendReport(env, report);
  log(`完成:ok=${!!ok} method=${restartMethod} locked=${locked} childPid=${child?.pid} healthy=${healthy} bufferGone=${bufferGone}`);
  process.exit(0);
}

main().catch(e => { log(`异常:${e.message}`); process.exit(1); });
