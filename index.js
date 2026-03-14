const { default: makeWASocket, useMultiFileAuthState } = require("@whiskeysockets/baileys")
const P = require("pino")

async function start() {

const { state, saveCreds } = await useMultiFileAuthState("auth")

const sock = makeWASocket({
logger: P({ level: "silent" }),
auth: state
})

sock.ev.on("connection.update", async (update) => {

const { connection, pairingCode } = update

if(pairingCode){
console.log("Code de connexion :", pairingCode)
}

if(connection === "open"){
console.log("WhatsApp connecté")

const session = Buffer.from(JSON.stringify(state.creds)).toString("base64")

console.log("\nSESSION_ID :\n")
console.log(session)

process.exit()

}

})

sock.ev.on("creds.update", saveCreds)

}

start()
