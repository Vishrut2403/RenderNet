import { spawn } from 'child_process';
import path from 'path';

const SHELL_SCRIPTS = new Set(['.cmd', '.bat']);

// A backslash only escapes when it sits immediately before a quote or at the
// end of the argument; anywhere else it is a path separator and stays as is.
function quoteArgument(value) {
  const escaped = String(value)
    .replace(/(\\*)"/g, '$1$1\\"')
    .replace(/(\\*)$/, '$1$1');

  return `"${escaped}"`;
}

// Node has refused to spawn .cmd and .bat directly since 20.12, so those go
// through the interpreter. cmd /s strips the outer quotes and takes what is
// left verbatim, which is what carries a path with spaces through intact.
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

// Windows has no signals: kill() terminates the process outright and leaves
// anything it started behind, so an interpreter would die while the render it
// launched carried on. Answers whether a SIGKILL escalation is still to come.
export function terminate(child, platform = process.platform) {
  if (platform !== 'win32') {
    child.kill('SIGTERM');
    return true;
  }

  spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    .on('error', () => child.kill());

  return false;
}
