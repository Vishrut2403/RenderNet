import { spawn } from 'child_process';
import path from 'path';

const SHELL_SCRIPTS = new Set(['.cmd', '.bat']);

function quoteArgument(value) {
  const escaped = String(value)
    .replace(/(\\*)"/g, '$1$1\\"')
    .replace(/(\\*)$/, '$1$1');

  return `"${escaped}"`;
}

export function spawnPlan(executable, args, platform = process.platform) {
  if (platform !== 'win32' || !SHELL_SCRIPTS.has(path.extname(executable).toLowerCase())) {
    return { command: executable, args, options: {} };
  }

  const line = [executable, ...args].map(quoteArgument).join(' ');

  return {
    command: process.env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
    options: { windowsVerbatimArguments: true }
  };
}

export function launch(executable, args, options = {}) {
  const plan = spawnPlan(executable, args);

  return spawn(plan.command, plan.args, { ...options, ...plan.options });
}

export function terminate(child, platform = process.platform) {
  if (platform !== 'win32') {
    child.kill('SIGTERM');
    return true;
  }

  spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    .on('error', () => child.kill());

  return false;
}
