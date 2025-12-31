// Minimal WebSocket signaling server for Deno / Deno Deploy.
// Handles: join, offer, answer, ice, leave. Maintains one sender + one receiver per room.

const rooms = new Map();
const MAX_PER_ROOM = 2;
const MAX_MESSAGE_BYTES = 64 * 1024;
const RATE_LIMIT_WINDOW_MS = 10_000;
const RATE_LIMIT_MAX = 60;
const ROOM_TTL_MS = 30 * 60 * 1000;
const rateLimit = new WeakMap();

function now() {
  return Date.now();
}

function touchRoom(id) {
  const room = rooms.get(id);
  if (room) room.touchedAt = now();
}

function getRoom(id) {
  if (!rooms.has(id)) {
    rooms.set(id, { sender: null, receiver: null, token: null, touchedAt: now() });
  }
  return rooms.get(id);
}

function send(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function cleanupStale() {
  const cutoff = now() - ROOM_TTL_MS;
  for (const [id, room] of rooms.entries()) {
    if (room.touchedAt < cutoff) {
      room.sender?.close();
      room.receiver?.close();
      rooms.delete(id);
    }
  }
}

setInterval(cleanupStale, 5 * 60 * 1000);

function enforceRate(ws) {
  const windowStart = now() - RATE_LIMIT_WINDOW_MS;
  const arr = rateLimit.get(ws) || [];
  const next = arr.filter((t) => t >= windowStart);
  next.push(now());
  rateLimit.set(ws, next);
  if (next.length > RATE_LIMIT_MAX) {
    ws.close(1013, 'rate limit');
    return false;
  }
  return true;
}

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

function handleSocket(ws) {
  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string' && new TextEncoder().encode(ev.data).length > MAX_MESSAGE_BYTES) {
      ws.close(1009, 'too big');
      return;
    }
    if (!enforceRate(ws)) return;

    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      ws.close(1003, 'bad json');
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
        send(ws, { type: 'error', message: 'bad token' });
        return;
      }
      if (!room.token) room.token = token;
      if (role === 'sender' && room.sender && room.sender !== ws) {
        send(ws, { type: 'error', message: 'sender exists' });
        return;
      }
      if (role === 'receiver' && room.receiver && room.receiver !== ws) {
        send(ws, { type: 'error', message: 'receiver exists' });
        return;
      }
      if ([room.sender, room.receiver].filter(Boolean).length >= MAX_PER_ROOM && ![room.sender, room.receiver].includes(ws)) {
        send(ws, { type: 'error', message: 'room full' });
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
      const room = rooms.get(ws.roomId);
      if (!room) {
        send(ws, { type: 'error', message: 'no room' });
        return;
      }
      const peer = ws.role === 'sender' ? room.receiver : room.sender;
      touchRoom(ws.roomId);
      send(peer, { type, data: msg.data });
      return;
    }

    if (type === 'leave') {
      cleanupSocket(ws);
      return;
    }

    send(ws, { type: 'error', message: 'unknown type' });
  };

  ws.onclose = () => cleanupSocket(ws);
  ws.onerror = () => cleanupSocket(ws);
}

Deno.serve((req) => {
  const { pathname } = new URL(req.url);

  if (pathname === '/health') {
    return new Response(JSON.stringify({ status: 'ok' }), {
      headers: { 'content-type': 'application/json' },
    });
  }

  if (pathname === '/ws') {
    const { response, socket } = Deno.upgradeWebSocket(req);
    handleSocket(socket);
    return response;
  }

  return new Response('ok', { status: 200 });
});
