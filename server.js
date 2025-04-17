const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const wrtc = require("wrtc");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");
const dotenv = require("dotenv");

const { webcrypto } = require("crypto");
const { subtle } = webcrypto;

dotenv.config({ path: ".env" });

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
  maxHttpBufferSize: 1e8, // 100MB for large messages
});

// Configuration
const UPLOAD_DIR = path.join(__dirname, "uploads");
const TEMP_DIR = path.join(__dirname, "temp");
const MAX_WRITE_QUEUE = 512 * 1024 * 1024; // 512MB
const CHUNK_SIZE = 64 * 1024; // 64KB
const CONNECTION_TIMEOUT = 120000; // Increase to 2 minutes from 30 seconds
const FILE_CLEANUP_INTERVAL = 3600000; // 1 hour
const MAX_INACTIVE_FILE_AGE = 86400000; // 24 hours
const SYSTEM_FREE_SPACE_MINIMUM = 1024 * 1024 * 1024; // 1GB

// Ensure directories exist with appropriate permissions
[UPLOAD_DIR, TEMP_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      console.log(`Created directory: ${dir}`);
    } catch (err) {
      console.error(`Failed to create directory ${dir}:`, err);
      process.exit(1); // Exit if we can't create critical directories
    }
  }

  // Check write permissions
  try {
    const testFile = path.join(dir, ".write-test");
    fs.writeFileSync(testFile, "test");
    fs.unlinkSync(testFile);
  } catch (err) {
    console.error(`No write permission for directory ${dir}:`, err);
    process.exit(1); // Exit if we don't have write permissions
  }
});

// Initialize metrics
const metrics = {
  activeConnections: 0,
  totalUploads: 0,
  successfulUploads: 0,
  failedUploads: 0,
  totalBytesTransferred: 0,
};

// Active transfers map
const activeTransfers = new Map();

// Main IO connection handler
io.on("connection", (socket) => {
  let transferState = null;

  metrics.activeConnections++;
  console.log(
    `Client connected: ${socket.id} (Active: ${metrics.activeConnections})`
  );

  // Set connection timeout
  const connectionTimeout = setTimeout(() => {
    if (!transferState || !transferState.started) {
      socket.disconnect(true);
    }
  }, CONNECTION_TIMEOUT);

  // Handle metadata
  socket.on("metadata", async (data) => {
    try {
      // Clear the timeout since we're starting a transfer
      clearTimeout(connectionTimeout);

      // Validate encryption key
      if (!data.key || data.key.length !== 32) {
        throw new Error("Invalid encryption key length");
      }

      // Convert key array to proper Buffer
      const keyMaterial = Buffer.from(new Uint8Array(data.key));

      // Sanitize filename
      const safeFileName = sanitizeFileName(data.fileName);
      const sessionId = data.sessionId || `session_${Date.now()}`;

      // Check for available disk space
      if (!checkDiskSpace()) {
        socket.emit("error", {
          message: "Not enough disk space available on server",
        });
        socket.disconnect(true);
        return;
      }

      // Enhanced transfer state initialization
      transferState = {
        id: sessionId,
        encryptionKey: keyMaterial,
        fileName: safeFileName,
        originalName: data.fileName,
        fileSize: data.fileSize,
        fileType: data.fileType,
        tempFilePath: path.join(TEMP_DIR, `${sessionId}_${safeFileName}`),
        finalFilePath: path.join(UPLOAD_DIR, `${Date.now()}_${safeFileName}`),
        fileStream: null,
        bytesReceived: 0,
        lastBytesReceived: 0, // Track for detecting stalled transfers
        writeQueue: 0,
        chunks: new Map(), // Store out-of-order chunks
        nextExpectedOffset: 0,
        lastActivityTime: Date.now(),
        lastProgressLog: Date.now(),
        lastBytesLogged: 0,
        started: true,
        completed: false,
        verified: false,
        errors: [], // Track errors
        encryptionMethod: "AES-GCM-256",
      };

      // Register the transfer
      activeTransfers.set(sessionId, transferState);

      console.log(
        `Metadata received for: ${transferState.fileName} (${formatBytes(
          transferState.fileSize
        )})`
      );
      console.log(`Session ID: ${sessionId}`);

      // Start the transfer timeout monitor
      monitorTransferTimeout(sessionId);
    } catch (err) {
      console.error("Metadata error:", err.message);
      socket.emit("error", { message: "Invalid metadata" });
      socket.disconnect(true);
    }
  });

  // Handle WebRTC offer
  socket.on("offer", async (data) => {
    try {
      const sessionId = data.sessionId;
      const offer = data.offer;

      if (!sessionId || !activeTransfers.has(sessionId)) {
        throw new Error("Invalid or missing session ID");
      }

      const state = activeTransfers.get(sessionId);
      state.lastActivityTime = Date.now();

      // Create peer connection
      const peerConnection = new wrtc.RTCPeerConnection({
        iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:stun1.l.google.com:19302" },
        ],
      });

      state.peerConnection = peerConnection;

      // Handle data channel
      peerConnection.ondatachannel = ({ channel }) => {
        state.dataChannel = channel;
        setupDataChannel(channel, state, socket);
      };

      // Handle ICE candidates
      peerConnection.onicecandidate = ({ candidate }) => {
        if (candidate) {
          socket.emit("ice-candidate", candidate);
        }
      };

      // Connection state changes
      peerConnection.onconnectionstatechange = () => {
        if (
          peerConnection.connectionState === "disconnected" ||
          peerConnection.connectionState === "failed" ||
          peerConnection.connectionState === "closed"
        ) {
          handleDisconnect(state, socket);
        }
      };

      // Process the offer
      await peerConnection.setRemoteDescription(
        new wrtc.RTCSessionDescription(offer)
      );
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);

      socket.emit("answer", answer);
    } catch (err) {
      console.error("Offer handling error:", err.message);
      socket.emit("error", { message: "Failed to process offer" });
    }
  });

  // Handle ICE candidates
  socket.on("ice-candidate", async (data) => {
    try {
      const sessionId = data.sessionId;
      const candidate = data.candidate;

      if (!sessionId || !activeTransfers.has(sessionId)) {
        return;
      }

      const state = activeTransfers.get(sessionId);

      if (state.peerConnection && state.peerConnection.remoteDescription) {
        await state.peerConnection.addIceCandidate(
          new wrtc.RTCIceCandidate(candidate)
        );
        state.lastActivityTime = Date.now();
      }
    } catch (err) {
      console.error("ICE candidate error:", err.message);
    }
  });

  // Handle server capabilities
  socket.on("capabilities", (serverCapabilities) => {
    // Negotiate common capabilities
    const commonEncryption = findCommonCapability(
      ["AES-GCM-256"],
      serverCapabilities.encryption || []
    );

    if (!commonEncryption) {
      handleError(
        "No compatible encryption method",
        new Error("Incompatible server")
      );
      return;
    }

    // Configure other settings based on negotiation
    const maxChunkSize = Math.min(
      serverCapabilities.maxChunkSize || CHUNK_SIZE,
      CHUNK_SIZE
    );
    const maxFileSize = serverCapabilities.maxFileSize || Infinity;

    console.log(`Negotiated encryption: ${commonEncryption}`);
    console.log(`Max chunk size: ${maxChunkSize}`);
    console.log(`Max file size: ${maxFileSize}`);

    // Store negotiated settings in the transfer state
    transferState = {
      ...transferState,
      encryptionMethod: commonEncryption,
      maxChunkSize,
      maxFileSize,
    };

    // Notify client of successful negotiation
    socket.emit("negotiation-success", {
      encryption: commonEncryption,
      maxChunkSize,
      maxFileSize,
    });
  });

  function findCommonCapability(clientCaps, serverCaps) {
    return clientCaps.find((cap) => serverCaps.includes(cap));
  }

  // Handle disconnection
  socket.on("disconnect", () => {
    metrics.activeConnections--;
    console.log(
      `Client disconnected: ${socket.id} (Active: ${metrics.activeConnections})`
    );

    clearTimeout(connectionTimeout);

    if (transferState) {
      handleDisconnect(transferState, socket);
    }
  });
});

// Setup data channel handlers
function setupDataChannel(channel, state, socket) {
  channel.binaryType = "arraybuffer";

  // Initialize file stream if needed
  if (!state.fileStream) {
    try {
      state.fileStream = fs.createWriteStream(state.tempFilePath);
      console.log(`Created write stream to: ${state.tempFilePath}`);
    } catch (err) {
      console.error(`Failed to create file stream: ${err.message}`);
      socket.emit("error", { message: "Failed to initialize file stream" });
      return;
    }
  }

  // Handle messages
  channel.onmessage = async ({ data }) => {
    state.lastActivityTime = Date.now();

    try {
      if (typeof data === "string") {
        // Process JSON control messages
        try {
          const message = JSON.parse(data);

          if (message.type === "complete") {
            finalizeTransfer(state, socket);
            return;
          }

          if (message.offset !== undefined) {
            // This is chunk metadata, prepare to receive binary data
            state.currentChunkOffset = message.offset;
            state.currentChunkIsLast = message.isLast;
            return;
          }
        } catch (e) {
          // Not JSON or other error
          console.warn("Invalid message format:", data);
        }
      } else {
        // Process binary data chunk
        if (state.currentChunkOffset !== undefined) {
          processChunk(state, socket, data, state.currentChunkOffset);
          // Log progress
          logTransferProgress(state);
          state.currentChunkOffset = undefined;
        }
      }
    } catch (err) {
      console.error("Processing error:", err.message);
      socket.emit("error", { message: "Failed to process data" });
    }
  };

  // Flow control
  channel.onbufferedamountlow = () => {
    if (state.dataChannel && state.dataChannel.readyState === "open") {
      state.dataChannel.send("resume");
    }
  };
}

// Process a chunk of file data
async function processChunk(state, socket, buffer, offset) {
  try {
    // Extract IV, encrypted data
    const dataView = new Uint8Array(buffer);

    // First 12 bytes are the IV
    const iv = dataView.subarray(0, 12);

    // Rest is the encrypted data (including auth tag)
    const encryptedData = dataView.subarray(12);

    // Decrypt the chunk
    const decrypted = await decryptChunk(
      encryptedData,
      state.encryptionKey,
      iv
    );

    // Log progress for large files
    if (
      state.fileSize > 50 * 1024 * 1024 &&
      offset % (10 * 1024 * 1024) < CHUNK_SIZE
    ) {
      console.log(
        `Progress: ${Math.round((offset / state.fileSize) * 100)}% of ${
          state.fileName
        }`
      );
    }

    // Check if the transfer has been completed
    if (state.completed) {
      console.warn(`Received chunk after transfer was completed at offset ${offset}`);
      return;
    }

    // Either write directly or store for later
    if (offset === state.nextExpectedOffset) {
      // We got the chunk we were expecting, write it directly
      await writeChunk(state, decrypted);
      state.nextExpectedOffset += decrypted.length;

      // Check if we have subsequent chunks stored
      let nextOffset = state.nextExpectedOffset;
      while (state.chunks.has(nextOffset)) {
        const nextChunk = state.chunks.get(nextOffset);
        state.chunks.delete(nextOffset);

        await writeChunk(state, nextChunk);
        nextOffset += nextChunk.length;
        state.nextExpectedOffset = nextOffset;
      }

      // Send acknowledgment back to client periodically
      if (offset % (5 * 1024 * 1024) < CHUNK_SIZE && state.dataChannel) {
        state.dataChannel.send(
          JSON.stringify({
            type: "ack",
            offset: state.nextExpectedOffset,
          })
        );
      }
    } else if (offset > state.nextExpectedOffset) {
      // Store this chunk for later
      state.chunks.set(offset, decrypted);
    }

    // Update last activity time
    state.lastActivityTime = Date.now();

    // Report progress back to client
    reportProgress(state, socket);
    
    // Check if we've received all data and complete the transfer
    if (state.bytesReceived === state.fileSize && !state.completed) {
      finalizeTransfer(state, socket);
    }
  } catch (err) {
    console.error(`Chunk processing error at offset ${offset}:`, err.message);
    socket.emit("chunk-error", { offset, message: "Failed to process chunk" });

    // Allow retrying this chunk
    if (state.dataChannel && state.dataChannel.readyState === "open") {
      state.dataChannel.send(
        JSON.stringify({
          type: "retry-request",
          offset: offset,
        })
      );
    }
  }
}

// Decrypt a chunk
async function decryptChunk(encryptedData, keyMaterial, iv) {
  try {
    // Import the raw key material into a CryptoKey
    const key = await subtle.importKey(
      "raw",
      keyMaterial,
      {
        name: "AES-GCM",
        length: 256,
      },
      false, // non-extractable for security
      ["decrypt"]
    );

    // Use the Web Crypto API for decryption
    const decryptedData = await subtle.decrypt(
      {
        name: "AES-GCM",
        iv: iv,
        tagLength: 128, // Must match client-side setting
      },
      key,
      encryptedData
    );

    return Buffer.from(decryptedData);
  } catch (err) {
    // More detailed error information
    console.error("Decryption error details:", {
      ivLength: iv ? iv.length : "undefined",
      encryptedDataLength: encryptedData ? encryptedData.length : "undefined",
      error: err.message,
    });
    throw new Error(`Decryption failed: ${err.message}`);
  }
}

// Write chunk to file with backpressure handling
async function writeChunk(state, data) {
  return new Promise((resolve, reject) => {
    // Check if the stream is still writable
    if (!state.fileStream || state.fileStream.closed || state.fileStream.destroyed || state.completed) {
      console.warn("Attempt to write to closed or completed stream");
      return resolve();
    }

    // Update metrics
    state.bytesReceived += data.length;
    state.writeQueue += data.length;
    metrics.totalBytesTransferred += data.length;

    // Log progress for large files
    const fileSize = state.fileSize;
    if (fileSize > 50 * 1024 * 1024) {
      // For files larger than 50MB, log progress periodically
      logTransferProgress(state);
    }

    // Check if we need to pause data flow
    if (state.writeQueue > MAX_WRITE_QUEUE && state.dataChannel) {
      state.dataChannel.send("pause");
    }

    const canContinue = state.fileStream.write(data, (err) => {
      if (err) {
        console.error(`File write error:`, err);
        reject(err);
        return;
      }

      state.writeQueue -= data.length;
      state.lastActivityTime = Date.now(); // Update activity timestamp on successful write

      // Resume data flow if needed
      if (state.writeQueue < MAX_WRITE_QUEUE / 2 && state.dataChannel) {
        state.dataChannel.send("resume");
      }

      resolve();
    });

    if (!canContinue) {
      // Wait for drain event
      state.fileStream.once("drain", () => {
        if (state.dataChannel) {
          state.dataChannel.send("resume");
        }
        // We don't resolve here as the write callback handles that
      });
    }
  });
}

// Report progress back to client
function reportProgress(state, socket) {
  // Only send progress updates periodically to avoid flooding
  const now = Date.now();
  if (!state.lastProgressUpdate || now - state.lastProgressUpdate > 1000) {
    const progress = Math.floor((state.bytesReceived / state.fileSize) * 100);

    if (state.dataChannel && state.dataChannel.readyState === "open") {
      state.dataChannel.send(`progress:${progress}`);
    }

    state.lastProgressUpdate = now;
  }
}

// Add to server.js
async function verifyFileIntegrity(state) {
  try {
    // Calculate SHA-256 hash of the file
    const fileBuffer = fs.readFileSync(state.tempFilePath);
    const hash = crypto.createHash("sha256").update(fileBuffer).digest("hex");

    // Store the hash or compare it with expected hash
    console.log(`File hash for ${state.fileName}: ${hash}`);
    return hash;
  } catch (err) {
    console.error(`Integrity verification failed: ${err.message}`);
    return null;
  }
}

// Finalize the transfer
function finalizeTransfer(state, socket) {
  if (!state.fileStream || state.completed) return;

  console.log(`Finalizing transfer for: ${state.fileName}`);
  
  // Only finalize when all expected data has been received
  if (state.bytesReceived !== state.fileSize) {
    console.warn(
      `Size mismatch during finalization: Expected ${state.fileSize} bytes but received ${state.bytesReceived} bytes`
    );
    
    // Don't end the stream yet, wait for more data
    socket.emit("transfer-status", {
      status: "completed",
      fileId: state.id,
      fileName: state.fileName,
      fileSize: state.bytesReceived,
      fileHash: fileHash,
    });

    state.dataChannel.send(
      JSON.stringify({
        type: "status",
        status: "completed",
        fileHash: fileHash,
      })
    );
    
    // Set a timeout to check again later
    setTimeout(() => {
      if (!state.completed && state.bytesReceived !== state.fileSize) {
        finalizeTransfer(state, socket);
      }
    }, 5000);  // Check again in 5 seconds
    
    return;
  }

  // Now we can end the stream
  state.fileStream.end(async () => {
    state.completed = true;
    
    // Verify integrity
    const fileHash = await verifyFileIntegrity(state);
    
    if (!fileHash) {
      socket.emit("transfer-status", {
        status: "failed",
        fileId: state.id,
        error: "File integrity check failed",
      });
      return;
    }

    // Move from temp to final location
    try {
      fs.renameSync(state.tempFilePath, state.finalFilePath);
      state.verified = true;
      metrics.successfulUploads++;

      console.log(`Successfully saved: ${state.fileName}`);
      console.log(`File size: ${formatBytes(state.bytesReceived)}`);
      console.log(`File hash: ${fileHash}`);

      // Notify client of successful transfer
      socket.emit("transfer-status", {
        status: "completed",
        fileId: state.id,
        fileName: state.fileName,
        fileSize: state.bytesReceived,
        fileHash: fileHash,
      });

      if (state.dataChannel && state.dataChannel.readyState === "open") {
        state.dataChannel.send(
          JSON.stringify({
            type: "status",
            status: "completed",
            fileHash: fileHash,
          })
        );
      }
    } catch (err) {
      metrics.failedUploads++;
      console.error(`Failed to finalize file: ${err.message}`);

      socket.emit("transfer-status", {
        status: "failed",
        fileId: state.id,
        error: "Failed to save file",
      });
    }

    // Clean up
    cleanupTransfer(state);
  });
}

// Handle disconnection
function handleDisconnect(state, socket) {
  if (state.completed) return;

  console.log(`Transfer interrupted for: ${state.fileName}`);

  if (state.bytesReceived === state.fileSize) {
    // The transfer might actually be complete
    finalizeTransfer(state, socket);
  } else {
    // Mark as failed if not complete
    metrics.failedUploads++;

    // Keep the temp file for potential resumption
    socket.emit("transfer-status", {
      status: "interrupted",
      fileId: state.id,
      bytesReceived: state.bytesReceived,
    });
  }
}

// Clean up transfer resources
function cleanupTransfer(state) {
  if (state.peerConnection) {
    state.peerConnection.close();
  }

  if (state.fileStream && !state.fileStream.closed) {
    state.fileStream.end();
  }

  // Keep the transfer state for a while in case of resumption
  setTimeout(() => {
    activeTransfers.delete(state.id);
  }, 60000); // Keep for 1 minute
}

// Log transfer progress
function logTransferProgress(state) {
  const now = Date.now();
  if (!state.lastProgressLog || now - state.lastProgressLog > 10000) {
    // Log every 10 seconds
    const progress = Math.floor((state.bytesReceived / state.fileSize) * 100);
    const speed = state.lastProgressLog
      ? (state.bytesReceived - state.lastBytesLogged) /
        ((now - state.lastProgressLog) / 1000)
      : 0;

    console.log(
      `Transfer progress: ${
        state.fileName
      } - ${progress}% complete (${formatBytes(
        state.bytesReceived
      )}/${formatBytes(state.fileSize)}) at ${formatBytes(speed)}/s`
    );

    state.lastProgressLog = now;
    state.lastBytesLogged = state.bytesReceived;
  }
}

// Monitor transfer timeout
function monitorTransferTimeout(sessionId) {
  const CHECK_INTERVAL = 15000; // 15 seconds

  const checkActivity = () => {
    if (!activeTransfers.has(sessionId)) return;

    const state = activeTransfers.get(sessionId);
    const now = Date.now();

    // Consider bytes received when determining activity
    if (
      now - state.lastActivityTime > CONNECTION_TIMEOUT &&
      state.bytesReceived === state.lastBytesReceived
    ) {
      console.log(`Transfer timed out: ${state.fileName}`);

      if (!state.completed) {
        metrics.failedUploads++;
      }

      cleanupTransfer(state);
      return;
    }

    // Track last bytes to detect stalled transfers
    state.lastBytesReceived = state.bytesReceived;

    // Schedule next check
    setTimeout(checkActivity, CHECK_INTERVAL);
  };

  setTimeout(checkActivity, CHECK_INTERVAL);
}

// Check available disk space
function checkDiskSpace() {
  try {
    const stats = fs.statfsSync(UPLOAD_DIR);
    const freeSpace = stats.bfree * stats.bsize;

    return freeSpace > SYSTEM_FREE_SPACE_MINIMUM;
  } catch (err) {
    console.error("Error checking disk space:", err);
    return false;
  }
}

// Clean up old temporary files
function cleanupTempFiles() {
  try {
    const now = Date.now();
    const files = fs.readdirSync(TEMP_DIR);

    files.forEach((file) => {
      const filePath = path.join(TEMP_DIR, file);
      const stats = fs.statSync(filePath);

      if (now - stats.mtime.getTime() > MAX_INACTIVE_FILE_AGE) {
        fs.unlinkSync(filePath);
        console.log(`Removed old temp file: ${file}`);
      }
    });
  } catch (err) {
    console.error("Error cleaning up temp files:", err);
  }
}

// Helper: Sanitize file name
function sanitizeFileName(fileName) {
  return fileName
    .replace(/[^a-zA-Z0-9_\-\.]/g, "_")
    .replace(/\.{2,}/g, ".")
    .slice(0, 255);
}

// Helper: Format bytes to human readable
function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  if (bytes === 0) return "0B";
  const exp = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / 1024 ** exp).toFixed(2)} ${units[exp]}`;
}

// Set up periodic cleanup tasks
setInterval(cleanupTempFiles, FILE_CLEANUP_INTERVAL);

// Set up API routes for system status
app.get("/api/status", (req, res) => {
  let diskInfo;
  try {
    const stats = fs.statfsSync(UPLOAD_DIR);
    diskInfo = {
      total: stats.blocks * stats.bsize,
      free: stats.bfree * stats.bsize,
      available: stats.bavail * stats.bsize,
    };
  } catch (err) {
    diskInfo = { error: err.message };
  }

  const status = {
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    disk: diskInfo,
    metrics: metrics,
    activeTransfers: activeTransfers.size,
  };

  res.json(status);
});

// List available files
app.get("/api/files", (req, res) => {
  try {
    const files = fs.readdirSync(UPLOAD_DIR)
      .filter(file => !file.startsWith('.')) // Skip hidden files
      .map(fileName => {
        const filePath = path.join(UPLOAD_DIR, fileName);
        const stats = fs.statSync(filePath);
        
        // Extract original name if available (from timestamp_originalname format)
        let displayName = fileName;
        const nameParts = fileName.split('_');
        if (nameParts.length > 1 && !isNaN(nameParts[0])) {
          // Remove timestamp prefix
          displayName = fileName.substring(fileName.indexOf('_') + 1);
        }
        
        return {
          id: Buffer.from(fileName).toString('base64url'),
          name: displayName,
          originalName: displayName,
          size: stats.size,
          created: stats.birthtime,
          path: fileName
        };
      })
      .sort((a, b) => b.created - a.created); // Sort by newest first
      
    res.json({ files });
  } catch (err) {
    console.error("Error listing files:", err);
    res.status(500).json({ error: "Failed to list files" });
  }
});

// Download a file
app.get("/api/download/:fileId", (req, res) => {
  try {
    const fileId = req.params.fileId;
    const fileName = Buffer.from(fileId, 'base64url').toString();
    const filePath = path.join(UPLOAD_DIR, fileName);
    
    // Verify file exists
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "File not found" });
    }
    
    // Determine content type (default to octet-stream)
    const fileStats = fs.statSync(filePath);
    
    // Extract original name if available
    let displayName = fileName;
    const nameParts = fileName.split('_');
    if (nameParts.length > 1 && !isNaN(nameParts[0])) {
      // Remove timestamp prefix
      displayName = fileName.substring(fileName.indexOf('_') + 1);
    }
    
    // Set content disposition and type
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(displayName)}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', fileStats.size);
    
    // Stream the file
    const fileStream = fs.createReadStream(filePath);
    fileStream.pipe(res);
    
    // Log the download
    console.log(`File download started: ${displayName} (${formatBytes(fileStats.size)})`);
  } catch (err) {
    console.error("Download error:", err);
    res.status(500).json({ error: "Failed to download file" });
  }
});

// Delete a file
app.delete("/api/files/:fileId", (req, res) => {
  try {
    const fileId = req.params.fileId;
    const fileName = Buffer.from(fileId, 'base64url').toString();
    const filePath = path.join(UPLOAD_DIR, fileName);
    
    // Verify file exists
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "File not found" });
    }
    
    // Delete the file
    fs.unlinkSync(filePath);
    console.log(`File deleted: ${fileName}`);
    
    res.json({ success: true });
  } catch (err) {
    console.error("Delete error:", err);
    res.status(500).json({ error: "Failed to delete file" });
  }
});

// Serve static files (like index.html)
app.use(express.static(path.join(__dirname, "public")));

// Start server
server.listen(process.env.PORT || 8000, () => {
  console.log("Server running on http://localhost:"+ (process.env.PORT || 8000));
  console.log(`Upload directory: ${UPLOAD_DIR}`);
  console.log(`Temporary directory: ${TEMP_DIR}`);
});
