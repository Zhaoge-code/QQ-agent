// headless 入口：node src/server.js（不带 Electron 窗口，浏览器访问控制台）
// Docker / Linux 服务器部署走的就是这里。
import { createApp } from './app.js';

// 带时间戳的日志：docker logs / journald 里没时间戳会很难对齐排障。
const stamp = () => new Date().toISOString();
const log = (...args) => console.log(stamp(), ...args);
const logError = (...args) => console.error(stamp(), ...args);

process.on('unhandledRejection', (error) => logError('[未处理异常]', error));

const app = createApp({ log });

let shuttingDown = false;
async function shutdown(code = 0, reason = '') {
  if (shuttingDown) return;
  shuttingDown = true;
  log(reason ? `正在退出（${reason}）…` : '正在退出…');
  // 兜底：清理卡住时也别赖着不走（否则 docker stop 要等到超时才 SIGKILL）。
  // 用 unref 是关键：句柄都关干净时事件循环会自然结束，这个定时器根本不会触发。
  const force = setTimeout(() => {
    log('退出超时（8s），强制结束。');
    process.exit(code);
  }, 8000);
  force.unref();
  // 清干净了就靠事件循环自然结束 —— 这样退出码才是真实退出码。
  // ⚠️ 别在这里直接 process.exit()：Windows 上句柄还在关的时候硬退会触发 libuv
  //    断言（uv_async -> 退出码 0xC0000409），进程虽然能死，退出码却会变成"崩溃"。
  process.exitCode = code;
  try {
    await app.stop();
  } catch (error) {
    logError('[退出] 清理失败:', error?.message ?? error);
  }
}

// SIGTERM = docker stop / systemd 发的停止信号；SIGINT = Ctrl+C。
process.on('SIGTERM', () => shutdown(0, 'SIGTERM'));
process.on('SIGINT', () => shutdown(0, 'SIGINT'));

// SIGHUP = "配置改完了，重新读盘生效"。bin/qq-agent.mjs 改完配置会自动发这个信号：
//   docker compose kill -s SIGHUP qq-agent
process.on('SIGHUP', () => {
  try {
    const applied = app.reloadConfig();
    log(`收到 SIGHUP，配置已重新加载${applied?.length ? '：' + applied.join('、') : ''}`);
  } catch (error) {
    logError('[重载] 失败，运行中的配置保持不变:', error?.message ?? error);
  }
});

// 未捕获异常之后进程状态已经不可信（可能连 OneBot 连接都处于半死状态）。
// 记录后主动退出，交给 restart: unless-stopped 干净地拉起来 ——
// 赖着不动才是真正会"悄悄不说话"的故障形态。
process.on('uncaughtException', (error) => {
  logError('[未捕获异常]', error);
  shutdown(1, 'uncaughtException');
});

app.start().catch((error) => {
  logError('[启动失败]', error?.message ?? error);
  process.exit(1);
});
