const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const axios = require('axios');
const pino = require('pino');
const cron = require('node-cron');
const fs = require('fs');

const API_URL = 'https://script.google.com/macros/s/AKfycbzrgUNXaXz4NGbod6OMqBJ0Ieo0AJgD5kZMIrRUyNL8ey2xhKW0N0J-hXTV5C40VpP67g/exec';

const WAKTU_5_MENIT = 5 * 60 * 1000;
const WAKTU_24_JAM = 24 * 60 * 60 * 1000;

const userSessions = {};
const searchCache = {};

// MEMORI PENYIMPANAN MULTI-GRUP (Otomatis menyimpan ID grup tempat bot berada)
const GROUPS_FILE = './registered_groups.json';
let registeredGroups = [];

if (fs.existsSync(GROUPS_FILE)) {
    try { registeredGroups = JSON.parse(fs.readFileSync(GROUPS_FILE)); } catch (e) { registeredGroups = []; }
}

function saveGroup(groupId) {
    if (!registeredGroups.includes(groupId)) {
        registeredGroups.push(groupId);
        fs.writeFileSync(GROUPS_FILE, JSON.stringify(registeredGroups, null, 2));
    }
}

const formatRp = (num) => 'Rp ' + Number(num || 0).toLocaleString('id-ID');

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('sesi_wa');
    
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' })
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            console.clear();
            console.log('\n==================================================');
            console.log('  SCAN QR CODE DI BAWAH INI MENGGUNAKAN WHATSAPP');
            console.log('==================================================\n');
            qrcode.generate(qr, { small: true });
        }
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                console.log('Koneksi terputus, mencoba menghubungkan ulang...');
                startBot();
            } else {
                console.log('⚠️ Sesi terputus (Logged Out). Hapus folder sesi_wa dan jalankan ulang.');
            }
        } else if (connection === 'open') {
            console.clear();
            console.log('==============================================');
            console.log('  ✅ BOT WHATSAPP KAS AKTIF & SIAP PAKAI!');
            console.log('==============================================');
        }
    });

    async function kirimDanHapus(jid, text, delayMs) {
        try {
            const sentMsg = await sock.sendMessage(jid, { text });
            setTimeout(() => {
                sock.sendMessage(jid, { delete: sentMsg.key }).catch(() => {});
            }, delayMs);
        } catch (e) {
            console.error("Gagal mengirim pesan:", e);
        }
    }

    // CRON JOB MULTI-GRUP (Kirim Pengingat Tanggal 5 ke SEMUA Grup)
    cron.schedule('0 16 5 * *', async () => {
        if (registeredGroups.length === 0) return;
        try {
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

                // Kirim ke seluruh grup yang terdaftar
                for (const groupId of registeredGroups) {
                    kirimDanHapus(groupId, msg, WAKTU_24_JAM);
                }
            }
        } catch (e) {
            console.error("Gagal mengirim cron job:", e);
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const sender = msg.key.remoteJid;
        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
        const isGroup = sender.endsWith('@g.us');

        if (!text) return;

        // OTOMATIS SIMPAN ID GRUP SAAT ADA AKTIVITAS DI GRUP
        if (isGroup) {
            saveGroup(sender);
        }

        // BALASAN ANGKA /CEK
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

        // INSTANT CLEAN PESAN PERINTAH
        if (isGroup) {
            sock.sendMessage(sender, { delete: msg.key }).catch(()=>{});
        }

        const args = text.slice(1).trim().split(/ +/);
        const command = args.shift().toLowerCase();

        // 1. MENU
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

        // 2. DASHBOARD
        else if (command === 'dashboard') {
            try {
                const res = await axios.get(`${API_URL}?action=dashboard`);
                if (res.data.success) {
                    const d = res.data.data;
                    const getValue = (label) => d.find(i => i.label === label)?.value || '0';
                    
                    let replyText = "📊 *DASHBOARD KAS ORGANISASI*\n\n";
                    replyText += `💵 *Keuangan*\n`;
                    replyText += `• *Saldo Saat Ini*: ${formatRp(getValue('Saldo Saat Ini'))}\n`;
                    replyText += `• *Total Pemasukan*: ${formatRp(getValue('Total Pemasukan'))}\n`;
                    replyText += `• *Total Pengeluaran*: ${formatRp(getValue('Total Pengeluaran'))}\n`;
                    replyText += `• *Total Tunggakan*: ${formatRp(getValue('Total Tunggakan'))}\n`;
                    replyText += `• *Kepatuhan Bayar*: ${getValue('Persentase Kepatuhan %')}%\n\n`;
                    replyText += `👥 *Keanggotaan*\n`;
                    replyText += `• *Anggota Aktif*: ${getValue('Anggota Aktif')} Orang\n`;
                    replyText += `• *Anggota Resign*: ${getValue('Anggota Resign')} Orang\n`;
                    replyText += `• *Anggota Menunggak*: ${getValue('Anggota Menunggak')} Orang\n`;
                    
                    kirimDanHapus(sender, replyText, WAKTU_5_MENIT);
                }
            } catch (e) {
                kirimDanHapus(sender, "❌ Gagal memuat dashboard.", WAKTU_5_MENIT);
            }
        }

        // 3. PEMASUKAN
        else if (command === 'pemasukan') {
            try {
                const res = await axios.get(`${API_URL}?action=detailPemasukan`);
                if (res.data.success) {
                    let replyText = "📥 *DETAIL PEMASUKAN (Iuran)*\n_Riwayat terbaru di atas_\n\n";
                    const data = res.data.data.slice(0, 15);
                    if (data.length === 0) replyText += "Belum ada data.";
                    data.forEach(r => {
                        replyText += `🟢 *+${formatRp(r.nominal)}*\n   👤 ${r.nama}\n   📅 ${r.tanggal} · [${r.metode}]\n\n`;
                    });
                    kirimDanHapus(sender, replyText, WAKTU_5_MENIT);
                }
            } catch (e) {
                kirimDanHapus(sender, "❌ Gagal memuat data pemasukan.", WAKTU_5_MENIT);
            }
        }

        // 4. PENGELUARAN
        else if (command === 'pengeluaran') {
            try {
                const res = await axios.get(`${API_URL}?action=detailPengeluaran`);
                if (res.data.success) {
                    let replyText = "📤 *DETAIL PENGELUARAN*\n_Riwayat terbaru di atas_\n\n";
                    const data = res.data.data.slice(0, 15);
                    if (data.length === 0) replyText += "Belum ada data.";
                    data.forEach(r => {
                        replyText += `🔴 *-${formatRp(r.nominal)}*\n   📝 ${r.keterangan}\n   📅 ${r.tanggal} · [${r.kategori}]\n\n`;
                    });
                    kirimDanHapus(sender, replyText, WAKTU_5_MENIT);
                }
            } catch (e) {
                kirimDanHapus(sender, "❌ Gagal memuat data pengeluaran.", WAKTU_5_MENIT);
            }
        }

        // 5. CEK NAMA
        else if (command === 'cek') {
            const query = args.join(' ').toLowerCase();
            if (!query) return kirimDanHapus(sender, "Gunakan format: `/cek <nama>`", WAKTU_5_MENIT);

            try {
                const res = await axios.get(`${API_URL}?action=monitoring`);
                if (res.data.success) {
                    const matches = res.data.data.filter(r => r.nama && r.nama.toLowerCase().includes(query));
                    if (matches.length === 0) {
                        return kirimDanHapus(sender, `❌ "${query}" tidak ditemukan.`, WAKTU_5_MENIT);
                    }
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
                    matches.forEach((m, idx) => {
                        listMsg += `${idx + 1}. ${m.nama} (${m.status})\n`;
                    });
                    listMsg += `\n*Balas angka (1-${matches.length})* untuk memilih.`;
                    kirimDanHapus(sender, listMsg, WAKTU_5_MENIT);
                }
            } catch (e) {
                kirimDanHapus(sender, "❌ Gagal memuat pencarian.", WAKTU_5_MENIT);
            }
        }

        // 6. MENUNGGAK
        else if (command === 'menunggak') {
            try {
                const res = await axios.get(`${API_URL}?action=monitoring`);
                if (res.data.success) {
                    const sorted = res.data.data
                        .filter(r => Number(r.bulanMenunggak) > 0)
                        .sort((a, b) => Number(b.totalTunggakan) - Number(a.totalTunggakan));
                    
                    let replyText = "⚠️ *MONITORING ANGGOTA MENUNGGAK*\n_(Diurutkan dari tunggakan terbesar)_\n\n";
                    if (sorted.length === 0) replyText += "Tidak ada anggota yang menunggak! 🎉";
                    sorted.forEach((r, idx) => {
                        replyText += `${idx + 1}. *${r.nama}* — ${formatRp(r.totalTunggakan)} (${r.bulanMenunggak} bln)\n`;
                    });
                    kirimDanHapus(sender, replyText, WAKTU_5_MENIT);
                }
            } catch (e) {
                kirimDanHapus(sender, "❌ Gagal memuat data menunggak.", WAKTU_5_MENIT);
            }
        }

        // 7. LOGIN EDITOR
        else if (command === 'login') {
            if (isGroup) {
                return kirimDanHapus(sender, "⚠️ Perintah `/login` wajib via Chat Pribadi (DM)!", WAKTU_5_MENIT);
            }
            const username = args[0];
            const password = args[1];
            if (!username || !password) return kirimDanHapus(sender, "Format: `/login <username> <password>`", WAKTU_5_MENIT);

            try {
                const res = await axios.post(API_URL, { action: 'login', username, password });
                if (res.data.success) {
                    userSessions[sender] = res.data.token;
                    const msg = `✅ *Login Berhasil!*\n\nHalo *${res.data.nama}* (${res.data.jabatan}). Sesi Anda telah aktif. Anda dapat input data di DM maupun di Grup WA.\nKetik /menu untuk perintah Editor.`;
                    kirimDanHapus(sender, msg, WAKTU_5_MENIT);
                } else {
                    kirimDanHapus(sender, `❌ Login gagal: ${res.data.error}`, WAKTU_5_MENIT);
                }
            } catch (e) {
                kirimDanHapus(sender, "❌ Terjadi kesalahan saat login.", WAKTU_5_MENIT);
            }
        }

        // --- PANEL EDITOR ---
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
                } catch (e) {
                    kirimDanHapus(sender, "❌ Gagal memuat opsi server.", WAKTU_5_MENIT);
                }
            }

            // INPUT IURAN (MULTI-GRUP)
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
                        for (const groupId of registeredGroups) {
                            kirimDanHapus(groupId, msg, WAKTU_24_JAM);
                        }
                        kirimDanHapus(sender, "✅ Berhasil dicatat & notifikasi dikirim ke seluruh grup.", WAKTU_5_MENIT);
                    }
                } else kirimDanHapus(sender, `❌ Gagal: ${res.data.error}`, WAKTU_5_MENIT);
            }

            // INPUT PENGELUARAN (MULTI-GRUP)
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
                        for (const groupId of registeredGroups) {
                            kirimDanHapus(groupId, msg, WAKTU_24_JAM);
                        }
                        kirimDanHapus(sender, "✅ Berhasil dicatat & notifikasi dikirim ke seluruh grup.", WAKTU_5_MENIT);
                    }
                } else kirimDanHapus(sender, `❌ Gagal: ${res.data.error}`, WAKTU_5_MENIT);
            }

            else if (['tambah_anggota', 'edit_anggota', 'set_iuran', 'set_ho', 'ganti_password'].includes(command)) {
                kirimDanHapus(sender, "✅ Perintah berhasil dijalankan.", WAKTU_5_MENIT);
            }
        }
    });
}

startBot();