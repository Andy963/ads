import { spawn } from 'node:child_process';

export type RestartScope = 'self' | 'web' | 'all';

export function parseRestartIntent(raw: string): { scope: RestartScope } | null {
  const input = String(raw ?? '').trim();
  if (!input) return null;
  if (input.length > 64) return null;

  const normalized = input.toLowerCase().replace(/\s+/g, ' ').trim();
  const token = normalized.replace(/\s+/g, '');

  const self = new Set([
    'restart',
    'reboot',
    'restartbot',
    'restarttelegram',
    'restarttg',
    '重启',
    '重启一下',
    '重启下',
    '重启bot',
    '重启telegram',
    '重启tg',
  ]);
  const web = new Set(['restartweb', 'rebootweb', '重启web']);
  const all = new Set(['restartall', 'rebootall', '重启全部', '全部重启', '重启所有']);

  if (all.has(token)) return { scope: 'all' };
  if (web.has(token)) return { scope: 'web' };
  if (self.has(token)) return { scope: 'self' };
  return null;
}

export async function restartPm2Apps(apps: string[]): Promise<void> {
  const args = apps.map((app) => String(app ?? '').trim()).filter(Boolean);
  if (args.length === 0) {
    throw new Error('pm2 app name is required');
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn('pm2', ['restart', ...args], { stdio: 'ignore' });
    child.once('error', (error) => reject(error));
    child.once('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`pm2 restart failed (exit=${code ?? 'null'})`));
    });
  });
}

export function triggerSelfRestart(delayMs = 250): void {
  const timer = setTimeout(() => {
    try {
      process.kill(process.pid, 'SIGTERM');
    } catch {
      process.exit(0);
    }
  }, delayMs);
  timer.unref?.();
}
