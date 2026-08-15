# Upload a file to a gitcode release via the presigned OBS URL flow.
param(
  [Parameter(Mandatory = $true)][string]$Token,
  [Parameter(Mandatory = $true)][string]$Repo,   # owner/name
  [Parameter(Mandatory = $true)][string]$Tag,
  [Parameter(Mandatory = $true)][string]$FilePath
)
$ProgressPreference = 'SilentlyContinue'
$fname = Split-Path $FilePath -Leaf
$base = "https://gitcode.com/api/v5/repos/$Repo"
$json = Invoke-RestMethod -Uri "$base/releases/$Tag/upload_url?access_token=$Token&file_name=$fname" -TimeoutSec 30
Write-Host "got presigned URL for $fname"
$headers = @()
foreach ($k in $json.headers.PSObject.Properties.Name) {
  $headers += "-H"
  $headers += "`"$k`: $($json.headers.$k)`""
}
$curlArgs = @('-sS', '-X', 'PUT')
$curlArgs += $headers
$curlArgs += '--data-binary', "@$FilePath"
$curlArgs += $json.url
$out = & 'C:\Windows\System32\curl.exe' @curlArgs 2>&1
Write-Host "upload resp: $($out -join ' ')"
if ($LASTEXITCODE -eq 0) { Write-Host "OK: $fname 上传完成" } else { Write-Host "FAIL: $fname (exit $LASTEXITCODE)"; exit 1 }
