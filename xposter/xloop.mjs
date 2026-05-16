import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';

let isRunning = false;
let lastImages = {};

// Existing Environment variables
const X_AUTH_TOKEN_RAW = process.env.X_AUTH_TOKEN || "";
const POST_TITLES_RAW = process.env.POST_TITLES || "";
const IMAGE_URL_RAW = process.env.IMAGE_URL || "";

// New Surveillance Environment configuration (Strictly No Defaults)
const EXTRA_LINK = process.env.EXTRA_LINK || "";
const TARGET_ALT = process.env.TARGET_ALT ? process.env.TARGET_ALT.trim() : "";
const TRACK_FILE = TARGET_ALT ? path.join('/tmp', `last_seen_tweet_${TARGET_ALT}.txt`) : "";

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ─── Selectors ────────────────────────────────────────────────────────────────
const SEL = {
  textbox:  'div[data-testid="tweetTextarea_0"], div[role="textbox"][contenteditable="true"]',
  fileInput: 'input[data-testid="fileInput"]',
  submitBtn: 'button[data-testid="tweetButton"], button[data-testid="tweetButtonInline"]',
  uploadDone: [
    'button[data-testid="removeMedia"]',
    '[aria-label="Remove media"]',
    'div[data-testid="attachments"] img',
    'img[src^="blob:"]',
  ].join(', '),
  toast:  'div[data-testid="toast"]',
  dialog: 'div[role="dialog"]',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
const getCycledItem = (arr, lastItem) => {
  if (arr.length <= 1) return arr[0];
  let item;
  do { item = arr[Math.floor(Math.random() * arr.length)]; }
  while (item === lastItem && arr.length > 1);
  return item;
};

function downloadImage(url, dest) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const file  = fs.createWriteStream(dest);
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Referer':    'https://x.com/',
        'Accept':     'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      },
    };

    const req = proto.get(url, options, (res) => {
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
        file.close();
        return downloadImage(res.headers.location, dest).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        return reject(new Error(`Download failed with status ${res.statusCode}`));
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
      file.on('error',  (err) => { fs.unlink(dest, () => {}); reject(err); });
    });

    req.on('error', (err) => { fs.unlink(dest, () => {}); reject(err); });
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Download timed out')); });
  });
}

function fetchLatestTweet(username) {
  return new Promise((resolve, reject) => {
    const url = `https://api.fxtwitter.com/${username}/latest`;
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function getLastPostedId() {
  if (TRACK_FILE && fs.existsSync(TRACK_FILE)) {
    return fs.readFileSync(TRACK_FILE, 'utf8').trim();
  }
  return null;
}

function saveLastPostedId(id) {
  if (TRACK_FILE) {
    fs.writeFileSync(TRACK_FILE, id, 'utf8');
  }
}

// ─── Core post attempt ────────────────────────────────────────────────────────
async function attemptPost(token, title, imageUrl, accId) {
  const tempPath = `/tmp/img_${accId}_${Date.now()}.png`;
  let browser = null;

  try {
    console.log(`[ACC-${accId}] 🚀 Starting post attempt...`);

    if (imageUrl) {
      console.log(`[ACC-${accId}] ⬇️  Downloading image...`);
      await downloadImage(imageUrl, tempPath);
      const stat = fs.statSync(tempPath);
      if (stat.size === 0) throw new Error('Downloaded image is empty');
      console.log(`[ACC-${accId}] ✅ Image downloaded (${(stat.size / 1024).toFixed(1)} KB)`);
    }

    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-setuid-sandbox',
        '--single-process',
        '--disable-extensions',
      ],
    });

    const context = await browser.newContext({
      viewport:        { width: 1280, height: 900 },
      deviceScaleFactor: 1,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale: 'en-US',
    });

    await context.addCookies([{
      name:     'auth_token',
      value:    token,
      domain:   '.x.com',
      path:     '/',
      httpOnly: true,
      secure:   true,
      sameSite: 'None',
    }]);

    const page = await context.newPage();

    await page.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (['font', 'media', 'websocket'].includes(type)) return route.abort();
      return route.continue();
    });

    console.log(`[ACC-${accId}] 🌐 Navigating to compose...`);
    await page.goto('https://x.com/compose/post', {
      waitUntil: 'domcontentloaded',
      timeout:   60000,
    });

    const currentUrl = page.url();
    if (!currentUrl.includes('x.com/compose') && !currentUrl.includes('x.com/i/')) {
      throw new Error(`Auth may have failed — landed on: ${currentUrl}`);
    }

    await page.waitForSelector(SEL.textbox, { state: 'visible', timeout: 30000 });
    console.log(`[ACC-${accId}] ✅ Compose box ready`);

    if (imageUrl && fs.existsSync(tempPath)) {
      await page.waitForSelector(SEL.fileInput, { state: 'attached', timeout: 15000 });
      await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (el) {
          el.style.display  = 'block';
          el.style.opacity  = '1';
          el.style.position = 'fixed';
          el.style.zIndex   = '9999';
        }
      }, SEL.fileInput);

      console.log(`[ACC-${accId}] 📎 Attaching image...`);
      const inputEl = await page.$(SEL.fileInput);
      if (!inputEl) throw new Error('File input element not found');
      await inputEl.setInputFiles(tempPath);

      console.log(`[ACC-${accId}] ⏳ Waiting for upload to complete...`);
      await Promise.race([
        page.waitForSelector(SEL.uploadDone, { state: 'visible', timeout: 60000 }),
        page.waitForFunction((sel) => {
          const btn = document.querySelector(sel);
          return btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true';
        }, SEL.submitBtn, { timeout: 60000 }),
      ]);
      console.log(`[ACC-${accId}] ✅ Upload complete`);
    }

    await page.focus(SEL.textbox);
    await page.click(SEL.textbox);
    await page.keyboard.type(title, { delay: 20 });

    await sleep(500);

    await page.waitForFunction((sel) => {
      const btn = document.querySelector(sel);
      return btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true';
    }, SEL.submitBtn, { timeout: 15000 });

    console.log(`[ACC-${accId}] 📤 Submitting post...`);
    await page.click(SEL.submitBtn);

    await Promise.race([
      page.waitForSelector(SEL.toast, { state: 'visible', timeout: 20000 }),
      page.waitForFunction((sel) => !document.querySelector(sel), SEL.dialog, { timeout: 20000 }),
    ]);

    console.log(`[ACC-${accId}] ✅ Post successful!`);
    return true;

  } catch (err) {
    console.error(`[ACC-${accId}] ❌ Attempt failed: ${err.message}`);
    return false;

  } finally {
    if (browser) await browser.close().catch(() => {});
    try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch {}
  }
}

// ─── Per-account loop ─────────────────────────────────────────────────────────
async function postForAccount(token, titles, images, accId, delayMs) {
  const accountKey = `acc_${accId}`;
  const MAX_RETRIES = 5;

  while (isRunning) {
    const startTime    = Date.now();
    const selectedTitle = titles[Math.floor(Math.random() * titles.length)];
    const selectedImage = getCycledItem(images, lastImages[accountKey]);
    lastImages[accountKey] = selectedImage;

    console.log(`[ACC-${accId}] 📝 Title: "${selectedTitle}"`);
    console.log(`[ACC-${accId}] 🖼️  Image: ${selectedImage}`);

    let posted      = false;
    let attempt     = 0;
    let backoffMs   = 5000;

    while (!posted && isRunning && attempt < MAX_RETRIES) {
      attempt++;
      if (attempt > 1) {
        console.log(`[ACC-${accId}] 🔁 Retry ${attempt}/${MAX_RETRIES} in ${backoffMs / 1000}s...`);
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, 60000);
      }
      posted = await attemptPost(token, selectedTitle, selectedImage, accId);
    }

    if (!posted) {
      console.error(`[ACC-${accId}] 💀 All ${MAX_RETRIES} attempts failed. Skipping this cycle.`);
    }

    const elapsed = Date.now() - startTime;
    const waitMs  = Math.max(30000, delayMs - elapsed);

    console.log(`[ACC-${accId}] 😴 Sleeping ${Math.round(waitMs / 1000)}s until next post.`);
    await sleep(waitMs);
  }

  console.log(`[ACC-${accId}] 🛑 Loop stopped.`);
}

// ─── Isolated Hourly Surveillance Stakeout Task ──────────────────────────────
async function runAltCloneTask() {
  if (!TARGET_ALT) {
    console.error("[MONITOR] Critical Error: TARGET_ALT environment variable is completely empty. Monitor aborted.");
    return;
  }

  const tokens = X_AUTH_TOKEN_RAW.split('|').map(t => t.trim()).filter(Boolean);
  if (!tokens.length) {
    console.error("[MONITOR] Error: No valid authentication cookie tokens loaded.");
    return;
  }

  console.log(`[MONITOR] Staking out timeline updates from target account: @${TARGET_ALT}...`);
  let tweetData;
  try {
    const response = await fetchLatestTweet(TARGET_ALT);
    tweetData = response.tweet;
  } catch (err) {
    console.error("[MONITOR] Failed to poll alt feed metrics:", err.message);
    return;
  }

  if (!tweetData || !tweetData.id) {
    console.log("[MONITOR] Empty payload returned. User may be private or deleted.");
    return;
  }

  const currentTweetId = tweetData.id;
  const lastTweetId = getLastPostedId();

  if (currentTweetId === lastTweetId) {
    console.log(`[MONITOR] Already duplicated post (${currentTweetId}). Restfully waiting until next hour.`);
    return;
  }

  console.log(`[MONITOR] Fresh activity detected! Post ID: ${currentTweetId}. Running clone action...`);

  let textToPost = tweetData.text || "";
  textToPost = textToPost.replace(/https:\/\/t\.co\/\w+/g, '').trim();
  if (EXTRA_LINK) {
    textToPost += `\n${EXTRA_LINK}`;
  }

  let mediaUrl = null;
  if (tweetData.media?.all && tweetData.media.all.length > 0) {
    mediaUrl = tweetData.media.all[0].url;
    if (mediaUrl.includes('format=')) {
      mediaUrl = mediaUrl.replace(/name=\w+/, 'name=orig');
    }
  }

  const targetToken = tokens[0];
  const success = await attemptPost(targetToken, textToPost, mediaUrl, "MONITOR-CLONE");
  
  if (success) {
    saveLastPostedId(currentTweetId);
    console.log(`[MONITOR] Post ${currentTweetId} tracked and copied successfully.`);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────
export async function startLoop(delaySeconds = 60) {
  if (isRunning) {
    console.warn('[SYSTEM] Loop is already running.');
    return;
  }
  isRunning = true;

  const tokens = X_AUTH_TOKEN_RAW.split('|').map(t => t.trim()).filter(Boolean);
  const titles = POST_TITLES_RAW.split('|').map(t => t.trim()).filter(Boolean);
  const images = IMAGE_URL_RAW.split('|').map(i => i.trim()).filter(Boolean);

  if (!tokens.length) { console.error('[SYSTEM] No auth tokens found. Set X_AUTH_TOKEN.'); return; }
  if (!titles.length) { console.error('[SYSTEM] No post titles found. Set POST_TITLES.');  return; }
  if (!images.length) { console.error('[SYSTEM] No image URLs found. Set IMAGE_URL.');     return; }

  console.log(`[SYSTEM] Starting ${tokens.length} account(s), posting every ${delaySeconds}s.`);

  tokens.forEach((token, index) => {
    const stagger = index * 60_000;
    setTimeout(() => {
      console.log(`[SYSTEM] Starting ACC-${index + 1} (staggered ${stagger / 1000}s)`);
      postForAccount(token, titles, images, index + 1, delaySeconds * 1000);
    }, stagger);
  });
}

export function stopLoop() {
  isRunning = false;
  console.log('[SYSTEM] Stop signal sent. Accounts will halt after their current cycle.');
}

// Start surveillance loop sequence ONLY if variable is safely present
if (TARGET_ALT) {
  const ONE_HOUR = 60 * 60 * 1000;
  console.log(`[SYSTEM] Monitoring stakeout routine activated for @${TARGET_ALT}. Loop check: 1 hour.`);
  runAltCloneTask();
  setInterval(runAltCloneTask, ONE_HOUR);
} else {
  console.error("[SYSTEM] ❌ TARGET_ALT Environment variable missing. Hourly clone tracker disabled entirely.");
}
