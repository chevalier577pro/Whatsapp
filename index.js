const { default: makeWASocket, useMultiFileAuthState } = require("@whiskeysockets/baileys")

async function startWA() {
    const state = JSON.parse(Buffer.from(process.env.WHATSAPP_SESSION, 'base64').toString('utf-8'))
    const sock = makeWASocket({ auth: state })
    // reste du code Discord ↔ WhatsApp
}