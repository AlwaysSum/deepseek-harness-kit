# ============================================================
# 本地发布脚本：把构建产物发布到 GitHub Releases 和 GitCode Releases
#
# 用法（在项目根目录或任意目录执行）：
#   # 1. 先构建（或已有产物可跳过）
#   .\scripts\publish-release.ps1 -Build
#
#   # 2. 发布（token 从环境变量读取）
#   $env:GITHUB_TOKEN = "github_pat_xxx"      # GitHub 令牌（可选，未设置则跳过 GitHub）
#   $env:GITCODE_TOKEN = "xxx"                # GitCode 令牌（可选，未设置则跳过 GitCode）
#   .\scripts\publish-release.ps1
#
# 参数：
#   -Version      版本号，如 0.2.0（默认自动读取 src-tauri/tauri.conf.json）
#   -Build        先执行 npm run tauri build
#   -TagAndPush   自动打 git tag vX.Y.Z 并推送（origin / gitcode 远程需可推送）
#   -SkipGitHub   跳过 GitHub
#   -SkipGitCode  跳过 GitCode
#   -GitHubRepo   GitHub 仓库，默认 AlwaysSum/deepseek-harness-kit
#   -GitCodeRepo  GitCode 仓库，默认 Sunflower816/deepseek-harness-kit
#   -Proxy        HTTP 代理（默认取 $env:HTTPS_PROXY，如 http://127.0.0.1:7890）
# ============================================================
[CmdletBinding()]
param(
  [string]$Version,
  [switch]$Build,
  [switch]$TagAndPush,
  [switch]$SkipGitHub,
  [switch]$SkipGitCode,
  [string]$GitHubRepo = "AlwaysSum/deepseek-harness-kit",
  [string]$GitCodeRepo = "Sunflower816/deepseek-harness-kit",
  [string]$Proxy = ""
)
$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path $PSScriptRoot -Parent

function Write-Step { param([string]$Msg) Write-Host "[发布] $Msg" -ForegroundColor Cyan }
function Write-Ok { param([string]$Msg) Write-Host "[发布] $Msg" -ForegroundColor Green }
function Write-Warn { param([string]$Msg) Write-Host "[发布] $Msg" -ForegroundColor Yellow }

# .NET HttpClient（GitCode OBS 上传用）
Add-Type -AssemblyName System.Net.Http -ErrorAction SilentlyContinue

# ---------- curl 工具 ----------
$curlPath = (Get-Command curl.exe -ErrorAction SilentlyContinue).Source
if (-not $curlPath) { $curlPath = 'C:\Windows\System32\curl.exe' }
if (-not (Test-Path $curlPath)) { throw '未找到 curl.exe（Windows 10+ 自带）' }

if (-not $Proxy -and $env:HTTPS_PROXY) { $Proxy = $env:HTTPS_PROXY }

# 统一 curl 调用：返回 @{ Code; Body }
function Call-Curl {
  param([string[]]$CurlArgs)
  $argsList = @('-sS', '--max-time', '120')
  if ($script:Proxy) { $argsList += '--proxy', $script:Proxy }
  $all = @($argsList) + @($CurlArgs)
  $out = & $script:curlPath @all -w "`n__HTTP__%{http_code}" 2>$null
  $lines = @($out) -join "`n"
  $parts = $lines -split '__HTTP__'
  $code = 0
  if ($parts.Count -gt 1) { $code = [int]($parts[-1].Trim()) }
  $body = $parts[0]
  return @{ Code = $code; Body = $body }
}

# ---------- 版本与 tag ----------
if (-not $Version) {
  $confPath = Join-Path $RepoRoot 'src-tauri\tauri.conf.json'
  $confText = [System.IO.File]::ReadAllText($confPath, [System.Text.Encoding]::UTF8)
  $conf = $confText | ConvertFrom-Json
  $Version = $conf.version
}
$Tag = "v$Version"
Write-Step "版本：$Version（tag=$Tag）"

if ($Build) {
  Write-Step '开始构建：npm run tauri build …'
  Push-Location $RepoRoot
  try { npm run tauri build; if ($LASTEXITCODE -ne 0) { throw '构建失败' } }
  finally { Pop-Location }
}

# ---------- 定位产物 ----------
$Assets = @()
$Setup = Get-ChildItem (Join-Path $RepoRoot "src-tauri\target\release\bundle\nsis\*_x64-setup.exe") -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like "*_${Version}_*" } |
    Select-Object -First 1
if ($Setup) { $Assets += $Setup.FullName }
$Portable = Join-Path $RepoRoot 'src-tauri\target\release\dsh-desktop.exe'
if (Test-Path $Portable) { $Assets += $Portable }
if ($Assets.Count -eq 0) { throw "未找到构建产物（$RepoRoot\src-tauri\target\release\…），请先执行 -Build 或手动构建" }
Write-Step "待上传：$($Assets -join '，')"

# ---------- 打 tag 并推送 ----------
if ($TagAndPush) {
  $git = (Get-Command git.exe -ErrorAction SilentlyContinue).Source
  if ($git) {
    if (-not (& $git tag -l $Tag)) { & $git tag $Tag; Write-Ok "已创建本地 tag $Tag" }
    foreach ($remote in @('origin', 'gitcode')) {
      $r = & $git ls-remote --exit-code --tags "$remote" $Tag 2>$null
      if ($LASTEXITCODE -ne 0) {
        & $git push "$remote" $Tag 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) { Write-Ok "已推送 tag 到 $remote" } else { Write-Warn "推送 tag 到 $remote 失败（请手动 git push $remote $Tag）" }
      } else {
        Write-Ok "tag 已存在于 $remote"
      }
    }
  } else {
    Write-Warn '未找到 git，跳过打 tag'
  }
}

# ---------- GitHub 发布 ----------
function Publish-GitHub {
  param([string]$Token)
  Write-Step '发布到 GitHub …'
  $api = "https://api.github.com/repos/$GitHubRepo"
  $auth = "Authorization: Bearer $Token"
  $ua = 'User-Agent: dsh-publish'

  # 已存在则复用
  $r = Call-Curl @('-H', $auth, '-H', $ua, "$api/releases/tags/$Tag")
  if ($r.Code -eq 200) {
    $relId = ($r.Body | ConvertFrom-Json).id
    Write-Ok "Release $Tag 已存在，复用 (id=$relId)"
  } else {
    $r = Call-Curl @('-X', 'POST', '-H', $auth, '-H', $ua,
      '-F', "tag_name=$Tag", '-F', "name=$Tag",
      '-F', "body=自动发布：DeepSeek Harness 桌面端 $Tag",
      "$api/releases")
    if ($r.Code -notin @(200, 201)) { throw "创建 GitHub Release 失败 (HTTP $($r.Code)): $($r.Body)" }
    $relId = ($r.Body | ConvertFrom-Json).id
    Write-Ok "GitHub Release $Tag 已创建 (id=$relId)"
  }

  foreach ($asset in $Assets) {
    $name = Split-Path $asset -Leaf
    # 资产上传必须走 uploads.github.com
    $r = Call-Curl @('-X', 'POST', '-H', $auth, '-H', $ua,
      '-H', 'Content-Type: application/octet-stream',
      '--data-binary', "@$asset",
      "https://uploads.github.com/repos/$GitHubRepo/releases/$relId/assets?name=$name")
    if ($r.Code -in @(200, 201)) {
      Write-Ok "GitHub 上传 $name 完成"
    } elseif ($r.Code -eq 422) {
      Write-Warn "GitHub $name 已存在，跳过"
    } else {
      throw "GitHub 上传 $name 失败 (HTTP $($r.Code)): $($r.Body)"
    }
  }
  Write-Ok "GitHub Release：https://github.com/$GitHubRepo/releases/tag/$Tag"
}

# ---------- GitCode 发布 ----------
function Publish-GitCode {
  param([string]$Token)
  Write-Step '发布到 GitCode …'
  $api = "https://gitcode.com/api/v5/repos/$GitCodeRepo"

  $r = Call-Curl @("$api/releases/tags/$Tag?access_token=$Token")
  if ($r.Code -ne 200) {
    # --data-urlencode 以 UTF-8 百分号编码发送，确保中文正常存储
    $r = Call-Curl @('-X', 'POST',
      '--data-urlencode', "tag_name=$Tag",
      '--data-urlencode', "name=$Tag",
      '--data-urlencode', "body=自动发布：DeepSeek Harness 桌面端 $Tag",
      "$api/releases?access_token=$Token")
    if ($r.Code -in @(200, 201)) {
      Write-Ok "GitCode Release $Tag 已创建"
    } elseif ($r.Code -eq 409) {
      # GitCode 存在最终一致性：创建接口返回已存在即可视为完成
      Write-Warn "GitCode Release $Tag 已存在（检测接口暂未同步，按已存在处理）"
    } else {
      throw "创建 GitCode Release 失败 (HTTP $($r.Code)): $($r.Body)"
    }
  } else {
    Write-Ok "GitCode Release $Tag 已存在"
  }

  foreach ($asset in $Assets) {
    $name = Split-Path $asset -Leaf
    # 上传并验证资产挂载（OBS 回调存在服务端抖动，未挂载则换新地址重试）
    $uploaded = $false
    for ($try = 1; $try -le 4 -and -not $uploaded; $try++) {
      # 1) 获取预签名上传地址（带重试，规避 GitCode 最终一致性）
      $up = $null
      for ($try2 = 1; $try2 -le 3 -and -not $up; $try2++) {
        $r = Call-Curl @("$api/releases/$Tag/upload_url?access_token=$Token&file_name=$name")
        if ($r.Code -eq 200) { $up = $r.Body | ConvertFrom-Json }
        else { Start-Sleep -Seconds 2 }
      }
      if (-not $up) { break }
      # 2) PUT 到 OBS（成功返回 203）
      #    用 .NET HttpClient 发送：规避 PowerShell 原生参数传递差异，且自动使用系统代理
      $http = New-Object System.Net.Http.HttpClient
      try {
        $http.Timeout = [TimeSpan]::FromSeconds(300)
        $bytes = [System.IO.File]::ReadAllBytes($asset)
        $content = New-Object System.Net.Http.ByteArrayContent (,$bytes)
        foreach ($k in $up.headers.PSObject.Properties.Name) {
          $ok = $content.Headers.TryAddWithoutValidation($k, [string]$up.headers.$k)
        }
        $resp = $http.PutAsync([Uri]$up.url, $content).GetAwaiter().GetResult()
        $putCode = [int]$resp.StatusCode
        $resp.Dispose()
      } catch {
        Write-Warn "GitCode 上传 $name 异常：$($_.Exception.Message)"
        $putCode = 0
      } finally {
        $http.Dispose()
      }
      if ($putCode -notin @(200, 201, 203)) {
        Write-Warn "GitCode 上传 $name 重试（HTTP $putCode）…"
        Start-Sleep -Seconds 3
        continue
      }
      # 3) 等待回调并验证资产已挂到 Release
      Start-Sleep -Seconds 6
      $check = Call-Curl @("$api/releases/tags/$Tag?access_token=$Token")
      if ($check.Code -eq 200) {
        $names = @(($check.Body | ConvertFrom-Json).assets | ForEach-Object { $_.name })
        if ($names -contains $name) { $uploaded = $true; break }
      }
      Write-Warn "GitCode 上传 $name 完成但未挂载，换新地址重试…"
      Start-Sleep -Seconds 3
    }
    if ($uploaded) {
      Write-Ok "GitCode 上传 $name 完成"
    } else {
      throw "GitCode 上传 $name 失败（多次尝试后仍未挂载到 Release）"
    }
  }
  Write-Ok "GitCode Release：https://gitcode.com/$GitCodeRepo/releases/tag/$Tag"
}

# ---------- 执行 ----------
if (-not $SkipGitHub) {
  $ghToken = $env:GITHUB_TOKEN
  if (-not $ghToken) { $ghToken = $env:GH_TOKEN }
  if ($ghToken) { Publish-GitHub $ghToken } else { Write-Warn '未设置 GITHUB_TOKEN，跳过 GitHub 发布' }
}

if (-not $SkipGitCode) {
  $gcToken = $env:GITCODE_TOKEN
  if ($gcToken) { Publish-GitCode $gcToken } else { Write-Warn '未设置 GITCODE_TOKEN，跳过 GitCode 发布' }
}

Write-Ok "发布完成：$Tag"
