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
  "Gemini is helping me stay online! 😉"
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
    
    // 1. Go to the home page
    await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 60000 });

    // 2. Try to find the "Post" button using multiple possible IDs
    const postButtonSelector = [
      'div[data-testid="SideNav_NewTweet_Button"]',
      'a[aria-label="Post"]',
      'div[aria-label="Post"]',
      'nav[aria-label="Primary"] [role="button"]'
    ].join(',');

    try {
      await page.waitForSelector(postButtonSelector, { timeout: 10000 });
      await page.click(postButtonSelector);
    } catch (e) {
      console.log("[LOOP] Sidebar button not found, checking if text box is already open...");
    }

    // 3. Wait for the text box (using multiple possible selectors)
    const textBoxSelector = 'div[data-testid="tweetTextarea_0"], div[role="textbox"]';
    await page.waitForSelector(textBoxSelector, { timeout: 15000 });
    await page.click(textBoxSelector);
    await page.keyboard.type(text, { delay: 100 });
    
    // 4. Click the final Post button
    const submitBtn = 'button[data-testid="tweetButton"], button[data-testid="tweetButtonInline"]';
    await page.waitForSelector(submitBtn, { timeout: 10000 });
    await page.click(submitBtn);
    
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
