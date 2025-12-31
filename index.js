import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import { WebSocketServer, WebSocket } from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const STATIC_DIR = path.join(__dirname, '..', 'public');

const MAX_PER_ROOM = 2;
const MAX_MESSAGE_BYTES = 64 * 1024;
const RATE_LIMIT_WINDOW_MS = 10_000;
const RATE_LIMIT_MAX = 60;
const ROOM_TTL_MS = 30 * 60 * 1000;

const app = express();
app.use(cors());
app.use(express.static(STATIC_DIR));
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const rooms = new Map();
const rateLimit = new WeakMap();

function now() {
  return Date.now();
}

function touchRoom(roomId) {
  const room = rooms.get(roomId);
  if (room) {
    room.touchedAt = now();
  }
}

function cleanupStaleRooms() {
  const cutoff = now() - ROOM_TTL_MS;
  for (const [roomId, room] of rooms.entries()) {
    if (room.touchedAt < cutoff) {
      [room.sender, room.receiver].forEach((ws) => ws?.close?.());
      rooms.delete(roomId);
    }
  }
}

setInterval(cleanupStaleRooms, 5 * 60 * 1000).unref();

function send(ws, message) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, { sender: null, receiver: null, touchedAt: now(), token: null });
  }
  return rooms.get(roomId);
}

function enforceRateLimit(ws) {
  const windowStart = now() - RATE_LIMIT_WINDOW_MS;
  const entry = rateLimit.get(ws) || [];
  const next = entry.filter((t) => t >= windowStart);
  next.push(now());
  rateLimit.set(ws, next);
  if (next.length > RATE_LIMIT_MAX) {
    ws.close(1013, 'Rate limit exceeded');
    return false;
  }
  return true;
}

wss.on('connection', (ws, req) => {
  if (req.url !== '/ws') {
    ws.close(1008, 'Invalid path');
    return;
  }

  ws.on('message', (payload) => {
    if (payload.length > MAX_MESSAGE_BYTES) {
      ws.close(1009, 'Message too large');
      return;
    }
    if (!enforceRateLimit(ws)) return;

    let msg;
    try {
      msg = JSON.parse(payload.toString());
    } catch {
      ws.close(1003, 'Invalid JSON');
      return;
    }

    const { type } = msg;
    if (type === 'join') {
      const { roomId, token, role } = msg;
      if (!roomId || !token || !role) {
        send(ws, { type: 'error', message: 'roomId, token, role required' });
        return;
      }

      const room = getRoom(roomId);
      if (room.token && room.token !== token) {
        send(ws, { type: 'error', message: 'Invalid token' });
        return;
      }
      if (!room.token) {
        room.token = token;
      }

      if (role === 'sender' && room.sender && room.sender !== ws) {
        send(ws, { type: 'error', message: 'Sender already present' });
        return;
      }
      if (role === 'receiver' && room.receiver && room.receiver !== ws) {
        send(ws, { type: 'error', message: 'Receiver already present' });
        return;
      }

      if ([room.sender, room.receiver].filter(Boolean).length >= MAX_PER_ROOM && ![room.sender, room.receiver].includes(ws)) {
        send(ws, { type: 'error', message: 'Room full' });
        return;
      }

      ws.roomId = roomId;
      ws.role = role;
      if (role === 'sender') room.sender = ws;
      if (role === 'receiver') room.receiver = ws;
      touchRoom(roomId);

      send(ws, { type: 'joined', roomId, role });

      if (room.sender && room.receiver) {
        send(room.sender, { type: 'ready' });
        send(room.receiver, { type: 'ready' });
      }
      return;
    }

    if (type === 'offer' || type === 'answer' || type === 'ice') {
      const { roomId, role } = ws;
      if (!roomId || !role) {
        send(ws, { type: 'error', message: 'Join first' });
        return;
      }
      const room = rooms.get(roomId);
      if (!room) {
        send(ws, { type: 'error', message: 'Room missing' });
        return;
      }
      const target = role === 'sender' ? room.receiver : room.sender;
      if (target?.readyState === WebSocket.OPEN) {
        touchRoom(roomId);
        send(target, { type, data: msg.data });
      } else {
        send(ws, { type: 'error', message: 'Peer not connected' });
      }
      return;
    }

    if (type === 'leave') {
      cleanupSocket(ws);
      return;
    }

    send(ws, { type: 'error', message: 'Unknown message type' });
  });

  ws.on('close', () => cleanupSocket(ws));
  ws.on('error', () => cleanupSocket(ws));
});

function cleanupSocket(ws) {
  const { roomId, role } = ws;
  if (!roomId || !role) return;
  const room = rooms.get(roomId);
  if (!room) return;

  if (role === 'sender' && room.sender === ws) room.sender = null;
  if (role === 'receiver' && room.receiver === ws) room.receiver = null;

  const peer = role === 'sender' ? room.receiver : room.sender;
  send(peer, { type: 'peer-left' });
  touchRoom(roomId);

  if (!room.sender && !room.receiver) {
    rooms.delete(roomId);
  }
}

server.listen(PORT, HOST, () => {
  console.log(`Signaling server running on http://${HOST}:${PORT}`);
});
