let queueRefreshInterval = null;

async function loadQueueStatus() {
  try {
    if (!auth || !auth.getToken || !auth.getToken()) {
      console.log('Not logged in, skipping queue load');
      return;
    }
    
    const response = await fetch(`${API_URL}/jobs/queue/status`, {
      headers: { 'Authorization': `Bearer ${auth.getToken()}` }
    });
    
    if (response.status === 401) {
      console.log('Session expiredSession expired in loadQueueStatus - stopping refresh only');
      stopQueueRefresh();
      return;
    }
    
    const data = await response.json();
    
    if (!data) {
      console.error('Invalid response format');
      return;
    }

    document.getElementById('current-render').textContent = 
      data.currentJobId ? `Job ${data.currentJobId}` : 'None';
    document.getElementById('queue-length').textContent = data.queueLength || 0;
    
    const queueList = document.getElementById('queue-list');
    
    if (!data.queue || data.queue.length === 0) {
      queueList.innerHTML = '<p class="empty-state">Queue is empty</p>';
    } else {
      queueList.innerHTML = data.queue.map((item, index) => `
        <div class="queue-item">
          <div style="display: flex; align-items: center; gap: 1rem;">
            <div class="queue-position">${index + 1}</div>
            <div>
              <div style="font-weight: 500;">Job ${item.id}</div>
              <div style="color: var(--text-muted); font-size: 0.875rem;">
                ${item.filename || 'Unknown file'}
              </div>
            </div>
          </div>
        </div>
      `).join('');
    }
  } catch (error) {
    console.error('Error loading queue:', error);
  }
}

async function loadDashboard() {
  try {
    if (!auth || !auth.getToken || !auth.getToken()) {
      console.log('Not logged in, skipping dashboard load');
      return;
    }
    
    const response = await fetch(`${API_URL}/jobs`, {
      headers: { 'Authorization': `Bearer ${auth.getToken()}` }
    });
    
    if (response.status === 401) {
      console.log('Session expired in loadQueueStatus - stopping refresh only');
      return;
    }
    
    const data = await response.json();
    
    if (!data || !data.jobs) {
      console.error('Invalid response format');
      return;
    }
    
    const jobs = data.jobs;

    const totalJobs = jobs.length;
    const completed = jobs.filter(j => j.status === 'completed').length;
    const rendering = jobs.filter(j => j.status === 'rendering').length;
    const pending = jobs.filter(j => j.status === 'pending').length;
    const failed = jobs.filter(j => j.status === 'failed').length;
    
    const completedJobs = jobs.filter(j => j.status === 'completed' && j.startedAt && j.completedAt);
    let avgTime = '--';
    
    if (completedJobs.length > 0) {
      const totalTime = completedJobs.reduce((sum, job) => {
        const start = new Date(job.startedAt);
        const end = new Date(job.completedAt);
        return sum + (end - start);
      }, 0);
      
      const avgMs = totalTime / completedJobs.length;
      avgTime = (avgMs / 60000).toFixed(1);
    }
    
    document.getElementById('total-jobs').textContent = totalJobs;
    document.getElementById('completed-jobs').textContent = completed;
    document.getElementById('rendering-jobs').textContent = rendering;
    document.getElementById('pending-jobs').textContent = pending;
    document.getElementById('failed-jobs').textContent = failed;
    document.getElementById('avg-time').textContent = avgTime;
    
    const recentJobs = jobs
      .sort((a, b) => b.id - a.id)
      .slice(0, 10);
    
    const activityList = document.getElementById('recent-jobs');
    
    if (recentJobs.length === 0) {
      activityList.innerHTML = '<p class="empty-state">No activity yet</p>';
    } else {
      activityList.innerHTML = recentJobs.map(job => `
        <div class="activity-item">
          <div class="activity-info">
            <span class="activity-filename">${job.originalFilename || 'Untitled'}</span>
            <span class="activity-time">
              ${job.owner || 'Unknown'} • ${formatDate(job.createdAt)}
            </span>
          </div>
          <span class="status-badge status-${job.status}">${job.status.toUpperCase()}</span>
        </div>
      `).join('');
    }
    
  } catch (error) {
    console.error('Error loading dashboard:', error);
  }
}

function formatDate(dateString) {
  if (!dateString) return 'N/A';
  const date = new Date(dateString);
  const now = new Date();
  const diff = now - date;
  
  if (diff < 60000) return 'Just now';
  if (diff < 3600000) {
    const mins = Math.floor(diff / 60000);
    return `${mins} min ago`;
  }
  if (diff < 86400000) {
    const hours = Math.floor(diff / 3600000);
    return `${hours}h ago`;
  }
  return date.toLocaleDateString();
}

function startQueueRefresh() {
  if (queueRefreshInterval) return;
  
  queueRefreshInterval = setInterval(() => {
    if (!auth || !auth.isLoggedIn || !auth.isLoggedIn()) {
      stopQueueRefresh();
      return;
    }
    
    const queueTab = document.getElementById('queue-tab');
    if (queueTab && queueTab.classList.contains('active')) {
      loadQueueStatus();
    }
    
    const dashboardTab = document.getElementById('dashboard-tab');
    if (dashboardTab && dashboardTab.classList.contains('active')) {
      loadDashboard();
    }
  }, 3000); 
}

function stopQueueRefresh() {
  if (queueRefreshInterval) {
    clearInterval(queueRefreshInterval);
    queueRefreshInterval = null;
    console.log('Stopped queue auto-refresh');
  }
}

document.getElementById('refresh-queue-btn')?.addEventListener('click', loadQueueStatus);

if (auth && auth.isLoggedIn && auth.isLoggedIn()) {
  startQueueRefresh();
}

window.loadQueueStatus = loadQueueStatus;
window.loadDashboard = loadDashboard;
window.startQueueRefresh = startQueueRefresh;
window.stopQueueRefresh = stopQueueRefresh;