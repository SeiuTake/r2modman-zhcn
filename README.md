# r2modman 简体中文汉化包

面向 **r2modman 3.2.20** 的简体中文汉化。**不需要 Node.js 就能安装**，只有开发期校验才用到。

**最终用户请直接下载 [Releases](../../releases) 里的 zip，看 [`pack/说明.md`](pack/说明.md)。**

```powershell
# 安装（先完全退出 r2modman）
.\pack\安装汉化.cmd
# 还原
.\pack\还原英文.cmd
```

---

## 仓库里有什么

本仓库**不包含** r2modman 的任何二进制或源码副本，只有：

- `pack/` — 安装脚本、汉化数据、说明、实测截图（这就是发布 zip 的内容）
- `verify/` — 开发期校验工具
- `build-pack.ps1` — 打包脚本

r2modman 自身的 `en-US` / `fr-FR` 文案属于 r2modman 项目（MIT, (c) ebkr），
不随仓库分发，由 `verify/extract-locales.mjs` 从你本机安装的 `app.asar` 现场抽取。

---

## 目录结构

```
r2modman-zhcn/
├─ pack/                          ← 发布内容（zip 的就是这个目录）
│  ├─ 安装汉化.cmd / 还原英文.cmd / 检查状态.cmd
│  ├─ 说明.md
│  ├─ locale/zh-CN.json           汉化数据（唯一数据源，623 条目 / 681 字符串）
│  ├─ screenshots/                实测截图
│  └─ tools/r2modman-zhcn.ps1     安装 / 还原 / 检查脚本（纯 PowerShell，无需 Node）
├─ verify/                        开发期校验工具（需要 Node.js）
│  ├─ extract-locales.mjs         从 app.asar 抽取 r2modman 自带文案作为基线
│  ├─ verify.mjs                  汉化数据结构校验
│  ├─ asar-verify.mjs             独立 asar 读取实现，交叉校验归档
│  ├─ asar-extract.js             从 asar 抽取文件
│  ├─ i18n-runtime-test.mjs       用真实 vue-i18n 验证改写后的语言包
│  ├─ run-all.ps1                 一键跑完全部校验
│  └─ capture-*.mjs / cdp-eval.mjs  通过 CDP 驱动真实界面截图与检查
├─ build-pack.ps1                 规范化编码 + 校验数据 + 生成 .cmd + 打 zip
├─ work/                          中间产物，不入库（基线、提取的 dist、测试副本、截图）
└─ dist/                          发布 zip，不入库（走 GitHub Release）
```

## 从零跑一遍校验

```powershell
git clone <this repo> ; cd r2modman-zhcn

# 指向任意一份原始的 r2modman 3.2.20 app.asar。
# 装过汉化的话，备份文件 app.asar.zhcn-backup 就是原始归档，最方便。
powershell -NoProfile -ExecutionPolicy Bypass -File verify\run-all.ps1 `
    -AsarPath "E:\Program Files\r2modman\resources\app.asar.zhcn-backup"
```

`run-all.ps1` 会在需要时自动抽取 `en-US` 基线和 `assets/`，然后在 **app.asar 的副本**上
完成安装/还原/交叉校验/运行时校验，全程不碰你的真实安装。

## 常用命令

```powershell
# 改完 pack/tools/*.ps1 或 locale/zh-CN.json 之后必须跑一次：
# 它会把这些 .ps1 重新保存为 UTF-8 with BOM
# （Windows PowerShell 5.1 对无 BOM 的 .ps1 会按 ANSI 代码页解析，中文会变乱码并导致语法错误）
powershell -NoProfile -ExecutionPolicy Bypass -File build-pack.ps1

# 全套校验（会在 app.asar 的副本上做安装/还原，不动真实安装）
powershell -NoProfile -ExecutionPolicy Bypass -File verify\run-all.ps1

# 只在副本上手动试装
powershell -NoProfile -ExecutionPolicy Bypass -File pack\tools\r2modman-zhcn.ps1 `
    -Action Install -InstallDir work\test -DryRun
```

`verify/run-all.ps1` 的 `-AsarPath` 默认指向
`E:\Program Files\r2modman\resources\app.asar.zhcn-backup`（即安装汉化后留下的原始归档）。
如果没装过汉化，把它指向原始的 `app.asar` 即可。

## 三个改写点（r2modman 3.2.20 的实际文件名）

| # | 条目 | 改写 | 说明 |
| --- | --- | --- | --- |
| 1 | `assets/instance-BX-NcIvi.js` | 末尾 `export` 前注入 `setLocaleMessage('zh', …)` / `setDateTimeFormat('zh-CN', …)` | i18n 实例在该 chunk 中创建并导出（`export{F as t}`）；注入代码复用这个导出，不依赖任何压缩后的变量名 |
| 2 | `assets/index-K8wfC3Xn.js` | `availableLocales.includes(t)?t:"en"` → `…:"zh"` | `LocaleService.set()` 的兜底值 |
| 3 | `assets/ManagerSettings-DQRXhyVO.js` | `global:{…,locale:"en"}` → `locale:"zh"` | 默认设置初始值；从未手动选过语言的用户走的就是它 |

三处都用**特征正则**而不是硬编码压缩变量名定位，并在匹配数不是 1 时明确报错退出，
避免版本变化后被静默改错。文件 1 用正则匹配末尾的 `export{X as t}` 取得局部变量名。

## 归档打包细节

`app.asar` 头部实际布局（脚本读写的依据）：

```
[0..3]   uint32 = 4                     外层 Pickle 载荷长度
[4..7]   uint32 = headerBlockSize       = 4 + payloadLength
[8..11]  uint32 = payloadLength         = 4 + jsonLen，再补齐到 4 字节对齐
[12..15] uint32 = jsonLen
[16..]   JSON 索引
[补零]
数据区从 8 + headerBlockSize 开始；条目 offset 相对数据区起点
```

每个条目记录 `size` / `offset`（字符串，十进制）/ `integrity`
（`SHA256` + 十六进制 `hash` + 4 MiB 分块 `blocks`）。重新打包时按索引顺序连续重排，
offset 全部重算，`integrity` 用新内容重算；未被改写的文件字节原样搬运。

## 校验链（都是独立实现，不共用代码）

1. `verify.mjs` — 词条树全等、占位符多重集全等、复数分支数全等、`@:` 链接词条全等、
   `searchTerms` 数组长度全等、bundle 里用到的 533 个 key 全部可解析。
2. 往返测试 — 副本上安装后哈希必须变化，还原后必须与原始**逐字节相同**且无残留。
3. `asar-verify.mjs` — 自己按 asar 格式重写的读取器：7867 个条目全部在范围内、
   每个条目的实际内容 SHA-256 与头部记录一致、相对基线只有预期的 3 个条目内容变化、
   其余 7864 个逐字节一致、数据区连续无空洞。
4. `i18n-runtime-test.mjs` — 用**真实的 vue-i18n**（从归档里抽出来的 chunk）加载改写后的
   实例 chunk，验证 `availableLocales` 含 `zh`、抽样词条命中、复数选择、`@:` 链接、
   `d(date,"long","zh-CN")` 日期格式，以及 533 个 key 的覆盖率。

另外用 CDP 驱动真实运行的应用做了端到端界面验证（切语言、截图），脚本在 `verify/capture-*.mjs`。

## 已知边界

- 只适配 3.2.20。其它版本会在能力允许时自动定位；找不到唯一匹配就报错退出而非乱改。
- 汉化包不含任何 r2modman 二进制，只改写用户本机已安装的副本。
- r2modman 自动更新会替换 `app.asar`；还原脚本会检测这种“已更新但备份是旧版”的情况并拒绝执行。
- `work/` 与 `dist/` 不入库：前者是 r2modman 自身内容（MIT, (c) ebkr）且体积数百 MB，
  后者走 GitHub Release。

## 授权

本仓库（脚本与译文）为 MIT，见 [LICENSE](LICENSE)。
r2modman 本体 Copyright (c) ebkr，MIT。
