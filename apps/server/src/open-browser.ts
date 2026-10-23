import { spawn } from 'node:child_process';
import path from 'node:path';

/** Pass the bootstrap URL as data, so paths and tickets never become shell commands. */
export function openLocalBrowser(url: string): void {
  const windows = process.platform === 'win32';
  const command = windows
    ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')
    : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = windows
    ? ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process -FilePath $env:AGENTDECK_BROWSER_URL']
    : [url];
  const failed = () => process.stderr.write('无法自动打开浏览器，请点击上方终端中的完整连接链接。\n');
  try {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: 'ignore',
      env: { ...process.env, AGENTDECK_BROWSER_URL: url },
    });
    child.once('error', failed);
    child.once('exit', code => { if (code !== 0) failed(); });
    child.unref();
  } catch { failed(); }
}
