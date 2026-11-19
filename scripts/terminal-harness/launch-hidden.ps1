# Starts the debug build on a separate, invisible Win32 desktop so that its
# window can neither take the keyboard focus nor cover the user's windows.
param([string]$Exe, [string]$Instance, [string]$DataDir, [string]$PidFile)
Add-Type @'
using System; using System.Runtime.InteropServices;
public class HiddenDesk {
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateDesktopW(string name, IntPtr device, IntPtr devmode, int flags, uint access, IntPtr sa);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct STARTUPINFO { public int cb; public IntPtr lpReserved; public IntPtr lpDesktop; public IntPtr lpTitle; public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags; public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcessW(string app, System.Text.StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  public static string Start(string exe, string cwd, string desk) {
    IntPtr h = CreateDesktopW(desk, IntPtr.Zero, IntPtr.Zero, 0, 0x10000000, IntPtr.Zero);
    if (h == IntPtr.Zero) return "ERR CreateDesktop " + Marshal.GetLastWin32Error();
    STARTUPINFO si = new STARTUPINFO(); si.cb = Marshal.SizeOf(typeof(STARTUPINFO)); si.lpDesktop = Marshal.StringToHGlobalUni(desk);
    PROCESS_INFORMATION pi;
    if (!CreateProcessW(exe, new System.Text.StringBuilder("\"" + exe + "\""), IntPtr.Zero, IntPtr.Zero, false, 0, IntPtr.Zero, cwd, ref si, out pi)) return "ERR CreateProcess " + Marshal.GetLastWin32Error();
    return pi.dwProcessId.ToString();
  }
}
'@
$env:MYMUX_DEV_INSTANCE = $Instance
$env:WEBVIEW2_USER_DATA_FOLDER = $DataDir
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--disable-features=CalculateNativeWinOcclusion --disable-renderer-backgrounding --disable-backgrounding-occluded-windows"
$r = [HiddenDesk]::Start($Exe, (Split-Path $Exe), "mymux-verify-$Instance")
if ($r -like "ERR*") { Write-Output $r; exit 1 }
$r | Out-File $PidFile -Encoding ascii
"started pid $r"
# Keep this process (and with it the desktop handle) alive while the test runs.
Wait-Process -Id ([int]$r) -ErrorAction SilentlyContinue
