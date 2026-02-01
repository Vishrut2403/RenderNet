document.getElementById('upload-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const fileInput = document.getElementById('blend-file');
  const frameStart = document.getElementById('frame-start').value;
  const frameEnd = document.getElementById('frame-end').value;
  const renderEngine = document.getElementById('render-engine').value;
  
  const file = fileInput.files[0];
  if (!file) {
    showNotification('Please select a .blend file', 'error');
    return;
  }
  
  if (parseInt(frameEnd) < parseInt(frameStart)) {
    showNotification('End frame must be greater than start frame', 'error');
    return;
  }
  
  const uploadBtn = document.getElementById('upload-btn');
  const progressDiv = document.getElementById('upload-progress');
  const progressBar = document.getElementById('upload-progress-bar');
  const statusText = document.getElementById('upload-status');
  
  uploadBtn.disabled = true;
  progressDiv.style.display = 'block';
  
  try {
    const formData = new FormData();
    formData.append('blend', file);
    formData.append('frameStart', frameStart);
    formData.append('frameEnd', frameEnd);
    formData.append('renderEngine', renderEngine);
    formData.append('username', auth.currentUser);

    console.log('Sending:', {
    filename: file.name,
    frameStart,
    frameEnd,
    renderEngine,
    username: auth.currentUser
    });
    
    const xhr = new XMLHttpRequest();
    
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        const percent = (e.loaded / e.total) * 100;
        progressBar.style.width = percent + '%';
        statusText.textContent = `Uploading... ${Math.round(percent)}%`;
      }
    });
    
    xhr.addEventListener('load', () => {
      if (xhr.status === 200) {
        const response = JSON.parse(xhr.responseText);
        
        showNotification(`Job ${response.jobId} added to queue!`, 'success');
        
        document.getElementById('upload-form').reset();
        progressDiv.style.display = 'none';
        uploadBtn.disabled = false;
        
        if (window.loadJobs) window.loadJobs();
        if (window.loadQueueStatus) window.loadQueueStatus();

        showNotification(`Job ${response.jobId} added to queue!`, 'success');

        document.getElementById('upload-form').reset();
        progressDiv.style.display = 'none';
        uploadBtn.disabled = false;

        if (window.loadJobs) {
        setTimeout(() => window.loadJobs(), 500);
      }
        
      } else {
        const error = JSON.parse(xhr.responseText);
        showNotification(`Upload failed: ${error.error}`, 'error');
        uploadBtn.disabled = false;
        progressDiv.style.display = 'none';
      }
    });
    
    xhr.addEventListener('error', () => {
      showNotification('Upload failed. Check your connection.', 'error');
      uploadBtn.disabled = false;
      progressDiv.style.display = 'none';
    });
    
    xhr.open('POST', `${API_URL}/upload`);
    xhr.setRequestHeader('Authorization', `Bearer ${auth.getToken()}`);
    xhr.send(formData);
    
  } catch (error) {
    console.error('Upload error:', error);
    showNotification('Upload failed: ' + error.message, 'error');
    uploadBtn.disabled = false;
    progressDiv.style.display = 'none';
  }
});

function showNotification(message, type = 'info') {
  const banner = document.getElementById('notification-banner');
  banner.textContent = message;
  banner.className = `notification-banner ${type} show`;
  
  setTimeout(() => {
    banner.classList.remove('show');
  }, 5000);
}