const fs = require('fs');

const CONFIG_PATH = '/app/.wa_auth/bot_config.json';

const DEFAULT_CONFIG = {
  // { waGroupId: discordChannelId }
  groupMappings: {},
  // { name: jid }
  contacts: {},
  // Discord guild + panel channel
  guildId: null,
  panelChannelId: null,
};

function load() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    }
  } catch (_) {}
  return { ...DEFAULT_CONFIG };
}

function save(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

module.exports = { load, save, DEFAULT_CONFIG };
