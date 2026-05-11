import { chromium } from 'playwright';
import fs from 'fs';
import https from 'https';

let isRunning = false;
let lastImages = {}; 

const X_AUTH_TOKEN_RAW = process.env.X_AUTH_TOKEN || "";
const POST_TITLES_RAW = process.env.POST_TITLES || "";
const IMAGE_URL_RAW = process.env.IMAGE_URL || "";

const getCycledItem = (arr, lastItem) => {
  if (arr.length <= 1) return arr[0];
  let newItem = arr[Math.floor(Math.random() * arr.length)];
  while (newItem === lastItem) {
    newItem = arr[Math.floor(Math.random() * arr.length)];
  }
  return newItem;
};

// --- ADVANCED DOWNLOADER (Bypasses "Blurry" Thumbnail Links) ---
async function downloadImage(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
        'Referer': 'https://x.com/' 
      },
      timeout: 20000 
    };

    https.get(url, options, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`Download failed: ${res.statusCode}`));
      res.pipe(file);
      file.on('finish', () => {
        file.close();
        const stats = fs.statSync(dest);
        if (stats.size < 10240) console.warn(`[SYSTEM] Warning: Small image file (${(stats.size/1024).toFixed(2)}KB).`);
        resolve();
      });
    }).on('error', (err) => { fs.unlink(dest, () => reject(err)); });
  });
}

async function postForAccount(token, titles, images, accId, delayMs) {
  const accountKey = `acc_${accId}`;
  const tempPath = `/tmp/img_${accId}_${Date.now()}.jpg`;
  
  const run = async () => {
    if (!isRunning) return;
    const startTime = Date.now();
    let browser = null;

    try {
      console.log(`[ACC-${accId}] 🚀 Cycle Start. Initializing HD Browser...`);
      
      browser = await chromium.launch({ 
        headless: true, 
        args: [
          '--no-sandbox', 
          '--disable-setuid-sandbox', 
          '--disable-dev-shm-usage',
          '--single-process', 
          '--no-zygote'
        ] 
      });

      // --- VIEWPORT INJECTION (Forces X to Desktop HD Mode) ---
      const context = await browser.newContext({
        viewport: { width: 1920, height: 1080 },
        deviceScaleFactor: 2, 
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
      });

      await context.addCookies([{
        name: "auth_token", value: token, domain: ".x.com", path: "/", httpOnly: true, secure: true
      }]);

      const page = await context.newPage();

      // --- RESOURCE BLOCKER (Prevents 60s Timeouts) ---
      await page.route('**/*', (route) => {
        const type = route.request().resourceType();
        const url = route.request().url();
        if (['font', 'media'].includes(type)) return route.abort();
        if (type === 'image' && !url.includes('twimg.com')) return route.abort();
        if (url.includes('analytics') || url.includes('ads')) return route.abort();
        route.continue();
      });

      const selectedTitle = titles[Math.floor(Math.random() * titles.length)];
      const selectedImage = getCycledItem(images, lastImages[accountKey]);
      lastImages[accountKey] = selectedImage;

      await downloadImage(selectedImage, tempPath);

      // 1. Direct Navigation
      console.log(`[ACC-${accId}] Navigating to Compose...`);
      await page.goto('https://x.com/compose/post', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(7000);

      // 2. Upload
      const fileInput = 'input[data-testid="fileInput"]';
      await page.waitForSelector(fileInput, { state: 'attached' });
      await (await page.$(fileInput)).setInputFiles(tempPath);
      
      console.log(`[ACC-${accId}] Uploading HD Image...`);
      await page.waitForSelector('div[data-testid="attachments"] img', { timeout: 40000 });
      
      // WAIT FOR PROCESSING (Crucial for HD)
      await page.waitForTimeout(5000); 

      // 3. Text Input (Focus/Fill bypasses pointer errors)
      const textBox = 'div[data-testid="tweetTextarea_0"], div[role="textbox"]';
      await page.waitForSelector(textBox);
      await page.focus(textBox);
      await page.fill(textBox, selectedTitle);
      
      // 4. Submit with Fallback
      const submitBtn = 'button[data-testid="tweetButton"], button[data-testid="tweetButtonInline"]';
      try {
        await page.waitForFunction((sel) => {
          const btn = document.querySelector(sel);
          return btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true';
        }, submitBtn, { timeout: 15000 });
      } catch (e) {
        console.log(`[ACC-${accId}] Button state stuck, forcing click...`);
      }

      await page.click(submitBtn, { force: true });
      
      console.log(`[ACC-${accId}] Post sent. Finalizing...`);
      await page.waitForTimeout(12000); 
      console.log(`[ACC-${accId}] ✅ Success!`);

    } catch (err) {
      console.error(`[ACC-${accId}] ❌ Error:`, err.message);
    } finally {
      // FULL CLEANUP (Resets RAM to 0)
      if (browser) await browser.close().catch(() => {});
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      
      if (isRunning) {
        const timeSpent = Date.now() - startTime;
        const nextTick = Math.max(30000, delayMs - timeSpent);
        console.log(`[ACC-${accId}] RAM Reset. Next post in ${Math.round(nextTick/1000)}s.`);
        setTimeout(run, nextTick);
      }
    }
  };

  run();
}

export async function startLoop(delaySeconds = 60) {
  if (isRunning) return;
  isRunning = true;

  const tokens = X_AUTH_TOKEN_RAW.split('|').filter(t => t.trim() !== "");
  const titles = POST_TITLES_RAW.split('|').map(t => t.trim());
  const images = IMAGE_URL_RAW.split('|').map(i => i.trim());

  tokens.forEach((token, index) => {
    // 60s stagger to prevent CPU spikes
    setTimeout(() => {
      postForAccount(token.trim(), titles, images, index + 1, delaySeconds * 1000);
    }, index * 60000);
  });
}

export function stopLoop() {
  isRunning = false;
  console.log("[SYSTEM] Shutdown initiated.");
}
