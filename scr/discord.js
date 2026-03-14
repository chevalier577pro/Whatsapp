const { Client, GatewayIntentBits } = require('discord.js');

let dcClient;

function initDiscord(onMessage) {
  dcClient = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent
    ]
  });

  dcClient.on('ready', () => {
    console.log(`✅ Discord connecté : ${dcClient.user.tag}`);
  });

  dcClient.on('messageCreate', msg => {
    if (msg.author.bot) return;
    if (msg.channelId !== process.env.DISCORD_CHANNEL_ID) return;
    onMessage(msg);
  });

  dcClient.login(process.env.DISCORD_TOKEN);
  return dcClient;
}

async function sendDiscord(text) {
  const channel = await dcClient.channels.fetch(process.env.DISCORD_CHANNEL_ID);
  await channel.send(text);
}

module.exports = { initDiscord, sendDiscord };
