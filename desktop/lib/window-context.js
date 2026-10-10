const { execFile } = require('node:child_process');
// Fixed command, no user-supplied interpolation; only used after Follow is enabled.
const script = `Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class RoodyWindow {
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
}
'@;
$b = New-Object System.Text.StringBuilder 2048;
$h = [RoodyWindow]::GetForegroundWindow();
[void][RoodyWindow]::GetWindowText($h, $b, $b.Capacity);
@{id=$h.ToInt64().ToString();title=$b.ToString()} | ConvertTo-Json -Compress`;
function activeWindow() {
  if (process.platform !== 'win32') return Promise.resolve(null);
  return new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 6000, windowsHide: true }, (err, out) => {
    if (err) return reject(new Error('Windows context unavailable. You can still use Look at this.'));
    try { resolve(JSON.parse(out)); } catch { reject(new Error('Could not read the active window')); }
  }));
}
module.exports = { activeWindow };
