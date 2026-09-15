/**
 * 直接写 Edge 的 Local State，打开远程调试门禁（不需要 UI 授权、不需要管理员）
 *   devtools.remote_debugging.allowed       = true   ← 策略层门禁（RemoteDebuggingAllowed）
 *   devtools.remote_debugging.user-enabled  = 参数  ← true 会进入「每个连接都要批准」模式
 * 用法：node patch-localstate.mjs [--user-enabled=true|false] [--restore]
 */
import fs from "node:fs";
import path from "node:path";

const P = path.join(process.env.LOCALAPPDATA, "Microsoft", "Edge", "User Data", "Local State");
const BAK = P + ".bak";

if (process.argv.includes("--restore")) {
  if (!fs.existsSync(BAK)) { console.log(JSON.stringify({ ok: false, error: "没有备份可恢复" })); process.exit(1); }
  fs.copyFileSync(BAK, P);
  console.log(JSON.stringify({ ok: true, restored: true }));
  process.exit(0);
}

const arg = process.argv.find((a) => a.startsWith("--user-enabled="));
const userEnabled = arg ? arg.split("=")[1] === "true" : false;

if (!fs.existsSync(BAK)) fs.copyFileSync(P, BAK); // 首次运行备份
const before = JSON.parse(fs.readFileSync(P, "utf8"));
const j = JSON.parse(fs.readFileSync(P, "utf8"));
j.devtools = j.devtools || {};
j.devtools.remote_debugging = j.devtools.remote_debugging || {};
j.devtools.remote_debugging.allowed = true;
j.devtools.remote_debugging["user-enabled"] = userEnabled;
fs.writeFileSync(P, JSON.stringify(j), "utf8");

console.log(JSON.stringify({
  ok: true,
  file: P,
  backup: BAK,
  before: before.devtools && before.devtools.remote_debugging,
  after: JSON.parse(fs.readFileSync(P, "utf8")).devtools.remote_debugging,
}, null, 1));
