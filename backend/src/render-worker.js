import { execFile } from 'child_process';
import { findBlenderExecutable } from './utils/blender-check.js';

/**
 * Render a Blender job
 * @param {Object} config 
 * @param {string} config.filePath 
 * @param {string} config.outputPath 
 * @param {number} config.frameStart 
 * @param {number} config.frameEnd 
 * @param {Function} callback 
 */
export function renderJob(config, callback, proccessCallback) {  
  const blenderPath = findBlenderExecutable();
  
  if (!blenderPath) {
    return callback(new Error('Blender executable not found'));
  }

  const args = [
    '-b', config.filePath,
    '-o', config.outputPath,
    '-s', config.frameStart.toString(),
    '-e', config.frameEnd.toString(),
  ];

  if(config.renderEngine){
    args.push('-E', config.renderEngine);
  }

  args.push('-a');

  console.log('Starting Blender render');
  console.log('Blender:', blenderPath);
  console.log('File:', config.filePath);
  console.log('Output:', config.outputPath);
  console.log('Frames:', `${config.frameStart}-${config.frameEnd}`);
  console.log('Engine:', config.renderEngine || 'Default');

  const startTime = Date.now();

  const process = execFile(blenderPath, args, (err, stdout, stderr) => {
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    
    if (err) {
      console.error(`Render failed after ${duration}s:`, err.message);
      return callback(err);
    }
    
    console.log(`Render completed in ${duration}s`);
    
    if (stdout) console.log('Blender stdout:', stdout);
    if (stderr) console.warn('Blender stderr:', stderr);
    
    callback(null, { duration, stdout, stderr });
  });

  process.on('exit', (code) => {
    if (code !== 0) {
      console.warn(`Blender exited with code ${code}`);
    }
  });

  if (proccessCallback){
    proccessCallback(process);
  }
}