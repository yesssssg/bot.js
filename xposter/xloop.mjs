import { chromium } from 'playwright';
import fs from 'fs';

let browser = null;
let page = null;
let isRunning = false;
let interval = null;

const COOKIE_PATH = './xposter/x-cookies.json';

const posts = [
  "Test looping post 1 🔥 Auto poster is live",
  "Test looping post 2 🚀 Keep it going",
  "Test looping post 3 💀 Free X loop bot",
  // ← Add your real posts here
];

async function initBrowser() {
  console.log("[LOOP] Launching browser...");
  browser = await chromium.launch({ 
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  page = await browser.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });

  // Load cookies if they exist
  if (fs.existsSync(COOKIE_PATH)) {
    console.log("[LOOP] Loading saved login cookies...");
    const cookies = JSON.parse(fs.readFileSync(COOKIE_PATH, 'utf8'));
    await page.context().addCookies(cookies);
  }

  console.log("[LOOP] ✅ Browser ready");
}

async function postTweet(text) {
  try {
    console.log(`[LOOP] Posting: ${text.substring(0, 60)}...`);
    await page.goto('https://x.com/compose/tweet', { waitUntil: 'networkidle', timeout: 45000 });

    await page.waitForSelector('div[data-testid="tweetTextarea_0"]', { timeout: 20000 });
    await page.click('div[data-testid="tweetTextarea_0"]');
    await page.keyboard.type(text);

    await page.waitForSelector('button[data-testid="tweetButton"]', { timeout: 15000 });
    await page.click('button[data-testid="tweetButton"]');

    console.log(`[LOOP] ✅ Posted successfully!`);
    return true;
  } catch (err) {
    console.error("[LOOP] ❌ Post failed:", err.message);
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
