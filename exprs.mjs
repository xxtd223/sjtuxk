// 注入页面执行的表达式（字符串形式，配置以字面量注入，避免闭包变量丢失）
//
// 说明：字段名取自 SJTU 研究生选课前端自己的表格定义
// （/yjsxkapp/sys/xsxkapp/public/courseTableFieldDefine.js）：
//   BJMC 班级名称 / BJDM 班级代码 / KCDM 课程代码 / KCMC 课程名称
//   RKJS 任课教师 / XQMC 校区 / PKSJDDMS 上课时间地点
//   DQRS 当前人数 / KXRS 可选人数(容量) / RWKKDWMC 开课院系 / SKYYMC 授课语言

/** 拉取候选班级 + 已选课程（withEnrolled=false 时只拉候选班级，少一次请求 → 疯狂模式更快） */
export function checkExpr(prefixes, opts = {}) {
  const KEYS = JSON.stringify(prefixes);
  const WITH_ENROLLED = opts.withEnrolled !== false;
  return `
(async () => {
  const KEYS = ${KEYS};
  const norm = (s) => String(s == null ? "" : s).trim().toUpperCase();
  const match = (bjmc, key) => {
    const k = norm(key), b = norm(bjmc);
    if (!k) return false;
    return k.indexOf("-") >= 0 ? b === k : b.indexOf(k) === 0;
  };
  const base = (window.BaseUrl || "/yjsxkapp");
  const post = async (u, body) => {
    const r = await fetch(base + u + "?_=" + Date.now(), {
      method: body ? "POST" : "GET",
      headers: body
        ? { "X-Requested-With": "XMLHttpRequest", "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" }
        : { "X-Requested-With": "XMLHttpRequest" },
      credentials: "include",
      body: body || undefined,
    });
    const ct = r.headers.get("content-type") || "";
    const t = await r.text();
    let j = null;
    try { j = JSON.parse(t); } catch (e) {}
    return { status: r.status, ct: ct, text: t.slice(0, 300), json: j };
  };
  const out = { url: location.href, loggedIn: !!window.WIS_XSINFO, rows: [], enrolled: [], captcha: false };
  if (!${WITH_ENROLLED}) out.enrolledSkipped = true;
  const form = document.querySelector("#jhnkcQueryForm");
  const fd = (form && window.jQuery) ? jQuery(form).serialize() : "";
  const q = await post("/sys/xsxkapp/xsxkCourse/loadJhnCourseInfo.do", fd + "&pageIndex=1&pageSize=2000&sortField=&sortOrder=");
  if (!q.json) {
    out.apiError = "HTTP " + q.status + " " + q.ct + " :: " + q.text.replace(/\\s+/g, " ");
    out.loginNeeded = /login|jaccount|统一身份|登录/i.test(q.text) || q.status === 401 || q.status === 403;
    return out;
  }
  if (q.json.loginURL) { out.loginNeeded = true; return out; }
  const datas = q.json.datas || [];
  out.total = q.json.total;
  const pick = (r) => ({
    bjmc: r.BJMC || "",
    bjdm: r.BJDM || "",
    kcdm: r.KCDM || "",
    kcmc: r.KCMC || "",
    teacher: r.RKJS || "",
    campus: r.XQMC || "",
    time: r.PKSJDDMS || "",
    dqrs: r.DQRS === undefined || r.DQRS === null || r.DQRS === "" ? null : Number(r.DQRS),
    kxrs: r.KXRS === undefined || r.KXRS === null || r.KXRS === "" ? null : Number(r.KXRS),
    conflict: r.IS_CONFLICT,
    dept: r.RWKKDWMC || "",
    lang: r.SKYYMC || "",
    credit: r.XF || r.KCXF || "",
  });
  for (const r of datas) {
    const bjmc = String(r.BJMC || "");
    if (KEYS.some((k) => match(bjmc, k))) out.rows.push(pick(r));
  }
  const s = ${WITH_ENROLLED} ? await post("/sys/xsxkapp/xsxkCourse/loadStdCourseInfo.do", null) : null;
  ((s && s.json && s.json.results) || []).forEach(function (r) {
    out.enrolled.push({ bjdm: r.BJDM || "", bjmc: r.BJMC || "", kcmc: r.KCMC || "" });
  });
  out.captcha = !!document.querySelector('input[name*="captcha" i],input[id*="captcha" i],input[name*="yzm" i],img[src*="captcha" i],[class*="captcha" i]');
  return out;
})()
`;
}

/**
 * 提交选课：直接调用选课页自己的接口
 *   POST choiceCourse.do { bjdm, lx, csrfToken[, secretKey] } → 返回 xid
 *   POST loadXkjgRes.do  { xid, sfhqdqxkqqs }               → 轮询结果
 * 参考 coursejsp.js 中 doChoiceCourse / doChoiceCourseLoadXkjgRes 的实现。
 */
export function selectExpr({ bjdm, lx = "0", maxWaitMs = 60_000 }) {
  return `
(async () => {
  const BJDM = ${JSON.stringify(bjdm)};
  const LX = ${JSON.stringify(String(lx))};
  const MAX_WAIT = ${Number(maxWaitMs) || 60_000};
  const base = (window.BaseUrl || "/yjsxkapp");
  const req = (u, body) => new Promise((resolve) => {
    fetch(base + u + "?_=" + Date.now(), {
      method: "POST",
      headers: { "X-Requested-With": "XMLHttpRequest", "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
      credentials: "include",
      body: body,
    }).then(async (r) => {
      const t = await r.text();
      let j = null; try { j = JSON.parse(t); } catch (e) {}
      resolve({ status: r.status, json: j, text: t.slice(0, 300) });
    }).catch((e) => resolve({ error: String(e && e.message || e) }));
  });
  const csrfEl = document.querySelector("#csrfToken");
  const csrf = (csrfEl && csrfEl.value) || (window.WIS_PUBLIC_INFO && window.WIS_PUBLIC_INFO.csrfToken) || "";
  let secretKey = null;
  try { secretKey = new URLSearchParams(location.search).get("secretKey"); } catch (e) {}
  const body = new URLSearchParams({ bjdm: BJDM, lx: LX, csrfToken: csrf });
  if (secretKey) body.set("secretKey", secretKey);

  const q = await req("/sys/xsxkapp/xsxkCourse/choiceCourse.do", body.toString());
  if (q.error) return { ok: false, stage: "submit-error", detail: q.error, bjdm: BJDM };
  if (!q.json) return { ok: false, stage: "submit", detail: "HTTP " + q.status + " :: " + q.text, bjdm: BJDM };
  if (Number(q.json.code) === 0) return { ok: false, stage: "rejected", detail: q.json.msg || "选课失败", bjdm: BJDM };
  const xid = q.json.msg;
  if (!xid) return { ok: false, stage: "no-xid", detail: JSON.stringify(q.json).slice(0, 200), bjdm: BJDM };

  const until = Date.now() + MAX_WAIT;
  let attempt = 0, delay = 500;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, delay));
    attempt++;
    const r2 = await req("/sys/xsxkapp/xsxkCourse/loadXkjgRes.do", new URLSearchParams({ xid: String(xid), sfhqdqxkqqs: attempt === 1 ? "1" : "0" }).toString());
    if (r2.error || !r2.json) { delay = 1000; continue; }
    const msg = r2.json.msg;
    if (msg === undefined || msg === null || String(msg) === "") { delay = 1000 + Math.floor(Math.random() * 2000); continue; }
    let parsed = null; try { parsed = JSON.parse(msg); } catch (e) {}
    if (parsed && Number(parsed.code) === 1) {
      return { ok: true, stage: "api", xid: String(xid), detail: parsed.msg || "选课成功", attempts: attempt, bjdm: BJDM };
    }
    return { ok: false, stage: "server", detail: (parsed && parsed.msg) || String(msg), xid: String(xid), attempts: attempt, bjdm: BJDM };
  }
  return { ok: false, stage: "timeout", detail: "等待选课结果超时（" + Math.round(MAX_WAIT / 1000) + "s）", xid: String(xid), attempts: attempt, bjdm: BJDM };
})()
`;
}
