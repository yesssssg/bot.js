import { chromium } from 'playwright';
import fs from 'fs';
import https from 'https';
import path from 'path';

let browser = null;
let page = null;
let isRunning = false;
let lastImage = null; // Memory to prevent back-to-back duplicates

const X_AUTH_TOKEN = process.env.X_AUTH_TOKEN;

// Helper to get a random item that ISN'T the last one used
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

async function initBrowser() {
  console.log("[LOOP] Launching browser...");
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
}

async function postToX() {
  const titles = (process.env.POST_TITLES || "Default").split('|').map(t => t.trim());
  const images = (process.env.IMAGE_URL || "").split('|').map(i => i.trim());
  
  const selectedTitle = titles[Math.floor(Math.random() * titles.length)];
  const selectedImage = getCycledItem(images, lastImage);
  lastImage = selectedImage; // Store for next time
  
  const tempPath = `/tmp/img_${Date.now()}.jpg`;

  try {
    await initBrowser();
    console.log(`[LOOP] Posting: "${selectedTitle.substring(0, 20)}..."`);
    
    await downloadImage(selectedImage, tempPath);

    await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 60000 });
    
    const postBtn = 'a[aria-label="Post"], div[data-testid="SideNav_NewTweet_Button"]';
    await page.waitForSelector(postBtn, { timeout: 30000 });
    await page.keyboard.press('Escape');
    await page.click(postBtn, { force: true });

    const fileInput = 'input[data-testid="fileInput"]';
    await page.waitForSelector(fileInput, { state: 'attached', timeout: 15000 });
    const handle = await page.$(fileInput);
    
    // Safety: ensure it's always using an image
    if (!handle) throw new Error("File input not found - cannot upload image.");
    
    await handle.setInputFiles(tempPath);
    console.log("[LOOP] Image attached.");

    const textBox = 'div[data-testid="tweetTextarea_0"], div[role="textbox"]';
    await page.waitForSelector(textBox, { timeout: 15000 });
    await page.click(textBox, { force: true });
    await page.keyboard.type(selectedTitle, { delay: 50 });

    const submitBtn = 'button[data-testid="tweetButton"]';
    await page.waitForTimeout(4000); // Wait for image processing
    await page.click(submitBtn, { force: true });

    console.log(`[LOOP] ✅ Successfully posted.`);
    await page.waitForTimeout(3000); 
    
  } catch (err) {
    console.error("[LOOP] ❌ Error during post logic:", err.message);
  } finally {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    if (browser) await browser.close();
    browser = null;
    page = null;
  }
}

export async function startLoop(delaySeconds = 60) {
  if (isRunning) return;
  isRunning = true;
  
  // Convert delay to milliseconds
  const msDelay = delaySeconds * 1000;
  console.log(`[LOOP] 🔄 STARTED - Frequency: ${delaySeconds} seconds.`);

  const loop = async () => {
    if (!isRunning) return;
    
    const startTime = Date.now();
    await postToX(); // Do the work
    const endTime = Date.now();
    
    // Calculate how long the post took and subtract it from the delay 
    // to keep the timing as accurate as possible.
    const timeSpent = endTime - startTime;
    const remainingDelay = Math.max(0, msDelay - timeSpent);

    if (isRunning) {
        console.log(`[LOOP] Waiting ${remainingDelay / 1000}s until next post...`);
        setTimeout(loop, remainingDelay);
    }
  };

  loop();
}

export function stopLoop() {
  isRunning = false;
  console.log("[LOOP] ⛔ Stopped.");
}
