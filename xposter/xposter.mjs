import { TwitterApi } from 'twitter-api-v2';
import * as fs from 'fs';
import * as path from 'path';

// ─────────────────────────────────────────
//  EDIT THESE
// ─────────────────────────────────────────

const postTitles = [
  "First title goes here",
  "Second title goes here",
  "Third title goes here",
];

const imagePath = "./xposter/image.jpg";

const delayBetweenPostsSeconds = 60;

// ─────────────────────────────────────────
//  DO NOT EDIT BELOW THIS LINE
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

async function uploadImage(imgPath) {
  const absolutePath = path.resolve(imgPath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Image not found at: ${absolutePath}`);
  }
  console.log(`Uploading image: ${absolutePath}`);
  const mediaId = await rwClient.v1.uploadMedia(absolutePath);
  console.log(`Image uploaded. Media ID: ${mediaId}`);
  return mediaId;
}

async function run() {
  console.log(`\nStarting X auto-poster`);
  console.log(`${postTitles.length} posts queued\n`);

  const mediaId = await uploadImage(imagePath);

  for (let i = 0; i < postTitles.length; i++) {
    const title = postTitles[i];
    console.log(`\n[${i + 1}/${postTitles.length}] Posting: "${title}"`);

    try {
      const tweet = await rwClient.v2.tweet({
        text: title,
        media: { media_ids: [mediaId] },
      });
      console.log(`Posted! Tweet ID: ${tweet.data.id}`);
    } catch (err) {
      console.error(`Failed to post: ${err.message}`);
    }

    if (i < postTitles.length - 1) {
      console.log(`Waiting ${delayBetweenPostsSeconds}s before next post...`);
      await sleep(delayBetweenPostsSeconds * 1000);
    }
  }

  console.log(`\nAll ${postTitles.length} posts done!`);
}

run().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
