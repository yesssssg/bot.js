import { chromium } from 'playwright';

let browser = null;
let page = null;
let isRunning = false;
let interval = null;

// This pulls the token safely from Railway's "Variables" tab
const X_AUTH_TOKEN = process.env.X_AUTH_TOKEN; 

const posts = [
  "Test looping post 1 🔥 Auto poster is live",
  "Test looping post 2 🚀 Keep it going",
  "Checking in... bot is running smoothly! 🤖",
  "Is Grok helping? Gemini is definitely on the job! 😉"
];

async function initBrowser() {
  console.log("[LOOP] Launching browser...");
  try {
    if (!X_AUTH_TOKEN) {
      console.error("[LOOP] ❌ ERROR: X_AUTH_TOKEN is missing in Railway Variables!");
      return false;
    }

    browser = await chromium.launch({ 
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    const context = await browser.newContext();
    
    // Injecting the session token to bypass login
    await context.addCookies([{
      name: "auth_token",
      value: X_AUTH_TOKEN,
      domain: ".x.com",
      path: "/",
      httpOnly: true,
      secure: true
    }]);

    page = await context.newPage();
    await page.setViewportSize({ width: 1280, height: 800 });
    console.log("[LOOP] ✅ Browser ready and session injected.");
    return true;
  } catch (e) {
    console.error("[LOOP] ❌ Browser init failed:", e.message);
    return false;
  }
}

async function postTweet(text) {
  try {
    if (!page || browser?.connected === false) {
      console.log("[LOOP] Browser closed or missing, restarting...");
      await initBrowser();
    }

    console.log(`[LOOP] Attempting to post: ${text.substring(0, 30)}...`);
    
    // Go directly to the compose box
    await page.goto('https://x.com/compose/tweet', { waitUntil: 'networkidle', timeout: 60000 });
    
    // Wait for the draft area to appear
    await page.waitForSelector('div[data-testid="tweetTextarea_0"]', { timeout: 20000 });
    await page.click('div[data-testid="tweetTextarea_0"]');
    await page.keyboard.type(text);
    
    // Click the Post button
    await page.waitForSelector('button[data-testid="tweetButton"]', { timeout: 10000 });
    await page.click('button[data-testid="tweetButton"]');
    
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
  if (isRunning) return console.log("[LOOP] Loop already running.");
  
  const ready = await initBrowser();
  if (!ready) return;

  isRunning = true;
  console.log(`[LOOP] 🔄 LOOP STARTED — Posting every ${delaySeconds}s`);
  
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
  console.log("[LOOP] ⛔ Loop stopped.");
}
