import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let browser = null;
let page = null;
let isRunning = false;
let interval = null;

const X_AUTH_TOKEN = process.env.X_AUTH_TOKEN; 

// --- EDIT YOUR CONTENT HERE ---


const postTitles = [ "SOPHIE RAIN BARES ALL: HER MOST INTIMATE LEAK VIDEO NOW ON DISCORD👇 discord.gg/23mMXGstnT",

"THE SOPHIE RAIN LEAK THAT WILL CHANGE EVERYTHING - FULL VIDEO IN DISCORD👇 discord.gg/23mMXGstnT",

"SOPHIE RAIN'S UNSEEN MOMENTS - FULL LEAK VIDEO AVAILABLE ON DISCORD👇 discord.gg/23mMXGstnT",

"SOPHIE RAIN'S ULTIMATE LEAK - WATCH THE FULL VIDEO ON DISCORD👇 discord.gg/23mMXGstnT",

"THE SCANDALOUS SOPHIE RAIN LEAK YOU WON'T WANT TO MISS - FULL VIDEO IN DISCORD👇 discord.gg/23mMXGstnT",

"SOPHIE RAIN'S NIKE PRO LEAK UNCOVERED IN DISCORD👇 discord.gg/23mMXGstnT",

"THE WAIT IS OVER: SOPHIE RAIN'S FULL LEAK VIDEO IS NOW LIVE ON DISCORD👇 discord.gg/23mMXGstnT",

"SOPHIE RAIN'S HIDDEN ASSETS EXPOSED IN DISCORD👇 discord.gg/23mMXGstnT",

"SOPHIE RAIN'S LEAK OF THE CENTURY - WATCH THE FULL VIDEO ON DISCORD👇 discord.gg/23mMXGstnT",

"THE SHOCKING SOPHIE RAIN LEAK THAT WILL MAKE YOUR JAW DROP - FULL VIDEO IN DISCORD👇 discord.gg/23mMXGstnT" ];
// Put the exact name of your image file here (must be in the xposter folder)
const STATIC_IMAGE_NAME = "IMG_1822.jpeg"; 
// ----------------------------

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

async function postToX(title, imageName) {
  try {
    if (!page) await initBrowser();
    console.log(`[LOOP] Preparing post: "${title}" with static image: ${imageName}`);

    await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.keyboard.press('Escape');

    // 1. Open Compose
    const postBtn = 'a[aria-label="Post"], div[data-testid="SideNav_NewTweet_Button"]';
    await page.waitForSelector(postBtn, { timeout: 15000 });
    await page.click(postBtn, { force: true });

    // 2. Upload the Static Image
    const imagePath = path.join(__dirname, imageName);
    const fileInputSelector = 'input[data-testid="fileInput"]';
    await page.waitForSelector(fileInputSelector, { state: 'attached', timeout: 15000 });
    const handle = await page.$(fileInputSelector);
    await handle.setInputFiles(imagePath);
    console.log(`[LOOP] Image attached.`);

    // 3. Type Title
    const textBox = 'div[data-testid="tweetTextarea_0"], div[role="textbox"]';
    await page.waitForSelector(textBox, { timeout: 15000 });
    await page.click(textBox, { force: true });
    await page.keyboard.type(title, { delay: 50 });

    // 4. Submit
    const submitBtn = 'button[data-testid="tweetButton"]';
    await page.waitForSelector(submitBtn, { timeout: 15000 });
    await page.click(submitBtn, { force: true });

    console.log(`[LOOP] ✅ Successfully posted!`);
    return true;
  } catch (err) {
    console.error("[LOOP] ❌ Failed to post:", err.message);
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
  console.log(`[LOOP] 🔄 STARTED — Cycling titles with static image every ${delaySeconds}s`);

  let index = 0;
  interval = setInterval(async () => {
    if (!isRunning) return;
    
    const currentTitle = postTitles[index % postTitles.length];
    
    // Always passes STATIC_IMAGE_NAME
    await postToX(currentTitle, STATIC_IMAGE_NAME);
    index++;
  }, delaySeconds * 1000);
}

export function stopLoop() {
  if (interval) clearInterval(interval);
  isRunning = false;
  console.log("[LOOP] ⛔ Stopped.");
}
