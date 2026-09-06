# Starts a process on a separate Windows desktop so its windows, dialogs and focus never reach the user's screen.
# Usage: start-on-hidden-desktop.ps1 -Desktop <name> -Exe <path> -Args <string> -Cwd <dir> -EnvJson <json object>
# Prints the PID. The desktop is created if missing and lives until the interactive session ends.
param(
  [Parameter(Mandatory = $true)][string]$Desktop,
  [Parameter(Mandatory = $true)][string]$Exe,
  [string]$Args = "",
  [string]$Cwd = (Get-Location).Path,
  [string]$EnvJson = "{}"
)
$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class HiddenDesktop {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct STARTUPINFO {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }

  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr CreateDesktop(string name, IntPtr device, IntPtr devmode, int flags, uint access, IntPtr sa);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CreateProcess(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags,
    IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

  const uint GENERIC_ALL = 0x10000000;
  const uint CREATE_UNICODE_ENVIRONMENT = 0x400;
  const uint CREATE_NEW_PROCESS_GROUP = 0x200;

  public static int Start(string desktop, string commandLine, string cwd) {
    IntPtr h = CreateDesktop(desktop, IntPtr.Zero, IntPtr.Zero, 0, GENERIC_ALL, IntPtr.Zero);
    if (h == IntPtr.Zero) throw new Exception("CreateDesktop failed: " + Marshal.GetLastWin32Error());
    var si = new STARTUPINFO(); si.cb = Marshal.SizeOf(si); si.lpDesktop = "WinSta0\\" + desktop;
    PROCESS_INFORMATION pi;
    // Environment is inherited from this PowerShell process (already patched by the caller).
    if (!CreateProcess(null, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, false,
        CREATE_UNICODE_ENVIRONMENT | CREATE_NEW_PROCESS_GROUP, IntPtr.Zero, cwd, ref si, out pi))
      throw new Exception("CreateProcess failed: " + Marshal.GetLastWin32Error());
    CloseHandle(pi.hThread); CloseHandle(pi.hProcess);
    return pi.dwProcessId;
  }
}
"@

$envMap = $EnvJson | ConvertFrom-Json
foreach ($p in $envMap.PSObject.Properties) { [Environment]::SetEnvironmentVariable($p.Name, [string]$p.Value, "Process") }
$cmd = '"' + $Exe + '"'
if ($Args -ne "") { $cmd += " " + $Args }
[HiddenDesktop]::Start($Desktop, $cmd, $Cwd)
