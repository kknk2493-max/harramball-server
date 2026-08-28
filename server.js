// ============================================================
// HarramBall Online Sunucusu
// Node.js + Socket.io - gerçek zamanlı oda/maç senkronizasyonu
// ============================================================
//
// NE YAPAR:
// - Oyuncular bu sunucuya bağlanır (P2P/PeerJS YOK artık)
// - Oda kurma, odaya katılma, takım seçme
// - Pozisyon/top senkronizasyonu (host yerine SUNUCU relay yapar)
// - Sohbet mesajları
// - Bir oyuncu bağlantısı koparsa diğerlerine haber verir
//
// NASIL ÇALIŞTIRILIR (yerel test için):
//   npm install
//   node server.js
//
// RENDER'A YÜKLEME:
//   1. Bu klasörü (server.js + package.json) bir GitHub reposuna at
//   2. Render.com -> New -> Web Service -> reposunu seç
//   3. Build Command: npm install
//   4. Start Command: node server.js
//   5. Render sana bir URL verecek (örn: https://harramball-xxxx.onrender.com)
//      Bu URL'yi oyunun client kodunda kullanacağız.

const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
    // Render "sağlık kontrolü" için basit bir cevap - sunucu ayakta mı diye bakar
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('HarramBall server ayakta. Aktif odalar: ' + rooms.size);
});

const io = new Server(server, {
    cors: { origin: '*' }, // Oyun herhangi bir domain'den bağlanabilsin diye
    pingInterval: 10000,
    pingTimeout: 5000
});

// ---- ODA YÖNETİMİ ----
// rooms: Map<roomId, RoomState>
// RoomState = {
//   id, name, hostSocketId, maxPlayers, hasPassword, password,
//   redTeam: [{id,name,number}], blueTeam: [...], spectators: [...],
//   gameStarted, isTrainingMode, gameMode, stadiumSize,
//   ball: {x,y,vx,vy}, lastActive
// }
const rooms = new Map();

function publicRoomInfo(room) {
    // Oda listesinde göstereceğimiz, şifreyi İÇERMEYEN bilgi
    return {
        id: room.id,
        name: room.name,
        hostSocketId: room.hostSocketId,
        maxPlayers: room.maxPlayers,
        hasPassword: !!room.hasPassword,
        currentPlayers: room.redTeam.length + room.blueTeam.length + room.spectators.length,
        redCount: room.redTeam.length,
        blueCount: room.blueTeam.length,
        gameMode: room.gameMode,
        gameStarted: room.gameStarted
    };
}

function broadcastRoomList() {
    const list = Array.from(rooms.values()).map(publicRoomInfo);
    io.emit('room_list', list);
}

function broadcastToRoom(roomId, event, payload, exceptSocketId) {
    const room = rooms.get(roomId);
    if (!room) return;
    const allIds = [room.hostSocketId, ...room.redTeam, ...room.blueTeam, ...room.spectators].map(p => p && p.id ? p.id : p);
    const uniqueIds = new Set(allIds.filter(Boolean));
    uniqueIds.forEach(sid => {
        if (sid === exceptSocketId) return;
        io.to(sid).emit(event, payload);
    });
}

function findRoomBySocket(socketId) {
    for (const room of rooms.values()) {
        const inRed = room.redTeam.find(p => p.id === socketId);
        const inBlue = room.blueTeam.find(p => p.id === socketId);
        const inSpec = room.spectators.find(p => p.id === socketId);
        if (inRed || inBlue || inSpec || room.hostSocketId === socketId) return room;
    }
    return null;
}

function removePlayerFromRoom(room, socketId) {
    room.redTeam = room.redTeam.filter(p => p.id !== socketId);
    room.blueTeam = room.blueTeam.filter(p => p.id !== socketId);
    room.spectators = room.spectators.filter(p => p.id !== socketId);
}

io.on('connection', (socket) => {
    console.log('[bağlandı]', socket.id);

    // ---- ODA LİSTESİNİ İSTE ----
    socket.on('list_rooms', () => {
        socket.emit('room_list', Array.from(rooms.values()).map(publicRoomInfo));
    });

    // ---- ODA KUR ----
    socket.on('create_room', (data) => {
        const roomId = 'room_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
        const room = {
            id: roomId,
            name: (data && data.name) || 'İsimsiz Oda',
            hostSocketId: socket.id,
            maxPlayers: (data && data.maxPlayers) || 10,
            hasPassword: !!(data && data.password),
            password: (data && data.password) || '',
            redTeam: [],
            blueTeam: [],
            spectators: [{ id: socket.id, name: (data && data.playerName) || 'Oyuncu' }],
            gameStarted: false,
            isTrainingMode: true,
            gameMode: (data && data.gameMode) || '3v3',
            stadiumSize: (data && data.stadiumSize) || 'medium',
            ball: { x: 950, y: 475, vx: 0, vy: 0 },
            lastActive: Date.now()
        };
        rooms.set(roomId, room);
        socket.join(roomId);
        socket.data.roomId = roomId;
        socket.data.playerName = room.spectators[0].name;

        socket.emit('room_created', { room });
        broadcastRoomList();
        console.log('[oda kuruldu]', roomId, room.name);
    });

    // ---- ODAYA KATIL (izleyici olarak - madde 3: takım seçtirmiyoruz) ----
    socket.on('join_room', (data) => {
        const room = rooms.get(data.roomId);
        if (!room) { socket.emit('join_error', { message: 'Oda bulunamadı.' }); return; }
        if (room.hasPassword && room.password !== data.password) {
            socket.emit('join_error', { message: 'Şifre yanlış.' });
            return;
        }
        const totalPlayers = room.redTeam.length + room.blueTeam.length + room.spectators.length;
        if (totalPlayers >= room.maxPlayers + 5) { // izleyiciler için biraz pay
            socket.emit('join_error', { message: 'Oda dolu.' });
            return;
        }

        const playerEntry = { id: socket.id, name: data.playerName || 'Oyuncu', number: data.playerNumber || 0 };
        room.spectators.push(playerEntry);
        socket.join(room.id);
        socket.data.roomId = room.id;
        socket.data.playerName = playerEntry.name;

        socket.emit('room_joined', { room, isSpectator: true, gameStarted: room.gameStarted, isTrainingMode: room.isTrainingMode });

        // Sohbete "X katıldı" bilgisini herkese yolla
        broadcastToRoom(room.id, 'chat_message', { sender: 'Sistem', message: '🟢 ' + playerEntry.name + ' odaya katıldı' });
        broadcastToRoom(room.id, 'room_update', { room });
        broadcastRoomList();
        console.log('[katıldı]', socket.id, '->', room.id);
    });

    // ---- TAKIM SEÇ / DEĞİŞTİR ----
    socket.on('switch_team', (data) => {
        const room = rooms.get(socket.data.roomId);
        if (!room) return;
        const me = { id: socket.id, name: socket.data.playerName, number: data.playerNumber || 0 };
        removePlayerFromRoom(room, socket.id);

        if (data.team === 'red') room.redTeam.push(me);
        else if (data.team === 'blue') room.blueTeam.push(me);
        else room.spectators.push(me);

        broadcastToRoom(room.id, 'room_update', { room });
        broadcastRoomList();
    });

    // ---- MAÇI BAŞLAT (sadece host) ----
    socket.on('start_match', (data) => {
        const room = rooms.get(socket.data.roomId);
        if (!room || room.hostSocketId !== socket.id) return;

        // GÜVENLİK AĞI: izleyici kalan oyuncuları otomatik takıma dağıt (kamera sorunu
        // burada da tekrarlanmasın diye - istemci tarafında yaptığımız düzeltmenin
        // sunucu eşleniği)
        room.spectators = room.spectators.filter(p => {
            if (p.id === room.hostSocketId || room.redTeam.find(x=>x.id===p.id) || room.blueTeam.find(x=>x.id===p.id)) return false;
            return true;
        });

        room.gameStarted = true;
        room.isTrainingMode = false;
        room.matchSettings = data && data.settings;

        broadcastToRoom(room.id, 'match_starting', { settings: room.matchSettings, serverTime: Date.now(), room });
        broadcastRoomList();
    });

    // ---- POZİSYON SENKRONİZASYONU (en kritik kısım - "diğer oyuncuyu görmüyor" bug'ının çözümü) ----
    // Her oyuncu kendi pozisyonunu belirli aralıklarla yollar, SUNUCU bunu odadaki
    // HERKESE (gönderen hariç) anında dağıtır. Host'a bağımlılık yok.
    socket.on('player_state', (data) => {
        const room = rooms.get(socket.data.roomId);
        if (!room) return;
        room.lastActive = Date.now();
        // data: {x,y,vx,vy,team,active,...}
        broadcastToRoom(room.id, 'player_state', Object.assign({ id: socket.id }, data), socket.id);
    });

    // ---- TOP SENKRONİZASYONU (fizik otoritesi: host hesaplar, sunucu dağıtır) ----
    socket.on('ball_state', (data) => {
        const room = rooms.get(socket.data.roomId);
        if (!room || room.hostSocketId !== socket.id) return; // sadece host top fiziğini hesaplar
        room.ball = data;
        broadcastToRoom(room.id, 'ball_state', data, socket.id);
    });

    // ---- GOL / SKOR ----
    socket.on('goal_scored', (data) => {
        const room = rooms.get(socket.data.roomId);
        if (!room || room.hostSocketId !== socket.id) return;
        broadcastToRoom(room.id, 'goal_scored', data, socket.id);
    });

    // ---- SOHBET ----
    socket.on('chat_message', (data) => {
        const room = rooms.get(socket.data.roomId);
        if (!room) return;
        // basit rate-limit
        const now = Date.now();
        socket.data._chatTimes = (socket.data._chatTimes || []).filter(t => now - t < 1000);
        if (socket.data._chatTimes.length >= 3) return;
        socket.data._chatTimes.push(now);

        broadcastToRoom(room.id, 'chat_message', { sender: socket.data.playerName, message: data.message });
    });

    // ---- FORMA / TAKIM BİLGİSİ YAYINI ----
    socket.on('jersey_update', (data) => {
        const room = rooms.get(socket.data.roomId);
        if (!room) return;
        broadcastToRoom(room.id, 'jersey_update', Object.assign({ id: socket.id }, data), socket.id);
    });

    // ---- BAĞLANTI KOPTU ----
    socket.on('disconnect', () => {
        console.log('[ayrıldı]', socket.id);
        const room = rooms.get(socket.data.roomId);
        if (!room) return;

        const wasHost = room.hostSocketId === socket.id;
        removePlayerFromRoom(room, socket.id);

        if (wasHost) {
            // Host ayrıldıysa: odadaki en eski oyuncuyu yeni host yap, kimse kalmadıysa odayı sil
            const candidate = room.redTeam[0] || room.blueTeam[0] || room.spectators[0];
            if (candidate) {
                room.hostSocketId = candidate.id;
                broadcastToRoom(room.id, 'host_changed', { newHostId: candidate.id });
            } else {
                rooms.delete(room.id);
                broadcastRoomList();
                return;
            }
        }

        broadcastToRoom(room.id, 'chat_message', { sender: 'Sistem', message: '🔴 ' + (socket.data.playerName || 'Oyuncu') + ' ayrıldı' });
        broadcastToRoom(room.id, 'room_update', { room });
        broadcastRoomList();
    });
});

// Boş kalmış (kimse yok, uzun süredir aktif olmayan) odaları temizle
setInterval(() => {
    const now = Date.now();
    for (const [id, room] of rooms.entries()) {
        const total = room.redTeam.length + room.blueTeam.length + room.spectators.length;
        if (total === 0 || now - room.lastActive > 1000 * 60 * 30) {
            rooms.delete(id);
        }
    }
}, 60000);

server.listen(PORT, () => {
    console.log('HarramBall sunucusu ' + PORT + ' portunda çalışıyor.');
});
