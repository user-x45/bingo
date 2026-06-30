/**
 * Cloudflare Workers - オンラインビンゴサーバー (Durable Objects対応 & 安全な遅延タイムアウト)
 * * [デプロイ方法]
 * wrangler.toml に以下の設定を追加します。
 * * name = "bingo-backend"
 * main = "worker.js"
 * compatibility_date = "2026-06-30"
 * * [[durable_objects.bindings]]
 * name = "BINGO_ROOM"
 * class_name = "BingoRoom"
 * * [[migrations]]
 * tag = "v1"
 * new_classes = ["BingoRoom"]
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS プリフライトリクエストの処理
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Upgrade",
        },
      });
    }

    // WebSocket接続用のパス: /ws/{roomCode}
    if (url.pathname.startsWith("/ws/")) {
      const pathParts = url.pathname.split("/");
      const roomCode = pathParts[2];

      if (!roomCode || roomCode.length !== 6) {
        return new Response("無効なルームコードです。6文字の英数字を指定してください。", { 
          status: 400,
          headers: { "Access-Control-Allow-Origin": "*" }
        });
      }

      const id = env.BINGO_ROOM.idFromName(roomCode.toLowerCase());
      const stub = env.BINGO_ROOM.get(id);

      return stub.fetch(request);
    }

    return new Response("Cloudflare Bingo API サーバーは正常に稼働しています。", {
      status: 200,
      headers: { 
        "Content-Type": "text/plain; charset=utf-8",
        "Access-Control-Allow-Origin": "*" 
      }
    });
  }
};

// =========================================================================
// Durable Object: BingoRoom クラス
// =========================================================================
export class BingoRoom {
  constructor(state, env) {
    this.state = state;
    this.sessions = []; // ルームに現在接続しているすべてのアクティブなセッション
    this.gameState = {
      drawnNumbers: [], 
      users: {},       // セッションIDごとのユーザー情報: { [sessionId]: { name, isHost } }
      createdAt: Date.now(),
      lastActivity: Date.now()
    };

    // 保存されている永続化状態を復元
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get("gameState");
      if (stored) {
        this.gameState = stored;
      }
    });
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("WebSocket接続を期待しています。", { 
        status: 426,
        headers: { "Access-Control-Allow-Origin": "*" }
      });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    await this.handleSession(server);

    return new Response(null, { 
      status: 101, 
      webSocket: client,
      headers: { "Access-Control-Allow-Origin": "*" }
    });
  }

  async handleSession(webSocket) {
    webSocket.accept();

    const sessionId = crypto.randomUUID();
    const session = { 
      webSocket, 
      id: sessionId, 
      name: "ゲスト", 
      isHost: false 
    };

    // 接続上限30名制限
    if (this.sessions.length >= 30) {
      webSocket.send(JSON.stringify({ 
        type: "error", 
        message: "ルームが満員です。最大参加人数（30人）を超えています。" 
      }));
      webSocket.close(1008, "Room is full");
      return;
    }

    // 新たに接続があったため、予定されているクリーンアップタイマー(アラーム)をキャンセル
    await this.state.storage.deleteAlarm();

    this.sessions.push(session);

    webSocket.addEventListener("message", async (msg) => {
      try {
        const data = JSON.parse(msg.data);
        this.gameState.lastActivity = Date.now();

        switch (data.type) {
          case "join":
            session.name = data.name || "プレイヤー";
            session.isHost = !!data.isHost;

            this.gameState.users[sessionId] = { 
              name: session.name, 
              isHost: session.isHost 
            };

            await this.state.storage.put("gameState", this.gameState);

            this.broadcast({
              type: "state",
              drawnNumbers: this.gameState.drawnNumbers,
              users: Object.values(this.gameState.users),
              event: `${session.name} さんが参加しました！`
            });
            break;

          case "draw":
            if (session.isHost) {
              const num = parseInt(data.number, 10);
              if (num && num >= 1 && num <= 75 && !this.gameState.drawnNumbers.includes(num)) {
                this.gameState.drawnNumbers.push(num);
                
                await this.state.storage.put("gameState", this.gameState);

                this.broadcast({
                  type: "draw",
                  number: num,
                  drawnNumbers: this.gameState.drawnNumbers,
                  event: `ホストが数字【${num}】を引きました！`
                });
              }
            }
            break;

          case "kick_all":
            if (session.isHost) {
              this.broadcast({ 
                type: "kick_all", 
                message: "ホストにより全員が退室させられました。ゲームを終了します。" 
              });

              const activeSessions = [...this.sessions];
              this.sessions = [];
              
              activeSessions.forEach(s => {
                try {
                  s.webSocket.close(1000, "Kicked by host");
                } catch (e) {}
              });

              // ホスト自らがルームを完全に閉じたら即時消去
              await this.state.storage.delete("gameState");
              await this.state.storage.deleteAlarm();
            }
            break;
        }
      } catch (err) {
        console.error("メッセージの処理に失敗しました: ", err);
      }
    });

    webSocket.addEventListener("close", async () => {
      this.sessions = this.sessions.filter(s => s.id !== sessionId);
      delete this.gameState.users[sessionId];

      // セッションが完全に0人（無人）になった場合
      if (this.sessions.length === 0) {
        // 即座に消去するのではなく、30分間（1800000ms）のタイムアウト時間を設定し、自動でアラーム（クリーンアップ処理）をセット
        const timeoutMs = 30 * 60 * 1000; // 30分
        await this.state.storage.setAlarm(Date.now() + timeoutMs);
        
        await this.state.storage.put("gameState", this.gameState);
      } else {
        await this.state.storage.put("gameState", this.gameState);
        
        this.broadcast({
          type: "state",
          drawnNumbers: this.gameState.drawnNumbers,
          users: Object.values(this.gameState.users),
          event: `${session.name} さんが退出しました。`
        });
      }
    });

    webSocket.addEventListener("error", () => {
      this.sessions = this.sessions.filter(s => s.id !== sessionId);
    });
  }

  // クリーンアップのアラーム処理がキックされたとき（30分間誰も接続しなかった場合）
  async alarm() {
    // 完全にルームデータをストレージから消去してクリーンアップします
    await this.state.storage.delete("gameState");
  }

  broadcast(message) {
    const payload = JSON.stringify(message);
    this.sessions.forEach(s => {
      try {
        if (s.webSocket.readyState === 1) { 
          s.webSocket.send(payload);
        }
      } catch (err) {}
    });
  }
}
