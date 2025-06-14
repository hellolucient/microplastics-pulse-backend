const { TwitterApi } = require('twitter-api-v2');

// Initialize the client with your environment variables
// Make sure to set these in your .env file or hosting environment
const client = new TwitterApi({
  appKey: process.env.TWITTER_API_KEY,
  appSecret: process.env.TWITTER_API_SECRET,
  accessToken: process.env.TWITTER_ACCESS_TOKEN,
  accessSecret: process.env.TWITTER_ACCESS_SECRET,
});

/**
 * Posts a single tweet to X.
 * @param {string} text The text content of the tweet.
 * @param {string} [imageUrl] (Optional) A URL to an image to attach to the tweet.
 * @returns {Promise<{success: boolean, tweet?: any, error?: string}>}
 */
async function postSingleTweet(text, imageUrl) {
  try {
    let mediaIds;

    // Use the v2 media upload endpoint, which is compatible with the Free tier.
    if (imageUrl && imageUrl.startsWith('http')) {
      console.log(`Fetching image from URL: ${imageUrl}`);
      const imageResponse = await fetch(imageUrl);
      
      if (!imageResponse.ok) {
        const errorText = await imageResponse.text();
        console.error(`Failed to fetch image: ${imageResponse.status} ${imageResponse.statusText}. Response: ${errorText}`);
        throw new Error(`Failed to fetch image: ${imageResponse.statusText}`);
      }
      
      const buffer = Buffer.from(await imageResponse.arrayBuffer());
      const contentType = imageResponse.headers.get('content-type') || 'image/jpeg';

      // --- AGGRESSIVE DEBUGGING ---
      console.log('--- DEBUG INFO ---');
      console.log('Content-Type passed to uploadMedia:', contentType);
      console.log('Buffer is a Buffer:', Buffer.isBuffer(buffer));
      console.log('Buffer length:', buffer ? buffer.length : 'null or undefined');
      console.log('--------------------');
      // --- END DEBUGGING ---
      
      // The v2 upload method returns a single media ID string.
      const mediaId = await client.v2.uploadMedia(buffer, {
        mimeType: contentType,
        target: 'tweet',
      });

      mediaIds = [mediaId];
      console.log(`Media uploaded successfully. Media ID: ${mediaId}`);
    } else if (imageUrl) {
      console.warn(`Skipping image upload because URL is not valid (does not start with http): ${imageUrl}`);
    }

    // Post the tweet, including the media ID if an image was uploaded
    console.log('Posting tweet to Twitter...');
    const tweet = await client.v2.tweet({
      text,
      ...(mediaIds && { media: { media_ids: mediaIds } }),
    });

    console.log('Tweet posted successfully:', tweet);
    return { success: true, tweet };
  } catch (error) {
    console.error('Error in postSingleTweet function:', error);
    // Extract more specific error message from twitter-api-v2 if available
    const errorMessage = error.data?.detail || error.message || 'An unknown error occurred during tweet posting.';
    return { success: false, error: errorMessage };
  }
}

/**
 * Defines the structure for a single tweet within a thread.
 * @typedef {object} ThreadTweet
 * @property {string} text
 * @property {string} [imageUrl]
 */

/**
 * Posts a thread of tweets to X.
 * @param {ThreadTweet[]} tweets An array of tweet objects, each with text and an optional imageUrl.
 * @returns {Promise<{success: boolean, tweets?: any[], error?: string}>}
 */
async function postTweetThread(tweets) {
  try {
    let previousTweetId;
    const postedTweets = [];

    for (const tweet of tweets) {
      let mediaId;

      if (tweet.imageUrl) {
        const imageResponse = await fetch(tweet.imageUrl);
        if (!imageResponse.ok) {
          throw new Error(`Failed to fetch image for thread: ${imageResponse.statusText}`);
        }
        const buffer = Buffer.from(await imageResponse.arrayBuffer());
        mediaId = await client.v1.uploadMedia(buffer, {
          mimeType: imageResponse.headers.get('content-type') || 'image/jpeg',
        });
      }

      // Post each tweet, replying to the previous one to form a thread
      const postedTweet = await client.v2.tweet({
        text: tweet.text,
        ...(mediaId && { media: { media_ids: [mediaId] } }),
        ...(previousTweetId && { reply: { in_reply_to_tweet_id: previousTweetId } }),
      });

      previousTweetId = postedTweet.data.id;
      postedTweets.push(postedTweet);
    }

    console.log('Thread posted successfully:', postedTweets);
    return { success: true, tweets: postedTweets };
  } catch (error) {
    console.error('Error posting thread:', error);
    const errorMessage = error.data?.detail || error.message || 'Failed to post thread';
    return { success: false, error: errorMessage };
  }
}

module.exports = {
  postSingleTweet,
  postTweetThread,
}; 