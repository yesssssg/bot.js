const { Client, GatewayIntentBits, PermissionsBitField, Collection } = require('discord.js');

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
let botDisabled = false;

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

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith(PREFIX)) return;

  const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const command = args.shift().toLowerCase();

  // ── !disable (toggle all commands) ──────────────────────────────────────
  if (command === 'disable') {
    if (!requireAdmin(message)) {
      return message.reply('❌ You need Administrator permission to use this command.');
    }
    botDisabled = !botDisabled;
    return message.reply(botDisabled ? '🔴 Bot commands **disabled**.' : '🟢 Bot commands **enabled**.');
  }

  if (botDisabled) return;

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
        return message.reply('Usage: `!autopinguser enable @user <cooldown>` (e.g. `!autopinguser enable @John 10s`)');
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
        return message.reply('❌ Invalid cooldown. Use formats like `10s`, `5m`, `2h`.');
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
      return message.reply(`✅ Auto ping for ${targetUser} enabled every **${formatCooldown(cooldownMs)}** (ping deleted after 0.5s).`);
    }

    if (sub === 'disable') {
      if (!userPingIntervals.has(message.channel.id)) {
        return message.reply('ℹ️ Auto user ping is not active in this channel.');
      }
      clearInterval(userPingIntervals.get(message.channel.id).interval);
      userPingIntervals.delete(message.channel.id);
      return message.reply('✅ Auto user ping **disabled** in this channel.');
    }

    return message.reply('Usage: `!autopinguser enable @user <cooldown>` or `!autopinguser disable`');
  }

  // ── !randommessages ──────────────────────────────────────────────────────
  if (command === 'randommessages') {
    try {
      let fetched = await message.channel.messages.fetch({ limit: 100 });
      let pool = fetched.filter(m =>
        !m.author.bot &&
        m.id !== message.id &&
        m.content.trim().length > 0
      ).map(m => m);

      if (pool.length < 3) {
        return message.reply('❌ Not enough non-bot messages in this channel to pick 3 random ones (need at least 3).');
      }

      const picked = [];
      while (picked.length < 3) {
        const idx = Math.floor(Math.random() * pool.length);
        picked.push(pool[idx]);
        pool.splice(idx, 1);
      }

      const lines = picked.map((m, i) =>
        `**${i + 1}.** **${m.author.username}**: ${m.content.slice(0, 300)}${m.content.length > 300 ? '…' : ''}`
      ).join('\n\n');

      return message.reply(`🎲 **3 Random Messages:**\n\n${lines}`);
    } catch (e) {
      console.error(e);
      return message.reply('❌ Failed to fetch messages.');
    }
  }

  // ── !purge <count> [--exclude @user1 @user2 ...] ─────────────────────────
  if (command === 'purge') {
    if (!requireAdmin(message)) {
      return message.reply('❌ You need Administrator permission to use this command.');
    }
    if (!message.channel.permissionsFor(message.guild.members.me).has(PermissionsBitField.Flags.ManageMessages)) {
      return message.reply('❌ I need the **Manage Messages** permission to delete messages.');
    }

    const excludeIndex = args.indexOf('--exclude');
    const countStr = args[0];
    const count = parseInt(countStr);

    if (isNaN(count) || count < 1 || count > 100) {
      return message.reply('Usage: `!purge <1-100> [--exclude @user1 @user2 ...]`');
    }

    const excludedIds = new Set();
    if (excludeIndex !== -1) {
      const excludeMentions = args.slice(excludeIndex + 1);
      for (const mention of excludeMentions) {
        const id = mention.replace(/[<@!>]/g, '');
        if (id) excludedIds.add(id);
      }
    }

    try {
      await message.delete().catch(() => {});

      let fetched = await message.channel.messages.fetch({ limit: 100 });

      const twoWeeksAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
      let toDelete = fetched
        .filter(m =>
          !excludedIds.has(m.author.id) &&
          m.createdTimestamp > twoWeeksAgo
        )
        .map(m => m)
        .slice(0, count);

      if (toDelete.length === 0) {
        return message.channel.send('ℹ️ No messages to delete (they may be older than 14 days or all from excluded users).');
      }

      await message.channel.bulkDelete(toDelete, true);

      const excludeNote = excludedIds.size > 0
        ? ` (excluded ${excludedIds.size} user${excludedIds.size > 1 ? 's' : ''})`
        : '';
      const reply = await message.channel.send(`🗑️ Deleted **${toDelete.length}** message${toDelete.length !== 1 ? 's' : ''}${excludeNote}.`);
      setTimeout(() => reply.delete().catch(() => {}), 4000);
    } catch (e) {
      console.error(e);
      message.channel.send('❌ Failed to delete messages. Make sure messages are not older than 14 days.').catch(() => {});
    }
  }
});

client.once('ready', () => {
  console.log(`✅ Bot is online as ${client.user.tag}`);
  console.log('Commands: !autopingeveryone, !autopinguser, !randommessages, !purge, !disable');
});

client.login(process.env.DISCORD_TOKEN);
