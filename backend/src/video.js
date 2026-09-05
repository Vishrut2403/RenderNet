import fs from 'fs';
import path from 'path';
import { launch } from './utils/process-control.js';
import { findFfmpeg } from './utils/ffmpeg-check.js';
import { getFrames, saveJob } from './db.js';
import { jobs } from './job-store.js';
import { forgetUsage } from './storage.js';
import { dataPath } from './paths.js';
import { PREVIEWABLE_EXTENSIONS } from './formats.js';
import { isTiled } from './composite.js';

const DEFAULT_FPS = Number(process.env.VIDEO_FPS) || 24;

let queued = Promise.resolve();

export function videoName(jobId) {
  return `render_${jobId}.mp4`;
}

function playableFrames(job) {
  return getFrames(job.id)
    .filter(frame => frame.status === 'done' && frame.filename)
    .filter(frame => PREVIEWABLE_EXTENSIONS.includes(path.extname(frame.filename).toLowerCase()))
    .map(frame => dataPath(job.outputFolder, frame.filename));
}

// Answers immediately with whether the encode was started; the job record
// carries the outcome, the way rendering itself does.
export function startVideo(jobId, fps = DEFAULT_FPS) {
  const job = jobs.get(jobId);

  if (!job) return { status: 404, error: 'Job not found' };
  if (job.video === 'encoding') return { status: 409, error: 'A video is already being made' };

  // Its frames are regions of one picture, and they are not even beside the
  // finished still - they are kept aside in a folder of their own.
  if (isTiled(job)) {
    return { status: 409, error: 'A tiled still is one picture, so there is nothing to play' };
  }

  if (!findFfmpeg()) {
    return { status: 501, error: 'This machine has no ffmpeg, so it cannot make a video' };
  }

  if (!Number.isInteger(fps) || fps < 1 || fps > 120) {
    return { status: 400, error: 'fps must be a whole number from 1 to 120' };
  }

  const frames = playableFrames(job);

  if (frames.length < 2) {
    return {
      status: 409,
      error: 'A video needs at least two rendered frames a browser can read; '
        + 'OpenEXR on its own is not one of them'
    };
  }

  job.video = 'encoding';
  saveJob(job);

  // One at a time: encoding is the same processor the renders want.
  queued = queued
    .then(() => encode(job, frames, fps))
    .then(error => finish(jobId, error))
    .catch(error => finish(jobId, error.message));

  return { status: 202, frames: frames.length };
}

function finish(jobId, error) {
  const job = jobs.get(jobId);

  if (!job) return;

  job.video = error ? 'failed' : 'ready';
  saveJob(job);

  if (error) console.error(`Job ${jobId}: video failed: ${error}`);
  else {
    // The video counts against the same quota as the frames it was made from.
    forgetUsage(job.owner);
    console.log(`Job ${jobId}: video ready`);
  }
}

function encode(job, frames, fps) {
  return new Promise(resolve => {
    const outputDir = dataPath(job.outputFolder);
    const listFile = path.join(outputDir, `video_${job.id}.txt`);
    const target = path.join(outputDir, videoName(job.id));

    // The concat demuxer takes the files it is given, so a job with gaps in its
    // range - frames that failed - still makes a video of what it has.
    fs.writeFileSync(
      listFile,
      frames.map(file => `file '${file.replace(/'/g, "'\\''")}'`).join('\n') + '\n'
    );

    const ffmpeg = launch(findFfmpeg(), [
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-r', String(fps),
      '-i', listFile,
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-crf', '20',
      // h.264 will not take an odd width or height, and a render at 33% often
      // has one.
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-movflags', '+faststart',
      target
    ], { stdio: ['ignore', 'ignore', 'pipe'] });

    let errors = '';
    ffmpeg.stderr.on('data', chunk => { errors = (errors + chunk).slice(-2000); });

    ffmpeg.on('error', error => resolve(`ffmpeg could not start: ${error.message}`));

    ffmpeg.on('close', code => {
      fs.rmSync(listFile, { force: true });

      if (code === 0 && fs.existsSync(target)) return resolve(null);

      resolve(`ffmpeg exited with code ${code}: ${errors.trim().slice(-400)}`);
    });
  });
}
