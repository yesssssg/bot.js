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

// ─── Constants ────────────────────────────────────────────────────────────────

const PREFIX = '!';
const AUTO_DELETE_MS = 30 * 1000; // 30 seconds for ALL bot messages and command messages
const LINK_DELETE_MS = 2 * 60 * 1000;

// ─── Auto-delete helpers ──────────────────────────────────────────────────────

function deleteAfter(msg, ms = AUTO_DELETE_MS) {
  if (!msg) return;
  setTimeout(() => msg.delete().catch(() => {}), ms);
}

function deleteCommand(message) {
  deleteAfter(message, AUTO_DELETE_MS);
}

// Wraps message.reply() and auto-deletes both the reply and the command
async function reply(message, content, deleteCmd = true) {
  const r = await message.reply(content).catch(() => null);
  if (r) deleteAfter(r);
  if (deleteCmd) deleteCommand(message);
  return r;
}

// ─── State ────────────────────────────────────────────────────────────────────

const everyonePingIntervals = new Map();
const userPingIntervals = new Map();
const pingJoinChannels = new Map();
const spamTracker = new Map();

// Reaction roles: { messageId -> { emoji -> roleId } }
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

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// AUTO BYPASS CONFIG
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const BYPASS_DOMAINS = [
  'speedy-links.com',
  'linkvertise.com',
  'link-center.net',
  'loot-link.com',
  'lootlinks.co',
  'lootlinks.com',
  'sub2unlock.com',
  'sub2get.com',
  'social-unlock.com',
  'rekonise.com',
  'socialwolvez.com',
  'boostink.com',
  'boost.ink',
  'flux.li',
  'fluxus.pw',
  'get-rblx.com',
  'krnl.ca',
  'pastebin.com/raw',
];

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
  } catch (e) { console.error('Failed to save user count:', e); }
}

async function saveSeenLink(tweetId) {
  try {
    if (!dataChannel) return;
    seenXLinks.add(tweetId);
    await dataChannel.send(`XLINK:${tweetId}`);
  } catch (e) { console.error('Failed to save seen link:', e); }
}

async function saveSeenRedditLink(postId) {
  try {
    if (!dataChannel) return;
    seenRedditLinks.add(postId);
    await dataChannel.send(`RLINK:${postId}`);
  } catch (e) { console.error('Failed to save seen Reddit link:', e); }
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
  } catch (e) { console.error('Failed to save reaction role:', e); }
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
  } catch (e) { console.error('Failed to save update sub message:', e); }
}

async function addUpdateSubscriber(userId) {
  try {
    if (updateSubscribers.has(userId)) return;
    updateSubscribers.add(userId);
    if (!dataChannel) return;
    const newMsg = await dataChannel.send(`UPSUB:${userId}`);
    updateSubUserHandles.set(userId, newMsg);
  } catch (e) { console.error('Failed to add update subscriber:', e); }
}

async function removeUpdateSubscriber(userId) {
  try {
    if (!updateSubscribers.has(userId)) return;
    updateSubscribers.delete(userId);
    if (updateSubUserHandles.has(userId)) {
      await updateSubUserHandles.get(userId).delete().catch(() => {});
      updateSubUserHandles.delete(userId);
    }
  } catch (e) { console.error('Failed to remove update subscriber:', e); }
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
      if (res.statusCode === 429) return reject(new Error('Reddit rate limited (429)'));
      if (res.statusCode !== 200) return reject(new Error(`Reddit returned status ${res.statusCode}`));
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
      const r = await message.reply(`sent already\ncurrent post count: ${currentCount}/${X_WATCH.POSTS_REQUIRED}`);
      deleteAfter(r, LINK_DELETE_MS);
      return;
    }

    const apiUrl = `https://api.fxtwitter.com/status/${tweetId}`;
    const raw = await fetchURL(apiUrl);

    let json;
    try { json = JSON.parse(raw); } catch {
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
        const r = await message.reply(X_WATCH.ALREADY_DONE_REPLY);
        deleteAfter(r, LINK_DELETE_MS);
        return;
      }

      await saveSeenLink(tweetId);
      const newCount = currentCount + 1;
      postCounts.set(userId, newCount);
      await saveUserCount(userId, newCount);

      if (newCount >= X_WATCH.POSTS_REQUIRED) {
        const role = message.guild.roles.cache.find(r => r.name.toLowerCase() === X_WATCH.REWARD_ROLE.toLowerCase());
        if (role && member) await member.roles.add(role).catch(e => console.error('Failed to add role:', e));
        const r = await message.reply(`${X_WATCH.REPLY_PREFIX}, ${newCount}/${X_WATCH.POSTS_REQUIRED} posts — role given!`);
        deleteAfter(r, LINK_DELETE_MS);
      } else {
        const r = await message.reply(`${X_WATCH.REPLY_PREFIX}, ${newCount}/${X_WATCH.POSTS_REQUIRED} posts`);
        deleteAfter(r, LINK_DELETE_MS);
      }
    } else {
      await saveSeenLink(tweetId);
      const r = await message.reply(`${X_WATCH.WRONG_REPLY}\npost exactly what is in <#${X_WATCH.GUIDE_CHANNEL_ID}>`);
      deleteAfter(r, LINK_DELETE_MS);
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
      const r = await message.reply(`${REDDIT_WATCH.WRONG_REPLY}\npost exactly what is in <#${REDDIT_WATCH.GUIDE_CHANNEL_ID}>`);
      deleteAfter(r, LINK_DELETE_MS);
      return;
    }

    const userId = message.author.id;
    const currentCount = postCounts.get(userId) || 0;

    if (seenRedditLinks.has(postId)) {
      const r = await message.reply(`sent already\ncurrent post count: ${currentCount}/${REDDIT_WATCH.POSTS_REQUIRED}`);
      deleteAfter(r, LINK_DELETE_MS);
      return;
    }

    const jsonUrl = `https://www.reddit.com/comments/${postId}.json`;
    let raw;
    try { raw = await fetchRedditURL(jsonUrl); } catch (e) {
      console.error('Failed to fetch Reddit post:', e);
      raw = null;
    }

    let postData = null;
    if (raw) {
      let json;
      try { json = JSON.parse(raw); } catch { json = null; }
      postData = json?.[0]?.data?.children?.[0]?.data || null;
    }

    if (!postData) {
      console.error('Could not read Reddit post data, counting anyway');
      const member2 = await message.guild.members.fetch(userId).catch(() => null);
      const hasRole2 = member2?.roles.cache.some(r => r.name.toLowerCase() === REDDIT_WATCH.REWARD_ROLE.toLowerCase());
      if (hasRole2) {
        await saveSeenRedditLink(postId);
        const r = await message.reply(REDDIT_WATCH.ALREADY_DONE_REPLY);
        deleteAfter(r, LINK_DELETE_MS);
        return;
      }
      await saveSeenRedditLink(postId);
      const newCount2 = currentCount + 1;
      postCounts.set(userId, newCount2);
      await saveUserCount(userId, newCount2);
      if (newCount2 >= REDDIT_WATCH.POSTS_REQUIRED) {
        const role2 = message.guild.roles.cache.find(r => r.name.toLowerCase() === REDDIT_WATCH.REWARD_ROLE.toLowerCase());
        if (role2 && member2) await member2.roles.add(role2).catch(() => {});
        const r = await message.reply(`${REDDIT_WATCH.REPLY_PREFIX}, ${newCount2}/${REDDIT_WATCH.POSTS_REQUIRED} posts — role given!`);
        deleteAfter(r, LINK_DELETE_MS);
        return;
      }
      const r = await message.reply(`${REDDIT_WATCH.REPLY_PREFIX}, ${newCount2}/${REDDIT_WATCH.POSTS_REQUIRED} posts`);
      deleteAfter(r, LINK_DELETE_MS);
      return;
    }

    const postTitle = (postData.title || '').trim().toLowerCase();
    const postSelftext = (postData.selftext || '').trim().toLowerCase();
    const targetClean = REDDIT_WATCH.TARGET_TEXT.trim().toLowerCase();

    const titleMatch = postTitle.includes(targetClean) || postTitle === targetClean;
    const selftextMatch = postSelftext.includes(targetClean) || postSelftext === targetClean;
    const canRead = postTitle.length > 0 || postSelftext.length > 0;

    if (canRead && !titleMatch && !selftextMatch) {
      await saveSeenRedditLink(postId);
      const r = await message.reply(`${REDDIT_WATCH.WRONG_REPLY}\npost exactly what is in <#${REDDIT_WATCH.GUIDE_CHANNEL_ID}>`);
      deleteAfter(r, LINK_DELETE_MS);
      return;
    }

    const member = await message.guild.members.fetch(userId).catch(() => null);
    const hasRole = member?.roles.cache.some(r => r.name.toLowerCase() === REDDIT_WATCH.REWARD_ROLE.toLowerCase());

    if (hasRole) {
      await saveSeenRedditLink(postId);
      const r = await message.reply(REDDIT_WATCH.ALREADY_DONE_REPLY);
      deleteAfter(r, LINK_DELETE_MS);
      return;
    }

    await saveSeenRedditLink(postId);
    const newCount = currentCount + 1;
    postCounts.set(userId, newCount);
    await saveUserCount(userId, newCount);

    if (newCount >= REDDIT_WATCH.POSTS_REQUIRED) {
      const role = message.guild.roles.cache.find(r => r.name.toLowerCase() === REDDIT_WATCH.REWARD_ROLE.toLowerCase());
      if (role && member) await member.roles.add(role).catch(e => console.error('Failed to add role:', e));
      const r = await message.reply(`${REDDIT_WATCH.REPLY_PREFIX}, ${newCount}/${REDDIT_WATCH.POSTS_REQUIRED} posts — role given!`);
      deleteAfter(r, LINK_DELETE_MS);
    } else {
      const r = await message.reply(`${REDDIT_WATCH.REPLY_PREFIX}, ${newCount}/${REDDIT_WATCH.POSTS_REQUIRED} posts`);
      deleteAfter(r, LINK_DELETE_MS);
    }
  } catch (e) {
    console.error('Failed to check Reddit link:', e);
  }
}

// ─── Auto Bypass (bypass.city) ────────────────────────────────────────────────

function extractBypassableLinks(content) {
  const urlRegex = /https?:\/\/[^\s<>"\]]+/gi;
  const found = content.match(urlRegex) || [];
  return found.filter(url => {
    try {
      const hostname = new URL(url).hostname.replace(/^www\./, '');
      return BYPASS_DOMAINS.some(domain => hostname === domain || hostname.endsWith('.' + domain));
    } catch { return false; }
  });
}

// bypass.city API: GET https://bypass.city/bypass?bypass=<encoded_url>
// Returns JSON: { status: "success", bypassed_link: "..." } or { status: "error", error: "..." }
function bypassLink(url) {
  return new Promise((resolve, reject) => {
    const apiUrl = `https://bypass.city/bypass?bypass=${encodeURIComponent(url)}`;
    https.get(apiUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Discord-Bot/1.0)',
        'Accept': 'application/json',
      }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return bypassLink(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          // bypass.city returns { status, bypassed_link } on success
          if (json.status === 'success' && json.bypassed_link) {
            resolve(json.bypassed_link);
          } else if (json.bypassed_link) {
            // some responses omit status but still return link
            resolve(json.bypassed_link);
          } else {
            reject(new Error(json.error || json.message || `API status: ${json.status || 'unknown'}`));
          }
        } catch {
          reject(new Error(`Invalid response from bypass.city: ${data.slice(0, 150)}`));
        }
      });
    }).on('error', reject);
  });
}

async function handleAutoBypass(message, links) {
  // Delete the triggering message after 30s as well
  deleteAfter(message);
  for (const link of links) {
    try {
      const bypassed = await bypassLink(link);
      const r = await message.reply(`🔓 **bypassed**\n${bypassed}`);
      deleteAfter(r);
    } catch (e) {
      const r = await message.reply(`❌ failed to bypass \`${link}\`\nerror: ${e.message}`);
      deleteAfter(r);
    }
  }
}

// ─── Anti Spam ────────────────────────────────────────────────────────────────

const pingWarnTracker = new Map();

async function handleAntiSpam(message) {
  const userId = message.author.id;
  const now = Date.now();
  const WINDOW = 5000;
  const LIMIT = 5;

  if (isFormatSpam(message.content)) {
    await message.delete().catch(() => {});
    const warn = await message.channel.send(`<@${userId}> no spamming`).catch(() => null);
    if (warn) deleteAfter(warn);
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
    } catch (e) { console.error('Failed to delete spam messages:', e); }

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
        if (member) await member.timeout(60 * 1000, 'Repeated spamming').catch(e => console.error('Failed to timeout:', e));
      } catch (e) { console.error('Timeout error:', e); }
    }

    const warn = await message.channel.send(`<@${userId}> no spamming`).catch(() => null);
    if (warn) deleteAfter(warn);
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

// ─── Multi-Account Helpers ────────────────────────────────────────────────────

function getToken(num) {
  const t = process.env[`TOKEN${num}`];
  return t && t.trim() ? t.trim() : null;
}

function availableAccounts() {
  const out = [];
  if (getToken(1)) out.push(1);
  if (getToken(2)) out.push(2);
  return out;
}

async function pickAccount(message, statusMsg) {
  const avail = availableAccounts();
  if (avail.length === 0) {
    await statusMsg.edit('no tokens configured. set TOKEN1 and/or TOKEN2 in railway variables.');
    deleteAfter(statusMsg);
    return null;
  }
  if (avail.length === 1) {
    await statusMsg.edit(`only account ${avail[0]} configured — using it automatically.`);
    return avail[0];
  }
  await statusMsg.edit('which account? reply `1` or `2`. (30 seconds)');
  try {
    const collected = await message.channel.awaitMessages({
      filter: m => m.author.id === message.author.id && ['1', '2'].includes(m.content.trim()),
      max: 1,
      time: 30000,
      errors: ['time'],
    });
    const choice = parseInt(collected.first().content.trim());
    await collected.first().delete().catch(() => {});
    if (!getToken(choice)) {
      await statusMsg.edit(`TOKEN${choice} is not set in railway variables.`);
      deleteAfter(statusMsg);
      return null;
    }
    return choice;
  } catch {
    await statusMsg.edit('no account selected — cancelled.');
    deleteAfter(statusMsg);
    return null;
  }
}

let altStakeoutProcess = null;

// ─── Join Ping Handler ────────────────────────────────────────────────────────

client.on('guildMemberAdd', async (member) => {
  const channelId = pingJoinChannels.get(member.guild.id);
  if (!channelId) return;
  try {
    const channel = await member.guild.channels.fetch(channelId);
    if (!channel) return;
    const ping = await channel.send(`<@${member.id}>`);
    ping.delete().catch(() => {});
  } catch (e) { console.error('Failed to send join ping:', e); }
});

// ─── Channel Create → Post in Updates Channel ─────────────────────────────────

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
        `new channel added\n` +
        `${channelRef}\n` +
        `${channel.guild.name}`
      );

    await updatesChannel.send({ embeds: [embed] });
  } catch (e) { console.error('Failed to post channel update:', e); }
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

  // ── Auto Bypass Listener ──────────────────────────────────────────────────
  const bypassableLinks = extractBypassableLinks(message.content);
  if (bypassableLinks.length > 0) {
    await handleAutoBypass(message, bypassableLinks);
    return;
  }

  // ── X Link Checker ────────────────────────────────────────────────────────
  const xLinkRegex = /https?:\/\/(?:twitter\.com|x\.com)\/\w+\/status\/\d+[^\s]*/gi;
  const xLinks = message.content.match(xLinkRegex);
  if (xLinks) {
    for (const link of xLinks) await checkXLink(message, link);
  }

  // ── Reddit Link Checker ───────────────────────────────────────────────────
  const redditLinkRegex = /https?:\/\/(?:www\.)?reddit\.com\/(?:r\/[^/\s]+\/)?comments\/[a-z0-9]+[^\s]*/gi;
  const redditLinks = message.content.match(redditLinkRegex);
  if (redditLinks) {
    for (const link of redditLinks) await checkRedditLink(message, link);
  }

  if (!message.content.startsWith(PREFIX)) return;

  const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const command = args.shift().toLowerCase();

  // ── !xpost ────────────────────────────────────────────────────────────────
  if (command === 'xpost') {
    if (!requireAdmin(message)) { await reply(message, 'admin only.'); return; }

    const postCount = parseInt(args[0]);
    const delayStr = args[1] || '5s';

    if (!postCount || postCount < 1) {
      await reply(message, 'usage: `!xpost <number> <delay>`\nexample: `!xpost 1 10s`');
      return;
    }

    const delayMs = parseCooldown(delayStr);
    if (!delayMs) { await reply(message, 'invalid delay. examples: 5s, 10s, 30s'); return; }

    deleteCommand(message);
    const statusMsg = await message.channel.send(`starting ${postCount} post(s)...`);
    deleteAfter(statusMsg);

    try {
      const XPOSTER_PATH = path.join(__dirname, 'xposter');
      const child = spawn('node', ['xposter.mjs'], {
        cwd: XPOSTER_PATH,
        env: {
          ...process.env,
          POST_COUNT: postCount.toString(),
          POST_DELAY_MS: delayMs.toString(),
        },
      });

      let output = '';
      child.stdout.on('data', (data) => { const t = data.toString().trim(); output += t + '\n'; console.log('[xposter]', t); });
      child.stderr.on('data', (data) => { const t = data.toString().trim(); output += t + '\n'; console.error('[xposter]', t); });
      child.on('error', async (err) => {
        console.error('[xpost] Spawn error:', err);
        await statusMsg.edit(`failed to start poster: ${err.message}`);
      });
      child.on('close', async (code) => {
        const lastLines = output.trim().split('\n').slice(-10).join('\n');
        if (code === 0) {
          await statusMsg.edit(`done\n\`\`\`\n${lastLines}\`\`\``);
        } else {
          await statusMsg.edit(`poster crashed (code ${code})\n\`\`\`\n${lastLines}\`\`\``);
        }
      });
    } catch (e) {
      console.error('[xpost] Error:', e);
      await statusMsg.edit('error starting poster: ' + e.message);
    }
    return;
  }

  // ── !startloop ────────────────────────────────────────────────────────────
  if (command === 'startloop') {
    if (!requireAdmin(message)) { await reply(message, 'admin only.'); return; }

    const delay = parseInt(args[0]) || 60;
    if (delay < 10) { await reply(message, 'minimum delay is 10 seconds.'); return; }

    deleteCommand(message);
    const status = await message.channel.send(`select an account...`);
    deleteAfter(status);

    const acctNum = await pickAccount(message, status);
    if (!acctNum) return;

    await status.edit(`starting loop with account ${acctNum} — every **${delay}** seconds...`);

    try {
      process.env.X_AUTH_TOKEN = getToken(acctNum);
      const { startLoop } = await import('./xposter/xloop.mjs');
      await startLoop(delay);
      await status.edit(`loop started with account ${acctNum}. posting every **${delay}** seconds. use !stoploop to stop.`);
    } catch (e) {
      console.error('[LOOP] CRITICAL ERROR:', e);
      await status.edit(`failed to start loop.\n\`\`\`\n${e.message}\n\`\`\``);
    }
    return;
  }

  // ── !stoploop ─────────────────────────────────────────────────────────────
  if (command === 'stoploop') {
    if (!requireAdmin(message)) { await reply(message, 'admin only.'); return; }
    deleteCommand(message);
    try {
      const { stopLoop } = await import('./xposter/xloop.mjs');
      stopLoop();
      const r = await message.channel.send('loop stopped.');
      deleteAfter(r);
    } catch (e) {
      console.error('[LOOP] Stop error:', e);
      const r = await message.channel.send('failed to stop loop.');
      deleteAfter(r);
    }
    return;
  }

  // ── !disable ──────────────────────────────────────────────────────────────
  if (command === 'disable') {
    if (!requireAdmin(message)) { await reply(message, 'admin only.'); return; }
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
    if (stopped === 0) { await reply(message, 'no active auto-pings to stop.'); return; }
    await reply(message, `stopped **${stopped}** auto-ping${stopped !== 1 ? 's' : ''}.`);
    return;
  }

  // ── !pingjoin ─────────────────────────────────────────────────────────────
  if (command === 'pingjoin') {
    if (!requireAdmin(message)) { await reply(message, 'admin only.'); return; }
    const sub = args[0]?.toLowerCase();
    if (sub === 'enable') {
      pingJoinChannels.set(message.guild.id, message.channel.id);
      await reply(message, `join pings enabled in this channel.`);
      return;
    }
    if (sub === 'disable') {
      if (!pingJoinChannels.has(message.guild.id)) { await reply(message, 'join pings are not active.'); return; }
      pingJoinChannels.delete(message.guild.id);
      await reply(message, 'join pings disabled.');
      return;
    }
    await reply(message, 'usage: `!pingjoin enable` or `!pingjoin disable`');
    return;
  }

  // ── !autopingeveryone ─────────────────────────────────────────────────────
  if (command === 'autopingeveryone') {
    if (!requireAdmin(message)) { await reply(message, 'admin only.'); return; }
    const sub = args[0]?.toLowerCase();
    if (sub === 'enable') {
      const cooldownStr = args[1];
      if (!cooldownStr) { await reply(message, 'usage: `!autopingeveryone enable <cooldown>`'); return; }
      const cooldownMs = parseCooldown(cooldownStr);
      if (!cooldownMs) { await reply(message, 'invalid cooldown.'); return; }
      if (everyonePingIntervals.has(message.channel.id)) clearInterval(everyonePingIntervals.get(message.channel.id).interval);
      const interval = setInterval(async () => {
        try {
          const p = await message.channel.send('@everyone');
          p.delete().catch(() => {});
        } catch (e) { console.error(e); }
      }, cooldownMs);
      everyonePingIntervals.set(message.channel.id, { interval, cooldownMs });
      await reply(message, `auto @everyone ping enabled every **${formatCooldown(cooldownMs)}**.`);
      return;
    }
    if (sub === 'disable') {
      if (!everyonePingIntervals.has(message.channel.id)) { await reply(message, 'not active in this channel.'); return; }
      clearInterval(everyonePingIntervals.get(message.channel.id).interval);
      everyonePingIntervals.delete(message.channel.id);
      await reply(message, 'auto @everyone ping disabled.');
      return;
    }
    await reply(message, 'usage: `!autopingeveryone enable <cooldown>` or `!autopingeveryone disable`');
    return;
  }

  // ── !startaltclone ────────────────────────────────────────────────────────
  if (command === 'startaltclone') {
    if (!requireAdmin(message)) { await reply(message, 'admin only.'); return; }
    if (altStakeoutProcess) { await reply(message, 'alt tracking is already active.'); return; }

    const targetAlt = process.env.TARGET_ALT ? process.env.TARGET_ALT.trim() : 'jameshandalt67';
    const appendUrl = args[0] || '';

    deleteCommand(message);
    const statusMsg = await message.channel.send('select an account for the stakeout...');
    deleteAfter(statusMsg);

    const acctNum = await pickAccount(message, statusMsg);
    if (!acctNum) return;

    const confirmMsg = await message.channel.send(
      `alt stakeout started\naccount: \`${acctNum}\`\ntarget: \`@${targetAlt}\`\ninterval: every 1 hour\nappended link: \`${appendUrl || 'none'}\``
    );
    deleteAfter(confirmMsg);

    try {
      const runDir = path.join(__dirname, 'xposter');
      altStakeoutProcess = spawn('node', ['xloop.mjs'], {
        cwd: runDir,
        env: {
          ...process.env,
          X_AUTH_TOKEN: getToken(acctNum),
          TARGET_ALT: targetAlt,
          EXTRA_LINK: appendUrl,
        }
      });
      altStakeoutProcess.stdout.on('data', (d) => console.log(`[STAKEOUT OUT]: ${d}`));
      altStakeoutProcess.stderr.on('data', (d) => console.error(`[STAKEOUT ERR]: ${d}`));
      altStakeoutProcess.on('close', (c) => {
        console.log(`[SYSTEM] Stakeout loop killed with code: ${c}`);
        altStakeoutProcess = null;
      });
    } catch (err) {
      altStakeoutProcess = null;
      const r = await message.channel.send('System error initializing background loop context: ' + err.message);
      deleteAfter(r);
    }
    return;
  }

  // ── !stopaltclone ─────────────────────────────────────────────────────────
  if (command === 'stopaltclone') {
    if (!requireAdmin(message)) { await reply(message, 'admin only.'); return; }
    if (!altStakeoutProcess) { await reply(message, 'no active stakeout running.'); return; }
    altStakeoutProcess.kill();
    altStakeoutProcess = null;
    await reply(message, 'stakeout stopped.');
    return;
  }

  // ── !autopinguser ─────────────────────────────────────────────────────────
  if (command === 'autopinguser') {
    if (!requireAdmin(message)) { await reply(message, 'admin only.'); return; }
    const sub = args[0]?.toLowerCase();
    if (sub === 'enable') {
      const userMention = args[1];
      const cooldownStr = args[2];
      if (!userMention || !cooldownStr) { await reply(message, 'usage: `!autopinguser enable @user <cooldown>`'); return; }
      const userId = userMention.replace(/[<@!>]/g, '');
      let targetUser;
      try { targetUser = await message.guild.members.fetch(userId); } catch {
        await reply(message, 'Could not find that user.');
        return;
      }
      const cooldownMs = parseCooldown(cooldownStr);
      if (!cooldownMs) { await reply(message, 'invalid cooldown.'); return; }
      if (userPingIntervals.has(message.channel.id)) clearInterval(userPingIntervals.get(message.channel.id).interval);
      const interval = setInterval(async () => {
        try {
          const ping = await message.channel.send(`<@${userId}>`);
          setTimeout(() => ping.delete().catch(() => {}), 500);
        } catch (e) { console.error(e); }
      }, cooldownMs);
      userPingIntervals.set(message.channel.id, { interval, userId, cooldownMs });
      await reply(message, `auto ping for ${targetUser} enabled every **${formatCooldown(cooldownMs)}**.`);
      return;
    }
    if (sub === 'disable') {
      if (!userPingIntervals.has(message.channel.id)) { await reply(message, 'not active in this channel.'); return; }
      clearInterval(userPingIntervals.get(message.channel.id).interval);
      userPingIntervals.delete(message.channel.id);
      await reply(message, 'auto user ping disabled.');
      return;
    }
    await reply(message, 'usage: `!autopinguser enable @user <cooldown>` or `!autopinguser disable`');
    return;
  }

  // ── !auth ─────────────────────────────────────────────────────────────────
  if (command === 'auth') {
    if (!requireAdmin(message)) { await reply(message, 'admin only.'); return; }

    const username = args[0];
    const password = args.slice(1).join(' ');

    if (!username || !password) { await reply(message, 'usage: `!auth <username> <password>`'); return; }

    deleteCommand(message);
    const statusMsg = await message.channel.send('launching browser...');
    deleteAfter(statusMsg);

    let browser = null;
    let page = null;
    let activeInput = null;

    const sendScreenshot = async (label) => {
      try {
        if (!page) return;
        const { AttachmentBuilder } = await import('discord.js');
        const buf = await page.screenshot({ fullPage: false });
        const attachment = new AttachmentBuilder(buf, { name: 'screen.png' });
        const r = await message.channel.send({
          content:
            `**${label}**\n` +
            `commands:\n` +
            `\`click x y\` — click anywhere\n` +
            `\`type: your text here\` — type into the active input\n` +
            `\`enter\` — press enter\n` +
            `\`tab\` — press tab\n` +
            `\`username\` — auto-fill username\n` +
            `\`password\` — auto-fill password\n` +
            `\`s\` — take a screenshot\n` +
            `\`done\` — extract the token\n` +
            `\`cancel\` — abort`,
          files: [attachment]
        });
        deleteAfter(r);
      } catch (e) {
        const r = await message.channel.send(`screenshot failed: ${e.message}`).catch(() => null);
        if (r) deleteAfter(r);
      }
    };

    const waitForCommand = async () => {
      await statusMsg.edit('waiting for your command...');
      try {
        const collected = await message.channel.awaitMessages({
          filter: m => m.author.id === message.author.id,
          max: 1,
          time: 120000,
          errors: ['time']
        });
        const val = collected.first().content.trim();
        await collected.first().delete().catch(() => {});
        return val;
      } catch { return null; }
    };

    try {
      const { chromium } = await import('playwright');
      browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-setuid-sandbox', '--single-process']
      });

      const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        viewport: { width: 1280, height: 800 }
      });

      page = await context.newPage();
      await statusMsg.edit('loading x login page...');
      try {
        await page.goto('https://x.com/i/flow/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(3000);
      } catch (e) { throw new Error(`Page load failed: ${e.message}`); }

      await sendScreenshot('x login loaded — you are in control');

      while (true) {
        const response = await waitForCommand();
        if (!response || response.toLowerCase() === 'cancel') {
          await browser.close();
          await statusMsg.edit('cancelled.');
          return;
        }

        const lower = response.toLowerCase();

        if (lower.startsWith('click ')) {
          const parts = response.split(' ');
          const x = parseInt(parts[1]);
          const y = parseInt(parts[2]);
          if (isNaN(x) || isNaN(y)) { await statusMsg.edit('invalid. use: `click 450 300`'); continue; }

          await page.mouse.click(x, y);
          await page.waitForTimeout(800);

          const clickedInput = await page.evaluate(({ cx, cy }) => {
            const el = document.elementFromPoint(cx, cy);
            if (!el) return null;
            const tag = el.tagName.toLowerCase();
            const isInput = tag === 'input' || tag === 'textarea' || el.getAttribute('contenteditable') === 'true' || el.getAttribute('role') === 'textbox';
            if (isInput) return { tag, type: el.getAttribute('type') || '', placeholder: el.getAttribute('placeholder') || '', name: el.getAttribute('name') || '' };
            return null;
          }, { cx: x, cy: y });

          if (clickedInput) {
            activeInput = { x, y, ...clickedInput };
            await statusMsg.edit(`clicked a text input at ${x}, ${y}\nfield: \`${JSON.stringify(clickedInput)}\`\nuse \`type: your text\` to type, or \`username\`/\`password\` to auto-fill.`);
          } else {
            activeInput = null;
            await statusMsg.edit(`clicked at ${x}, ${y}`);
          }
          await page.waitForTimeout(1000);
          await sendScreenshot(`after click at ${x}, ${y}`);
          continue;
        }

        if (lower.startsWith('type:')) {
          const text = response.slice(5).trim();
          if (!text) { await statusMsg.edit('nothing to type. use: `type: hello world`'); continue; }
          if (!activeInput) await statusMsg.edit('no input selected — typing at cursor...');
          await page.keyboard.type(text, { delay: 80 });
          await statusMsg.edit(`typed: "${text}"`);
          await page.waitForTimeout(500);
          await sendScreenshot('after typing');
          continue;
        }

        if (lower === 'enter') {
          await page.keyboard.press('Enter');
          await statusMsg.edit('pressed enter');
          await page.waitForTimeout(2000);
          await sendScreenshot('after enter');
          continue;
        }

        if (lower === 'tab') {
          await page.keyboard.press('Tab');
          await statusMsg.edit('pressed tab');
          await page.waitForTimeout(500);
          await sendScreenshot('after tab');
          continue;
        }

        if (lower === 's' || lower === 'screenshot') {
          await sendScreenshot('current screen');
          continue;
        }

        if (lower === 'username') {
          const selectors = [
            'input[autocomplete="username"]',
            'input[name="text"]',
            'input[type="text"]',
            'input[placeholder*="username" i]',
            'input[placeholder*="email" i]',
            'input[placeholder*="phone" i]',
          ];
          let filled = false;
          for (const sel of selectors) {
            try {
              const el = await page.$(sel);
              if (el) {
                await el.click();
                await page.waitForTimeout(300);
                await el.fill('');
                await el.type(username, { delay: 80 });
                filled = true;
                activeInput = { sel };
                break;
              }
            } catch {}
          }
          await statusMsg.edit(filled ? `username filled` : 'Could not find a username field');
          await page.waitForTimeout(500);
          await sendScreenshot('after username fill');
          continue;
        }

        if (lower === 'password') {
          try {
            const el = await page.$('input[name="password"], input[type="password"]');
            if (el) {
              await el.click();
              await page.waitForTimeout(300);
              await el.fill('');
              await el.type(password, { delay: 80 });
              activeInput = { sel: 'password' };
              await statusMsg.edit('password filled');
            } else {
              await statusMsg.edit('Could not find a password field');
            }
          } catch (e) { await statusMsg.edit(`Error: ${e.message}`); }
          await page.waitForTimeout(500);
          await sendScreenshot('after password fill');
          continue;
        }

        if (lower === 'clear') {
          await page.keyboard.press('Control+A');
          await page.keyboard.press('Backspace');
          await statusMsg.edit('cleared input');
          await sendScreenshot('after clear');
          continue;
        }

        if (lower === 'done') {
          const url = page.url();
          await statusMsg.edit(`current url: \`${url}\` — extracting auth_token...`);
          const cookies = await context.cookies();
          const authCookie = cookies.find(c => c.name === 'auth_token');
          await browser.close();

          if (!authCookie) {
            await statusMsg.edit(`\`auth_token\` not found in cookies.\nURL was: \`${url}\`\nYou may not be fully logged in yet.`);
            return;
          }

          try {
            const dm = await message.author.createDM();
            await dm.send(`auth_token for \`${username}\`:\n\`\`\`\n${authCookie.value}\n\`\`\``);
            await statusMsg.edit('done. auth_token sent to your dms.');
          } catch {
            await statusMsg.edit(`got it (dms closed — delete this fast):\n\`\`\`\n${authCookie.value}\n\`\`\``);
          }
          return;
        }

        await statusMsg.edit(`unknown command: \`${response}\`. use \`s\` for a screenshot.`);
      }
    } catch (e) {
      try {
        if (page) {
          const { AttachmentBuilder } = await import('discord.js');
          const buf = await page.screenshot({ fullPage: false });
          const attachment = new AttachmentBuilder(buf, { name: 'error.png' });
          const r = await message.channel.send({ content: `error: ${e.message}`, files: [attachment] });
          deleteAfter(r);
        }
      } catch {}
      if (browser) await browser.close().catch(() => {});
      console.error('[!auth] Error:', e);
      await statusMsg.edit(`**Error:** \`${e.message}\``);
    }
    return;
  }

  // ── !randommessages ───────────────────────────────────────────────────────
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

      if (isNaN(requestedCount) || requestedCount < 1) {
        await reply(message, 'usage: `!randommessages [number] [channel name]`');
        return;
      }

      let targetChannel = message.channel;
      if (channelQuery) {
        const found = findClosestChannel(message.guild, channelQuery);
        if (!found) { await reply(message, `couldn't find a channel matching "${channelQuery}".`); return; }
        targetChannel = found;
      }

      let fetched = await targetChannel.messages.fetch({ limit: 100 });
      let pool = fetched.filter(m => !m.author.bot && m.content.trim().length > 0).map(m => m);

      if (pool.length === 0) {
        await reply(message, `no messages found in ${targetChannel.id !== message.channel.id ? `#${targetChannel.name}` : 'this channel'}.`);
        return;
      }

      const actualCount = Math.min(requestedCount, pool.length);
      const picked = await weightedRandomPick(pool, actualCount, message.guild);

      const sourceNote = targetChannel.id !== message.channel.id ? ` from #${targetChannel.name}` : '';
      const header = `${picked.length} random message${picked.length !== 1 ? 's' : ''}${sourceNote}:\n`;
      const lines = picked.map(m => `${m.author.username}\n${m.content.slice(0, 300)}${m.content.length > 300 ? '…' : ''}`).join('\n\n');

      await reply(message, header + lines);
    } catch (e) {
      console.error(e);
      await reply(message, 'failed to fetch messages.');
    }
    return;
  }

  // ── !purge ────────────────────────────────────────────────────────────────
  if (command === 'purge') {
    if (!requireAdmin(message)) { await reply(message, 'admin only.'); return; }
    if (!message.channel.permissionsFor(message.guild.members.me).has(PermissionsBitField.Flags.ManageMessages)) {
      await reply(message, 'I need Manage Messages permission.');
      return;
    }

    const excludeIndex = args.indexOf('--exclude');
    const count = parseInt(args[0]);
    if (isNaN(count) || count < 1 || count > 100) {
      await reply(message, 'usage: `!purge <1-100> [--exclude @user1 @user2 ...]`');
      return;
    }

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
      if (toDelete.length === 0) {
        const r = await message.channel.send('no messages to delete.');
        deleteAfter(r);
        return;
      }
      await message.channel.bulkDelete(toDelete, true);
      const excludeNote = excludedIds.size > 0 ? ` (excluded ${excludedIds.size} user${excludedIds.size > 1 ? 's' : ''})` : '';
      const reply2 = await message.channel.send(`deleted **${toDelete.length}** message${toDelete.length !== 1 ? 's' : ''}${excludeNote}.`);
      deleteAfter(reply2);
    } catch (e) {
      console.error(e);
      const r = await message.channel.send('Failed to delete messages. Make sure messages are not older than 14 days.').catch(() => null);
      if (r) deleteAfter(r);
    }
    return;
  }

  // ── !kick ─────────────────────────────────────────────────────────────────
  if (command === 'kick') {
    if (!requireAdmin(message)) { await reply(message, 'admin only.'); return; }
    if (!message.guild.members.me.permissions.has(PermissionsBitField.Flags.KickMembers)) {
      await reply(message, 'I need Kick Members permission.');
      return;
    }

    const userMention = args[0];
    if (!userMention) { await reply(message, 'usage: `!kick @user [reason]`'); return; }

    const userId = userMention.replace(/[<@!>]/g, '');
    const reason = args.slice(1).join(' ') || 'No reason provided';

    let member;
    try { member = await message.guild.members.fetch(userId); } catch {
      await reply(message, 'Could not find that user.');
      return;
    }

    if (!member.kickable) { await reply(message, 'I cannot kick this user. They may have a higher role than me.'); return; }

    try {
      await member.kick(reason);
      await reply(message, `**${member.user.tag}** kicked. reason: ${reason}`);
    } catch (e) {
      console.error('Failed to kick member:', e);
      await reply(message, 'Failed to kick that user.');
    }
    return;
  }

  // ── !ban ──────────────────────────────────────────────────────────────────
  if (command === 'ban') {
    if (!requireAdmin(message)) { await reply(message, 'admin only.'); return; }
    if (!message.guild.members.me.permissions.has(PermissionsBitField.Flags.BanMembers)) {
      await reply(message, 'I need Ban Members permission.');
      return;
    }

    const userMention = args[0];
    if (!userMention) { await reply(message, 'usage: `!ban @user [reason]`'); return; }

    const userId = userMention.replace(/[<@!>]/g, '');
    const reason = args.slice(1).join(' ') || 'No reason provided';

    let member;
    try { member = await message.guild.members.fetch(userId); } catch {
      await reply(message, 'Could not find that user.');
      return;
    }

    if (!member.bannable) { await reply(message, 'I cannot ban this user. They may have a higher role than me.'); return; }

    try {
      await member.ban({ reason, deleteMessageSeconds: 0 });
      await reply(message, `**${member.user.tag}** banned. reason: ${reason}`);
    } catch (e) {
      console.error('Failed to ban member:', e);
      await reply(message, 'Failed to ban that user.');
    }
    return;
  }

  // ── !fm ───────────────────────────────────────────────────────────────────
  if (command === 'fm') {
    if (!requireAdmin(message)) { await reply(message, 'admin only.'); return; }

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
    if (!requireAdmin(message)) { await reply(message, 'admin only.'); return; }
    const text = args.join(' ');
    if (!text) { await reply(message, 'usage: `!post <text>`'); return; }
    X_WATCH.TARGET_TEXT = text;
    REDDIT_WATCH.TARGET_TEXT = text;
    await reply(message, `target text updated to: **${text}**`);
    return;
  }

  // ── !rr ───────────────────────────────────────────────────────────────────
  if (command === 'rr') {
    if (!requireAdmin(message)) { await reply(message, 'admin only.'); return; }

    const msgId = args[0];
    const emojiRaw = args[1];
    const roleName = args.slice(2).join(' ');

    if (!msgId || !emojiRaw || !roleName) {
      await reply(message, 'usage: `!rr <message id> <emoji> <role name>`');
      return;
    }

    const emojiClean = emojiRaw.replace(/:/g, '');
    const role = message.guild.roles.cache.find(r => r.name.toLowerCase() === roleName.toLowerCase());
    if (!role) { await reply(message, `couldn't find a role named "${roleName}".`); return; }

    let targetMsg;
    try { targetMsg = await message.channel.messages.fetch(msgId); } catch {
      await reply(message, 'Could not find that message in this channel.');
      return;
    }

    let reactedEmoji;
    try {
      const reaction = await targetMsg.react(emojiClean);
      reactedEmoji = reaction.emoji;
    } catch {
      await reply(message, `Could not react with that emoji. Make sure it's a valid emoji the bot can use.`);
      return;
    }

    const emojiKey = reactedEmoji.id
      ? `${reactedEmoji.name}:${reactedEmoji.id}`
      : reactedEmoji.name;

    if (!reactionRoles.has(msgId)) reactionRoles.set(msgId, {});
    reactionRoles.get(msgId)[emojiKey] = role.id;

    await saveReactionRole(msgId, emojiKey, role.id);
    await reply(message, `reaction role set. users who react with ${emojiRaw} will get the **${roleName}** role.`);
    return;
  }

  // ── !updateset ────────────────────────────────────────────────────────────
  if (command === 'updateset') {
    if (!requireAdmin(message)) { await reply(message, 'admin only.'); return; }

    const embed = new EmbedBuilder()
      .setColor(0xFF69B4)
      .setDescription(
        `꩜ ────────────────── ꩜\n` +
        `\n` +
        `**server updates**\n` +
        `\n` +
        `react below to receive a dm whenever\n` +
        `a new channel is added to the server\n` +
        `\n` +
        `make sure your dms are open\n` +
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
    try { await reaction.fetch(); } catch (e) { dbg(`Failed to fetch partial reaction: ${e}`); return; }
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

  if (!reactionRoles.has(msgId)) { dbg(`No mapping found for message ${msgId}`); return; }

  const emojiKey = reaction.emoji.id
    ? `${reaction.emoji.name}:${reaction.emoji.id}`
    : reaction.emoji.name;

  const mapping = reactionRoles.get(msgId);
  dbg(`Emoji key: "${emojiKey}" | mapping keys: ${Object.keys(mapping).join(', ')}`);

  const roleId = mapping[emojiKey] || mapping[reaction.emoji.name];
  if (!roleId) { dbg(`No role found for emoji key "${emojiKey}"`); return; }

  dbg(`Found role ID: ${roleId} — attempting to add to user ${user.id}`);

  try {
    const guild = reaction.message.guild;
    const member = await guild.members.fetch(user.id).catch(() => null);
    if (!member) { dbg(`Could not fetch member ${user.id}`); return; }
    await member.roles.add(roleId)
      .then(() => dbg(`Successfully added role ${roleId} to ${user.id}`))
      .catch(e => dbg(`Failed to add role: ${e}`));
  } catch (e) { dbg(`Reaction role add error: ${e}`); }
});

client.on('messageReactionRemove', async (reaction, user) => {
  if (user.bot) return;

  if (reaction.partial) {
    try { await reaction.fetch(); } catch { return; }
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
  } catch (e) { console.error('Reaction role remove error:', e); }
});

client.login(process.env.DISCORD_TOKEN);
