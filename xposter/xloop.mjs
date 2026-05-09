import { chromium } from 'playwright';

let browser = null;
let page = null;
let isRunning = false;
let interval = null;

const posts = [
  "Test looping post 1 🔥 Auto poster working",
  "Test looping post 2 🚀 Keep it going",
  "Test looping post 3 💀 Free X loop bot",
  // Add your real posts here
];

async function initBrowser() {
  console.log("[LOOP] Launching browser...");
  try {
    browser = await chromium.launch({ 
      headless: true,
      args: [
        '--no-sandbox', 
        '--disable-setuid-sandbox', 
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    });
    page = await browser.newPage();
    await page.setViewportSize({ width: 1280, height: 800 });
    console.log("[LOOP] ✅ Browser launched successfully");
    return true;
  } catch (e) {
    console.error("[LOOP] ❌ Browser launch failed:", e.message);
    throw e;
  }
}

async function postTweet(text) {
  try {
    console.log(`[LOOP] Trying to post: ${text.substring(0, 50)}...`);
    await page.goto('https://x.com/compose/tweet', { waitUntil: 'networkidle', timeout: 30000 });
    
    await page.waitForSelector('div[data-testid="tweetTextarea_0"]', { timeout: 15000 });
    await page.click('div[data-testid="tweetTextarea_0"]');
    await page.keyboard.type(text);
    
    await page.waitForSelector('button[data-testid="tweetButton"]', { timeout: 10000 });
    await page.click('button[data-testid="tweetButton"]');
    
    console.log(`[LOOP] ✅ Successfully posted: ${text.substring(0, 60)}...`);
    return true;
  } catch (err) {
    console.error("[LOOP] ❌ Post failed:", err.message);
    return false;
  }
}

export async function startLoop(delaySeconds = 60) {
  if (isRunning) {
    console.log("[LOOP] Loop is already running");
    return;
  }

  await initBrowser();
  
  isRunning = true;
  const delayMs = delaySeconds * 1000;
  console.log(`[LOOP] 🔄 Infinite loop STARTED — posting every ${delaySeconds} seconds`);

  let index = 0;

  interval = setInterval(async () => {
    if (!isRunning) return;
    const text = posts[index % posts.length];
    await postTweet(text);
    index++;
  }, delayMs);
}

export function stopLoop() {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
  isRunning = false;
  console.log("[LOOP] ⛔ Loop stopped");
}

export async function shutdown() {
  if (browser) await browser.close();
}
