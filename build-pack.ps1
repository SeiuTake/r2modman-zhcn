<#
    Build the r2modman Chinese localization pack (release folder + zip).

    NOTE: this file is intentionally ASCII-only. Windows PowerShell 5.1 decodes .ps1
    files without a BOM using the system ANSI code page, so any non-ASCII source here
    would be mis-parsed before the script can even run. It is the job of this script
    to add the UTF-8 BOM to the user-facing pack scripts, which do contain Chinese.

    Steps:
      1. Re-save pack\tools\*.ps1 as UTF-8 *with* BOM.
      2. Validate pack\locale\zh-CN.json parses and count its strings.
      3. Generate ASCII-safe .cmd launchers (they run `chcp 65001` first so the
         Chinese console output from the .ps1 is not mojibake).
      4. Zip the pack folder into dist\.
#>
[CmdletBinding()]
param(
    [string]$PackVersion = '1.0.0',
    [string]$TargetAppVersion = '3.2.20',
    [switch]$SkipZip
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Pack = Join-Path $Root 'pack'
$Dist = Join-Path $Root 'dist'
$Utf8Bom = New-Object System.Text.UTF8Encoding($true)
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

Write-Host '== 1/4  Normalize .ps1 encoding (UTF-8 with BOM)' -ForegroundColor Cyan
# Both the shipped scripts and the dev-side verify script contain Chinese, so both need
# the BOM; editors that drop it would otherwise break them under Windows PowerShell 5.1.
$ps1Files = @(
    Get-ChildItem -Path (Join-Path $Pack 'tools') -Filter '*.ps1' -Recurse -ErrorAction SilentlyContinue
    Get-ChildItem -Path (Join-Path $Root 'verify') -Filter '*.ps1' -Recurse -ErrorAction SilentlyContinue
)
foreach ($f in $ps1Files) {
    $bytes = [IO.File]::ReadAllBytes($f.FullName)
    $text = $Utf8NoBom.GetString($bytes)
    if ($text.Length -gt 0 -and $text[0] -eq [char]0xFEFF) { $text = $text.Substring(1) }
    [IO.File]::WriteAllText($f.FullName, $text, $Utf8Bom)
    Write-Host ("   {0}  ({1} bytes -> UTF-8 BOM)" -f $f.Name, $bytes.Length)
}

Write-Host '== 2/4  Validate localization data' -ForegroundColor Cyan
$localePath = Join-Path $Pack 'locale\zh-CN.json'
if (-not (Test-Path $localePath)) { throw "missing $localePath" }
$locale = [IO.File]::ReadAllText($localePath, $Utf8NoBom) | ConvertFrom-Json

function Count-Leaf($o) {
    $n = 0
    foreach ($p in $o.PSObject.Properties) {
        if ($p.Value -is [System.Management.Automation.PSCustomObject]) { $n += (Count-Leaf $p.Value) }
        elseif ($p.Value -is [object[]]) { $n += $p.Value.Count }
        else { $n++ }
    }
    return $n
}
$leaf = Count-Leaf $locale.translations
$metaName = $locale.metadata.name
$metaLocale = $locale.metadata.locale
Write-Host ("   {0} [{1}] - {2} strings" -f $metaName, $metaLocale, $leaf)

Write-Host '== 3/4  Generate .cmd launchers' -ForegroundColor Cyan
$tmpl = @'
@echo off
chcp 65001 >nul
setlocal
set "HERE=%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%HERE%tools\r2modman-zhcn.ps1" -Action __ACTION__ __EXTRA__ %*
echo.
pause
'@
$install = $tmpl.Replace('__ACTION__', 'Install').Replace('__EXTRA__', "-AppVersion `"$TargetAppVersion`"")
$restore = $tmpl.Replace('__ACTION__', 'Restore').Replace('__EXTRA__', '')
$status = $tmpl.Replace('__ACTION__', 'Status').Replace('__EXTRA__', '')

# Launcher file names carry Chinese so the user sees them at a glance; the console
# code page is switched to UTF-8 above before PowerShell prints anything.
$names = @{ "$([char]0x5B89)$([char]0x88C5)$([char]0x6C49)$([char]0x5316).cmd" = $install
            "$([char]0x8FD8)$([char]0x539F)$([char]0x82F1)$([char]0x6587).cmd" = $restore
            "$([char]0x68C0)$([char]0x67E5)$([char]0x72B6)$([char]0x6001).cmd" = $status }
foreach ($k in $names.Keys) {
    [IO.File]::WriteAllText((Join-Path $Pack $k), $names[$k], $Utf8NoBom)
    Write-Host "   $k"
}

if ($SkipZip) { Write-Host '== 4/4  Zip skipped (-SkipZip)' -ForegroundColor Cyan; return }

Write-Host '== 4/4  Package' -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $Dist | Out-Null
$zip = Join-Path $Dist "r2modman-zhcn-$PackVersion-$TargetAppVersion.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory($Pack, $zip, [IO.Compression.CompressionLevel]::Optimal, $false)
$zi = Get-Item $zip
Write-Host ("   {0}  ({1} KB)" -f $zi.FullName, [math]::Round($zi.Length / 1KB, 1))
