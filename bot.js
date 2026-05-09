const { Client, GatewayIntentBits, PermissionsBitField, ChannelType, EmbedBuilder } = require('discord.js');
const https = require('https');
const { execSync, spawn } = require('child_process');
const path = require('path');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessageReactions,
  ],
});

// ─── State ────────────────────────────────────────────────────────────────────

const everyonePingIntervals = new Map();
const userPingIntervals = new Map();
const pingJoinChannels = new Map();
const spamTracker = new Map();

// Reaction roles: { messageId -> { emoji -> roleName } }
const reactionRoles = new Map();

// Update subscriptions
let updateSubMessage = null;
const updateSubscribers = new Set();

// Post counts cache
const postCounts = new Map();

// Seen links
const seenXLinks = new Set();
const seenRedditLinks = new Set();

// Data channel
const DATA_CHANNEL_ID = '1497467308010901525';

// X Auto Poster config
const XPOSTER_PATH = path.join(__dirname, '..', 'xposter');

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
  MATCH_FIELD: 'both',
  TARGET_TEXT: 'hey @grok remove the red things😋',
  REPLY_PREFIX: 'good',
  POSTS_REQUIRED: 3,
  REWARD_ROLE: 'payed sorry',
  ALREADY_DONE_REPLY: 'thanks',
  WRONG_REPLY: 'wrong post',
  GUIDE_CHANNEL_ID: '1498948285581365353',
};

// ─── Data Channel Storage ─────────────────────────────────────────────────────

let dataChannel = null;
const dataMessages = new Map();
const reactionRoleMessages = new Map();
let updateSubMsgHandle = null;
const updateSubUserHandles = new Map();

async function loadDataFromChannel() {
  try {
    dataChannel = await client.channels.fetch(DATA_CHANNEL_ID);
    if (!dataChannel) {
      console.error('Data channel not found!');
      return;
    }

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
      if (msg.content.startsWith('COUNT:')) {
        const parts = msg.content.split(':');
        if (parts.length !== 3) continue;
        const userId = parts[1];
        const count = parseInt(parts[2]);
        if (isNaN(count)) continue;
        postCounts.set(userId, count);
        dataMessages.set(userId, msg);
      }

      if (msg.content.startsWith('XLINK:')) {
        const tweetId = msg.content.slice(6).trim();
        if (tweetId) seenXLinks.add(tweetId);
      }

      if (msg.content.startsWith('RLINK:')) {
        const postId = msg.content.slice(6).trim();
        if (postId) seenRedditLinks.add(postId);
      }

      if (msg.content.startsWith('RROLE|')) {
        const parts = msg.content.slice(6).split('|');
        if (parts.length !== 3) continue;
        const [msgId, emojiKey, roleId] = parts;
        if (!reactionRoles.has(msgId)) reactionRoles.set(msgId, {});
        reactionRoles.get(msgId)[emojiKey] = roleId;
        reactionRoleMessages.set(msgId + '|' + emojiKey, msg);
      }

      if (msg.content.startsWith('UPMSG:')) {
        const parts = msg.content.split(':');
        if (parts.length >= 5) {
          const [, messageId, channelId, guildId, ...emojiParts] = parts;
          const emojiKey = emojiParts.join(':');
          updateSubMessage = { messageId, channelId, guildId, emojiKey };
          updateSubMsgHandle = msg;
        }
      }

      if (msg.content.startsWith('UPSUB:')) {
        const userId = msg.content.slice(6).trim();
        if (userId) {
          updateSubscribers.add(userId);
          updateSubUserHandles.set(userId, msg);
        }
      }
    }

    console.log(
      `Loaded ${postCounts.size} user counts, ${seenXLinks.size} seen X links, ` +
      `${seenRedditLinks.size} seen Reddit links, ${reactionRoles.size} reaction role messages, ` +
      `${updateSubscribers.size} update subscribers.`
    );
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

async function saveSeenLink(tweetId) {
  try {
    if (!dataChannel) return;
    seenXLinks.add(tweetId);
    await dataChannel.send(`XLINK:${tweetId}`);
  } catch (e) {
    console.error('Failed to save seen link:', e);
  }
}

async function saveSeenRedditLink(postId) {
  try {
    if (!dataChannel) return;
    seenRedditLinks.add(postId);
    await dataChannel.send(`RLINK:${postId}`);
  } catch (e) {
    console.error('Failed to save seen Reddit link:', e);
  }
}

async function saveReactionRole(msgId, emojiKey, roleId) {
  try {
    if (!dataChannel) return;
    const key = msgId + '|' + emojiKey;
    const content = 'RROLE|' + msgId + '|' + emojiKey + '|' + roleId;
    if (reactionRoleMessages.has(key)) {
      const msg = reactionRoleMessages.get(key);
      const updated = await msg.edit(content);
      reactionRoleMessages.set(key, updated);
    } else {
      const newMsg = await dataChannel.send(content);
      reactionRoleMessages.set(key, newMsg);
    }
  } catch (e) {
    console.error('Failed to save reaction role:', e);
  }
}

async function saveUpdateSubMessage(messageId, channelId, guildId, emojiKey) {
  try {
    if (!dataChannel) return;
    const content = `UPMSG:${messageId}:${channelId}:${guildId}:${emojiKey}`;
    if (updateSubMsgHandle) {
      const updated = await updateSubMsgHandle.edit(content);
      updateSubMsgHandle = updated;
    } else {
      updateSubMsgHandle = await dataChannel.send(content);
    }
  } catch (e) {
    console.error('Failed to save update sub message:', e);
  }
}

async function addUpdateSubscriber(userId) {
  try {
    if (updateSubscribers.has(userId)) return;
    updateSubscribers.add(userId);
    if (!dataChannel) return;
    const content = `UPSUB:${userId}`;
    const newMsg = await dataChannel.send(content);
    updateSubUserHandles.set(userId, newMsg);
  } catch (e) {
    console.error('Failed to add update subscriber:', e);
  }
}

async function removeUpdateSubscriber(userId) {
  try {
    if (!updateSubscribers.has(userId)) return;
    updateSubscribers.delete(userId);
    if (updateSubUserHandles.has(userId)) {
      await updateSubUserHandles.get(userId).delete().catch(() => {});
      updateSubUserHandles.delete(userId);
    }
  } catch (e) {
    console.error('Failed to remove update subscriber:', e);
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
  if (ms >= 86400000) return `${(ms / 86400000).toFixed(1)}d`;
  if (ms >= 3600000) return `${(ms / 3600000).toFixed(1)}h`;
  if (ms >= 60000) return `${(ms / 60000).toFixed(1)}m`;
  return `${(ms / 1000).toFixed(1)}s`;
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
      if (nameIdx < name.length) {
        score++;
        nameIdx++;
      }
    }
    if (name.startsWith(q)) score += 5;
    if (name.includes(q)) score += 3;
    if (score > bestScore) {
      bestScore = score;
      bestMatch = channel;
    }
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

function fetchRedditURL(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'User-Agent': 'discord-bot:post-verifier:v1.0 (by /u/FlimsyBadger3576)',
        'Accept': 'application/json'
      }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchRedditURL(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode === 429) {
        return reject(new Error('Reddit rate limited (429)'));
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`Reddit returned status ${res.statusCode}`));
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

function isFormatSpam(content) {
  const newlineCount = (content.match(/\n/g) || []).length;
  if (newlineCount > 3) return true;
  if (/(.)\1{48,}/.test(content)) return true;
  return false;
}

async function checkXLink(message, url) {
  try {
    const tweetId = extractTweetId(url);
    if (!tweetId) return;

    const userId = message.author.id;
    const currentCount = postCounts.get(userId) || 0;

    if (seenXLinks.has(tweetId)) {
      return message.reply(`sent already\ncurrent post count: ${currentCount}/${X_WATCH.POSTS_REQUIRED}`).then(r => deleteAfter(r, LINK_DELETE_MS));
    }

    const apiUrl = `https://api.fxtwitter.com/status/${tweetId}`;
    const raw = await fetchURL(apiUrl);

    let json;
    try {
      json = JSON.parse(raw);
    } catch {
      console.error('fxtwitter returned non-JSON:', raw.slice(0, 200));
      return;
    }

    const tweetText = json?.tweet?.text;
    if (!tweetText) {
      console.error('No tweet text in fxtwitter response:', JSON.stringify(json).slice(0, 200));
      return;
    }

    const tweetClean = tweetText.trim().toLowerCase().replace(/https?:\/\//g, '');
    const targetClean = X_WATCH.TARGET_TEXT.trim().toLowerCase().replace(/https?:\/\//g, '');

    if (dataChannel) {
      await dataChannel.send(
        `[X DEBUG] user: <@${userId}>\n` +
        `got:    "${tweetText}"\n` +
        `target: "${X_WATCH.TARGET_TEXT}"\n` +
        `match:  ${tweetClean === targetClean}`
      ).catch(() => {});
    }

    if (tweetClean === targetClean || tweetClean.includes(targetClean)) {
      const member = await message.guild.members.fetch(userId).catch(() => null);
      const hasRole = member?.roles.cache.some(r => r.name.toLowerCase() === X_WATCH.REWARD_ROLE.toLowerCase());

      if (hasRole) {
        await saveSeenLink(tweetId);
        return message.reply(X_WATCH.ALREADY_DONE_REPLY).then(r => deleteAfter(r, LINK_DELETE_MS));
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
        return message.reply(`${X_WATCH.REPLY_PREFIX}, ${newCount}/${X_WATCH.POSTS_REQUIRED} posts — role given!`).then(r => deleteAfter(r, LINK_DELETE_MS));
      } else {
        return message.reply(`${X_WATCH.REPLY_PREFIX}, ${newCount}/${X_WATCH.POSTS_REQUIRED} posts`).then(r => deleteAfter(r, LINK_DELETE_MS));
      }

    } else {
      await saveSeenLink(tweetId);
      await message.reply(`${X_WATCH.WRONG_REPLY}\npost exactly what is in <#${X_WATCH.GUIDE_CHANNEL_ID}>`).then(r => deleteAfter(r, LINK_DELETE_MS));
    }

  } catch (e) {
    console.error('Failed to check X link:', e);
  }
}

function extractRedditPostId(url) {
  const match = url.match(/reddit\.com\/(?:r\/[^/]+\/)?comments\/([a-z0-9]+)/i);
  return match ? match[1] : null;
}

async function checkRedditLink(message, url) {
  try {
    const postId = extractRedditPostId(url);
    if (!postId) {
      return message.reply(`${REDDIT_WATCH.WRONG_REPLY}\npost exactly what is in <#${REDDIT_WATCH.GUIDE_CHANNEL_ID}>`).then(r => deleteAfter(r, LINK_DELETE_MS));
    }

    const userId = message.author.id;
    const currentCount = postCounts.get(userId) || 0;

    if (seenRedditLinks.has(postId)) {
      return message.reply(`sent already\ncurrent post count: ${currentCount}/${REDDIT_WATCH.POSTS_REQUIRED}`).then(r => deleteAfter(r, LINK_DELETE_MS));
    }

    const jsonUrl = `https://www.reddit.com/comments/${postId}.json`;
    let raw;
    try {
      raw = await fetchRedditURL(jsonUrl);
    } catch (e) {
      console.error('Failed to fetch Reddit post:', e);
      raw = null;
    }

    let postData = null;
    if (raw) {
      let json;
      try {
        json = JSON.parse(raw);
      } catch {
        json = null;
      }
      postData = json?.[0]?.data?.children?.[0]?.data || null;
    }

    if (!postData) {
      console.error('Could not read Reddit post data, counting anyway');
      const member2 = await message.guild.members.fetch(userId).catch(() => null);
      const hasRole2 = member2?.roles.cache.some(r => r.name.toLowerCase() === REDDIT_WATCH.REWARD_ROLE.toLowerCase());
      if (hasRole2) {
        await saveSeenRedditLink(postId);
        return message.reply(REDDIT_WATCH.ALREADY_DONE_REPLY).then(r => deleteAfter(r, LINK_DELETE_MS));
      }
      await saveSeenRedditLink(postId);
      const newCount2 = currentCount + 1;
      postCounts.set(userId, newCount2);
      await saveUserCount(userId, newCount2);
      if (newCount2 >= REDDIT_WATCH.POSTS_REQUIRED) {
        const role2 = message.guild.roles.cache.find(r => r.name.toLowerCase() === REDDIT_WATCH.REWARD_ROLE.toLowerCase());
        if (role2 && member2) await member2.roles.add(role2).catch(() => {});
        return message.reply(`${REDDIT_WATCH.REPLY_PREFIX}, ${newCount2}/${REDDIT_WATCH.POSTS_REQUIRED} posts — role given!`).then(r => deleteAfter(r, LINK_DELETE_MS));
      }
      return message.reply(`${REDDIT_WATCH.REPLY_PREFIX}, ${newCount2}/${REDDIT_WATCH.POSTS_REQUIRED} posts`).then(r => deleteAfter(r, LINK_DELETE_MS));
    }

    const postTitle = (postData.title || '').trim().toLowerCase();
    const postSelftext = (postData.selftext || '').trim().toLowerCase();
    const targetClean = REDDIT_WATCH.TARGET_TEXT.trim().toLowerCase();

    const titleMatch = postTitle.includes(targetClean) || postTitle === targetClean;
    const selftextMatch = postSelftext.includes(targetClean) || postSelftext === targetClean;
    const canRead = postTitle.length > 0 || postSelftext.length > 0;

    if (canRead && !titleMatch && !selftextMatch) {
      await saveSeenRedditLink(postId);
      return message.reply(`${REDDIT_WATCH.WRONG_REPLY}\npost exactly what is in <#${REDDIT_WATCH.GUIDE_CHANNEL_ID}>`).then(r => deleteAfter(r, LINK_DELETE_MS));
    }

    const member = await message.guild.members.fetch(userId).catch(() => null);
    const hasRole = member?.roles.cache.some(r => r.name.toLowerCase() === REDDIT_WATCH.REWARD_ROLE.toLowerCase());

    if (hasRole) {
      await saveSeenRedditLink(postId);
      return message.reply(REDDIT_WATCH.ALREADY_DONE_REPLY).then(r => deleteAfter(r, LINK_DELETE_MS));
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
      return message.reply(`${REDDIT_WATCH.REPLY_PREFIX}, ${newCount}/${REDDIT_WATCH.POSTS_REQUIRED} posts — role given!`).then(r => deleteAfter(r, LINK_DELETE_MS));
    } else {
      return message.reply(`${REDDIT_WATCH.REPLY_PREFIX}, ${newCount}/${REDDIT_WATCH.POSTS_REQUIRED} posts`).then(r => deleteAfter(r, LINK_DELETE_MS));
    }

  } catch (e) {
    console.error('Failed to check Reddit link:', e);
  }
}

const pingWarnTracker = new Map();

async function handleAntiSpam(message) {
  const userId = message.author.id;
  const now = Date.now();
  const WINDOW = 5000;
  const LIMIT = 5;

  if (isFormatSpam(message.content)) {
    await message.delete().catch(() => {});
    const warn = await message.channel.send(`<@${userId}> no spamming`).catch(() => null);
    if (warn) setTimeout(() => warn.delete().catch(() => {}), 4000);
    return true;
  }

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

    const PING_WINDOW = 20000;
    const PING_LIMIT = 3;
    if (!pingWarnTracker.has(userId)) pingWarnTracker.set(userId, []);
    const pings = pingWarnTracker.get(userId);
    pings.push(now);
    const recentPings = pings.filter(t => now - t < PING_WINDOW);
    pingWarnTracker.set(userId, recentPings);

    if (recentPings.length >= PING_LIMIT) {
      pingWarnTracker.set(userId, []);
      try {
        const member = await message.guild.members.fetch(userId).catch(() => null);
        if (member) {
          await member.timeout(60 * 1000, 'Repeated spamming').catch(e => console.error('Failed to timeout:', e));
        }
      } catch (e) {
        console.error('Timeout error:', e);
      }
    }

    const warn = await message.channel.send(`<@${userId}> no spamming`).catch(() => null);
    if (warn) setTimeout(() => warn.delete().catch(() => {}), 4000);
    return true;
  }

  return false;
}

function containsInviteLink(content) {
  const lower = content.toLowerCase();
  return (
    lower.includes('discord.gg/') ||
    lower.includes('discord.com/invite/') ||
    lower.includes('discordapp.com')
  );
}

const PREFIX = '!';
const LINK_DELETE_MS = 2 * 60 * 1000;

function deleteAfter(msg, ms) {
  setTimeout(() => msg.delete().catch(() => {}), ms);
}

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

// ─── Channel Create → Post in Updates Channel ────────────────────────────────

const UPDATES_CHANNEL_ID = '1500588941034655955';

client.on('channelCreate', async (channel) => {
  if (!channel.guild) return;

  try {
    const updatesChannel = await client.channels.fetch(UPDATES_CHANNEL_ID).catch(() => null);
    if (!updatesChannel) return;

    const isText = channel.type === ChannelType.GuildText;
    const channelRef = isText ? `<#${channel.id}>` : `**${channel.name}**`;

    const embed = new EmbedBuilder()
      .setColor(0xFF69B4)
      .setDescription(
        `✦ new channel added\n` +
        `${channelRef}\n` +
        `∙ ${channel.guild.name}`
      );

    await updatesChannel.send({ embeds: [embed] });
  } catch (e) {
    console.error('Failed to post channel update:', e);
  }
});

// ─── Message Handler ──────────────────────────────────────────────────────────

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  if (message.channel.id === DATA_CHANNEL_ID) return;

  const isAdmin = message.member?.permissions.has(PermissionsBitField.Flags.Administrator);

  if (!isAdmin && containsInviteLink(message.content)) {
    await message.delete().catch(() => {});
    return;
  }

  const wasSpam = !isAdmin && await handleAntiSpam(message);
  if (wasSpam) return;

  const LINK_CHANNEL_ID = '1498957410906406942';
  const anyLinkRegex = /https?:\/\//i;
  if (!isAdmin && message.channel.id === LINK_CHANNEL_ID && anyLinkRegex.test(message.content)) {
    deleteAfter(message, LINK_DELETE_MS);
  }

  const xLinkRegex = /https?:\/\/(?:twitter\.com|x\.com)\/\w+\/status\/\d+[^\s]*/gi;
  const xLinks = message.content.match(xLinkRegex);
  if (xLinks) {
    for (const link of xLinks) {
      await checkXLink(message, link);
    }
  }

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

  // ── !xpost ────────────────────────────────────────────────────────────────
  // ── !xpost ────────────────────────────────────────────────────────────────
if (command === 'xpost') {
  if (!requireAdmin(message)) {
    return message.reply('❌ You need Administrator permission to use this command.');
  }

  const postCount = parseInt(args[0]);
  const delayStr = args[1];

  if (!postCount || postCount < 1) {
    return message.reply('Usage: `!xpost <number> <delay>` — e.g. `!xpost 3 5s`');
  }

  const delayMs = parseCooldown(delayStr);
  if (!delayMs) {
    return message.reply('❌ Invalid delay. Use like: 5s, 1m, 2h');
  }

  const statusMsg = await message.reply(
    `⏳ Starting ${postCount} posts with ${formatCooldown(delayMs)} delay...`
  );

  try {
    const XPOSTER_DIR = path.resolve(__dirname, '..', 'xposter');
    const SCRIPT_PATH = path.join(XPOSTER_DIR, 'xposter.mjs');

    console.log('[xposter] dir:', XPOSTER_DIR);
    console.log('[xposter] script:', SCRIPT_PATH);

    const child = spawn(process.execPath, [SCRIPT_PATH], {
      cwd: XPOSTER_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        POST_COUNT: String(postCount),
        POST_DELAY_MS: String(delayMs),
      },
    });

    let output = '';

    child.stdout.on('data', (data) => {
      const text = data.toString();
      output += text;
      console.log('[xposter]', text.trim());
    });

    child.stderr.on('data', (data) => {
      const text = data.toString();
      output += text;
      console.error('[xposter error]', text.trim());
    });

    child.on('error', async (err) => {
      console.error('[xposter spawn error]', err);
      await statusMsg.edit('❌ Failed to start xposter process.');
    });

    child.on('close', async (code) => {
      const lastOutput = output.trim().split('\n').slice(-5).join('\n');

      if (code === 0) {
        await statusMsg.edit(
          `✅ Posted ${postCount} times!\n\`\`\`\n${lastOutput || 'No output'}\n\`\`\``
        );
      } else {
        await statusMsg.edit(
          `❌ Xposter crashed (code ${code})\n\`\`\`\n${lastOutput || 'No output'}\n\`\`\``
        );
      }
    });

  } catch (e) {
    console.error('[xpost fatal error]', e);
    await statusMsg.edit(`❌ Error: ${e.message}`);
  }

  return;
}

  // ── !disable ──────────────────────────────────────────────────────────────
  if (command === 'disable') {
    if (!requireAdmin(message)) return message.reply('❌ You need Administrator permission to use this command.');
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
    if (stopped === 0) return message.reply('ℹ️ No active auto-pings to stop.');
    return message.reply(`✅ Stopped **${stopped}** active auto-ping${stopped !== 1 ? 's' : ''}.`);
  }

  // ── !pingjoin ─────────────────────────────────────────────────────────────
  if (command === 'pingjoin') {
    if (!requireAdmin(message)) return message.reply('❌ You need Administrator permission to use this command.');
    const sub = args[0]?.toLowerCase();
    if (sub === 'enable') {
      pingJoinChannels.set(message.guild.id, message.channel.id);
      return message.reply(`✅ Join pings **enabled** in this channel.`);
    }
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
      const interval = setInterval(async () => {
        try {
          const p = await message.channel.send('@everyone');
          p.delete().catch(() => {});
        } catch (e) {
          console.error(e);
        }
      }, cooldownMs);
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
      try {
        targetUser = await message.guild.members.fetch(userId);
      } catch {
        return message.reply('❌ Could not find that user.');
      }
      const cooldownMs = parseCooldown(cooldownStr);
      if (!cooldownMs) return message.reply('❌ Invalid cooldown.');
      if (userPingIntervals.has(message.channel.id)) clearInterval(userPingIntervals.get(message.channel.id).interval);
      const interval = setInterval(async () => {
        try {
          const ping = await message.channel.send(`<@${userId}>`);
          setTimeout(() => ping.delete().catch(() => {}), 500);
        } catch (e) {
          console.error(e);
        }
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

  // ── !kick ─────────────────────────────────────────────────────────────────
  if (command === 'kick') {
    if (!requireAdmin(message)) return message.reply('❌ You need Administrator permission to use this command.');
    if (!message.guild.members.me.permissions.has(PermissionsBitField.Flags.KickMembers)) return message.reply('❌ I need Kick Members permission.');

    const userMention = args[0];
    if (!userMention) return message.reply('Usage: `!kick @user [reason]`');

    const userId = userMention.replace(/[<@!>]/g, '');
    const reason = args.slice(1).join(' ') || 'No reason provided';

    let member;
    try {
      member = await message.guild.members.fetch(userId);
    } catch {
      return message.reply('❌ Could not find that user.');
    }

    if (!member.kickable) return message.reply('❌ I cannot kick this user. They may have a higher role than me.');

    try {
      await member.kick(reason);
      return message.reply(`✅ **${member.user.tag}** has been kicked. Reason: ${reason}`);
    } catch (e) {
      console.error('Failed to kick member:', e);
      return message.reply('❌ Failed to kick that user.');
    }
  }

  // ── !ban ──────────────────────────────────────────────────────────────────
  if (command === 'ban') {
    if (!requireAdmin(message)) return message.reply('❌ You need Administrator permission to use this command.');
    if (!message.guild.members.me.permissions.has(PermissionsBitField.Flags.BanMembers)) return message.reply('❌ I need Ban Members permission.');

    const userMention = args[0];
    if (!userMention) return message.reply('Usage: `!ban @user [reason]`');

    const userId = userMention.replace(/[<@!>]/g, '');
    const reason = args.slice(1).join(' ') || 'No reason provided';

    let member;
    try {
      member = await message.guild.members.fetch(userId);
    } catch {
      return message.reply('❌ Could not find that user.');
    }

    if (!member.bannable) return message.reply('❌ I cannot ban this user. They may have a higher role than me.');

    try {
      await member.ban({ reason, deleteMessageSeconds: 0 });
      return message.reply(`✅ **${member.user.tag}** has been banned. Reason: ${reason}`);
    } catch (e) {
      console.error('Failed to ban member:', e);
      return message.reply('❌ Failed to ban that user.');
    }
  }

  // ── !fm ───────────────────────────────────────────────────────────────────
  if (command === 'fm') {
    if (!requireAdmin(message)) return message.reply('❌ You need Administrator permission to use this command.');

    const embed = new EmbedBuilder()
      .setColor(0xFFB6C1)
      .setDescription(
        `∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿\n` +
        `\n` +
        `✦ **pay for rewards** ✦\n` +
        `\n` +
        `i select requests randomly, ideally every 3 days or more frequently depending on how i feel. i use a bot command to pick 3 messages from the requests channel — those get added to the server.\n` +
        `\n` +
        `∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿\n` +
        `\n` +
        `✦ **how to pay** ✦\n` +
        `\n` +
        `⌒ 175 robux\n` +
        `⌒ $3 venmo\n` +
        `⌒ server boost\n` +
        `⌒ nitro gift\n` +
        `\n` +
        `paying gives you a higher chance of being selected — you won't always be picked, but you'll come up much more often than standard users.\n` +
        `\n` +
        `∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿\n` +
        `\n` +
        `✦ **free options** ✦\n` +
        `\n` +
        `⌒ post on x using the exact text and image provided in <#1498948285581365353>\n` +
        `⌒ copy the post link and send it to <#1498957410906406942> — the bot verifies it automatically\n` +
        `⌒ you must post 3 times. you can post all 3 right away\n` +
        `\n` +
        `⌒ reddit support coming soon\n` +
        `\n` +
        `→ dm to buy\n` +
        `\n` +
        `∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿`
      );

    await message.channel.send({ embeds: [embed] });
    await message.delete().catch(() => {});
    return;
  }

  // ── !post ─────────────────────────────────────────────────────────────────
  if (command === 'post') {
    if (!requireAdmin(message)) return message.reply('❌ You need Administrator permission to use this command.');
    const text = args.join(' ');
    if (!text) return message.reply('Usage: `!post <text>` — sets the target text for both X and Reddit verification.');
    X_WATCH.TARGET_TEXT = text;
    REDDIT_WATCH.TARGET_TEXT = text;
    return message.reply(`✅ Target text updated to: **${text}**`);
  }

  // ── !rr ───────────────────────────────────────────────────────────────────
  if (command === 'rr') {
    if (!requireAdmin(message)) return message.reply('❌ You need Administrator permission to use this command.');

    const msgId = args[0];
    const emojiRaw = args[1];
    const roleName = args.slice(2).join(' ');

    if (!msgId || !emojiRaw || !roleName) {
      return message.reply('Usage: `!rr <message id> <emoji> <role name>`');
    }

    const emojiClean = emojiRaw.replace(/:/g, '');
    const role = message.guild.roles.cache.find(r => r.name.toLowerCase() === roleName.toLowerCase());
    if (!role) return message.reply(`❌ Could not find a role named "${roleName}".`);

    let targetMsg;
    try {
      targetMsg = await message.channel.messages.fetch(msgId);
    } catch {
      return message.reply('❌ Could not find that message in this channel.');
    }

    let reactedEmoji;
    try {
      const reaction = await targetMsg.react(emojiClean);
      reactedEmoji = reaction.emoji;
    } catch {
      return message.reply(`❌ Could not react with that emoji. Make sure it's a valid emoji the bot can use.`);
    }

    const emojiKey = reactedEmoji.id
      ? `${reactedEmoji.name}:${reactedEmoji.id}`
      : reactedEmoji.name;

    if (!reactionRoles.has(msgId)) reactionRoles.set(msgId, {});
    reactionRoles.get(msgId)[emojiKey] = role.id;

    await saveReactionRole(msgId, emojiKey, role.id);

    return message.reply(`✅ Reaction role set! Users who react with ${emojiRaw} on that message will get the **${roleName}** role.`);
  }

  // ── !updateset ────────────────────────────────────────────────────────────
  if (command === 'updateset') {
    if (!requireAdmin(message)) return message.reply('❌ You need Administrator permission to use this command.');

    const embed = new EmbedBuilder()
      .setColor(0xFF69B4)
      .setDescription(
        `꩜ ────────────────── ꩜\n` +
        `\n` +
        `🤡  **server updates**\n` +
        `\n` +
        `react below to receive a dm whenever\n` +
        `a new channel is added to the server\n` +
        `\n` +
        `✦ make sure your dms are open ✦\n` +
        `\n` +
        `unreact at any time to opt out\n` +
        `\n` +
        `꩜ ────────────────── ꩜`
      );

    await message.delete().catch(() => {});

    const sent = await message.channel.send({ embeds: [embed] });

    const CLOWN = '🤡';
    let reactedEmoji;
    try {
      const reaction = await sent.react(CLOWN);
      reactedEmoji = reaction.emoji;
    } catch (e) {
      console.error('Failed to react with clown emoji:', e);
      return;
    }

    const emojiKey = reactedEmoji.id
      ? `${reactedEmoji.name}:${reactedEmoji.id}`
      : reactedEmoji.name;

    updateSubMessage = {
      messageId: sent.id,
      channelId: message.channel.id,
      guildId: message.guild.id,
      emojiKey,
    };

    await saveUpdateSubMessage(sent.id, message.channel.id, message.guild.id, emojiKey);

    return;
  }
});

// ─── Ready ────────────────────────────────────────────────────────────────────

client.once('ready', async () => {
  console.log(`✅ Bot is online as ${client.user.tag}`);
  await loadDataFromChannel();
  console.log(`Watching X posts for: "${X_WATCH.TARGET_TEXT}"`);
  console.log(`Watching Reddit posts for: "${REDDIT_WATCH.TARGET_TEXT}" (field: ${REDDIT_WATCH.MATCH_FIELD})`);
  if (updateSubMessage) {
    console.log(`Update sub message loaded: ${updateSubMessage.messageId} | emoji: ${updateSubMessage.emojiKey} | subscribers: ${updateSubscribers.size}`);
  }
});

// ─── Reaction Role + Update Sub Listeners ────────────────────────────────────

client.on('messageReactionAdd', async (reaction, user) => {
  if (user.bot) return;

  const dbg = (msg) => dataChannel?.send(`[RR DEBUG] ${msg}`).catch(() => {});

  if (reaction.partial) {
    try {
      await reaction.fetch();
    } catch (e) {
      dbg(`Failed to fetch partial reaction: ${e}`);
      return;
    }
  }

  const msgId = reaction.message.id;

  if (updateSubMessage && msgId === updateSubMessage.messageId) {
    const emojiKey = reaction.emoji.id
      ? `${reaction.emoji.name}:${reaction.emoji.id}`
      : reaction.emoji.name;

    if (emojiKey === updateSubMessage.emojiKey || reaction.emoji.name === updateSubMessage.emojiKey) {
      await addUpdateSubscriber(user.id);
    }
    return;
  }

  dbg(`Reaction on msg ${msgId} | emoji name: ${reaction.emoji.name} | emoji id: ${reaction.emoji.id} | known messages: ${[...reactionRoles.keys()].join(', ') || 'none'}`);

  if (!reactionRoles.has(msgId)) {
    dbg(`No mapping found for message ${msgId}`);
    return;
  }

  const emojiKey = reaction.emoji.id
    ? `${reaction.emoji.name}:${reaction.emoji.id}`
    : reaction.emoji.name;

  const mapping = reactionRoles.get(msgId);
  dbg(`Emoji key: "${emojiKey}" | mapping keys: ${Object.keys(mapping).join(', ')}`);

  const roleId = mapping[emojiKey] || mapping[reaction.emoji.name];
  if (!roleId) {
    dbg(`No role found for emoji key "${emojiKey}"`);
    return;
  }

  dbg(`Found role ID: ${roleId} — attempting to add to user ${user.id}`);

  try {
    const guild = reaction.message.guild;
    const member = await guild.members.fetch(user.id).catch(() => null);
    if (!member) {
      dbg(`Could not fetch member ${user.id}`);
      return;
    }
    await member.roles.add(roleId)
      .then(() => dbg(`Successfully added role ${roleId} to ${user.id}`))
      .catch(e => dbg(`Failed to add role: ${e}`));
  } catch (e) {
    dbg(`Reaction role add error: ${e}`);
  }
});

client.on('messageReactionRemove', async (reaction, user) => {
  if (user.bot) return;

  if (reaction.partial) {
    try {
      await reaction.fetch();
    } catch {
      return;
    }
  }

  const msgId = reaction.message.id;

  if (updateSubMessage && msgId === updateSubMessage.messageId) {
    const emojiKey = reaction.emoji.id
      ? `${reaction.emoji.name}:${reaction.emoji.id}`
      : reaction.emoji.name;

    if (emojiKey === updateSubMessage.emojiKey || reaction.emoji.name === updateSubMessage.emojiKey) {
      await removeUpdateSubscriber(user.id);
    }
    return;
  }

  if (!reactionRoles.has(msgId)) return;

  const emojiKey = reaction.emoji.id
    ? `${reaction.emoji.name}:${reaction.emoji.id}`
    : reaction.emoji.name;

  const mapping = reactionRoles.get(msgId);
  const roleId = mapping[emojiKey] || mapping[reaction.emoji.name];
  if (!roleId) return;

  try {
    const guild = reaction.message.guild;
    const member = await guild.members.fetch(user.id).catch(() => null);
    if (member) await member.roles.remove(roleId).catch(e => console.error('Failed to remove reaction role:', e));
  } catch (e) {
    console.error('Reaction role remove error:', e);
  }
});

client.login(process.env.DISCORD_TOKEN);
