// ============================================================
// HarramBall Röle Sunucusu (v2 - PeerJS uyumlu, basit)
// ============================================================
// NE YAPAR: Oyunun mevcut kodu "peer ID" mantığıyla çalışıyor
// (host'un peer ID'si = oda ID'si, oyuncular birbirine peer ID
// ile bağlanıyor). Bu sunucu odaları/takımları falan BİLMEZ -
// sadece "şu ID'li istemciye şu veriyi ilet" işini yapar, tıpkı
// PeerJS'in P2P bağlantısının yaptığı gibi, ama gerçek bir
// sunucu üzerinden (daha güvenilir, host'a bağımlı değil).
//
// ÇALIŞTIRMA: npm install && node server.js
// RENDER: Build Command "npm install", Start Command "node server.js"

const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const idToSocket = new Map(); // peerId -> socket

const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('HarramBall röle sunucusu ayakta. Bağlı istemci: ' + idToSocket.size);
});

const io = new Server(server, { cors: { origin: '*' }, pingInterval: 5000, pingTimeout: 10000 });

io.on('connection', (socket) => {
    let myId = null;

    // İstemci kendi kalıcı ID'sini (localStorage'daki harramball_unique_id) bildirir
    socket.on('register', (id) => {
        myId = id;
        const old = idToSocket.get(id);
        if (old && old !== socket) { try { old.disconnect(true); } catch (e) {} }
        idToSocket.set(id, socket);
        socket.data.peerId = id;
        socket.emit('registered', { id });
    });

    // A, B'ye bağlanmak istiyor (PeerJS'teki peer.connect(remoteId) karşılığı)
    socket.on('connect_to', ({ to }) => {
        const target = idToSocket.get(to);
        if (target) {
            target.emit('incoming_connection', { from: myId });
            socket.emit('connect_ack', { to, ok: true });
        } else {
            socket.emit('connect_ack', { to, ok: false, reason: 'offline' });
        }
    });

    // B, A'nın bağlantı isteğini kabul ettiğini bildirir
    socket.on('accept_connection', ({ to }) => {
        const target = idToSocket.get(to);
        if (target) target.emit('connection_opened', { from: myId });
        socket.emit('connection_opened', { from: to });
    });

    // Asıl veri iletimi (conn.send() karşılığı)
    socket.on('relay', ({ to, data }) => {
        const target = idToSocket.get(to);
        if (target) target.emit('relay', { from: myId, data });
    });

    socket.on('disconnect', () => {
        if (myId && idToSocket.get(myId) === socket) {
            idToSocket.delete(myId);
            io.emit('peer_disconnected', { id: myId });
        }
    });
});

server.listen(PORT, () => {
    console.log('HarramBall röle sunucusu ' + PORT + ' portunda çalışıyor.');
});
