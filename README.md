# RenderNet

A full-stack web application for distributed Blender rendering with user authentication and queued job execution.

---

## Overview

RenderNet is a full-stack project demonstrating backend system design, job scheduling, and process automation using Blender's CLI. The application allows authenticated users to submit rendering jobs, manages them through a queue-based architecture, and delivers rendered outputs through a web interface.



---

## Key Features

- Upload and render `.blend` files remotely
- User authentication using JWT
- Centralized job queue with status tracking
- Download rendered frames as ZIP archives
- Admin-level access for user and job management
- Automatic cleanup of uploaded and rendered files (48-hour retention)

---

## Tech Stack

### Backend

- Node.js
- Express.js
- JWT-based authentication
- Multer for file uploads
- Blender CLI for rendering
- Background worker for job execution

### Frontend

- Vanilla JavaScript (no framework)
- HTML + CSS (dark theme)
- REST API integration

---

## Installation

### Prerequisites

- Node.js v16 or later
- Blender installed and accessible via system PATH
- npm or yarn

### Setup Instructions

1. **Clone the repository**

   ```bash
   git clone https://github.com/Vishrut2403/RenderNet.git
   cd RenderNet
   ```

2. **Install backend dependencies**

   ```bash
   cd backend
   npm install
   ```

3. **(Optional) Install frontend dependencies**

   ```bash
   cd ../frontend
   npm install
   ```

4. **Environment configuration**

   Create a `.env` file inside the `backend` directory:

   ```env
   PORT=5500
   JWT_SECRET=your-secret-key
   ```

5. **Start the backend server**

   ```bash
   cd backend
   npm start
   ```

6. **Serve the frontend**

   You may open `frontend/index.html` directly in a browser, or serve it locally:

   ```bash
   cd frontend
   npx http-server -p 8080
   ```

---

## Usage

1. Create a user account
2. Log in to obtain an authentication token
3. Upload a `.blend` file and specify the frame range
4. Monitor job status via the dashboard
5. Download completed renders as a ZIP file

---

## Feature Status

### Implemented

- Blender CLI–based render execution
- Queue-based job scheduling
- JWT authentication and role-based access
- Background worker for render jobs
- GPU-based rendering configuration
- Automatic cleanup of stale files

### Work in Progress

- Improved job progress tracking
- Multi-worker scalability support

### Planned

- Distributed rendering across multiple nodes
- WebSocket-based real-time job updates

---



## Contributing

This project was developed as an individual portfolio project. Feedback and suggestions are welcome.

