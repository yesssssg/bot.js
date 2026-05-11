import { chromium } from 'playwright';
import fs from 'fs';
import https from 'https';

let isRunning = false;
let lastImages = {}; 

const X_AUTH_TOKEN_RAW = process.env.X_AUTH_TOKEN || "";
const POST_TITLES_RAW = process.env.POST_TITLES || "";
const IMAGE_URL_RAW = process.env.IMAGE_URL || "";

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const getCycledItem = (arr, lastItem) => {
  if (arr.length <= 1) return arr[0];
  let newItem = arr[Math.floor(Math.random() * arr.length)];
  while (newItem === lastItem) {
    newItem = arr[Math.floor(Math.random() * arr.length)];
  }
  return newItem;
};

async function downloadImage(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'Referer': 'https://x.com/' 
      }
    };
    https.get(url, options, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`Download failed: ${res.statusCode}`));
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', (err) => { fs.unlink(dest, () => reject(err)); });
  });
}

async function postForAccount(token, titles, images, accId, delayMs) {
  const accountKey = `acc_${accId}`;
  
  while (isRunning) {
    const startTime = Date.now();
    const tempPath = `/tmp/img_${accId}_${Date.now()}.png`; // Force PNG for sharpness
    let browser = null;

    try {
      console.log(`[ACC-${accId}] 🚀 Cycle Start. Initializing HD session...`);
      
      browser = await chromium.launch({ 
        headless: true, 
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--single-process'] 
      });

      const context = await browser.newContext({
        viewport: { width: 1920, height: 1080 },
        deviceScaleFactor: 2, 
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
      });

      await context.addCookies([{
        name: "auth_token", value: token, domain: ".x.com", path: "/", httpOnly: true, secure: true
      }]);

      const page = await context.newPage();

      // Block fonts and ads to save RAM
      await page.route('**/*', (route) => {
        const type = route.request().resourceType();
        if (['font', 'media'].includes(type)) return route.abort();
        route.continue();
      });

      const selectedTitle = titles[Math.floor(Math.random() * titles.length)];
      const selectedImage = getCycledItem(images, lastImages[accountKey]);
      lastImages[accountKey] = selectedImage;

      await downloadImage(selectedImage, tempPath);

      console.log(`[ACC-${accId}] Opening Compose...`);
      await page.goto('https://x.com/compose/post', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(7000);

      // Uploading
      const fileInput = 'input[data-testid="fileInput"]';
      await page.waitForSelector(fileInput, { state: 'attached' });
      await (await page.$(fileInput)).setInputFiles(tempPath);
      
      console.log(`[ACC-${accId}] Uploading HD Image...`);
      await page.waitForSelector('div[data-testid="attachments"] img', { timeout: 40000 });
      await page.waitForTimeout(6000); // Wait for X to generate high-res IDs

      // Fill Text
      const textBox = 'div[data-testid="tweetTextarea_0"], div[role="textbox"]';
      await page.waitForSelector(textBox);
      await page.focus(textBox);
      await page.fill(textBox, selectedTitle);
      
      // Submit
      const submitBtn = 'button[data-testid="tweetButton"], button[data-testid="tweetButtonInline"]';
      await page.waitForFunction((sel) => {
        const btn = document.querySelector(sel);
        return btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true';
      }, submitBtn, { timeout: 20000 });

      await page.click(submitBtn);
      console.log(`[ACC-${accId}] Post clicked. Verifying...`);

      // VERIFICATION: Check if the compose box actually disappears or toast appears
      try {
        await Promise.race([
          page.waitForSelector('div[data-testid="toast"]', { timeout: 15000 }),
          page.waitForFunction(() => !document.querySelector('div[role="dialog"]'), { timeout: 15000 })
        ]);
        console.log(`[ACC-${accId}] ✅ Success! Post confirmed by X.`);
      } catch (e) {
        console.warn(`[ACC-${accId}] ⚠️ Post verification timed out. It might be shadow-hidden.`);
      }

    } catch (err) {
      console.error(`[ACC-${accId}] ❌ Error:`, err.message);
    } finally {
      if (browser) await browser.close().catch(() => {});
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    }

    const timeSpent = Date.now() - startTime;
    const nextTick = Math.max(60000, delayMs - timeSpent); 
    
    console.log(`[ACC-${accId}] 😴 Sleeping for ${Math.round(nextTick/1000)}s.`);
    await sleep(nextTick); 
  }
}

export async function startLoop(delaySeconds = 60) {
  if (isRunning) return;
  isRunning = true;

  const tokens = X_AUTH_TOKEN_RAW.split('|').filter(t => t.trim() !== "");
  const titles = POST_TITLES_RAW.split('|').map(t => t.trim());
  const images = IMAGE_URL_RAW.split('|').map(i => i.trim());

  tokens.forEach((token, index) => {
    setTimeout(() => {
      postForAccount(token.trim(), titles, images, index + 1, delaySeconds * 1000);
    }, index * 60000); 
  });
}

export function stopLoop() {
  isRunning = false;
  console.log("[SYSTEM] Shutting down loop...");
}
