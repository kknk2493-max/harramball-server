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
const { RoomPhysics } = require('./physics.js');

const PORT = process.env.PORT || 3000;
const idToSocket = new Map(); // peerId -> socket
const knownContacts = new Map(); // peerId -> Set<peerId> (kimlerle mesajlaştığını biliyoruz)

// ============================================================
// FAZ 1 - SUNUCU FİZİK OTORİTESİ
// ============================================================
// physicsRooms: roomId -> RoomPhysics (her maçın kendi fizik durumu)
// roomMembers: roomId -> Set<peerId> (o maçtaki herkes - snapshot kime gidecek)
// peerToRoom: peerId -> roomId (biri koptuğunda hangi odadan çıkaracağımızı bilelim)
const physicsRooms = new Map();
const roomMembers = new Map();
const peerToRoom = new Map();

function linkContacts(a, b) {
    if (!a || !b) return;
    if (!knownContacts.has(a)) knownContacts.set(a, new Set());
    if (!knownContacts.has(b)) knownContacts.set(b, new Set());
    knownContacts.get(a).add(b);
    knownContacts.get(b).add(a);
}

const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('HarramBall sunucusu ayakta. Bağlı istemci: ' + idToSocket.size + ', aktif maç: ' + physicsRooms.size);
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

    // ---- FAZ 1: SUNUCU FİZİK ODASI ----
    // İstemci "artık bu maçtayım, fiziği sen hesapla" diyor. roomId = host'un
    // peer ID'si (istemcideki mevcut oda kimliği mantığıyla birebir aynı).
    socket.on('join_physics_room', ({ roomId, mapSize, team }) => {
        if (!roomId || !myId) return;
        if (!physicsRooms.has(roomId)) {
            physicsRooms.set(roomId, new RoomPhysics(mapSize || 'medium'));
            roomMembers.set(roomId, new Set());
        }
        physicsRooms.get(roomId).addPlayer(myId, team === 'red' ? 'red' : 'blue');
        roomMembers.get(roomId).add(myId);
        peerToRoom.set(myId, roomId);
        // OPTİMİZASYON: socket.io'nun kendi "oda" (room) mekanizmasına katılıyoruz.
        // Böylece her tik'te üye üye tek tek emit etmek yerine TEK bir yayın
        // yapıp socket.io'nun kendi içinde dağıtmasını sağlıyoruz - JSON'u her
        // oyuncu için ayrı ayrı hazırlamak yerine BİR KERE hazırlıyor. Bedava
        // planın kısıtlı CPU'sunda bu, gerçek bir fark yaratıyor.
        socket.join('phys_' + roomId);
    });

    socket.on('leave_physics_room', () => {
        const roomId = peerToRoom.get(myId);
        if (!roomId) return;
        const rp = physicsRooms.get(roomId);
        if (rp) rp.removePlayer(myId);
        const members = roomMembers.get(roomId);
        if (members) { members.delete(myId); if (members.size === 0) { physicsRooms.delete(roomId); roomMembers.delete(roomId); } }
        peerToRoom.delete(myId);
        socket.leave('phys_' + roomId);
    });

    // OPTİMİZASYON (v1.2): İstemci artık TEK bir mesajda hem yönünü hem
    // gerçek konumunu bildiriyor - eskiden 2 ayrı mesaj vardı (60/sn x 2),
    // bu da bedava sunucunun kısıtlı CPU'sunu tıkayıp ping'i 2-3 saniyeye
    // fırlatmıştı. Şimdi tek mesaj, saniyede sadece ~20 kere geliyor.
    socket.on('player_state', ({ x, y, vx, vy, dx, dy, running, kick }) => {
        const roomId = peerToRoom.get(myId);
        if (!roomId) return;
        const rp = physicsRooms.get(roomId);
        if (!rp) return;
        rp.setInput(myId, { dx, dy, running, kick });
        rp.setReportedPosition(myId, x, y, vx, vy);
    });

    // Geriye dönük uyumluluk (eski istemciler için) - kullanılmıyorsa zararsız
    socket.on('player_input', (input) => {
        const roomId = peerToRoom.get(myId);
        if (!roomId) return;
        const rp = physicsRooms.get(roomId);
        if (rp) rp.setInput(myId, input);
    });
    socket.on('player_position', ({ x, y, vx, vy }) => {
        const roomId = peerToRoom.get(myId);
        if (!roomId) return;
        const rp = physicsRooms.get(roomId);
        if (rp) rp.setReportedPosition(myId, x, y, vx, vy);
    });

    socket.on('disconnect', () => {
        if (myId && idToSocket.get(myId) === socket) {
            idToSocket.delete(myId);
            // Fizik odasından da temizle
            const roomId = peerToRoom.get(myId);
            if (roomId) {
                const rp = physicsRooms.get(roomId);
                if (rp) rp.removePlayer(myId);
                const members = roomMembers.get(roomId);
                if (members) { members.delete(myId); if (members.size === 0) { physicsRooms.delete(roomId); roomMembers.delete(roomId); } }
                peerToRoom.delete(myId);
            }
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

// ============================================================
// FİZİK TİK DÖNGÜSÜ
// ============================================================
// OPTİMİZASYON: fizik hesaplama (step) hassasiyet için 60fps'de kalıyor,
// ama ağa YAYIN (broadcast) 30fps'e düşürüldü - göz farkı hissetmiyor
// ama mesaj/CPU yükünü YARIYA indiriyor (bedava planın kısıtlı CPU'sunda
// bu, ping'i düşürmede en büyük etkiyi yapan değişiklik).
// Ayrıca "volatile" kullanıyoruz: sunucu o an tıkanıksa eski/gecikmiş
// bir anlık görüntüyü kuyruğa atmak yerine ATLIYOR - böylece gecikme
// birikip büyümüyor, her zaman EN GÜNCEL veri gönderiliyor.
const TICK_MS = 16;       // fizik hassasiyeti: ~60fps
const BROADCAST_MS = 33;  // ağa yayın: ~30fps
let _tickAcc = 0;

setInterval(() => {
    physicsRooms.forEach((rp, roomId) => {
        const result = rp.step(TICK_MS);
        if (result.goal) {
            // Gol nadir olur ve önemlidir - volatile DEĞİL, kesin ulaşsın
            io.to('phys_' + roomId).emit('goal_scored', { team: result.goal });
        }
    });
}, TICK_MS);

setInterval(() => {
    physicsRooms.forEach((rp, roomId) => {
        const snapshot = rp.getSnapshot();
        io.to('phys_' + roomId).volatile.emit('physics_snapshot', snapshot);
    });
}, BROADCAST_MS);

server.listen(PORT, () => {
    console.log('HarramBall sunucusu ' + PORT + ' portunda çalışıyor. (Faz 1: fizik motoru aktif)');
});
