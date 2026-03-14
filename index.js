const { default: makeWASocket, useMultiFileAuthState } = require("@whiskeysockets/baileys")
const P = require("pino")

async function start(){

const { state, saveCreds } = await useMultiFileAuthState("auth")

const sock = makeWASocket({
logger: P({ level: "silent" }),
auth: state
})

sock.ev.on("creds.update", saveCreds)

sock.ev.on("connection.update", async (update) => {

const { connection } = update

if(connection === "open"){

console.log("WhatsApp connecté")

const session = Buffer.from(JSON.stringify(state.creds)).toString("base64")

console.log("\n===== SESSION_ID =====\n")
console.log(session)
console.log("\n======================\n")

process.exit()

}

})

// ⚡ génération du code
const phone = process.env.PHONE_NUMBER

setTimeout(async () => {

const code = await sock.requestPairingCode(phone)

console.log("\n===== CODE WHATSAPP =====\n")
console.log(code)
console.log("\n=========================\n")

}, 3000)

}

start()