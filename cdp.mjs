// Minimal CDP client over the running Edge browser (consent-gated remote debugging).
// Reads the DevToolsActivePort file each time so it survives Edge restarts.
import fs from "node:fs";

export const EDGE_PORTFILE =
  process.env.EDGE_DEVTOOLS_PORTFILE ||
  "C:\\Users\\86159\\AppData\\Local\\Microsoft\\Edge\\User Data\\DevToolsActivePort";

export function readCdpWsUrl() {
  const raw = fs.readFileSync(EDGE_PORTFILE, "utf8");
  const lines = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const port = lines[0];
  const path = lines[1];
  if (!port || !path) throw new Error("DevToolsActivePort malformed: " + raw);
  return `ws://127.0.0.1:${port}${path}`;
}

async function connectOnce(url, timeoutMs) {
  const ws = new WebSocket(url);
  const client = new Cdp(ws);
  const cleanup = () => { try { ws.close(); } catch {} };
  await new Promise((resolve, reject) => {
    const to = setTimeout(() => { cleanup(); reject(new Error(`CDP connect timeout after ${timeoutMs}ms (${url})`)); }, timeoutMs);
    ws.addEventListener("open", () => { clearTimeout(to); resolve(); }, { once: true });
    ws.addEventListener("error", (e) => { clearTimeout(to); cleanup(); reject(new Error("CDP ws error: " + (e?.message || "unknown"))); }, { once: true });
  });
  client.start();
  return client;
}

export async function connect(timeoutMs = 15000, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    let url;
    try { url = readCdpWsUrl(); } catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 800)); continue; }
    try {
      return await connectOnce(url, timeoutMs);
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1200 + i * 800));
    }
  }
  throw lastErr || new Error("CDP connect failed");
}

export class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    // targetId -> sessionId, 复用同一页面会话，避免每次 evaluate 都 attach（减少对浏览器的操作）
    this.pageSessions = new Map();
  }

  start() {
    this.ws.addEventListener("message", (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (timer) clearTimeout(timer);
        if (msg.error) reject(new Error(`CDP ${msg.error.code}: ${msg.error.message}`));
        else resolve(msg.result);
      }
    });
    this.ws.addEventListener("close", () => {
      this.closed = true;
      for (const { reject, timer } of this.pending.values()) { if (timer) clearTimeout(timer); reject(new Error("CDP socket closed")); }
      this.pending.clear();
    });
    this.ws.addEventListener("error", () => {});
  }

  send(method, params = {}, sessionId, timeoutMs = 20000) {
    if (this.closed) return Promise.reject(new Error("CDP socket closed"));
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs ? setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timeout after ${timeoutMs}ms`));
      }, timeoutMs) : null;
      this.pending.set(id, { resolve, reject, timer });
      try { this.ws.send(JSON.stringify(payload)); }
      catch (e) { this.pending.delete(id); if (timer) clearTimeout(timer); reject(e); }
    });
  }

  async targets() {
    const { targetInfos = [] } = await this.send("Target.getTargets");
    return targetInfos;
  }

  async pages() {
    const t = await this.targets();
    return t.filter((x) => x.type === "page");
  }

  async findPage(pred) {
    const pages = await this.pages();
    return pages.find(pred) || null;
  }

  async attach(targetId) {
    const cached = this.pageSessions.get(targetId);
    if (cached) return cached;
    // 缓存 Promise，避免多协程并发 attach 同一页面时重复建立会话
    const p = this.send("Target.attachToTarget", { targetId, flatten: true })
      .then(({ sessionId }) => {
        this.pageSessions.set(targetId, sessionId);
        return sessionId;
      })
      .catch((e) => {
        this.pageSessions.delete(targetId);
        throw e;
      });
    this.pageSessions.set(targetId, p);
    return p;
  }

  dropSession(targetId) {
    this.pageSessions.delete(targetId);
  }

  // Run a function (as string body) inside a page. `fn` must be self-contained.
  async evaluate(targetId, fnOrExpr, { timeoutMs = 20000, userGesture = true } = {}) {
    const expression = typeof fnOrExpr === "string" ? fnOrExpr : `(${fnOrExpr.toString()})()`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const sessionId = await this.attach(targetId);
      try {
        const res = await this.send(
          "Runtime.evaluate",
          { expression, returnByValue: true, awaitPromise: true, userGesture },
          sessionId,
          timeoutMs,
        );
        if (res.exceptionDetails) {
          const d = res.exceptionDetails;
          throw new Error("page eval error: " + (d.exception?.description || d.text || JSON.stringify(d)).slice(0, 500));
        }
        return res.result?.value;
      } catch (e) {
        // 会话可能已失效（页面刷新/关闭）：丢弃后重试一次
        this.dropSession(targetId);
        if (attempt === 1) throw e;
      }
    }
  }

  close() {
    try { this.ws.close(); } catch {}
  }
}
