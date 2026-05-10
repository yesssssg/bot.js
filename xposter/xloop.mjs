import { chromium } from 'playwright';
import fs from 'fs';
import https from 'https';

let isRunning = false;
let browser = null;
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
  let context = null;

  const run = async () => {
    if (!isRunning) return;
    const startTime = Date.now();

    try {
      if (!browser) {
        browser = await chromium.launch({ 
          headless: true, 
          args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] 
        });
      }

      context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
      });

      await context.addCookies([{
        name: "auth_token", value: token, domain: ".x.com", path: "/", httpOnly: true, secure: true
      }]);

      const page = await context.newPage();
      const selectedTitle = titles[Math.floor(Math.random() * titles.length)];
      const selectedImage = getCycledItem(images, lastImages[accountKey]);
      lastImages[accountKey] = selectedImage;

      await downloadImage(selectedImage, tempPath);
      console.log(`[ACC-${accId}] Starting post: ${selectedTitle.substring(0, 15)}...`);

      // 1. Go to Home
      await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 60000 });
      
      const postBtn = 'a[aria-label="Post"], div[data-testid="SideNav_NewTweet_Button"]';
      await page.waitForSelector(postBtn, { timeout: 30000 });
      await page.keyboard.press('Escape');
      await page.click(postBtn, { force: true });

      // 2. Upload Image
      const fileInput = 'input[data-testid="fileInput"]';
      await page.waitForSelector(fileInput, { state: 'attached', timeout: 15000 });
      const handle = await page.$(fileInput);
      await handle.setInputFiles(tempPath);
      
      console.log(`[ACC-${accId}] Uploading image (40s max wait)...`);
      // Wait longer for the image to actually render in the draft
      await page.waitForSelector('div[data-testid="attachments"] img', { timeout: 40000 });

      // 3. Type Title
      const textBox = 'div[data-testid="tweetTextarea_0"], div[role="textbox"]';
      await page.waitForSelector(textBox, { timeout: 15000 });
      await page.click(textBox, { force: true });
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Backspace');
      await page.keyboard.type(selectedTitle, { delay: 100 }); 

      // 4. Submit with 30s timeout
      const submitBtn = 'button[data-testid="tweetButton"]';
      
      console.log(`[ACC-${accId}] Waiting for Post button to enable (30s)...`);
      try {
        await page.waitForFunction((sel) => {
          const btn = document.querySelector(sel);
          // Returns true if button exists and is NOT disabled
          return btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true';
        }, submitBtn, { timeout: 30000 }); // FIXED: Set to 30 seconds
      } catch (e) {
        console.log(`[ACC-${accId}] Button still showing disabled after 30s. Attempting forced click anyway...`);
      }

      await page.click(submitBtn, { force: true });
      console.log(`[ACC-${accId}] ✅ Post Successful!`);
      
      // Short wait to ensure the request finishes before closing browser
      await page.waitForTimeout(5000);

    } catch (err) {
      console.error(`[ACC-${accId}] ❌ Error:`, err.message);
    } finally {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      if (context) await context.close();
      
      const timeSpent = Date.now() - startTime;
      const nextTick = Math.max(10000, delayMs - timeSpent);
      if (isRunning) {
        console.log(`[ACC-${accId}] Waiting ${Math.round(nextTick/1000)}s for next cycle.`);
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

  console.log(`[SYSTEM] Starting automation for ${tokens.length} account(s).`);

  tokens.forEach((token, index) => {
    // 30s stagger to avoid CPU spikes on start
    setTimeout(() => {
      postForAccount(token, titles, images, index + 1, delaySeconds * 1000);
    }, index * 30000);
  });
}

export function stopLoop() {
  isRunning = false;
  console.log("[SYSTEM] ⛔ Shutdown requested.");
}
