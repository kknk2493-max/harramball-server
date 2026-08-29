// ============================================================
// HarramBall Sunucu Fiziği (Faz 1)
// ============================================================
// Oyunun istemci kodundaki gerçek sabitler buraya birebir taşındı
// (harramball.html içindeki PHYSICS objesi ve hareket kodundan).
// Amaç: topun/oyuncunun HİSSİNİ hiç değiştirmeden, hesaplamayı
// host'un tarayıcısından alıp buraya (sunucuya) taşımak.

const PHYSICS = {
    BALL_DAMPING: 0.9915,        // top havadayken/hızlıyken sürtünme
    BALL_DAMPING_GROUND: 0.976,  // top yavaşken sürtünme
    PLAYER_DAMPING: 0.55,
    KICK_RESTITUTION: 0.62,
    PLAYER_MASS: 3.0,
    MAX_BALL_SPEED: 13.0,
    MAX_PLAYER_SPEED: 4.2,
    STRONG_KICK: 11.5,
    SOFT_KICK: 5.5,
    CURL_FACTOR: 0.13,
    PLAYER_ACCEL: 0.35,
    PLAYER_RADIUS: 20,
    BALL_RADIUS: 12,             // istemcide net bir sabit bulunamadı - test ederken
                                  // ekrandaki topla karşılaştırıp inceltilecek
};

// Harita boyutları (istemcideki 'small'/'medium'/'large' ile birebir)
const MAPS = {
    small:  { width: 1400, height: 700,  goalHeight: 200, goalDepth: 1400 * 0.055 },
    medium: { width: 1900, height: 950,  goalHeight: 260, goalDepth: 1900 * 0.055 },
    large:  { width: 2800, height: 1400, goalHeight: 380, goalDepth: 2800 * 0.055 },
};

// Tek bir odanın (maçın) tam fizik durumunu ve tek-frame ilerletme
// mantığını tutan sınıf. Sunucu, her oda için bunlardan bir tane
// tutacak ve sabit aralıklarla (örn. 60fps) step() çağıracak.
class RoomPhysics {
    constructor(mapSize) {
        this.map = MAPS[mapSize] || MAPS.medium;
        this.ball = { x: this.map.width / 2, y: this.map.height / 2, vx: 0, vy: 0 };
        this.players = new Map(); // id -> {x,y,vx,vy,team,input:{dx,dy,kick}}
    }

    addPlayer(id, team) {
        const isRed = team === 'red';
        this.players.set(id, {
            x: isRed ? this.map.width * 0.3 : this.map.width * 0.7,
            y: this.map.height / 2,
            vx: 0, vy: 0,
            team,
            input: { dx: 0, dy: 0, kick: false, running: false }
        });
    }

    removePlayer(id) {
        this.players.delete(id);
    }

    // İstemciden gelen "ben şu yöne gidiyorum" bilgisini kaydet.
    // Gerçek hareketi BURADA değil, step() içinde hesaplıyoruz -
    // bu yüzden hile yapmak (hızlı hareket etmek gibi) mümkün değil.
    setInput(id, input) {
        const p = this.players.get(id);
        if (p) p.input = input;
    }

    // DÜZELTME (v1.1): Eskiden sunucu, oyuncunun konumunu SADECE yön tuşundan
    // (dx,dy) kendi başına tahmin ediyordu. Bu, oyuncunun kendi ekranındaki
    // GERÇEK (yerel, akıcı) konumundan zamanla kayıyordu - top, oyuncunun
    // göründüğü yerde değil, sunucunun "sandığı" hayali yerde çarpışma
    // arıyordu. Bu yüzden "topa değemiyorum" hissi oluşuyordu. Artık istemci
    // kendi GERÇEK x/y'sini doğrudan bildiriyor, sunucu tahmin etmiyor -
      // sadece bu pozisyonu top çarpışması için kullanıyor.
    setReportedPosition(id, x, y, vx, vy) {
        const p = this.players.get(id);
        if (!p) return;
        p.x = x; p.y = y;
        p.vx = vx || 0; p.vy = vy || 0;
        p.reported = true; // bu oyuncu artık kendi konumunu bildiriyor
    }

    resetKickoff() {
        this.ball.x = this.map.width / 2;
        this.ball.y = this.map.height / 2;
        this.ball.vx = 0; this.ball.vy = 0;
    }

    // Tek bir fizik adımı (yaklaşık 16.67ms = 60fps varsayımıyla)
    step(dtMs) {
        const normFactor = Math.min(dtMs / 16.67, 1.5);
        const m = this.map;

        // --- Oyuncu hareketi ---
        // v1.1: "reported" (konumunu doğrudan bildiren) oyuncular için
        // sunucu ARTIK kendi tahminini yapmıyor - istemcinin gerçek konumu
        // aynen kullanılıyor (yukarıdaki setReportedPosition ile geldi).
        // Bildirmeyen oyuncular için eski yön-tabanlı tahmin devam ediyor
        // (geriye dönük uyumluluk / güvenlik ağı).
        this.players.forEach(p => {
            if (p.reported) return; // konumu zaten güncel, tahmine gerek yok
            const speed = (p.input.running ? PHYSICS.MAX_PLAYER_SPEED * 1.4 : PHYSICS.MAX_PLAYER_SPEED);
            const targetVx = p.input.dx * speed;
            const targetVy = p.input.dy * speed;
            p.vx += (targetVx - p.vx) * PHYSICS.PLAYER_ACCEL * normFactor;
            p.vy += (targetVy - p.vy) * PHYSICS.PLAYER_ACCEL * normFactor;
            p.x += p.vx * normFactor;
            p.y += p.vy * normFactor;

            // Saha dışına çıkmayı engelle
            const r = PHYSICS.PLAYER_RADIUS;
            if (p.x - r < 0) { p.x = r; p.vx = 0; }
            if (p.x + r > m.width) { p.x = m.width - r; p.vx = 0; }
            if (p.y - r < 0) { p.y = r; p.vy = 0; }
            if (p.y + r > m.height) { p.y = m.height - r; p.vy = 0; }
        });

        // --- Top hareketi ---
        const b = this.ball;
        b.x += b.vx * normFactor;
        b.y += b.vy * normFactor;

        const spd = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
        const frict = spd > 0.5 ? PHYSICS.BALL_DAMPING : PHYSICS.BALL_DAMPING_GROUND;
        b.vx *= Math.pow(frict, normFactor);
        b.vy *= Math.pow(frict, normFactor);
        if (spd < 0.05) { b.vx = 0; b.vy = 0; }

        // --- Top-duvar/kale çarpışması ---
        const br = PHYSICS.BALL_RADIUS;
        const inGoalMouthY = b.y > (m.height - m.goalHeight) / 2 && b.y < (m.height + m.goalHeight) / 2;

        if (b.y - br < 0) { b.y = br; b.vy *= -1; }
        if (b.y + br > m.height) { b.y = m.height - br; b.vy *= -1; }

        let goal = null; // 'red' veya 'blue' (hangi tarafın kalesine girdi)
        if (b.x - br < m.goalDepth) {
            if (inGoalMouthY) { goal = 'blue'; /* mavi attı, kırmızının kalesi */ }
            else { b.x = m.goalDepth + br; b.vx *= -1; }
        }
        if (b.x + br > m.width - m.goalDepth) {
            if (inGoalMouthY) { goal = 'red'; }
            else { b.x = m.width - m.goalDepth - br; b.vx *= -1; }
        }

        // --- Top-oyuncu çarpışması ---
        this.players.forEach(p => {
            const dx = b.x - p.x, dy = b.y - p.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const minDist = PHYSICS.PLAYER_RADIUS + br;
            if (dist < minDist && dist > 0) {
                const nx = dx / dist, ny = dy / dist;
                const overlap = minDist - dist;
                b.x += nx * overlap;
                b.y += ny * overlap;
                const kickPower = p.input.kick
                    ? (p.input.strongKick ? PHYSICS.STRONG_KICK : PHYSICS.SOFT_KICK)
                    : 0;
                const relSpeed = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
                b.vx = nx * (kickPower + relSpeed * PHYSICS.KICK_RESTITUTION);
                b.vy = ny * (kickPower + relSpeed * PHYSICS.KICK_RESTITUTION);
                const bspd = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
                if (bspd > PHYSICS.MAX_BALL_SPEED) {
                    b.vx = (b.vx / bspd) * PHYSICS.MAX_BALL_SPEED;
                    b.vy = (b.vy / bspd) * PHYSICS.MAX_BALL_SPEED;
                }
            }
        });

        if (goal) this.resetKickoff();
        return { goal };
    }

    getSnapshot() {
        const players = {};
        this.players.forEach((p, id) => { players[id] = { x: p.x, y: p.y, vx: p.vx, vy: p.vy, team: p.team }; });
        return { ball: { x: this.ball.x, y: this.ball.y, vx: this.ball.vx, vy: this.ball.vy }, players };
    }
}

module.exports = { RoomPhysics, PHYSICS, MAPS };
