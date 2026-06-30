const INACTIVE_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const EMPTY_ROOM_TIMEOUT_MS = 5 * 60 * 1000;

export class BingoRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map();
    this.drawnNumbers = [];
    this.users = [];

    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get('roomData');
      if (stored) {
        this.drawnNumbers = stored.drawnNumbers || [];
        this.users = stored.users || [];
      }
    });
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected websocket', { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.handleSession(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  handleSession(webSocket) {
    webSocket.accept();
    const sessionId = crypto.randomUUID();
    this.sessions.set(sessionId, { webSocket, user: null });

    webSocket.addEventListener('message', (event) => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch (e) {
        return;
      }
      this.handleMessage(sessionId, data);
    });

    const onClose = () => this.handleClose(sessionId);
    webSocket.addEventListener('close', onClose);
    webSocket.addEventListener('error', onClose);
  }

  async persist() {
    await this.state.storage.put('roomData', {
      drawnNumbers: this.drawnNumbers,
      users: this.users
    });
  }

  async resetInactiveAlarm() {
    await this.state.storage.setAlarm(Date.now() + INACTIVE_TIMEOUT_MS);
  }

  async setEmptyRoomAlarm() {
    await this.state.storage.setAlarm(Date.now() + EMPTY_ROOM_TIMEOUT_MS);
  }

  async alarm() {
    this.drawnNumbers = [];
    this.users = [];
    await this.state.storage.deleteAll();
  }

  async handleMessage(sessionId, data) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (data.type === 'join') {
      if (this.users.length >= 30) {
        this.sendTo(session.webSocket, {
          type: 'error',
          message: 'このルームは満員です（最大30人）'
        });
        session.webSocket.close();
        return;
      }

      const name = String(data.name || 'プレイヤー').slice(0, 15);
      const isHost = !!data.isHost;

      if (!isHost && !this.users.some(u => u.isHost)) {
        this.sendTo(session.webSocket, {
          type: 'error',
          message: 'ホストがいないルームには参加できません。ホストが先にルームを作成してください。'
        });
        session.webSocket.close();
        return;
      }

      session.user = { name, isHost };

      const existing = this.users.find(u => u.name === name);
      if (!existing) {
        this.users.push({ name, isHost });
      }

      await this.persist();
      await this.resetInactiveAlarm();

      this.broadcast({
        type: 'state',
        drawnNumbers: this.drawnNumbers,
        users: this.users,
        event: `${name} さんが参加しました！`
      });
      return;
    }

    if (data.type === 'draw') {
      const num = Number(data.number);
      if (!Number.isInteger(num) || num < 1 || num > 75) return;
      if (this.drawnNumbers.includes(num)) return;

      this.drawnNumbers.push(num);
      await this.persist();
      await this.resetInactiveAlarm();

      this.broadcast({
        type: 'draw',
        number: num,
        drawnNumbers: this.drawnNumbers,
        event: `ホストが数字【${num}】を引きました！`
      });
      return;
    }

    if (data.type === 'kick_all') {
      this.drawnNumbers = [];
      this.users = [];
      await this.state.storage.deleteAll();

      this.broadcast({
        type: 'kick_all',
        message: 'ホストにより全員が退室させられました。ゲームを終了します。'
      });

      for (const [, s] of this.sessions) {
        try {
          s.webSocket.close();
        } catch (e) {}
      }
      this.sessions.clear();
    }
  }

  async handleClose(sessionId) {
    const session = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);

    if (session && session.user) {
      this.users = this.users.filter(u => u.name !== session.user.name);
      await this.persist();

      if (this.users.length === 0) {
        await this.setEmptyRoomAlarm();
      } else {
        await this.resetInactiveAlarm();
      }

      this.broadcast({
        type: 'state',
        drawnNumbers: this.drawnNumbers,
        users: this.users,
        event: `${session.user.name} さんが退室しました`
      });
    }
  }

  sendTo(webSocket, message) {
    try {
      webSocket.send(JSON.stringify(message));
    } catch (e) {}
  }

  broadcast(message) {
    const str = JSON.stringify(message);
    for (const [id, session] of this.sessions) {
      try {
        session.webSocket.send(str);
      } catch (e) {
        this.sessions.delete(id);
      }
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/ws/')) {
      const roomCode = url.pathname.slice('/ws/'.length).toLowerCase();
      if (!roomCode) {
        return new Response('Room code required', { status: 400 });
      }
      const id = env.BINGO_ROOM.idFromName(roomCode);
      const stub = env.BINGO_ROOM.get(id);
      return stub.fetch(request);
    }

    return new Response('Bingo WebSocket server is running.', {
      status: 200,
      headers: { 'content-type': 'text/plain;charset=UTF-8' }
    });
  }
};
