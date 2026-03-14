require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const http = require('http');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
} = require('@whiskeysockets/baileys');

const {
  Client: DcClient,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  AttachmentBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  ActivityType,
} = require('discord.js');

const qrcode = require('qrcode');
const pino   = require('pino');
const cfg    = require('./config');

const AUTH_DIR = '/app/.wa_auth';
let config     = cfg.load();

let lastQR      = null;
let waSocket    = null;
let waConnected = false;
let waGroups    = []; // cache des groupes WA

// ─── QR HTTP Server ───────────────────────────────────────────────────────────
http.createServer(async (req, res) => {
  if (req.url === '/reset') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<html><body style="background:#111;color:white;font-family:sans-serif;padding:40px"><h2>🔄 Session supprimée, nouveau QR dans 3s...</h2></body></html>');
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    lastQR = null; waConnected = false;
    setTimeout(startWhatsApp, 1000);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  const style = 'background:#111;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;font-family:sans-serif';
  if (lastQR) {
    const img = await qrcode.toDataURL(lastQR);
    res.end(`<html><body style="${style}"><div style="text-align:center">
      <p style="color:white;font-size:20px">📱 Scanne avec WhatsApp</p>
      <img src="${img}" style="width:300px;border-radius:12px"/>
      <p style="color:#aaa;font-size:13px">Rafraichis si expiré • <a href="/reset" style="color:#f55">Reset session</a></p>
    </div></body></html>`);
  } else if (waConnected) {
    res.end(`<html><body style="${style}"><div style="text-align:center">
      <p style="color:#4caf50;font-size:26px">✅ WhatsApp connecté !</p>
      <p style="color:#aaa"><a href="/reset" style="color:#f55">Changer de compte</a></p>
    </div></body></html>`);
  } else {
    res.end(`<html><body style="${style}">
      <p style="color:#ff9800;font-size:20px">⏳ Connexion en cours... Rafraichis dans 5s</p>
    </body></html>`);
  }
}).listen(process.env.PORT || 3000, () => console.log('🌐 Serveur QR démarré'));

// ─── Discord Client ───────────────────────────────────────────────────────────
const dcClient = new DcClient({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ─── Slash Commands ───────────────────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName('panel')
    .setDescription('🎛️ Ouvrir le panneau de configuration du bot'),

  new SlashCommandBuilder()
    .setName('send')
    .setDescription('📤 Envoyer un message WhatsApp')
    .addStringOption(o => o.setName('destination')
      .setDescription('Numéro (+33...), nom de contact, ou nom de groupe WA')
      .setRequired(true))
    .addStringOption(o => o.setName('message')
      .setDescription('Texte à envoyer')
      .setRequired(true)),

  new SlashCommandBuilder()
    .setName('contact')
    .setDescription('📇 Gérer les contacts')
    .addSubcommand(s => s.setName('add')
      .setDescription('Ajouter un contact')
      .addStringOption(o => o.setName('nom').setDescription('Nom du contact').setRequired(true))
      .addStringOption(o => o.setName('numero').setDescription('Numéro (+33...)').setRequired(true)))
    .addSubcommand(s => s.setName('list')
      .setDescription('Lister les contacts'))
    .addSubcommand(s => s.setName('remove')
      .setDescription('Supprimer un contact')
      .addStringOption(o => o.setName('nom').setDescription('Nom du contact').setRequired(true))),
].map(c => c.toJSON());

async function registerCommands(guildId) {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, guildId), { body: commands });
    console.log(`✅ Slash commands enregistrées sur le serveur ${guildId}`);
  } catch (e) {
    console.error('Erreur enregistrement commandes:', e.message);
  }
}

// ─── Helper : résoudre destination WA ────────────────────────────────────────
function resolveDestination(dest) {
  // Numéro direct
  if (/^\+?\d{7,}$/.test(dest.replace(/\s/g, ''))) {
    return dest.replace(/\D/g, '') + '@s.whatsapp.net';
  }
  // Contact sauvegardé
  const lower = dest.toLowerCase();
  for (const [name, jid] of Object.entries(config.contacts)) {
    if (name.toLowerCase() === lower) return jid;
  }
  // Groupe WA par nom
  const group = waGroups.find(g => g.subject?.toLowerCase().includes(lower));
  if (group) return group.id;
  return null;
}

// ─── Panel ────────────────────────────────────────────────────────────────────
async function sendPanel(interaction) {
  const mappingLines = Object.entries(config.groupMappings).map(([waId, dcId]) => {
    const group = waGroups.find(g => g.id === waId);
    const name  = group ? group.subject : waId;
    return `• **${name}** → <#${dcId}>`;
  });

  const contactLines = Object.entries(config.contacts).map(
    ([name, jid]) => `• **${name}** : \`${jid.replace('@s.whatsapp.net', '')}\``
  );

  const embed = new EmbedBuilder()
    .setTitle('🎛️ Panneau de configuration')
    .setColor(0x25d366)
    .addFields(
      { name: '📡 Groupes WA → Salons Discord', value: mappingLines.length ? mappingLines.join('\n') : '_Aucun configuré_' },
      { name: '📇 Contacts', value: contactLines.length ? contactLines.join('\n') : '_Aucun contact_' },
      { name: '📶 État WhatsApp', value: waConnected ? '✅ Connecté' : '❌ Déconnecté' },
    )
    .setFooter({ text: 'Utilise les boutons ci-dessous pour configurer' });

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('panel_list_groups').setLabel('📋 Lister groupes WA').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('panel_map_group').setLabel('🔗 Lier groupe → salon').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('panel_unmap_group').setLabel('❌ Délier groupe').setStyle(ButtonStyle.Danger),
  );

  await interaction.reply({ embeds: [embed], components: [row1], ephemeral: true });
}

// ─── Discord Events ───────────────────────────────────────────────────────────
dcClient.on('clientReady', async () => {
  console.log(`\u2705 Discord connecté : ${dcClient.user.tag}`);

  // Statut visible
  dcClient.user.setPresence({
    activities: [{ name: '📱 WhatsApp Bridge', type: ActivityType.Watching }],
    status: 'online',
  });

  // Enregistrer les slash commands sur tous les serveurs
  for (const guild of dcClient.guilds.cache.values()) {
    await registerCommands(guild.id);
  }
});

dcClient.on('interactionCreate', async interaction => {
  // ── Slash Commands ──
  if (interaction.isChatInputCommand()) {
    const { commandName } = interaction;

    // Auto-save guild
    if (!config.guildId) {
      config.guildId = interaction.guildId;
      cfg.save(config);
      await registerCommands(config.guildId);
    }

    // /panel
    if (commandName === 'panel') {
      return sendPanel(interaction);
    }

    // /send
    if (commandName === 'send') {
      if (!waConnected) return interaction.reply({ content: '❌ WhatsApp non connecté.', ephemeral: true });
      const dest = interaction.options.getString('destination');
      const text = interaction.options.getString('message');
      const jid  = resolveDestination(dest);
      if (!jid) return interaction.reply({ content: `❌ Destination introuvable : \`${dest}\``, ephemeral: true });
      try {
        await waSocket.sendMessage(jid, { text });
        return interaction.reply({ content: `✅ Message envoyé à **${dest}**`, ephemeral: true });
      } catch (e) {
        return interaction.reply({ content: `❌ Erreur envoi : ${e.message}`, ephemeral: true });
      }
    }

    // /contact
    if (commandName === 'contact') {
      const sub = interaction.options.getSubcommand();
      if (sub === 'add') {
        const nom = interaction.options.getString('nom');
        const num = interaction.options.getString('numero').replace(/\D/g, '') + '@s.whatsapp.net';
        config.contacts[nom] = num;
        cfg.save(config);
        return interaction.reply({ content: `✅ Contact **${nom}** ajouté !`, ephemeral: true });
      }
      if (sub === 'remove') {
        const nom = interaction.options.getString('nom');
        if (!config.contacts[nom]) return interaction.reply({ content: `❌ Contact \`${nom}\` introuvable.`, ephemeral: true });
        delete config.contacts[nom];
        cfg.save(config);
        return interaction.reply({ content: `✅ Contact **${nom}** supprimé.`, ephemeral: true });
      }
      if (sub === 'list') {
        const lines = Object.entries(config.contacts).map(([n, j]) => `• **${n}** : \`${j.replace('@s.whatsapp.net', '')}\``);
        return interaction.reply({ content: lines.length ? lines.join('\n') : '_Aucun contact_', ephemeral: true });
      }
    }
  }

  // ── Boutons panel ──
  if (interaction.isButton()) {
    // Lister les groupes WA
    if (interaction.customId === 'panel_list_groups') {
      if (!waConnected) return interaction.reply({ content: '❌ WhatsApp non connecté.', ephemeral: true });
      const lines = waGroups.slice(0, 40).map((g, i) => `\`${i+1}.\` **${g.subject}**\n└ \`${g.id}\``);
      return interaction.reply({
        content: `**📋 Groupes WhatsApp (${waGroups.length}) :**\n${lines.join('\n') || '_Aucun groupe_'}`,
        ephemeral: true
      });
    }

    // Lier groupe → salon
    if (interaction.customId === 'panel_map_group') {
      return interaction.reply({
        content: '**🔗 Pour lier un groupe à un salon Discord :**\n\nTape dans ce salon :\n```\n!map <ID_GROUPE_WA> <ID_SALON_DISCORD>\n```\n*Exemple :* `!map 120363XXXXXXX@g.us 1234567890`\n\n*Utilise "Lister groupes WA" pour avoir les IDs*',
        ephemeral: true
      });
    }

    // Délier groupe
    if (interaction.customId === 'panel_unmap_group') {
      return interaction.reply({
        content: '**❌ Pour délier un groupe :**\n\nTape dans ce salon :\n```\n!unmap <ID_GROUPE_WA>\n```',
        ephemeral: true
      });
    }
  }
});

// Commandes texte admin pour mapper/démapper
dcClient.on('messageCreate', async msg => {
  if (msg.author.bot) return;

  // !map <waGroupId> <discordChannelId>
  if (msg.content.startsWith('!map ')) {
    const parts = msg.content.split(' ');
    if (parts.length < 3) return msg.reply('Usage: `!map <waGroupId> <discordChannelId>`');
    const [, waId, dcId] = parts;
    config.groupMappings[waId] = dcId;
    cfg.save(config);
    return msg.reply(`✅ Groupe \`${waId}\` lié au salon <#${dcId}>`);
  }

  // !unmap <waGroupId>
  if (msg.content.startsWith('!unmap ')) {
    const waId = msg.content.split(' ')[1];
    if (!config.groupMappings[waId]) return msg.reply('❌ Groupe non trouvé dans les mappings.');
    delete config.groupMappings[waId];
    cfg.save(config);
    return msg.reply(`✅ Groupe \`${waId}\` délié.`);
  }
});

// ─── WhatsApp ─────────────────────────────────────────────────────────────────
async function startWhatsApp() {
  if (waSocket) {
    try { waSocket.ev.removeAllListeners(); } catch (_) {}
    try { waSocket.end(); } catch (_) {}
    waSocket = null;
  }
  waConnected = false;

  if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  waSocket = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['WA-Discord-Bot', 'Chrome', '1.0.0'],
  });

  waSocket.ev.on('creds.update', saveCreds);

  waSocket.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) { lastQR = qr; console.log('📱 QR prêt — scanne sur ton URL Railway'); }

    if (connection === 'open') {
      lastQR = null;
      waConnected = true;
      console.log('✅ WhatsApp connecté !');
      // Charger les groupes
      try {
        const chats = await waSocket.groupFetchAllParticipating();
        waGroups = Object.values(chats);
        console.log(`📋 ${waGroups.length} groupes chargés`);
      } catch (e) {
        console.error('Erreur chargement groupes:', e.message);
      }
    }

    if (connection === 'close') {
      waConnected = false;
      lastQR = null;
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      console.log(`⚠️ Déconnecté (code: ${code}), reconnexion: ${shouldReconnect}`);
      if (code === 401 || code === 403) {
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      }
      if (shouldReconnect) setTimeout(startWhatsApp, 3000);
    }
  });

  // ─── WA → Discord ─────────────────────────────────────────────────────────
  waSocket.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      if (!msg.message) continue;

      const jid = msg.key.remoteJid;
      const isGroup = jid.endsWith('@g.us');
      if (!isGroup) continue; // on ne traite que les groupes

      const dcChannelId = config.groupMappings[jid];
      if (!dcChannelId) continue; // groupe non mappé

      let channel;
      try { channel = await dcClient.channels.fetch(dcChannelId); }
      catch { continue; }

      const sender = msg.pushName || (msg.key.participant || '').replace('@s.whatsapp.net', '');
      const msgContent = msg.message;

      // Texte
      const text = msgContent.conversation
        || msgContent.extendedTextMessage?.text
        || msgContent.imageMessage?.caption
        || msgContent.videoMessage?.caption
        || null;

      // Media
      const mediaType = msgContent.imageMessage ? 'image'
        : msgContent.videoMessage ? 'video'
        : msgContent.audioMessage ? 'audio'
        : msgContent.documentMessage ? 'document'
        : null;

      try {
        if (mediaType) {
          // Télécharger le média
          const buffer = await downloadMediaMessage(msg, 'buffer', {});
          const ext = mediaType === 'image' ? 'jpg'
            : mediaType === 'video' ? 'mp4'
            : mediaType === 'audio' ? 'ogg'
            : 'bin';
          const attachment = new AttachmentBuilder(buffer, { name: `media.${ext}` });
          const content = `📱 **${sender}** :${text ? ` ${text}` : ''}`;
          await channel.send({ content, files: [attachment] });
        } else if (text) {
          await channel.send(`📱 **${sender}** : ${text}`);
        } else {
          await channel.send(`📱 **${sender}** : [message non supporté]`);
        }
      } catch (e) {
        console.error('Erreur envoi Discord:', e.message);
      }
    }
  });
}

// ─── Démarrage ────────────────────────────────────────────────────────────────
process.on('unhandledRejection', err => console.error('Unhandled:', err?.message || err));

dcClient.login(process.env.DISCORD_TOKEN);
startWhatsApp();
