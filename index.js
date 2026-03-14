require('dotenv').config();
const fs   = require('fs');
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
  ChannelType,
} = require('discord.js');

const qrcode = require('qrcode');
const pino   = require('pino');
const cfg    = require('./config');

const AUTH_DIR = '/app/.wa_auth';
let config     = cfg.load();
let lastQR     = null;
let waSocket   = null;
let waConnected = false;
let waGroups   = [];

// ─── QR HTTP Server ────────────────────────────────────────────────────────────
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

// ─── Discord Client ────────────────────────────────────────────────────────────
const dcClient = new DcClient({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
  ],
});

// ─── Slash Commands définitions ────────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName('panel')
    .setDescription('🎛️ Panneau de configuration du bot — visible par tous'),

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
    .setDescription('📇 Gérer les contacts WhatsApp')
    .addSubcommand(s => s.setName('add')
      .setDescription('Ajouter un contact')
      .addStringOption(o => o.setName('nom').setDescription('Nom').setRequired(true))
      .addStringOption(o => o.setName('numero').setDescription('Numéro (+33...)').setRequired(true)))
    .addSubcommand(s => s.setName('list').setDescription('Lister les contacts'))
    .addSubcommand(s => s.setName('remove')
      .setDescription('Supprimer un contact')
      .addStringOption(o => o.setName('nom').setDescription('Nom').setRequired(true))),
].map(c => c.toJSON());

async function registerCommands(guildId) {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, guildId), { body: commands });
    console.log(`✅ Slash commands enregistrées sur ${guildId}`);
  } catch (e) {
    console.error('Erreur enregistrement commandes:', e.message);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function resolveDestination(dest) {
  if (/^\+?\d{7,}$/.test(dest.replace(/\s/g, '')))
    return dest.replace(/\D/g, '') + '@s.whatsapp.net';
  const lower = dest.toLowerCase();
  for (const [name, jid] of Object.entries(config.contacts))
    if (name.toLowerCase() === lower) return jid;
  const group = waGroups.find(g => g.subject?.toLowerCase().includes(lower));
  if (group) return group.id;
  return null;
}

function sanitizeChannelName(name) {
  return name.toLowerCase().replace(/[^a-z0-9-_\u00e0-\u00ff]/gi, '-').replace(/-+/g, '-').slice(0, 100);
}

function sanitizeRoleName(name) {
  return name.replace(/[^\w\s\u00e0-\u00ff]/gi, '').trim().slice(0, 100) || 'membre-wa';
}

// ─── Création automatique salon + rôles ────────────────────────────────────────
async function autoCreateChannel(guild, waGroup) {
  const groupId = waGroup.id;
  const groupName = waGroup.subject || groupId;

  console.log(`🔧 Création auto du salon pour "${groupName}"...`);

  // Récupérer les participants et identifier les admins
  let participants = [];
  try {
    const meta = await waSocket.groupMetadata(groupId);
    participants = meta.participants || [];
  } catch (e) {
    console.error('Erreur récupération participants:', e.message);
  }

  const adminJids = participants
    .filter(p => p.admin === 'admin' || p.admin === 'superadmin')
    .map(p => p.id);

  // Créer ou récupérer les rôles pour chaque membre
  const memberRoles = [];   // rôles membres normaux
  const adminRoles  = [];   // rôles admins

  for (const p of participants) {
    const name = sanitizeRoleName(p.notify || p.id.replace('@s.whatsapp.net', ''));
    const isAdmin = p.admin === 'admin' || p.admin === 'superadmin';
    const roleName = `WA | ${name}`;

    // Chercher si le rôle existe déjà
    let role = guild.roles.cache.find(r => r.name === roleName);
    if (!role) {
      role = await guild.roles.create({
        name: roleName,
        color: isAdmin ? 0x25d366 : 0x9e9e9e,
        reason: `Membre du groupe WA "${groupName}"`,
      });
      console.log(`✅ Rôle créé : ${roleName}`);
    } else {
      console.log(`♻️ Rôle existant réutilisé : ${roleName}`);
    }

    if (isAdmin) adminRoles.push(role);
    else memberRoles.push(role);
  }

  const allRoles = [...adminRoles, ...memberRoles];

  // Construire les permission overwrites
  // @everyone : ne peut pas voir
  const permissionOverwrites = [
    {
      id: guild.roles.everyone.id,
      deny: [PermissionFlagsBits.ViewChannel],
    },
  ];

  // Admins WA : voir + écrire
  for (const role of adminRoles) {
    permissionOverwrites.push({
      id: role.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles],
    });
  }

  // Membres WA : voir seulement (pas écrire)
  for (const role of memberRoles) {
    permissionOverwrites.push({
      id: role.id,
      allow: [PermissionFlagsBits.ViewChannel],
      deny: [PermissionFlagsBits.SendMessages],
    });
  }

  // Créer le salon
  const channelName = sanitizeChannelName(groupName);
  let channel = guild.channels.cache.find(c => c.name === channelName && c.type === ChannelType.GuildText);

  if (!channel) {
    channel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      topic: `📱 Miroir du groupe WhatsApp : ${groupName}`,
      permissionOverwrites,
    });
    console.log(`✅ Salon créé : #${channelName}`);
  } else {
    await channel.permissionOverwrites.set(permissionOverwrites);
    console.log(`♻️ Salon existant mis à jour : #${channelName}`);
  }

  // Sauvegarder le mapping
  config.groupMappings[groupId] = channel.id;
  cfg.save(config);

  return { channel, allRoles, adminRoles, memberRoles };
}

// ─── Panel embed principal ─────────────────────────────────────────────────────
async function sendPanel(interaction) {
  const mappingLines = Object.entries(config.groupMappings).map(([waId, dcId]) => {
    const group = waGroups.find(g => g.id === waId);
    return `• **${group?.subject || waId}** → <#${dcId}>`;
  });

  const contactLines = Object.entries(config.contacts).map(
    ([name, jid]) => `• **${name}** : \`${jid.replace('@s.whatsapp.net', '')}\``
  );

  const embed = new EmbedBuilder()
    .setTitle('🎛️ Panneau de configuration')
    .setColor(0x25d366)
    .addFields(
      { name: '📡 Groupes WA liés', value: mappingLines.length ? mappingLines.join('\n') : '_Aucun configuré_' },
      { name: '📇 Contacts', value: contactLines.length ? contactLines.join('\n') : '_Aucun contact_' },
      { name: '📶 WhatsApp', value: waConnected ? '✅ Connecté' : '❌ Déconnecté' },
    )
    .setFooter({ text: 'Tout le monde peut voir ce panel • Seuls les admins peuvent configurer' });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('panel_list_groups').setLabel('📋 Groupes WA').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('panel_setup_group').setLabel('⚡ Lier un groupe').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('panel_unmap_group').setLabel('🗑️ Délier').setStyle(ButtonStyle.Danger),
  );

  await interaction.reply({ embeds: [embed], components: [row] }); // visible par tous (pas ephemeral)
}

// ─── Panel : liste des groupes avec boutons de liaison ─────────────────────────
async function sendGroupList(interaction) {
  if (!waConnected) return interaction.reply({ content: '❌ WhatsApp non connecté.', ephemeral: true });
  if (!waGroups.length) return interaction.reply({ content: '❌ Aucun groupe chargé.', ephemeral: true });

  const chunks = [];
  for (let i = 0; i < Math.min(waGroups.length, 25); i++) {
    const g = waGroups[i];
    const linked = config.groupMappings[g.id] ? ` ✅` : '';
    chunks.push(`\`${i+1}.\` **${g.subject}**${linked}\n└ \`${g.id}\``);
  }

  const embed = new EmbedBuilder()
    .setTitle(`📋 Groupes WhatsApp (${waGroups.length})`)
    .setDescription(chunks.join('\n'))
    .setColor(0x25d366)
    .setFooter({ text: 'Clique sur "⚡ Lier un groupe" pour configurer' });

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

// ─── Panel : sélection groupe pour liaison ─────────────────────────────────────
async function sendSetupGroupSelect(interaction) {
  if (!waConnected) return interaction.reply({ content: '❌ WhatsApp non connecté.', ephemeral: true });

  const unlinkdGroups = waGroups.filter(g => !config.groupMappings[g.id]).slice(0, 20);

  if (!unlinkdGroups.length)
    return interaction.reply({ content: '✅ Tous les groupes sont déjà liés !', ephemeral: true });

  // Afficher les groupes non liés avec des boutons (par pages de 5)
  const rows = [];
  const pageGroups = unlinkdGroups.slice(0, 5);

  for (const g of pageGroups) {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`setup_auto_${g.id}`)
        .setLabel(`⚡ ${g.subject.slice(0, 40)}`)
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`setup_manual_${g.id}`)
        .setLabel('✏️ Manuel')
        .setStyle(ButtonStyle.Secondary),
    );
    rows.push(row);
  }

  const embed = new EmbedBuilder()
    .setTitle('🔗 Lier un groupe WhatsApp')
    .setDescription(
      pageGroups.map((g, i) => `**${i+1}.** ${g.subject}`).join('\n') +
      '\n\n⚡ **Auto** = crée le salon + rôles membres automatiquement\n✏️ **Manuel** = tu fournis un salon existant'
    )
    .setColor(0x25d366);

  await interaction.reply({ embeds: [embed], components: rows, ephemeral: true });
}

// ─── Discord Events ────────────────────────────────────────────────────────────
dcClient.on('clientReady', async () => {
  console.log(`✅ Discord connecté : ${dcClient.user.tag}`);
  dcClient.user.setPresence({
    activities: [{ name: '📱 WhatsApp Bridge', type: ActivityType.Watching }],
    status: 'online',
  });
  for (const guild of dcClient.guilds.cache.values()) {
    await registerCommands(guild.id);
  }
});

dcClient.on('interactionCreate', async interaction => {
  // ── Slash commands ──
  if (interaction.isChatInputCommand()) {
    const { commandName } = interaction;

    if (!config.guildId) {
      config.guildId = interaction.guildId;
      cfg.save(config);
    }

    if (commandName === 'panel') return sendPanel(interaction);

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
        return interaction.reply({ content: `❌ Erreur : ${e.message}`, ephemeral: true });
      }
    }

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

  // ── Boutons ──
  if (interaction.isButton()) {
    const id = interaction.customId;

    if (id === 'panel_list_groups') return sendGroupList(interaction);
    if (id === 'panel_setup_group') return sendSetupGroupSelect(interaction);

    if (id === 'panel_unmap_group') {
      const lines = Object.entries(config.groupMappings).map(([waId, dcId]) => {
        const g = waGroups.find(x => x.id === waId);
        return `• \`${g?.subject || waId}\` → <#${dcId}> — tape \`!unmap ${waId}\``;
      });
      return interaction.reply({
        content: lines.length ? `**Groupes liés :**\n${lines.join('\n')}` : '_Aucun groupe lié_',
        ephemeral: true,
      });
    }

    // ⚡ Création automatique
    if (id.startsWith('setup_auto_')) {
      const groupId = id.replace('setup_auto_', '');
      const group   = waGroups.find(g => g.id === groupId);
      if (!group) return interaction.reply({ content: '❌ Groupe introuvable.', ephemeral: true });

      await interaction.deferReply({ ephemeral: true });

      try {
        const guild = interaction.guild;
        const { channel, adminRoles, memberRoles } = await autoCreateChannel(guild, group);

        const embed = new EmbedBuilder()
          .setTitle('✅ Salon créé automatiquement !')
          .setColor(0x25d366)
          .addFields(
            { name: '📺 Salon', value: `<#${channel.id}>` },
            { name: '👑 Rôles admins (peuvent écrire)', value: adminRoles.map(r => `<@&${r.id}>`).join(', ') || '_Aucun_' },
            { name: '👥 Rôles membres (lecture seule)', value: memberRoles.map(r => `<@&${r.id}>`).join(', ') || '_Aucun_' },
          )
          .setFooter({ text: 'Assigne les rôles aux membres Discord pour leur donner accès' });

        return interaction.editReply({ embeds: [embed] });
      } catch (e) {
        console.error('Erreur auto-create:', e);
        return interaction.editReply({ content: `❌ Erreur : ${e.message}` });
      }
    }

    // ✏️ Liaison manuelle
    if (id.startsWith('setup_manual_')) {
      const groupId = id.replace('setup_manual_', '');
      return interaction.reply({
        content: `**✏️ Liaison manuelle :**\nTape dans n'importe quel salon :\n\`\`\`\n!map ${groupId} <ID_SALON_DISCORD>\n\`\`\``,
        ephemeral: true,
      });
    }
  }
});

// Commandes texte admin
dcClient.on('messageCreate', async msg => {
  if (msg.author.bot) return;

  if (msg.content.startsWith('!map ')) {
    const parts = msg.content.split(' ');
    if (parts.length < 3) return msg.reply('Usage: `!map <waGroupId> <discordChannelId>`');
    config.groupMappings[parts[1]] = parts[2];
    cfg.save(config);
    return msg.reply(`✅ Groupe \`${parts[1]}\` lié au salon <#${parts[2]}>`);
  }

  if (msg.content.startsWith('!unmap ')) {
    const waId = msg.content.split(' ')[1];
    if (!config.groupMappings[waId]) return msg.reply('❌ Groupe non trouvé.');
    delete config.groupMappings[waId];
    cfg.save(config);
    return msg.reply(`✅ Groupe \`${waId}\` délié.`);
  }
});

// ─── WhatsApp ──────────────────────────────────────────────────────────────────
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
    if (qr) { lastQR = qr; console.log('📱 QR prêt'); }

    if (connection === 'open') {
      lastQR = null;
      waConnected = true;
      console.log('✅ WhatsApp connecté !');
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
      if (code === 401 || code === 403) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      if (shouldReconnect) setTimeout(startWhatsApp, 3000);
    }
  });

  // WA → Discord
  waSocket.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      if (!msg.message) continue;

      const jid = msg.key.remoteJid;
      if (!jid.endsWith('@g.us')) continue;

      const dcChannelId = config.groupMappings[jid];
      if (!dcChannelId) continue;

      let channel;
      try { channel = await dcClient.channels.fetch(dcChannelId); } catch { continue; }

      const sender  = msg.pushName || msg.key.participant?.replace('@s.whatsapp.net', '') || '?';
      const content = msg.message;
      const text    = content.conversation
        || content.extendedTextMessage?.text
        || content.imageMessage?.caption
        || content.videoMessage?.caption
        || null;

      const mediaType = content.imageMessage ? 'image'
        : content.videoMessage ? 'video'
        : content.audioMessage ? 'audio'
        : content.documentMessage ? 'document'
        : null;

      try {
        if (mediaType) {
          const buffer = await downloadMediaMessage(msg, 'buffer', {});
          const ext    = { image: 'jpg', video: 'mp4', audio: 'ogg', document: 'bin' }[mediaType];
          const attach = new AttachmentBuilder(buffer, { name: `media.${ext}` });
          await channel.send({ content: `📱 **${sender}**${text ? ` : ${text}` : ''}`, files: [attach] });
        } else if (text) {
          await channel.send(`📱 **${sender}** : ${text}`);
        }
      } catch (e) {
        console.error('Erreur WA→DC:', e.message);
      }
    }
  });
}

// ─── Démarrage ─────────────────────────────────────────────────────────────────
process.on('unhandledRejection', err => console.error('Unhandled:', err?.message || err));
dcClient.login(process.env.DISCORD_TOKEN);
startWhatsApp();
