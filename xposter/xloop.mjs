import { chromium } from 'playwright';

let browser = null;
let page = null;
let isRunning = false;
let interval = null;

const X_AUTH_TOKEN = process.env.X_AUTH_TOKEN; 

const posts = [
  "Test looping post 1 🔥 Auto poster is live",
  "Test looping post 2 🚀 Keep it going",
  "Checking in... bot is running smoothly! 🤖",
  "The loop is real. 🚀 #Automation"
];

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
      name: "auth_token",
      value: X_AUTH_TOKEN,
      domain: ".x.com",
      path: "/",
      httpOnly: true,
      secure: true
    }]);

    page = await context.newPage();
    console.log("[LOOP] ✅ Stealth browser ready.");
    return true;
  } catch (e) {
    console.error("[LOOP] ❌ Init failed:", e.message);
    return false;
  }
}

async function postTweet(text) {
  try {
    if (!page) await initBrowser();
    console.log(`[LOOP] Posting: ${text.substring(0, 30)}...`);
    
    await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Press Escape to clear any pop-ups (like "Enable Notifications")
    await page.keyboard.press('Escape');

    const postButtonSelector = [
      'div[data-testid="SideNav_NewTweet_Button"]',
      'a[aria-label="Post"]',
      'div[aria-label="Post"]'
    ].join(',');

    try {
      await page.waitForSelector(postButtonSelector, { timeout: 10000 });
      // FORCE CLICK the sidebar button
      await page.click(postButtonSelector, { force: true });
    } catch (e) {
      console.log("[LOOP] Sidebar button skipped, looking for box...");
    }

    const textBoxSelector = 'div[data-testid="tweetTextarea_0"], div[role="textbox"]';
    await page.waitForSelector(textBoxSelector, { timeout: 15000 });
    
    // FORCE CLICK the text area and type
    await page.click(textBoxSelector, { force: true });
    await page.keyboard.type(text, { delay: 100 });
    
    const submitBtn = 'button[data-testid="tweetButton"], button[data-testid="tweetButtonInline"]';
    await page.waitForSelector(submitBtn, { timeout: 10000 });
    await page.click(submitBtn, { force: true });
    
    console.log(`[LOOP] ✅ Posted successfully!`);
    return true;
  } catch (err) {
    console.error("[LOOP] ❌ Post failed:", err.message);
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
  console.log(`[LOOP] 🔄 STARTED — Posting every ${delaySeconds}s`);
  
  let index = 0;
  interval = setInterval(async () => {
    if (!isRunning) return;
    await postTweet(posts[index % posts.length]);
    index++;
  }, delaySeconds * 1000);
}

export function stopLoop() {
  if (interval) clearInterval(interval);
  isRunning = false;
  console.log("[LOOP] ⛔ Stopped.");
}
