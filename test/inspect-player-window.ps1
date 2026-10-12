param([Parameter(Mandatory=$true)][int]$PlayerProcessId)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AnimeRecoveryWindow {
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
}
'@
$taskPlayer = Get-Process -Id $PlayerProcessId
$taskPlayer.Refresh()
$taskHandle = $taskPlayer.MainWindowHandle
[PSCustomObject]@{
    processId = $PlayerProcessId
    hasWindow = ($taskHandle -ne 0)
    visible = (($taskHandle -ne 0) -and [AnimeRecoveryWindow]::IsWindowVisible($taskHandle))
    title = $taskPlayer.MainWindowTitle
} | ConvertTo-Json -Compress
