<#
    一键跑完整套校验（开发/回归用，需要 Node.js）。

      1. 汉化数据结构校验   verify\verify.mjs      —— 词条树、占位符、复数、链接词条、覆盖率
      2. 打包器单元测试     —— 在 app.asar 的副本上安装 / 还原，全过程不碰真实安装
      3. 归档交叉校验       verify\asar-verify.mjs —— 独立实现（Node）逐条比对 SHA-256
      4. 语言包运行时校验   verify\i18n-runtime-test.mjs
                            —— 用真实 vue-i18n 加载改写后的 chunk，验证注册/插值/复数/链接/日期

    用法：powershell -NoProfile -ExecutionPolicy Bypass -File verify\run-all.ps1
          可选 -AsarPath "<r2modman>\resources\app.asar" 指向其它原始归档
#>
[CmdletBinding()]
param(
    [string]$AsarPath = 'E:\Program Files\r2modman\resources\app.asar.zhcn-backup',
    [string]$WorkDir
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
if (-not $WorkDir) { $WorkDir = Join-Path $Root 'work\selftest' }
$PackScript = Join-Path $Root 'pack\tools\r2modman-zhcn.ps1'
$results = New-Object 'System.Collections.Generic.List[object]'

function Step([string]$name, [scriptblock]$body) {
    Write-Host ''
    Write-Host "==================== $name" -ForegroundColor Cyan
    $sw = [Diagnostics.Stopwatch]::StartNew()
    try {
        & $body
        $ok = ($LASTEXITCODE -eq 0 -or $null -eq $LASTEXITCODE)
        if (-not $ok) { throw "退出码 $LASTEXITCODE" }
        $results.Add([pscustomobject]@{ Name = $name; Ok = $true; Ms = $sw.ElapsedMilliseconds; Err = '' })
        Write-Host "---- PASS ($($sw.ElapsedMilliseconds) ms)" -ForegroundColor Green
    }
    catch {
        $results.Add([pscustomobject]@{ Name = $name; Ok = $false; Ms = $sw.ElapsedMilliseconds; Err = $_.Exception.Message })
        Write-Host "---- FAIL: $($_.Exception.Message)" -ForegroundColor Red
    }
}

# 0 ---------------------------------------------------------------------------
# r2modman 自带的 en-US / fr-FR 文案不随仓库发布，缺了就从 app.asar 现抽。
Step '0/4  准备基线（从 app.asar 抽取 r2modman 自带文案）' {
    if (-not (Test-Path $AsarPath)) { throw "找不到原始 app.asar：$AsarPath" }
    if (Test-Path (Join-Path $Root 'work\en.json')) { Write-Host '   work\en.json 已存在，跳过' }
    else {
        & node (Join-Path $Root 'verify\extract-locales.mjs') $AsarPath (Join-Path $Root 'work')
        if ($LASTEXITCODE -ne 0) { throw 'extract-locales.mjs 失败' }
    }
    if (Test-Path (Join-Path $Root 'work\dist\assets')) { Write-Host '   work\dist\assets 已存在，跳过' }
    else {
        & node (Join-Path $Root 'verify\asar-extract.js') $AsarPath (Join-Path $Root 'work\dist') '^/assets/'
        if ($LASTEXITCODE -ne 0) { throw 'asar-extract.js 失败' }
    }
}

# 1 ---------------------------------------------------------------------------
Step '1/4  汉化数据结构校验' {
    & node (Join-Path $Root 'verify\verify.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'verify.mjs 失败' }
}

# 2 ---------------------------------------------------------------------------
Step '2/4  打包器 安装/还原 往返测试（副本）' {
    if (-not (Test-Path $AsarPath)) { throw "找不到原始 app.asar：$AsarPath" }
    if (Test-Path $WorkDir) { Remove-Item $WorkDir -Recurse -Force }
    New-Item -ItemType Directory -Force -Path (Join-Path $WorkDir 'resources') | Out-Null
    Copy-Item $AsarPath (Join-Path $WorkDir 'resources\app.asar') -Force
    $before = (Get-FileHash (Join-Path $WorkDir 'resources\app.asar') -Algorithm SHA256).Hash

    & powershell -NoProfile -ExecutionPolicy Bypass -File $PackScript -Action Install -InstallDir $WorkDir
    if ($LASTEXITCODE -ne 0) { throw "安装失败（退出码 $LASTEXITCODE）" }

    $patched = (Get-FileHash (Join-Path $WorkDir 'resources\app.asar') -Algorithm SHA256).Hash
    if ($patched -eq $before) { throw '安装后 app.asar 未变化' }
    Write-Host "   安装后 SHA-256: $patched"

    & powershell -NoProfile -ExecutionPolicy Bypass -File $PackScript -Action Restore -InstallDir $WorkDir
    if ($LASTEXITCODE -ne 0) { throw "还原失败（退出码 $LASTEXITCODE）" }

    $after = (Get-FileHash (Join-Path $WorkDir 'resources\app.asar' -ErrorAction SilentlyContinue) -Algorithm SHA256).Hash
    if ($after -ne $before) { throw "还原后与原始不一致（$after != $before）" }
    $left = @(Get-ChildItem (Join-Path $WorkDir 'resources') | Where-Object { $_.Name -ne 'app.asar' })
    if ($left.Count -gt 0) { throw "还原后残留文件: $($left.Name -join ', ')" }
    Write-Host '   还原后与原始逐字节一致，无残留文件'
}

# 3 ---------------------------------------------------------------------------
Step '3/4  归档交叉校验（独立 Node 实现）' {
    # 重新打一次补丁用于校验
    & powershell -NoProfile -ExecutionPolicy Bypass -File $PackScript -Action Install -InstallDir $WorkDir | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "安装失败（退出码 $LASTEXITCODE）" }
    & node (Join-Path $Root 'verify\asar-verify.mjs') (Join-Path $WorkDir 'resources\app.asar') $AsarPath
    if ($LASTEXITCODE -ne 0) { throw 'asar-verify.mjs 失败' }
}

# 4 ---------------------------------------------------------------------------
Step '4/4  语言包运行时校验（真实 vue-i18n）' {
    $rt = Join-Path $WorkDir 'rt'
    if (Test-Path $rt) { Remove-Item $rt -Recurse -Force }
    & node (Join-Path $Root 'verify\asar-extract.js') (Join-Path $WorkDir 'resources\app.asar') $rt '^/assets/'
    if ($LASTEXITCODE -ne 0) { throw 'asar-extract.js 失败' }
    & node (Join-Path $Root 'verify\i18n-runtime-test.mjs') (Join-Path $rt 'assets')
    if ($LASTEXITCODE -ne 0) { throw 'i18n-runtime-test.mjs 失败' }
}

Write-Host ''
Write-Host '========================= 汇总' -ForegroundColor Cyan
$results | Format-Table @{n='步骤';e={$_.Name}}, @{n='结果';e={ if ($_.Ok) { 'PASS' } else { 'FAIL' } }}, @{n='耗时ms';e={$_.Ms}} -AutoSize
$failed = @($results | Where-Object { -not $_.Ok })
if ($failed.Count) {
    Write-Host "失败 $($failed.Count) 项：" -ForegroundColor Red
    foreach ($f in $failed) { Write-Host "  - $($f.Name): $($f.Err)" -ForegroundColor Red }
    exit 1
}
Write-Host '全部通过。' -ForegroundColor Green
exit 0
