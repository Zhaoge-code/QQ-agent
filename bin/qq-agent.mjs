#!/usr/bin/env node
// QQ Agent 命令行配置工具（服务器 / Docker 部署用）
//
// 为什么需要它：控制台在只读模式下只能监控，配置一律从这里改 ——
// 这样"能打开浏览器的人"拿不到 API Key，也不会误点改坏配置。
//
// 用法（容器内执行）：
//   docker compose exec qq-agent node bin/qq-agent.mjs show
//   docker compose exec qq-agent node bin/qq-agent.mjs set-api --base-url https://api.deepseek.com/v1 --key sk-xxx --model deepseek-chat
//   docker compose exec qq-agent node bin/qq-agent.mjs set-allow group:123456,group:234567
//   docker compose exec qq-agent node bin/qq-agent.mjs set-allow --add group:999
//   docker compose exec qq-agent node bin/qq-agent.mjs set-deny  group:888
//   docker compose exec qq-agent node bin/qq-agent.mjs set-tier  40
//   docker compose exec qq-agent node bin/qq-agent.mjs set-vision off
//   docker compose exec qq-agent node bin/qq-agent.mjs set-sticker on --encourage 2
//   docker compose exec qq-agent node bin/qq-agent.mjs set-onebot --ws ws://napcat:3001 --http http://napcat:3000
//   docker compose exec qq-agent node bin/qq-agent.mjs test-api
//   docker compose exec qq-agent node bin/qq-agent.mjs reload
//
// 改完配置会自动给主进程发 SIGHUP 触发热重载；发不到时会提示手动重启。
import fs from 'node:fs';
import { getConfig, updateConfig, CONFIG_FILE } from '../src/config.js';
import { sliderToTier } from '../src/tier-slider.js';

const USAGE = `
QQ Agent 配置工具

  show                                   查看当前配置（密钥脱敏）
  set-api   --base-url <url> --key <key> [--model <id>]
                                         设置模型接口（给 --key 会同时清空"目录提供商"，
                                         否则它优先级更高、会导致刚设的 Key 不生效）
  set-allow [group:123,private:456]      整体替换白名单（不带参数=清空）
  set-allow --add     group:123[,group:456]
  set-allow --remove  group:123
  set-deny  ...                          黑名单，写法同 set-allow
  set-tier  <0-100>                      响应档位滑条：0 只回 @，100 什么都回
  set-vision  on|off                     图片识别开关：off 后移除看图工具，模型只看到 [图片] 占位符
  set-sticker on|off [--encourage 0-3] [--collect on|off]
                                         表情包开关：off 后连工具一起下架，彻底不能发/收藏表情；
                                         --encourage 发表情的积极程度，--collect 能不能收藏别人发的图
  set-onebot [--ws <url>] [--http <url>] [--token <令牌>]
                                         设置协议端（OneBot v11）地址。
                                         容器里不能用 127.0.0.1 —— 那是容器自己：
                                         协议端在同一个 compose 里就写服务名（ws://napcat:3001），
                                         装在宿主机上就写 host.docker.internal。
  test-api                               发一条 ping 验证地址 / Key / 模型
  reload                                 只让主进程重读配置（手工改过 config.json 时用）

条目写法：group:群号 或 private:QQ号；只写数字默认当群号。
`.trim();

function die(msg) { console.error(`\n[x] ${msg}\n`); process.exit(1); }
function info(msg) { console.log(`==> ${msg}`); }
function warn(msg) { console.log(`[!] ${msg}`); }

/** 极简参数解析：--key value / --flag。位置参数进 _。 */
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i += 1; }
    } else {
      out._.push(arg);
    }
  }
  return out;
}

/** 密钥脱敏：只露头 3 位和尾 4 位，够确认"设的是哪把钥匙"又不至于泄漏。 */
function mask(secret) {
  const s = String(secret || '');
  if (!s) return '（未设置）';
  if (s.length <= 8) return '（已设置）';
  return `${s.slice(0, 3)}…${s.slice(-4)}（共 ${s.length} 字符）`;
}

function describeTier(store = {}) {
  const pos = store.contextSliderPos;
  if (pos === undefined || pos === null) return `档位 ${store.contextTier ?? '?'}（未用滑条位置，建议 set-tier 统一设置）`;
  const { tier, randomPercent } = sliderToTier(Number(pos));
  const extra = tier === 3 ? `，${randomPercent}% 概率随机响应` : '';
  return `滑条 ${pos}/100 → ${tier} 档${extra}`;
}

/** 把 "group:123,456,private:789" 解析成 { groups, privates }。 */
function normList(raw) {
  const groups = [];
  const privates = [];
  for (const item of String(raw).split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = /^(group|private|群|私聊)\s*[:：]\s*(\d+)$/i.exec(item);
    if (m) {
      const kind = String(m[1]).toLowerCase();
      (kind === 'private' || kind === '私聊' ? privates : groups).push(m[2]);
    } else if (/^\d+$/.test(item)) {
      groups.push(item);
    } else {
      die(`看不懂的条目：${item}（写法：group:123 或 private:456）`);
    }
  }
  return { groups, privates };
}

function mergeList(current, { replaceList, addList, removeList }) {
  let groups = [...(current?.groups || [])];
  let privates = [...(current?.private || [])];
  if (replaceList) {
    const parsed = normList(replaceList);
    groups = parsed.groups;
    privates = parsed.privates;
  }
  if (addList) {
    const parsed = normList(addList);
    for (const g of parsed.groups) if (!groups.includes(g)) groups.push(g);
    for (const p of parsed.privates) if (!privates.includes(p)) privates.push(p);
  }
  if (removeList) {
    const parsed = normList(removeList);
    groups = groups.filter((g) => !parsed.groups.includes(g));
    privates = privates.filter((p) => !parsed.privates.includes(p));
  }
  return { groups, private: privates };
}

/**
 * 通知主进程重读配置。
 * 容器里主进程就是 PID 1；非容器环境退化成扫 /proc 找 src/server.js。
 * 返回是否至少发出去了一个信号。
 */
function signalServer() {
  const targets = [];
  const cmdOf = (pid) => {
    try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' '); } catch { return ''; }
  };
  if (cmdOf(1).includes('src/server.js')) targets.push(1);
  if (!targets.length) {
    try {
      for (const entry of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(entry)) continue;
        const pid = Number(entry);
        if (pid === process.pid || targets.includes(pid)) continue;
        if (cmdOf(pid).includes('src/server.js')) targets.push(pid);
      }
    } catch { /* 不是 Linux，或/ proc 不可读 */ }
  }
  let sent = false;
  for (const pid of targets) {
    try {
      process.kill(pid, 'SIGHUP');
      info(`已通知主进程（pid ${pid}）重新加载配置`);
      sent = true;
    } catch (error) {
      warn(`通知 pid ${pid} 失败：${error?.message ?? error}`);
    }
  }
  return sent;
}

function afterWrite() {
  info(`已写入 ${CONFIG_FILE}`);
  if (!signalServer()) {
    warn('没找到正在运行的主进程，配置会在下次启动时生效。手动重启：docker compose restart qq-agent');
  }
}

// ── 子命令 ──────────────────────────────────────────────────────────────

function cmdShow() {
  const c = getConfig();
  // 中文在终端占两列，按显示宽度补空格才不会参差不齐
  const width = (s) => [...String(s)].reduce((n, ch) => n + (/[\u2e80-\u9fff\uff00-\uffef\u3000-\u303f]/.test(ch) ? 2 : 1), 0);
  const line = (k, v) => console.log(`  ${k}${' '.repeat(Math.max(2, 16 - width(k)))}${v}`);
  console.log('\n当前配置（密钥已脱敏）\n');
  line('配置文件', CONFIG_FILE);
  line('Base URL', c.api?.baseUrl || '（未设置）');
  line('API Key', mask(c.api?.apiKey));
  line('模型', c.api?.model || '（未设置）');
  line('目录提供商', c.api?.provider ? `${c.api.provider}（它的 Key 优先级更高）` : '（未用）');
  line('OneBot WS', c.snowluma?.wsUrl || '（未设置）');
  line('OneBot HTTP', c.snowluma?.httpUrl || '（未设置）');
  line('OneBot 令牌', c.snowluma?.accessToken ? '（已设置）' : '（未设置）');
  line('群白名单', (c.allow?.groups || []).join(', ') || '（空 —— 机器人不会响应任何群）');
  line('私聊白名单', (c.allow?.private || []).join(', ') || '（空）');
  line('群黑名单', (c.deny?.groups || []).join(', ') || '（空）');
  line('私聊黑名单', (c.deny?.private || []).join(', ') || '（空）');
  line('空白名单放行', c.allowAllWhenEmpty === true ? '是（不推荐）' : '否');
  line('响应档位', describeTier(c.store));
  line('主动开话题', c.proactive?.enabled ? '开' : '关');
  line('图片识别', c.api?.vision === false ? '关（只看得到 [图片] 占位符）' : '开');
  line('表情包', c.sticker?.enabled === false ? '关' : `开（积极度 ${c.sticker?.encourage ?? 1}${c.sticker?.collectEnabled === false ? '，收藏已关' : ''}）`);
  console.log('');
}

function cmdSetApi(args) {
  const api = {};
  if (args['base-url']) api.baseUrl = String(args['base-url']).trim();
  if (args.key) api.apiKey = String(args.key).trim();
  if (args.model) api.model = String(args.model).trim();
  if (!Object.keys(api).length) die('至少要给一个参数：--base-url / --key / --model');

  if (args.key) {
    // resolveApiKey 的优先级是「选中的目录提供商 > 顶层 api.apiKey」，
    // 不清掉它，命令行刚设的 Key 会被旧提供商的 Key 顶掉（表现为一堆 401）。
    const prev = String(getConfig().api?.provider || '');
    if (prev) warn(`原目录提供商「${prev}」已清空（它的 Key 优先级高于手动 Key）`);
    api.provider = '';
  }

  updateConfig({ api });
  if (api.baseUrl) info(`Base URL = ${api.baseUrl}`);
  if (api.apiKey) info(`API Key = ${mask(api.apiKey)}`);
  if (api.model) info(`模型 = ${api.model}`);
  afterWrite();
}

function cmdSetList(kind, args) {
  const positional = args._.slice(1);
  const replaceList = positional[0];
  const addList = args.add === true ? undefined : args.add;
  const removeList = args.remove === true ? undefined : args.remove;
  if (args.add === true || args.remove === true) die('--add / --remove 后面要跟条目，例如 --add group:123');
  if (!replaceList && !addList && !removeList) {
    warn(`没有给条目，将把${kind === 'allow' ? '白名单' : '黑名单'}清空`);
  }
  const current = getConfig()[kind] || {};
  const next = mergeList(current, { replaceList, addList, removeList });
  updateConfig({ [kind]: next });
  info(`群：${next.groups.join(', ') || '（空）'}`);
  info(`私聊：${next.private.join(', ') || '（空）'}`);
  afterWrite();
}

function cmdSetTier(args) {
  const raw = args._[1];
  if (raw === undefined) die('用法：set-tier <0-100>');
  const pos = Number(raw);
  if (!Number.isFinite(pos) || pos < 0 || pos > 100) die('滑条位置必须是 0~100 的数字');
  // 只写滑条位置：档位与随机概率由 config.js 统一派生，避免两处打架
  updateConfig({ store: { contextSliderPos: pos } });
  info(`响应档位 = ${describeTier({ contextSliderPos: pos })}`);
  afterWrite();
}

/** on/off 解析：也接受 true/false、1/0、开/关这类写法。 */
function parseOnOff(raw, label) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (['on', 'true', '1', 'yes', 'enable', 'enabled', '开', '开启'].includes(v)) return true;
  if (['off', 'false', '0', 'no', 'disable', 'disabled', '关', '关闭'].includes(v)) return false;
  die(`${label} 只接受 on / off`);
}

/** 图片识别开关：off 后看图工具会被下架，模型只看到 [图片] 占位符。 */
function cmdSetVision(args) {
  const on = parseOnOff(args._[1], 'set-vision');
  updateConfig({ api: { vision: on } });
  info(`图片识别 = ${on ? '开' : '关（看图工具已下架，模型只会看到 [图片] 占位符）'}`);
  afterWrite();
}

/** 表情包总开关 / 发表情积极程度 / 能不能收藏别人发的图。 */
function cmdSetSticker(args) {
  const sticker = {};
  if (args._[1] !== undefined) sticker.enabled = parseOnOff(args._[1], 'set-sticker');
  if (args.encourage !== undefined) {
    if (args.encourage === true) die('--encourage 后面要跟 0~3 的数字');
    const lvl = Number(args.encourage);
    if (!Number.isInteger(lvl) || lvl < 0 || lvl > 3) die('--encourage 必须是 0~3 的整数（0=不鼓励，3=很积极）');
    sticker.encourage = lvl;
  }
  if (args.collect !== undefined) {
    if (args.collect === true) die('--collect 后面要跟 on / off');
    sticker.collectEnabled = parseOnOff(args.collect, '--collect');
  }
  if (!Object.keys(sticker).length) die('用法：set-sticker on|off [--encourage 0-3] [--collect on|off]');
  updateConfig({ sticker });
  if (sticker.enabled !== undefined) info(`表情包 = ${sticker.enabled ? '开' : '关（表情工具已下架）'}`);
  if (sticker.encourage !== undefined) info(`发表情积极程度 = ${sticker.encourage}`);
  if (sticker.collectEnabled !== undefined) info(`收藏别人发的图 = ${sticker.collectEnabled ? '开' : '关'}`);
  afterWrite();
}

function cmdSetOnebot(args) {
  const snowluma = {};
  if (args.ws) snowluma.wsUrl = String(args.ws).trim();
  if (args.http) snowluma.httpUrl = String(args.http).trim().replace(/\/+$/, '');
  if (args.token && args.token !== true) {
    snowluma.accessToken = String(args.token).trim();
    snowluma.httpAccessToken = String(args.token).trim();
  }
  if (!Object.keys(snowluma).length) die('至少要给一个参数：--ws / --http / --token');
  updateConfig({ snowluma });
  if (snowluma.wsUrl) info(`OneBot WS   = ${snowluma.wsUrl}`);
  if (snowluma.httpUrl) info(`OneBot HTTP = ${snowluma.httpUrl}`);
  if (snowluma.accessToken !== undefined) info('OneBot 令牌已设置');
  afterWrite();
}

async function cmdTestApi() {
  const cfg = getConfig();
  if (!String(cfg.api?.baseUrl || '').trim()) die('还没设 Base URL，先跑 set-api --base-url … --key …');
  info(`测试 ${cfg.api.baseUrl} 的模型 ${cfg.api.model || '（未设置）'} …`);
  const startedAt = Date.now();
  const { chatCompletion } = await import('../src/llm.js');
  try {
    const r = await chatCompletion({
      messages: [{ role: 'user', content: '请只回复两个字符：pong' }],
      tools: null,
      temperature: 0
    });
    const reply = typeof r.message?.content === 'string' ? r.message.content.slice(0, 60) : '';
    info(`通了 ✅ 用时 ${Date.now() - startedAt}ms，模型回：${reply}`);
    return true;
  } catch (error) {
    console.error(`\n[x] 失败：${error?.message ?? error}\n`);
    console.error('排查顺序：Base URL 是否要带 /v1、Key 是否有效、模型名是否存在、服务器能不能出网。\n');
    return false;
  }
}

// ── 入口 ────────────────────────────────────────────────────────────────

const args = parseArgs(process.argv.slice(2));
const command = args._[0];

if (!command || command === 'help' || args.help) {
  console.log(USAGE);
  process.exit(0);
}

switch (command) {
  case 'show': cmdShow(); break;
  case 'set-api': cmdSetApi(args); break;
  case 'set-allow': cmdSetList('allow', args); break;
  case 'set-deny': cmdSetList('deny', args); break;
  case 'set-tier': cmdSetTier(args); break;
  case 'set-vision': cmdSetVision(args); break;
  case 'set-sticker': cmdSetSticker(args); break;
  case 'set-onebot': cmdSetOnebot(args); break;
  case 'test-api': process.exit(await cmdTestApi() ? 0 : 1); break;
  case 'reload':
    if (!signalServer()) die('没找到正在运行的主进程。手动重启：docker compose restart qq-agent');
    break;
  default:
    console.error(`未知命令：${command}\n`);
    console.log(USAGE);
    process.exit(1);
}
