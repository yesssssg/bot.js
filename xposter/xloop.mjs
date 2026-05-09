import { chromium } from 'playwright';
import fs from 'fs';

let browser = null;
let page = null;
let isRunning = false;
let interval = null;

const COOKIE_PATH = './xposter/x-cookies.json';

const posts = [
  "Test looping post 1 🔥 Railway loop bot",
  "Test looping post 2 🚀 Still going strong",
  "Test looping post 3 💀 Free auto poster",
];

async function initBrowser() {
  console.log("[LOOP] Launching browser...");

  // Close old browser if exists
  if (browser) await browser.close().catch(() => {});

  browser = await chromium.launch({ 
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-background-networking'
    ]
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 }
  });
  page = await context.newPage();

  if (fs.existsSync(COOKIE_PATH)) {
    console.log("[LOOP] Loading cookies...");
    const cookies = JSON.parse(fs.readFileSync(COOKIE_PATH, 'utf8'));
    await context.addCookies(cookies);
  }

  console.log("[LOOP] ✅ Browser ready");
}

async function postTweet(text) {
  if (!page) return false;

  try {
    console.log(`[LOOP] → ${text.substring(0, 50)}...`);

    await page.goto('https://x.com/compose/tweet', { 
      waitUntil: 'domcontentloaded', 
      timeout: 25000 
    });

    await page.waitForSelector('div[data-testid="tweetTextarea_0"]', { timeout: 15000 });
    await page.click('div[data-testid="tweetTextarea_0"]');
    await page.keyboard.type(text);

    await page.waitForSelector('button[data-testid="tweetButton"]', { timeout: 10000 });
    await page.click('button[data-testid="tweetButton"]');

    console.log(`[LOOP] ✅ Posted successfully`);
    return true;
  } catch (err) {
    console.error("[LOOP] Post failed:", err.message);
    return false;
  }
}

export async function startLoop(delaySeconds = 60) {
  if (isRunning) return console.log("[LOOP] Already running");

  await initBrowser();
  
  isRunning = true;
  console.log(`[LOOP] 🔄 LOOP STARTED — every ${delaySeconds} seconds`);

  let index = 0;

  interval = setInterval(async () => {
    if (!isRunning) return;
    try {
      const text = posts[index % posts.length];
      await postTweet(text);
      index++;
    } catch (e) {
      console.error("[LOOP] Interval error:", e.message);
    }
  }, delaySeconds * 1000);
}

export function stopLoop() {
  if (interval) clearInterval(interval);
  isRunning = false;
  console.log("[LOOP] ⛔ Loop stopped");
}
