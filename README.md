# 📁 File Sharing App

A simple real-time file sharing web application using Node.js, Express, Socket.IO, and WebRTC.

## 🚀 Features

- 📤 Upload and share files instantly
- 📡 Real-time peer-to-peer connections via WebRTC
- 🔒 Secure with support for `.env` configurations
- 🐳 Dockerized for easy deployment

---

## 📦 Prerequisites

- [Node.js](https://nodejs.org/) (for local development)
- [Docker](https://www.docker.com/) (for containerized usage)

---

## 🔧 Setup (Local)

```bash
# Clone the repository
git clone https://github.com/yourusername/file-sharing-app.git
cd file-sharing-app

# Install dependencies
npm install

# Start the server
npm start
```

By default, the app runs on `http://localhost:3000`.

## 🐳 Running with Docker

### 🏗️ Build the Docker image

```bash
docker build -t file-sharing-app .
```

### ▶️ Run the Docker container

```bash
docker run -p 3000:3000 file-sharing-app
```

If you'd like to use a different port, for example `4000`:

```bash
docker run -p 4000:3000 file-sharing-app
```

Or if your app is configured to listen on a dynamic port:

```bash
docker run -p 4000:4000 -e PORT=4000 file-sharing-app
```

## ⚙️ Environment Variables

Create a `.env` file in the project root for local development:

```env
PORT=3000
```

Docker reads `ENV` and `ARG` variables in the Dockerfile or via `-e` flag at runtime.

## 📁 Folder Structure

```bash
/uploads     # Final uploaded files
/temp        # Temporary chunks and storage
/public      # Static frontend files
server.js    # Main server logic
```

## 🧪 Testing the API

### List all uploaded files

```http
GET http://localhost:3000/api/files
```

*This route should return a JSON list of uploaded files (if implemented).*

## 🛠️ Build Tips

- Ensure `/uploads` and `/temp` directories are writable inside Docker

- Use `chown` in Dockerfile to allow non-root user to access upload dirs

- Add proper error handling if running behind a reverse proxy or on staging

## 📜 License

MIT License — [Jaimin Vadadoriya](https://github.com/JaiminVadadoriya/File-sharing/blob/main/LICENSE)
