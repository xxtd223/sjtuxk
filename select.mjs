/**
 * 目标课程筛选 / 排序（纯逻辑，可单测）
 *
 * 一个 target 描述「要抢什么课」：
 *   bjmc     必填。课程代码前缀（如 "CS7331" → 匹配所有 CS7331-xxx-yy 班级）
 *            或完整班级名称（含 "-"，如 "CS7331-03300-M01" → 精确匹配）
 *   campus   可选。校区关键词（对 XQMC 做子串匹配，如 "闵行"）—— **硬门槛**
 *   teachers 可选。任课教师关键词数组（对 RKJS 做子串匹配，如 ["赵杰茹"]）
 *   time     可选。上课时间地点关键词（对 PKSJDDMS 做子串匹配，如 "星期四"）
 *   allowFallback 可选。默认 true：优先档全满/不存在时，接 2 → 3 的顺序降级；
 *            设为 false 则严格模式（只选「教师+时间」都符合的班）。
 *   avoidConflict 可选。默认 true：**与已选课程冲突**的班级不选（IS_CONFLICT===1）。
 *            设为 false 才允许选冲突班（一般没必要，选了也会被教务拒绝/撞课）。
 *   lx       可选。提交选课时的课程来源标识，默认 "0"（计划内课程）
 *
 * 选择规则（字典序，不是加权平均）：
 *   1) 校区：**硬门槛**。只考虑符合校区的班级；一个都没有 → 不选（不会退而选别的校区）。
 *   2) 冲突：**硬门槛**（默认开启）。与已选课程冲突的班级直接排除；
 *      于是「最优=冲突班、次优=不冲突班」时会自动选后者，而不是硬抢冲突班。
 *   3) 任课教师：符合教师的班级**整档**优先于不符合的。
 *   4) 上课时间地点：没有符合教师的班级时，符合时间的优先；都不符合的最后才考虑。
 *   5) 同一档内：有空位优先 → 教师关键词位置（越靠前越优）→ 时间关键词位置 → 班级代码。
 *
 * 档位 tier：教师✔时间✔ = 0；教师✔时间✘ = 1；教师✘时间✔ = 2；都✘ = 3。
 * 只在「该档存在班级」时选该档；所以高优先档全满时是等它出空位，而不是改选低优先档。
 */

const norm = (s) => String(s ?? "").trim().toUpperCase();

/** 班级名称是否命中 target.bjmc */
export function matchBjmc(bjmc, key) {
  const k = norm(key);
  const b = norm(bjmc);
  if (!k) return false;
  if (k.includes("-")) return b === k; // 完整班级名 → 精确匹配
  return b.startsWith(k); // 课程代码 → 前缀匹配
}

/** 关键词在文本中首次出现的位置；未出现返回 -1 */
function indexOfAny(text, keys) {
  const t = String(text ?? "");
  let best = -1;
  for (const k of keys) {
    if (!k) continue;
    const i = t.indexOf(k);
    if (i >= 0 && (best < 0 || i < best)) best = i;
  }
  return best;
}

export function toArray(v) {
  if (v == null) return [];
  const a = Array.isArray(v) ? v : [v];
  return a.map((x) => String(x ?? "").trim()).filter(Boolean);
}

export function normalizeTarget(raw) {
  const bjmc = String(raw?.bjmc ?? "").trim();
  return {
    bjmc,
    name: raw?.name || "",
    campus: String(raw?.campus ?? "").trim(),
    teachers: toArray(raw?.teachers ?? raw?.teacher),
    time: String(raw?.time ?? "").trim(),
    allowFallback: raw?.allowFallback !== false, // 默认 true，显式写 false 才严格
    avoidConflict: raw?.avoidConflict !== false, // 默认 true，显式写 false 才允许选冲突班
    lx: raw?.lx != null ? String(raw.lx) : "0",
  };
}

/** 空位判定：已选人数 < 容量（容量/人数缺失时视为不可抢） */
export function hasVacancy(row) {
  const raw = (v) => v !== null && v !== undefined && v !== "";
  if (!raw(row?.dqrs) || !raw(row?.kxrs)) return false;
  const d = Number(row.dqrs);
  const k = Number(row.kxrs);
  return Number.isFinite(d) && Number.isFinite(k) && d < k;
}

const cmpRank = (a, b) =>
  Number(b.vacancy) - Number(a.vacancy) ||
  a.teacherIndex - b.teacherIndex ||
  a.timeIndex - b.timeIndex ||
  String(a.bjdm).localeCompare(String(b.bjdm));

const cmpTier = (a, b) => a.tier - b.tier || cmpRank(a, b);

/**
 * 对某门课的全部候选班级做筛选 + 排序
 * @param {object} target   normalizeTarget 的产物
 * @param {Array}  rows     该课程代码下的所有班级
 * @param {Array}  enrolled 已选课程 [{bjdm,bjmc}]
 */
export function analyze(target, rows = [], enrolled = []) {
  const enrolledBjdm = new Set(enrolled.map((e) => norm(e.bjdm)).filter(Boolean));
  const enrolledBjmc = new Set(enrolled.map((e) => norm(e.bjmc)).filter(Boolean));

  const matched = [];
  for (const r of rows) {
    if (!matchBjmc(r?.bjmc, target.bjmc)) continue;
    const tIdx = target.teachers.length ? indexOfAny(r.teacher, target.teachers) : -2;
    const teacherOk = target.teachers.length === 0 ? true : tIdx >= 0;
    const sIdx = target.time ? String(r.time ?? "").indexOf(target.time) : -2;
    const timeOk = !target.time ? true : sIdx >= 0;
    const campusOk = !target.campus ? true : String(r.campus ?? "").includes(target.campus);
    matched.push({
      row: r,
      bjmc: r.bjmc,
      bjdm: r.bjdm,
      kcmc: r.kcmc || "",
      teacher: r.teacher || "",
      campus: r.campus || "",
      time: r.time || "",
      dqrs: Number(r.dqrs),
      kxrs: Number(r.kxrs),
      vacancy: hasVacancy(r),
      campusOk,
      conflict: Number(r?.conflict) === 1, // IS_CONFLICT===1 → 与已选课程冲突
      conflictOk: Number(r?.conflict) !== 1,
      teacherOk,
      timeOk,
      tier: (teacherOk ? 0 : 2) + (timeOk ? 0 : 1),
      teacherIndex: tIdx >= 0 ? tIdx : Number.MAX_SAFE_INTEGER,
      timeIndex: sIdx >= 0 ? sIdx : Number.MAX_SAFE_INTEGER,
      enrolled: enrolledBjdm.has(norm(r.bjdm)) || enrolledBjmc.has(norm(r.bjmc)),
    });
  }

  const enrolledHit = matched.find((c) => c.enrolled) || null;

  // 校区是硬门槛：不满足的直接排除（allowFallback 也不放宽这一条）
  const onCampus = matched.filter((c) => c.campusOk);
  // 冲突也是硬门槛（默认）：与已选课程冲突的班直接排除，避免「选了也白选」（教务拒绝/撞课）
  const selectable = target.avoidConflict ? onCampus.filter((c) => !c.conflict) : onCampus;
  // 严格模式只考虑 tier 0（教师+时间都符合）；允许降级时才纳入其它档
  const pool = target.allowFallback ? selectable : selectable.filter((c) => c.tier === 0);

  // 选中的档 = pool 里存在的最低档（高优先档全满时等空位，不改选低档）
  const bestTier = pool.length ? Math.min(...pool.map((c) => c.tier)) : null;
  const ranked = pool.filter((c) => c.tier === bestTier).sort(cmpRank);
  const firstPriority = [...pool].sort(cmpTier)[0] || null;

  const reason = matched.length === 0 ? "no-course"
    : onCampus.length === 0 ? "no-campus"
    : selectable.length === 0 ? "all-conflict"
    : pool.length === 0 ? "no-qualified"
    : null;

  return {
    target,
    matched,
    onCampus,
    selectable,
    pool,
    ranked,
    best: ranked[0] || null,
    bestVacant: ranked.find((c) => c.vacancy) || null,
    firstPriority,
    enrolled: enrolledHit,
    bestTier,
    reason,
    stats: {
      matched: matched.length,
      campusOk: onCampus.length,
      teacherOk: matched.filter((c) => c.teacherOk && c.campusOk).length,
      timeOk: matched.filter((c) => c.timeOk && c.campusOk).length,
      conflict: matched.filter((c) => c.conflict && c.campusOk).length,
      vacant: matched.filter((c) => c.vacancy && c.campusOk).length,
    },
  };
}

export function describe(c) {
  if (!c) return "-";
  const bits = [];
  if (c.conflict) bits.push("⚠冲突");
  if (c.teacher) bits.push(c.teacher);
  if (c.time) bits.push(c.time);
  const cap = Number.isFinite(c.dqrs) ? `${c.dqrs}/${c.kxrs}` : "容量未知";
  return `${c.bjmc}(${bits.join(" | ") || c.kcmc}) ${cap}`;
}
