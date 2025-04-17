// File: public/main.js
// Configuration
const CHUNK_SIZE = 64 * 1024; // 64KB chunks
const MAX_BUFFER = 1 * 1024 * 1024; // 1MB buffer limit
const RECONNECT_DELAY = 3000; // 3 seconds
const MAX_RETRIES = 5;

// State variables
let socket;
let peerConnection = null;
let dataChannel = null;
let encryptionKey = null;
let fileQueue = [];
let currentFile = null;
let currentFileReader = null;
let currentFileOffset = 0;
let isChannelOpen = false;
let isSending = false;
let isPaused = false;
let retryCount = 0;
let transferStartTime = 0;
let transferSessionId = null;
let lastProgressUpdate = 0;
let reconnectTimeout = null;

// UI Elements
const uploadBtn = document.getElementById("uploadBtn");
const fileInput = document.getElementById("fileInput");
const dropZone = document.getElementById("dropZone");
const progressBar = document.getElementById("progressBar");
const status = document.getElementById("status");
const fileList = document.getElementById("fileList");
const connectionStatus = document.getElementById("connectionStatus");

// Initialize the application
function initialize() {
  setupEventListeners();
  connectSocket();
}

// Set up event listeners
function setupEventListeners() {
  // Upload button click
  uploadBtn.addEventListener("click", () => fileInput.click());

  // File selection
  fileInput.addEventListener("change", handleFileSelection);

  // Drag and drop
  dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropZone.classList.add("active");
  });

  dropZone.addEventListener("dragleave", () => {
    dropZone.classList.remove("active");
  });

  dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.classList.remove("active");
    if (e.dataTransfer.files.length > 0) {
      handleFiles(e.dataTransfer.files);
    }
  });

  // Online/offline events
  window.addEventListener("online", () => {
    updateConnectionStatus("Reconnecting...");
    connectSocket();
  });

  window.addEventListener("offline", () => {
    updateConnectionStatus("Disconnected");
    handleDisconnect();
  });

  // Before unload warning
  window.addEventListener("beforeunload", (e) => {
    if (isSending) {
      e.preventDefault();
      e.returnValue =
        "You have an ongoing file transfer. Are you sure you want to leave?";
      return e.returnValue;
    }
  });
}

// Handle file selection
function handleFileSelection(e) {
  handleFiles(e.target.files);
  fileInput.value = ""; // Reset input to allow selecting same files again
}

// Handle files (from input or drop)
function handleFiles(files) {
  for (const file of files) {
    addFileToQueue(file);
  }
  processQueue();
}

// Add file to queue
function addFileToQueue(file) {
  const fileId = generateFileId();
  const fileEntry = {
    id: fileId,
    file: file,
    status: "queued",
    progress: 0,
    retries: 0,
  };

  fileQueue.push(fileEntry);
  renderFileList();
}

// Process the queue
function processQueue() {
  if (isSending || fileQueue.length === 0) return;

  // Get the first queued file
  const fileEntry = fileQueue.find((f) => f.status === "queued");
  if (!fileEntry) return;

  currentFile = fileEntry;
  verifyFileIntegrity(fileEntry.file).then((hash) => {
    currentFile.fileHash= hash;
  });
  currentFile.status = "preparing";
  renderFileList();

  // Start the transfer
  startFileTransfer(currentFile);
}

// Connect socket
function connectSocket() {
  if (socket) {
    socket.disconnect();
  }

  socket = io(window.location.href, {
    reconnectionAttempts: MAX_RETRIES,
    reconnectionDelay: RECONNECT_DELAY,
    timeout: 10000,
  });

  setupSocketEvents();
}

// Set up socket events
function setupSocketEvents() {
  socket.on("connect", () => {
    socket.emit("capabilities", {
      encryption: ["AES-GCM-256"],
      compression: ["none"], // Future: add compression options
      chunkSize: CHUNK_SIZE,
      resumable: true,
      integrityCheck: ["SHA-256"],
    });
    updateConnectionStatus("Connected");
    clearTimeout(reconnectTimeout);
    retryCount = 0;
    processQueue();
  });

  socket.on("disconnect", () => {
    updateConnectionStatus("Disconnected");
    handleDisconnect();
  });

  socket.on("connect_error", () => {
    updateConnectionStatus("Connection Failed");
    attemptReconnect();
  });

  socket.on("answer", async (answer) => {
    try {
      if (peerConnection) {
        await peerConnection.setRemoteDescription(answer);
      }
    } catch (err) {
      handleError("Answer error", err);
    }
  });

  socket.on("ice-candidate", async (candidate) => {
    try {
      if (peerConnection && peerConnection.remoteDescription) {
        await peerConnection.addIceCandidate(candidate);
      }
    } catch (err) {
      handleError("ICE candidate error", err);
    }
  });

  socket.on("transfer-status", (data) => {
    handleTransferStatus(data);
    if (data.status === "completed") {
      // Store the download URL if provided
      if (data.downloadUrl) {
        // Find the file in queue and add the download URL
        const fileEntry = fileQueue.find((f) => f.id === data.fileId);
        if (fileEntry) {
          fileEntry.downloadUrl = data.downloadUrl;
          renderFileList(); // Update the UI immediately with download link
        }
      }
      console.log("Transfer completed:", data);
      if (
        data.name == currentFile.file.name &&
        data.fileHash == currentFile.fileHash
      ) {
        // If the completed file is the current one, reset the transfer state
        currentFile.status = "completed";
        currentFile.downloadUrl = data.downloadUrl || null;
        console.log(
          `File ${currentFile.file.name} completed with download URL: ${data.downloadUrl}`
        );

        setTimeout(loadFiles, 1000);
      }
    }
  });
}

// Start file transfer
async function startFileTransfer(fileEntry) {
  if (!socket || !socket.connected) {
    fileEntry.status = "waiting";
    updateStatus("Waiting for connection...");
    renderFileList();
    return;
  }

  resetTransfer();

  fileEntry.status = "connecting";
  updateStatus(`Establishing connection for ${fileEntry.file.name}`);
  renderFileList();

  transferSessionId = generateSessionId();
  transferStartTime = Date.now();

  try {
    await initializeWebRTC(fileEntry);
  } catch (err) {
    handleError("WebRTC initialization failed", err);
    fileEntry.status = "failed";
    renderFileList();
    processQueue();
  }
}

// Initialize WebRTC
async function initializeWebRTC(fileEntry) {
  const file = fileEntry.file;

  // Create RTCPeerConnection
  const configuration = {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
    ],
  };

  peerConnection = new RTCPeerConnection(configuration);

  // Create data channel with reliability options
  dataChannel = peerConnection.createDataChannel("fileTransfer", {
    ordered: true,
    maxRetransmits: 30,
  });

  setupDataChannelHandlers(fileEntry);
  await setupEncryption(file);
  setupICECandidates();

  // Create and send offer
  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);

  socket.emit("offer", {
    offer: offer,
    sessionId: transferSessionId,
    fileName: file.name,
    fileSize: file.size,
    fileType: file.type,
  });
}

// Set up data channel handlers
function setupDataChannelHandlers(fileEntry) {
  dataChannel.binaryType = "arraybuffer";

  dataChannel.onopen = () => {
    isChannelOpen = true;
    fileEntry.status = "uploading";
    updateStatus(`Starting upload for ${fileEntry.file.name}`);
    renderFileList();
    startFileUpload(fileEntry);
  };

  dataChannel.onclose = () => {
    isChannelOpen = false;
    if (isSending) {
      handleTransferInterruption(fileEntry);
    }
  };

  dataChannel.onerror = (err) => {
    handleError("Data channel error", err);
    isChannelOpen = false;
    if (isSending) {
      handleTransferInterruption(fileEntry);
    }
  };

  // Add this to the dataChannel.onmessage handler
  dataChannel.onmessage = (event) => {
    const message = event.data;

    if (typeof message === "string") {
      try {
        const parsed = JSON.parse(message);

        if (parsed.type === "retry-request") {
          // Server is requesting a retry of a specific chunk
          const offset = parsed.offset;
          console.log(`Server requested retry for chunk at offset: ${offset}`);

          if (isSending && currentFile) {
            retryChunk(currentFile, offset).catch((err) =>
              handleError("Chunk retry failed", err)
            );
          }
        } else if (parsed.type === "ack") {
          // Server acknowledges successful receipt up to this offset
          console.log(
            `Server acknowledged data up to: ${formatBytes(parsed.offset)}`
          );
        } else if (parsed.type === "status" && parsed.status === "completed") {
          console.log("Server confirmed complete file receipt");
          // Handle successful completion
          if (currentFile) {
            currentFile.status = "completed";
            updateStatus(
              `Upload completed and verified: ${currentFile.file.name}`
            );
            renderFileList();

            resetTransfer();
            processQueue();
          }
        }
      } catch (e) {
        // Handle non-JSON string messages
        if (message === "resume") {
          console.log("Server requested to resume transfer");
          if (isPaused) {
            isPaused = false;
            continueUpload();
          }
        } else if (message.startsWith("progress:")) {
          const progress = parseInt(message.split(":")[1]);
          console.log(`Server reports progress: ${progress}%`);
          // You could update UI here if needed
        } else {
          console.log("Server message:", message);
        }
      }
    }
  };
}

// Add a new function to retry specific chunks
async function retryChunk(fileEntry, offset) {
  const file = fileEntry.file;
  const chunkSize = CHUNK_SIZE;

  if (offset >= file.size) return;

  try {
    // Create temporary reader for this retry
    const tempReader = new FileReader();

    // Read the chunk at the specified offset
    const chunk = await readChunk(file, offset, chunkSize, tempReader);

    // Encrypt and send the chunk
    const packet = await encryptChunk(chunk);
    const metadata = {
      offset: offset,
      fileId: fileEntry.id,
      isLast: offset + chunk.byteLength >= file.size,
      isRetry: true,
    };

    // Send chunk metadata, then the chunk data
    dataChannel.send(JSON.stringify(metadata));
    dataChannel.send(packet);

    console.log(`Chunk at offset ${offset} retried successfully`);
  } catch (err) {
    console.error(`Failed to retry chunk at offset ${offset}:`, err);
    throw err;
  }
}

// Set up encryption
async function setupEncryption(file) {
  try {
    // Generate a strong random key
    const rawKey = crypto.getRandomValues(new Uint8Array(32));

    // Import the key properly
    encryptionKey = await crypto.subtle.importKey(
      "raw",
      rawKey,
      {
        name: "AES-GCM",
        length: 256,
      },
      false, // non-extractable for security
      ["encrypt"]
    );

    socket.emit("metadata", {
      protocolVersion: "1.0",
      key: Array.from(rawKey),
      fileName: file.name,
      fileSize: file.size,
      fileType: file.type,
      sessionId: transferSessionId,
    });

    return true;
  } catch (err) {
    handleError("Encryption setup failed", err);
    return false;
  }
}

// Set up ICE candidates
function setupICECandidates() {
  peerConnection.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit("ice-candidate", {
        candidate: e.candidate,
        sessionId: transferSessionId,
      });
    }
  };

  peerConnection.oniceconnectionstatechange = () => {
    switch (peerConnection.iceConnectionState) {
      case "disconnected":
      case "failed":
        if (isSending) {
          handleTransferInterruption(currentFile);
        }
        break;
      case "closed":
        break;
    }
  };
}

// Start file upload process
async function startFileUpload(fileEntry) {
  const file = fileEntry.file;

  if (!isChannelOpen) {
    fileEntry.status = "waiting";
    updateStatus("Waiting for connection...");
    renderFileList();
    return;
  }

  fileEntry.status = "uploading";
  renderFileList();

  isSending = true;
  isPaused = false;
  currentFileOffset = 0;

  try {
    // Create file reader
    const fileReader = new FileReader();
    currentFileReader = fileReader;

    await processFile(fileEntry, fileReader);
  } catch (err) {
    if (err.name !== "AbortError") {
      handleError("Upload error", err);
      fileEntry.status = "failed";
      renderFileList();
    }
  } finally {
    finalizeTransfer(fileEntry);
  }
}

// Process file in chunks
async function processFile(fileEntry, fileReader) {
  const file = fileEntry.file;
  const chunkSize = CHUNK_SIZE;
  let offset = currentFileOffset;
  let retryAttempts = {};
  const MAX_CHUNK_RETRIES = 3;
  let chunksSent = 0;
  let totalChunks = Math.ceil(file.size / chunkSize);

  updateStatus(`Uploading: ${formatBytes(offset)}/${formatBytes(file.size)}`);
  updateProgress(offset, file.size);

  while (offset < file.size) {
    if (!isSending) break;

    try {
      // Wait if paused or buffer is too full
      while (
        isPaused ||
        (dataChannel &&
          dataChannel.bufferedAmount > MAX_BUFFER &&
          isChannelOpen)
      ) {
        await wait(50);
        if (!isSending) return;
      }

      if (!isChannelOpen || !dataChannel) {
        throw new Error("Connection closed");
      }

      // Read chunk
      const chunk = await readChunk(file, offset, chunkSize, fileReader);

      // Encrypt and send chunk
      const packet = await encryptChunk(chunk);
      const isLastChunk = offset + chunk.byteLength >= file.size;

      const metadata = {
        offset: offset,
        fileId: fileEntry.id,
        isLast: isLastChunk,
        chunkIndex: chunksSent,
        totalChunks: totalChunks,
      };

      // Send chunk identifier first, then the chunk data
      dataChannel.send(JSON.stringify(metadata));

      // Add delay between metadata and binary data
      await wait(5);

      // Send the actual data
      dataChannel.send(packet);
      chunksSent++;

      // Wait a bit to avoid overwhelming the connection with large files
      if (file.size > 100 * 1024 * 1024) {
        // For files larger than 100MB, add small pauses periodically
        if (offset % (5 * 1024 * 1024) < chunkSize) {
          await wait(50);
        }
      }

      // Update offset and progress
      offset += chunk.byteLength;
      currentFileOffset = offset;

      // Update progress periodically (not every chunk to avoid UI bottlenecks)
      const now = Date.now();
      if (now - lastProgressUpdate > 200) {
        updateProgress(offset, file.size);
        updateFileProgress(fileEntry, Math.round((offset / file.size) * 100));
        lastProgressUpdate = now;

        // Log progress for large files
        if (
          file.size > 50 * 1024 * 1024 &&
          offset % (10 * 1024 * 1024) < chunkSize
        ) {
          console.log(
            `Sending: ${Math.round((offset / file.size) * 100)}% of ${
              file.name
            }`
          );
        }
      }
    } catch (err) {
      console.error(`Error sending chunk at offset ${offset}:`, err);

      // Handle retry logic for individual chunks
      if (!retryAttempts[offset]) {
        retryAttempts[offset] = 0;
      }

      retryAttempts[offset]++;

      if (retryAttempts[offset] <= MAX_CHUNK_RETRIES) {
        console.log(
          `Retrying chunk at offset ${offset} (${retryAttempts[offset]}/${MAX_CHUNK_RETRIES})`
        );
        // Don't increment offset, will retry this chunk
        await wait(1000); // Wait before retry
      } else {
        console.error(
          `Failed to send chunk at offset ${offset} after ${MAX_CHUNK_RETRIES} attempts`
        );
        // Move to next chunk after max retries
        offset += chunkSize;
      }
    }
  }

  // Ensure all data has been sent before signaling completion
  if (dataChannel && dataChannel.bufferedAmount > 0) {
    await wait(2000); // Wait longer for buffer to clear
  }

  // Final progress update
  updateProgress(file.size, file.size);
  updateFileProgress(fileEntry, 100);

  // Wait for the server to process all data
  await wait(2000);
}

// Read a chunk from file
function readChunk(file, offset, chunkSize, fileReader) {
  return new Promise((resolve, reject) => {
    const slice = file.slice(offset, offset + chunkSize);

    fileReader.onload = (e) => resolve(new Uint8Array(e.target.result));
    fileReader.onerror = (e) => reject(e);

    fileReader.readAsArrayBuffer(slice);
  });
}

// Encrypt chunk
async function encryptChunk(chunk) {
  try {
    // Generate a unique IV for each chunk
    const iv = crypto.getRandomValues(new Uint8Array(12));

    // Encrypt with GCM for authenticated encryption
    const encrypted = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        tagLength: 128, // 128-bit authentication tag
      },
      encryptionKey,
      chunk.buffer
    );

    // Combine IV and encrypted data for transmission
    return new Uint8Array([...iv, ...new Uint8Array(encrypted)]);
  } catch (err) {
    handleError("Encryption failed", err);
    throw err; // Re-throw to handle in the calling function
  }
}

// Continue upload after pause
function continueUpload() {
  if (isSending && currentFile && isChannelOpen) {
    processFile(currentFile, currentFileReader)
      .catch((err) => handleError("Upload continuation error", err))
      .finally(() => {
        if (currentFileOffset >= currentFile.file.size) {
          finalizeTransfer(currentFile);
        }
      });
  }
}

// Finalize transfer
function finalizeTransfer(fileEntry) {
  if(currentFile.status == "completed") {
    // Cleanup current transfer
    resetTransfer();

    // Mark file as completed
    fileEntry.status = "completed";
    updateStatus(`Upload completed for ${fileEntry.file.name}`);
    renderFileList();

    // Process next file
    setTimeout(processQueue, 1000);
    return;
  }
  // First, confirm with server that all chunks were received
  if (isChannelOpen && dataChannel && dataChannel.readyState === "open") {
    dataChannel.send(
      JSON.stringify({
        type: "verify",
        fileId: fileEntry.id,
        expectedSize: fileEntry.file.size,
        fileName: fileEntry.file.name,
      })
    );

    // Wait for server confirmation before sending complete signal
    setTimeout(() => {
      if (isChannelOpen && dataChannel && dataChannel.readyState === "open") {
        dataChannel.send(
          JSON.stringify({ type: "complete", fileId: fileEntry.id })
        );
      }

      // Cleanup current transfer
      resetTransfer();

      // Mark file as completed
      fileEntry.status = "completed";
      updateStatus(`Upload completed for ${fileEntry.file.name}`);
      renderFileList();

      // Process next file
      setTimeout(processQueue, 1000);
    }, 2000);
  } else {
    // Connection is closed, handle as needed
    resetTransfer();
    fileEntry.status = "failed";
    updateStatus(`Connection closed before transfer could complete`);
    renderFileList();
    setTimeout(processQueue, 1000);
  }
}

// Handle transfer interruption
function handleTransferInterruption(fileEntry) {
  isSending = false;

  if (fileEntry.retries < MAX_RETRIES) {
    fileEntry.retries++;
    fileEntry.status = "retrying";
    updateStatus(
      `Connection interrupted, retrying... (${fileEntry.retries}/${MAX_RETRIES})`
    );
    renderFileList();

    setTimeout(() => {
      startFileTransfer(fileEntry);
    }, RECONNECT_DELAY);
  } else {
    fileEntry.status = "failed";
    updateStatus(
      `Upload failed for ${fileEntry.file.name} after ${MAX_RETRIES} attempts`
    );
    renderFileList();

    resetTransfer();
    processQueue();
  }
}

// Handle transfer status from server
function handleTransferStatus(data) {
  if (data.status === "completed" && currentFile && data.fileHash === currentFile.fileHash) {
    currentFile.status = "completed";
    console.log("dokho");

    // Store the download URL if provided
    if (data.downloadUrl) {
      currentFile.downloadUrl = data.downloadUrl;
    }

    updateStatus(`Upload completed and verified: ${currentFile.file.name}`);
    renderFileList();

    resetTransfer();
    processQueue();
  } else if (
    data.status === "incomplete" &&
    currentFile &&
    data.fileHash === currentFile.fileHash
  ) {
    // Server indicates that not all data has been received
    console.log(
      `Server reports incomplete transfer: ${data.receivedBytes}/${data.expectedBytes} bytes`
    );

    // We might need to resend missing chunks
    if (isChannelOpen && dataChannel && dataChannel.readyState === "open") {
      // Just wait for server to request specific chunks if needed
      updateStatus(`Verifying data, please wait...`);
    }
  }
}

// Handle disconnect
function handleDisconnect() {
  if (isSending && currentFile) {
    handleTransferInterruption(currentFile);
  }

  isChannelOpen = false;

  // Attempt reconnect
  attemptReconnect();
}

// Attempt to reconnect
function attemptReconnect() {
  clearTimeout(reconnectTimeout);

  if (retryCount >= MAX_RETRIES) {
    updateConnectionStatus("Reconnection failed");
    return;
  }

  retryCount++;
  updateConnectionStatus(`Reconnecting (${retryCount}/${MAX_RETRIES})...`);

  reconnectTimeout = setTimeout(() => {
    connectSocket();
  }, RECONNECT_DELAY);
}

// Reset transfer state
function resetTransfer() {
  isSending = false;
  isPaused = false;

  if (currentFileReader) {
    currentFileReader = null;
  }

  if (dataChannel && dataChannel.readyState === "open") {
    dataChannel.close();
  }

  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }

  dataChannel = null;
  isChannelOpen = false;
}

// Retry a failed transfer
function retryTransfer(fileId) {
  const fileEntry = fileQueue.find((f) => f.id === fileId);
  if (!fileEntry) return;

  fileEntry.status = "queued";
  fileEntry.retries = 0;
  renderFileList();

  processQueue();
}

// Remove file from queue
function removeFile(fileId) {
  fileQueue = fileQueue.filter((f) => f.id !== fileId);
  renderFileList();
}

// Update progress UI
function updateProgress(current, total) {
  const percent = Math.round((current / total) * 100);
  progressBar.style.width = `${percent}%`;

  // Calculate transfer speed
  const elapsedSeconds = (Date.now() - transferStartTime) / 1000;
  const bytesPerSecond = current / elapsedSeconds;

  updateStatus(
    `Uploading: ${percent}% (${formatBytes(current)}/${formatBytes(
      total
    )}) - ${formatBytes(bytesPerSecond)}/s`
  );
}

// Update file progress
function updateFileProgress(fileEntry, percent) {
  fileEntry.progress = percent;
  renderFileList();
}

// Render file list
function renderFileList() {
  fileList.innerHTML = "";

  fileQueue.forEach((file) => {
    const fileItem = document.createElement("div");
    fileItem.className = "file-item";

    const fileInfo = document.createElement("div");
    fileInfo.className = "file-info";

    const fileName = document.createElement("div");
    fileName.textContent = `${file.file.name} (${formatBytes(file.file.size)})`;

    const fileProgress = document.createElement("div");
    fileProgress.className = "progress-container";
    fileProgress.style.height = "8px";
    fileProgress.style.margin = "5px 0";

    const progressBar = document.createElement("div");
    progressBar.id = `progress-${file.id}`;
    progressBar.style.width = `${file.progress}%`;
    progressBar.style.height = "100%";
    progressBar.style.background = getStatusColor(file.status);

    fileProgress.appendChild(progressBar);
    fileInfo.appendChild(fileName);
    fileInfo.appendChild(fileProgress);

    const statusText = document.createElement("div");
    statusText.textContent = getStatusText(file);
    statusText.style.fontSize = "12px";
    statusText.style.color = "#666";
    fileInfo.appendChild(statusText);

    const fileActions = document.createElement("div");
    fileActions.className = "file-actions";

    if (file.status === "failed") {
      const retryBtn = document.createElement("button");
      retryBtn.className = "retry-btn";
      retryBtn.textContent = "Retry";
      retryBtn.onclick = () => retryTransfer(file.id);
      fileActions.appendChild(retryBtn);
    }

    if (file.status !== "uploading") {
      const removeBtn = document.createElement("button");
      removeBtn.className = "retry-btn";
      removeBtn.style.background = "#f44336";
      removeBtn.style.marginLeft = "5px";
      removeBtn.textContent = "Remove";
      removeBtn.onclick = () => removeFile(file.id);
      fileActions.appendChild(removeBtn);
    }

    fileItem.appendChild(fileInfo);
    fileItem.appendChild(fileActions);
    fileList.appendChild(fileItem);
  });
}

// Get status text
function getStatusText(file) {
  switch (file.status) {
    case "queued":
      return "Queued for upload";
    case "preparing":
      return "Preparing...";
    case "connecting":
      return "Establishing connection...";
    case "uploading":
      return `Uploading ${file.progress}%`;
    case "completed":
      return "Completed";
    case "failed":
      return `Failed${
        file.retries > 0 ? ` after ${file.retries} attempts` : ""
      }`;
    case "retrying":
      return `Retrying (${file.retries}/${MAX_RETRIES})...`;
    case "waiting":
      return "Waiting for connection...";
    default:
      return "Unknown status";
  }
}

// Get status color
function getStatusColor(status) {
  switch (status) {
    case "completed":
      return "#4CAF50";
    case "uploading":
      return "#2196F3";
    case "failed":
      return "#f44336";
    case "retrying":
      return "#ff9800";
    default:
      return "#4CAF50";
  }
}

// Update status text
function updateStatus(message) {
  status.textContent = message;
}

// Update connection status
function updateConnectionStatus(message) {
  connectionStatus.textContent = message;
  connectionStatus.className = "connection-status";

  if (message.includes("Connected")) {
    connectionStatus.classList.add("connected");
  } else if (message.includes("Reconnecting")) {
    connectionStatus.classList.add("reconnecting");
  } else {
    connectionStatus.classList.add("disconnected");
  }
}

// Helper: Format bytes to human readable
function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  if (bytes === 0) return "0B";
  const exp = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / 1024 ** exp).toFixed(2)} ${units[exp]}`;
}

// Helper: Generate unique ID
function generateFileId() {
  return "file_" + Date.now() + "_" + Math.random().toString(36).substr(2, 9);
}

// Helper: Generate session ID
function generateSessionId() {
  return (
    "session_" + Date.now() + "_" + Math.random().toString(36).substr(2, 9)
  );
}

// Helper: Wait for specified milliseconds
function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Helper: Handle errors
function handleError(message, err) {
  console.error(message, err);
  updateStatus(`Error: ${message}`);
}

// File listing functions
async function loadFiles() {
  try {
    const response = await fetch("/api/files");
    if (!response.ok) {
      throw new Error("Failed to load files");
    }

    const data = await response.json();

    // Check if fileListings element exists before trying to render
    const fileListingsElement = document.getElementById("fileListings");
    if (fileListingsElement) {
      renderFileListings(data.files);
    } else {
      console.warn("fileListings element not found, skipping render");
      // Optionally create the element if it doesn't exist
      const container = document.createElement("div");
      container.id = "fileListings";
      container.className = "file-listings-container";
      document.body.appendChild(container); // Add to document
      renderFileListings(data.files);
    }
  } catch (err) {
    console.error("Error loading files:", err);

    // Safely handle missing elements
    const fileListingsElement = document.getElementById("fileListings");
    if (fileListingsElement) {
      fileListingsElement.innerHTML = `
          <div class="no-files">
            <p>Error loading files. <button class="refresh-btn" onclick="loadFiles()">Retry</button></p>
          </div>
        `;
    }
  }
}

// Add this function to your client code
function renderFileListings(files) {
  const container = document.getElementById("fileListings");

  // Check if the container exists
  if (!container) {
    console.error("fileListings container not found in the DOM");
    return; // Exit if container doesn't exist
  }

  if (!files || files.length === 0) {
    container.innerHTML = `
        <div class="no-files">
          <p>No files available for download.</p>
        </div>
      `;
    return;
  }

  let html =
    '<button class="refresh-btn" onclick="loadFiles()">Refresh</button>';

  files.forEach((file) => {
    const created = new Date(file.created).toLocaleString();

    html += `
        <div class="file-listing" id="file-${file.id}">
          <div class="file-listing-info">
            <div class="file-name">${escapeHTML(file.name)}</div>
            <div class="file-meta">
              Size: ${formatBytes(file.size)} • Uploaded: ${created}
            </div>
          </div>
          <div class="file-actions">
            <a href="/api/download/${
              file.id
            }" class="download-btn" download>Download</a>
            <button class="delete-btn" onclick="deleteFile('${
              file.id
            }', '${escapeHTML(file.name)}')">Delete</button>
          </div>
        </div>
      `;
  });

  container.innerHTML = html;
}

function renderFileList() {
  fileList.innerHTML = "";

  fileQueue.forEach((file) => {
    const fileItem = document.createElement("div");
    fileItem.className = "file-item";

    const fileInfo = document.createElement("div");
    fileInfo.className = "file-info";

    const fileName = document.createElement("div");
    fileName.textContent = `${file.file.name} (${formatBytes(file.file.size)})`;

    const fileProgress = document.createElement("div");
    fileProgress.className = "progress-container";
    fileProgress.style.height = "8px";
    fileProgress.style.margin = "5px 0";

    const progressBar = document.createElement("div");
    progressBar.id = `progress-${file.id}`;
    progressBar.style.width = `${file.progress}%`;
    progressBar.style.height = "100%";
    progressBar.style.background = getStatusColor(file.status);

    fileProgress.appendChild(progressBar);
    fileInfo.appendChild(fileName);
    fileInfo.appendChild(fileProgress);

    const statusText = document.createElement("div");
    statusText.textContent = getStatusText(file);
    statusText.style.fontSize = "12px";
    statusText.style.color = "#666";
    fileInfo.appendChild(statusText);

    const fileActions = document.createElement("div");
    fileActions.className = "file-actions";

    // If file has a download URL and is completed, show download button
    if (file.status === "completed" && file.downloadUrl) {
      const downloadBtn = document.createElement("a");
      downloadBtn.className = "download-btn";
      downloadBtn.href = file.downloadUrl;
      downloadBtn.textContent = "Download";
      downloadBtn.download = file.file.name; // Set suggested filename
      fileActions.appendChild(downloadBtn);
    }

    if (file.status === "failed") {
      const retryBtn = document.createElement("button");
      retryBtn.className = "retry-btn";
      retryBtn.textContent = "Retry";
      retryBtn.onclick = () => retryTransfer(file.id);
      fileActions.appendChild(retryBtn);
    }

    if (file.status !== "uploading") {
      const removeBtn = document.createElement("button");
      removeBtn.className = "retry-btn";
      removeBtn.style.background = "#f44336";
      removeBtn.style.marginLeft = "5px";
      removeBtn.textContent = "Remove";
      removeBtn.onclick = () => removeFile(file.id);
      fileActions.appendChild(removeBtn);
    }

    fileItem.appendChild(fileInfo);
    fileItem.appendChild(fileActions);
    fileList.appendChild(fileItem);
  });
}

async function deleteFile(fileId, fileName) {
  if (!confirm(`Are you sure you want to delete "${fileName}"?`)) {
    return;
  }

  try {
    const response = await fetch(`/api/files/${fileId}`, {
      method: "DELETE",
    });

    if (!response.ok) {
      throw new Error("Failed to delete file");
    }

    // Remove from UI
    const fileElement = document.getElementById(`file-${fileId}`);
    if (fileElement) {
      fileElement.remove();
    }

    // Check if there are no more files
    const container = document.getElementById("fileListings");
    if (!container.querySelector(".file-listing")) {
      loadFiles(); // Reload to show "no files" message
    }
  } catch (err) {
    console.error("Error deleting file:", err);
    alert("Failed to delete file. Please try again.");
  }
}

// Helper function to escape HTML
function escapeHTML(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

async function verifyFileIntegrity(file) {
  try {
    // Create a FileReader to read the file
    const fileReader = new FileReader();

    // Return a promise that resolves when the file is read and the hash is calculated
    return new Promise((resolve, reject) => {
      fileReader.onload = async () => {
        try {
          // Get the file buffer (ArrayBuffer)
          const fileBuffer = fileReader.result;

          // Calculate the SHA-256 hash using crypto.subtle.digest
          const hashBuffer = await crypto.subtle.digest("SHA-256", fileBuffer);

          // Convert the hash buffer into a hex string
          const hashArray = Array.from(new Uint8Array(hashBuffer));
          const hashHex = hashArray
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join("");

          // Return the calculated hash
          resolve(hashHex);
        } catch (err) {
          console.error(`Error calculating hash: ${err.message}`);
          reject(err);
        }
      };

      // Handle any error that occurs during the file reading process
      fileReader.onerror = () => {
        console.error("Error reading file:", fileReader.error);
        reject(fileReader.error);
      };

      // Read the file as an ArrayBuffer
      fileReader.readAsArrayBuffer(file);
    });
  } catch (err) {
    console.error(`Integrity verification failed: ${err.message}`);
    return null;
  }
}

// Load files when page is ready
document.addEventListener("DOMContentLoaded", () => {
  loadFiles();

  // Refresh file list when a file upload completes
  // socket.on("transfer-status", (data) => {
  //   if (data.status === "completed") {
  //     setTimeout(loadFiles, 1000);
  //   }
  // });
});

// Initialize the app when the page loads
window.addEventListener("DOMContentLoaded", initialize);
