import { launch, terminate } from './utils/process-control.js';

const OUTPUT_TAIL = 4000;
const KILL_GRACE_MS = 5000;

export const FRAME_DONE = 'RENDERNET_FRAME_DONE ';

const READY = 'RENDERNET_READY';
const SPAN_DONE = 'RENDERNET_SPAN_DONE';
const SPAN_FAILED = 'RENDERNET_SPAN_FAILED ';

export const DAEMON_SCRIPT = `import bpy, sys, json

PATTERN = bpy.context.scene.render.filepath


def render(frames):
    scene = bpy.context.scene

    for number in frames:
        scene.frame_set(number)
        scene.render.filepath = PATTERN.replace('####', str(number).zfill(4))
        bpy.ops.render.render(write_still=True)


print('${READY}', flush=True)

# readline rather than iteration, which reads ahead and would sit on a span
# until enough of them had been sent to fill a buffer.
while True:
    line = sys.stdin.readline()

    if not line:
        break

    try:
        render(json.loads(line))
    except Exception as failure:
        print('${SPAN_FAILED}' + str(failure).replace('\\n', ' '), flush=True)
        sys.exit(1)

    print('${SPAN_DONE}', flush=True)
`;

export function sessionKey(executable, args, env) {
  const ours = Object.entries(env).filter(([name]) => name.startsWith('RENDERNET_')).sort();

  return JSON.stringify([executable, args, ours]);
}

export class BlenderSession {
  constructor(executable, args, env) {
    this.executable = executable;
    this.args = args;
    this.env = env;
    this.key = sessionKey(executable, args, env);
    this.process = null;
    this.pending = null;
    this.onFrame = null;
    this.partial = '';
    this.stdout = '';
    this.stderr = '';
    this.killTimer = null;
  }

  get alive() {
    return this.process !== null;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject, marker: READY };

      const blender = launch(this.executable, this.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: this.env
      });

      this.process = blender;

      blender.stdout.on('data', data => this.readOutput(data));
      blender.stdin.on('error', () => {});
      blender.stderr.on('data', (data) => {
        this.stderr = (this.stderr + data).slice(-OUTPUT_TAIL);
      });

      blender.on('close', (code, signal) => this.closed(code, signal));
      blender.on('error', (error) => {
        this.process = null;
        this.settle(new Error(`Failed to start Blender: ${error.message}`));
      });
    });
  }

  renderSpan(frames, onFrame) {
    return new Promise((resolve, reject) => {
      if (!this.alive) {
        reject(new Error('Blender is no longer running'));
        return;
      }

      this.onFrame = onFrame;
      this.pending = { resolve, reject, marker: SPAN_DONE };

      try {
        this.process.stdin.write(`${JSON.stringify(frames)}\n`);
      } catch (error) {
        this.settle(new Error(`Blender would not take the span: ${error.message}`));
      }
    });
  }

  readOutput(data) {
    this.stdout = (this.stdout + data).slice(-OUTPUT_TAIL);

    this.partial += data;

    const lines = this.partial.split('\n');
    this.partial = lines.pop();

    for (const line of lines) this.readLine(line);
  }

  readLine(line) {
    const said = line.indexOf(FRAME_DONE);

    if (said > -1) {
      this.onFrame?.(Number(line.slice(said + FRAME_DONE.length)));
      return;
    }

    const failed = line.indexOf(SPAN_FAILED);

    if (failed > -1) {
      this.settle(new Error(line.slice(failed + SPAN_FAILED.length).trim()));
      return;
    }

    if (this.pending && line.includes(this.pending.marker)) this.settle(null);
  }

  closed(code, signal) {
    this.process = null;
    clearTimeout(this.killTimer);

    if (signal) {
      this.settle(new Error(`Blender terminated by signal ${signal}`));
      return;
    }

    const detail = (this.stderr.trim() || this.stdout.trim()).slice(-500);

    this.settle(code === 0
      ? new Error('Blender stopped before the span was finished')
      : new Error(`Blender exited with code ${code}: ${detail}`));
  }

  settle(failure) {
    const waiting = this.pending;

    this.pending = null;

    if (!waiting) return;

    if (failure) waiting.reject(failure);
    else waiting.resolve();
  }

  kill() {
    const running = this.process;

    if (!running) return Promise.resolve();

    return new Promise((resolve) => {
      running.on('close', () => resolve());

      if (terminate(running)) {
        this.killTimer = setTimeout(() => running.kill('SIGKILL'), KILL_GRACE_MS);
        this.killTimer.unref?.();
      }
    });
  }
}
