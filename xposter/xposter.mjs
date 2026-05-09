import { TwitterApi } from 'twitter-api-v2';
import * as fs from 'fs';
import * as path from 'path';

// CONFIG
const postTitles = ["Test post from Railway 🚀"];
const useImage = false;
const imagePath = "./xposter/image.jpg";

// MAIN CODE
const client = new TwitterApi({
  appKey:       process.env.TWITTER_API_KEY,
  appSecret:    process.env.TWITTER_API_SECRET,
  accessToken:  process.env.TWITTER_ACCESS_TOKEN,
  accessSecret: process.env.TWITTER_ACCESS_SECRET,
});

const rwClient = client.readWrite;

async function run() {
  const postCount = parseInt(process.env.POST_COUNT) || 1;
  const delayMs   = parseInt(process.env.POST_DELAY_MS) || 5000;

  console.log(`🚀 X Poster Started → ${postCount} posts`);

  for (let i = 0; i < postCount; i++) {
    const text = postTitles[i % postTitles.length];

    console.log(`\n[${i+1}/${postCount}] Trying to post: ${text}`);

    try {
      const tweet = await rwClient.v2.tweet({ text });
      console.log(`✅ SUCCESS! Tweet ID: ${tweet.data.id}`);
      console.log(`🔗 https://x.com/i/web/status/${tweet.data.id}`);
    } catch (err) {
      console.error(`❌ FULL ERROR:`);
      console.error(err);

      if (err.data) {
        console.error("Response Data:", JSON.stringify(err.data, null, 2));
      }
    }
  }

  console.log(`\n🎉 Finished!`);
}

run().catch(err => {
  console.error("Fatal crash:", err);
});
