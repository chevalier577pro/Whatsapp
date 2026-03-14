require("dotenv").config()

const { default: makeWASocket, useMultiFileAuthState } = require("@whiskeysockets/baileys")
const { Client, GatewayIntentBits } = require("discord.js")
const P = require("pino")

// Discord
const discord = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
})

// WhatsApp
async function startWA(){

  const { state, saveCreds } = await useMultiFileAuthState("auth")

  const sock = makeWASocket({
    logger: P({ level: "silent" }),
    auth: state
  })

  sock.ev.on("creds.update", saveCreds)

  // Génération du code pour +58
  const phone = process.env.PHONE_NUMBER

  sock.ev.on("connection.update", async (update) => {
    const { connection, pairingCode } = update

    if(pairingCode){
      console.log("\n===== CODE WHATSAPP =====")
      console.log(pairingCode)
      console.log("=========================\n")
    }

    if(connection === "open"){
      console.log("WhatsApp connecté ✅")

      // Génération SESSION_ID
      const session = Buffer.from(JSON.stringify(state.creds)).toString("base64")
      console.log("\n===== SESSION_ID =====")
      console.log(session)
      console.log("=====================\n")
    }

    if(connection === "close"){
      console.log("WhatsApp déconnecté ❌")
    }
  })

  // WhatsApp -> Discord
  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0]
    if(!msg.message || msg.key.fromMe) return
    const text = msg.message.conversation || "message"
    const channel = await discord.channels.fetch(process.env.CHANNEL_ID)
    if(channel) channel.send("📱 WhatsApp : " + text)
  })

  // Discord -> WhatsApp
  discord.on("messageCreate", async message => {
    if(message.author.bot) return
    if(message.channel.id !== process.env.CHANNEL_ID) return

    const number = process.env.PHONE_NUMBER + "@s.whatsapp.net"

    await sock.sendMessage(number, { text: message.content })
  })
}

// Discord login
discord.login(process.env.DISCORD_TOKEN)

startWA()