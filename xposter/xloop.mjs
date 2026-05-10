import { chromium } from 'playwright';
import fs from 'fs';
import https from 'https';
import path from 'path';

let browser = null;
let page = null;
let isRunning = false;
let interval = null;

const X_AUTH_TOKEN = process.env.X_AUTH_TOKEN;

// Helper to get random item from array
const getRandom = (arr) => arr[Math.floor(Math.random() * arr.length)];

async function downloadImage(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`Download failed: ${response.statusCode}`));
        return;
      }
      response.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', (err) => {
      fs.unlink(dest, () => reject(err));
    });
  });
}

async function initBrowser() {
  console.log("[LOOP] Launching stealth browser...");
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
    console.error("[LOOP] ❌ Init failed:", e.message);
    return false;
  }
}

async function postToX() {
  // Re-read variables inside the function so you can update Railway without restarting the bot
  const titles = (process.env.POST_TITLES || "Default").split('|').map(t => t.trim());
  const images = (process.env.IMAGE_URL || "").split('|').map(i => i.trim());
  
  const selectedTitle = getRandom(titles);
  const selectedImage = getRandom(images);
  const tempPath = `/tmp/img_${Date.now()}.jpg`;

  try {
    if (!page) await initBrowser();
    
    console.log(`[LOOP] Random Pick: "${selectedTitle.substring(0, 20)}..." with a random image.`);
    await downloadImage(selectedImage, tempPath);

    await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.keyboard.press('Escape');

    const postBtn = 'a[aria-label="Post"], div[data-testid="SideNav_NewTweet_Button"]';
    await page.waitForSelector(postBtn, { timeout: 15000 });
    await page.click(postBtn, { force: true });

    const fileInput = 'input[data-testid="fileInput"]';
    await page.waitForSelector(fileInput, { state: 'attached', timeout: 15000 });
    const handle = await page.$(fileInput);
    await handle.setInputFiles(tempPath);

    const textBox = 'div[data-testid="tweetTextarea_0"], div[role="textbox"]';
    await page.waitForSelector(textBox, { timeout: 15000 });
    await page.click(textBox, { force: true });
    await page.keyboard.type(selectedTitle, { delay: 50 });

    const submitBtn = 'button[data-testid="tweetButton"]';
    await page.waitForSelector(submitBtn, { timeout: 15000 });
    await page.click(submitBtn, { force: true });

    console.log(`[LOOP] ✅ Successfully posted random combo!`);
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    return true;
  } catch (err) {
    console.error("[LOOP] ❌ Error:", err.message);
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    if (browser) await browser.close();
    page = null;
    return false;
  }
}

export async function startLoop(delaySeconds = 60) {
  if (isRunning) return;
  const ready = await initBrowser();
  if (!ready) return;

  isRunning = true;
  console.log(`[LOOP] 🔄 RANDOM MODE STARTED — Posting every ${delaySeconds}s`);

  interval = setInterval(async () => {
    if (!isRunning) return;
    await postToX();
  }, delaySeconds * 1000);
}

export function stopLoop() {
  if (interval) clearInterval(interval);
  isRunning = false;
  console.log("[LOOP] ⛔ Stopped.");
}
