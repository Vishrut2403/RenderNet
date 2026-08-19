// The platform decisions are taken as data so both branches can be checked from
// either OS. Windows is where the project deploys and the one place the rest of
// the suite cannot reach from a developer machine.
import { spawn } from 'child_process';
import { createResults, waitForCondition } from './helpers.mjs';
import { spawnPlan, terminate } from '../src/utils/process-control.js';

function commandLine(plan) {
  return plan.args[plan.args.length - 1];
}

// CommandLineToArgvW, which is how every Windows program recovers its argv.
// Running the generated line back through it is the closest this can get to
// Windows from a developer machine: cmd /s strips the outer quotes, the .cmd
// re-emits the rest through %*, and the process at the end parses it by these
// rules. A quoting bug shows up here as an argument that comes back wrong.
function parseWindowsArgv(line) {
  const argv = [];
  let current = '';
  let quoted = false;
  let started = false;
  let slashes = 0;

  const flushSlashes = (beforeQuote) => {
    current += '\\'.repeat(beforeQuote ? Math.floor(slashes / 2) : slashes);
    const literalQuote = beforeQuote && slashes % 2 === 1;
    slashes = 0;
    return literalQuote;
  };

  for (const char of line) {
    if (char === '\\') {
      slashes++;
      started = true;
      continue;
    }

    if (char === '"') {
      if (flushSlashes(true)) current += '"';
      else quoted = !quoted;
      started = true;
      continue;
    }

    flushSlashes(false);

    if (!quoted && (char === ' ' || char === '\t')) {
      if (started) argv.push(current);
      current = '';
      started = false;
      continue;
    }

    current += char;
    started = true;
  }

  flushSlashes(false);
  if (started) argv.push(current);

  return argv;
}

// What cmd /s does before handing the rest on.
function stripOuterQuotes(line) {
  return line.startsWith('"') && line.endsWith('"') ? line.slice(1, -1) : line;
}

export default async function run() {
  const results = createResults('process-control');

  console.log('\n  Launching');

  const posix = spawnPlan('/usr/bin/blender', ['-b', 'scene.blend'], 'linux');
  results.check('POSIX spawns the executable directly',
    posix.command === '/usr/bin/blender' && posix.args.length === 2,
    JSON.stringify(posix));
  results.check('and asks for no special argument handling',
    Object.keys(posix.options).length === 0, JSON.stringify(posix.options));

  const exe = spawnPlan('C:\\Program Files\\Blender\\blender.exe', ['-b'], 'win32');
  results.check('an .exe on Windows is spawned directly too',
    exe.command === 'C:\\Program Files\\Blender\\blender.exe', exe.command);

  const cmd = spawnPlan('C:\\tools\\fake blender.cmd', ['-b', 'C:\\my scenes\\a.blend'], 'win32');
  results.check('a .cmd goes through the interpreter',
    /cmd\.exe$/i.test(cmd.command), cmd.command);
  results.check('with /d /s /c',
    cmd.args.slice(0, 3).join(' ') === '/d /s /c', JSON.stringify(cmd.args));
  results.check('and verbatim arguments, since the quoting is done here',
    cmd.options.windowsVerbatimArguments === true, JSON.stringify(cmd.options));

  const line = commandLine(cmd);
  results.check('the whole command line is wrapped for /s to strip',
    line.startsWith('"') && line.endsWith('"'), line);
  results.check('a script path with a space survives quoted',
    line.includes('"C:\\tools\\fake blender.cmd"'), line);
  results.check('an argument with a space survives quoted',
    line.includes('"C:\\my scenes\\a.blend"'), line);

  // A trailing backslash before the closing quote would escape it and swallow
  // the rest of the command line - the classic Windows quoting bug.
  const trailing = commandLine(spawnPlan('C:\\a b\\x.bat', ['C:\\out dir\\'], 'win32'));
  results.check('a trailing backslash is doubled so it cannot escape the quote',
    trailing.includes('"C:\\out dir\\\\"'), trailing);

  const quoted = commandLine(spawnPlan('C:\\x.cmd', ['say "hi"'], 'win32'));
  results.check('an embedded quote is escaped',
    quoted.includes('\\"hi\\"'), quoted);

  results.check('.BAT is recognised whatever its case',
    /cmd\.exe$/i.test(spawnPlan('C:\\x.BAT', [], 'win32').command),
    spawnPlan('C:\\x.BAT', [], 'win32').command);

  results.check('an extensionless path is left alone',
    spawnPlan('/opt/blender/blender', [], 'win32').command === '/opt/blender/blender');

  console.log('\n  The command line survives Windows argument parsing');

  const cases = [
    ['C:\\tools\\fake blender.cmd', ['-b', 'C:\\my scenes\\a.blend', '-f', '1']],
    ['C:\\x.cmd', ['C:\\out dir\\', '-o', 'C:\\r\\frame_####']],
    ['C:\\x.cmd', ['say "hi"', 'plain', '']],
    ['C:\\Program Files (x86)\\b.bat', ['--', '--cycles-device', 'CPU']]
  ];

  for (const [executable, args] of cases) {
    const parsed = parseWindowsArgv(stripOuterQuotes(commandLine(spawnPlan(executable, args, 'win32'))));
    const expected = [executable, ...args];

    results.check(`round-trips ${JSON.stringify(args)}`,
      JSON.stringify(parsed) === JSON.stringify(expected),
      `got ${JSON.stringify(parsed)}`);
  }

  console.log('\n  Terminating');

  const survivor = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  await waitForCondition(() => survivor.pid !== undefined, { label: 'the child to start' });

  results.check('POSIX reports that an escalation is still to come',
    terminate(survivor, 'linux') === true);
  results.check('and the polite stop lands',
    await waitForCondition(() => survivor.exitCode !== null || survivor.signalCode !== null,
      { label: 'the child to stop' }));

  // taskkill is forceful already, so there is nothing left to escalate to. Off
  // Windows it is absent and the fallback kill is what stops the child, which
  // is the path that runs if taskkill is ever missing on Windows too.
  const tree = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  await waitForCondition(() => tree.pid !== undefined, { label: 'the child to start' });

  results.check('Windows reports no escalation to come',
    terminate(tree, 'win32') === false);
  results.check('and the child stops either way',
    await waitForCondition(() => tree.exitCode !== null || tree.signalCode !== null,
      { label: 'the child to stop' }));

  return results;
}
