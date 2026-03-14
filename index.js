require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Client: DcClient, GatewayIntentBits } = require('discord.js');
const qrcode = require('qrcode');
const http = require('http');
const pino = require('pino');

let lastQR = null;
let waSocket = null;

// ── Serveur HTTP pour afficher le QR ─────────────────────────
http.createServer(async (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  if (lastQR) {
    const img = await qrcode.toDataURL(lastQR);
    res.end(`<html><body style="background:#111;display:flex;align-items:center;justify-content:center;height:100vh">
      <div style="text-align:center">
        <p style="color:white;font-family:sans-serif;font-size:18px">Scanne avec WhatsApp</p>
        <img src="${img}" style="width:300px"/>
        <p style="color:#aaa;font-family:sans-serif">Rafraichis la page si le QR expire</p>
      </div>
    </body></html>`);
  } else {
    res.end(`<html><body style="background:#111;display:flex;align-items:center;justify-content:center;height:100vh">
      <p style="color:white;font-family:sans-serif;font-size:20px">✅ WhatsApp connecte !</p>
    </body></html>`);
  }
}).listen(process.env.PORT || 3000, () => {
  console.log('🌐 Serveur QR demarre');
});

// ── Discord ───────────────────────────────────────────────────
const dcClient = new DcClient({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

dcClient.on('ready', () => {
  console.log(`✅ Discord connecte : ${dcClient.user.tag}`);
});

// ── WhatsApp avec Baileys (sans Chromium) ─────────────────────
async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('/app/.wa_auth');

  waSocket = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false
  });

  waSocket.ev.on('creds.update', saveCreds);

  waSocket.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      lastQR = qr;
      console.log('📱 QR pret — ouvre ton URL Railway');
    }
    if (connection === 'open') {
      lastQR = null;
      console.log('✅ WhatsApp connecte');
    }
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('⚠️ Deconnecte, reconnexion:', shouldReconnect);
      if (shouldReconnect) {
        setTimeout(startWhatsApp, 3000);
      }
    }
  });

  // WhatsApp → Discord
  waSocket.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      if (!msg.message) continue;

      const text = msg.message.conversation
        || msg.message.extendedTextMessage?.text
        || '[media]';

      const from = msg.key.remoteJid;
      const name = msg.pushName || from;

      try {
        const channel = await dcClient.channels.fetch(process.env.DISCORD_CHANNEL_ID);
        await channel.send(`📱 **${name}** : ${text}`);
      } catch (e) {
        console.error('Erreur WA→DC:', e.message);
      }
    }
  });
}

// Discord → WhatsApp  (!wa +33612345678 message)
dcClient.on('messageCreate', async msg => {
  if (msg.author.bot) return;
  if (msg.channelId !== process.env.DISCORD_CHANNEL_ID) return;
  const match = msg.content.match(/^!wa\s+(\+\d+)\s+(.+)/s);
  if (!match) return;
  if (!waSocket) {
    await msg.react('❌');
    return;
  }
  try {
    const number = match[1].replace('+', '') + '@s.whatsapp.net';
    await waSocket.sendMessage(number, { text: match[2] });
    await msg.react('✅');
  } catch (e) {
    await msg.react('❌');
    console.error('Erreur envoi WA:', e.message);
  }
});

process.on('unhandledRejection', err => {
  console.error('Erreur:', err.message);
});

// ── Start ─────────────────────────────────────────────────────
dcClient.login(process.env.DISCORD_TOKEN);
startWhatsApp();
```

---

## Nouveau `Dockerfile` — beaucoup plus léger, plus de Chromium !
```
FROM node:20-slim

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

CMD ["node", "index.js"]
