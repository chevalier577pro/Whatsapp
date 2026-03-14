require("dotenv").config()

const { default: makeWASocket } = require("@whiskeysockets/baileys")
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
const session = JSON.parse(
Buffer.from(process.env.SESSION_ID, "base64").toString()
)

const sock = makeWASocket({
logger: P({ level: "silent" }),
auth: { creds: session, keys: {} }
})

// Discord ready
discord.on("ready", () => {
console.log("Discord connecté :", discord.user.tag)
})

// WhatsApp message → Discord
sock.ev.on("messages.upsert", async ({ messages }) => {

const msg = messages[0]

if(!msg.message) return

const text = msg.message.conversation || "message"

const channel = await discord.channels.fetch(process.env.CHANNEL_ID)

channel.send("📱 WhatsApp : " + text)

})

// Discord → WhatsApp
discord.on("messageCreate", async message => {

if(message.author.bot) return
if(message.channel.id !== process.env.CHANNEL_ID) return

const number = "336XXXXXXXX@s.whatsapp.net"

await sock.sendMessage(number, {
text: message.content
})

})

discord.login(process.env.DISCORD_TOKEN)
