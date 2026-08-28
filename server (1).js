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
const knownContacts = new Map(); // peerId -> Set<peerId> (kimlerle mesajlaştığını biliyoruz)

function linkContacts(a, b) {
    if (!a || !b) return;
    if (!knownContacts.has(a)) knownContacts.set(a, new Set());
    if (!knownContacts.has(b)) knownContacts.set(b, new Set());
    knownContacts.get(a).add(b);
    knownContacts.get(b).add(a);
}

const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('HarramBall röle sunucusu ayakta. Bağlı istemci: ' + idToSocket.size);
});

const io = new Server(server, {
    cors: { origin: '*' },
    pingInterval: 5000,
    pingTimeout: 10000,
    // OPTİMİZASYON 1: WebSocket sıkıştırmasını (permessage-deflate) kapattık.
    // Sıkıştırma her mesajda CPU harcıyor - bizim mesajlarımız zaten küçük
    // (pozisyon/top verisi), sıkıştırmanın kazancı yok ama maliyeti var.
    // Bedava planın kısıtlı CPU'sunda bu, gerçek bir fark yaratıyor.
    perMessageDeflate: false,
    // OPTİMİZASYON 2: socket.io'nun kendi istemci dosyalarını sunmasını kapattık
    // (biz zaten CDN'den yüklüyoruz) - gereksiz dosya sunumu CPU/RAM harcar.
    serveClient: false
});

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
            linkContacts(myId, to);
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

    // Bilinçli bağlantı kapatma (conn.close() karşılığı) - eskiden bu hiç yoktu,
    // yüzünden "odadan çıkan oyuncunun karakteri sahada kalıyordu" bug'ı vardı.
    socket.on('close_connection', ({ to }) => {
        const target = idToSocket.get(to);
        if (target) target.emit('connection_closed', { from: myId });
    });

    socket.on('disconnect', () => {
        if (myId && idToSocket.get(myId) === socket) {
            idToSocket.delete(myId);
            // OPTİMİZASYON 3: eskiden io.emit(...) ile SUNUCUDAKİ HERKESE haber
            // gidiyordu - 50 kişi varsa her ayrılışta 50 gereksiz mesaj demekti.
            // Artık sadece gerçekten bu oyuncuyla mesajlaşmış olanlara gidiyor.
            const contacts = knownContacts.get(myId);
            if (contacts) {
                contacts.forEach(cid => {
                    const s = idToSocket.get(cid);
                    if (s) s.emit('peer_disconnected', { id: myId });
                    const set = knownContacts.get(cid);
                    if (set) set.delete(myId);
                });
                knownContacts.delete(myId);
            }
        }
    });
});

server.listen(PORT, () => {
    console.log('HarramBall röle sunucusu ' + PORT + ' portunda çalışıyor.');
});
