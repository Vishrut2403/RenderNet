const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const FormData = require('form-data');
const fetch = require('node-fetch');

const BLENDER_PATH = process.env.BLENDER_PATH || 'blender';
const API_URL = process.env.API_URL || 'http://localhost:5500';

class RenderWorker {
  constructor(workerId = 'local-worker') {
    this.workerId = workerId;
    this.currentJob = null;
  }

  async renderJob(job) {
    const { id, blendPath, outputDir, frameStart, frameEnd, renderEngine, username } = job;
    
    console.log(`\nWorker ${this.workerId}: Starting job ${id}`);
    console.log(`Blend file: ${blendPath}`);
    console.log(`Frames: ${frameStart} - ${frameEnd}`);
    console.log(`Engine: ${renderEngine}`);
    
    this.currentJob = job;

    fs.mkdirSync(outputDir, { recursive: true });
    
    let successfulFrames = 0;
    let failedFrames = 0;
    
    for (let frame = frameStart; frame <= frameEnd; frame++) {
      try {
        console.log(`\nRendering frame ${frame}/${frameEnd} (${Math.round(((frame - frameStart) / (frameEnd - frameStart + 1)) * 100)}%)`);
        
        const framePath = await this.renderSingleFrame(
          blendPath,
          frame,
          outputDir,
          renderEngine
        );
        
        console.log(`Frame ${frame} rendered: ${framePath}`);
        
        const uploaded = await this.uploadFrame(id, frame, framePath, username);
        
        if (uploaded) {
          console.log(`Frame ${frame} uploaded successfully`);
          successfulFrames++;
          
        } else {
          console.warn(`Frame ${frame} upload failed, keeping local copy`);
          successfulFrames++; 
        }

        await this.reportProgress(id, frame, frameEnd, username);
        
      } catch (error) {
        console.error(`Frame ${frame} failed:`, error.message);
        failedFrames++;
        
        await this.reportFrameFailure(id, frame, error.message, username);
      }
    }
    
    console.log(`\nJob ${id} completed!`);
    console.log(`Successful: ${successfulFrames} frames`);
    console.log(`Failed: ${failedFrames} frames`);

    await this.reportJobComplete(id, username, successfulFrames, failedFrames);
    
    this.currentJob = null;
    
    return {
      success: failedFrames === 0,
      successfulFrames,
      failedFrames
    };
  }

  renderSingleFrame(blendPath, frame, outputDir, renderEngine) {
    return new Promise((resolve, reject) => {
      const frameFilename = `frame_${frame.toString().padStart(4, '0')}`;
      const outputPath = path.join(outputDir, frameFilename);
      
      const args = [
        '-b', blendPath,           
        '-E', renderEngine,     
        '-f', frame.toString(),     
        '-o', outputPath + '#',       
        '--', '--cycles-device', 'CPU' 
      ];
      
      console.log(`   Running: ${BLENDER_PATH} ${args.join(' ')}`);
      
      const blender = spawn(BLENDER_PATH, args);
      
      let stderr = '';
      
      blender.stdout.on('data', (data) => {
      });
      
      blender.stderr.on('data', (data) => {
        stderr += data.toString();
      });
      
      blender.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`Blender exited with code ${code}: ${stderr}`));
          return;
        }
        
        const expectedFile = `${outputPath}${frame.toString().padStart(4, '0')}.png`;
        
        if (fs.existsSync(expectedFile)) {
          resolve(expectedFile);
        } else {
          reject(new Error(`Rendered frame not found: ${expectedFile}`));
        }
      });
      
      blender.on('error', (err) => {
        reject(new Error(`Failed to start Blender: ${err.message}`));
      });
    });
  }

  async uploadFrame(jobId, frameNumber, framePath, username) {
    try {
      const formData = new FormData();
      formData.append('frame', fs.createReadStream(framePath));
      formData.append('frameNumber', frameNumber.toString());
      formData.append('username', username);
      
      const response = await fetch(`${API_URL}/jobs/${jobId}/upload-frame`, {
        method: 'POST',
        body: formData,
        headers: formData.getHeaders()
      });
      
      if (!response.ok) {
        const error = await response.text();
        console.error(`Upload failed: ${error}`);
        return false;
      }
      
      return true;
      
    } catch (error) {
      console.error(`Upload error: ${error.message}`);
      return false;
    }
  }
  async reportProgress(jobId, currentFrame, totalFrames, username) {
    try {
      const progress = Math.round(((currentFrame - this.currentJob.frameStart + 1) / 
                                   (totalFrames - this.currentJob.frameStart + 1)) * 100);
      
      await fetch(`${API_URL}/jobs/${jobId}/progress`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          currentFrame,
          totalFrames,
          progress,
          username
        })
      });
    } catch (error) {
      console.error(`Failed to report progress: ${error.message}`);
    }
  }

  async reportFrameFailure(jobId, frameNumber, error, username) {
    try {
      await fetch(`${API_URL}/jobs/${jobId}/frame-failed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          frameNumber,
          error,
          username
        })
      });
    } catch (err) {
      console.error(`Failed to report frame failure: ${err.message}`);
    }
  }
  
  async reportJobComplete(jobId, username, successfulFrames, failedFrames) {
    try {
      await fetch(`${API_URL}/jobs/${jobId}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          successfulFrames,
          failedFrames,
          username
        })
      });
    } catch (error) {
      console.error(`Failed to report job completion: ${error.message}`);
    }
  }
}

module.exports = RenderWorker;