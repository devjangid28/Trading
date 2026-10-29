/**
 * Frees the two fixed dev ports before `npm run dev` starts.
 *
 * Ctrl+C normally tears the children down, but on Windows the chain
 * `concurrently` → `tsx watch` → node can leave an orphan holding 5173 or 8787.
 * The next start then either fails to bind (server.strictPort) or — worse — the
 * browser keeps talking to the stale process and shows a blank page.
 *
 * Only listeners that are demonstrably part of this project are killed, so an
 * unrelated app that happens to use one of these ports is left untouched.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const PORTS = [5173, 8787];
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..').toLowerCase();

interface Listener {
  pid: number;
  command: string;
}

function run(file: string, args: string[]): string {
  try {
    return execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

function listenersOn(port: number): Listener[] {
  if (process.platform === 'win32') {
    const out = run('netstat', ['-ano', '-p', 'tcp']);
    const pids = new Set<number>();
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
      if (m && Number(m[1]) === port) pids.add(Number(m[2]));
    }
    return [...pids].map((pid) => {
      const command = run('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
      ]).trim();
      return { pid, command };
    });
  }

  const out = run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']);
  return out
    .split(/\s+/)
    .filter(Boolean)
    .map((raw) => {
      const pid = Number(raw);
      return { pid, command: run('ps', ['-p', String(pid), '-o', 'command=']).trim() };
    });
}

/** A listener is ours only when its command line points at this checkout. */
function isOurs(listener: Listener): boolean {
  const command = listener.command.toLowerCase();
  return command.includes(REPO) || command.includes('orderflow');
}

function kill(pid: number): void {
  if (process.platform === 'win32') {
    run('taskkill', ['/PID', String(pid), '/T', '/F']);
  } else {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

let freed = 0;
for (const port of PORTS) {
  for (const listener of listenersOn(port)) {
    if (listener.pid === process.pid) continue;
    if (!isOurs(listener)) {
      console.warn(
        `[dev] port ${port} is held by an unrelated process (PID ${listener.pid}); leaving it alone. ` +
          'Free the port yourself if startup fails.',
      );
      continue;
    }
    console.log(`[dev] freeing port ${port} from a stale OrderFlow process (PID ${listener.pid})`);
    kill(listener.pid);
    freed += 1;
  }
}

if (freed > 0) {
  // Give the OS a beat to release the sockets before Vite/Express rebind.
  await new Promise((resolve) => setTimeout(resolve, 500));
}
