require('dotenv').config();
const fs = require('fs');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const { Client: DcClient, GatewayIntentBits } = require('discord.js');
const qrcode = require('qrcode');
const http = require('http');
const pino = require('pino');

const AUTH_DIR = '/app/.wa_auth';
let lastQR = null;
let waSocket = null;
let waConnected = false;

// ─── Serveur HTTP pour afficher le QR ────────────────────────────────────────
http.createServer(async (req, res) => {
  // Route /reset : vide la session et redémarre
  if (req.url === '/reset') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<html><body style="background:#111;color:white;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh"><p>🔄 Session supprimée, reconnexion dans 3s...</p></body></html>');
    console.log('🔄 Reset session demandé via /reset');
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    lastQR = null;
    waConnected = false;
    setTimeout(startWhatsApp, 1000);
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  if (lastQR) {
    const img = await qrcode.toDataURL(lastQR);
    res.end(`<html><body style="background:#111;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
      <div style="text-align:center">
        <p style="color:white;font-family:sans-serif;font-size:20px">📱 Scanne avec WhatsApp</p>
        <img src="${img}" style="width:300px;border-radius:12px"/>
        <p style="color:#aaa;font-family:sans-serif;font-size:14px">Rafraichis si le QR expire • <a href="/reset" style="color:#f55">Reset session</a></p>
      </div>
    </body></html>`);
  } else if (waConnected) {
    res.end(`<html><body style="background:#111;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
      <div style="text-align:center">
        <p style="color:#4caf50;font-family:sans-serif;font-size:24px">✅ WhatsApp connecté !</p>
        <p style="color:#aaa;font-family:sans-serif"><a href="/reset" style="color:#f55">Se déconnecter / changer de compte</a></p>
      </div>
    </body></html>`);
  } else {
    res.end(`<html><body style="background:#111;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
      <p style="color:#ff9800;font-family:sans-serif;font-size:20px">⏳ Connexion en cours... Rafraichis dans 5s</p>
    </body></html>`);
  }
}).listen(process.env.PORT || 3000, () => {
  console.log('🌐 Serveur QR démarré');
});

// ─── Discord ──────────────────────────────────────────────────────────────────
const dcClient = new DcClient({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

dcClient.on('clientReady', () => {
  console.log(`✅ Discord connecté : ${dcClient.user.tag}`);
});

// ─── WhatsApp ─────────────────────────────────────────────────────────────────
async function startWhatsApp() {
  // Nettoyer l'ancien socket
  if (waSocket) {
    try { waSocket.ev.removeAllListeners(); } catch (_) {}
    try { waSocket.end(); } catch (_) {}
    waSocket = null;
  }
  waConnected = false;

  // Créer le dossier auth si nécessaire
  if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  console.log(`📦 Baileys version: ${version.join('.')}`);

  waSocket = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['WA-Discord-Bot', 'Chrome', '1.0.0'],
  });

  waSocket.ev.on('creds.update', saveCreds);

  waSocket.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      lastQR = qr;
      console.log('📱 QR prêt — ouvre ton URL Railway et scanne');
    }

    if (connection === 'open') {
      lastQR = null;
      waConnected = true;
      console.log('✅ WhatsApp connecté !');
    }

    if (connection === 'close') {
      waConnected = false;
      lastQR = null;
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      console.log(`⚠️ Déconnecté (code: ${code}), reconnexion: ${shouldReconnect}`);

      if (shouldReconnect) {
        // Si session invalide (401), supprimer les creds et repartir propre
        if (code === 401 || code === 403) {
          console.log('🗑️ Session invalide, suppression des creds...');
          fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        }
        setTimeout(startWhatsApp, 3000);
      } else {
        console.log('🚫 Déconnexion volontaire (loggedOut), pas de reconnexion');
      }
    }
  });

  // WA → Discord
  waSocket.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      if (!msg.message) continue;

      const text = msg.message.conversation
        || msg.message.extendedTextMessage?.text
        || msg.message.imageMessage?.caption
        || '[media/autre]';

      const from = msg.pushName || msg.key.remoteJid;

      try {
        const channel = await dcClient.channels.fetch(process.env.DISCORD_CHANNEL_ID);
        await channel.send(`📱 **${from}** : ${text}`);
      } catch (e) {
        console.error('Erreur WA→DC:', e.message);
      }
    }
  });
}

// ─── Discord → WA ─────────────────────────────────────────────────────────────
dcClient.on('messageCreate', async msg => {
  if (msg.author.bot) return;
  if (msg.channelId !== process.env.DISCORD_CHANNEL_ID) return;

  const match = msg.content.match(/^!wa\s+(\+\d+)\s+(.+)/s);
  if (!match) return;

  if (!waSocket || !waConnected) {
    await msg.react('❌');
    await msg.reply('⚠️ WhatsApp non connecté. Va sur ton URL Railway pour scanner le QR.');
    return;
  }

  try {
    const number = match[1].replace(/\D/g, '') + '@s.whatsapp.net';
    await waSocket.sendMessage(number, { text: match[2] });
    await msg.react('✅');
  } catch (e) {
    await msg.react('❌');
    console.error('Erreur envoi WA:', e.message);
  }
});

process.on('unhandledRejection', err => {
  console.error('Unhandled rejection:', err?.message || err);
});

// ─── Démarrage ────────────────────────────────────────────────────────────────
dcClient.login(process.env.DISCORD_TOKEN);
startWhatsApp();
