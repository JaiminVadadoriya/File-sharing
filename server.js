const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const wrtc = require('wrtc');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Configuration
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const MAX_WRITE_QUEUE = 1024 * 1024 * 512; // 512MB
const CHUNK_SIZE = 16384;

// Ensure upload directory exists
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

io.on('connection', (socket) => {
  let peerConnection;
  let fileStream;
  let encryptionKey;
  let fileName;
  let writeQueue = 0;

  socket.on('metadata', ({ key, fileName: originalName }) => {
    try {
      // Validate encryption key
      if (!key || key.length !== 32) {
        throw new Error('Invalid encryption key length');
      }
      
      encryptionKey = Buffer.from(key);
      fileName = `${Date.now()}_${originalName.replace(/[^a-zA-Z0-9\.]/g, '')}`;
      console.log(`Starting receive for: ${fileName}`);
    } catch (err) {
      console.error('Metadata error:', err.message);
      socket.disconnect(true);
    }
  });

  socket.on('offer', async (offer) => {
    try {
      peerConnection = new wrtc.RTCPeerConnection();
      
      peerConnection.ondatachannel = ({ channel }) => {
        channel.onmessage = async ({ data }) => {
          try {
            // Handle completion signal
            if (typeof data === 'string') {
              const message = JSON.parse(data);
              if (message.type === 'complete') {
                finalizeFile();
                return;
              }
            }

            // Process data chunk
            const buffer = Buffer.from(data);
            
            // Extract IV (12B), ciphertext, and tag (16B)
            const iv = buffer.subarray(0, 12);
            const tag = buffer.subarray(buffer.length - 16);
            const ciphertext = buffer.subarray(12, buffer.length - 16);

            // Validate chunk structure
            if (iv.length !== 12 || tag.length !== 16) {
              throw new Error('Invalid chunk structure');
            }

            // Decrypt chunk
            const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, iv);
            decipher.setAuthTag(tag);

            const decrypted = Buffer.concat([
              decipher.update(ciphertext),
              decipher.final()
            ]);

            // Initialize file stream if not exists
            if (!fileStream) {
              const filePath = path.join(UPLOAD_DIR, fileName);
              fileStream = fs.createWriteStream(filePath);
              console.log(`Writing to: ${filePath}`);
            }

            // Handle backpressure
            writeQueue += decrypted.length;
            if (writeQueue > MAX_WRITE_QUEUE) {
              channel.send('pause');
            }

            const canWrite = fileStream.write(decrypted, () => {
              writeQueue -= decrypted.length;
              if (writeQueue < MAX_WRITE_QUEUE / 2) {
                channel.send('resume');
              }
            });

            if (!canWrite) {
              channel.send('pause');
              fileStream.once('drain', () => channel.send('resume'));
            }
          } catch (err) {
            console.error('Processing error:', err.message);
            cleanup();
          }
        };
      };

      // Set up ICE candidates
      peerConnection.onicecandidate = ({ candidate }) => {
        if (candidate) {
          socket.emit('ice-candidate', candidate);
        }
      };

      // Process WebRTC offer
      await peerConnection.setRemoteDescription(offer);
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      socket.emit('answer', answer);

    } catch (err) {
      console.error('Offer handling error:', err.message);
      cleanup();
    }
  });

  socket.on('ice-candidate', async (candidate) => {
    try {
      if (peerConnection) {
        await peerConnection.addIceCandidate(new wrtc.RTCIceCandidate(candidate));
      }
    } catch (err) {
      console.error('ICE candidate error:', err.message);
    }
  });

  socket.on('disconnect', () => {
    cleanup();
  });

  function finalizeFile() {
    if (fileStream) {
      fileStream.end(() => {
        console.log(`Successfully saved: ${fileName}`);
        console.log(`File size: ${formatBytes(writeQueue)}`);
        cleanup();
      });
    }
  }

  function cleanup() {
    if (fileStream) {
      if (!fileStream.closed) fileStream.end();
      fileStream = null;
    }
    if (peerConnection) {
      peerConnection.close();
      peerConnection = null;
    }
    writeQueue = 0;
  }

  function formatBytes(bytes) {
    const units = ['B', 'KB', 'MB', 'GB'];
    if (bytes === 0) return '0B';
    const exp = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / 1024 ** exp).toFixed(2)} ${units[exp]}`;
  }
});

// Serve static files (like index.html)
app.use(express.static(path.join(__dirname, 'public')));

server.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
  console.log(`Upload directory: ${UPLOAD_DIR}`);
});