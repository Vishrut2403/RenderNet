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

  /**
   * Render frames for a job with incremental uploads
   */
  async renderJob(job) {
    const { id, blendPath, outputDir, frameStart, frameEnd, renderEngine, username } = job;
    
    console.log(`\n🎬 Worker ${this.workerId}: Starting job ${id}`);
    console.log(`📁 Blend file: ${blendPath}`);
    console.log(`🎞️  Frames: ${frameStart} - ${frameEnd}`);
    console.log(`⚙️  Engine: ${renderEngine}`);
    
    this.currentJob = job;
    
    // Ensure output directory exists
    fs.mkdirSync(outputDir, { recursive: true });
    
    let successfulFrames = 0;
    let failedFrames = 0;
    
    // Render frames one by one
    for (let frame = frameStart; frame <= frameEnd; frame++) {
      try {
        console.log(`\n🎬 Rendering frame ${frame}/${frameEnd} (${Math.round(((frame - frameStart) / (frameEnd - frameStart + 1)) * 100)}%)`);
        
        // Render single frame
        const framePath = await this.renderSingleFrame(
          blendPath,
          frame,
          outputDir,
          renderEngine
        );
        
        console.log(`✅ Frame ${frame} rendered: ${framePath}`);
        
        // Upload frame immediately
        const uploaded = await this.uploadFrame(id, frame, framePath, username);
        
        if (uploaded) {
          console.log(`📤 Frame ${frame} uploaded successfully`);
          successfulFrames++;
          
          // Delete local frame to save space (optional)
          // fs.unlinkSync(framePath);
        } else {
          console.warn(`⚠️  Frame ${frame} upload failed, keeping local copy`);
          successfulFrames++; // Still count as successful render
        }
        
        // Report progress
        await this.reportProgress(id, frame, frameEnd, username);
        
      } catch (error) {
        console.error(`❌ Frame ${frame} failed:`, error.message);
        failedFrames++;
        
        // Report failure
        await this.reportFrameFailure(id, frame, error.message, username);
      }
    }
    
    console.log(`\n🎉 Job ${id} completed!`);
    console.log(`✅ Successful: ${successfulFrames} frames`);
    console.log(`❌ Failed: ${failedFrames} frames`);
    
    // Report job completion
    await this.reportJobComplete(id, username, successfulFrames, failedFrames);
    
    this.currentJob = null;
    
    return {
      success: failedFrames === 0,
      successfulFrames,
      failedFrames
    };
  }

  /**
   * Render a single frame
   */
  renderSingleFrame(blendPath, frame, outputDir, renderEngine) {
    return new Promise((resolve, reject) => {
      // Output path for this specific frame
      const frameFilename = `frame_${frame.toString().padStart(4, '0')}`;
      const outputPath = path.join(outputDir, frameFilename);
      
      // Blender command
      const args = [
        '-b', blendPath,              // Background mode
        '-E', renderEngine,            // Render engine
        '-f', frame.toString(),        // Single frame
        '-o', outputPath + '#',        // Output with frame number placeholder
        '--', '--cycles-device', 'CPU' // Force CPU rendering (change to GPU if available)
      ];
      
      console.log(`   Running: ${BLENDER_PATH} ${args.join(' ')}`);
      
      const blender = spawn(BLENDER_PATH, args);
      
      let stderr = '';
      
      blender.stdout.on('data', (data) => {
        // Optionally log Blender output
        // process.stdout.write(data.toString());
      });
      
      blender.stderr.on('data', (data) => {
        stderr += data.toString();
      });
      
      blender.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`Blender exited with code ${code}: ${stderr}`));
          return;
        }
        
        // Find the rendered file (Blender adds frame number)
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

  /**
   * Upload frame to server
   */
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

  /**
   * Report progress to server
   */
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
      // Non-critical, just log
      console.error(`Failed to report progress: ${error.message}`);
    }
  }

  /**
   * Report frame failure
   */
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

  /**
   * Report job completion
   */
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