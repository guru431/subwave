// `subwave logs [service|all]` — tails compose logs to the terminal; Ctrl-C
// breaks out. With no arg, prompts.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { detectCompose, listDeclaredServices, type ComposeFile, type ComposeEnv } from '../compose.ts';
import { composeLogs } from '../docker.ts';
import { exitIfCancelled, err, info, muted, p, pauseForEnter, header, warn } from '../ui.ts';
import { getWebDevLog } from '../web-dev.ts';

const WEB_DEV_SERVICE = 'web (dev)';

export interface LogsOpts {
  service?: string;
}

export async function runLogsCommand(opts: LogsOpts = {}): Promise<void> {
  const current = detectCompose();
  if (current.env === 'down' || !current.file) {
    header('Stack down');
    info('nothing to tail. `subwave start` first.');
    await pauseForEnter();
    return;
  }

  const services = await resolveServices(current.file, current.env, opts.service);
  if (!services) return;

  // The dev web server isn't in docker; its log is a plain file.
  if (services.length === 1 && services[0] === WEB_DEV_SERVICE) {
    return tailWebDev();
  }

  header(services.length === 0 ? 'Tailing all services' : `Tailing ${services.join(', ')}`);
  muted('Ctrl-C to stop.');
  console.log();

  await composeLogs(current.file, services);
}

async function resolveServices(file: ComposeFile, env: ComposeEnv, arg?: string): Promise<string[] | null> {
  const declared = listDeclaredServices(file);
  // The picker shows the spaced form, but `subwave logs web-dev` must work too.
  const WEB_DEV_ALIASES = new Set(['web-dev', 'webdev', WEB_DEV_SERVICE]);

  if (arg) {
    if (arg === 'all') return [];
    if (env === 'dev' && WEB_DEV_ALIASES.has(arg)) return [WEB_DEV_SERVICE];
    if (!declared.includes(arg)) {
      err(`unknown service: ${arg}. known: ${declared.join(', ')}${env === 'dev' ? ', web-dev' : ''}`);
      return null;
    }
    return [arg];
  }

  const options = [
    { value: '__all__', label: 'all services', hint: 'tail everything' },
    ...declared.map((s) => ({ value: s, label: s })),
  ];
  if (env === 'dev') {
    options.push({
      value: WEB_DEV_SERVICE,
      label: WEB_DEV_SERVICE,
      hint: 'tail state/logs/web-dev.log',
    });
  }
  const choice = exitIfCancelled(await p.select<string>({
    message: 'Which logs?',
    options,
  }));
  return choice === '__all__' ? [] : [choice];
}

async function tailWebDev(): Promise<void> {
  header('Tailing web (dev)');
  muted(`source: ${getWebDevLog()}`);
  muted('Ctrl-C to stop.');
  console.log();
  if (!existsSync(getWebDevLog())) {
    info('log file does not exist yet — start the web dev server to create it.');
    return;
  }
  await new Promise<void>((resolveP) => {
    const child = spawn('tail', ['-n', '200', '-f', getWebDevLog()], { stdio: 'inherit' });
    child.on('error', (e) => {
      warn(`Could not start tail: ${e.message}. Read ${getWebDevLog()} with your log viewer.`);
      resolveP();
    });
    child.on('exit', () => resolveP());
  });
}
