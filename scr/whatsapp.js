const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

let waClient;

function initWhatsApp(onMessage) {
  waClient = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { args: ['--no-sandbox', '--disable-setuid-sandbox'] }
  });

  waClient.on('qr', qr => {
    console.log('Scanne ce QR code avec WhatsApp :');
    qrcode.generate(qr, { small: true });
  });

  waClient.on('ready', () => {
    console.log('✅ WhatsApp connecté');
  });

  waClient.on('message', msg => {
    if (msg.fromMe) return;
    onMessage(msg);
  });

  waClient.initialize();
  return waClient;
}

async function sendWhatsApp(to, text) {
  // `to` = numéro format "33612345678@c.us"
  await waClient.sendMessage(to, text);
}

module.exports = { initWhatsApp, sendWhatsApp };
