#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptFile = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptFile);
const rootDir = path.resolve(scriptDir, '..');
const logsDir = path.join(rootDir, 'logs');
const pidFile = path.join(logsDir, 'bridge.pid');
const outLog = path.join(logsDir, 'service.log');
const errLog = path.join(logsDir, 'service.err');
const entryFile = path.join(rootDir, 'dist', 'index.js');

const WATCHDOG_ENABLED = process.env.BRIDGE_WATCHDOG_ENABLED !== '0';
const MAX_RESTARTS_PER_HOUR = parseInt(process.env.BRIDGE_WATCHDOG_MAX_RESTARTS_PER_HOUR || '5', 10) || 5;
const RESTART_DELAY_MS = parseInt(process.env.BRIDGE_WATCHDOG_RESTART_DELAY_MS || '3000', 10) || 3000;

function isWindows() {
  return process.platform === 'win32';
}

function getNpmCommandVariants(args) {
  const variants = [];
  const npmExecPath = process.env.npm_execpath;

  if (npmExecPath) {
    variants.push({
      command: process.execPath,
      args: [npmExecPath, ...args],
    });
  }

  variants.push({ command: 'npm', args });

  if (isWindows()) {
    variants.push({ command: 'npm.cmd', args });
    variants.push({ command: 'npm.exe', args });
  }

  const seen = new Set();
  const uniqueVariants = [];

  for (const variant of variants) {
    const key = `${variant.command}::${variant.args.join('\u0000')}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    uniqueVariants.push(variant);
  }

  return uniqueVariants;
}

function runNpm(args) {
  const variants = getNpmCommandVariants(args);
  let lastResult = null;

  for (const variant of variants) {
    const result = spawnSync(variant.command, variant.args, {
      cwd: rootDir,
      stdio: 'inherit',
    });

    if (result.error) {
      lastResult = result;
      continue;
    }

    if (result.status === 0) {
      return result;
    }

    lastResult = result;
  }

  return lastResult;
}

function readPid() {
  if (!fs.existsSync(pidFile)) {
    return null;
  }

  const raw = fs.readFileSync(pidFile, 'utf-8').trim();
  const pid = Number.parseInt(raw, 10);
  return Number.isNaN(pid) ? null : pid;
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function ensureBuildIfMissing() {
  if (fs.existsSync(entryFile)) {
    return;
  }

  console.log('[start] 未检测到 dist/index.js，开始自动构建');
  const result = runNpm(['run', 'build']);

  if (!result || result.error || result.status !== 0) {
    console.error('[start] 构建失败，启动中止');
    process.exit(result?.status ?? 1);
  }
}

function ensureLogDir() {
  fs.mkdirSync(logsDir, { recursive: true });
}

function startBridgeDetached() {
  const stdoutFd = fs.openSync(outLog, 'a');
  const stderrFd = fs.openSync(errLog, 'a');

  const child = spawn(process.execPath, ['dist/index.js'], {
    cwd: rootDir,
    detached: true,
    stdio: ['ignore', stdoutFd, stderrFd],
    windowsHide: true,
  });

  child.unref();
  fs.closeSync(stdoutFd);
  fs.closeSync(stderrFd);

  fs.writeFileSync(pidFile, String(child.pid), 'utf-8');
  console.log(`[start] 启动成功，PID=${child.pid}`);
  console.log(`[start] 日志文件: ${outLog}`);
  return child.pid;
}

function startBridgeWithWatchdog() {
  const restartTimes = [];
  let shutdownRequested = false;
  let currentChild = null;

  const cleanup = () => {
    shutdownRequested = true;
    if (currentChild) {
      try {
        currentChild.kill('SIGTERM');
      } catch {
        // ignore
      }
      currentChild = null;
    }
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  const runChild = () => {
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;
    const recentRestarts = restartTimes.filter((t) => t > oneHourAgo);
    if (recentRestarts.length >= MAX_RESTARTS_PER_HOUR) {
      console.error(
        `[start] 看门狗: 1 小时内重启已达 ${MAX_RESTARTS_PER_HOUR} 次，停止重启。请检查日志排查问题。`
      );
      process.exit(1);
    }

    return new Promise((resolve) => {
      const child = spawn(process.execPath, ['dist/index.js'], {
        cwd: rootDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      currentChild = child;

      child.stdout?.pipe(process.stdout);
      child.stderr?.pipe(process.stderr);

      child.on('exit', (code, signal) => {
        currentChild = null;
        if (shutdownRequested) {
          resolve();
          return;
        }
        restartTimes.push(Date.now());
        console.warn(
          `[start] 子进程退出 code=${code} signal=${signal}，${Math.round(RESTART_DELAY_MS / 1000)}s 后重启`
        );
        setTimeout(() => {
          if (shutdownRequested) {
            resolve();
            return;
          }
          runChild().then(resolve);
        }, RESTART_DELAY_MS);
      });
    });
  };

  fs.writeFileSync(pidFile, String(process.pid), 'utf-8');
  console.log(`[start] 看门狗模式启动，主进程 PID=${process.pid}`);
  console.log(`[start] 子进程崩溃后将自动重启（最多 ${MAX_RESTARTS_PER_HOUR} 次/小时）`);
  return runChild();
}

function main() {
  ensureLogDir();

  const existingPid = readPid();
  if (existingPid && isProcessAlive(existingPid)) {
    console.log(`[start] 服务已在运行，PID=${existingPid}`);
    console.log(`[start] 如需重启，请先执行: node scripts/stop.mjs`);
    process.exit(0);
  }

  if (existingPid && !isProcessAlive(existingPid)) {
    fs.rmSync(pidFile, { force: true });
  }

  ensureBuildIfMissing();

  if (WATCHDOG_ENABLED) {
    startBridgeWithWatchdog().then(() => {
      fs.rmSync(pidFile, { force: true });
      process.exit(0);
    });
  } else {
    startBridgeDetached();
  }
}

main();
