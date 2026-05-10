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
  if (browser) {
    try { await browser.close(); } catch (e) {}
  }
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
  const selectedTitle = getRandom(titles);
  const selectedImage = getRandom(images);
  const tempPath = `/tmp/img_${Date.now()}.jpg`;

  try {
    await initBrowser();
    console.log(`[LOOP] Attempting post: ${selectedTitle.substring(0, 15)}...`);
    
    await downloadImage(selectedImage, tempPath);

    // Use domcontentloaded - much faster than networkidle
    await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 60000 });
    
    // Wait for the main UI to exist
    const postBtn = 'a[aria-label="Post"], div[data-testid="SideNav_NewTweet_Button"]';
    await page.waitForSelector(postBtn, { timeout: 30000 });
    await page.keyboard.press('Escape');
    await page.click(postBtn, { force: true });

    const fileInput = 'input[data-testid="fileInput"]';
    await page.waitForSelector(fileInput, { state: 'attached', timeout: 15000 });
    const handle = await page.$(fileInput);
    await handle.setInputFiles(tempPath);
    console.log("[LOOP] Image attached.");

    // Wait for text box
    const textBox = 'div[data-testid="tweetTextarea_0"], div[role="textbox"]';
    await page.waitForSelector(textBox, { timeout: 15000 });
    await page.click(textBox, { force: true });
    await page.keyboard.type(selectedTitle, { delay: 50 });

    // Wait for button to be clickable (image processing)
    const submitBtn = 'button[data-testid="tweetButton"]';
    await page.waitForTimeout(4000); 
    await page.click(submitBtn, { force: true });

    console.log(`[LOOP] ✅ Success!`);
    await page.waitForTimeout(3000); 
    
  } catch (err) {
    console.error("[LOOP] ❌ Error:", err.message);
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
  console.log(`[LOOP] 🔄 STARTED (Every ${delaySeconds}s)`);
  
  // Self-correcting loop to prevent overlap
  const run = async () => {
    if (!isRunning) return;
    await postToX();
    if (isRunning) setTimeout(run, delaySeconds * 1000);
  };
  run();
}

export function stopLoop() {
  isRunning = false;
  console.log("[LOOP] ⛔ Stopped.");
}
