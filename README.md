# SJTU 研究生选课助手

按**课程代码前缀**自动识别该课程的所有班级，按「校区 → 任课教师 → 上课时间地点」字典序优先级挑选，
出现空位立即提交选课。多门课并行监测，复用你自己浏览器里已登录的会话。

```
node monitor.mjs --dry     # 跑一遍看结果：打印识别到的班级与排序，不选课
node monitor.mjs           # 常规抢课
node monitor.mjs -crz      # 疯狂模式
```

---

## 环境与系统要求

| 项目 | 要求 |
| --- | --- |
| 操作系统 | Windows 10 / 11 |
| Node.js | ≥ 18 |
| 浏览器 | Microsoft Edge，保持运行且**已开启远程调试**，并已登录选课、打开选课页 |
| 通知通道（可选） | `openclaw` CLI |

## 快速开始

```powershell
node monitor.mjs --dry        # 1. 先干跑：确认识别到的班级、筛选结果、排序是否符合预期
node monitor.mjs              # 2. 正式开抢（常规模式）
node monitor.mjs -crz         # 3. 疯狂模式
```

停止：结束对应 node 进程即可（`Stop-Process -Id <pid> -Force`）。同一时间只能跑一个实例。

---

## 配置 `monitor.config.json`

把 `monitor.config.example.json` 复制成 `monitor.config.json`，改成自己的课程即可：

```json
{
  "courses": [
    {
      "bjmc": "ABC1001",
      "name": "示例课程一",
      "campus": "闵行",
      "teachers": ["张三"],
      "time": "星期四",
      "allowFallback": true,
      "lx": "0"
    },
    { "bjmc": "ABC1002", "name": "示例课程二", "lx": "0" }
  ],
  "minIntervalMs": 25000,
  "maxIntervalMs": 35000,
  "deadline": "2026-09-24T20:00:00+08:00"
}
```

课程字段（每门课一条）：

* `bjmc` 必填。课程代码前缀 `"ABC1001"` 命中所有 `ABC1001-*` 班级；写完整班级名（含 `-`）则精确命中。
* `campus` / `teachers` / `time` 可选，不填即不参与筛选；三者都对目标字段做子串匹配（优先级见下方「选课优先级」，其中校区是硬门槛）。
* `allowFallback`：默认 `true`；显式写 `false` 才是严格模式（只选「教师+时间」都符合的班）。
* `lx`：提交选课时的课程来源标识，默认 `"0"`（计划内课程）。

运行参数：`minIntervalMs` / `maxIntervalMs`（常规模式的每轮间隔）、`deadline`（到点自动停止）、
`logEveryMs`（日志心跳间隔，默认 120000）。其余参数见 `monitor.mjs` 顶部的 `DEFAULTS`。

> 每轮都会重新读取配置：**改筛选条件无需重启**；**新增/删除课程需要重启进程**。

### 用自己的配置

直接改 `monitor.config.json`，或用环境变量指向另一份配置：

```powershell
$env:MONITOR_CONFIG = "C:\path\to\my.config.json"
node monitor.mjs
```

## 选课优先级（挑「最优班级」）

按**字典序**逐级比较：

1. **校区是硬门槛**：只看符合校区的班级；一个都没有 → 不选。
2. **任课教师**：符合教师的班级整档优先。
3. **上课时间地点**：没有符合教师的班级时，符合时间的优先；都不符合的排最后。
4. 同一档内：**有空位优先** → 教师关键词位置（越靠前越优：`张三,李四` ＞ `李四,张三`）→ 时间位置 → 班级代码。
5. 高优先档全满时**等它出空位**，不会改选低优先档。

`allowFallback`（默认 `true`）：优先档不存在/全满时按 2 → 3 降级；写 `false` 则只选教师+时间都符合的班。
`--dry` 会打印 `候选N 校区内N 符合条件N 有空位N 最优=... 首选=...`，可直接核对。

## 行为与通知

* 命中空位 → 自动提交 → 轮询结果 → 通知成功 / 失败原因，然后继续监测；
* 已在「已选课程」中 → 该课程停止监测；
* 日志：容量有变化就立即打一行；**没变化时至少每 2 分钟打一行**（带轮次，如 `第 12 轮 · ...`），
  所以“安静”不等于“卡死”；
* 通知只在出现空位 / 成功 / 失败 / 异常时发（不会每轮都发）；
* 到达 `deadline` 自动停止；只操作配置命中的班级，不退课、不动其他课。

## 文件

|文件|说明|
|-|-|
|`monitor.mjs`|主程序|
|`monitor.config.json`|课程与参数配置（自己创建）|
|`monitor.config.example.json`|配置示例|
|`select.mjs`|筛选 / 排序逻辑|
|`sjtu-api.mjs`|接口请求（Node 直连）|
|`exprs.mjs`|接口请求（页面内 fetch）|
|`cdp.mjs`|极简 CDP 客户端|
|`start-edge-debug.ps1`|启动 Edge 并开启 / 检测调试端口|
|`patch-localstate.mjs`|写 Edge 的远程调试开关（自动备份 / 可还原）|
|`monitor.log`|运行日志（自动生成）|
|`monitor-state.json`|运行状态（自动生成）|

---

## 前置条件：让 Edge 打开调试端口

```powershell
powershell -ExecutionPolicy Bypass -File .\start-edge-debug.ps1            # Edge 已完全退出时
powershell -ExecutionPolicy Bypass -File .\start-edge-debug.ps1 -Restart   # 由脚本先强退 Edge 再启动
```

脚本会：写 Edge 的远程调试开关 → 启动 Edge（`--remote-debugging-port` + `--restore-last-session`）→ 真握手检测。

**Edge 153 的关键前提（已由脚本代劳）**：默认用户数据目录下，光传 `--remote-debugging-port` 是不起作用的
（Chromium 136+ 安全加固），而且 `edge://inspect` 里那个开关只写一半（缺 `allowed` 门禁位）。
脚本会往 Edge 的 `Local State`（普通 JSON，不需管理员）写入：

```json
"devtools": { "remote_debugging": { "allowed": true, "user-enabled": true } }
```

这会让调试服务以**批准模式**在你已登录的 profile 上启动（原文件备份为 `Local State.bak`，
可用 `node patch-localstate.mjs --restore` 还原）。

启动后在 Edge 里会弹一次 **「是否允许远程调试」→ 点允许**（每个新连接需批一次；脚本全程只维持一条
长连接，所以点一次就能长期工作，只有断线重连才会再问）。期间别用其它工具连同一个 Edge。

## 连接不上怎么办

1. 确认端口开着：`curl.exe -s http://127.0.0.1:9222/json/version`（返回 404 就是没开启，去 `edge://inspect` 拨开关）；
2. 确认 Edge 在运行、选课页标签还在；
3. Edge 重启过：脚本会自动重连，可能需要在 Edge 再点一次「允许」。

---

## 免责声明

* 本项目仅供**个人学习与技术交流**使用，禁止用于任何商业用途或牟利行为。
* 请遵守所在学校的选课规定与信息系统的使用条款；是否使用、如何使用，由使用者自行判断。
* 脚本复用你**本人浏览器中已登录的会话**，不代填账号密码，不绕过认证、验证码或任何访问控制，不修改成绩、学籍等数据。
* 选课结果、账号状态、对学校系统造成的影响等一切后果，由使用者自行承担；作者不对任何直接或间接损失负责。
* 请勿长时间高频请求，避免对学校服务器造成不必要的压力；因滥用导致的限流、封禁等后果自负。
* 使用本项目即表示你已阅读并同意以上条款；如不同意，请勿使用。
