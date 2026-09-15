/**
 * Node 侧直连选课接口（复用浏览器里已登录的 cookie）
 *
 * 为什么不在页面里 fetch：
 *   教务站是 HTTP/1.1，浏览器对同源只开 6 条连接。页面内并发会被连接池卡死，
 *   而且请求要过一遍渲染进程（实测 130ms+，拥堵时直接挂住）。
 *   Node 直连实测 20–30ms/次（keep-alive），单并发就能到 30–50 次/秒。
 *
 * 这里只做「取 cookie / csrf」时需要浏览器（CDP），业务请求全部在 Node 侧发。
 */
const DEFAULT_BASE = "https://yjsxk.sjtu.edu.cn/yjsxkapp";

export class SjtuApi {
  constructor({ baseUrl = DEFAULT_BASE, timeoutMs = 15_000, referer } = {}) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, "");
    this.timeoutMs = timeoutMs;
    this.referer = referer || this.baseUrl + "/sys/xsxkapp/course.html";
    this.cookie = "";
    this.csrf = "";
    this.secretKey = null;
    this.stats = { req: 0, err: 0 };
  }

  setCookies(str) { this.cookie = String(str || ""); }
  setAuth({ csrf, secretKey }) {
    if (csrf !== undefined) this.csrf = String(csrf || "");
    if (secretKey !== undefined) this.secretKey = secretKey || null;
  }

  async post(pathname, body, { timeoutMs } = {}) {
    const url = this.baseUrl + pathname + "?_=" + Date.now() + "." + Math.random().toString(36).slice(2);
    const headers = {
      "X-Requested-With": "XMLHttpRequest",
      "Referer": this.referer,
      "Origin": new URL(this.baseUrl).origin,
    };
    if (this.cookie) headers["Cookie"] = this.cookie;
    if (body) headers["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8";
    this.stats.req++;
    let r;
    try {
      r = await fetch(url, {
        method: "POST",
        headers,
        body: body || undefined,
        signal: AbortSignal.timeout(timeoutMs || this.timeoutMs),
      });
    } catch (e) {
      this.stats.err++;
      return { error: String((e && e.message) || e) };
    }
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text: text.slice(0, 400) };
  }

  /** 与页面版 checkExpr 返回同样的结构 */
  async check(keys, { withEnrolled = true } = {}) {
    const out = { url: this.baseUrl + "/sys/xsxkapp/course.html", loggedIn: true, rows: [], enrolled: [], captcha: false };
    const q = await this.post("/sys/xsxkapp/xsxkCourse/loadJhnCourseInfo.do", "pageIndex=1&pageSize=2000&sortField=&sortOrder=");
    if (q.error) { out.apiError = q.error; return out; }
    if (!q.json) {
      out.apiError = "HTTP " + q.status + " :: " + String(q.text || "").replace(/\s+/g, " ");
      out.loginNeeded = q.status === 401 || q.status === 403 || /login|jaccount|统一身份|登录/i.test(q.text || "");
      return out;
    }
    if (q.json.loginURL) { out.loginNeeded = true; return out; }
    const datas = q.json.datas || [];
    out.total = q.json.total;
    const match = (bjmc, key) => {
      const k = String(key || "").trim().toUpperCase();
      const b = String(bjmc || "").trim().toUpperCase();
      if (!k) return false;
      return k.includes("-") ? b === k : b.startsWith(k);
    };
    const pick = (r) => ({
      bjmc: r.BJMC || "", bjdm: r.BJDM || "", kcdm: r.KCDM || "", kcmc: r.KCMC || "",
      teacher: r.RKJS || "", campus: r.XQMC || "", time: r.PKSJDDMS || "",
      dqrs: r.DQRS === undefined || r.DQRS === null || r.DQRS === "" ? null : Number(r.DQRS),
      kxrs: r.KXRS === undefined || r.KXRS === null || r.KXRS === "" ? null : Number(r.KXRS),
      conflict: r.IS_CONFLICT, dept: r.RWKKDWMC || "", lang: r.SKYYMC || "", credit: r.XF || r.KCXF || "",
    });
    for (const r of datas) if (keys.some((k) => match(r.BJMC, k))) out.rows.push(pick(r));

    if (withEnrolled) {
      const s = await this.post("/sys/xsxkapp/xsxkCourse/loadStdCourseInfo.do", null);
      ((s.json && s.json.results) || []).forEach((r) => out.enrolled.push({ bjdm: r.BJDM || "", bjmc: r.BJMC || "", kcmc: r.KCMC || "" }));
    } else {
      out.enrolledSkipped = true;
    }
    return out;
  }

  /** 提交选课 + 轮询结果；返回结构与页面版 selectExpr 一致 */
  async select(bjdm, lx = "0", { maxWaitMs = 60_000 } = {}) {
    const body = new URLSearchParams({ bjdm: String(bjdm), lx: String(lx), csrfToken: this.csrf });
    if (this.secretKey) body.set("secretKey", this.secretKey);
    const q = await this.post("/sys/xsxkapp/xsxkCourse/choiceCourse.do", body.toString());
    if (q.error) return { ok: false, stage: "submit-error", detail: q.error, bjdm };
    if (!q.json) return { ok: false, stage: "submit", detail: "HTTP " + q.status + " :: " + q.text, bjdm };
    if (Number(q.json.code) === 0) return { ok: false, stage: "rejected", detail: q.json.msg || "选课失败", bjdm };
    const xid = q.json.msg;
    if (!xid) return { ok: false, stage: "no-xid", detail: JSON.stringify(q.json).slice(0, 200), bjdm };

    const until = Date.now() + maxWaitMs;
    let attempt = 0, delay = 500;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, delay));
      attempt++;
      const r2 = await this.post("/sys/xsxkapp/xsxkCourse/loadXkjgRes.do", new URLSearchParams({ xid: String(xid), sfhqdqxkqqs: attempt === 1 ? "1" : "0" }).toString());
      if (r2.error || !r2.json) { delay = 1000; continue; }
      const msg = r2.json.msg;
      if (msg === undefined || msg === null || String(msg) === "") { delay = 1000 + Math.floor(Math.random() * 2000); continue; }
      let parsed = null; try { parsed = JSON.parse(msg); } catch {}
      if (parsed && Number(parsed.code) === 1) return { ok: true, stage: "api", xid: String(xid), detail: parsed.msg || "选课成功", attempts: attempt, bjdm };
      return { ok: false, stage: "server", detail: (parsed && parsed.msg) || String(msg), xid: String(xid), attempts: attempt, bjdm };
    }
    return { ok: false, stage: "timeout", detail: "等待选课结果超时（" + Math.round(maxWaitMs / 1000) + "s）", xid: String(xid), attempts: attempt, bjdm };
  }
}
