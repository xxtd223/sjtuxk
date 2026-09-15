/**
 * SJTU 研究生选课 — 多课程并行监测 + 智能选课
 *
 * 通过 CDP 常驻连接「当前浏览器」(Edge) 已登录的选课页：
 *   1) 按 bjmc（课程代码前缀，如 "CS7331"）筛出该课程的全部班级；
 *   2) 按可选条件过滤：校区（XQMC）/ 任课教师（RKJS）/ 上课时间地点（PKSJDDMS）；
 *   3) 按优先级选出最优班级（有空位 > 条件满足度 > 教师位置 > 时间位置）；
 *   4) 一旦最优班级有空位（已选 < 容量）立即提交选课，并核验结果。
 * 多门课各自一个独立协程并行执行（互不阻塞）。
 *
 * 两种轮询模式：
 *   常规  每轮检查完再随机睡 25–35 秒
 *   疯狂  完全不睡，槽位一空就发下一次；速率 = 在途数（crazyConcurrency）÷ 单次耗时
 *
 * 两种接口通道：
 *   node（默认）  CDP 只用来取 cookie/csrfToken，业务请求由 Node 直连发出 —— 实测 ~25ms/次
 *   page         在页面内 fetch（兼容/回退）—— 受浏览器 HTTP/1.1 同源 6 连接限制，慢且易堵
 *
 * 用法:
 *   node monitor.mjs            # 常规监测（每轮间隔随机 25–35 秒）
 *   node monitor.mjs -crz       # 疯狂模式（不限间隔，直接打满；慎用！）
 *   node monitor.mjs --dry      # 只检查一轮并打印筛选/排序结果，不选课、不通知
 *   node monitor.mjs -crz --dry # 疯狂模式 + 只检查一轮
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { connect } from "./cdp.mjs";
import { checkExpr, selectExpr } from "./exprs.mjs";
import { SjtuApi } from "./sjtu-api.mjs";
import { analyze, describe, normalizeTarget } from "./select.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 可用环境变量覆盖，便于多套配置 / 自测（MONITOR_CONFIG / MONITOR_LOG / MONITOR_STATE / MONITOR_LOCK / MONITOR_NO_NOTIFY）
const CFG_FILE = process.env.MONITOR_CONFIG || path.join(HERE, "monitor.config.json");
const LOG_FILE = process.env.MONITOR_LOG || path.join(HERE, "monitor.log");
const STATE_FILE = process.env.MONITOR_STATE || path.join(HERE, "monitor-state.json");
const LOCK_FILE = process.env.MONITOR_LOCK || path.join(HERE, "monitor.lock");
const NO_NOTIFY = process.env.MONITOR_NO_NOTIFY === "1";
const OPENCLAW_MJS = process.env.MONITOR_OPENCLAW || "C:\\Program Files\\nodejs\\node_global\\node_modules\\openclaw\\openclaw.mjs";

const ARGS = process.argv.slice(2);
const hasFlag = (...names) => names.some((n) => ARGS.includes(n));
const DRY = hasFlag("--dry", "-dry");
const CRAZY = hasFlag("-crz", "--crazy", "--crz");
const HELP = hasFlag("-h", "--help", "-help");

if (HELP) {
  console.log(`用法: node monitor.mjs [--dry] [-crz]

  (无参数)   常规监测：每轮检查完再随机睡 25–35 秒
  -crz       疯狂模式：不限发起间隔，由 crazyConcurrency 决定在途并发
  --dry      只检查一轮并打印筛选/排序结果，不选课、不通知`);
  process.exit(0);
}

const DEFAULTS = {
  courses: [],
  minIntervalMs: 25_000,
  maxIntervalMs: 35_000,
  crazyConcurrency: 3, // 疯狂模式的唯一节流：每个目标的在途检查数（不再有发起间隔）
  fullCheckEvery: 10,  // 疯狂模式下每 N 次轻量检查做一次完整检查（含「已选课程」）
  transport: "node",   // node = Node 侧直连接口（快，默认）；page = 页面内 fetch（兼容/回退）
  apiBase: "https://yjsxk.sjtu.edu.cn/yjsxkapp",
  apiTimeoutMs: 15_000,
  cookieRefreshMs: 60_000, // 从浏览器同步 cookie 的间隔
  statsEveryMs: 10_000, // 状态行（含实测速率）输出间隔
  deadline: "2026-09-24T20:00:00+08:00",
  stopWhenAllEnrolled: true,
  coursePageUrl: "https://yjsxk.sjtu.edu.cn/yjsxkapp/sys/xsxkapp/course.html",
  connectTimeoutMs: 1_800_000,
  reconnectBackoffMs: 30_000,
  failCooldownMs: 90_000,
  selectTimeoutMs: 60_000,
  keepAliveMs: 20_000,
  notifyCooldownMs: 60_000, // 同类通知的最小间隔（防止疯狂模式下刷屏）
};

// ---------------------------------------------------------------- utilities
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => Math.floor(a + Math.random() * (b - a + 1));
const ts = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const short = (bjmc) => String(bjmc || "").split("-")[0];

function log(msg) {
  const line = `[${ts()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + "\n", "utf8"); } catch {}
}

function writeState(patch) {
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch {}
  const next = { ...cur, ...patch, updatedAt: Date.now() };
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2), "utf8"); } catch {}
  return next;
}

function withTimeout(p, ms, tag) {
  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${ms}ms (${tag})`)), ms)),
  ]);
}

// ---------------------------------------------------------------- 通知（异步队列，绝不阻塞轮询）
const notifyQ = [];
let notifyBusy = false;

function pumpNotify() {
  if (notifyBusy) return;
  const text = notifyQ.shift();
  if (!text) return;
  notifyBusy = true;
  const done = (() => {
    let called = false;
    return (why) => {
      if (called) return;
      called = true;
      if (why) log("notify: " + why);
      notifyBusy = false;
      pumpNotify();
    };
  })();
  try {
    const p = spawn(process.execPath, [OPENCLAW_MJS, "system", "event", "--text", text, "--mode", "now"], {
      windowsHide: true, stdio: ["ignore", "ignore", "pipe"],
    });
    let err = "";
    if (p.stderr) p.stderr.on("data", (d) => { err = (err + d.toString("utf8")).slice(-300); });
    p.on("close", (code) => done(code === 0 ? null : `exit ${code}${err ? " :: " + err.replace(/\s+/g, " ").trim() : ""}`));
    p.on("error", (e) => done("error " + e.message));
    const to = setTimeout(() => done("timeout"), 60_000);
    if (to.unref) to.unref();
  } catch (e) { done("spawn " + e.message); }
}

function notifyEM(text) {
  if (DRY) { log("DRY-NOTIFY: " + String(text).replace(/\s+/g, " ")); return; }
  if (NO_NOTIFY) { log("NOTIFY(suppressed): " + String(text).replace(/\s+/g, " ")); return; }
  log("NOTIFY: " + String(text).replace(/\s+/g, " "));
  notifyQ.push(text);
  pumpNotify();
}

/** 简易互斥锁：保证同一时刻只有一段代码在操作页面/CDP */
class Mutex {
  constructor() { this.p = Promise.resolve(); }
  run(fn) {
    const r = this.p.then(fn, fn);
    this.p = r.then(() => {}, () => {});
    return r;
  }
}

// ---------------------------------------------------------------- 单实例锁
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e && e.code === "EPERM"; }
}

function acquireLock() {
  try {
    const prev = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8"));
    if (prev && prev.pid && prev.pid !== process.pid && pidAlive(prev.pid)) {
      console.error(`已有监测进程在运行（pid=${prev.pid}，启动于 ${prev.startedAt || "?"}）。`);
      console.error("同一时间只允许一个 monitor 进程 —— 否则会向 Edge 建立多条 DevTools 连接，可能反复弹授权提示。");
      console.error(`要停止旧进程：Stop-Process -Id ${prev.pid} -Force`);
      return false;
    }
  } catch {}
  try {
    fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), "utf8");
  } catch {}
  return true;
}

function releaseLock() {
  try {
    const cur = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8"));
    if (cur.pid === process.pid) fs.unlinkSync(LOCK_FILE);
  } catch {}
}

// ---------------------------------------------------------------- config
function loadCfg() {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(CFG_FILE, "utf8")) || {}; }
  catch (e) { log("读取配置失败，使用默认值: " + e.message); }

  const cfg = { ...DEFAULTS, ...raw };
  if (CRAZY) {
    // 疯狂模式：不再有发起间隔（无 sleep），速率完全由 crazyConcurrency（在途数）决定
    cfg.minIntervalMs = 0;
    cfg.maxIntervalMs = 0;
    cfg.launchDelayMs = 0;
    if (!("failCooldownMs" in raw)) cfg.failCooldownMs = 1500;
    if (!("reconnectBackoffMs" in raw)) cfg.reconnectBackoffMs = 2500;
    if (!("notifyCooldownMs" in raw)) cfg.notifyCooldownMs = 120_000;
    cfg.concurrency = Math.max(1, Number(cfg.crazyConcurrency) || 4);
  } else {
    cfg.concurrency = 1;
  }
  cfg.targets = (raw.courses || []).map(normalizeTarget).filter((t) => t.bjmc);
  cfg.deadlineDate = new Date(cfg.deadline);
  if (Number.isNaN(cfg.deadlineDate.getTime())) cfg.deadlineDate = new Date(DEFAULTS.deadline);
  return cfg;
}

// ---------------------------------------------------------------- runner
class Runner {
  constructor() {
    this.cdp = null;
    this.ka = null;
    this.stop = false;
    this.connectP = null;
    this.pageId = null;          // 缓存的选课页 targetId（避免每次检查都做一次 CDP 查找）
    this.pageMutex = new Mutex();
    this.connCount = 0;          // 本进程建立过的 CDP 连接次数（越少越好：Edge 授权提示只该出现一次）
    this.keepAliveFails = 0;
    this.notifiedAt = new Map(); // key -> timestamp（通知节流）
    this.episode = new Set();    // 已通知过的「事件」，条件恢复后清除
    this.lastLog = new Map();    // 目标 -> 上次日志内容（避免刷屏）
    this.states = new Map();     // 目标 -> "running" | "enrolled" | "stopped"
    this.api = null;              // Node 直连客户端
    this.authAt = 0;              // 上次同步 cookie/csrf 的时间
    this.authP = null;            // 认证同步单飞
    this.nodeDownUntil = 0;       // Node 直连失败后的回退冷却
    this.transport = "page";
  }

  // ---------------- CDP ----------------
  async connect(cfg) {
    // 已有可用连接 → 直接复用（绝不重建，避免触发新的 Edge 授权提示）
    if (this.cdp && !this.cdp.closed) { this.connectP = Promise.resolve(this.cdp); return this.cdp; }
    if (!this.connectP) {
      const first = this.connCount === 0;
      this.connCount++;
      log(first
        ? "首次连接 Edge：若 Edge 弹出授权提示，请在 Edge 窗口点『允许』（同一 Edge 会话只需这一次）…"
        : `第 ${this.connCount} 次连接 Edge（连接曾断开；同一 Edge 会话正常无需再授权，若弹窗请点『允许』）…`);
      const to = DRY ? Math.min(Number(cfg.connectTimeoutMs) || 30_000, 30_000) : cfg.connectTimeoutMs;
      // attempts=3：Edge 实测偶发「第一条 ws 握手被断」，重试即可成功
      this.connectP = connect(to, 3)
        .then((c) => {
          this.cdp = c;
          this.keepAliveFails = 0;
          c.ws.addEventListener("close", () => {
            this.connectP = null;
            this.pageId = null;
            log("⚠️ 与 Edge 的 CDP 连接已断开，将在下一轮自动重连。");
          });
          log("已连接到 Edge");
          this.startKeepAlive(cfg);
          return c;
        })
        .catch((e) => { this.connectP = null; throw e; });
    }
    return this.connectP;
  }

  startKeepAlive(cfg) {
    this.stopKeepAlive();
    this.ka = setInterval(() => {
      if (!this.cdp || this.cdp.closed) return;
      this.cdp.send("Target.getTargets", {}, undefined, 8000)
        .then(() => { this.keepAliveFails = 0; })
        .catch(() => {
          this.keepAliveFails++;
          // 连续失败才判定为假死并重连（单次失败不动作，避免无谓地重建连接）
          if (this.keepAliveFails >= 5) { log("心跳连续失败，重建 CDP 连接"); this.dropCdp(); }
        });
    }, cfg.keepAliveMs || 20_000);
    if (this.ka.unref) this.ka.unref();
  }

  stopKeepAlive() { if (this.ka) { clearInterval(this.ka); this.ka = null; } }

  dropCdp() {
    this.stopKeepAlive();
    this.connectP = null;
    this.pageId = null;
    try { this.cdp?.close(); } catch {}
    this.cdp = null;
  }

  async getPage(cfg) {
    if (this.pageId) return { targetId: this.pageId }; // 快路径：命中缓存，不做任何 CDP 往返
    return this.pageMutex.run(() => this._getPage(cfg));
  }

  async _getPage(cfg) {
    if (!this.cdp || this.cdp.closed) await this.connect(cfg);
    const isCourse = (p) => String(p.url).includes("xsxkapp/course.html");
    let page = await withTimeout(this.cdp.findPage(isCourse), 15_000, "find-page").catch(() => null);
    if (page) { this.pageId = page.targetId; return page; }

    // 标签不存在 / 被关掉 / 被导航走：自动恢复（优先复用 yjsxk 标签，否则新建一个）
    const host = await this.cdp.findPage((p) => String(p.url).includes("yjsxk.sjtu.edu.cn")).catch(() => null);
    if (host) {
      log("未找到选课标签，复用现有 SJTU 标签并导航到选课页…");
      try {
        const sid = await this.cdp.attach(host.targetId);
        await this.cdp.send("Page.navigate", { url: cfg.coursePageUrl }, sid, 20_000);
      } catch (e) { log("navigate 失败: " + e.message); }
    } else {
      log("未找到选课标签，新建一个选课页标签…");
      try { await this.cdp.send("Target.createTarget", { url: cfg.coursePageUrl, background: false }, undefined, 20_000); }
      catch (e) { log("createTarget 失败: " + e.message); }
    }
    await sleep(3000);
    page = await withTimeout(this.cdp.findPage(isCourse), 15_000, "find-page-2").catch(() => null);
    if (page) this.pageId = page.targetId;
    return page || null;
  }

  async evalPage(cfg, expr, timeoutMs = 45_000) {
    const page = await this.getPage(cfg);
    if (!page) return { __noPage: true };
    try {
      return await withTimeout(this.cdp.evaluate(page.targetId, expr), timeoutMs, "evaluate");
    } catch (e) {
      const msg = String(e && e.message || e);
      if (/session|target|attach|closed|detach/i.test(msg)) this.pageId = null; // 页面会话失效 → 下次重新定位
      if (this.cdp?.closed) this.dropCdp(); // 仅在连接真的断了时才丢弃
      throw e;
    }
  }

  // ---------------- Node 直连接口（CDP 只用来取 cookie/csrf） ----------------
  /** 从浏览器同步 cookie + csrfToken（HttpOnly 的 cookie 只能走 CDP 拿）
   *  单飞：多门课同时启动时只做一次，避免并发 evaluate 把会话掎崩 */
  async ensureAuth(cfg, { force = false } = {}) {
    const ttl = Number(cfg.cookieRefreshMs) || 60_000;
    if (!force && this.api && this.api.cookie && Date.now() - this.authAt < ttl) return true;
    if (this.authP) return this.authP;
    this.authP = this._ensureAuth(cfg, force).catch(() => false).finally(() => { this.authP = null; });
    return this.authP;
  }

  async _ensureAuth(cfg, force) {
    const page = await this.getPage(cfg);
    if (!page) return false;
    const sid = await this.cdp.attach(page.targetId);
    let cookies = [];
    try { cookies = (await this.cdp.send("Network.getAllCookies", {}, sid, 10_000)).cookies || []; }
    catch { try { cookies = (await this.cdp.send("Storage.getCookies", {}, sid, 10_000)).cookies || []; } catch {} }
    const jar = cookies.filter((c) => /(^|\.)sjtu\.edu\.cn$/i.test(String(c.domain))).map((c) => `${c.name}=${c.value}`).join("; ");
    if (!jar) return false;
    const meta = await this.cdp.evaluate(page.targetId,
      `({csrf: (document.querySelector("#csrfToken") || {}).value || (window.WIS_PUBLIC_INFO && window.WIS_PUBLIC_INFO.csrfToken) || "", secretKey: new URLSearchParams(location.search).get("secretKey"), loggedIn: !!window.WIS_XSINFO})`,
      { timeoutMs: 15_000 }).catch(() => ({}));
    if (!this.api) {
      this.api = new SjtuApi({ baseUrl: cfg.apiBase, timeoutMs: Number(cfg.apiTimeoutMs) || 15_000 });
    }
    this.api.setCookies(jar);
    this.api.setAuth({ csrf: meta.csrf, secretKey: meta.secretKey });
    this.authAt = Date.now();
    if (this.transport !== "node") {
      this.transport = "node";
      log(`改用 Node 直连接口（复用了浏览器 cookie，csrf=${meta.csrf ? "已取" : "空"}）—— 单次请求约 20–30ms`);
    }
    return true;
  }

  /** 一次检查：优先 Node 直连，失败/过期时回退页面内 fetch */
  async checkOnce(cfg, t, { withEnrolled = true } = {}) {
    const canNode = cfg.transport !== "page" && Date.now() >= this.nodeDownUntil;
    if (canNode) {
      try {
        if (await this.ensureAuth(cfg)) {
          let info = await this.api.check([t.bjmc], { withEnrolled });
          if (info && (info.loginNeeded || info.apiError)) {
            // cookie 可能过期 → 强刷一次再重试
            if (await this.ensureAuth(cfg, { force: true })) info = await this.api.check([t.bjmc], { withEnrolled });
          }
          if (info && !info.loginNeeded && !info.apiError) return info;
          this.nodeDownUntil = Date.now() + 60_000;
          log(`Node 直连返回异常（${info && (info.loginNeeded ? "需要登录" : info.apiError)}），60s 内改走页面内检查`);
        } else {
          this.nodeDownUntil = Date.now() + 60_000;
          log("拿不到浏览器 cookie，60s 内改走页面内检查");
        }
      } catch (e) {
        this.nodeDownUntil = Date.now() + 60_000;
        log("Node 直连失败，60s 内改走页面内检查: " + String(e && e.message || e).slice(0, 140));
      }
    }
    return this.evalPage(cfg, checkExpr([t.bjmc], { withEnrolled }), 30_000);
  }

  /** 提交选课：优先 Node 直连 */
  async selectOnce(cfg, cand, t) {
    if (cfg.transport !== "page" && Date.now() >= this.nodeDownUntil && this.api && this.api.cookie) {
      try {
        return await this.api.select(cand.bjdm, t.lx, { maxWaitMs: cfg.selectTimeoutMs });
      } catch (e) {
        log("Node 直连选课失败，回退页面内提交: " + String(e && e.message || e).slice(0, 140));
      }
    }
    return this.evalPage(cfg, selectExpr({ bjdm: cand.bjdm, lx: t.lx, maxWaitMs: cfg.selectTimeoutMs }), cfg.selectTimeoutMs + 30_000);
  }

  // ---------------- 通知 ----------------
  /** 同一事件只通知一次；事件被 clearEpisode 后可再次通知（受 notifyCooldownMs 节流） */
  notify(key, text, cfg) {
    const now = Date.now();
    if (this.episode.has(key)) return;
    const cd = Number(cfg.notifyCooldownMs) || 0;
    if (cd > 0 && now - (this.notifiedAt.get(key) || 0) < cd) { this.episode.add(key); return; }
    this.notifiedAt.set(key, now);
    this.episode.add(key);
    notifyEM(text);
  }

  clearEpisode(key) { this.episode.delete(key); }

  interval(cfg) {
    const lo = Number(cfg.minIntervalMs) || 25_000;
    const hi = Math.max(lo, Number(cfg.maxIntervalMs) || lo);
    return rand(lo, hi);
  }

  /** 同一条日志内容不重复刷（内容变化才打印） */
  logThrottled(bjmc, text, { force = false } = {}) {
    const prev = this.lastLog.get(bjmc);
    if (!force && prev && prev.text === text) return;
    this.lastLog.set(bjmc, { text, at: Date.now() });
    log(`[${short(bjmc)}] ${text}`);
  }

  // ---------------- 单目标处理 ----------------
  /** 做一次检查并把结果落到日志/状态；返回处理结论 */
  async handleInfo(ctx, t, cfg, info) {
    const a = analyze(t, info.rows, info.enrolled);
    ctx.lastAnalysis = a;
    writeState({
      ["target:" + t.bjmc]: {
        at: Date.now(),
        total: info.total,
        matched: a.matched.length,
        qualified: a.pool.length,
        vacant: a.ranked.filter((c) => c.vacancy).length,
        best: a.best ? { bjmc: a.best.bjmc, teacher: a.best.teacher, time: a.best.time, campus: a.best.campus, dqrs: a.best.dqrs, kxrs: a.best.kxrs, vacancy: a.best.vacancy } : null,
      },
    });

    if (a.enrolled) {
      this.logThrottled(t.bjmc, `已选上：${describe(a.enrolled)}`, { force: true });
      this.notify("target-done:" + t.bjmc, `✅ ${t.bjmc}（${t.name || ""}）已选上：${describe(a.enrolled)}，该课程停止监测。`, cfg);
      ctx.result = { target: t, reason: "enrolled", chosen: a.enrolled };
      ctx.done = true;
      this.states.set(t.bjmc, "enrolled");
      return "enrolled";
    }

    const candText = `候选${a.matched.length} 校区内${a.onCampus.length} 符合条件${a.pool.length} 有空位${a.ranked.filter((c) => c.vacancy).length}`;
    const bestText = a.best ? describe(a.best) : (a.matched.length ? "无符合条件班级" : "该课程代码下没有班级");
    const waitText = a.firstPriority && (!a.best || a.best.bjdm !== a.firstPriority.bjdm) ? ` 首选=${describe(a.firstPriority)}` : "";
    ctx.summary = `${candText} 最优=${bestText}${waitText}`;
    this.logThrottled(t.bjmc, ctx.summary);

    if (!a.best) {
      if (a.reason === "no-course") {
        this.notify("norow:" + t.bjmc, `⚠️ ${t.bjmc}：选课列表里没有该课程代码的班级（本轮 total=${info.total}）。确认课程代码是否正确、是否在本轮开放。`, cfg);
      } else if (a.reason === "no-campus") {
        const where = t.campus ? `校区「${t.campus}」` : "校区";
        this.notify("nocampus:" + t.bjmc, `⚠️ ${t.bjmc}：找到 ${a.matched.length} 个班级，但没有一个符合${where}，按规则不选。现有：${a.matched.slice(0, 4).map(describe).join("；")}`, cfg);
      } else {
        const miss = [t.teachers.length && `教师 ${t.teachers.join("/")}`, t.time && `时间 ${t.time}`].filter(Boolean).join("、") || "教师/时间";
        this.notify("nofit:" + t.bjmc, `⚠️ ${t.bjmc}：闵行等校区内有 ${a.onCampus.length} 个班级，但没有符合${miss}的（当前严格模式，不降级），暂不选课。`, cfg);
      }
      return "nofit";
    }

    if (!a.best.vacancy) {
      this.notify("vac:" + t.bjmc, `⏳ ${bestText} 已满，正在等待空位…`, cfg);
      return "full";
    }
    return "vacancy";
  }

  /** 提交选课（同一目标同一时刻只允许一次） */
  async submit(ctx, t, cfg) {
    if (ctx.submitting || ctx.done) return;
    const a = ctx.lastAnalysis;
    if (!a || !a.best || !a.best.vacancy) return;
    ctx.submitting = true;
    const cand = a.best;
    try {
      this.clearEpisode("vac:" + t.bjmc);
      this.logThrottled(t.bjmc, `发现空位：${describe(cand)}`, { force: true });
      this.notify("found:" + t.bjmc, `🔔 ${t.bjmc} 出现空位：${describe(cand)}，正在自动选课…`, cfg);
      if (DRY) { ctx.result = { target: t, reason: "dry", chosen: cand }; ctx.done = true; return; }

      ctx.stats.submits++;
      let out;
      try {
        out = await this.selectOnce(cfg, cand, t);
      } catch (e) {
        out = { ok: false, stage: "exception", detail: e.message };
      }
      if (!out || out.__noPage) out = { ok: false, stage: "no-page", detail: "选课页标签丢失" };

      if (out.ok) {
        log(`[${short(t.bjmc)}] 选课成功：${cand.bjmc}（${out.detail || ""}）`);
        this.notify("ok:" + t.bjmc, `✅ 选课成功：${cand.bjmc}（${cand.kcmc}）${cand.teacher ? " " + cand.teacher : ""}。`, cfg);
        ctx.result = { target: t, reason: "enrolled", chosen: cand };
        ctx.done = true;
        this.states.set(t.bjmc, "enrolled");
        return;
      }
      const detail = typeof out.detail === "string" ? out.detail : JSON.stringify(out.detail || {});
      log(`[${short(t.bjmc)}] 未成功(stage=${out.stage})：${String(detail).slice(0, 200)}`);
      this.notify("fail:" + t.bjmc, `⚠️ ${cand.bjmc} 出现空位但本次未选上（${out.stage}）：${String(detail).slice(0, 180)}。继续监测。`, cfg);
      this.clearEpisode("vac:" + t.bjmc); // 允许下一轮空位再次尝试/通知
      await sleep(cfg.failCooldownMs);
    } finally {
      ctx.submitting = false;
    }
  }

  // ---------------- 轮询循环 ----------------
  async loopSequential(ctx, cfgProvider) {
    const t0 = ctx.target;
    while (!this.stop && !ctx.done) {
      const cfg = loadCfg();
      const t = cfg.targets.find((x) => x.bjmc === t0.bjmc) || t0;
      if (Date.now() >= cfg.deadlineDate.getTime()) { ctx.result = { target: t, reason: "deadline" }; ctx.done = true; break; }
      if (await this.oneRound(ctx, t, cfg) === "stop") break;
    }
    return ctx.result;
  }

  async loopCrazy(ctx, cfgProvider) {
    const t0 = ctx.target;
    let lastStats = Date.now(), windowChecks = 0;
    while (!this.stop && !ctx.done) {
      const cfg = loadCfg();
      const t = cfg.targets.find((x) => x.bjmc === t0.bjmc) || t0;
      const fullEvery = Math.max(1, Number(cfg.fullCheckEvery) || 10);
      if (Date.now() >= cfg.deadlineDate.getTime()) { ctx.result = { target: t, reason: "deadline" }; ctx.done = true; break; }

      // 每隔 statsEveryMs 打一行「实测速率」，否则疯狂模式下日志看起来像卡住了
      const now = Date.now();
      if (now - lastStats >= (Number(cfg.statsEveryMs) || 10_000)) {
        const dt = (now - lastStats) / 1000;
        const rate = dt > 0 ? ((ctx.stats.checks - windowChecks) / dt).toFixed(1) : "-";
        windowChecks = ctx.stats.checks;
        lastStats = now;
        this.logThrottled(t.bjmc,
          `疯狂轮询：累计检查 ${ctx.stats.checks} 次（实测 ${rate} 次/秒）｜在途 ${ctx.inflight}｜错误 ${ctx.stats.errors}｜提交 ${ctx.stats.submits}｜${ctx.summary || "-"}`,
          { force: true });
      }

      // 正在提交 / 在途已达上限 → 先不发起新请求
      if (ctx.submitting || ctx.inflight >= cfg.concurrency) { await sleep(5); continue; }

      ctx.inflight++;
      // 轻量检查：只拉候选班级（1 次请求）——疯狂模式下已选状态每 fullCheckEvery 次查一次
      const n = ctx.stats.checks;
      const full = n === 0 || n % fullEvery === 0;
      ctx.stats.checks++;
      this.checkOnce(cfg, t, { withEnrolled: full })
        .then(async (info) => {
          if (info && info.__noPage) info = { __error: "找不到选课页标签" };
          if (info && info.__error) {
            ctx.stats.errors++;
            this.notify("conn", `⚠️ 无法继续：${info.__error}。请确认 Edge 已开启远程调试（edge://inspect/#remote-debugging）并接受首次授权提示（点『允许』），然后脚本会自动重连。`, cfg);
            return;
          }
          if (info.loginNeeded || (!info.loggedIn && info.apiError)) {
            this.notify("login", "⚠️ 需要登录：选课会话可能已失效，请在 Edge 中重新登录 jAccount 并打开选课页（脚本会继续重试）。", cfg);
            return;
          }
          if (info.captcha) {
            this.notify("captcha", "⚠️ 需要验证码：选课页出现验证码，请在 Edge 中处理（脚本会继续重试）。", cfg);
            return;
          }
          this.clearEpisode("conn");
          this.clearEpisode("login");
          this.clearEpisode("captcha");
          const verdict = await this.handleInfo(ctx, t, cfg, info);
          if (verdict === "vacancy") await this.submit(ctx, t, cfg);
        })
        .catch((e) => {
          ctx.stats.errors++;
          const msg = String(e && e.message || e);
          if (ctx.stats.errors <= 3 || ctx.stats.errors % 50 === 0) log(`[${short(t.bjmc)}] 检查异常(${ctx.stats.errors})：${msg.slice(0, 120)}`);
        })
        .finally(() => { ctx.inflight--; });

      // 无 sleep：槽位一空就立即发下一次（速率 = 在途数 ÷ 单次耗时）
      await sleep(Number(cfg.launchDelayMs) || 0);
    }
    return ctx.result;
  }

  /** 常规模式的一轮：检查 → 处理 → 需要时提交 */
  async oneRound(ctx, t, cfg) {
    let info;
    try { info = await this.checkOnce(cfg, t, { withEnrolled: true }); }
    catch (e) { info = { __error: e.message }; }
    if (info && info.__noPage) info = { __error: "找不到选课页标签" };

    if (info && info.__error) {
      ctx.stats.errors++;
      this.notify("conn", `⚠️ 无法继续：${info.__error}。请确认 Edge 已开启远程调试（edge://inspect/#remote-debugging）并接受首次授权提示（点『允许』），然后脚本会自动重连。`, cfg);
      if (DRY) { ctx.result = { target: t, reason: "dry-error", error: info.__error }; ctx.done = true; return "stop"; }
      await sleep(cfg.reconnectBackoffMs);
      return "retry";
    }
    if (info.loginNeeded || (!info.loggedIn && info.apiError)) {
      this.notify("login", "⚠️ 需要登录：选课会话可能已失效，请在 Edge 中重新登录 jAccount 并打开选课页（脚本会继续重试）。", cfg);
      if (DRY) { ctx.result = { target: t, reason: "dry-login" }; ctx.done = true; return "stop"; }
      await sleep(this.interval(cfg));
      return "retry";
    }
    if (info.captcha) {
      this.notify("captcha", "⚠️ 需要验证码：选课页出现验证码，请在 Edge 中处理（脚本会继续重试）。", cfg);
      if (DRY) { ctx.result = { target: t, reason: "dry-captcha" }; ctx.done = true; return "stop"; }
      await sleep(this.interval(cfg));
      return "retry";
    }
    this.clearEpisode("conn");
    this.clearEpisode("login");
    this.clearEpisode("captcha");

    ctx.stats.checks++;
    const verdict = await this.handleInfo(ctx, t, cfg, info);
    if (verdict === "vacancy") {
      await this.submit(ctx, t, cfg);
      if (DRY) return "stop";
      await sleep(3000);
      return "ok";
    }
    if (DRY) { ctx.result = { target: t, reason: "dry" }; ctx.done = true; return "stop"; }
    await sleep(this.interval(cfg));
    return "ok";
  }

  // ---------------- 单个课程目标的工作协程 ----------------
  async worker(target, cfgProvider) {
    const key = short(target.bjmc);
    const cond = [target.campus && `校区=${target.campus}`, target.teachers.length && `教师=${target.teachers.join("/")}`, target.time && `时间=${target.time}`].filter(Boolean).join(" ");
    log(`[${key}] 开始监测 ${target.bjmc}${target.name ? " " + target.name : ""}${cond ? " | " + cond : ""}`);
    const ctx = {
      target,
      done: false,
      submitting: false,
      inflight: 0,
      lastAnalysis: null,
      summary: "",
      result: { target, reason: "stop" },
      stats: { checks: 0, errors: 0, submits: 0, startedAt: Date.now() },
    };
    return CRAZY ? this.loopCrazy(ctx, cfgProvider) : this.loopSequential(ctx, cfgProvider);
  }

  // ---------------- 主循环（监督各协程） ----------------
  async run() {
    const cfg0 = loadCfg();
    if (!cfg0.targets.length) { log("配置里没有课程（courses 为空），退出。"); return; }
    log(`启动监测：${cfg0.targets.length} 门课 | 模式=${CRAZY ? `疯狂(不限间隔，单目标在途≤${cfg0.concurrency}，速率≈在途数÷单次耗时)` : `常规(${cfg0.minIntervalMs / 1000}-${cfg0.maxIntervalMs / 1000}s)`} | 接口=${cfg0.transport === "page" ? "页面内 fetch" : "Node 直连(优先)"} | 截止 ${cfg0.deadlineDate.toISOString()}`);
    log(`单实例锁：已获取（pid=${process.pid}，本进程只会向 Edge 建立 1 条 CDP 连接）`);
    for (const t of cfg0.targets) {
      const cond = [t.campus && `校区=${t.campus}`, t.teachers.length && `教师=${t.teachers.join("/")}`, t.time && `时间=${t.time}`].filter(Boolean).join(" ");
      log(`  目标: ${t.bjmc} ${t.name || ""}${cond ? " | " + cond : ""}${t.allowFallback ? " | 允许降级" : ""}`);
    }
    writeState({
      pid: process.pid, startedAt: Date.now(), done: false, crazy: CRAZY,
      targets: cfg0.targets.map((t) => t.bjmc), results: {},
    });

    const workers = new Map(); // bjmc -> { promise, state }
    const spawnWorker = (t) => {
      if (workers.has(t.bjmc)) return;
      const rec = { state: "running" };
      rec.promise = this.worker(t, loadCfg)
        .catch((e) => { log(`[${short(t.bjmc)}] 协程异常：${e?.stack || e}`); return { target: t, reason: "error" }; })
        .then((r) => { rec.state = r && r.reason === "enrolled" ? "enrolled" : "stopped"; rec.result = r; return r; });
      workers.set(t.bjmc, rec);
    };
    for (const t of cfg0.targets) spawnWorker(t);

    while (!this.stop) {
      await sleep(5000);
      const cfg = loadCfg();
      if (Date.now() >= cfg.deadlineDate.getTime()) {
        log("到达截止时间，停止监测");
        notifyEM(`⏹ 选课监测已到截止时间（${cfg.deadline}），已停止监测 ${workers.size} 门课。`);
        break;
      }
      for (const t of cfg.targets) spawnWorker(t); // 配置里新增的课程 → 就地补一个协程

      const st = [...workers.values()].map((w) => w.state);
      writeState({
        results: Object.fromEntries([...workers.entries()].map(([k, w]) => [k, w.state])),
        running: st.filter((s) => s === "running").length,
      });
      const allDone = st.length > 0 && st.every((s) => s !== "running");
      if (allDone && cfg.stopWhenAllEnrolled !== false) {
        const enrolled = [...workers.values()].filter((w) => w.state === "enrolled").length;
        log(`全部课程处理完毕（选上 ${enrolled}/${workers.size}），退出`);
        if (enrolled === workers.size) {
          notifyEM(`✅ 目标课程已全部选上（${[...workers.keys()].map(short).join(", ")}），监测结束。`);
        }
        break;
      }
    }

    this.stop = true;
    writeState({ done: true, results: Object.fromEntries([...workers.entries()].map(([k, w]) => [k, w.state])) });
    return [...workers.values()].map((w) => w.result);
  }
}

// ---------------------------------------------------------------- main
if (!acquireLock()) process.exit(1);
process.on("exit", releaseLock);

const m = new Runner();
process.on("SIGINT", () => { m.stop = true; });
process.on("SIGTERM", () => { m.stop = true; });

try {
  const results = await m.run();
  if (!DRY) writeState({ done: true, pid: null });
  try { m.dropCdp(); } catch {}
  await sleep(120); // 给 socket 关闭留一拍，避免 Windows 上 libuv 退出断言
  process.exit(0);
} catch (e) {
  log("致命错误: " + (e?.stack || e));
  writeState({ done: true, reason: "fatal", error: String(e?.message || e) });
  process.exit(1);
}
