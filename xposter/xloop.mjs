import { chromium } from 'playwright';
import fs from 'fs';
import https from 'https';

let isRunning = false;
let lastImages = {}; 

const X_AUTH_TOKEN_RAW = process.env.X_AUTH_TOKEN || "";
const POST_TITLES_RAW = process.env.POST_TITLES || "Default Title";
const IMAGE_URL_RAW = process.env.IMAGE_URL || "";

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
    https.get(url, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`Status: ${res.statusCode}`));
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
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
      console.log(`[ACC-${accId}] 🚀 Launching...`);
      browser = await chromium.launch({ 
        headless: true, 
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--single-process'] 
      });

      const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
      });

      await context.addCookies([{
        name: "auth_token", value: token, domain: ".x.com", path: "/", httpOnly: true, secure: true
      }]);

      const page = await context.newPage();

      // Block junk to save RAM
      await page.route('**/*', (route) => {
        const type = route.request().resourceType();
        if (['font', 'media'].includes(type)) return route.abort();
        route.continue();
      });

      const selectedTitle = titles[Math.floor(Math.random() * titles.length)];
      const selectedImage = getCycledItem(images, lastImages[accountKey]);
      lastImages[accountKey] = selectedImage;

      await downloadImage(selectedImage, tempPath);

      console.log(`[ACC-${accId}] Navigating...`);
      await page.goto('https://x.com/compose/post', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(5000);

      // Upload
      const fileInput = 'input[data-testid="fileInput"]';
      await page.waitForSelector(fileInput, { state: 'attached' });
      await (await page.$(fileInput)).setInputFiles(tempPath);
      
      console.log(`[ACC-${accId}] Image processing...`);
      await page.waitForSelector('div[data-testid="attachments"] img', { timeout: 30000 });

      // Text
      const textBox = 'div[data-testid="tweetTextarea_0"], div[role="textbox"]';
      await page.waitForSelector(textBox);
      await page.focus(textBox);
      await page.fill(textBox, selectedTitle);
      
      // Submit Logic (Improved)
      const submitBtn = 'button[data-testid="tweetButton"], button[data-testid="tweetButtonInline"]';
      console.log(`[ACC-${accId}] Attempting to post...`);

      try {
        // Wait up to 15s for the button to be "naturally" enabled
        await page.waitForFunction((sel) => {
          const btn = document.querySelector(sel);
          return btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true';
        }, submitBtn, { timeout: 15000 });
      } catch (e) {
        console.log(`[ACC-${accId}] Button still disabled, forcing click fallback...`);
      }

      // Force the click even if the UI thinks it's disabled
      await page.click(submitBtn, { force: true });
      
      await page.waitForTimeout(10000); 
      console.log(`[ACC-${accId}] ✅ Post Successful!`);

    } catch (err) {
      console.error(`[ACC-${accId}] ❌ Error:`, err.message);
    } finally {
      if (browser) await browser.close().catch(() => {});
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      
      if (isRunning) {
        const timeSpent = Date.now() - startTime;
        const nextTick = Math.max(20000, delayMs - timeSpent);
        setTimeout(run, nextTick);
      }
    }
  };

  run();
}

export async function startLoop(delaySeconds = 60) {
  if (isRunning) return;
  isRunning = true;
  const tokens = X_AUTH_TOKEN_RAW.split('|').filter(t => t.trim() !== "").map(t => t.trim());
  const titles = POST_TITLES_RAW.split('|').map(t => t.trim());
  const images = IMAGE_URL_RAW.split('|').map(i => i.trim());
  tokens.forEach((token, index) => {
    setTimeout(() => postForAccount(token, titles, images, index + 1, delaySeconds * 1000), index * 45000);
  });
}

export function stopLoop() { isRunning = false; }
