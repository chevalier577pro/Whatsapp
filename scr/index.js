require('dotenv').config();
const { initWhatsApp, sendWhatsApp } = require('./whatsapp');
const { initDiscord, sendDiscord } = require('./discord');

// WhatsApp → Discord
initWhatsApp(async (msg) => {
  const contact = await msg.getContact();
  const name = contact.pushname || msg.from;
  await sendDiscord(`📱 **${name}** : ${msg.body}`);
});

// Discord → WhatsApp
// Format attendu dans Discord : !wa +33612345678 Ton message
initDiscord(async (msg) => {
  const match = msg.content.match(/^!wa\s+(\+\d+)\s+(.+)/s);
  if (!match) return;
  const number = match[1].replace('+', '') + '@c.us';
  const text = match[2];
  await sendWhatsApp(number, text);
  await msg.react('✅');
});
```

**`.env`**
```
DISCORD_TOKEN=ton_token_discord
DISCORD_CHANNEL_ID=id_du_channel
