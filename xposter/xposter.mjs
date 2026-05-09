import { TwitterApi } from 'twitter-api-v2';

const client = new TwitterApi({
  appKey:       process.env.TWITTER_API_KEY,
  appSecret:    process.env.TWITTER_API_SECRET,
  accessToken:  process.env.TWITTER_ACCESS_TOKEN,
  accessSecret: process.env.TWITTER_ACCESS_SECRET,
});

const rwClient = client.readWrite;

async function run() {
  console.log("🚀 Starting test post...");

  try {
    console.log("API Key starts with:", process.env.TWITTER_API_KEY?.slice(0, 8) + "...");
    console.log("Access Token starts with:", process.env.TWITTER_ACCESS_TOKEN?.slice(0, 15) + "...");

    const tweet = await rwClient.v2.tweet({ 
      text: "Test post from Railway debug version 🚀" 
    });

    console.log("✅ SUCCESS! Posted!");
    console.log("Tweet ID:", tweet.data.id);

  } catch (err) {
    console.error("❌ FULL ERROR DETAILS:");
    console.error(err);

    if (err.data) {
      console.error("Error Data:", JSON.stringify(err.data, null, 2));
    }
    if (err.code) console.error("Code:", err.code);
    if (err.status) console.error("Status:", err.status);
  }
}

run();
