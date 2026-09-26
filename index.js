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

process.on('uncaughtException', console.error);
process.on('unhandledRejection', console.error);

const port = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot WhatsApp Kas Production Server Aktif!\n');
}).listen(port, () => console.log(`🌍 Web server aktif di port ${port}`));

const API_URL = 'https://script.google.com/macros/s/AKfycbzrgUNXaXz4NGbod6OMqBJ0Ieo0AJgD5kZMIrRUyNL8ey2xhKW0N0J-hXTV5C40VpP67g/exec';
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://bot-WA-tele:bot123@cluster0.sxnekhs.mongodb.net/bot_kas?retryWrites=true&w=majority';
const NOMOR_BOT = '6285956143731'; 

const WAKTU_5_MENIT = 5 * 60 * 1000;
const WAKTU_24_JAM = 24 * 60 * 60 * 1000;
const formatRp = (num) => 'Rp ' + Number(num || 0).toLocaleString('id-ID');

const userSessions = {};
const searchCache = {};
const processedMessages = new Set();
let registeredGroups = [];

const JSONReplacer = (k, v) => (Buffer.isBuffer(v) || v?.type === 'Buffer' ? { type: 'Buffer', data: v.data || v.toString('base64') } : v);
const JSONReviver = (k, v) => (v?.type === 'Buffer' ? Buffer.from(v.data || v, 'base64') : v);

let mongoClient;
let sessionCollection;
let configCollection;

async function initMongoDB() {
    if (!mongoClient) {
        mongoClient = new MongoClient(MONGO_URI);
        await mongoClient.connect();
        const db = mongoClient.db('bot_whatsapp');
        sessionCollection = db.collection('session_kas');
        configCollection = db.collection('app_config');
        
        const config = await configCollection.findOne({ _id: 'registered_groups' });
        if (config && config.groups) {
            registeredGroups = config.groups;
        }
    }
}

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
    const { version } = await fetchLatestBaileysVersion();
    
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
                console.log('⚠️ Sesi tidak valid. Melakukan Reset Database...');
                try { await sessionCollection.deleteMany({}); } catch (e) {}
            } else {
                console.log('🔄 Mencoba Reconnect dalam 5 detik...');
                setTimeout(startBot, 5000);
            }
        } else if (connection === 'open') {
            console.log('\n==============================================');
            console.log('  ✅ BOT WHATSAPP KAS BERHASIL ONLINE!');
            console.log('==============================================\n');
        }
    });

    if (!sock.authState.creds.registered) {
        let retryCount = 0;
        const askCode = async () => {
            try {
                if (!sock || sock.authState.creds.registered) return;
                let code = await sock.requestPairingCode(NOMOR_BOT);
                code = code?.match(/.{1,4}/g)?.join("-") || code; 
                console.log(`\n🔑 KODE PAIRING WA: ${code}\n`);
            } catch (e) {
                if (retryCount < 3) {
                    retryCount++;
                    setTimeout(askCode, 4000);
                }
            }
        };
        setTimeout(askCode, 5000);
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

    // CRON JOB PENGINGAT (Tgl 5 Jam 16:00 WIB)
    cron.schedule('0 16 5 * *', async () => {
        if (registeredGroups.length === 0) return;
        try {
            const res = await axios.get(`${API_URL}?action=monitoring`);
            if (res.data.success) {
                const sorted = res.data.data
                    .filter(r => Number(r.bulanMenunggak) > 0)
                    .sort((a, b) => Number(b.totalTunggakan) - Number(a.totalTunggakan));
                
                let msg = `🔔 *PENGINGAT PEMBAYARAN KAS*\n\nHalo Rekan-rekan!\nMengingatkan untuk pembayaran kas bulanan periode ini.\n\n`;
                msg += `⚠️ *Daftar Anggota Menunggak*:\n`;
                
                if (sorted.length === 0) msg += "Semua anggota lunas! 🎉\n";
                else {
                    sorted.forEach((r, idx) => {
                        msg += `${idx + 1}. *${r.nama}* — ${formatRp(r.totalTunggakan)} (${r.bulanMenunggak} Bulan)\n`;
                    });
                }
                msg += `\n📲 _Gunakan perintah /cek <nama> di grup ini untuk cek data pribadi._`;

                for (const groupId of registeredGroups) {
                    kirimDanHapus(groupId, msg, 0);
                }
            }
        } catch (e) {
            console.error("Cron job error:", e);
        }
    }, {
        scheduled: true,
        timezone: "Asia/Jakarta"
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const msgId = msg.key.id;
        if (processedMessages.has(msgId)) return;
        processedMessages.add(msgId);
        setTimeout(() => processedMessages.delete(msgId), 10000);

        const sender = msg.key.remoteJid;
        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
        const isGroup = sender.endsWith('@g.us');

        if (!text) return;

        if (isGroup) {
            saveGroup(sender);
        }

        // RESPON ANGKA PENCARIAN
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

        if (command === 'menu' || command === 'help') {
            const isEditor = !!userSessions[sender];
            let helpText = "📌 *MENU BANTUAN*\n\n";
            helpText += "📊 *Informasi Kas & Monitoring*\n";
            helpText += "🔹 `/dashboard` — Ringkasan kas & saldo\n";
            helpText += "🔹 `/pemasukan` — Riwayat iuran masuk\n";
            helpText += "🔹 `/pengeluaran` — Riwayat pengeluaran\n";
            helpText += "🔹 `/cek <nama>` — Cek status & tunggakan\n";
            helpText += "🔹 `/menunggak` — Daftar menunggak terbanyak\n\n";
            helpText += "🔐 *Akses Editor (DM Bot)*\n";
            helpText += "🔹 `/login <username> <password>`\n";

            if (isEditor) {
                helpText += "\n🛠️ *PANEL EDITOR AKTIF*\n";
                helpText += "▫️ `/opsi_editor` — Cek opsi server\n";
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
                    
                    let replyText = "📊 *DASHBOARD KAS*\n\n";
                    replyText += `💵 *Keuangan*\n`;
                    replyText += `• Saldo: ${formatRp(getValue('Saldo'))}\n`;
                    replyText += `• Pemasukan: ${formatRp(getValue('Total Pemasukan'))}\n`;
                    replyText += `• Pengeluaran: ${formatRp(getValue('Total Pengeluaran'))}\n`;
                    replyText += `• Tunggakan: ${formatRp(getValue('Total Tunggakan'))}\n\n`;
                    replyText += `👥 *Keanggotaan*\n`;
                    replyText += `• Aktif: ${getValue('Anggota Aktif')} Orang\n`;
                    replyText += `• Menunggak: ${getValue('Anggota Menunggak')} Orang\n`;
                    
                    kirimDanHapus(sender, replyText, WAKTU_5_MENIT);
                }
            } catch (e) { kirimDanHapus(sender, "❌ Gagal memuat dashboard.", WAKTU_5_MENIT); }
        }

        else if (command === 'pemasukan') {
            try {
                const res = await axios.get(`${API_URL}?action=detailPemasukan`);
                if (res.data.success) {
                    let replyText = "📥 *DETAIL PEMASUKAN*\n\n";
                    const data = res.data.data.slice(0, 15);
                    if (data.length === 0) replyText += "Belum ada data.";
                    data.forEach(r => replyText += `🟢 *+${formatRp(r.nominal)}*\n   👤 ${r.nama}\n   📅 ${r.tanggal} [${r.metode}]\n\n`);
                    kirimDanHapus(sender, replyText, WAKTU_5_MENIT);
                }
            } catch (e) { kirimDanHapus(sender, "❌ Gagal memuat pemasukan.", WAKTU_5_MENIT); }
        }

        else if (command === 'pengeluaran') {
            try {
                const res = await axios.get(`${API_URL}?action=detailPengeluaran`);
                if (res.data.success) {
                    let replyText = "📤 *DETAIL PENGELUARAN*\n\n";
                    const data = res.data.data.slice(0, 15);
                    if (data.length === 0) replyText += "Belum ada data.";
                    data.forEach(r => replyText += `🔴 *-${formatRp(r.nominal)}*\n   📝 ${r.keterangan}\n   📅 ${r.tanggal} [${r.kategori}]\n\n`);
                    kirimDanHapus(sender, replyText, WAKTU_5_MENIT);
                }
            } catch (e) { kirimDanHapus(sender, "❌ Gagal memuat pengeluaran.", WAKTU_5_MENIT); }
        }

        else if (command === 'cek') {
            const query = args.join(' ').toLowerCase();
            if (!query) return kirimDanHapus(sender, "Format: `/cek <nama>`", WAKTU_5_MENIT);

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
                    let replyText = "⚠️ *ANGGOTA MENUNGGAK*\n\n";
                    if (sorted.length === 0) replyText += "Semua anggota lunas! 🎉";
                    sorted.forEach((r, idx) => replyText += `${idx + 1}. *${r.nama}* — ${formatRp(r.totalTunggakan)} (${r.bulanMenunggak} bln)\n`);
                    kirimDanHapus(sender, replyText, WAKTU_5_MENIT);
                }
            } catch (e) { kirimDanHapus(sender, "❌ Gagal memuat data menunggak.", WAKTU_5_MENIT); }
        }

        else if (command === 'login') {
            if (isGroup) return kirimDanHapus(sender, "⚠️ Perintah `/login` wajib via DM Bot!", WAKTU_5_MENIT);
            const username = args[0];
            const password = args[1];
            if (!username || !password) return kirimDanHapus(sender, "Format: `/login <username> <password>`", WAKTU_5_MENIT);

            try {
                const res = await axios.post(API_URL, { action: 'login', username, password });
                if (res.data.success) {
                    userSessions[sender] = res.data.token;
                    kirimDanHapus(sender, `✅ *Login Berhasil!*\nHalo *${res.data.nama}* (${res.data.jabatan}). Ketik /menu untuk opsi editor.`, WAKTU_5_MENIT);
                } else {
                    kirimDanHapus(sender, `❌ Login gagal: ${res.data.error}`, WAKTU_5_MENIT);
                }
            } catch (e) { kirimDanHapus(sender, "❌ Terjadi kesalahan saat login.", WAKTU_5_MENIT); }
        }

        // ================= ACTION EDITOR =================
        else if (['opsi_editor', 'iuran', 'catat_pengeluaran', 'tambah_anggota', 'edit_anggota', 'set_iuran', 'set_ho', 'ganti_password', 'logout'].includes(command)) {
            const token = userSessions[sender];
            if (!token) return kirimDanHapus(sender, "❌ Akses Ditolak! Silakan login via DM.", WAKTU_5_MENIT);

            if (command === 'logout') {
                axios.post(API_URL, { action: 'logout', token }).catch(() => {});
                delete userSessions[sender];
                return kirimDanHapus(sender, "✅ Sesi Editor berhasil logout.", WAKTU_5_MENIT);
            }

            if (command === 'opsi_editor') {
                try {
                    const res = await axios.get(`${API_URL}?action=formLists`);
                    if (res.data.success) {
                        const d = res.data.data;
                        let optText = "📋 *PENGATURAN SERVER*\n\n";
                        optText += `💰 *Iuran Bulanan*: ${formatRp(d.iuranBulanan)}\n`;
                        optText += `🏢 *Support HO*: ${formatRp(d.supportHO)}\n\n`;
                        optText += `📌 *Metode*: ${d.metodeList.join(', ')}\n`;
                        optText += `📌 *Kategori*: ${d.kategoriList.join(', ')}\n`;
                        kirimDanHapus(sender, optText, WAKTU_5_MENIT);
                    }
                } catch (e) { kirimDanHapus(sender, "❌ Gagal memuat opsi server.", WAKTU_5_MENIT); }
            }

            else if (command === 'iuran') {
                const nama = (args[0] || '').replace(/_/g, ' ');
                const nominal = args[1];
                const metode = args[2] || 'Cash';
                if (!nama || !nominal || isNaN(nominal)) return kirimDanHapus(sender, "Format: `/iuran <nama> <nominal> <metode>`\nContoh: `/iuran Budi_Santoso 50000 Transfer`", WAKTU_5_MENIT);

                try {
                    const res = await axios.post(API_URL, { action: 'addIuran', token, payload: { nama, nominal, metode } });
                    if (res.data.success) {
                        let msg = `🟢 *PEMASUKAN KAS BARU*\n\n`;
                        msg += `👤 *Nama*: ${nama}\n`;
                        msg += `💵 *Nominal*: ${formatRp(nominal)}\n`;
                        msg += `💳 *Metode*: ${metode}\n`;
                        
                        if (isGroup) {
                            kirimDanHapus(sender, msg, WAKTU_24_JAM);
                        } else {
                            for (const groupId of registeredGroups) kirimDanHapus(groupId, msg, WAKTU_24_JAM);
                            kirimDanHapus(sender, "✅ Pembayaran berhasil dicatat & dibagikan ke grup.", WAKTU_5_MENIT);
                        }
                    } else kirimDanHapus(sender, `❌ Gagal: ${res.data.error}`, WAKTU_5_MENIT);
                } catch (e) { kirimDanHapus(sender, "❌ Server API tidak merespons.", WAKTU_5_MENIT); }
            }

            else if (command === 'catat_pengeluaran') {
                const kategori = (args[0] || '').replace(/_/g, ' ');
                const nominal = args[1];
                const keterangan = args.slice(2).join(' ');
                if (!kategori || !nominal || !keterangan || isNaN(nominal)) return kirimDanHapus(sender, "Format: `/catat_pengeluaran <kategori> <nominal> <keterangan>`\nContoh: `/catat_pengeluaran Konsumsi 150000 Snack Rapat`", WAKTU_5_MENIT);

                try {
                    const res = await axios.post(API_URL, { action: 'addPengeluaran', token, payload: { kategori, nominal, keterangan } });
                    if (res.data.success) {
                        let msg = `🔴 *PENGELUARAN KAS BARU*\n\n`;
                        msg += `📝 *Keterangan*: ${keterangan}\n`;
                        msg += `💵 *Nominal*: ${formatRp(nominal)}\n`;
                        msg += `📌 *Kategori*: ${kategori}\n`;
                        
                        if (isGroup) {
                            kirimDanHapus(sender, msg, WAKTU_24_JAM);
                        } else {
                            for (const groupId of registeredGroups) kirimDanHapus(groupId, msg, WAKTU_24_JAM);
                            kirimDanHapus(sender, "✅ Pengeluaran berhasil dicatat & dibagikan ke grup.", WAKTU_5_MENIT);
                        }
                    } else kirimDanHapus(sender, `❌ Gagal: ${res.data.error}`, WAKTU_5_MENIT);
                } catch (e) { kirimDanHapus(sender, "❌ Server API tidak merespons.", WAKTU_5_MENIT); }
            }

            else if (command === 'tambah_anggota') {
                const nama = args.join(' ').replace(/_/g, ' ');
                if (!nama) return kirimDanHapus(sender, "Format: `/tambah_anggota <nama_lengkap>`", WAKTU_5_MENIT);

                try {
                    const res = await axios.post(API_URL, { action: 'addAnggota', token, payload: { nama, status: 'Aktif' } });
                    if (res.data.success) {
                        kirimDanHapus(sender, `✅ Anggota *${nama}* berhasil ditambahkan ke database.`, WAKTU_5_MENIT);
                    } else kirimDanHapus(sender, `❌ Gagal: ${res.data.error}`, WAKTU_5_MENIT);
                } catch (e) { kirimDanHapus(sender, "❌ Server API tidak merespons.", WAKTU_5_MENIT); }
            }

            else if (command === 'edit_anggota') {
                const namaLama = (args[0] || '').replace(/_/g, ' ');
                const namaBaru = (args[1] || '').replace(/_/g, ' ');
                const status = args[2] || 'Aktif';
                if (!namaLama || !namaBaru) return kirimDanHapus(sender, "Format: `/edit_anggota <nama_lama> <nama_baru> <status>`\nContoh: `/edit_anggota Budi_Santoso Budi_Pratama Resign`", WAKTU_5_MENIT);

                try {
                    const res = await axios.post(API_URL, { action: 'updateAnggota', token, payload: { namaLama, namaBaru, status } });
                    if (res.data.success) {
                        kirimDanHapus(sender, `✅ Data anggota *${namaLama}* berhasil diperbarui.`, WAKTU_5_MENIT);
                    } else kirimDanHapus(sender, `❌ Gagal: ${res.data.error}`, WAKTU_5_MENIT);
                } catch (e) { kirimDanHapus(sender, "❌ Server API tidak merespons.", WAKTU_5_MENIT); }
            }

            else if (command === 'set_iuran') {
                const nominal = args[0];
                if (!nominal || isNaN(nominal)) return kirimDanHapus(sender, "Format: `/set_iuran <nominal_angka>`", WAKTU_5_MENIT);

                try {
                    const res = await axios.post(API_URL, { action: 'updateSetting', token, payload: { parameter: 'Iuran Bulanan', nilai: nominal } });
                    if (res.data.success) {
                        kirimDanHapus(sender, `✅ Tarif Iuran Bulanan diubah menjadi: ${formatRp(nominal)}`, WAKTU_5_MENIT);
                    } else kirimDanHapus(sender, `❌ Gagal: ${res.data.error}`, WAKTU_5_MENIT);
                } catch (e) { kirimDanHapus(sender, "❌ Server API tidak merespons.", WAKTU_5_MENIT); }
            }

            else if (command === 'set_ho') {
                const nominal = args[0];
                if (!nominal || isNaN(nominal)) return kirimDanHapus(sender, "Format: `/set_ho <nominal_angka>`", WAKTU_5_MENIT);

                try {
                    const res = await axios.post(API_URL, { action: 'updateSetting', token, payload: { parameter: 'Support HO', nilai: nominal } });
                    if (res.data.success) {
                        kirimDanHapus(sender, `✅ Support HO diubah menjadi: ${formatRp(nominal)}`, WAKTU_5_MENIT);
                    } else kirimDanHapus(sender, `❌ Gagal: ${res.data.error}`, WAKTU_5_MENIT);
                } catch (e) { kirimDanHapus(sender, "❌ Server API tidak merespons.", WAKTU_5_MENIT); }
            }

            else if (command === 'ganti_password') {
                const oldPassword = args[0];
                const newPassword = args[1];
                if (!oldPassword || !newPassword) return kirimDanHapus(sender, "Format: `/ganti_password <pass_lama> <pass_baru>`", WAKTU_5_MENIT);

                try {
                    const res = await axios.post(API_URL, { action: 'changePassword', token, payload: { oldPassword, newPassword } });
                    if (res.data.success) {
                        kirimDanHapus(sender, "✅ Password akun editor Anda berhasil diperbarui.", WAKTU_5_MENIT);
                    } else kirimDanHapus(sender, `❌ Gagal: ${res.data.error}`, WAKTU_5_MENIT);
                } catch (e) { kirimDanHapus(sender, "❌ Server API tidak merespons.", WAKTU_5_MENIT); }
            }
        }
    });
}

startBot();
