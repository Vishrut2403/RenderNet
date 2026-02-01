let jobsRefreshInterval = null;
let lastJobStatuses = new Map();

async function loadJobs() {
  try {
    if (!auth || auth.isLoggedIn() !== true) {
      return;
    }

    const token = auth.getToken();
    const currentUser = auth.getCurrentUser();

    if (!token || !currentUser) {
      return;
    }

    console.log('Loading jobs for user:', currentUser);

    const response = await fetch(`${API_URL}/jobs`, {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });

    if (response.status === 401) {
      console.log('Jobs unauthorized — stopping refresh only');
      stopJobsRefresh();
      return;
    }

    const data = await response.json();

    if (!data || !Array.isArray(data.jobs)) {
      console.error('Invalid jobs response:', data);
      return;
    }

    const userJobs = data.jobs.filter(job => job.owner === currentUser);

    displayJobs(userJobs);
    checkForCompletedJobs(userJobs);

  } catch (err) {
    console.error('Error loading jobs:', err);
  }
}

function displayJobs(jobs) {
  const jobsList = document.getElementById('jobs-list');
  if (!jobsList) return;

  if (jobs.length === 0) {
    jobsList.innerHTML =
      '<p class="empty-state">No jobs yet. Upload a .blend file to get started!</p>';
    return;
  }

  jobs.sort((a, b) => b.id - a.id);

  jobsList.innerHTML = jobs.map(job => `
    <div class="job-item">
      <div class="job-header">
        <div class="job-info">
          <h3>${job.originalFilename || 'Untitled'}</h3>
          <div class="job-meta">
            Job ID: ${job.id} • ${formatDate(job.createdAt)}
          </div>
        </div>
        <span class="status-badge status-${job.status}">
          ${job.status.toUpperCase()}
        </span>
      </div>

      <div class="job-details">
        <div class="detail-item">
          <span class="detail-label">Frames</span>
          <span class="detail-value">${job.frameStart}-${job.frameEnd}</span>
        </div>

        <div class="detail-item">
          <span class="detail-label">Engine</span>
          <span class="detail-value">${job.renderEngine || 'N/A'}</span>
        </div>

        ${job.status === 'pending' && job.queuePosition ? `
          <div class="detail-item">
            <span class="detail-label">Queue Position</span>
            <span class="detail-value">#${job.queuePosition}</span>
          </div>
        ` : ''}

        ${job.status === 'completed' && job.completedAt ? `
          <div class="detail-item">
            <span class="detail-label">Completed</span>
            <span class="detail-value">${formatDate(job.completedAt)}</span>
          </div>
        ` : ''}

        ${job.status === 'failed' && job.error ? `
          <div class="detail-item">
            <span class="detail-label">Error</span>
            <span class="detail-value error-text">${job.error}</span>
          </div>
        ` : ''}
      </div>

      <div class="job-actions">
        ${(job.status === 'pending' || job.status === 'rendering') ? `
          <button class="btn btn-danger" onclick="cancelJob(${job.id})">
            Cancel
          </button>
        ` : ''}

        ${job.status === 'completed' ? `
          <button class="btn btn-success" onclick="downloadJob(${job.id})">
            Download Renders
          </button>
        ` : ''}

        <button class="btn btn-secondary" onclick="refreshJob(${job.id})">
          Refresh
        </button>
      </div>
    </div>
  `).join('');
}

function checkForCompletedJobs(jobs) {
  jobs.forEach(job => {
    const lastStatus = lastJobStatuses.get(job.id);

    if (lastStatus === 'rendering' && job.status === 'completed') {
      showNotification(
        `Render completed! ${job.originalFilename}`,
        'success'
      );
      playNotificationSound();
    }

    lastJobStatuses.set(job.id, job.status);
  });
}

async function cancelJob(jobId) {
  if (!confirm('Cancel this job? All files will be deleted.')) return;

  try {
    const response = await fetch(`${API_URL}/jobs/${jobId}/cancel`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.getToken()}`
      }
    });

    if (response.ok) {
      showNotification('Job cancelled', 'info');
      loadJobs();
      window.loadQueueStatus?.();
    } else {
      const err = await response.json();
      showNotification(err.error || 'Cancel failed', 'error');
    }
  } catch (err) {
    showNotification('Cancel failed', 'error');
  }
}

async function downloadJob(jobId) {
  try {
    const token = auth.getToken();

    const filesRes = await fetch(`${API_URL}/download/${jobId}/files`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (!filesRes.ok) {
      const err = await filesRes.json();
      showNotification(err.error || 'Download failed', 'error');
      return;
    }

    const zipRes = await fetch(`${API_URL}/download/${jobId}/zip`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (!zipRes.ok) {
      showNotification('Download failed', 'error');
      return;
    }

    const blob = await zipRes.blob();
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `render_${jobId}.zip`;
    document.body.appendChild(a);
    a.click();

    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 100);

    showNotification('Download started', 'success');

  } catch (err) {
    showNotification('Download error', 'error');
  }
}

function refreshJob() {
  loadJobs();
}

function startJobsRefresh() {
  if (jobsRefreshInterval) return;

  jobsRefreshInterval = setInterval(() => {
    if (auth?.isLoggedIn() !== true) {
      stopJobsRefresh();
      return;
    }

    const tab = document.getElementById('my-jobs-tab');
    if (tab?.classList.contains('active')) {
      loadJobs();
    }
  }, 5000);
}

function stopJobsRefresh() {
  if (jobsRefreshInterval) {
    clearInterval(jobsRefreshInterval);
    jobsRefreshInterval = null;
  }
  lastJobStatuses.clear();
}

function formatDate(dateString) {
  if (!dateString) return 'N/A';
  const diff = Date.now() - new Date(dateString);
  if (diff < 60000) return 'Just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} min ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} hr ago`;
  return new Date(dateString).toLocaleString();
}

function playNotificationSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.frequency.value = 800;
    gain.gain.value = 0.2;

    osc.start();
    osc.stop(ctx.currentTime + 0.4);
  } catch {}
}

window.loadJobs = loadJobs;
window.startJobsRefresh = startJobsRefresh;
window.stopJobsRefresh = stopJobsRefresh;
window.cancelJob = cancelJob;
window.downloadJob = downloadJob;
window.refreshJob = refreshJob;