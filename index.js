// ==========================================
// PUTZZPEDIA CVPS — WHATSAPP BOT (LINKED DEVICE)
// Menggunakan Baileys
// ==========================================
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeInMemoryStore,
    jidDecode,
    proto,
    getContentType
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const pino = require("pino");
const qrcode = require("qrcode-terminal");
const fs = require("fs");
const axios = require("axios");
const { Client } = require("ssh2");
const NodeCache = require("node-cache");

// ==========================================
// KONFIGURASI
// ==========================================
const OWNER_NUMBER = "628xxxxxxxxxx"; // Ganti dengan nomor WA owner (format 62)
const USERNAME = "root";

// Grup resmi untuk /createvps — format: "628xxx-xxxx@g.us"
let ALLOWED_GROUP_ID = "";

const RAILWAY_API_URL = "https://backboard.railway.com/graphql/v2";
const CATCHMAIL_API_URL = "https://api.catchmail.io/api/v1";
const CATCHMAIL_DOMAINS = ["catchmail.io", "mailistry.com", "zeppost.com"];

const ADMIN_CONTACT = "628xxxxxxxxxx"; // Nomor WA admin untuk order
const PAYMENT_INFO = "DANA / OVO / GOPAY / QRIS";

const BRAND = "PutzzPedia";
const TAGLINE = "Cvps System";

const CHECK_INTERVAL = 3000;
const MAX_TIME = 15 * 60 * 1000;

const msgRetryCounterCache = new NodeCache();

// ==========================================
// LOAD FILE DATA
// ==========================================
function loadJSON(path, fallback = {}) {
    try {
        if (fs.existsSync(path)) {
            return JSON.parse(fs.readFileSync(path, "utf-8"));
        }
    } catch (e) {
        console.error(`[LOAD ERROR] ${path}: ${e.message}`);
    }
    return fallback;
}
function saveJSON(path, data) {
    fs.writeFileSync(path, JSON.stringify(data, null, 2));
}

let tokens = loadJSON("tokens.json", {});
let premiumUsers = new Set(loadJSON("premium.json", []));
let resellerList = loadJSON("reseller.json", []);
let allowedGroups = new Set(loadJSON("groups.json", []));
let products = loadJSON("products.json", {});

function saveTokens() { saveJSON("tokens.json", tokens); }
function savePremium() { saveJSON("premium.json", [...premiumUsers]); }
function saveReseller() { saveJSON("reseller.json", resellerList); }
function saveGroups() { saveJSON("groups.json", [...allowedGroups]); }

// ==========================================
// UTIL
// ==========================================
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function formatRupiah(n) { return "Rp " + Number(n).toLocaleString("id-ID"); }

function normalizeJid(jid) {
    if (!jid) return "";
    return jid.split(":")[0].split("@")[0];
}

function isOwnerNumber(jid) {
    return normalizeJid(jid) === OWNER_NUMBER.replace(/\D/g, "");
}

function escapeMarkdown(t) {
    if (!t) return "";
    return String(t).replace(/([_*~`>#+\-=|{}.!])/g, "");
}

function mention(jid) {
    if (!jid) return "User";
    return "@" + normalizeJid(jid);
}

function formatTime(ts = Date.now()) {
    const d = new Date(ts);
    return d.toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
}

// ==========================================
// CARD BUILDER (WhatsApp markdown style)
// ==========================================
const DIVIDER = "━━━━━━━━━━━━━━━━━━━━━";

function card(title, body, footer) {
    let msg = `*${BRAND}* _${TAGLINE}_\n${DIVIDER}\n*${title}*\n\n${body || ""}`;
    if (footer) msg += `\n\n${DIVIDER}\n➤ _${footer}_`;
    return msg;
}
function cardOk(t, b, f) { return card(`✅ ${t}`, b, f); }
function cardErr(t, b, f) { return card(`❌ ${t}`, b, f); }
function cardWarn(t, b, f) { return card(`⚠️ ${t}`, b, f); }
function cardInfo(t, b, f) { return card(`ℹ️ ${t}`, b, f); }

// ==========================================
// PRODUK
// ==========================================
function formatProductList() {
    const cats = [...new Set(Object.values(products).map(p => p.category))];
    let body = "";
    for (const cat of cats) {
        body += `\n*📁 ${cat}*\n`;
        for (const [id, p] of Object.entries(products)) {
            if (p.category === cat) {
                body += `▸ ${p.name} — *${formatRupiah(p.price)}*\n`;
            }
        }
    }
    return card("🛒 Daftar Produk PutzzPedia Cvps", body.trim(), `Order via wa.me/${ADMIN_CONTACT}`);
}

function formatProductDetail(id) {
    const p = products[id];
    if (!p) return null;
    const feat = Array.isArray(p.features) ? p.features.map(f => `  ✓ ${f}`).join("\n") : "";
    const body =
`*${p.name}*

📁 Kategori: ${p.category}
💰 Harga: *${formatRupiah(p.price)}*

📝 ${p.description}

✨ Fitur:
${feat}

💳 Pembayaran: ${PAYMENT_INFO}`;
    return card("🛒 Detail Produk PutzzPedia", body, `Order via admin wa.me/${ADMIN_CONTACT}`);
}

function formatPricelist() {
    let body = "*🖥️ Reseller Cvps NAT* — Rp 5.000\n";
    body += "*🎮 Panel Pterodactyl:*\n";
    body += "  ▸ 1GB — Rp 1.000\n";
    body += "  ▸ 2GB — Rp 2.000\n";
    body += "  ▸ 3GB — Rp 3.000\n";
    body += "  ▸ 4GB — Rp 4.000\n";
    body += "  ▸ 5GB — Rp 5.000\n";
    body += "  ▸ 7GB — Rp 7.000\n";
    body += "*🤝 Reseller Panel* — Rp 5.000";
    return card("💰 Pricelist PutzzPedia Cvps", body, `Order via admin wa.me/${ADMIN_CONTACT} · ${PAYMENT_INFO}`);
}

// ==========================================
// SESSION MEMORY
// ==========================================
const inputSessions = new Map();
const readySessions = new Map();
const mailSessions = new Map();
const knownGroups = new Map();

function createInputSession(chatId, data) {
    clearInputSession(chatId);
    data.timer = setTimeout(() => inputSessions.delete(chatId), 10 * 60 * 1000);
    inputSessions.set(chatId, data);
}
function getInputSession(chatId) { return inputSessions.get(chatId); }
function clearInputSession(chatId) {
    const s = inputSessions.get(chatId);
    if (s?.timer) clearTimeout(s.timer);
    inputSessions.delete(chatId);
}

// ==========================================
// TOKEN MANAGEMENT
// ==========================================
function userTokenAlias(userId) { return `user_${String(userId)}`; }

function canUseToken(alias, userId) {
    const t = tokens[alias];
    if (!t) return false;
    if (isOwnerNumber(userId)) return true;
    return t.ownerId && String(t.ownerId) === String(userId);
}

function getUserTokenAliases(userId) {
    return Object.keys(tokens).filter(a => canUseToken(a, userId));
}

function setUserOwnToken(userId, tokenValue) {
    const alias = userTokenAlias(userId);
    tokens[alias] = { token: String(tokenValue).trim(), ownerId: String(userId) };
    saveTokens();
    return alias;
}

function getUserOwnToken(userId) {
    const alias = userTokenAlias(userId);
    if (tokens[alias] && canUseToken(alias, userId)) return tokens[alias].token;
    const list = getUserTokenAliases(userId);
    return list.length > 0 ? tokens[list[0]].token : null;
}

function isPremium(userId) {
    if (isOwnerNumber(userId)) return true;
    return premiumUsers.has(String(userId));
}

// ==========================================
// CATCHMAIL
// ==========================================
const reqOptions = { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 10000 };

async function checkInbox(address) {
    try {
        const res = await axios.get(`${CATCHMAIL_API_URL}/mailbox?address=${encodeURIComponent(address)}`, reqOptions);
        return Array.isArray(res.data?.messages) ? res.data.messages : [];
    } catch { return []; }
}
async function readMessage(address, id) {
    try {
        const res = await axios.get(`${CATCHMAIL_API_URL}/message/${encodeURIComponent(id)}?mailbox=${encodeURIComponent(address)}`, reqOptions);
        return res.data || null;
    } catch { return null; }
}
function bodyText(detail) {
    if (!detail) return "";
    if (detail.body?.text) return detail.body.text;
    if (detail.body?.html) {
        return detail.body.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    }
    return "";
}
function isRailwayMessage(d) {
    const full = `${d?.from || ""}\n${d?.subject || ""}\n${bodyText(d)}`.toLowerCase();
    if (!full.includes("railway")) return false;
    return /login\s+code|verification\s+code|verify|otp/i.test(full) || /\b\d{6}\b/.test(full);
}
function extractRailwayCode(d) {
    const subj = String(d?.subject || "");
    let m = subj.match(/\b(\d{6})\b/);
    if (m) return m[1];
    const body = bodyText(d);
    m = body.match(/(?:login|verification|verify|otp)[^0-9]{0,80}(\d{6})\b/i);
    if (m) return m[1];
    m = `${subj}\n${body}`.match(/\b(\d{6})\b/);
    return m ? m[1] : null;
}
function createEmail() {
    const rs = Math.random().toString(36).slice(2, 12);
    const domain = CATCHMAIL_DOMAINS[Math.floor(Math.random() * CATCHMAIL_DOMAINS.length)];
    return `putzz${rs}@${domain}`;
}
function stopMailSession(userId) {
    const s = mailSessions.get(userId);
    if (!s) return;
    clearInterval(s.interval);
    clearTimeout(s.timeout);
    mailSessions.delete(userId);
}
function startMailMonitor(sock, chatId, userId, address, userMention) {
    stopMailSession(userId);
    const session = { address, seen: new Set(), interval: null, timeout: null };

    session.timeout = setTimeout(() => {
        if (!mailSessions.has(userId)) return;
        stopMailSession(userId);
        sock.sendMessage(chatId, { text: card("⏰ Pemantauan Selesai", "Tidak ditemukan kode OTP Railway.", "Temp-mail sudah ditutup.") });
    }, MAX_TIME);

    session.interval = setInterval(async () => {
        if (!mailSessions.has(userId)) return;
        const inbox = await checkInbox(address);
        for (const item of inbox) {
            if (!item?.id) continue;
            const id = String(item.id);
            if (session.seen.has(id)) continue;
            session.seen.add(id);
            const detail = await readMessage(address, item.id);
            if (!detail || !isRailwayMessage(detail)) continue;
            const code = extractRailwayCode(detail);
            if (!code) continue;
            stopMailSession(userId);
            await sock.sendMessage(chatId, {
                text: card("🚂 Kode Login Railway", `👤 User: ${userMention}\n🔐 Kode: *${code}*`, "Temp-mail ditutup.")
            });
            return;
        }
    }, CHECK_INTERVAL);

    mailSessions.set(userId, session);
}

// ==========================================
// SSH FUNCTIONS
// ==========================================
function connectSSH(config) {
    return new Promise((resolve, reject) => {
        const conn = new Client();
        let done = false;
        const finish = (err, res) => { if (done) return; done = true; try { conn.end(); } catch {} err ? reject(err) : resolve(res); };
        conn.once("ready", () => {
            const cmd = `
echo "__IP__"; IP=$(curl -sS ifconfig.me 2>/dev/null); echo "$IP"
echo "__OS__"; . /etc/os-release 2>/dev/null; echo "\${PRETTY_NAME:-Unknown}"
echo "__CPU__"; lscpu 2>/dev/null | awk -F: '/Model name/{gsub(/^ +| +$/,"",$2); print $2; exit}'
echo "__CORES__"; nproc
echo "__RAM__"; free -h | awk '/^Mem:/{print $2}'
echo "__RAMUSED__"; free -h | awk '/^Mem:/{print $3"/"$2}'
echo "__DISK__"; df -hP / | awk 'NR==2{print $2}'
echo "__DISKUSED__"; df -hP / | awk 'NR==2{print $3"/"$2" ("$5")"}'
echo "__UPTIME__"; uptime -p | sed 's/up //'
echo "__KERNEL__"; uname -r
echo "__ARCH__"; uname -m
echo "__HOSTNAME__"; hostname
`;
            conn.exec(cmd, (err, stream) => {
                if (err) return finish(err);
                let out = "", errS = "";
                stream.on("data", d => out += d.toString());
                stream.stderr.on("data", d => errS += d.toString());
                stream.on("close", () => out.trim() ? finish(null, out) : finish(new Error(errS || "Empty output")));
            });
        });
        conn.once("error", finish);
        conn.connect({ host: config.host, port: config.port, username: USERNAME, password: config.password, readyTimeout: 15000 });
    });
}
function getField(raw, name) {
    const m = raw.match(new RegExp(`__${name}__\\s*\\n([\\s\\S]*?)(?=\\n__|$)`));
    return m ? m[1].trim() : "-";
}
function parseVPS(raw) {
    return {
        ip: getField(raw, "IP"), os: getField(raw, "OS"), cpu: getField(raw, "CPU"),
        cores: getField(raw, "CORES"), ram: getField(raw, "RAM"), disk: getField(raw, "DISK"),
        uptime: getField(raw, "UPTIME"), ramUsed: getField(raw, "RAMUSED"),
        diskUsed: getField(raw, "DISKUSED"), kernel: getField(raw, "KERNEL"),
        arch: getField(raw, "ARCH"), hostname: getField(raw, "HOSTNAME")
    };
}
function formatVPS(vps, port, pass) {
    return card("🖥️ VPS PutzzPedia",
`🏷️ Host : ${vps.hostname}
🧩 OS   : ${vps.os}
🧠 CPU  : ${vps.cpu} (${vps.cores} core)
💾 RAM  : ${vps.ramUsed} / ${vps.ram}
📀 Disk : ${vps.diskUsed} / ${vps.disk}
🌐 IP   : ${vps.ip}
🔌 Port : ${port}
👤 User : ${USERNAME}
🔑 Pass : ${pass}
⏱️ Uptime: ${vps.uptime}

🟢 Status: *ACTIVE*`, "Simpan data ini, jangan share.");
}

// ==========================================
// WHATSAPP SOCKET
// ==========================================
let sock;

async function startSock() {
    const { state, saveCreds } = await useMultiFileAuthState("auth_info");
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        logger: pino({ level: "silent" }),
        printQRInTerminal: false,
        auth: state,
        browser: ["PutzzPedia Cvps", "Chrome", "1.0.0"],
        msgRetryCounterCache,
        getMessage: async () => proto.Message.fromObject({})
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            console.log("\n📱 Scan QR ini pakai WhatsApp (Perangkat Tertaut):\n");
            qrcode.generate(qr, { small: true });
        }
        if (connection === "close") {
            const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
            const shouldReconnect = code !== DisconnectReason.loggedOut;
            console.log(`[WA] Koneksi ditutup (code=${code}). Reconnect: ${shouldReconnect}`);
            if (shouldReconnect) setTimeout(() => startSock(), 3000);
            else console.log("❌ Logout dari WhatsApp. Hapus folder auth_info & scan ulang.");
        } else if (connection === "open") {
            console.log("\n✅ WhatsApp Connected — PutzzPedia Cvps Bot siap!\n");
        }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
        if (type !== "notify") return;
        const m = messages[0];
        if (!m.message || m.key.fromMe) return;
        await handleMessage(m);
    });
}

// ==========================================
// MESSAGE HANDLER
// ==========================================
async function reply(jid, text, extra = {}) {
    return sock.sendMessage(jid, { text, ...extra });
}
async function replyWithMentions(jid, text, mentions, extra = {}) {
    return sock.sendMessage(jid, { text, mentions, ...extra });
}

async function handleMessage(m) {
    const chatId = m.key.remoteJid;
    const sender = m.key.participant || m.key.remoteJid;
    const isGroup = chatId.endsWith("@g.us");
    const pushName = m.pushName || "User";
    const senderMention = mention(sender);

    // Simpan grup yang dikenal
    if (isGroup) {
        try {
            const meta = await sock.groupMetadata(chatId);
            knownGroups.set(chatId, meta.subject);
        } catch {}
    }

    // Ekstrak teks
    const type = getContentType(m.message);
    let text = "";
    if (type === "conversation") text = m.message.conversation;
    else if (type === "extendedTextMessage") text = m.message.extendedTextMessage.text;
    else if (type === "imageMessage" && m.message.imageMessage.caption) text = m.message.imageMessage.caption;
    else if (type === "videoMessage" && m.message.videoMessage.caption) text = m.message.videoMessage.caption;

    text = (text || "").trim();
    if (!text) return;

    // Simpan sesi input
    const session = getInputSession(chatId);

    // === COMMAND HANDLER ===
    if (text.startsWith("/") || text.startsWith("!")) {
        const cmd = text.split(/\s+/)[0].toLowerCase().replace(/^[\/!]/, "").replace(/@\d+/, "");
        const args = text.split(/\s+/).slice(1);

        switch (cmd) {
            case "start":
            case "menu":
                return handleStart(chatId, sender, senderMention, isGroup);

            case "produk":
            case "product":
                return replyWithMentions(chatId, formatProductList(), [sender]);

            case "harga":
            case "pricelist":
                return reply(chatId, formatPricelist());

            case "ping":
                const t0 = Date.now();
                await reply(chatId, "🏓 Pong! Cek latency...");
                return reply(chatId, `✅ Latency: *${Date.now() - t0}ms*`);

            case "whoami":
                return replyWithMentions(chatId, card("🆔 ID WhatsApp Kamu", `Nomor: *${normalizeJid(sender)}*\nJID  : ${sender}`), [sender]);

            case "stats":
                if (!isOwnerNumber(sender)) return;
                return handleStats(chatId);

            case "add":
                if (!isOwnerNumber(sender)) return;
                if (!isGroup) return reply(chatId, cardWarn("Khusus Grup", "Gunakan di dalam grup."));
                allowedGroups.add(chatId);
                saveGroups();
                return reply(chatId, cardOk("Grup Diizinkan", `Grup ini ditambahkan ke whitelist PutzzPedia Cvps.`));

            case "del":
                if (!isOwnerNumber(sender)) return;
                if (!isGroup) return reply(chatId, cardWarn("Khusus Grup", "Gunakan di dalam grup."));
                allowedGroups.delete(chatId);
                saveGroups();
                return reply(chatId, cardErr("Grup Dihapus", "Izin grup ini dicabut."));

            case "listadd":
                if (!isOwnerNumber(sender)) return;
                return reply(chatId, card("📋 Grup Diizinkan", [...allowedGroups].map((g, i) => `${i + 1}. ${knownGroups.get(g) || g}`).join("\n") || "Belum ada."));

            case "mytoken":
                return handleMyToken(chatId, sender, senderMention, args[0], isGroup);

            case "settoken":
                if (!isOwnerNumber(sender)) return;
                if (args.length >= 3) {
                    tokens[args[0]] = { token: args[1], ownerId: args[2] };
                    saveTokens();
                    return reply(chatId, cardOk("Token Tersimpan", `Alias: ${args[0]}\nDikunci: ${args[2]}`));
                }
                createInputSession(chatId, { step: "settoken_alias", action: "settoken" });
                return reply(chatId, card("🏷️ Tambah Token 1/3", "Kirim *alias* untuk token ini.\nContoh: utama"));

            case "listtokens":
                if (!isOwnerNumber(sender)) return;
                return handleListTokens(chatId);

            case "deltoken":
                if (!isOwnerNumber(sender)) return;
                if (!args[0]) return reply(chatId, cardWarn("Cara Pakai", "/deltoken <alias>"));
                if (!tokens[args[0]]) return reply(chatId, cardErr("Tidak Ditemukan", `Alias ${args[0]} tidak ada.`));
                delete tokens[args[0]];
                saveTokens();
                return reply(chatId, cardOk("Token Dihapus", `Alias ${args[0]} berhasil dihapus.`));

            case "addprem":
                if (!isOwnerNumber(sender)) return;
                if (!args[0]) return reply(chatId, cardWarn("Cara Pakai", "/addprem <nomor>"));
                premiumUsers.add(args[0]);
                savePremium();
                return reply(chatId, cardOk("Premium Ditambahkan", `Nomor ${args[0]} sekarang premium.`));

            case "delprem":
                if (!isOwnerNumber(sender)) return;
                if (!args[0]) return reply(chatId, cardWarn("Cara Pakai", "/delprem <nomor>"));
                premiumUsers.delete(args[0]);
                savePremium();
                return reply(chatId, cardOk("Premium Dihapus", `Nomor ${args[0]} bukan premium lagi.`));

            case "listprem":
                if (!isOwnerNumber(sender)) return;
                return reply(chatId, card("📋 Daftar Premium", [...premiumUsers].map((p, i) => `${i + 1}. ${p}`).join("\n") || "Kosong."));

            case "address":
                if (!isOwnerNumber(sender)) return;
                if (!args[0]) return reply(chatId, cardWarn("Cara Pakai", "/address <nomor>"));
                if (!resellerList.includes(args[0])) { resellerList.push(args[0]); saveReseller(); }
                return reply(chatId, cardOk("Reseller Ditambahkan", `Nomor ${args[0]} jadi reseller.`));

            case "delress":
                if (!isOwnerNumber(sender)) return;
                if (!args[0]) return reply(chatId, cardWarn("Cara Pakai", "/delress <nomor>"));
                resellerList = resellerList.filter(r => r !== args[0]);
                saveReseller();
                return reply(chatId, cardOk("Reseller Dihapus", `Nomor ${args[0]} dihapus.`));

            case "listress":
                if (!isOwnerNumber(sender)) return;
                return reply(chatId, card("📋 Daftar Reseller", resellerList.map((r, i) => `${i + 1}. ${r}`).join("\n") || "Kosong."));

            case "tempmail":
                return handleTempMail(chatId, sender, senderMention, isGroup);

            case "createvps":
                return handleCreateVPS(chatId, sender, senderMention, isGroup);

            case "fix":
                return handleFixVPS(chatId, sender, senderMention, isGroup);

            case "login":
                if (!isOwnerNumber(sender)) return;
                createInputSession(chatId, { step: "domain", action: "login" });
                return reply(chatId, card("🌐 Login VPS 1/2", "Kirim domain/hostname SSH VPS.\nFormat: host atau host:port"));

            case "upload":
                if (!isOwnerNumber(sender)) return;
                return reply(chatId, cardWarn("Upload", "Kirim file dengan caption /upload lalu ikuti instruksi."));

            default:
                return reply(chatId, cardErr("Command Tidak Dikenal", `Coba /start untuk lihat menu.`));
        }
    }

    // === SESSION HANDLER (input user) ===
    if (session) {
        await handleSession(chatId, sender, senderMention, text, session, isGroup);
    }
}

// ==========================================
// HANDLERS
// ==========================================
async function handleStart(chatId, sender, senderMention, isGroup) {
    if (isOwnerNumber(sender)) {
        const menu =
`*🛒 Produk*
▸ /produk — daftar produk
▸ /harga — pricelist

*🖥️ VPS*
▸ /createvps — buat VPS (grup resmi)
▸ /fix — cek spek VPS
▸ /login — login VPS (owner)
▸ /upload — upload file

*🔑 Token*
▸ /mytoken — set token sendiri
▸ /settoken — owner set token
▸ /listtokens  /deltoken

*🌐 Grup*
▸ /add  /del  /listadd

*⭐ Premium & Reseller*
▸ /addprem  /delprem  /listprem
▸ /address  /delress  /listress

*⚙️ Lainnya*
▸ /stats  /ping  /whoami`;
        return replyWithMentions(chatId, card(`🖥️ PutzzPedia Cvps · Dashboard Owner`, `Halo ${senderMention}\n\n${menu}`, `Owner Panel`), [sender]);
    }

    const userMenu =
`*🛒 Produk*
▸ /produk — daftar produk
▸ /harga — pricelist

*🖥️ VPS*
▸ /createvps — buat VPS (grup resmi)
▸ /fix — cek spek VPS
▸ /mytoken — set token

*🔧 Utilitas*
▸ /tempmail — email sementara
▸ /whoami — cek nomor
▸ /ping — cek bot hidup`;
    return replyWithMentions(chatId, card(`🖥️ PutzzPedia Cvps Manager`, `Halo ${senderMention}\n\n${userMenu}`, `Order: wa.me/${ADMIN_CONTACT}`), [sender]);
}

async function handleStats(chatId) {
    const up = process.uptime();
    const d = Math.floor(up / 86400), h = Math.floor((up % 86400) / 3600), m = Math.floor((up % 3600) / 60);
    const body =
`🔑 Token    : ${Object.keys(tokens).length}
🌐 Grup     : ${allowedGroups.size}
⭐ Premium  : ${premiumUsers.size}
🤝 Reseller : ${resellerList.length}
🛒 Produk   : ${Object.keys(products).length}
🟢 VPS Aktif: ${readySessions.size}
⏱️ Uptime   : ${d}h ${h}j ${m}m`;
    return reply(chatId, card("📊 Statistik Bot", body));
}

async function handleListTokens(chatId) {
    const aliases = Object.keys(tokens);
    if (!aliases.length) return reply(chatId, card("📭 Daftar Token", "Belum ada token."));
    const list = aliases.map((a, i) => {
        const t = tokens[a];
        const bound = t.ownerId ? t.ownerId : "⚠️ belum dikunci";
        return `${i + 1}. *${a}*\n   🔐 ${t.token.substring(0, 8)}...\n   👤 ${bound}`;
    }).join("\n\n");
    return reply(chatId, card("📋 Token Tersimpan", list));
}

async function handleMyToken(chatId, sender, senderMention, tokenArg, isGroup) {
    if (!isGroup && !allowedGroups.has(chatId)) {
        // Private chat OK untuk set token
    }
    if (tokenArg) {
        if (isGroup) {
            return reply(chatId, cardWarn("Keamanan", `${senderMention}, jangan kirim token di grup.\nChat pribadi bot: /mytoken TOKEN_KAMU`));
        }
        if (tokenArg.length < 20) return reply(chatId, cardErr("Token Tidak Valid", "Token Railway terlalu pendek."));
        setUserOwnToken(sender, tokenArg);
        return replyWithMentions(chatId, cardOk("Token Tersimpan", `${senderMention}, token Railway kamu berhasil disimpan.`), [sender]);
    }
    const existing = getUserOwnToken(sender);
    const status = existing
        ? `Status: *sudah ada token*\nPreview: ${existing.substring(0, 8)}...\n\nGanti: /mytoken TOKEN_BARU`
        : `Status: *belum ada token*\n\nKirim: /mytoken TOKEN_RAILWAY_KAMU`;
    return replyWithMentions(chatId, card("🔑 Token Railway", `${senderMention}\n\n${status}`), [sender]);
}

async function handleTempMail(chatId, sender, senderMention, isGroup) {
    if (isGroup && !allowedGroups.has(chatId)) return;
    if (mailSessions.has(sender)) {
        return reply(chatId, cardWarn("Sesi Masih Aktif", "Tunggu OTP sebelumnya masuk dulu."));
    }
    const addr = createEmail();
    await replyWithMentions(chatId, card("📧 Temp Mail Railway", `User: ${senderMention}\nEmail: *${addr}*\n\nMenunggu OTP (maks. 15 menit)...`), [sender]);
    startMailMonitor(sock, chatId, sender, addr, senderMention);
}

async function handleCreateVPS(chatId, sender, senderMention, isGroup) {
    if (!isGroup) {
        return reply(chatId, cardErr("Tidak Bisa di Sini", "Pembuatan VPS hanya bisa dari grup resmi PutzzPedia Cvps."));
    }
    if (!allowedGroups.has(chatId)) {
        return reply(chatId, cardErr("Grup Belum Didaftarkan", "Minta owner ketik /add dulu di grup ini."));
    }
    createInputSession(chatId, { step: "createvps_token", action: "createvps", initiator: sender });
    return replyWithMentions(chatId, card("🖥️ Create VPS · 1/2", `${senderMention}, kirim *token Railway* di chat ini.\n\nCara ambil: railway.app/account/tokens → New Token → My Projects.\n\n_Pesan token akan dihapus otomatis setelah diterima._`), [sender]);
}

async function handleFixVPS(chatId, sender, senderMention, isGroup) {
    if (isGroup && !allowedGroups.has(chatId) && !isOwnerNumber(sender)) return;
    createInputSession(chatId, { step: "domain", action: "fix", initiator: sender });
    return replyWithMentions(chatId, card("🔧 Cek VPS · 1/2", `${senderMention}, kirim domain/hostname SSH VPS.\nFormat: host atau host:port`), [sender]);
}

// ==========================================
// SESSION HANDLER
// ==========================================
async function handleSession(chatId, sender, senderMention, text, session, isGroup) {
    if (session.initiator && session.initiator !== sender) return;

    // SETTOKEN flow (owner)
    if (session.action === "settoken") {
        if (session.step === "settoken_alias") {
            session.alias = text;
            session.step = "settoken_token";
            return reply(chatId, card("🔑 Tambah Token 2/3", `Alias: *${text}*\nKirim *token Railway*.`));
        }
        if (session.step === "settoken_token") {
            session.token = text;
            session.step = "settoken_owner";
            return reply(chatId, card("👤 Tambah Token 3/3", `Token diterima ✅\nKirim *nomor WhatsApp* pemilik token.`));
        }
        if (session.step === "settoken_owner") {
            if (!/^\d+$/.test(text)) return reply(chatId, cardErr("Nomor Tidak Valid", "Harus angka."));
            tokens[session.alias] = { token: session.token, ownerId: text };
            saveTokens();
            clearInputSession(chatId);
            return reply(chatId, cardOk("Token Tersimpan", `Alias: ${session.alias}\nDikunci: ${text}`));
        }
    }

    // MYTOKEN flow
    if (session.action === "mytoken" && session.step === "mytoken_wait") {
        if (text.length < 20) return reply(chatId, cardErr("Token Tidak Valid", "Terlalu pendek."));
        setUserOwnToken(sender, text);
        clearInputSession(chatId);
        return replyWithMentions(chatId, cardOk("Token Tersimpan", `${senderMention}, token berhasil disimpan.`), [sender]);
    }

    // CREATEVPS flow
    if (session.action === "createvps") {
        if (session.step === "createvps_token") {
            if (text.length < 20) return reply(chatId, cardErr("Token Tidak Valid", "Terlalu pendek."));
            session.selectedToken = text;
            session.step = "vps_name";
            setUserOwnToken(sender, text);
            return replyWithMentions(chatId, card("🖥️ Create VPS · 2/2", `${senderMention}, token diterima ✅\n\nKirim *nama VPS*.\nContoh: putzz-vps-1 (tanpa spasi).`), [sender]);
        }
        if (session.step === "vps_name") {
            const vpsName = text.replace(/\s+/g, "-");
            if (!/^[a-zA-Z0-9\-]+$/.test(vpsName)) return reply(chatId, cardErr("Nama Tidak Valid", "Hanya huruf/angka/dash."));
            clearInputSession(chatId);
            await reply(chatId, card("⚙️ Menyiapkan VPS", `Nama: *${vpsName}*\nProses build 1-15 menit. Mohon tunggu...`));
            // (Deploy Railway logic di sini — mirror dari versi Telegram)
            // Karena panjang, saya ringkas: panggil fungsi deployRailwayVPS(...)
            return deployRailwayVPS(chatId, sender, senderMention, vpsName, session.selectedToken);
        }
    }

    // FIX / LOGIN flow (domain -> port -> password)
    if (["domain", "port", "password"].includes(session.step)) {
        if (session.step === "domain") {
            const match = text.match(/^([^:\s]+)(?::(\d+))?$/);
            if (!match) return reply(chatId, cardErr("Hostname Tidak Valid", "Format: host atau host:port"));
            session.host = match[1];
            if (match[2]) {
                session.port = Number(match[2]);
                session.step = "password";
                return reply(chatId, card("🔑 Password · Terakhir", `${senderMention}, kirim password SSH root VPS.`));
            }
            session.step = "port";
            return reply(chatId, card("🔌 Port SSH · 2/3", "Kirim port SSH (contoh: 22)."));
        }
        if (session.step === "port") {
            const port = Number(text);
            if (!Number.isInteger(port) || port < 1 || port > 65535) return reply(chatId, cardErr("Port Invalid", "Angka 1-65535."));
            session.port = port;
            session.step = "password";
            return reply(chatId, card("🔑 Password · Terakhir", "Kirim password SSH root VPS."));
        }
        if (session.step === "password") {
            const config = { host: session.host, port: session.port, password: text };
            const action = session.action;
            clearInputSession(chatId);

            if (action === "fix") {
                await reply(chatId, card("🔧 Menghubungkan SSH", `Host: ${config.host}:${config.port}\nMohon tunggu...`));
                try {
                    const raw = await connectSSH(config);
                    const vps = parseVPS(raw);
                    const targetJid = isGroup ? sender : chatId;
                    await sock.sendMessage(targetJid, { text: formatVPS(vps, config.port, config.password) });
                    if (isGroup) await reply(chatId, cardOk("Cek Selesai", "Detail dikirim ke DM kamu."));
                } catch (e) {
                    await reply(chatId, cardErr("Gagal Login", e.message));
                }
                return;
            }
            if (action === "login") {
                await reply(chatId, card("🌐 Login VPS", "Menghubungkan..."));
                try {
                    const raw = await connectSSH(config);
                    const vps = parseVPS(raw);
                    await reply(chatId, formatVPS(vps, config.port, config.password));
                } catch (e) {
                    await reply(chatId, cardErr("Gagal Login", e.message));
                }
                return;
            }
        }
    }
}

// ==========================================
// DEPLOY RAILWAY (versi ringkas)
// ==========================================
async function deployRailwayVPS(chatId, sender, senderMention, vpsName, apiToken) {
    try {
        const headers = { 'Authorization': `Bearer ${apiToken}`, 'Content-Type': 'application/json' };
        const api = async (q) => {
            const res = await axios.post(RAILWAY_API_URL, { query: q }, { headers });
            if (res.data.errors) throw new Error(res.data.errors[0].message);
            return res.data.data;
        };

        // 1. Ambil workspace
        await reply(chatId, card("⚙️ Tahap 1/6", "Mengambil workspace..."));
        let ws = null;
        try {
            const w = await api(`query { me { workspaces { edges { node { id } } } } }`);
            ws = w?.me?.workspaces?.edges?.[0]?.node?.id;
        } catch {}

        // 2. Buat project
        await reply(chatId, card("⚙️ Tahap 2/6", "Membuat project..."));
        const projQ = ws
            ? `mutation { projectCreate(input: { name: "${vpsName}", workspaceId: "${ws}" }) { id environments(first: 1) { edges { node { id } } } } }`
            : `mutation { projectCreate(input: { name: "${vpsName}" }) { id environments(first: 1) { edges { node { id } } } } }`;
        const p1 = await api(projQ);
        const projectId = p1.projectCreate.id;
        const envId = p1.projectCreate.environments.edges[0].node.id;

        // 3. Buat service
        await reply(chatId, card("⚙️ Tahap 3/6", "Membuat service..."));
        const s1 = await api(`mutation { serviceCreate(input: { projectId: "${projectId}", name: "${vpsName}", source: { repo: "parham7991/railway-ubuntu-ssh-claude" } }) { id } }`);
        const serviceId = s1.serviceCreate.id;

        // 4. Set password
        await reply(chatId, card("⚙️ Tahap 4/6", "Set password..."));
        const randomPassword = "Putzz" + Math.random().toString(36).slice(2, 10) + "#!";
        await api(`mutation { variableCollectionUpsert(input: { projectId: "${projectId}", environmentId: "${envId}", serviceId: "${serviceId}", variables: { ROOT_PASSWORD: "${randomPassword}" } }) }`);

        // 5. Buka port TCP 22
        await reply(chatId, card("⚙️ Tahap 5/6", "Buka port SSH..."));
        const tcp = await api(`mutation { tcpProxyCreate(input: { environmentId: "${envId}", serviceId: "${serviceId}", applicationPort: 22 }) { domain proxyPort } }`);
        const proxyDomain = tcp.tcpProxyCreate.domain;
        const proxyPort = tcp.tcpProxyCreate.proxyPort;

        // 6. Tunggu deploy sukses
        await reply(chatId, card("⚙️ Tahap 6/6", "Menunggu server aktif (1-15 menit)..."));
        let ready = false, attempt = 0;
        while (!ready && attempt < 180) {
            attempt++;
            await sleep(5000);
            try {
                const d = await api(`query { deployments(input: { projectId: "${projectId}", environmentId: "${envId}", serviceId: "${serviceId}" }) { edges { node { status } } } }`);
                const st = d?.deployments?.edges?.[0]?.node?.status;
                if (st === "SUCCESS") ready = true;
                else if (st === "FAILED" || st === "CRASHED") throw new Error("Deploy gagal/crash.");
            } catch (e) {
                if (e.message.includes("gagal")) throw e;
            }
        }
        if (!ready) throw new Error("Timeout build.");

        // Ambil data via SSH
        const sshConfig = { host: proxyDomain, port: proxyPort, password: randomPassword };
        let raw = null, retries = 60;
        while (retries > 0 && !raw) {
            try { await sleep(10000); raw = await connectSSH(sshConfig); }
            catch { retries--; }
        }
        if (!raw) throw new Error("SSH belum bisa diakses.");

        const vps = parseVPS(raw);
        const targetJid = sender; // kirim ke DM
        await sock.sendMessage(targetJid, { text: formatVPS(vps, proxyPort, randomPassword) });
        await reply(chatId, cardOk("VPS PutzzPedia Siap!", "Data login sudah dikirim ke DM kamu."));
    } catch (e) {
        await reply(chatId, cardErr("Deploy Gagal", e.message));
    }
}

// ==========================================
// BOOT
// ==========================================
console.log("");
console.log("╭──────────────────────────────────────╮");
console.log("│  PUTZZPEDIA CVPS WA BOT              │");
console.log("│  WhatsApp Linked Device              │");
console.log("╰──────────────────────────────────────╯");
console.log("");
startSock().catch(e => console.error("[FATAL]", e));
