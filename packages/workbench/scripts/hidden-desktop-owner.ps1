param(
  [Parameter(Mandatory = $true)][string]$RequestFile,
  [Parameter(Mandatory = $true)][string]$ResultFile,
  [Parameter(Mandatory = $true)][string]$ExitFile
)
$ErrorActionPreference = "Stop"
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class HiddenDesktopOwner {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct STARTUPINFO {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr CreateDesktop(string name, IntPtr device, IntPtr devmode, int flags, uint access, IntPtr sa);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool CloseDesktop(IntPtr handle);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CreateProcess(string app, StringBuilder command, IntPtr pa, IntPtr ta, bool inherit, uint flags,
    IntPtr environment, string cwd, ref STARTUPINFO startup, out PROCESS_INFORMATION process);
  [DllImport("kernel32.dll")] public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll")] public static extern bool GetExitCodeProcess(IntPtr handle, out uint code);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
}
"@
$request = [System.IO.File]::ReadAllText($RequestFile, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
Remove-Item -LiteralPath $RequestFile -Force
foreach ($property in $request.env.PSObject.Properties) {
  [Environment]::SetEnvironmentVariable($property.Name, [string]$property.Value, "Process")
}
$desktopHandle = [HiddenDesktopOwner]::CreateDesktop(
  [string]$request.desktop, [IntPtr]::Zero, [IntPtr]::Zero, 0, 0x10000000, [IntPtr]::Zero)
if ($desktopHandle -eq [IntPtr]::Zero) {
  throw "CreateDesktop failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
}
$process = New-Object HiddenDesktopOwner+PROCESS_INFORMATION
$startup = New-Object HiddenDesktopOwner+STARTUPINFO
$startup.cb = [Runtime.InteropServices.Marshal]::SizeOf($startup)
$startup.lpDesktop = "WinSta0\$($request.desktop)"
$command = '"' + [string]$request.exe + '"'
if ([string]$request.args -ne "") { $command += " " + [string]$request.args }
try {
  if (-not [HiddenDesktopOwner]::CreateProcess(
      [string]$request.exe, ([System.Text.StringBuilder]::new($command)), [IntPtr]::Zero, [IntPtr]::Zero, $false,
      0x400 -bor 0x200, [IntPtr]::Zero, [string]$request.cwd, [ref]$startup, [ref]$process)) {
    throw "CreateProcess failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error()); cwd=$($request.cwd); command=$command"
  }
  [HiddenDesktopOwner]::CloseHandle($process.hThread) | Out-Null
  @{ pid = $process.dwProcessId; ownerPid = $PID; desktop = [string]$request.desktop } |
    ConvertTo-Json -Compress | Set-Content -LiteralPath $ResultFile -Encoding UTF8
  [HiddenDesktopOwner]::WaitForSingleObject($process.hProcess, [uint32]::MaxValue) | Out-Null
  [uint32]$exitCode = 0
  [HiddenDesktopOwner]::GetExitCodeProcess($process.hProcess, [ref]$exitCode) | Out-Null
  @{ pid = $process.dwProcessId; exitCode = $exitCode } |
    ConvertTo-Json -Compress | Set-Content -LiteralPath $ExitFile -Encoding UTF8
} catch {
  @{ error = $_.Exception.Message; ownerPid = $PID } |
    ConvertTo-Json -Compress | Set-Content -LiteralPath $ResultFile -Encoding UTF8
  throw
} finally {
  if ($process.hProcess -ne [IntPtr]::Zero) { [HiddenDesktopOwner]::CloseHandle($process.hProcess) | Out-Null }
  [HiddenDesktopOwner]::CloseDesktop($desktopHandle) | Out-Null
}
