import { TwitterApi } from 'twitter-api-v2';
import * as fs from 'fs';
import * as path from 'path';

// ─────────────────────────────────────────
//  CONFIG - EDIT HERE
// ─────────────────────────────────────────

const postTitles = [
  "Test post from Railway 🚀",
  "This is working perfectly!",
  "Auto poster is live 🔥",
  // Add as many titles as you want
];

const useImage = false;                    // Change to true when you add image.jpg
const imagePath = "./xposter/image.jpg";

// ─────────────────────────────────────────
//  MAIN CODE (Do not edit below)
// ─────────────────────────────────────────

const client = new TwitterApi({
  appKey:       process.env.TWITTER_API_KEY,
  appSecret:    process.env.TWITTER_API_SECRET,
  accessToken:  process.env.TWITTER_ACCESS_TOKEN,
  accessSecret: process.env.TWITTER_ACCESS_SECRET,
});

const rwClient = client.readWrite;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function uploadImage() {
  if (!useImage) return null;
  try {
    const absolutePath = path.resolve(imagePath);
    if (!fs.existsSync(absolutePath)) {
      console.log("⚠️ Image not found, posting text only.");
      return null;
    }
    console.log("📸 Uploading image...");
    const mediaId = await rwClient.v1.uploadMedia(absolutePath);
    console.log("✅ Image uploaded");
    return mediaId;
  } catch (e) {
    console.log("⚠️ Image upload failed:", e.message);
    return null;
  }
}

async function run() {
  // Read values sent by the bot (!xpost command)
  const postCount = parseInt(process.env.POST_COUNT) || postTitles.length || 1;
  const delayMs   = parseInt(process.env.POST_DELAY_MS) || 5000;

  console.log(`🚀 X Poster Started - ${postCount} posts, ${delayMs/1000}s delay`);

  const mediaId = await uploadImage();

  for (let i = 0; i < postCount; i++) {
    const text = postTitles[i % postTitles.length] || `Post ${i+1}`;

    console.log(`\n[${i+1}/${postCount}] Posting: ${text}`);

    try {
      const options = { text: text };
      if (mediaId) options.media = { media_ids: [mediaId] };

      const tweet = await rwClient.v2.tweet(options);
      console.log(`✅ Posted! → https://x.com/i/web/status/${tweet.data.id}`);
    } catch (err) {
      console.error(`❌ Error posting:`, err.message);
    }

    if (i < postCount - 1) {
      console.log(`⏳ Waiting ${delayMs/1000} seconds...`);
      await sleep(delayMs);
    }
  }

  console.log(`\n🎉 Finished posting ${postCount} tweets!`);
}

run().catch(err => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
