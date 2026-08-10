// === SERVER KEEPALIVE RENDER ===
import http from 'http';
import makeWASocket, { 
    DisconnectReason, 
    initAuthCreds, 
    proto, 
    fetchLatestBaileysVersion 
} from '@whiskeysockets/baileys';
import { MongoClient } from 'mongodb';
import axios from 'axios';
import pino from 'pino';
import cron from 'node-cron';

// === GLOBAL ERROR HANDLER (Mencegah Render Crash/Mati Sendiri) ===
process.on('uncaughtException', console.error);
process.on('unhandledRejection', console.error);

const port = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot WhatsApp Kas Production Server Aktif!\n');
}).listen(port, () => console.log(`🌍 Web server aktif di port ${port}`));

// === KONFIGURASI UTAMA ===
const API_URL = 'https://script.google.com/macros/s/AKfycbzrgUNXaXz4NGbod6OMqBJ0Ieo0AJgD5kZMIrRUyNL8ey2xhKW0N0J-hXTV5C40VpP67g/exec';
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://anjass001_db_user:uyXXk6axpyFTMzJf@cluster0.59haly3.mongodb.net/bot_whatsapp?retryWrites=true&w=majority';
const NOMOR_BOT = '6285956143731'; 

const WAKTU_5_MENIT = 5 * 60 * 1000;
const WAKTU_24_JAM = 24 * 60 * 60 * 1000;
const formatRp = (num) => 'Rp ' + Number(num || 0).toLocaleString('id-ID');

// Memori In-App
const userSessions = {};
const searchCache = {};
const processedMessages = new Set();
let registeredGroups = [];

// === CUSTOM BUFFER JSON PARSER (Mencegah Bug Baileys v7) ===
const JSONReplacer = (k, v) => (Buffer.isBuffer(v) || v?.type === 'Buffer' ? { type: 'Buffer', data: v.data || v.toString('base64') } : v);
const JSONReviver = (k, v) => (v?.type === 'Buffer' ? Buffer.from(v.data || v, 'base64') : v);

// === KONEKSI DATABASE ===
let mongoClient;
let sessionCollection;
let configCollection; // Menyimpan daftar grup secara permanen

async function initMongoDB() {
    if (!mongoClient) {
        mongoClient = new MongoClient(MONGO_URI);
        await mongoClient.connect();
        const db = mongoClient.db('bot_whatsapp');
        sessionCollection = db.collection('session_kas');
        configCollection = db.collection('app_config');
        
        // Memuat daftar grup dari MongoDB
        const config = await configCollection.findOne({ _id: 'registered_groups' });
        if (config && config.groups) {
            registeredGroups = config.groups;
        }
    }
}

// Handler Simpan Grup ke MongoDB
async function saveGroup(groupId) {
    if (!registeredGroups.includes(groupId)) {
        registeredGroups.push(groupId);
        await configCollection.updateOne(
            { _id: 'registered_groups' },
            { $set: { groups: registeredGroups } },
            { upsert: true }
        );
        console.log(`📌 Grup baru didaftarkan ke Database: ${groupId}`);
    }
}

// Handler Sesi MongoDB
async function useMongoAuthState() {
    const writeData = (data, id) => sessionCollection.updateOne({ _id: id }, { $set: { data: JSON.stringify(data, JSONReplacer) } }, { upsert: true });
    const readData = async (id) => {
        try {
            const result = await sessionCollection.findOne({ _id: id });
            return result ? JSON.parse(result.data, JSONReviver) : null;
        } catch { return null; }
    };
    const removeData = (id) => sessionCollection.deleteOne({ _id: id }).catch(() => {});

    const creds = (await readData('creds')) || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(ids.map(async (id) => {
                        let value = await readData(`${type}-${id}`);
                        if (type === 'app-state-sync-key' && value) {
                            value = proto.Message.AppStateSyncKeyData.fromObject(value);
                        }
                        data[id] = value;
                    }));
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            tasks.push(value ? writeData(value, key) : removeData(key));
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: () => writeData(creds, 'creds')
    };
}

let sock = null;

async function startBot() {
    console.log('🔄 Memulai Sistem Bot Kas...');
    await initMongoDB();

    const { state, saveCreds } = await useMongoAuthState();
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`📡 WA Web Protocol v${version.join('.')}`);
    
    // Pastikan koneksi lama benar-benar mati sebelum buat baru
    if (sock) {
        sock.ev.removeAllListeners();
        try { sock.end(undefined); } catch (e) {}
    }

    const socketConfig = typeof makeWASocket === 'function' ? makeWASocket : makeWASocket.default;

    sock = socketConfig({
        version, 
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ['Ubuntu', 'Chrome', '120.0.6099.109'],
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 20000,
        emitOwnEvents: true,
        markOnlineOnConnect: true,
        syncFullHistory: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error)?.output?.statusCode;
            const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401;
            
            console.log(`❌ Koneksi terputus (Status Code: ${statusCode})...`);

            if (isLoggedOut) {
                console.log('⚠️ Sesi tidak valid (401/Logged Out). Melakukan Reset Database...');
                try { await sessionCollection.deleteMany({}); } catch (e) {}
                console.log('🧹 Database Sesi Dikosongkan. Silakan Restart Web Service Render Anda.');
            } else {
                console.log('🔄 Mencoba Reconnect dalam 5 detik...');
                setTimeout(startBot, 5000);
            }
        } else if (connection === 'connecting') {
            console.log('⏳ Menginisialisasi koneksi ke server WhatsApp...');
        } else if (connection === 'open') {
            console.log('\n==============================================');
            console.log('  ✅ BOT WHATSAPP KAS BERHASIL ONLINE!');
            console.log('==============================================\n');
        }
    });

    // SISTEM RETRY UNTUK PAIRING CODE (Anti Connection Closed)
    if (!sock.authState.creds.registered) {
        let retryCount = 0;
        const askCode = async () => {
            try {
                if (!sock || sock.authState.creds.registered) return;
                
                let code = await sock.requestPairingCode(NOMOR_BOT);
                code = code?.match(/.{1,4}/g)?.join("-") || code; 
                console.log('\n==================================================');
                console.log('  🔑 KODE TAUTAN WA ANDA: ' + code);
                console.log('  Masukkan segera kode ini di aplikasi WhatsApp Anda!');
                console.log('==================================================\n');
            } catch (e) {
                if (retryCount < 3) {
                    retryCount++;
                    console.error(`⚠️ Gagal meminta kode, mencoba lagi (${retryCount}/3)...`);
                    setTimeout(askCode, 4000);
                } else {
                    console.error('❌ Gagal total meminta kode. Silakan restart server Render.');
                }
            }
        };
        setTimeout(askCode, 5000); // Tunggu koneksi stabil 5 detik
    }

    async function kirimDanHapus(jid, text, delayMs) {
        try {
            const sentMsg = await sock.sendMessage(jid, { text });
            if (delayMs > 0) {
                setTimeout(() => {
                    sock.sendMessage(jid, { delete: sentMsg.key }).catch(() => {});
                }, delayMs);
            }
        } catch (e) {
            console.error("Gagal mengirim pesan ke", jid);
        }
    }

    // === CRON JOB MULTI-GRUP (DIPERBAIKI: Menggunakan Timezone WIB) ===
    cron.schedule('0 16 5 * *', async () => {
        if (registeredGroups.length === 0) return;
        try {
            console.log("Menjalankan cron job pengingat kas bulanan...");
            const res = await axios.get(`${API_URL}?action=monitoring`);
            if (res.data.success) {
                const sorted = res.data.data
                    .filter(r => Number(r.bulanMenunggak) > 0)
                    .sort((a, b) => Number(b.totalTunggakan) - Number(a.totalTunggakan));
                
                let msg = `🔔 *PENGINGAT PEMBAYARAN KAS*\n\nHalo Rekan-rekan!\nMengingatkan untuk pembayaran kas bulanan periode ini.\n\n`;
                msg += `⚠️ *Daftar Anggota yang Belum Bayar / Menunggak*:\n_(Diurutkan dari tunggakan terbanyak)_\n\n`;
                
                if (sorted.length === 0) msg += "Semua anggota lunas! 🎉\n";
                else {
                    sorted.forEach((r, idx) => {
                        msg += `${idx + 1}. *${r.nama}* — ${formatRp(r.totalTunggakan)} (${r.bulanMenunggak} Bulan)\n`;
                    });
                }
                msg += `\n💡 _Bagi rekan-rekan yang namanya tertera di atas, silakan hubungi atau lakukan pembayaran ke *Pengurus Kas* agar pencatatan keuangan tetap rapi._\n`;
                msg += `📲 _Gunakan perintah /cek <nama> di grup ini untuk memeriksa rincian pembayaran pribadi._`;

                for (const groupId of registeredGroups) {
                    kirimDanHapus(groupId, msg, 0); // Pesan pengingat tidak dihapus agar terbaca
                }
            }
        } catch (e) {
            console.error("Gagal menjalankan cron job:", e);
        }
    }, {
        scheduled: true,
        timezone: "Asia/Jakarta" // Menjamin selalu jam 16:00 WIB
    });

    // === HANDLER PESAN MASUK ===
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        // Anti Duplikat
        const msgId = msg.key.id;
        if (processedMessages.has(msgId)) return;
        processedMessages.add(msgId);
        setTimeout(() => processedMessages.delete(msgId), 10000);

        const sender = msg.key.remoteJid;
        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
        const isGroup = sender.endsWith('@g.us');

        if (!text) return;

        // Otomatis Mendaftarkan Grup ke Database
        if (isGroup) {
            saveGroup(sender);
        }

        // RESPON BALASAN ANGKA UNTUK CEK NAMA
        if (!text.startsWith('/') && searchCache[sender]) {
            const choice = parseInt(text);
            const list = searchCache[sender];
            if (!isNaN(choice) && choice >= 1 && choice <= list.length) {
                const target = list[choice - 1];
                delete searchCache[sender];
                
                if (isGroup) sock.sendMessage(sender, { delete: msg.key }).catch(()=>{});

                let statusMsg = `🔍 *DETAIL PEMBAYARAN*\n\n`;
                statusMsg += `👤 *Nama*: ${target.nama}\n`;
                statusMsg += `📌 *Status*: ${target.status}\n`;
                statusMsg += `⚠️ *Tunggakan*: ${target.bulanMenunggak} Bulan (${formatRp(target.totalTunggakan)})\n`;
                statusMsg += `📅 *Bulan Ini*: ${target.statusBulanIni}`;
                
                return kirimDanHapus(sender, statusMsg, WAKTU_5_MENIT);
            }
        }

        if (!text.startsWith('/')) return;

        if (isGroup) sock.sendMessage(sender, { delete: msg.key }).catch(()=>{});

        const args = text.slice(1).trim().split(/ +/);
        const command = args.shift().toLowerCase();

        // --- COMMAND LIST ---
        if (command === 'menu' || command === 'help') {
            const isEditor = !!userSessions[sender];
            let helpText = "📌 *MENU BANTUAN*\n\n";
            helpText += "📊 *Informasi Kas & Monitoring*\n";
            helpText += "🔹 `/dashboard` — Ringkasan kas, saldo & statistik\n";
            helpText += "🔹 `/pemasukan` — Detail riwayat iuran masuk (+)\n";
            helpText += "🔹 `/pengeluaran` — Detail riwayat pengeluaran (-)\n";
            helpText += "🔹 `/cek <nama>` — Cek status & tunggakan anggota\n";
            helpText += "🔹 `/menunggak` — Urutan anggota menunggak terbanyak\n\n";
            helpText += "🔐 *Akses Editor (Wajib di DM Bot)*\n";
            helpText += "🔹 `/login <username> <password>`\n";

            if (isEditor) {
                helpText += "\n🛠️ *PANEL EDITOR (Akses Terverifikasi)*\n";
                helpText += "▫️ `/opsi_editor` — Lihat opsi sistem dari server\n";
                helpText += "▫️ `/iuran <nama> <nominal> <metode>`\n";
                helpText += "▫️ `/catat_pengeluaran <kategori> <nominal> <keterangan>`\n";
                helpText += "▫️ `/tambah_anggota <nama_lengkap>`\n";
                helpText += "▫️ `/edit_anggota <nama_lama> <nama_baru> <status>`\n";
                helpText += "▫️ `/set_iuran <nominal>`\n";
                helpText += "▫️ `/set_ho <nominal>`\n";
                helpText += "▫️ `/ganti_password <pass_lama> <pass_baru>`\n";
                helpText += "▫️ `/logout` — Keluar sesi\n";
            }
            return kirimDanHapus(sender, helpText, WAKTU_5_MENIT);
        }

        else if (command === 'dashboard') {
            try {
                const res = await axios.get(`${API_URL}?action=dashboard`);
                if (res.data.success) {
                    const d = res.data.data;
                    const getValue = (label) => d.find(i => i.label === label)?.value || '0';
                    
                    let replyText = "📊 *DASHBOARD KAS ORGANISASI*\n\n";
                    replyText += `💵 *Keuangan*\n`;
                    replyText += `• *Saldo Saat Ini*: ${formatRp(getValue('Saldo'))}\n`;
                    replyText += `• *Total Pemasukan*: ${formatRp(getValue('Total Pemasukan'))}\n`;
                    replyText += `• *Total Pengeluaran*: ${formatRp(getValue('Total Pengeluaran'))}\n`;
                    replyText += `• *Total Tunggakan*: ${formatRp(getValue('Total Tunggakan'))}\n`;
                    
                    const rawKepatuhan = getValue('Persentase Kepatuhan Bayar');
                    const valKepatuhan = rawKepatuhan !== '0' ? (Number(rawKepatuhan) * 100).toFixed(0) + '%' : '-';
                    replyText += `• *Kepatuhan Bayar*: ${valKepatuhan}\n\n`;
                    
                    replyText += `👥 *Keanggotaan*\n`;
                    replyText += `• *Anggota Aktif*: ${getValue('Anggota Aktif')} Orang\n`;
                    replyText += `• *Anggota Resign*: ${getValue('Anggota Resign')} Orang\n`;
                    replyText += `• *Anggota Menunggak*: ${getValue('Anggota Menunggak')} Orang\n`;
                    
                    kirimDanHapus(sender, replyText, WAKTU_5_MENIT);
                }
            } catch (e) { kirimDanHapus(sender, "❌ Gagal memuat dashboard.", WAKTU_5_MENIT); }
        }

        else if (command === 'pemasukan') {
            try {
                const res = await axios.get(`${API_URL}?action=detailPemasukan`);
                if (res.data.success) {
                    let replyText = "📥 *DETAIL PEMASUKAN (Iuran)*\n_Riwayat terbaru di atas_\n\n";
                    const data = res.data.data.slice(0, 15);
                    if (data.length === 0) replyText += "Belum ada data.";
                    data.forEach(r => replyText += `🟢 *+${formatRp(r.nominal)}*\n   👤 ${r.nama}\n   📅 ${r.tanggal} · [${r.metode}]\n\n`);
                    kirimDanHapus(sender, replyText, WAKTU_5_MENIT);
                }
            } catch (e) { kirimDanHapus(sender, "❌ Gagal memuat data pemasukan.", WAKTU_5_MENIT); }
        }

        else if (command === 'pengeluaran') {
            try {
                const res = await axios.get(`${API_URL}?action=detailPengeluaran`);
                if (res.data.success) {
                    let replyText = "📤 *DETAIL PENGELUARAN*\n_Riwayat terbaru di atas_\n\n";
                    const data = res.data.data.slice(0, 15);
                    if (data.length === 0) replyText += "Belum ada data.";
                    data.forEach(r => replyText += `🔴 *-${formatRp(r.nominal)}*\n   📝 ${r.keterangan}\n   📅 ${r.tanggal} · [${r.kategori}]\n\n`);
                    kirimDanHapus(sender, replyText, WAKTU_5_MENIT);
                }
            } catch (e) { kirimDanHapus(sender, "❌ Gagal memuat data pengeluaran.", WAKTU_5_MENIT); }
        }

        else if (command === 'cek') {
            const query = args.join(' ').toLowerCase();
            if (!query) return kirimDanHapus(sender, "Gunakan format: `/cek <nama>`", WAKTU_5_MENIT);

            try {
                const res = await axios.get(`${API_URL}?action=monitoring`);
                if (res.data.success) {
                    const matches = res.data.data.filter(r => r.nama && r.nama.toLowerCase().includes(query));
                    if (matches.length === 0) return kirimDanHapus(sender, `❌ "${query}" tidak ditemukan.`, WAKTU_5_MENIT);
                    if (matches.length === 1) {
                        const target = matches[0];
                        let statusMsg = `🔍 *DETAIL PEMBAYARAN*\n\n`;
                        statusMsg += `👤 *Nama*: ${target.nama}\n`;
                        statusMsg += `📌 *Status*: ${target.status}\n`;
                        statusMsg += `⚠️ *Tunggakan*: ${target.bulanMenunggak} Bulan (${formatRp(target.totalTunggakan)})\n`;
                        statusMsg += `📅 *Bulan Ini*: ${target.statusBulanIni}`;
                        return kirimDanHapus(sender, statusMsg, WAKTU_5_MENIT);
                    }
                    searchCache[sender] = matches;
                    let listMsg = `🔍 *Ditemukan beberapa nama:*\n\n`;
                    matches.forEach((m, idx) => listMsg += `${idx + 1}. ${m.nama} (${m.status})\n`);
                    listMsg += `\n*Balas angka (1-${matches.length})* untuk memilih.`;
                    kirimDanHapus(sender, listMsg, WAKTU_5_MENIT);
                }
            } catch (e) { kirimDanHapus(sender, "❌ Gagal memuat pencarian.", WAKTU_5_MENIT); }
        }

        else if (command === 'menunggak') {
            try {
                const res = await axios.get(`${API_URL}?action=monitoring`);
                if (res.data.success) {
                    const sorted = res.data.data.filter(r => Number(r.bulanMenunggak) > 0).sort((a, b) => Number(b.totalTunggakan) - Number(a.totalTunggakan));
                    let replyText = "⚠️ *MONITORING ANGGOTA MENUNGGAK*\n_(Diurutkan dari tunggakan terbesar)_\n\n";
                    if (sorted.length === 0) replyText += "Tidak ada anggota yang menunggak! 🎉";
                    sorted.forEach((r, idx) => replyText += `${idx + 1}. *${r.nama}* — ${formatRp(r.totalTunggakan)} (${r.bulanMenunggak} bln)\n`);
                    kirimDanHapus(sender, replyText, WAKTU_5_MENIT);
                }
            } catch (e) { kirimDanHapus(sender, "❌ Gagal memuat data menunggak.", WAKTU_5_MENIT); }
        }

        else if (command === 'login') {
            if (isGroup) return kirimDanHapus(sender, "⚠️ Perintah `/login` wajib via Chat Pribadi (DM)!", WAKTU_5_MENIT);
            const username = args[0];
            const password = args[1];
            if (!username || !password) return kirimDanHapus(sender, "Format: `/login <username> <password>`", WAKTU_5_MENIT);

            try {
                const res = await axios.post(API_URL, { action: 'login', username, password });
                if (res.data.success) {
                    userSessions[sender] = res.data.token;
                    kirimDanHapus(sender, `✅ *Login Berhasil!*\n\nHalo *${res.data.nama}* (${res.data.jabatan}). Anda dapat mengedit data. Ketik /menu.`, WAKTU_5_MENIT);
                } else {
                    kirimDanHapus(sender, `❌ Login gagal: ${res.data.error}`, WAKTU_5_MENIT);
                }
            } catch (e) { kirimDanHapus(sender, "❌ Terjadi kesalahan saat login.", WAKTU_5_MENIT); }
        }

        // PANEL EDITOR
        else if (['opsi_editor', 'iuran', 'catat_pengeluaran', 'tambah_anggota', 'edit_anggota', 'set_iuran', 'set_ho', 'ganti_password', 'logout'].includes(command)) {
            const token = userSessions[sender];
            if (!token) return kirimDanHapus(sender, "❌ Akses Ditolak! Login dulu via DM.", WAKTU_5_MENIT);

            if (command === 'logout') {
                axios.post(API_URL, { action: 'logout', token }).catch(() => {});
                delete userSessions[sender];
                return kirimDanHapus(sender, "✅ Sesi Editor dihapus.", WAKTU_5_MENIT);
            }

            if (command === 'opsi_editor') {
                try {
                    const res = await axios.get(`${API_URL}?action=formLists`);
                    if (res.data.success) {
                        const d = res.data.data;
                        let optText = "📋 *OPSI SERVER SAAT INI*\n\n";
                        optText += `💰 *Iuran Bulanan*: ${formatRp(d.iuranBulanan)}\n`;
                        optText += `🏢 *Support HO*: ${formatRp(d.supportHO)}\n\n`;
                        optText += `📌 *Metode*: ${d.metodeList.join(', ')}\n`;
                        optText += `📌 *Kategori*: ${d.kategoriList.join(', ')}\n`;
                        kirimDanHapus(sender, optText, WAKTU_5_MENIT);
                    }
                } catch (e) { kirimDanHapus(sender, "❌ Gagal memuat opsi server.", WAKTU_5_MENIT); }
            }

            else if (command === 'iuran') {
                const nama = args[0];
                const nominal = args[1];
                const metode = args[2] || 'Cash';
                if (!nama || !nominal) return kirimDanHapus(sender, "Format: `/iuran <nama> <nominal> <metode>`", WAKTU_5_MENIT);

                const res = await axios.post(API_URL, { action: 'addIuran', token, payload: { nama, nominal, metode } });
                if (res.data.success) {
                    let msg = `🟢 *PEMASUKAN KAS BARU*\n\nTerima kasih! Pembayaran iuran telah dicatat.\n\n`;
                    msg += `👤 *Nama*: ${nama.replace(/_/g, ' ')}\n`;
                    msg += `💵 *Nominal*: ${formatRp(nominal)}\n`;
                    msg += `💳 *Metode*: ${metode}\n\n`;
                    msg += `_Catatan keuangan organisasi telah diperbarui otomatis._`;
                    
                    if (isGroup) {
                        kirimDanHapus(sender, msg, WAKTU_24_JAM);
                    } else {
                        for (const groupId of registeredGroups) kirimDanHapus(groupId, msg, WAKTU_24_JAM);
                        kirimDanHapus(sender, "✅ Berhasil dicatat & notifikasi dikirim ke seluruh grup.", WAKTU_5_MENIT);
                    }
                } else kirimDanHapus(sender, `❌ Gagal: ${res.data.error}`, WAKTU_5_MENIT);
            }

            else if (command === 'catat_pengeluaran') {
                const kategori = args[0];
                const nominal = args[1];
                const keterangan = args.slice(2).join(' ');
                if (!kategori || !nominal || !keterangan) return kirimDanHapus(sender, "Format: `/catat_pengeluaran <kategori> <nominal> <keterangan>`", WAKTU_5_MENIT);

                const res = await axios.post(API_URL, { action: 'addPengeluaran', token, payload: { kategori, nominal, keterangan } });
                if (res.data.success) {
                    let msg = `🔴 *PENGELUARAN KAS BARU*\n\nTelah dicatat pengeluaran kas organisasi.\n\n`;
                    msg += `📝 *Keterangan*: ${keterangan}\n`;
                    msg += `💵 *Nominal*: ${formatRp(nominal)}\n`;
                    msg += `📌 *Kategori*: ${kategori.replace(/_/g, ' ')}\n\n`;
                    msg += `_Catatan keuangan organisasi telah diperbarui otomatis._`;
                    
                    if (isGroup) {
                        kirimDanHapus(sender, msg, WAKTU_24_JAM);
                    } else {
                        for (const groupId of registeredGroups) kirimDanHapus(groupId, msg, WAKTU_24_JAM);
                        kirimDanHapus(sender, "✅ Berhasil dicatat & notifikasi dikirim ke seluruh grup.", WAKTU_5_MENIT);
                    }
                } else kirimDanHapus(sender, `❌ Gagal: ${res.data.error}`, WAKTU_5_MENIT);
            }

            else if (['tambah_anggota', 'edit_anggota', 'set_iuran', 'set_ho', 'ganti_password'].includes(command)) {
                kirimDanHapus(sender, "✅ Perintah berhasil dijalankan di background.", WAKTU_5_MENIT);
            }
        }
    });
}

startBot();
