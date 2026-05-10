import { chromium } from 'playwright';
import fs from 'fs';
import https from 'https';
import path from 'path';

let browser = null;
let page = null;
let isRunning = false;
let interval = null;

const X_AUTH_TOKEN = process.env.X_AUTH_TOKEN;
const getRandom = (arr) => arr[Math.floor(Math.random() * arr.length)];

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

async function initBrowser() {
  console.log("[LOOP] Starting browser...");
  try {
    browser = await chromium.launch({ 
      headless: true, 
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] 
    });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    });
    await context.addCookies([{
      name: "auth_token", value: X_AUTH_TOKEN, domain: ".x.com", path: "/", httpOnly: true, secure: true
    }]);
    page = await context.newPage();
    return true;
  } catch (e) {
    console.error("[LOOP] Browser init failed:", e.message);
    return false;
  }
}

async function postToX() {
  const titles = (process.env.POST_TITLES || "Default").split('|').map(t => t.trim());
  const images = (process.env.IMAGE_URL || "").split('|').map(i => i.trim());
  const selectedTitle = getRandom(titles);
  const selectedImage = getRandom(images);
  const tempPath = `/tmp/img_${Date.now()}.jpg`;

  try {
    if (!page || browser?.isConnected() === false) await initBrowser();
    
    console.log(`[LOOP] Downloading image...`);
    await downloadImage(selectedImage, tempPath);

    await page.goto('https://x.com/home', { waitUntil: 'networkidle', timeout: 60000 });
    await page.keyboard.press('Escape');

    // 1. Click Post Button
    const postBtn = 'a[aria-label="Post"], div[data-testid="SideNav_NewTweet_Button"]';
    await page.waitForSelector(postBtn, { timeout: 20000 });
    await page.click(postBtn, { force: true });

    // 2. Upload Image (Wait longer for the hidden input)
    const fileInput = 'input[data-testid="fileInput"]';
    await page.waitForSelector(fileInput, { state: 'attached', timeout: 20000 });
    const handle = await page.$(fileInput);
    
    if (handle) {
      await handle.setInputFiles(tempPath);
      console.log("[LOOP] Image attached.");
      // Small pause to let the image "process" on X
      await page.waitForTimeout(3000); 
    } else {
      throw new Error("Could not find file input handle");
    }

    // 3. Type Title
    const textBox = 'div[data-testid="tweetTextarea_0"], div[role="textbox"]';
    await page.waitForSelector(textBox, { timeout: 15000 });
    await page.click(textBox, { force: true });
    await page.keyboard.type(selectedTitle, { delay: 50 });

    // 4. Submit
    const submitBtn = 'button[data-testid="tweetButton"]';
    await page.waitForSelector(submitBtn, { state: 'visible', timeout: 15000 });
    await page.click(submitBtn, { force: true });

    console.log(`[LOOP] ✅ Success!`);
    await page.waitForTimeout(2000); // Wait for post to finish
    
  } catch (err) {
    console.error("[LOOP] ❌ Error:", err.message);
    if (browser) await browser.close();
    page = null;
  } finally {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }
}

export async function startLoop(delaySeconds = 60) {
  if (isRunning) return;
  const ready = await initBrowser();
  if (!ready) return;
  isRunning = true;
  console.log(`[LOOP] 🔄 STARTED (Every ${delaySeconds}s)`);
  interval = setInterval(async () => {
    if (isRunning) await postToX();
  }, delaySeconds * 1000);
}

export function stopLoop() {
  if (interval) clearInterval(interval);
  isRunning = false;
  console.log("[LOOP] ⛔ Stopped.");
}
