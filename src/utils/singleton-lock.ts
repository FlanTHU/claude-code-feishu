/**
 * 单例锁：用独占绑定本地 TCP 端口实现内核级进程互斥。
 *
 * 为什么用端口而不是 pid 文件：
 *  - 端口独占由内核保证，进程崩溃后自动释放，不会像 pid 文件那样留下陈旧记录；
 *  - 拦得住任何启动路径（launchd / systemd / start.mjs 看门狗 / 手动裸起），
 *    只要重复启动就会撞到 EADDRINUSE 而礼让退出。
 *
 * 背景：曾出现 launchd 服务与 start.mjs 看门狗两套 supervisor 各拉一个实例，
 * 两实例各连一条飞书长连接，导致同一条消息被回复两次。此锁是根因之外的兜底防线。
 */

import net from 'node:net';

/**
 * 尝试获取单例锁。
 * @param port 锁端口（独立于业务端口，默认 4099）
 * @returns 成功返回持有锁的 server（需在退出时 close 释放）；端口已被占用返回 null。
 */
export function acquireSingletonLock(port: number): Promise<net.Server | null> {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        resolve(null);
        return;
      }
      // 其他错误（如权限不足）也视为拿不到锁，礼让退出，避免误判为可启动
      console.error(`[Singleton] 绑定锁端口 ${port} 出错 (${err.code}): ${err.message}`);
      resolve(null);
    });

    // exclusive: true —— 与 local-api 的 false 相反，这里就是要独占，
    // 不允许多进程共享同一端口，否则锁形同虚设。
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      resolve(server);
    });
  });
}
