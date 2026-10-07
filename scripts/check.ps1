$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)

function Invoke-Checked([string]$File, [string[]]$Arguments) {
  & $File @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$File $($Arguments -join ' ') failed with exit code $LASTEXITCODE" }
}

Invoke-Checked 'node' @('test/run.js')
Invoke-Checked 'node' @('--check', 'main.js')
Invoke-Checked 'node' @('--check', 'preload.js')
Invoke-Checked 'node' @('--check', 'renderer/app.js')
Invoke-Checked 'node' @('--check', 'renderer/i18n.js')
Invoke-Checked 'git' @('diff', '--check')
Write-Host 'All checks passed.'
