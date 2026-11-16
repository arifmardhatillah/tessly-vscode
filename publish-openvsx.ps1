# Unggah Tessly ke Open VSX (dipakai Cursor, Windsurf, VSCodium).
# Token diminta di sini dan tidak tampil saat ditempel; tidak disimpan ke file mana pun.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
$vsix = "tessly-$version.vsix"
if (-not (Test-Path $vsix)) {
  Write-Host "Membuat $vsix ..."
  npx vsce package
}

$secure = Read-Host 'Tempel token Open VSX lalu tekan Enter' -AsSecureString
$env:OVSX_PAT = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))

try {
  # Namespace hanya perlu dibuat sekali; kalau sudah ada, pesan "already exists" boleh diabaikan.
  Write-Host 'Menyiapkan namespace arifmardhatillah ...'
  npx --yes ovsx create-namespace arifmardhatillah
  Write-Host "Mengunggah $vsix ..."
  npx --yes ovsx publish $vsix
  if ($LASTEXITCODE -eq 0) { Write-Host "Selesai: https://open-vsx.org/extension/arifmardhatillah/tessly" -ForegroundColor Green }
} finally {
  Remove-Item Env:OVSX_PAT -ErrorAction SilentlyContinue
}
