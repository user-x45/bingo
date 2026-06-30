/**
 * Cloudflare Workers - オンラインビンゴサーバー (Durable Objects対応)
 * * [デプロイ方法]
 * 1. wrangler.toml に以下の設定を追加します。
 * * name = "bingo-backend"
 * main = "worker.js"
 * compatibility_date = "2026-06-30"
 * * [[durable_objects.bindings]]
 * name = "BINGO_ROOM"
 * class_name = "BingoRoom"
 * * [[migrations]]
 * tag = "v1"
 * new_classes = ["BingoRoom"]
 * */

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

      // Durable ObjectのIDを一意のルームコードから生成または取得
      const id = env.BINGO_ROOM.idFromName(roomCode.toLowerCase());
      const stub = env.BINGO_ROOM.get(id);

      // Durable Objectにリクエストを転送
      return stub.fetch(request);
    }

    // インデックスまたはその他の無効なパス
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
// 各ビンゴルームの独立したリアルタイムステートと接続セッションを管理
// =========================================================================
export class BingoRoom {
  constructor(state, env) {
    this.state = state;
    this.sessions = []; // ルームに現在接続しているすべてのアクティブなセッション
    this.gameState = {
      drawnNumbers: [], // 既に引かれた数字の配列
      users: {},       // セッションIDごとのユーザー情報: { [sessionId]: { name, isHost } }
      createdAt: Date.now(),
      lastActivity: Date.now()
    };

    // 保存されている永続化状態を復元（再起動や退避への対策）
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get("gameState");
      if (stored) {
        this.gameState = stored;
      }
    });
  }

  async fetch(request) {
    // WebSocketアップグレード要求の検証
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("WebSocket接続を期待しています。", { 
        status: 426,
        headers: { "Access-Control-Allow-Origin": "*" }
      });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // 接続処理を開始
    await this.handleSession(server);

    return new Response(null, { 
      status: 101, 
      webSocket: client,
      headers: { "Access-Control-Allow-Origin": "*" }
    });
  }

  async handleSession(webSocket) {
    webSocket.accept();

    // 接続ごとに一意のセッションIDを生成
    const sessionId = crypto.randomUUID();
    const session = { 
      webSocket, 
      id: sessionId, 
      name: "ゲスト", 
      isHost: false 
    };

    // 最大参加人数を30名に制限するガードレール
    if (this.sessions.length >= 30) {
      webSocket.send(JSON.stringify({ 
        type: "error", 
        message: "ルームが満員です。最大参加人数（30人）を超えています。" 
      }));
      webSocket.close(1008, "Room is full");
      return;
    }

    this.sessions.push(session);

    // メッセージ受信イベント
    webSocket.addEventListener("message", async (msg) => {
      try {
        const data = JSON.parse(msg.data);
        this.gameState.lastActivity = Date.now();

        switch (data.type) {
          case "join":
            // ルーム入室・初期化
            session.name = data.name || "プレイヤー";
            session.isHost = !!data.isHost;

            this.gameState.users[sessionId] = { 
              name: session.name, 
              isHost: session.isHost 
            };

            // 永続化ストレージに保存
            await this.state.storage.put("gameState", this.gameState);

            // 全接続者へルーム最新状態をブロードキャスト
            this.broadcast({
              type: "state",
              drawnNumbers: this.gameState.drawnNumbers,
              users: Object.values(this.gameState.users),
              event: `${session.name} さんが参加しました！`
            });
            break;

          case "draw":
            // 数字の抽選処理 (ホスト権限チェック)
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
            // ホストによる全員の強制退出
            if (session.isHost) {
              this.broadcast({ 
                type: "kick_all", 
                message: "ホストにより全員が退出させられました。ゲームを終了します。" 
              });

              // すべての接続セッションを切断
              const activeSessions = [...this.sessions];
              this.sessions = [];
              
              activeSessions.forEach(s => {
                try {
                  s.webSocket.close(1000, "Kicked by host");
                } catch (e) {}
              });

              // ストレージから状態を削除
              await this.state.storage.delete("gameState");
            }
            break;
        }
      } catch (err) {
        console.error("メッセージの処理に失敗しました: ", err);
      }
    });

    // 接続解除イベント
    webSocket.addEventListener("close", async () => {
      this.sessions = this.sessions.filter(s => s.id !== sessionId);
      delete this.gameState.users[sessionId];

      // ルームに誰もいなくなった場合は、Durable Object内のデータもクリアして自動タイムアウト
      if (this.sessions.length === 0) {
        await this.state.storage.delete("gameState");
      } else {
        await this.state.storage.put("gameState", this.gameState);
        
        // 残っているユーザーに通知
        this.broadcast({
          type: "state",
          drawnNumbers: this.gameState.drawnNumbers,
          users: Object.values(this.gameState.users),
          event: `${session.name} さんが退出しました。`
        });
      }
    });

    // エラーハンドリング
    webSocket.addEventListener("error", () => {
      // 接続異常時も安全にセッションリストから削除
      this.sessions = this.sessions.filter(s => s.id !== sessionId);
    });
  }

  // ルームに接続中の全員にメッセージを送信するヘルパー関数
  broadcast(message) {
    const payload = JSON.stringify(message);
    this.sessions.forEach(s => {
      try {
        if (s.webSocket.readyState === 1) { // OPEN の場合のみ送信
          s.webSocket.send(payload);
        }
      } catch (err) {
        console.error("ブロードキャスト中にエラーが発生しました: ", err);
      }
    });
  }
}
