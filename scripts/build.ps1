$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)

& (Join-Path $PSScriptRoot 'check.ps1')

$dist = Join-Path (Get-Location) 'dist'
if (Test-Path -LiteralPath $dist) {
  Get-ChildItem -LiteralPath $dist -File -Filter 'AnimePlayer-Setup-*.exe' |
    Remove-Item -Force
}

& (Join-Path (Split-Path (Get-Command npm.cmd).Source) 'npm.cmd') exec -- electron-builder --win
if ($LASTEXITCODE -ne 0) { throw "electron-builder failed with exit code $LASTEXITCODE" }

$version = (Get-Content -LiteralPath 'package.json' -Raw | ConvertFrom-Json).version
$expectedInstaller = Join-Path $dist "AnimePlayer-Setup-$version.exe"
if (-not (Test-Path -LiteralPath $expectedInstaller)) { throw "Expected installer not found: $expectedInstaller" }

$staleInstallers = @(Get-ChildItem -LiteralPath $dist -File -Filter 'AnimePlayer-Setup-*.exe' | Where-Object Name -ne "AnimePlayer-Setup-$version.exe")
if ($staleInstallers.Count -gt 0) { throw "Old installers remain in dist: $($staleInstallers.Name -join ', ')" }

Get-Item -LiteralPath (Join-Path $dist 'AnimePlayer-portable.exe'), $expectedInstaller |
  Select-Object Name, Length, LastWriteTime
