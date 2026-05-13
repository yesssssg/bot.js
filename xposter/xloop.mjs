import { chromium } from 'playwright';
import fs from 'fs';
import https from 'https';
import http from 'http';

let isRunning = false;
let lastImages = {};

const X_AUTH_TOKEN_RAW = process.env.X_AUTH_TOKEN || "";
const POST_TITLES_RAW = process.env.POST_TITLES || "";
const IMAGE_URL_RAW = process.env.IMAGE_URL || "";

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ─── Selectors ────────────────────────────────────────────────────────────────
// Centralised so they're easy to update if X changes their UI

const SEL = {
  textbox:  'div[data-testid="tweetTextarea_0"], div[role="textbox"][contenteditable="true"]',
  fileInput: 'input[data-testid="fileInput"]',
  submitBtn: 'button[data-testid="tweetButton"], button[data-testid="tweetButtonInline"]',
  // Multiple fallbacks for "upload finished" detection
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
      // Follow one redirect
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

// ─── Core post attempt ────────────────────────────────────────────────────────

async function attemptPost(token, title, imageUrl, accId) {
  const tempPath = `/tmp/img_${accId}_${Date.now()}.png`;
  let browser = null;

  try {
    console.log(`[ACC-${accId}] 🚀 Starting post attempt...`);

    // 1. Download image first — fail fast before launching a browser
    console.log(`[ACC-${accId}] ⬇️  Downloading image...`);
    await downloadImage(imageUrl, tempPath);
    const stat = fs.statSync(tempPath);
    if (stat.size === 0) throw new Error('Downloaded image is empty');
    console.log(`[ACC-${accId}] ✅ Image downloaded (${(stat.size / 1024).toFixed(1)} KB)`);

    // 2. Launch browser
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

    // Inject auth cookie
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

    // Block heavy resources we don't need
    await page.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (['font', 'media', 'websocket'].includes(type)) return route.abort();
      return route.continue();
    });

    // 3. Navigate to compose
    console.log(`[ACC-${accId}] 🌐 Navigating to compose...`);
    await page.goto('https://x.com/compose/post', {
      waitUntil: 'domcontentloaded',
      timeout:   60000,
    });

    // 4. Verify we're logged in — if redirected away, auth failed
    const currentUrl = page.url();
    if (!currentUrl.includes('x.com/compose') && !currentUrl.includes('x.com/i/')) {
      throw new Error(`Auth may have failed — landed on: ${currentUrl}`);
    }

    // 5. Wait for the textbox
    await page.waitForSelector(SEL.textbox, { state: 'visible', timeout: 30000 });
    console.log(`[ACC-${accId}] ✅ Compose box ready`);

    // 6. Wait for the file input to be attached (it may be hidden, that's fine)
    await page.waitForSelector(SEL.fileInput, { state: 'attached', timeout: 15000 });

    // Force-show the input so Playwright can interact with it reliably
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) {
        el.style.display  = 'block';
        el.style.opacity  = '1';
        el.style.position = 'fixed';
        el.style.zIndex   = '9999';
      }
    }, SEL.fileInput);

    // 7. Attach the file
    console.log(`[ACC-${accId}] 📎 Attaching image...`);
    const inputEl = await page.$(SEL.fileInput);
    if (!inputEl) throw new Error('File input element not found');
    await inputEl.setInputFiles(tempPath);

    // 8. Wait for upload to finish
    // Strategy: wait for any "upload done" indicator OR for the submit button
    // to become enabled (X keeps it disabled while media is uploading).
    console.log(`[ACC-${accId}] ⏳ Waiting for upload to complete...`);

    await Promise.race([
      // Indicator A: any of the known "media attached" elements appear
      page.waitForSelector(SEL.uploadDone, { state: 'visible', timeout: 60000 }),

      // Indicator B: submit button becomes fully enabled
      // (reliable fallback — X won't enable it until upload is done)
      page.waitForFunction((sel) => {
        const btn = document.querySelector(sel);
        return btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true';
      }, SEL.submitBtn, { timeout: 60000 }),
    ]);

    console.log(`[ACC-${accId}] ✅ Upload complete`);

    // 9. Fill in the text
    await page.focus(SEL.textbox);
    // Use keyboard typing for React-controlled inputs (fill() can sometimes not trigger onChange)
    await page.click(SEL.textbox);
    await page.keyboard.type(title, { delay: 20 });

    // Small pause to let React settle after typing
    await sleep(500);

    // 10. Wait for submit button to be enabled (in case typing temporarily disabled it)
    await page.waitForFunction((sel) => {
      const btn = document.querySelector(sel);
      return btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true';
    }, SEL.submitBtn, { timeout: 15000 });

    // 11. Submit
    console.log(`[ACC-${accId}] 📤 Submitting post...`);
    await page.click(SEL.submitBtn);

    // 12. Confirm success: toast appears OR dialog closes
    await Promise.race([
      page.waitForSelector(SEL.toast, { state: 'visible', timeout: 20000 }),
      page.waitForFunction(
        (sel) => !document.querySelector(sel),
        SEL.dialog,
        { timeout: 20000 }
      ),
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
        backoffMs = Math.min(backoffMs * 2, 60000); // exponential backoff, cap 60s
      }
      posted = await attemptPost(token, selectedTitle, selectedImage, accId);
    }

    if (!posted) {
      console.error(`[ACC-${accId}] 💀 All ${MAX_RETRIES} attempts failed. Skipping this cycle.`);
    }

    const elapsed = Date.now() - startTime;
    const waitMs  = Math.max(30000, delayMs - elapsed); // minimum 30s between posts

    console.log(`[ACC-${accId}] 😴 Sleeping ${Math.round(waitMs / 1000)}s until next post.`);
    await sleep(waitMs);
  }

  console.log(`[ACC-${accId}] 🛑 Loop stopped.`);
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
    const stagger = index * 60_000; // 1 min stagger between accounts
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
