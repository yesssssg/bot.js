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
const spamTracker = new Map();

// In-memory cache of combined post counts { userId -> count }
// X and Reddit posts both increment the same counter per user
const postCounts = new Map();

// In-memory sets of already-seen link IDs
const seenXLinks = new Set();
const seenRedditLinks = new Set();

// Channel ID where counts AND seen links are stored
const DATA_CHANNEL_ID = '1497467308010901525';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// X POST WATCHER CONFIG
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const X_WATCH = {
  TARGET_TEXT: 'hey @grok remove the red things😋',
  REPLY_PREFIX: 'good',
  POSTS_REQUIRED: 3,
  REWARD_ROLE: 'payed sorry',
  ALREADY_DONE_REPLY: 'thanks',
  WRONG_REPLY: 'wrong post',
  GUIDE_CHANNEL_ID: '1498948285581365353',
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// REDDIT POST WATCHER CONFIG
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const REDDIT_WATCH = {
  // Match against post title, body (selftext), or both — options: 'title', 'body', 'both'
  MATCH_FIELD: 'title',
  TARGET_TEXT: 'hey @grok remove the red things😋',
  REPLY_PREFIX: 'good',
  POSTS_REQUIRED: 3,
  REWARD_ROLE: 'payed sorry',
  ALREADY_DONE_REPLY: 'thanks',
  WRONG_REPLY: 'wrong post',
  GUIDE_CHANNEL_ID: '1498948285581365353',
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// ─── Data Channel Storage ─────────────────────────────────────────────────────

// Combined count: "COUNT:userId:count"
// Seen X links:   "XLINK:tweetId"
// Seen Reddit:    "RLINK:postId"
// On startup we fetch all messages and rebuild all in-memory structures.

let dataChannel = null;
const dataMessages = new Map(); // userId -> Discord message (for combined counts)

async function loadDataFromChannel() {
  try {
    dataChannel = await client.channels.fetch(DATA_CHANNEL_ID);
    if (!dataChannel) { console.error('Data channel not found!'); return; }

    let lastId = null;
    let allMessages = [];

    while (true) {
      const options = { limit: 100 };
      if (lastId) options.before = lastId;
      const batch = await dataChannel.messages.fetch(options);
      if (batch.size === 0) break;
      allMessages = allMessages.concat([...batch.values()]);
      lastId = batch.last().id;
      if (batch.size < 100) break;
    }

    for (const msg of allMessages) {
      // Load combined post counts
      if (msg.content.startsWith('COUNT:')) {
        const parts = msg.content.split(':');
        if (parts.length !== 3) continue;
        const userId = parts[1];
        const count = parseInt(parts[2]);
        if (isNaN(count)) continue;
        postCounts.set(userId, count);
        dataMessages.set(userId, msg);
        continue;
      }

      // Load seen X links
      if (msg.content.startsWith('XLINK:')) {
        const tweetId = msg.content.slice(6).trim();
        if (tweetId) seenXLinks.add(tweetId);
        continue;
      }

      // Load seen Reddit links
      if (msg.content.startsWith('RLINK:')) {
        const postId = msg.content.slice(6).trim();
        if (postId) seenRedditLinks.add(postId);
        continue;
      }
    }

    console.log(`Loaded ${postCounts.size} user counts, ${seenXLinks.size} seen X links, ${seenRedditLinks.size} seen Reddit links from data channel.`);
  } catch (e) {
    console.error('Failed to load data from channel:', e);
  }
}

async function saveUserCount(userId, count) {
  try {
    if (!dataChannel) return;
    const content = `COUNT:${userId}:${count}`;

    if (dataMessages.has(userId)) {
      const msg = dataMessages.get(userId);
      const updated = await msg.edit(content);
      dataMessages.set(userId, updated);
    } else {
      const newMsg = await dataChannel.send(content);
      dataMessages.set(userId, newMsg);
    }
  } catch (e) {
    console.error('Failed to save user count:', e);
  }
}

// Record a tweet ID as seen (persisted to the data channel)
async function saveSeenLink(tweetId) {
  try {
    if (!dataChannel) return;
    seenXLinks.add(tweetId);
    await dataChannel.send(`XLINK:${tweetId}`);
  } catch (e) {
    console.error('Failed to save seen link:', e);
  }
}

// Record a Reddit post ID as seen (persisted to the data channel)
async function saveSeenRedditLink(postId) {
  try {
    if (!dataChannel) return;
    seenRedditLinks.add(postId);
    await dataChannel.send(`RLINK:${postId}`);
  } catch (e) {
    console.error('Failed to save seen Reddit link:', e);
  }
}

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
      headers: { 'User-Agent': 'bot', 'Accept': 'application/json' }
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

function extractTweetId(url) {
  const match = url.match(/(?:twitter\.com|x\.com)\/\w+\/status\/(\d+)/);
  return match ? match[1] : null;
}

// ─── Format Spam Check ────────────────────────────────────────────────────────

// Returns true if the message content violates formatting rules:
//   - more than 3 newlines
//   - any single character repeated 49 or more times consecutively
function isFormatSpam(content) {
  const newlineCount = (content.match(/\n/g) || []).length;
  if (newlineCount > 3) return true;
  if (/(.)\1{48,}/.test(content)) return true;
  return false;
}

// ─── X Link Watcher ───────────────────────────────────────────────────────────

async function checkXLink(message, url) {
  try {
    const tweetId = extractTweetId(url);
    if (!tweetId) return;

    const userId = message.author.id;
    const currentCount = postCounts.get(userId) || 0;

    // Check if this exact tweet ID has already been submitted (in-memory + data channel)
    if (seenXLinks.has(tweetId)) {
      return message.reply(`sent already\ncurrent post count: ${currentCount}/${X_WATCH.POSTS_REQUIRED}`);
    }

    const apiUrl = `https://api.fxtwitter.com/status/${tweetId}`;
    const raw = await fetchURL(apiUrl);

    let json;
    try { json = JSON.parse(raw); }
    catch {
      console.error('fxtwitter returned non-JSON:', raw.slice(0, 200));
      return;
    }

    const tweetText = json?.tweet?.text;
    if (!tweetText) {
      console.error('No tweet text in fxtwitter response:', JSON.stringify(json).slice(0, 200));
      return;
    }

    const tweetClean = tweetText.trim().toLowerCase();
    const targetClean = X_WATCH.TARGET_TEXT.trim().toLowerCase();

    if (tweetClean === targetClean) {
      const member = await message.guild.members.fetch(userId).catch(() => null);
      const hasRole = member?.roles.cache.some(r => r.name.toLowerCase() === X_WATCH.REWARD_ROLE.toLowerCase());

      if (hasRole) {
        await saveSeenLink(tweetId);
        return message.reply(X_WATCH.ALREADY_DONE_REPLY);
      }

      await saveSeenLink(tweetId);

      const newCount = currentCount + 1;
      postCounts.set(userId, newCount);
      await saveUserCount(userId, newCount);

      if (newCount >= X_WATCH.POSTS_REQUIRED) {
        const role = message.guild.roles.cache.find(r => r.name.toLowerCase() === X_WATCH.REWARD_ROLE.toLowerCase());
        if (role && member) {
          await member.roles.add(role).catch(e => console.error('Failed to add role:', e));
        }
        return message.reply(`${X_WATCH.REPLY_PREFIX}, ${newCount}/${X_WATCH.POSTS_REQUIRED} posts — role given!`);
      } else {
        return message.reply(`${X_WATCH.REPLY_PREFIX}, ${newCount}/${X_WATCH.POSTS_REQUIRED} posts`);
      }

    } else {
      await saveSeenLink(tweetId);
      await message.reply(`${X_WATCH.WRONG_REPLY}\npost exactly what is in <#${X_WATCH.GUIDE_CHANNEL_ID}>`);
    }

  } catch (e) {
    console.error('Failed to check X link:', e);
  }
}

function extractRedditPostId(url) {
  // Matches /comments/POST_ID/ in any reddit URL shape
  const match = url.match(/reddit\.com\/(?:r\/[^/]+\/)?comments\/([a-z0-9]+)/i);
  return match ? match[1] : null;
}

// ─── Reddit Link Watcher ──────────────────────────────────────────────────────

async function checkRedditLink(message, url) {
  try {
    const postId = extractRedditPostId(url);
    if (!postId) return;

    const userId = message.author.id;
    const currentCount = postCounts.get(userId) || 0;

    // Duplicate check
    if (seenRedditLinks.has(postId)) {
      return message.reply(`sent already\ncurrent post count: ${currentCount}/${REDDIT_WATCH.POSTS_REQUIRED}`);
    }

    // Fetch post data via Reddit's public .json endpoint
    const jsonUrl = `https://www.reddit.com/comments/${postId}.json`;
    let raw;
    try {
      raw = await fetchURL(jsonUrl);
    } catch (e) {
      console.error('Failed to fetch Reddit post:', e);
      return;
    }

    let json;
    try { json = JSON.parse(raw); }
    catch {
      console.error('Reddit returned non-JSON:', raw.slice(0, 200));
      return;
    }

    const postData = json?.[0]?.data?.children?.[0]?.data;
    if (!postData) {
      console.error('Could not parse Reddit post data');
      return;
    }

    const postTitle    = (postData.title    || '').trim().toLowerCase();
    const postSelftext = (postData.selftext || '').trim().toLowerCase();
    const targetClean  = REDDIT_WATCH.TARGET_TEXT.trim().toLowerCase();

    let matched = false;
    if (REDDIT_WATCH.MATCH_FIELD === 'title')  matched = postTitle === targetClean;
    if (REDDIT_WATCH.MATCH_FIELD === 'body')   matched = postSelftext === targetClean;
    if (REDDIT_WATCH.MATCH_FIELD === 'both')   matched = postTitle === targetClean || postSelftext === targetClean;

    if (matched) {
      const member = await message.guild.members.fetch(userId).catch(() => null);
      const hasRole = member?.roles.cache.some(r => r.name.toLowerCase() === REDDIT_WATCH.REWARD_ROLE.toLowerCase());

      if (hasRole) {
        await saveSeenRedditLink(postId);
        return message.reply(REDDIT_WATCH.ALREADY_DONE_REPLY);
      }

      await saveSeenRedditLink(postId);

      const newCount = currentCount + 1;
      postCounts.set(userId, newCount);
      await saveUserCount(userId, newCount);

      if (newCount >= REDDIT_WATCH.POSTS_REQUIRED) {
        const role = message.guild.roles.cache.find(r => r.name.toLowerCase() === REDDIT_WATCH.REWARD_ROLE.toLowerCase());
        if (role && member) {
          await member.roles.add(role).catch(e => console.error('Failed to add role:', e));
        }
        return message.reply(`${REDDIT_WATCH.REPLY_PREFIX}, ${newCount}/${REDDIT_WATCH.POSTS_REQUIRED} posts — role given!`);
      } else {
        return message.reply(`${REDDIT_WATCH.REPLY_PREFIX}, ${newCount}/${REDDIT_WATCH.POSTS_REQUIRED} posts`);
      }

    } else {
      await saveSeenRedditLink(postId);
      await message.reply(`${REDDIT_WATCH.WRONG_REPLY}\npost exactly what is in <#${REDDIT_WATCH.GUIDE_CHANNEL_ID}>`);
    }

  } catch (e) {
    console.error('Failed to check Reddit link:', e);
  }
}

async function handleAntiSpam(message) {
  const userId = message.author.id;
  const now = Date.now();
  const WINDOW = 5000;
  const LIMIT = 5;

  // ── Format spam check (newlines / repeated characters) ──────────────────
  if (isFormatSpam(message.content)) {
    await message.delete().catch(() => {});
    await message.channel.send(`<@${userId}> no spamming`).catch(() => {});
    return true;
  }

  // ── Rapid-fire spam check ────────────────────────────────────────────────
  if (!spamTracker.has(userId)) spamTracker.set(userId, []);
  const timestamps = spamTracker.get(userId);
  timestamps.push({ time: now, messageId: message.id });
  const recent = timestamps.filter(t => now - t.time < WINDOW);
  spamTracker.set(userId, recent);

  if (recent.length >= LIMIT) {
    try {
      const fetched = await message.channel.messages.fetch({ limit: 20 });
      const toDelete = fetched.filter(m =>
        m.author.id === userId &&
        Date.now() - m.createdTimestamp < WINDOW + 1000
      );
      await message.channel.bulkDelete(toDelete, true).catch(() => {});
    } catch (e) {
      console.error('Failed to delete spam messages:', e);
    }

    spamTracker.set(userId, []);
    await message.channel.send(`<@${userId}> no spamming`).catch(() => {});
    return true;
  }

  return false;
}

// ─── Invite Link Filter ───────────────────────────────────────────────────────

function containsInviteLink(content) {
  const lower = content.toLowerCase();
  return (
    lower.includes('discord.gg') ||
    lower.includes('discord.com/inv') ||
    lower.includes('discordapp.')
  );
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

  // Ignore messages in the data channel
  if (message.channel.id === DATA_CHANNEL_ID) return;

  // Invite link filter
  if (containsInviteLink(message.content)) {
    await message.delete().catch(() => {});
    return;
  }

  // Anti-spam (includes format spam check)
  const wasSpam = await handleAntiSpam(message);
  if (wasSpam) return;

  // X link watcher
  const xLinkRegex = /https?:\/\/(?:twitter\.com|x\.com)\/\w+\/status\/\d+[^\s]*/gi;
  const xLinks = message.content.match(xLinkRegex);
  if (xLinks) {
    for (const link of xLinks) {
      await checkXLink(message, link);
    }
  }

  // Reddit link watcher
  const redditLinkRegex = /https?:\/\/(?:www\.)?reddit\.com\/(?:r\/[^/\s]+\/)?comments\/[a-z0-9]+[^\s]*/gi;
  const redditLinks = message.content.match(redditLinkRegex);
  if (redditLinks) {
    for (const link of redditLinks) {
      await checkRedditLink(message, link);
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

client.once('ready', async () => {
  console.log(`✅ Bot is online as ${client.user.tag}`);
  await loadDataFromChannel();
  console.log(`Watching X posts for: "${X_WATCH.TARGET_TEXT}"`);
  console.log(`Watching Reddit posts for: "${REDDIT_WATCH.TARGET_TEXT}" (field: ${REDDIT_WATCH.MATCH_FIELD})`);
});

client.login(process.env.DISCORD_TOKEN);
