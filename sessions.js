// Gestionnaire de sessions WhatsApp multi-utilisateurs
const fs   = require('fs');
const path = require('path');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
} = require('@whiskeysockets/baileys');
const pino = require('pino');

const SESSIONS_DIR = '/app/.wa_auth/sessions';

// Map<discordUserId, { socket, connected, phoneNumber }>
const sessions = new Map();

let onMessageCallback = null;
let onStatusCallback  = null;

function setOnMessage(cb) { onMessageCallback = cb; }
function setOnStatus(cb)  { onStatusCallback  = cb; }

function getSessionDir(discordUserId) {
  return path.join(SESSIONS_DIR, discordUserId);
}

function getAllSessions() {
  if (!fs.existsSync(SESSIONS_DIR)) return [];
  return fs.readdirSync(SESSIONS_DIR).filter(f =>
    fs.statSync(path.join(SESSIONS_DIR, f)).isDirectory()
  );
}

function getSession(discordUserId) {
  return sessions.get(discordUserId) || null;
}

function isConnected(discordUserId) {
  return sessions.get(discordUserId)?.connected === true;
}

async function startSession(discordUserId, onPairingCode) {
  // Si session active, on la ferme d'abord
  await stopSession(discordUserId);

  const sessionDir = getSessionDir(discordUserId);
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const { version }          = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['WA-Bridge', 'Chrome', '1.0.0'],
  });

  sessions.set(discordUserId, { socket: sock, connected: false, phoneNumber: null });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    const session = sessions.get(discordUserId);
    if (!session) return;

    if (connection === 'open') {
      session.connected   = true;
      session.phoneNumber = sock.authState?.creds?.me?.id?.split(':')[0] || null;
      console.log(`✅ Session connectée pour ${discordUserId} (${session.phoneNumber})`);
      if (onStatusCallback) onStatusCallback(discordUserId, 'connected', session.phoneNumber);
    }

    if (connection === 'close') {
      session.connected = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      console.log(`⚠️ Session ${discordUserId} déconnectée (code: ${code})`);

      if (code === DisconnectReason.loggedOut) {
        // Déconnexion volontaire → supprimer la session
        await stopSession(discordUserId);
        if (onStatusCallback) onStatusCallback(discordUserId, 'loggedout', null);
      } else {
        // Reconnexion auto
        if (onStatusCallback) onStatusCallback(discordUserId, 'reconnecting', null);
        setTimeout(() => startSession(discordUserId, null), 3000);
      }
    }
  });

  // Messages reçus → callback global
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      if (!msg.message) continue;
      if (onMessageCallback) onMessageCallback(discordUserId, msg, sock);
    }
  });

  // Générer le pairing code si demandé
  if (onPairingCode && !state.creds.registered) {
    return new Promise((resolve, reject) => {
      // Attendre que la socket soit ouverte et prête (event connection.update avec qr)
      const timeout = setTimeout(() => reject(new Error('Timeout connexion WA')), 30000);

      sock.ev.on('connection.update', async ({ qr, connection }) => {
        if (qr) {
          // Socket prête, on peut demander le pairing code
          clearTimeout(timeout);
          try {
            const code = await sock.requestPairingCode(onPairingCode);
            resolve(code);
          } catch (e) {
            reject(e);
          }
        }
        if (connection === 'close') {
          clearTimeout(timeout);
          reject(new Error('Connection fermée avant le pairing'));
        }
      });
    });
  }

  return null;
}

async function stopSession(discordUserId) {
  const session = sessions.get(discordUserId);
  if (session?.socket) {
    try { session.socket.ev.removeAllListeners(); } catch (_) {}
    try { session.socket.end(); } catch (_) {}
  }
  sessions.delete(discordUserId);
}

async function deleteSession(discordUserId) {
  await stopSession(discordUserId);
  const dir = getSessionDir(discordUserId);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  console.log(`🗑️ Session supprimée pour ${discordUserId}`);
}

async function sendMessage(discordUserId, jid, content) {
  const session = sessions.get(discordUserId);
  if (!session?.connected) throw new Error('Session non connectée');
  return session.socket.sendMessage(jid, content);
}

async function restoreAllSessions() {
  const userIds = getAllSessions();
  console.log(`🔄 Restauration de ${userIds.length} session(s)...`);
  for (const userId of userIds) {
    try {
      await startSession(userId, null);
    } catch (e) {
      console.error(`Erreur restauration session ${userId}:`, e.message);
    }
  }
}

module.exports = {
  startSession,
  stopSession,
  deleteSession,
  sendMessage,
  getSession,
  isConnected,
  getAllSessions,
  restoreAllSessions,
  setOnMessage,
  setOnStatus,
  sessions,
};
