document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const targetTab = btn.dataset.tab;
    
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    
    document.querySelectorAll('.tab-content').forEach(content => {
      content.classList.remove('active');
    });
    document.getElementById(`${targetTab}-tab`).classList.add('active');
    
    switch(targetTab) {
      case 'my-jobs':
        if (window.loadJobs) window.loadJobs();
        break;
      case 'queue':
        if (window.loadQueueStatus) window.loadQueueStatus();
        break;
      case 'dashboard':
        if (window.loadDashboard) window.loadDashboard();
        break;
    }
  });
});

document.addEventListener('DOMContentLoaded', () => {
  console.log('Render Farm Frontend Initialized');
  
  if (auth && auth.isLoggedIn && auth.isLoggedIn()) {
    const currentUserEl = document.getElementById('current-user');
    if (currentUserEl) {
      currentUserEl.textContent = auth.getCurrentUser();
    }
    
    const settingsUsernameEl = document.getElementById('settings-username');
    if (settingsUsernameEl) {
      settingsUsernameEl.textContent = auth.getCurrentUser();
    }
    
    setTimeout(() => {
      if (window.loadJobs) window.loadJobs();
      if (window.loadQueueStatus) window.loadQueueStatus();
      if (window.loadDashboard) window.loadDashboard();
    }, 100); 
  }
});