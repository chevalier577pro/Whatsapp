require('dotenv').config();
const fs   = require('fs');
const http = require('http');

const {
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

const qrcode  = require('qrcode');
const pino    = require('pino');
const cfg     = require('./config');
const sess    = require('./sessions');

// ─── Config & état global ──────────────────────────────────────────────────────
const AUTH_DIR   = '/app/.wa_auth';
let config       = cfg.load();

// Session principale (ton compte WA pour le bot)
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');

let mainSocket    = null;
let mainConnected = false;
let lastQR        = null;
let waGroups      = [];

// ─── QR HTTP Server ────────────────────────────────────────────────────────────
http.createServer(async (req, res) => {
  if (req.url === '/reset') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<html><body style="background:#111;color:white;font-family:sans-serif;padding:40px"><h2>🔄 Reset en cours...</h2></body></html>');
    const mainDir = `${AUTH_DIR}/main`;
    fs.rmSync(mainDir, { recursive: true, force: true });
    fs.mkdirSync(mainDir, { recursive: true });
    lastQR = null; mainConnected = false;
    setTimeout(startMainWA, 1000);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  const style = 'background:#111;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;font-family:sans-serif';
  if (lastQR) {
    const img = await qrcode.toDataURL(lastQR);
    res.end(`<html><body style="${style}"><div style="text-align:center">
      <p style="color:white;font-size:20px">📱 Scanne avec WhatsApp (compte principal du bot)</p>
      <img src="${img}" style="width:300px;border-radius:12px"/>
      <p style="color:#aaa;font-size:13px"><a href="/reset" style="color:#f55">Reset session</a></p>
    </div></body></html>`);
  } else if (mainConnected) {
    res.end(`<html><body style="${style}"><div style="text-align:center">
      <p style="color:#4caf50;font-size:26px">✅ Bot WhatsApp connecté !</p>
      <p style="color:#aaa"><a href="/reset" style="color:#f55">Changer de compte</a></p>
    </div></body></html>`);
  } else {
    res.end(`<html><body style="${style}">
      <p style="color:#ff9800;font-size:20px">⏳ Connexion en cours...</p>
    </body></html>`);
  }
}).listen(process.env.PORT || 3000, () => console.log('🌐 Serveur QR démarré'));

// ─── Discord ───────────────────────────────────────────────────────────────────
const dcClient = new DcClient({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
  ],
});

// ─── Slash commands ────────────────────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName('panel')
    .setDescription('🎛️ Panneau de configuration'),

  new SlashCommandBuilder()
    .setName('connect')
    .setDescription('🔗 Connecter ton compte WhatsApp au bot')
    .addStringOption(o => o
      .setName('numero')
      .setDescription('Ton numéro WhatsApp avec indicatif (+33612345678)')
      .setRequired(true)),

  new SlashCommandBuilder()
    .setName('disconnect')
    .setDescription('❌ Déconnecter ton compte WhatsApp'),

  new SlashCommandBuilder()
    .setName('status')
    .setDescription('📶 Voir l\'état de ta connexion WhatsApp'),

  new SlashCommandBuilder()
    .setName('send')
    .setDescription('📤 Envoyer un message WhatsApp')
    .addStringOption(o => o.setName('destination')
      .setDescription('Numéro (+33...), contact ou groupe')
      .setRequired(true))
    .addStringOption(o => o.setName('message')
      .setDescription('Message à envoyer')
      .setRequired(true)),

  new SlashCommandBuilder()
    .setName('contact')
    .setDescription('📇 Gérer tes contacts')
    .addSubcommand(s => s.setName('add')
      .setDescription('Ajouter')
      .addStringOption(o => o.setName('nom').setDescription('Nom').setRequired(true))
      .addStringOption(o => o.setName('numero').setDescription('Numéro').setRequired(true)))
    .addSubcommand(s => s.setName('list').setDescription('Lister'))
    .addSubcommand(s => s.setName('remove')
      .setDescription('Supprimer')
      .addStringOption(o => o.setName('nom').setDescription('Nom').setRequired(true))),
].map(c => c.toJSON());

async function registerCommands(guildId) {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, guildId), { body: commands });
    console.log(`✅ Commandes enregistrées sur ${guildId}`);
  } catch (e) { console.error('Erreur commandes:', e.message); }
}

// ─── Helpers ───────────────────────────────────────────────────────────────────
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
  return name.toLowerCase().replace(/[^a-z0-9\u00e0-\u00ff]/gi, '-').replace(/-+/g, '-').slice(0, 100);
}

function sanitizeRoleName(name) {
  return ('WA | ' + name).replace(/[^\w\s|À-ÿ]/gi, '').trim().slice(0, 100);
}

// ─── Trouver quel utilisateur Discord correspond à un JID WA ──────────────────
function findDiscordUserByJid(jid) {
  const phone = jid.replace('@s.whatsapp.net', '').replace('@g.us', '');
  for (const [discordId, session] of sess.sessions.entries()) {
    if (session.phoneNumber && session.phoneNumber === phone) return discordId;
  }
  return null;
}

// ─── Création auto salon + rôles ───────────────────────────────────────────────
async function autoCreateChannel(guild, waGroup) {
  const groupId   = waGroup.id;
  const groupName = waGroup.subject || groupId;
  console.log(`🔧 Création auto "${groupName}"...`);

  let participants = [];
  try {
    const meta = await mainSocket.groupMetadata(groupId);
    participants = meta.participants || [];
  } catch (e) { console.error('Erreur participants:', e.message); }

  const adminRoles  = [];
  const memberRoles = [];

  for (const p of participants) {
    const name    = sanitizeRoleName(p.notify || p.id.replace('@s.whatsapp.net', ''));
    const isAdmin = p.admin === 'admin' || p.admin === 'superadmin';

    let role = guild.roles.cache.find(r => r.name === name);
    if (!role) {
      role = await guild.roles.create({
        name,
        color: isAdmin ? 0x25d366 : 0x9e9e9e,
        reason: `Membre WA "${groupName}"`,
      });
      console.log(`✅ Rôle créé : ${name}`);
    } else {
      console.log(`♻️ Rôle réutilisé : ${name}`);
    }

    if (isAdmin) adminRoles.push(role);
    else memberRoles.push(role);
  }

  const permissionOverwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    ...adminRoles.map(r => ({
      id: r.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles],
    })),
    ...memberRoles.map(r => ({
      id: r.id,
      allow: [PermissionFlagsBits.ViewChannel],
      deny: [PermissionFlagsBits.SendMessages],
    })),
  ];

  const channelName = sanitizeChannelName(groupName);
  let channel = guild.channels.cache.find(c => c.name === channelName && c.type === ChannelType.GuildText);

  if (!channel) {
    channel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      topic: `📱 Miroir WhatsApp : ${groupName}`,
      permissionOverwrites,
    });
  } else {
    await channel.permissionOverwrites.set(permissionOverwrites);
  }

  config.groupMappings[groupId] = channel.id;
  cfg.save(config);

  return { channel, adminRoles, memberRoles };
}

// ─── Panel ─────────────────────────────────────────────────────────────────────
async function sendPanel(interaction) {
  const mappingLines = Object.entries(config.groupMappings).map(([waId, dcId]) => {
    const g = waGroups.find(x => x.id === waId);
    return `• **${g?.subject || waId}** → <#${dcId}>`;
  });

  // Sessions membres
  const sessionLines = [];
  for (const [userId, s] of sess.sessions.entries()) {
    const member = await interaction.guild.members.fetch(userId).catch(() => null);
    const name   = member?.displayName || userId;
    const status = s.connected ? `✅ connecté (${s.phoneNumber || '?'})` : '🔄 reconnexion...';
    sessionLines.push(`• **${name}** : ${status}`);
  }

  // Rôles WA existants
  const waRoles = interaction.guild.roles.cache
    .filter(r => r.name.startsWith('WA | '))
    .map(r => `• <@&${r.id}> — ${r.members.size} membre(s)`);

  const embed = new EmbedBuilder()
    .setTitle('🎛️ Panneau de configuration')
    .setColor(0x25d366)
    .addFields(
      { name: '📡 Bot WA principal', value: mainConnected ? '✅ Connecté' : '❌ Déconnecté' },
      { name: '🔗 Groupes WA liés', value: mappingLines.length ? mappingLines.join('\n') : '_Aucun_' },
      { name: '👥 Sessions membres', value: sessionLines.length ? sessionLines.join('\n') : '_Personne de connecté_' },
      { name: '🏷️ Rôles WA', value: waRoles.length ? waRoles.join('\n') : '_Aucun rôle WA_' },
    )
    .setFooter({ text: 'Utilise /connect pour lier ton compte WhatsApp' });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('panel_list_groups').setLabel('📋 Groupes WA').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('panel_setup_group').setLabel('⚡ Lier un groupe').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('panel_unmap_group').setLabel('🗑️ Délier').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('panel_roles').setLabel('🏷️ Gérer rôles').setStyle(ButtonStyle.Secondary),
  );

  await interaction.reply({ embeds: [embed], components: [row] });
}

async function sendGroupList(interaction) {
  if (!mainConnected) return interaction.reply({ content: '❌ Bot WA non connecté.', ephemeral: true });
  const lines = waGroups.slice(0, 25).map((g, i) => {
    const linked = config.groupMappings[g.id] ? ' ✅' : '';
    return `\`${i+1}.\` **${g.subject}**${linked}\n└ \`${g.id}\``;
  });
  const embed = new EmbedBuilder()
    .setTitle(`📋 Groupes WhatsApp (${waGroups.length})`)
    .setDescription(lines.join('\n') || '_Aucun_')
    .setColor(0x25d366);
  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function sendSetupSelect(interaction) {
  if (!mainConnected) return interaction.reply({ content: '❌ Bot WA non connecté.', ephemeral: true });
  const unlinked = waGroups.filter(g => !config.groupMappings[g.id]).slice(0, 5);
  if (!unlinked.length) return interaction.reply({ content: '✅ Tous les groupes sont liés !', ephemeral: true });

  const rows = unlinked.map(g => new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`setup_auto_${g.id}`).setLabel(`⚡ ${g.subject.slice(0, 40)}`).setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`setup_manual_${g.id}`).setLabel('✏️ Manuel').setStyle(ButtonStyle.Secondary),
  ));

  const embed = new EmbedBuilder()
    .setTitle('🔗 Lier un groupe')
    .setDescription(
      unlinked.map((g, i) => `**${i+1}.** ${g.subject}`).join('\n') +
      '\n\n⚡ **Auto** = crée salon + rôles\n✏️ **Manuel** = salon existant'
    ).setColor(0x25d366);

  await interaction.reply({ embeds: [embed], components: rows, ephemeral: true });
}

async function sendRolesPanel(interaction) {
  const waRoles = interaction.guild.roles.cache.filter(r => r.name.startsWith('WA | '));
  if (!waRoles.size) return interaction.reply({ content: '_Aucun rôle WA sur ce serveur_', ephemeral: true });

  const lines = waRoles.map(r =>
    `• **${r.name}** (${r.members.size} membre(s)) — couleur ${r.hexColor}`
  );

  const embed = new EmbedBuilder()
    .setTitle('🏷️ Rôles WhatsApp')
    .setDescription(lines.join('\n'))
    .setColor(0x25d366)
    .setFooter({ text: 'Les rôles WA | Nom sont créés automatiquement lors de la liaison de groupe' });

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

// ─── Discord Events ────────────────────────────────────────────────────────────
dcClient.on('clientReady', async () => {
  console.log(`✅ Discord connecté : ${dcClient.user.tag}`);
  dcClient.user.setPresence({
    activities: [{ name: '📱 WhatsApp Bridge', type: ActivityType.Watching }],
    status: 'online',
  });
  for (const guild of dcClient.guilds.cache.values()) await registerCommands(guild.id);
  // Restaurer toutes les sessions membres
  await sess.restoreAllSessions();
});

dcClient.on('interactionCreate', async interaction => {
  if (interaction.isChatInputCommand()) {
    const { commandName } = interaction;
    if (!config.guildId) { config.guildId = interaction.guildId; cfg.save(config); }

    // /panel
    if (commandName === 'panel') return sendPanel(interaction);

    // /status
    if (commandName === 'status') {
      const s = sess.getSession(interaction.user.id);
      if (!s) return interaction.reply({ content: '❌ Tu n\'as pas de session WA active. Utilise `/connect`.', ephemeral: true });
      const status = s.connected
        ? `✅ Connecté — Numéro : \`${s.phoneNumber || 'inconnu'}\``
        : '🔄 En cours de reconnexion...';
      return interaction.reply({ content: `**📶 Ton statut WhatsApp :** ${status}`, ephemeral: true });
    }

    // /connect
    if (commandName === 'connect') {
      const numero = interaction.options.getString('numero').replace(/\D/g, '');
      if (!numero || numero.length < 8)
        return interaction.reply({ content: '❌ Numéro invalide. Format : `+33612345678`', ephemeral: true });

      await interaction.deferReply({ ephemeral: true });

      try {
        const code = await sess.startSession(interaction.user.id, numero);
        if (code) {
          const formatted = code.match(/.{1,4}/g).join('-');
          const embed = new EmbedBuilder()
            .setTitle('📱 Code de connexion WhatsApp')
            .setDescription(
              `**Ton code de pairing :**\n# \`${formatted}\`\n\n` +
              '**Comment l\'utiliser :**\n' +
              '1. Ouvre WhatsApp sur ton téléphone\n' +
              '2. Paramètres → Appareils liés\n' +
              '3. Lier un appareil → Lier avec numéro de téléphone\n' +
              '4. Entre le code ci-dessus\n\n' +
              '⏳ Le code expire dans 2 minutes.'
            )
            .setColor(0x25d366)
            .setFooter({ text: 'Ne partage pas ce code !' });
          return interaction.editReply({ embeds: [embed] });
        } else {
          return interaction.editReply({ content: '🔄 Session existante en cours de restauration...' });
        }
      } catch (e) {
        console.error('Erreur /connect:', e.message);
        return interaction.editReply({ content: `❌ Erreur : ${e.message}` });
      }
    }

    // /disconnect
    if (commandName === 'disconnect') {
      await sess.deleteSession(interaction.user.id);
      return interaction.reply({ content: '✅ Ton compte WhatsApp a été déconnecté.', ephemeral: true });
    }

    // /send
    if (commandName === 'send') {
      const userId = interaction.user.id;
      if (!sess.isConnected(userId))
        return interaction.reply({ content: '❌ Ton compte WA n\'est pas connecté. Utilise `/connect`.', ephemeral: true });

      const dest = interaction.options.getString('destination');
      const text = interaction.options.getString('message');
      const jid  = resolveDestination(dest);
      if (!jid) return interaction.reply({ content: `❌ Destination introuvable : \`${dest}\``, ephemeral: true });

      try {
        await sess.sendMessage(userId, jid, { text });
        return interaction.reply({ content: `✅ Message envoyé à **${dest}**`, ephemeral: true });
      } catch (e) {
        return interaction.reply({ content: `❌ Erreur : ${e.message}`, ephemeral: true });
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
        if (!config.contacts[nom]) return interaction.reply({ content: `❌ Introuvable.`, ephemeral: true });
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
    if (id === 'panel_setup_group') return sendSetupSelect(interaction);
    if (id === 'panel_roles')       return sendRolesPanel(interaction);

    if (id === 'panel_unmap_group') {
      const lines = Object.entries(config.groupMappings).map(([waId, dcId]) => {
        const g = waGroups.find(x => x.id === waId);
        return `• **${g?.subject || waId}** → <#${dcId}> — \`!unmap ${waId}\``;
      });
      return interaction.reply({ content: lines.length ? lines.join('\n') : '_Aucun groupe lié_', ephemeral: true });
    }

    if (id.startsWith('setup_auto_')) {
      const groupId = id.replace('setup_auto_', '');
      const group   = waGroups.find(g => g.id === groupId);
      if (!group) return interaction.reply({ content: '❌ Groupe introuvable.', ephemeral: true });
      await interaction.deferReply({ ephemeral: true });
      try {
        const { channel, adminRoles, memberRoles } = await autoCreateChannel(interaction.guild, group);
        const embed = new EmbedBuilder()
          .setTitle('✅ Salon créé !')
          .setColor(0x25d366)
          .addFields(
            { name: '📺 Salon', value: `<#${channel.id}>` },
            { name: '👑 Admins (peuvent écrire)', value: adminRoles.map(r => `<@&${r.id}>`).join(', ') || '_Aucun_' },
            { name: '👥 Membres (lecture seule)', value: memberRoles.map(r => `<@&${r.id}>`).join(', ') || '_Aucun_' },
          )
          .setFooter({ text: 'Assigne les rôles WA aux membres Discord pour leur donner accès' });
        return interaction.editReply({ embeds: [embed] });
      } catch (e) {
        return interaction.editReply({ content: `❌ Erreur : ${e.message}` });
      }
    }

    if (id.startsWith('setup_manual_')) {
      const groupId = id.replace('setup_manual_', '');
      return interaction.reply({
        content: `**✏️ Liaison manuelle :**\n\`\`\`\n!map ${groupId} <ID_SALON_DISCORD>\n\`\`\``,
        ephemeral: true,
      });
    }
  }
});

// Messages Discord → WA (depuis le bon compte du membre)
dcClient.on('messageCreate', async msg => {
  if (msg.author.bot) return;

  // Commandes admin texte
  if (msg.content.startsWith('!map ')) {
    const parts = msg.content.split(' ');
    if (parts.length < 3) return msg.reply('Usage: `!map <waGroupId> <discordChannelId>`');
    config.groupMappings[parts[1]] = parts[2];
    cfg.save(config);
    return msg.reply(`✅ Groupe lié au salon <#${parts[2]}>`);
  }
  if (msg.content.startsWith('!unmap ')) {
    const waId = msg.content.split(' ')[1];
    if (!config.groupMappings[waId]) return msg.reply('❌ Groupe non trouvé.');
    delete config.groupMappings[waId];
    cfg.save(config);
    return msg.reply(`✅ Groupe délié.`);
  }

  // Si le salon est mappé à un groupe WA → relayer le message depuis le compte WA du membre
  const waGroupId = Object.entries(config.groupMappings).find(([, dcId]) => dcId === msg.channelId)?.[0];
  if (!waGroupId) return;

  const userId = msg.author.id;
  if (!sess.isConnected(userId)) {
    // Pas de session WA → ignorer silencieusement (ou réagir avec ❌)
    await msg.react('❌').catch(() => {});
    return;
  }

  try {
    // Transférer le message sur WA depuis le compte du membre
    if (msg.attachments.size > 0) {
      for (const att of msg.attachments.values()) {
        const isImage = att.contentType?.startsWith('image/');
        const isVideo = att.contentType?.startsWith('video/');
        const isAudio = att.contentType?.startsWith('audio/');

        if (isImage) {
          await sess.sendMessage(userId, waGroupId, {
            image: { url: att.url },
            caption: msg.content || undefined,
          });
        } else if (isVideo) {
          await sess.sendMessage(userId, waGroupId, {
            video: { url: att.url },
            caption: msg.content || undefined,
          });
        } else if (isAudio) {
          await sess.sendMessage(userId, waGroupId, {
            audio: { url: att.url },
            mimetype: att.contentType,
          });
        } else {
          await sess.sendMessage(userId, waGroupId, {
            document: { url: att.url },
            fileName: att.name,
            mimetype: att.contentType || 'application/octet-stream',
          });
        }
      }
    } else if (msg.content) {
      await sess.sendMessage(userId, waGroupId, { text: msg.content });
    }
    await msg.react('✅').catch(() => {});
  } catch (e) {
    console.error('Erreur DC→WA:', e.message);
    await msg.react('❌').catch(() => {});
  }
});

// ─── Callback : message WA reçu (toutes sessions membres) ─────────────────────
sess.setOnMessage(async (discordUserId, msg, socket) => {
  const jid     = msg.key.remoteJid;
  const isGroup = jid.endsWith('@g.us');
  if (!isGroup) return; // pour l'instant on ne gère que les groupes

  const dcChannelId = config.groupMappings[jid];
  if (!dcChannelId) return;

  let channel;
  try { channel = await dcClient.channels.fetch(dcChannelId); } catch { return; }

  const sender  = msg.pushName || msg.key.participant?.replace('@s.whatsapp.net', '') || '?';
  const content = msg.message;
  const text    = content?.conversation
    || content?.extendedTextMessage?.text
    || content?.imageMessage?.caption
    || content?.videoMessage?.caption
    || null;

  const mediaType = content?.imageMessage ? 'image'
    : content?.videoMessage ? 'video'
    : content?.audioMessage ? 'audio'
    : content?.documentMessage ? 'document'
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
  } catch (e) { console.error('Erreur WA→DC:', e.message); }
});

// Callback : changement de statut session membre
sess.setOnStatus(async (discordUserId, status, phoneNumber) => {
  console.log(`📶 Session ${discordUserId}: ${status} ${phoneNumber || ''}`);
});

// ─── Session WA principale (compte du bot pour lire les groupes) ───────────────
async function startMainWA() {
  if (mainSocket) {
    try { mainSocket.ev.removeAllListeners(); } catch (_) {}
    try { mainSocket.end(); } catch (_) {}
    mainSocket = null;
  }
  mainConnected = false;

  const mainDir = `${AUTH_DIR}/main`;
  if (!fs.existsSync(mainDir)) fs.mkdirSync(mainDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(mainDir);
  const { version }          = await fetchLatestBaileysVersion();

  mainSocket = makeWASocket({
    version, auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['WA-Bot-Main', 'Chrome', '1.0.0'],
  });

  mainSocket.ev.on('creds.update', saveCreds);

  mainSocket.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) { lastQR = qr; console.log('📱 QR principal prêt'); }
    if (connection === 'open') {
      lastQR = null; mainConnected = true;
      console.log('✅ Session principale WA connectée !');
      try {
        const chats = await mainSocket.groupFetchAllParticipating();
        waGroups = Object.values(chats);
        console.log(`📋 ${waGroups.length} groupes chargés`);
      } catch (e) { console.error('Erreur groupes:', e.message); }
    }
    if (connection === 'close') {
      mainConnected = false; lastQR = null;
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === 401 || code === 403) fs.rmSync(`${AUTH_DIR}/main`, { recursive: true, force: true });
      if (code !== DisconnectReason.loggedOut) setTimeout(startMainWA, 3000);
    }
  });

  // La session principale reçoit aussi les messages des groupes (backup)
  mainSocket.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      if (!msg.message) continue;
      const jid = msg.key.remoteJid;
      if (!jid.endsWith('@g.us')) continue;
      const dcChannelId = config.groupMappings[jid];
      if (!dcChannelId) continue;
      // Éviter les doublons : ne poster que si aucun membre n'a cette session
      const senderJid = msg.key.participant || '';
      const hasMemberSession = findDiscordUserByJid(senderJid);
      if (hasMemberSession) return; // le membre a sa propre session, elle va poster

      let channel;
      try { channel = await dcClient.channels.fetch(dcChannelId); } catch { continue; }
      const sender  = msg.pushName || senderJid.replace('@s.whatsapp.net', '') || '?';
      const content = msg.message;
      const text    = content?.conversation || content?.extendedTextMessage?.text
        || content?.imageMessage?.caption || content?.videoMessage?.caption || null;
      const mediaType = content?.imageMessage ? 'image' : content?.videoMessage ? 'video'
        : content?.audioMessage ? 'audio' : content?.documentMessage ? 'document' : null;
      try {
        if (mediaType) {
          const buffer = await downloadMediaMessage(msg, 'buffer', {});
          const ext    = { image: 'jpg', video: 'mp4', audio: 'ogg', document: 'bin' }[mediaType];
          const attach = new AttachmentBuilder(buffer, { name: `media.${ext}` });
          await channel.send({ content: `📱 **${sender}**${text ? ` : ${text}` : ''}`, files: [attach] });
        } else if (text) {
          await channel.send(`📱 **${sender}** : ${text}`);
        }
      } catch (e) { console.error('Erreur main WA→DC:', e.message); }
    }
  });
}

// ─── Démarrage ─────────────────────────────────────────────────────────────────
process.on('unhandledRejection', err => console.error('Unhandled:', err?.message || err));
dcClient.login(process.env.DISCORD_TOKEN);
startMainWA();
