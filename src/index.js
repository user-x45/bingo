// Cloudflare Workers バックエンドスクリプト
// KV またはインメモリ（Durable Objects）を利用してルーム情報を保持します。
// ここでは簡易かつ高速なメモリ状態同期用のWorkerスクリプトを提供します。

const rooms = new Map(); // ルームデータのインメモリ保持用（シンプルな動作検証用）

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    // CORSのプリフライトリクエストに対応
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // 1. ルームの新規作成 API
      if (url.pathname === '/api/room' && request.method === 'POST') {
        const body = await request.json();
        const roomId = Math.floor(1000 + Math.random() * 9000).toString(); // 4桁の部屋ID
        
        rooms.set(roomId, {
          id: roomId,
          hostId: body.hostId,
          drawnNumbers: [],
          players: [
            { id: body.hostId, name: "ホスト", markedCount: 0, isReach: false, isBingo: false, lastSeen: Date.now() }
          ],
          createdAt: Date.now()
        });

        return new Response(JSON.stringify({ success: true, roomId }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      // 2. ルームへの入室（ゲスト用） API
      if (url.pathname.match(/^\/api\/room\/\d+\/join$/) && request.method === 'POST') {
        const roomId = url.pathname.split('/')[3];
        const body = await request.json();
        const room = rooms.get(roomId);

        if (!room) {
          return new Response(JSON.stringify({ success: false, message: 'ルームが見つかりません。' }), {
            status: 404,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        // プレイヤーが未追加ならリストに追加
        const playerExists = room.players.some(p => p.id === body.clientId);
        if (!playerExists) {
          room.players.push({
            id: body.clientId,
            name: `ゲスト_${body.clientId.substring(5, 8)}`,
            markedCount: 0,
            isReach: false,
            isBingo: false,
            lastSeen: Date.now()
          });
        }

        return new Response(JSON.stringify({ success: true }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      // 3. リアルタイム状態同期 API
      if (url.pathname.match(/^\/api\/room\/\d+\/sync$/) && request.method === 'POST') {
        const roomId = url.pathname.split('/')[3];
        const body = await request.json();
        const room = rooms.get(roomId);

        if (!room) {
          return new Response(JSON.stringify({ success: false, message: 'ルームが破棄されたか存在しません。' }), {
            status: 404,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        // 送信してきたクライアントの情報を更新
        const player = room.players.find(p => p.id === body.clientId);
        if (player) {
          player.markedCount = body.markedCount;
          player.isReach = body.isReach;
          player.isBingo = body.isBingo;
          player.lastSeen = Date.now();
        } else {
          room.players.push({
            id: body.clientId,
            name: `プレイヤー_${body.clientId.substring(5, 8)}`,
            markedCount: body.markedCount,
            isReach: body.isReach,
            isBingo: body.isBingo,
            lastSeen: Date.now()
          });
        }

        // ホスト（親）が引いた数字の履歴を同期
        if (body.isHost && body.drawnNumbers && body.drawnNumbers.length > 0) {
          room.drawnNumbers = body.drawnNumbers;
        }

        // タイムアウトした古いプレイヤーのクリーンアップ（約30秒通信のない人を削除）
        room.players = room.players.filter(p => Date.now() - p.lastSeen < 30000);

        return new Response(JSON.stringify({
          success: true,
          drawnNumbers: room.drawnNumbers,
          players: room.players
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      return new Response('Miracle Bingo Cloudflare Endpoint', { status: 200 });

    } catch (err) {
      return new Response(JSON.stringify({ success: false, error: err.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
  }
};
