require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const { Client: DcClient, GatewayIntentBits } = require('discord.js');
const qrcode = require('qrcode');
const http = require('http');

let lastQR = null;

http.createServer(async (req, res) => {
  if (lastQR) {
    const img = await qrcode.toDataURL(lastQR);
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<html><body style="background:#111;display:flex;align-items:center;justify-content:center;height:100vh">
      <div style="text-align:center">
        <p style="color:white;font-family:sans-serif;font-size:18px">Scanne avec WhatsApp</p>
        <img src="${img}" style="width:300px"/>
        <p style="color:#aaa;font-family:sans-serif">Rafraîchis la page si le QR expire</p>
      </div>
    </body></html>`);
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<html><body style="background:#111;display:flex;align-items:center;justify-content:center;height:100vh">
      <p style="color:white;font-family:sans-serif;font-size:20px">✅ WhatsApp connecté (ou démarrage en cours...)</p>
    </body></html>`);
  }
}).listen(process.env.PORT || 3000, () => {
  console.log('🌐 Serveur QR démarré');
});

const waClient = new Client({
  authStrategy: new LocalAuth({ dataPath: '/app/.wwebjs_auth' }),
  puppeteer: {
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
      '--single-process'
    ]
  }
});

waClient.on('qr', qr => {
  lastQR = qr;
  console.log('📱 QR prêt — ouvre ton URL Railway pour le scanner');
});

waClient.on('authenticated', () => {
  lastQR = null;
  console.log('🔐 WhatsApp authentifié');
});

waClient.on('ready', () => {
  console.log('✅ WhatsApp connecté');
});

waClient.on('auth_failure', msg => {
  console.error('❌ Auth échouée:', msg);
});

waClient.on('disconnected', reason => {
  console.log('⚠️ Déconnecté:', reason);
});

const dcClient = new DcClient({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

dcClient.on('ready', () => {
  console.log(`✅ Discord connecté : ${dcClient.user.tag}`);
});

// WhatsApp → Discord
waClient.on('message', async msg => {
  if (msg.fromMe) return;
  try {
    const contact = await msg.getContact();
    const name = contact.pushname || contact.number || msg.from;
    const channel = await dcClient.channels.fetch(process.env.DISCORD_CHANNEL_ID);
    await channel.send(`📱 **${name}** : ${msg.body}`);
  } catch (e) {
    console.error('Erreur WA→DC:', e.message);
  }
});

// Discord → WhatsApp  (!wa +33612345678 message)
dcClient.on('messageCreate', async msg => {
  if (msg.author.bot) return;
  if (msg.channelId !== process.env.DISCORD_CHANNEL_ID) return;
  const match = msg.content.match(/^!wa\s+(\+\d+)\s+(.+)/s);
  if (!match) return;
  try {
    const number = match[1].replace('+', '') + '@c.us';
    await waClient.sendMessage(number, match[2]);
    await msg.react('✅');
  } catch (e) {
    await msg.react('❌');
    console.error('Erreur envoi WA:', e.message);
  }
});

dcClient.login(process.env.DISCORD_TOKEN);
waClient.initialize();
