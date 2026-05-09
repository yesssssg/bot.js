import { chromium } from 'playwright';
import fs from 'fs';

let browser = null;
let page = null;
let isRunning = false;
let interval = null;

const COOKIE_PATH = './xposter/x-cookies.json';

const posts = [
  "Test looping post 1 🔥 Working on Railway",
  "Test looping post 2 🚀 Free auto poster",
  "Test looping post 3 💀 Loop bot active",
];

async function initBrowser() {
  console.log("[LOOP] Launching new browser...");
  try {
    if (browser) await browser.close().catch(() => {});

    browser = await chromium.launch({ 
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--single-process']
    });

    const context = await browser.newContext();
    page = await context.newPage();
    await page.setViewportSize({ width: 1280, height: 800 });

    if (fs.existsSync(COOKIE_PATH)) {
      console.log("[LOOP] Loading cookies...");
      const cookies = JSON.parse(fs.readFileSync(COOKIE_PATH, 'utf8'));
      await context.addCookies(cookies);
    }

    console.log("[LOOP] ✅ Browser initialized");
  } catch (e) {
    console.error("[LOOP] ❌ Failed to init browser:", e.message);
  }
}

async function postTweet(text) {
  if (!page) {
    console.log("[LOOP] Page not ready, reinitializing...");
    await initBrowser();
    if (!page) return false;
  }

  try {
    console.log(`[LOOP] → Posting: ${text.substring(0, 50)}...`);
    
    await page.goto('https://x.com/compose/tweet', { 
      waitUntil: 'domcontentloaded', 
      timeout: 30000 
    });

    await page.waitForSelector('div[data-testid="tweetTextarea_0"]', { timeout: 15000 });
    await page.click('div[data-testid="tweetTextarea_0"]');
    await page.keyboard.type(text);

    await page.waitForSelector('button[data-testid="tweetButton"]', { timeout: 10000 });
    await page.click('button[data-testid="tweetButton"]');

    console.log(`[LOOP] ✅ Successfully posted!`);
    return true;
  } catch (err) {
    console.error("[LOOP] ❌ Post error:", err.message);
    return false;
  }
}

export async function startLoop(delaySeconds = 60) {
  if (isRunning) return console.log("[LOOP] Already running");

  await initBrowser();
  
  isRunning = true;
  console.log(`[LOOP] 🔄 LOOP STARTED — every ${delaySeconds}s`);

  let index = 0;

  interval = setInterval(async () => {
    if (!isRunning) return;
    const text = posts[index % posts.length];
    await postTweet(text);
    index++;
  }, delaySeconds * 1000);
}

export function stopLoop() {
  if (interval) clearInterval(interval);
  isRunning = false;
  console.log("[LOOP] ⛔ Loop stopped");
}
