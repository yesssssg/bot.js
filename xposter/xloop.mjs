import { chromium } from 'playwright';

let browser = null;
let page = null;
let isRunning = false;
let interval = null;

const posts = [
  "Test looping post 1 🔥",
  "Test looping post 2 🚀 Auto poster working",
  "Test looping post 3 💀 Keep going",
  // Add your real posts here
];

async function initBrowser() {
  if (browser) return true;
  
  console.log("🚀 Launching browser for X login...");
  browser = await chromium.launch({ 
    headless: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  
  page = await browser.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });
  console.log("Browser launched. Login may be needed on first run.");
  return true;
}

async function postTweet(text) {
  try {
    await page.goto('https://x.com/compose/tweet', { waitUntil: 'networkidle', timeout: 30000 });
    
    await page.waitForSelector('div[data-testid="tweetTextarea_0"]', { timeout: 15000 });
    await page.click('div[data-testid="tweetTextarea_0"]');
    await page.keyboard.type(text);
    
    await page.waitForSelector('button[data-testid="tweetButton"]', { timeout: 10000 });
    await page.click('button[data-testid="tweetButton"]');
    
    console.log(`✅ Posted: ${text.substring(0, 60)}...`);
    return true;
  } catch (err) {
    console.error("❌ Failed to post:", err.message);
    return false;
  }
}

export async function startLoop(delaySeconds = 60) {
  if (isRunning) return console.log("✅ Loop is already running");
  
  await initBrowser();
  
  isRunning = true;
  const delayMs = delaySeconds * 1000;
  
  console.log(`🔄 Infinite loop started — posting every ${delaySeconds} seconds`);

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
  console.log("⛔ Loop stopped");
}

export async function shutdown() {
  if (browser) await browser.close();
}
