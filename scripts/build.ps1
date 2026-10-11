$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)
& npm.cmd run dist
if ($LASTEXITCODE -ne 0) { throw 'npm run dist failed' }
