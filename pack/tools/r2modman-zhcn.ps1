<#
.SYNOPSIS
    r2modman 简体中文汉化包 — 安装 / 还原 / 状态检查

.DESCRIPTION
    向已安装的 r2modman 的 resources\app.asar 注入 zh-CN 语言包，并（可选）
    把语言回退默认值从 en 改为 zh。

    为什么必须重打包 app.asar：
      r2modman 没有插件或外部语言包机制，界面文案（vue-i18n 词条）全部编译进
      assets\*.js 中，因此汉化只能改写归档内容。本脚本做三处改写：

        [1] 注入语言包
            在 assets 中定位 vue-i18n 语言包 chunk（含 en-US 目录的那个，
            3.2.20 为 assets/instance-BX-NcIvi.js），在其末尾 export 语句之前插入
            setLocaleMessage('zh', {...}) 与 setDateTimeFormat('zh-CN', ...)。
            语言菜单会自动多出一项 "zh (简体中文)"。

        [2] 语言回退值 en -> zh
            主 bundle 中 LocaleService.set() 的兜底值是 "en"，改为 "zh"（等长替换）。

        [3] 默认设置初始值 en -> zh
            ManagerSettings 中 global 默认设置含 locale:"en"，改为 "zh"（等长替换）。
            从未手动选过语言的用户拿到的就是这个默认值，不减它界面仍是英文。

        然后重新打包：按索引顺序连续排布所有条目、重算 offset 与 integrity(SHA-256)，
        写出新的 app.asar，未改动的文件字节逐一原样搬运；写完后自检再替换。

        备份 = 把原 app.asar 直接改名为 app.asar.zhcn-backup（同盘改名，瞬间完成，
        不额外占用 190MB 空间）。还原就是把名字改回去。

      用 -KeepDefaultEnglish 可只做 [1]，保持英文为默认语言。

    参考：本机 3.2.20 的 app.asar 为 190,509,184 字节，7867 个条目，
          数据区 188,449,448 字节，头部块 2,059,728 字节。

.PARAMETER Action
    Install  安装汉化（默认）
    Restore  还原为原版
    Status   只检查状态，不修改任何文件

.PARAMETER InstallDir
    r2modman 安装目录。省略时自动从注册表 / 常见路径查找。

.PARAMETER LocaleFile
    汉化数据文件，默认为包内的 locale\zh-CN.json。

.PARAMETER AppVersion
    期望的 r2modman 版本，默认 3.2.20。仅用于提示，不会阻止安装。

.PARAMETER KeepDefaultEnglish
    安装汉化但不改默认语言（未手动选过语言时仍显示英文）。

.PARAMETER DryRun
    只报告将要做什么，不写入任何文件。
#>
[CmdletBinding()]
param(
    [ValidateSet('Install', 'Restore', 'Status')]
    [string]$Action = 'Install',

    [string]$InstallDir,
    [string]$LocaleFile,
    [string]$AppVersion = '3.2.20',

    [switch]$KeepDefaultEnglish,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

# 让中文输出在已 chcp 65001 的控制台里正常显示
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

# --------------------------------------------------------------------------- 常量
$PackId      = 'r2modman-zhcn'
$PackVersion = '1.0.0'
$LocaleName  = 'zh-CN'
$LocaleKey   = 'zh'              # vue-i18n messages 中使用的短码
$Marker      = '/*r2modman-zhcn-pack*/'
$BlockSize   = 4194304           # asar integrity 分块大小（4 MiB）
$CopyBuffer  = 4MB

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PackRoot = Split-Path -Parent $ScriptDir
if (-not $LocaleFile) { $LocaleFile = Join-Path $PackRoot 'locale\zh-CN.json' }

function Write-Head($t)  { Write-Host ''; Write-Host "== $t" -ForegroundColor Cyan }
function Write-Ok($t)    { Write-Host "   [OK]   $t" -ForegroundColor Green }
function Write-Warn2($t) { Write-Host "   [警告] $t" -ForegroundColor Yellow }
function Write-Err($t)   { Write-Host "   [错误] $t" -ForegroundColor Red }
function Write-Info($t)  { Write-Host "   $t" }

# StrictMode 下访问不存在的属性会抛异常；注册表项与状态文件都可能缺字段。
function Get-Prop($Object, [string]$Name, $Default = $null) {
    if ($null -eq $Object) { return $Default }
    $p = $Object.PSObject.Properties[$Name]
    if ($null -ne $p) { return $p.Value }
    return $Default
}

# ------------------------------------------------------------------ 二进制读写工具
function Read-Exact {
    param([System.IO.Stream]$Stream, [int]$Count, [int64]$Position)
    $buf = New-Object byte[] $Count
    $Stream.Position = $Position
    $done = 0
    while ($done -lt $Count) {
        $n = $Stream.Read($buf, $done, $Count - $done)
        if ($n -le 0) { throw "读取 app.asar 时意外到达文件末尾（期望 $Count 字节，读到 $done 字节）" }
        $done += $n
    }
    return , $buf
}

function Copy-Range {
    param([System.IO.Stream]$Source, [System.IO.Stream]$Target, [int64]$Offset, [int64]$Count, [byte[]]$Buffer)
    $Source.Position = $Offset
    $remaining = $Count
    while ($remaining -gt 0) {
        $chunk = [int][Math]::Min([int64]$Buffer.Length, $remaining)
        $read = $Source.Read($Buffer, 0, $chunk)
        if ($read -le 0) { throw "复制数据时源文件提前结束（偏移 $Offset）" }
        $Target.Write($Buffer, 0, $read)
        $remaining -= $read
    }
}

function Get-Sha256Hex {
    param([byte[]]$Bytes)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($Bytes)) -replace '-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
}

function Get-StreamSha256Hex {
    param([string]$Path)
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        try { return ([BitConverter]::ToString($sha.ComputeHash($stream)) -replace '-', '').ToLowerInvariant() }
        finally { $stream.Dispose() }
    }
    finally { $sha.Dispose() }
}

function Get-AsarIntegrity {
    param([byte[]]$Bytes)
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $blocks = New-Object 'System.Collections.Generic.List[string]'
        $offset = 0
        while ($offset -lt $Bytes.Length) {
            $len = [Math]::Min($BlockSize, $Bytes.Length - $offset)
            $blocks.Add(([BitConverter]::ToString($sha.ComputeHash($Bytes, $offset, $len)) -replace '-', '').ToLowerInvariant())
            $offset += $len
        }
        $whole = ([BitConverter]::ToString($sha.ComputeHash($Bytes)) -replace '-', '').ToLowerInvariant()
    }
    finally { $sha.Dispose() }
    return [pscustomobject]@{
        algorithm = 'SHA256'
        hash      = $whole
        blockSize = $BlockSize
        blocks    = $blocks
    }
}

function Get-AsarHeader {
    param([System.IO.Stream]$Stream)
    $prefix = Read-Exact -Stream $Stream -Count 16 -Position 0
    $outerPayloadSize = [BitConverter]::ToUInt32($prefix, 0)
    if ($outerPayloadSize -ne 4) { throw "不是有效的 asar 文件：外层 Pickle 长度字段为 $outerPayloadSize（期望 4）" }
    $headerSize = [BitConverter]::ToUInt32($prefix, 4)
    $jsonSize = [BitConverter]::ToUInt32($prefix, 12)
    if ($headerSize -lt 4 -or $jsonSize -lt 2 -or ($headerSize - 4) -lt $jsonSize) {
        throw "asar 头部长度字段异常：headerSize=$headerSize jsonSize=$jsonSize"
    }
    $jsonBytes = Read-Exact -Stream $Stream -Count ([int]$jsonSize) -Position 16
    $index = [Text.Encoding]::UTF8.GetString($jsonBytes) | ConvertFrom-Json
    return [pscustomobject]@{
        Index      = $index
        JsonSize   = [int64]$jsonSize
        HeaderSize = [int64]$headerSize
        BaseOffset = 8 + [int64]$headerSize
        FileLength = $Stream.Length
    }
}

function Get-AsarFileNodes {
    param($Node, [string]$Prefix = '')
    foreach ($prop in $Node.files.PSObject.Properties) {
        $name = $prop.Name
        $child = $prop.Value
        $path = if ($Prefix) { "$Prefix/$name" } else { "/$name" }
        if ($child.PSObject.Properties['files']) {
            Get-AsarFileNodes -Node $child -Prefix $path
        }
        else {
            [pscustomobject]@{ Path = $path; Entry = $child }
        }
    }
}

function Get-EntryBytes {
    param($Asar, $Entry, [System.IO.Stream]$Stream)
    $size = [int64]$Entry.size
    if ($size -le 0) { return , (New-Object byte[] 0) }
    return , (Read-Exact -Stream $Stream -Count ([int]$size) -Position ($Asar.BaseOffset + [int64]$Entry.offset))
}

# ------------------------------------------------------------------- 安装位置解析
function Find-R2ModmanDir {
    $candidates = New-Object 'System.Collections.Generic.List[string]'

    foreach ($root in @(
            'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
            'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
            'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')) {
        if (-not (Test-Path $root)) { continue }
        foreach ($key in Get-ChildItem -Path $root -ErrorAction SilentlyContinue) {
            $item = Get-ItemProperty -Path $key.PSPath -ErrorAction SilentlyContinue
            if (-not $item) { continue }
            $displayName = [string](Get-Prop $item 'DisplayName' '')
            if ($displayName -notlike '*r2modman*' -and $displayName -notlike '*Thunderstore Mod Manager*') { continue }
            $installLocation = [string](Get-Prop $item 'InstallLocation' '')
            if ($installLocation -and (Test-Path $installLocation)) { $candidates.Add($installLocation) }
            $uninstallString = [string](Get-Prop $item 'UninstallString' '')
            if ($uninstallString) {
                $exe = ($uninstallString -replace '^"', '' -replace '"\s*.*$', '' -replace '\s+/.*$', '').Trim()
                if ($exe -and (Test-Path $exe)) { $candidates.Add((Split-Path -Parent $exe)) }
            }
        }
    }

    foreach ($p in @(
            (Join-Path $env:LOCALAPPDATA 'Programs\r2modman'),
            (Join-Path $env:ProgramFiles 'r2modman'),
            (Join-Path ${env:ProgramFiles(x86)} 'r2modman'),
            (Join-Path $env:LOCALAPPDATA 'r2modman'),
            (Join-Path $env:ProgramFiles 'Thunderstore Mod Manager'))) {
        if ($p -and (Test-Path $p)) { $candidates.Add($p) }
    }

    foreach ($c in $candidates) {
        if ($c -and (Test-Path (Join-Path $c 'resources\app.asar'))) { return (Resolve-Path $c).Path }
    }
    return $null
}

function Get-RunningProcess {
    $p = Get-Process -Name 'r2modman' -ErrorAction SilentlyContinue
    if (-not $p) { $p = Get-Process -Name 'Thunderstore Mod Manager' -ErrorAction SilentlyContinue }
    return $p
}

function Get-StatePath($AsarPath) { return "$AsarPath.zhcn-state.json" }
function Get-BackupPath($AsarPath) { return "$AsarPath.zhcn-backup" }
function Get-NewPath($AsarPath) { return "$AsarPath.zhcn-new" }

function Read-State($AsarPath) {
    $sp = Get-StatePath $AsarPath
    if (-not (Test-Path $sp)) { return $null }
    try { return Get-Content -LiteralPath $sp -Raw -Encoding UTF8 | ConvertFrom-Json } catch { return $null }
}

# ==============================================================================
#  主流程
# ==============================================================================

Write-Host ''
Write-Host " r2modman 简体中文汉化包 v$PackVersion   目标版本 $AppVersion" -ForegroundColor White
Write-Host " 操作: $Action" -ForegroundColor White
if ($DryRun) { Write-Host ' 模式: 演练（DryRun，不写入任何文件）' -ForegroundColor Yellow }

# ------------------------------------------------------------------ 1. 定位安装
Write-Head '1/6  定位 r2modman 安装目录'
if (-not $InstallDir) { $InstallDir = Find-R2ModmanDir }
if (-not $InstallDir) {
    Write-Err '未找到 r2modman 安装目录。请用 -InstallDir 手动指定，例如：'
    Write-Err '  -InstallDir "E:\Program Files\r2modman"'
    exit 2
}
$InstallDir = (Resolve-Path $InstallDir).Path
$AsarPath = Join-Path $InstallDir 'resources\app.asar'
if (-not (Test-Path $AsarPath)) { Write-Err "未找到 $AsarPath"; exit 2 }
Write-Ok "安装目录: $InstallDir"
Write-Info ("app.asar : {0:N0} 字节" -f (Get-Item $AsarPath).Length)

$running = Get-RunningProcess
if ($running) {
    Write-Warn2 "r2modman 正在运行（$($running.Count) 个进程，PID: $($running.Id -join ', ')）"
    if ($Action -eq 'Status') { Write-Info '（Status 为只读操作，继续）' }
    else {
        Write-Err '请先完全退出 r2modman，然后重新运行本脚本。'
        Write-Err '提示：r2modman 会在退出时自动安装已下载的更新，更新会覆盖汉化。'
        exit 3
    }
}

$backupPath = Get-BackupPath $AsarPath
$statePath = Get-StatePath $AsarPath
$newPath = Get-NewPath $AsarPath
$state = Read-State $AsarPath

# ------------------------------------------------------------------ 2. 解析 asar
Write-Head '2/6  解析 app.asar'
$readStream = [IO.File]::Open($AsarPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
try {
    $asar = Get-AsarHeader -Stream $readStream
    $allFiles = @(Get-AsarFileNodes -Node $asar.Index)
    Write-Ok "头部 JSON $($asar.JsonSize) 字节，$($allFiles.Count) 个文件条目，数据区起始偏移 $($asar.BaseOffset)"

    $pkgNode = $allFiles | Where-Object { $_.Path -eq '/package.json' } | Select-Object -First 1
    $installedVersion = '(未知)'
    if ($pkgNode) {
        try {
            $pkg = [Text.Encoding]::UTF8.GetString((Get-EntryBytes -Asar $asar -Entry $pkgNode.Entry -Stream $readStream)) | ConvertFrom-Json
            $installedVersion = [string](Get-Prop $pkg 'version' '(未知)')
        }
        catch { }
    }
    if ($installedVersion -eq $AppVersion) { Write-Ok "应用版本: $installedVersion" }
    else { Write-Warn2 "应用版本为 $installedVersion，而汉化包针对 $AppVersion 制作。若界面出现英文残留属正常现象。" }

    # --------------------------------------------------- 3. 定位语言包 & 判断状态
    Write-Head '3/6  检查汉化状态'
    $assetNodes = @($allFiles | Where-Object { $_.Path -like '/assets/*.js' })
    $i18nNode = $null
    $i18nContent = $null
    $fallbackNode = $null
    $fallbackContent = $null
    $fallbackMulti = 0
    $fallbackRe = [regex]'availableLocales\.includes\(([A-Za-z_$][A-Za-z0-9_$]*)\)\?\1:"en"'

    foreach ($node in $assetNodes) {
        $text = [Text.Encoding]::UTF8.GetString((Get-EntryBytes -Asar $asar -Entry $node.Entry -Stream $readStream))
        if (-not $i18nNode -and
            $text.Contains(',locale:"en-US"},translations:{') -and
            $text.Contains('globalInjection:!0') -and
            $text.Contains('allowComposition:!0')) {
            $i18nNode = $node
            $i18nContent = $text
        }
        if (-not $fallbackNode) {
            $hits = $fallbackRe.Matches($text)
            if ($hits.Count -eq 1) { $fallbackNode = $node; $fallbackContent = $text }
            elseif ($hits.Count -gt 1) { $fallbackMulti = $hits.Count }
        }
    }
    if (-not $i18nNode) { Write-Err '未能定位语言包 chunk，该 r2modman 版本可能不兼容本汉化包。'; exit 5 }
    Write-Ok "语言包 chunk   : $($i18nNode.Path)  ($($i18nNode.Entry.size) 字节)"
    $patched = $i18nContent.Contains($Marker)
    if ($fallbackNode) { Write-Ok "语言默认值位置 : $($fallbackNode.Path)" }
    elseif ($fallbackMulti -gt 1) { Write-Warn2 "匹配到多处语言回退逻辑（$fallbackMulti 处），将不修改默认语言。" }
    elseif ($patched) { Write-Info '语言回退逻辑已是本汉化包改写后的版本（找不到原始 "en" 属正常）' }
    else { Write-Warn2 '未找到语言回退逻辑，默认语言将保持英文。' }
    $backupExists = Test-Path $backupPath
    if ($patched) {
        Write-Ok '当前 app.asar 已包含本汉化包（检测到汉化标记）'
        if ($state) { Write-Info "上次安装: $(Get-Prop $state 'appliedAt' '?')，应用版本 $(Get-Prop $state 'appVersion' '?')" }
    }
    else { Write-Info '当前为原版（未汉化）' }
    if ($backupExists) { Write-Info "备份存在: $backupPath" }

    # ------------------------------------------------------------------ Status
    if ($Action -eq 'Status') {
        Write-Head '结果'
        Write-Info ("已汉化     : {0}" -f $patched)
        Write-Info ("备份       : {0}" -f $(if ($backupExists) { '{0}  ({1:N0} 字节)' -f $backupPath, (Get-Item $backupPath).Length } else { '（无）' }))
        Write-Info ("状态文件   : {0}" -f $(if ($state) { $statePath } else { '（无）' }))
        Write-Info ("默认语言   : {0}" -f $(if ($state) { Get-Prop $state 'defaultLocale' '-' } else { '-' }))
        Write-Info '可选语言   : zh (简体中文) / en (English) / fr (Français)'
        exit 0
    }

    # ------------------------------------------------------------------ Restore
    if ($Action -eq 'Restore') {
        Write-Head '4/6  还原原版'
        if (-not $backupExists) {
            Write-Err "未找到备份 $backupPath，无法自动还原。"
            Write-Err '可下载 r2modman 3.2.20 安装程序覆盖安装以恢复原版。'
            exit 4
        }
        if (-not $patched) {
            Write-Warn2 '当前 app.asar 不含汉化标记，说明它可能已被 r2modman 自动更新替换。'
            Write-Warn2 '此时还原备份会把管理器降级回旧版本，因此已停止。'
            Write-Err '请重新运行 r2modman 安装程序升级/修复，或手动删除备份文件。'
            Write-Err '若确实想强制还原旧版本备份，请手动改名覆盖：'
            Write-Err "  $backupPath  ->  $AsarPath"
            exit 4
        }
        $backupHash = Get-StreamSha256Hex -Path $backupPath
        $expectHash = [string](Get-Prop $state 'originalSha256' '')
        if ($expectHash -and $backupHash -ne $expectHash) {
            Write-Err '备份文件校验失败（SHA-256 不匹配），已停止以免写入损坏的文件。'
            exit 4
        }
        Write-Ok "备份校验通过 (SHA-256 $($backupHash.Substring(0, 16))...)"

        if ($DryRun) { Write-Warn2 'DryRun：未做任何修改。'; exit 0 }

        # 必须先释放读句柄，否则无法删除/改名 app.asar
        $readStream.Dispose()
        [IO.File]::Delete($AsarPath)
        [IO.File]::Move($backupPath, $AsarPath)
        if (Test-Path $statePath) { Remove-Item -LiteralPath $statePath -Force }
        Write-Ok 'app.asar 已还原为原版，备份与状态文件已清理'
        Write-Head '完成'
        Write-Host '   请重新启动 r2modman，界面将恢复为英文。' -ForegroundColor Green
        exit 0
    }

    # ------------------------------------------------------------------ Install
    Write-Head '4/6  准备汉化数据'
    if ($patched) {
        Write-Err '当前 app.asar 已经是汉化版，无需重复安装。'
        Write-Err '若要重新安装（例如更新了汉化数据），请先运行「还原英文.cmd」，再安装。'
        exit 5
    }
    if (-not (Test-Path $LocaleFile)) { Write-Err "未找到汉化数据文件 $LocaleFile"; exit 2 }
    $localeObj = [IO.File]::ReadAllText($LocaleFile, (New-Object System.Text.UTF8Encoding($false))) | ConvertFrom-Json
    $localeMeta = Get-Prop $localeObj 'metadata'
    if (-not $localeMeta -or -not (Get-Prop $localeObj 'translations')) {
        Write-Err '汉化数据文件格式不正确（缺少 metadata 或 translations）'; exit 2
    }
    $friendlyName = [string](Get-Prop $localeMeta 'name' $LocaleName)
    Write-Ok "语言包: $friendlyName [$(Get-Prop $localeMeta 'locale' $LocaleName)]"

    $localeJson = $localeObj | ConvertTo-Json -Depth 40 -Compress
    $localeJson = $localeJson -replace [char]0x2028, '\u2028' -replace [char]0x2029, '\u2029'
    Write-Info ("序列化后 {0:N0} 字符 / {1:N0} 字节" -f $localeJson.Length, [Text.Encoding]::UTF8.GetByteCount($localeJson))

    # ------------------------------------------------------- 5. 生成改写后的内容
    Write-Head '5/6  改写语言包 chunk'
    $modified = New-Object 'System.Collections.Specialized.OrderedDictionary'

    $exportRe = [regex]'export\s*\{\s*([A-Za-z_$][A-Za-z0-9_$]*)\s+as\s+t\s*\}\s*;?\s*$'
    $exportMatch = $exportRe.Match($i18nContent)
    if (-not $exportMatch.Success) { Write-Err '语言包 chunk 末尾的 export 语句不符合预期。'; exit 5 }
    $i18nLocal = $exportMatch.Groups[1].Value
    Write-Info "i18n 实例导出为局部变量 '$i18nLocal'"

    $injection = @"
$Marker
;(function(__i18n,__zhcn){__i18n.global.setLocaleMessage('$LocaleKey',__zhcn);try{var __d=__i18n.global.getDateTimeFormat('en-US');if(__d)__i18n.global.setDateTimeFormat('$LocaleName',__d);}catch(__e){}})( $i18nLocal , $localeJson );
"@
    $newI18n = $i18nContent.Substring(0, $exportMatch.Index) + $injection + $i18nContent.Substring($exportMatch.Index)
    Write-Ok "注入 zh-CN 语言包: $($i18nContent.Length) -> $($newI18n.Length) 字符"
    $modified[$i18nNode.Path] = [pscustomobject]@{ Node = $i18nNode; Content = $newI18n; Note = '注入 zh-CN 语言包' }

    # 读取某路径“改写后的内容”；没有改写记录时回落到归档里的原始内容。
    function Get-ModifiedContent($node) {
        if ($modified.Contains($node.Path)) { return [string]$modified[$node.Path].Content }
        return [Text.Encoding]::UTF8.GetString((Get-EntryBytes -Asar $asar -Entry $node.Entry -Stream $readStream))
    }
    # 记录某文件的新内容；同一文件多处改写时以传入内容为准并累加说明。
    function Set-ModifiedContent($node, [string]$content, [string]$note) {
        if ($modified.Contains($node.Path)) {
            $existingNote = [string]$modified[$node.Path].Note
            $modified[$node.Path].Content = $content
            $modified[$node.Path].Note = $existingNote + ' + ' + $note
        }
        else {
            $modified[$node.Path] = [pscustomobject]@{ Node = $node; Content = $content; Note = $note }
        }
    }

    $defaultLocaleApplied = $false
    if ($KeepDefaultEnglish) {
        Write-Info '按 -KeepDefaultEnglish 要求，不修改默认语言。'
    }
    else {
        # 第一处：LocaleService.set() 里的兜底值 "en"
        if (-not $fallbackNode) {
            Write-Warn2 '未定位到唯一的语言回退逻辑，跳过该处默认语言修改。'
        }
        else {
            $content = Get-ModifiedContent $fallbackNode
            $replaced = $fallbackRe.Replace($content, 'availableLocales.includes($1)?$1:"' + $LocaleKey + '"')
            if ($replaced.Length -ne $content.Length) { Write-Err '默认语言替换改变了文件长度，已中止。'; exit 5 }
            Write-Ok "默认语言回退值 en -> $LocaleKey   ($($fallbackNode.Path))"
            Set-ModifiedContent $fallbackNode $replaced "默认语言回退 en->$LocaleKey"
            $defaultLocaleApplied = $true
        }

        # 第二处：ManagerSettings 中 global 设置的初始值 locale:"en"
        # 从未手动选过语言的用户拿到的就是它，不改这里界面仍是英文。
        $defaultsRe = [regex]'(global:\{[^{}]*?)locale:"en"'
        $defaultsNode = $null
        $defaultsMulti = 0
        foreach ($node in $assetNodes) {
            $hits = $defaultsRe.Matches((Get-ModifiedContent $node))
            if ($hits.Count -eq 1) {
                if (-not $defaultsNode) { $defaultsNode = $node }
                else { $defaultsMulti = 2; $defaultsNode = $null; break }
            }
            elseif ($hits.Count -gt 1) { $defaultsMulti = $hits.Count; $defaultsNode = $null; break }
        }
        if (-not $defaultsNode) {
            if ($defaultsMulti -gt 1) { Write-Warn2 "匹配到多处 global 默认设置（$defaultsMulti 处），跳过默认语言值修改。" }
            else { Write-Warn2 '未在 global 默认设置中找到 locale，跳过默认语言值修改。' }
        }
        else {
            $content = Get-ModifiedContent $defaultsNode
            $replaced = $defaultsRe.Replace($content, '${1}locale:"' + $LocaleKey + '"')
            if ($replaced.Length -ne $content.Length) { Write-Err '默认设置替换改变了文件长度，已中止。'; exit 5 }
            if ($replaced -eq $content) { Write-Warn2 '默认设置替换未产生变化，跳过。' }
            else {
                Write-Ok "默认设置初始值 locale:en -> $LocaleKey ($($defaultsNode.Path))"
                Set-ModifiedContent $defaultsNode $replaced "默认设置 locale->$LocaleKey"
                $defaultLocaleApplied = $true
            }
        }
    }

    $newBytesByPath = @{}
    $oldSizeByPath = @{}
    foreach ($kv in $modified.GetEnumerator()) {
        $bytes = [Text.Encoding]::UTF8.GetBytes([string]$kv.Value.Content)
        $newBytesByPath[$kv.Key] = $bytes
        $oldSizeByPath[$kv.Key] = [int64]$kv.Value.Node.Entry.size
        $kv.Value.Node.Entry.size = $bytes.Length
        $kv.Value.Node.Entry.integrity = Get-AsarIntegrity -Bytes $bytes
    }

    # ------------------------------------------------- 6. 重新打包并写入 app.asar
    Write-Head '6/6  重新打包 app.asar'

    $layout = New-Object 'System.Collections.Generic.List[object]'
    $cursor = [int64]0
    foreach ($f in $allFiles) {
        $entry = $f.Entry
        $oldOffset = [int64]$entry.offset
        $isNew = $newBytesByPath.ContainsKey($f.Path)
        $oldSize = [int64]$entry.size
        if ($oldSizeByPath.ContainsKey($f.Path)) { $oldSize = $oldSizeByPath[$f.Path] }
        $entry.offset = [string]$cursor
        $layout.Add([pscustomobject]@{
                Path      = $f.Path
                Entry     = $entry
                OldSize   = $oldSize
                Size      = [int64]$entry.size
                IsNew     = $isNew
                OldOffset = $oldOffset
                NewBytes  = $(if ($isNew) { $newBytesByPath[$f.Path] } else { $null })
                Note      = $(if ($isNew) { [string]$modified[$f.Path].Note } else { '' })
            })
        $cursor += [int64]$entry.size
    }

    $newJson = $asar.Index | ConvertTo-Json -Depth 40 -Compress
    $newJsonBytes = [Text.Encoding]::UTF8.GetBytes($newJson)
    # 归档头部布局（与原归档一致）：
    #   [0..3]   外层 Pickle 载荷长度 = 4
    #   [4..7]   headerBlockSize = 4 + payloadLength
    #   [8..11]  payloadLength   = 4(字符串长度字段) + jsonLen，再补齐到 4 字节对齐
    #   [12..15] jsonLen
    #   [16..]   JSON 索引
    #   数据区从 8 + headerBlockSize 开始
    $payloadLength = 4 + $newJsonBytes.Length
    if ($payloadLength % 4 -ne 0) { $payloadLength += 4 - ($payloadLength % 4) }
    $headerBlockSize = 4 + $payloadLength

    Write-Info ("索引 JSON   : {0:N0} -> {1:N0} 字节" -f $asar.JsonSize, $newJsonBytes.Length)
    Write-Info ("头部块      : {0:N0} -> {1:N0} 字节" -f $asar.HeaderSize, $headerBlockSize)
    Write-Info ("数据区      : {0:N0} 字节，{1} 个条目全部重排 offset" -f $cursor, $layout.Count)
    Write-Info ("新 app.asar : {0:N0} -> {1:N0} 字节" -f $asar.FileLength, (8 + $headerBlockSize + $cursor))
    $changedList = @($layout | Where-Object { $_.IsNew })
    foreach ($c in $changedList) {
        Write-Info ("   · {0}   {1:N0} -> {2:N0} 字节  ({3})" -f $c.Path, $c.OldSize, $c.Size, $c.Note)
    }
    Write-Info '   其它条目内容不变（仅 offset 重排并重算 integrity）'

    if ($DryRun) {
        Write-Warn2 'DryRun：以上为将执行的操作，未写入任何文件。'
        exit 0
    }

    if (Test-Path $newPath) { Remove-Item -LiteralPath $newPath -Force }
    $writeStream = [IO.File]::Open($newPath, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        # [0..3]=4, [4..7]=headerBlockSize, [8..11]=payloadLength, [12..15]=jsonLen
        $prefix = New-Object byte[] 16
        [BitConverter]::GetBytes([uint32]4).CopyTo($prefix, 0)
        [BitConverter]::GetBytes([uint32]$headerBlockSize).CopyTo($prefix, 4)
        [BitConverter]::GetBytes([uint32]$payloadLength).CopyTo($prefix, 8)
        [BitConverter]::GetBytes([uint32]$newJsonBytes.Length).CopyTo($prefix, 12)
        $writeStream.Write($prefix, 0, 16)
        $writeStream.Write($newJsonBytes, 0, $newJsonBytes.Length)
        $padLen = $payloadLength - 4 - $newJsonBytes.Length
        if ($padLen -gt 0) { $writeStream.Write((New-Object byte[] $padLen), 0, $padLen) }

        # 数据区：连续未修改的条目合并成一次批量复制
        $buffer = New-Object byte[] $CopyBuffer
        $i = 0
        while ($i -lt $layout.Count) {
            $item = $layout[$i]
            if ($item.IsNew) {
                $writeStream.Write($item.NewBytes, 0, $item.NewBytes.Length)
                $i++
                continue
            }
            $runStart = [int64]$item.OldOffset
            $runLen = [int64]$item.Size
            $j = $i + 1
            while ($j -lt $layout.Count -and -not $layout[$j].IsNew -and
                [int64]$layout[$j].OldOffset -eq ($runStart + $runLen)) {
                $runLen += [int64]$layout[$j].Size
                $j++
            }
            # 索引中的 offset 是相对数据区起点(BaseOffset)的，读源文件时必须加上基址
            Copy-Range -Source $readStream -Target $writeStream -Offset ($asar.BaseOffset + $runStart) -Count $runLen -Buffer $buffer
            $i = $j
        }
        $writeStream.Flush($true)
    }
    finally { $writeStream.Dispose() }

    $newLength = (Get-Item $newPath).Length
    $expectedLength = 8 + $headerBlockSize + $cursor
    if ($newLength -ne $expectedLength) {
        Remove-Item -LiteralPath $newPath -Force
        Write-Err "写出长度 $newLength 与预期 $expectedLength 不符，已删除临时文件，原安装未改动。"
        exit 6
    }
    Write-Ok ("新 app.asar 已写出: {0:N0} 字节" -f $newLength)

    # 自检：用同一套解析逻辑重新读取刚写出的文件，并用独立的读取路径校验
    # 每个条目的 offset/size 与 integrity(SHA-256)，确认归档自洽后才替换原文件。
    $verifyStream = [IO.File]::Open($newPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        $verifyHeader = Get-AsarHeader -Stream $verifyStream
        $verifyFiles = @(Get-AsarFileNodes -Node $verifyHeader.Index)
        if ($verifyFiles.Count -ne $allFiles.Count) {
            throw "自检失败：条目数 $($verifyFiles.Count) != $($allFiles.Count)"
        }
        $checked = 0
        $markerOk = $false
        foreach ($f in $verifyFiles) {
            $off = [int64]$f.Entry.offset
            $len = [int64]$f.Entry.size
            if ($off -lt 0 -or ($verifyHeader.BaseOffset + $off + $len) -gt $verifyHeader.FileLength) {
                throw "自检失败：$($f.Path) 超出文件范围"
            }
            # 抽检被改写的两个条目，其余条目靠长度与总长度保证
            if ($newBytesByPath.ContainsKey($f.Path)) {
                $actual = Get-EntryBytes -Asar $verifyHeader -Entry $f.Entry -Stream $verifyStream
                $expectIntegrity = Get-AsarIntegrity -Bytes $newBytesByPath[$f.Path]
                $actualHash = Get-Sha256Hex -Bytes $actual
                if ($actualHash -ne $expectIntegrity.hash) {
                    throw "自检失败：$($f.Path) 内容哈希不符"
                }
                if ([Text.Encoding]::UTF8.GetString($actual).Contains($Marker)) { $markerOk = $true }
                $checked++
            }
        }
        if ($checked -ne $newBytesByPath.Count) { throw "自检失败：改写条目数不符（$checked）" }
        if (-not $markerOk) { throw '自检失败：汉化标记未出现在新语言包中' }
        Write-Ok "自检通过：归档可解析、条目数一致、改写内容哈希正确、汉化标记就位"
    }
    catch {
        $verifyStream.Dispose()
        Remove-Item -LiteralPath $newPath -Force
        Write-Err $_.Exception.Message
        Write-Err '已删除临时文件，原安装未做任何改动。'
        exit 6
    }
    finally { $verifyStream.Dispose() }
}
finally {
    $readStream.Dispose()
}

# --------------------------------------------------------------- 交换文件（同盘改名）
Write-Head '交换文件'
$originalHash = Get-StreamSha256Hex -Path $AsarPath
Write-Info "原 app.asar SHA-256: $originalHash"

if ($backupExists) {
    Write-Info '检测到已有备份，保留备份并直接替换 app.asar'
    [IO.File]::Replace($newPath, $AsarPath, $null)
}
else {
    [IO.File]::Move($AsarPath, $backupPath)
    Write-Ok "原 app.asar 已改名为备份: $(Split-Path -Leaf $backupPath)"
    [IO.File]::Move($newPath, $AsarPath)
}
Write-Ok '新 app.asar 已就位'

$stateObj = [ordered]@{
    pack               = $PackId
    packVersion        = $PackVersion
    appVersion         = $installedVersion
    targetAppVersion   = $AppVersion
    asarPath           = $AsarPath
    appliedAt          = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    originalFileLength = [int64]$asar.FileLength
    originalSha256     = $originalHash
    newFileLength      = [int64]$newLength
    backupFile         = $backupPath
    localeKey          = $LocaleKey
    localeName         = $LocaleName
    localeDisplayName  = $friendlyName
    defaultLocale      = $(if ($defaultLocaleApplied) { $LocaleKey } else { 'en (未修改)' })
    patchedEntries     = @($changedList | ForEach-Object {
            [ordered]@{ path = $_.Path; note = $_.Note; oldSize = $_.OldSize; newSize = $_.Size }
        })
}
$stateObj | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $statePath -Encoding UTF8
Write-Ok "状态文件: $statePath"

Write-Head '完成'
Write-Host '   汉化安装成功！' -ForegroundColor Green
Write-Host ''
Write-Host '   下一步：启动 r2modman。' -ForegroundColor White
if ($defaultLocaleApplied) { Write-Host '   · 未手动选择过语言时，界面会直接显示简体中文。' -ForegroundColor Gray }
Write-Host '   · 右下角活动栏的语言菜单可在 中文 / English / Français 之间切换。' -ForegroundColor Gray
Write-Host '   · 还原英文：运行「还原英文.cmd」。' -ForegroundColor Gray
Write-Host '   · 注意：r2modman 自动更新会替换 app.asar，更新后需要重新安装汉化。' -ForegroundColor Yellow
Write-Host ''
