const { Client, GatewayIntentBits, PermissionsBitField, ChannelType } = require('discord.js');
const https = require('https');

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
const pingJoinChannels = new Map();

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// X POST WATCHER CONFIG — edit these to change what the bot looks for and says
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const X_WATCH = {

  // The exact text the tweet must contain (case-insensitive)
  TARGET_TEXT: 'hey',

  // What the bot replies with when the tweet matches
  REPLY: 'yes',

  // What the bot replies with when the tweet does NOT match
  WRONG_REPLY: 'wrong post',

  // The channel ID to link to in the wrong post message
  GUIDE_CHANNEL_ID: '1498948285581365353',

};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

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

function findClosestChannel(guild, query) {
  const q = query.toLowerCase().replace(/[^a-z0-9]/g, '');
  const channels = guild.channels.cache.filter(c => c.type === ChannelType.GuildText);

  let bestMatch = null;
  let bestScore = -1;

  for (const channel of channels.values()) {
    const name = channel.name.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (name === q) return channel;

    let score = 0;
    let nameIdx = 0;
    for (const char of q) {
      while (nameIdx < name.length && name[nameIdx] !== char) nameIdx++;
      if (nameIdx < name.length) { score++; nameIdx++; }
    }
    if (name.startsWith(q)) score += 5;
    if (name.includes(q)) score += 3;

    if (score > bestScore) { bestScore = score; bestMatch = channel; }
  }

  return bestScore > 0 ? bestMatch : null;
}

async function weightedRandomPick(pool, count, guild) {
  const weighted = [];
  for (const msg of pool) {
    try {
      const member = await guild.members.fetch(msg.author.id).catch(() => null);
      const hasPaidRole = member?.roles.cache.some(r => r.name.toLowerCase() === 'payed sorry');
      const slots = hasPaidRole ? 3 : 2;
      for (let i = 0; i < slots; i++) weighted.push(msg);
    } catch {
      weighted.push(msg);
      weighted.push(msg);
    }
  }

  const picked = [];
  const usedIds = new Set();

  while (picked.length < count && weighted.length > 0) {
    const idx = Math.floor(Math.random() * weighted.length);
    const msg = weighted[idx];
    if (!usedIds.has(msg.id)) {
      picked.push(msg);
      usedIds.add(msg.id);
    }
    for (let i = weighted.length - 1; i >= 0; i--) {
      if (weighted[i].id === msg.id) weighted.splice(i, 1);
    }
  }

  return picked;
}

function fetchURL(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'
      }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchURL(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function extractTweetText(html) {
  const patterns = [
    /<meta name="description" content="([^"]+)"/i,
    /<meta property="og:description" content="([^"]+)"/i,
    /class="[^"]*tweet[^"]*"[^>]*>([^<]+)</i,
    /<p[^>]*class="[^"]*text[^"]*"[^>]*>([\s\S]*?)<\/p>/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match && match[1]) {
      return match[1]
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/<[^>]+>/g, '')
        .trim();
    }
  }

  return null;
}

function extractTweetId(url) {
  const match = url.match(/(?:twitter\.com|x\.com)\/\w+\/status\/(\d+)/);
  return match ? match[1] : null;
}

// ─── X Link Watcher ───────────────────────────────────────────────────────────

async function checkXLink(message, url) {
  try {
    const tweetId = extractTweetId(url);
    if (!tweetId) return;

    const viewerUrl = `https://twitterwebviewer.com/?tweet_id=${tweetId}`;
    const html = await fetchURL(viewerUrl);
    const tweetText = extractTweetText(html);

    if (!tweetText) return;

    const tweetClean = tweetText.trim().toLowerCase();
    const targetClean = X_WATCH.TARGET_TEXT.trim().toLowerCase();

    if (tweetClean === targetClean) {
      await message.reply(X_WATCH.REPLY);
    } else {
      await message.reply(`${X_WATCH.WRONG_REPLY}\npost exactly what is in <#${X_WATCH.GUIDE_CHANNEL_ID}>`);
    }
  } catch (e) {
    console.error('Failed to check X link:', e);
  }
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

  // ── X link watcher ────────────────────────────────────────────────────────
  const xLinkRegex = /https?:\/\/(?:twitter\.com|x\.com)\/\w+\/status\/\d+[^\s]*/gi;
  const xLinks = message.content.match(xLinkRegex);
  if (xLinks) {
    for (const link of xLinks) {
      await checkXLink(message, link);
    }
  }

  if (!message.content.startsWith(PREFIX)) return;

  const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const command = args.shift().toLowerCase();

  // ── !disable ──────────────────────────────────────────────────────────────
  if (command === 'disable') {
    if (!requireAdmin(message)) return message.reply('❌ You need Administrator permission to use this command.');

    let stopped = 0;
    for (const [channelId, data] of everyonePingIntervals) { clearInterval(data.interval); everyonePingIntervals.delete(channelId); stopped++; }
    for (const [channelId, data] of userPingIntervals) { clearInterval(data.interval); userPingIntervals.delete(channelId); stopped++; }

    if (stopped === 0) return message.reply('ℹ️ No active auto-pings to stop.');
    return message.reply(`✅ Stopped **${stopped}** active auto-ping${stopped !== 1 ? 's' : ''}.`);
  }

  // ── !pingjoin ─────────────────────────────────────────────────────────────
  if (command === 'pingjoin') {
    if (!requireAdmin(message)) return message.reply('❌ You need Administrator permission to use this command.');
    const sub = args[0]?.toLowerCase();
    if (sub === 'enable') { pingJoinChannels.set(message.guild.id, message.channel.id); return message.reply(`✅ Join pings **enabled** in this channel.`); }
    if (sub === 'disable') {
      if (!pingJoinChannels.has(message.guild.id)) return message.reply('ℹ️ Join pings are not active.');
      pingJoinChannels.delete(message.guild.id);
      return message.reply('✅ Join pings **disabled**.');
    }
    return message.reply('Usage: `!pingjoin enable` or `!pingjoin disable`');
  }

  // ── !autopingeveryone ─────────────────────────────────────────────────────
  if (command === 'autopingeveryone') {
    if (!requireAdmin(message)) return message.reply('❌ You need Administrator permission to use this command.');
    const sub = args[0]?.toLowerCase();

    if (sub === 'enable') {
      const cooldownStr = args[1];
      if (!cooldownStr) return message.reply('Usage: `!autopingeveryone enable <cooldown>`');
      const cooldownMs = parseCooldown(cooldownStr);
      if (!cooldownMs) return message.reply('❌ Invalid cooldown.');
      if (everyonePingIntervals.has(message.channel.id)) clearInterval(everyonePingIntervals.get(message.channel.id).interval);
      const interval = setInterval(async () => { try { await message.channel.send('@everyone'); } catch (e) { console.error(e); } }, cooldownMs);
      everyonePingIntervals.set(message.channel.id, { interval, cooldownMs });
      return message.reply(`✅ Auto @everyone ping enabled every **${formatCooldown(cooldownMs)}**.`);
    }
    if (sub === 'disable') {
      if (!everyonePingIntervals.has(message.channel.id)) return message.reply('ℹ️ Not active in this channel.');
      clearInterval(everyonePingIntervals.get(message.channel.id).interval);
      everyonePingIntervals.delete(message.channel.id);
      return message.reply('✅ Auto @everyone ping disabled.');
    }
    return message.reply('Usage: `!autopingeveryone enable <cooldown>` or `!autopingeveryone disable`');
  }

  // ── !autopinguser ─────────────────────────────────────────────────────────
  if (command === 'autopinguser') {
    if (!requireAdmin(message)) return message.reply('❌ You need Administrator permission to use this command.');
    const sub = args[0]?.toLowerCase();

    if (sub === 'enable') {
      const userMention = args[1];
      const cooldownStr = args[2];
      if (!userMention || !cooldownStr) return message.reply('Usage: `!autopinguser enable @user <cooldown>`');
      const userId = userMention.replace(/[<@!>]/g, '');
      let targetUser;
      try { targetUser = await message.guild.members.fetch(userId); } catch { return message.reply('❌ Could not find that user.'); }
      const cooldownMs = parseCooldown(cooldownStr);
      if (!cooldownMs) return message.reply('❌ Invalid cooldown.');
      if (userPingIntervals.has(message.channel.id)) clearInterval(userPingIntervals.get(message.channel.id).interval);
      const interval = setInterval(async () => {
        try { const ping = await message.channel.send(`<@${userId}>`); setTimeout(() => ping.delete().catch(() => {}), 500); }
        catch (e) { console.error(e); }
      }, cooldownMs);
      userPingIntervals.set(message.channel.id, { interval, userId, cooldownMs });
      return message.reply(`✅ Auto ping for ${targetUser} enabled every **${formatCooldown(cooldownMs)}**.`);
    }
    if (sub === 'disable') {
      if (!userPingIntervals.has(message.channel.id)) return message.reply('ℹ️ Not active in this channel.');
      clearInterval(userPingIntervals.get(message.channel.id).interval);
      userPingIntervals.delete(message.channel.id);
      return message.reply('✅ Auto user ping disabled.');
    }
    return message.reply('Usage: `!autopinguser enable @user <cooldown>` or `!autopinguser disable`');
  }

  // ── !randommessages [count] [channel] ────────────────────────────────────
  if (command === 'randommessages') {
    try {
      let requestedCount = 3;
      let channelQuery = null;

      if (args.length > 0) {
        const firstIsNumber = !isNaN(parseInt(args[0])) && isFinite(args[0]);
        if (firstIsNumber) {
          requestedCount = parseInt(args[0]);
          if (args.length > 1) channelQuery = args.slice(1).join(' ');
        } else {
          channelQuery = args.join(' ');
        }
      }

      if (isNaN(requestedCount) || requestedCount < 1) return message.reply('Usage: `!randommessages [number] [channel name]`');

      let targetChannel = message.channel;
      if (channelQuery) {
        const found = findClosestChannel(message.guild, channelQuery);
        if (!found) return message.reply(`Couldn't find a channel matching "${channelQuery}".`);
        targetChannel = found;
      }

      let fetched = await targetChannel.messages.fetch({ limit: 100 });
      let pool = fetched.filter(m => !m.author.bot && m.content.trim().length > 0).map(m => m);

      if (pool.length === 0) return message.reply(`No messages found in ${targetChannel.id !== message.channel.id ? `#${targetChannel.name}` : 'this channel'}.`);

      const actualCount = Math.min(requestedCount, pool.length);
      const picked = await weightedRandomPick(pool, actualCount, message.guild);

      const sourceNote = targetChannel.id !== message.channel.id ? ` from #${targetChannel.name}` : '';
      const header = `${picked.length} random message${picked.length !== 1 ? 's' : ''}${sourceNote}:\n`;
      const lines = picked.map(m => `${m.author.username}\n${m.content.slice(0, 300)}${m.content.length > 300 ? '…' : ''}`).join('\n\n');

      return message.reply(header + lines);
    } catch (e) {
      console.error(e);
      return message.reply('Failed to fetch messages.');
    }
  }

  // ── !purge ────────────────────────────────────────────────────────────────
  if (command === 'purge') {
    if (!requireAdmin(message)) return message.reply('❌ You need Administrator permission to use this command.');
    if (!message.channel.permissionsFor(message.guild.members.me).has(PermissionsBitField.Flags.ManageMessages)) return message.reply('❌ I need Manage Messages permission.');

    const excludeIndex = args.indexOf('--exclude');
    const count = parseInt(args[0]);
    if (isNaN(count) || count < 1 || count > 100) return message.reply('Usage: `!purge <1-100> [--exclude @user1 @user2 ...]`');

    const excludedIds = new Set();
    if (excludeIndex !== -1) {
      for (const mention of args.slice(excludeIndex + 1)) {
        const id = mention.replace(/[<@!>]/g, '');
        if (id) excludedIds.add(id);
      }
    }

    try {
      await message.delete().catch(() => {});
      let fetched = await message.channel.messages.fetch({ limit: 100 });
      const twoWeeksAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
      let toDelete = fetched.filter(m => !excludedIds.has(m.author.id) && m.createdTimestamp > twoWeeksAgo).map(m => m).slice(0, count);
      if (toDelete.length === 0) return message.channel.send('ℹ️ No messages to delete.');
      await message.channel.bulkDelete(toDelete, true);
      const excludeNote = excludedIds.size > 0 ? ` (excluded ${excludedIds.size} user${excludedIds.size > 1 ? 's' : ''})` : '';
      const reply = await message.channel.send(`🗑️ Deleted **${toDelete.length}** message${toDelete.length !== 1 ? 's' : ''}${excludeNote}.`);
      setTimeout(() => reply.delete().catch(() => {}), 4000);
    } catch (e) {
      console.error(e);
      message.channel.send('❌ Failed to delete messages. Make sure messages are not older than 14 days.').catch(() => {});
    }
  }
});

// ─── Ready ────────────────────────────────────────────────────────────────────

client.once('ready', () => {
  console.log(`✅ Bot is online as ${client.user.tag}`);
  console.log(`Watching X posts for: "${X_WATCH.TARGET_TEXT}"`);
});

client.login(process.env.DISCORD_TOKEN);
