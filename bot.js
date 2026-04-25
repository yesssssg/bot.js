const { Client, GatewayIntentBits, PermissionsBitField } = require('discord.js');
const Mega = require('megajs');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

// ─── State ────────────────────────────────────────────────────────────────────

const everyonePingIntervals = new Map();
const userPingIntervals = new Map();
// pingJoinChannels: { guildId -> channelId }
const pingJoinChannels = new Map();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseCooldown(str) {
  const match = str.match(/^(\d+)(s|m|h|d)?$/i);
  if (!match) return null;
  const value = parseInt(match[1]);
  const unit = (match[2] || 's').toLowerCase();
  const multipliers = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
  return value * multipliers[unit];
}

function formatCooldown(ms) {
  if (ms >= 86400000) return `${ms / 86400000}d`;
  if (ms >= 3600000)  return `${ms / 3600000}h`;
  if (ms >= 60000)    return `${ms / 60000}m`;
  return `${ms / 1000}s`;
}

function requireAdmin(message) {
  return message.member.permissions.has(PermissionsBitField.Flags.Administrator);
}

const PREFIX = '!';

// ─── Join Ping Handler ────────────────────────────────────────────────────────

client.on('guildMemberAdd', async (member) => {
  const channelId = pingJoinChannels.get(member.guild.id);
  if (!channelId) return;

  try {
    const channel = await member.guild.channels.fetch(channelId);
    if (!channel) return;
    const ping = await channel.send(`<@${member.id}>`);
    ping.delete().catch(() => {});
  } catch (e) {
    console.error('Failed to send join ping:', e);
  }
});

// ─── Message Handler ──────────────────────────────────────────────────────────

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith(PREFIX)) return;

  const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const command = args.shift().toLowerCase();

  // ── !middlemega ──────────────────────────────────────────────
  if (command === 'middlemega') {
    try {
      await message.reply('🔍 Searching for mega.nz folders...');

      const fetched = await message.channel.messages.fetch({ limit: 100 });

      const megaLinks = [];
      const regex = /https?:\/\/mega\.nz\/[^\s]+/gi;

      fetched.forEach(msg => {
        const matches = msg.content.match(regex);
        if (matches) megaLinks.push(...matches);
      });

      if (!megaLinks.length) {
        return message.reply('❌ No mega.nz links found in this channel.');
      }

      function getAllImages(node, out = []) {
        if (!node) return out;

        if (node.children && node.children.length) {
          for (const child of node.children) {
            getAllImages(child, out);
          }
        } else {
          if (node.name && /\.(png|jpg|jpeg|webp|gif)$/i.test(node.name)) {
            out.push(node);
          }
        }

        return out;
      }

      let bestFolder = null;
      let mostFiles = 0;

      for (const link of megaLinks) {
        try {
          const folder = Mega.File.fromURL(link);

          // ✅ ADDED: load children (important)
          await new Promise((resolve, reject) => {
            folder.loadAttributes(err => {
              if (err) return reject(err);

              folder.loadChildren(err2 => {
                if (err2) reject(err2);
                else resolve();
              });
            });
          });

          // ✅ ADDED: detect and move into subfolder from URL
          let targetNode = folder;

          const subMatch = link.match(/\/folder\/([a-zA-Z0-9_-]+)/g);
          if (subMatch && subMatch.length > 1) {
            const lastFolderId = subMatch[subMatch.length - 1].split('/').pop();

            function findFolderById(node, id) {
              if (!node || !node.children) return null;

              for (const child of node.children) {
                if (child.nodeId === id) return child;
                const found = findFolderById(child, id);
                if (found) return found;
              }
              return null;
            }

            const found = findFolderById(folder, lastFolderId);
            if (found) targetNode = found;
          }

          // ✅ CHANGED: use targetNode instead of folder
          const images = getAllImages(targetNode);

          if (images.length > mostFiles) {
            mostFiles = images.length;
            bestFolder = images;
          }

        } catch (e) {
          console.error('Mega error:', e);
        }
      }

      if (!bestFolder || bestFolder.length === 0) {
        return message.reply('❌ No valid mega folders with images found.');
      }

      const mid = Math.floor(bestFolder.length / 2);

      const selected = [
        bestFolder[mid - 1],
        bestFolder[mid],
        bestFolder[mid + 1]
      ].filter(Boolean);

      for (const file of selected) {
        const buffer = await new Promise((resolve, reject) => {
          file.downloadBuffer((err, data) => {
            if (err) reject(err);
            else resolve(data);
          });
        });

        await message.channel.send({
          files: [{ attachment: buffer, name: file.name }]
        });
      }

    } catch (e) {
      console.error(e);
      message.reply('❌ Failed to process mega folder.');
    }
  }

  // ── !disable — stop all currently running auto-pings ────────────────────
  if (command === 'disable') {
    if (!requireAdmin(message)) {
      return message.reply('❌ You need Administrator permission to use this command.');
    }

    let stopped = 0;

    for (const [channelId, data] of everyonePingIntervals) {
      clearInterval(data.interval);
      everyonePingIntervals.delete(channelId);
      stopped++;
    }

    for (const [channelId, data] of userPingIntervals) {
      clearInterval(data.interval);
      userPingIntervals.delete(channelId);
      stopped++;
    }

    if (stopped === 0) {
      return message.reply('ℹ️ No active auto-pings to stop.');
    }

    return message.reply(`✅ Stopped **${stopped}** active auto-ping${stopped !== 1 ? 's' : ''}.`);
  }

  // ── !pingjoin enable / disable ───────────────────────────────────────────
  if (command === 'pingjoin') {
    if (!requireAdmin(message)) {
      return message.reply('❌ You need Administrator permission to use this command.');
    }

    const sub = args[0]?.toLowerCase();

    if (sub === 'enable') {
      pingJoinChannels.set(message.guild.id, message.channel.id);
      return message.reply(`✅ Join pings **enabled** — new members will be pinged in this channel (ping deleted immediately).`);
    }

    if (sub === 'disable') {
      if (!pingJoinChannels.has(message.guild.id)) {
        return message.reply('ℹ️ Join pings are not active.');
      }
      pingJoinChannels.delete(message.guild.id);
      return message.reply('✅ Join pings **disabled**.');
    }

    return message.reply('Usage: `!pingjoin enable` or `!pingjoin disable`');
  }

  // ── !autopingeveryone enable <cooldown> ──────────────────────────────────
  if (command === 'autopingeveryone') {
    if (!requireAdmin(message)) {
      return message.reply('❌ You need Administrator permission to use this command.');
    }

    const sub = args[0]?.toLowerCase();

    if (sub === 'enable') {
      const cooldownStr = args[1];
      if (!cooldownStr) {
        return message.reply('Usage: `!autopingeveryone enable <cooldown>` (e.g. `30s`, `5m`, `2h`)');
      }
      const cooldownMs = parseCooldown(cooldownStr);
      if (!cooldownMs) {
        return message.reply('❌ Invalid cooldown. Use formats like `30s`, `5m`, `2h`, `1d`.');
      }

      if (everyonePingIntervals.has(message.channel.id)) {
        clearInterval(everyonePingIntervals.get(message.channel.id).interval);
      }

      const interval = setInterval(async () => {
        try {
          await message.channel.send('@everyone');
        } catch (e) {
          console.error('Failed to send @everyone ping:', e);
        }
      }, cooldownMs);

      everyonePingIntervals.set(message.channel.id, { interval, cooldownMs });
      return message.reply(`✅ Auto @everyone ping **enabled** in this channel every **${formatCooldown(cooldownMs)}**.`);
    }

    if (sub === 'disable') {
      if (!everyonePingIntervals.has(message.channel.id)) {
        return message.reply('ℹ️ Auto @everyone ping is not active in this channel.');
      }
      clearInterval(everyonePingIntervals.get(message.channel.id).interval);
      everyonePingIntervals.delete(message.channel.id);
      return message.reply('✅ Auto @everyone ping **disabled** in this channel.');
    }

    return message.reply('Usage: `!autopingeveryone enable <cooldown>` or `!autopingeveryone disable`');
  }

  // ── !autopinguser enable @user <cooldown> ────────────────────────────────
  if (command === 'autopinguser') {
    if (!requireAdmin(message)) {
      return message.reply('❌ You need Administrator permission to use this command.');
    }

    const sub = args[0]?.toLowerCase();

    if (sub === 'enable') {
      const userMention = args[1];
      const cooldownStr = args[2];

      if (!userMention || !cooldownStr) {
        return message.reply('Usage: `!autopinguser enable @user <cooldown>`');
      }

      const userId = userMention.replace(/[<@!>]/g, '');
      let targetUser;
      try {
        targetUser = await message.guild.members.fetch(userId);
      } catch {
        return message.reply('❌ Could not find that user in this server.');
      }

      const cooldownMs = parseCooldown(cooldownStr);
      if (!cooldownMs) {
        return message.reply('❌ Invalid cooldown.');
      }

      if (userPingIntervals.has(message.channel.id)) {
        clearInterval(userPingIntervals.get(message.channel.id).interval);
      }

      const interval = setInterval(async () => {
        try {
          const ping = await message.channel.send(`<@${userId}>`);
          setTimeout(() => ping.delete().catch(() => {}), 500);
        } catch (e) {
          console.error('Failed to send user ping:', e);
        }
      }, cooldownMs);

      userPingIntervals.set(message.channel.id, { interval, userId, cooldownMs });
      return message.reply(`✅ Auto ping for ${targetUser} enabled every **${formatCooldown(cooldownMs)}**.`);
    }

    if (sub === 'disable') {
      if (!userPingIntervals.has(message.channel.id)) {
        return message.reply('ℹ️ Auto user ping is not active.');
      }
      clearInterval(userPingIntervals.get(message.channel.id).interval);
      userPingIntervals.delete(message.channel.id);
      return message.reply('✅ Auto user ping disabled.');
    }
  }

});

// ─── Ready ────────────────────────────────────────────────────────────────────

client.once('ready', () => {
  console.log(`✅ Bot is online as ${client.user.tag}`);
});

client.login(process.env.DISCORD_TOKEN);
