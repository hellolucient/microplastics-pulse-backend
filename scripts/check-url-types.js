#!/usr/bin/env node

/**
 * Simple script to check what types of URLs exist in the latest_news table
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function checkUrlTypes() {
  console.log('🔍 Checking URL types in latest_news table...\n');
  
  try {
    // Get all URLs
    const { data: articles, error } = await supabase
      .from('latest_news')
      .select('id, url, title')
      .limit(100); // Limit to first 100 for testing

    if (error) {
      throw new Error(`Failed to fetch articles: ${error.message}`);
    }

    if (!articles || articles.length === 0) {
      console.log('❌ No articles found in database');
      return;
    }

    console.log(`📊 Found ${articles.length} articles\n`);

    // Categorize URLs
    const urlTypes = {
      'google.com/share.google': [],
      'google.com/share': [],
      'share.google': [],
      'other': []
    };

    articles.forEach(article => {
      if (article.url.includes('google.com/share.google')) {
        urlTypes['google.com/share.google'].push(article);
      } else if (article.url.includes('google.com/share')) {
        urlTypes['google.com/share'].push(article);
      } else if (article.url.includes('share.google')) {
        urlTypes['share.google'].push(article);
      } else {
        urlTypes['other'].push(article);
      }
    });

    // Display results
    console.log('📋 URL Type Breakdown:');
    console.log(`   google.com/share.google: ${urlTypes['google.com/share.google'].length} articles`);
    console.log(`   google.com/share: ${urlTypes['google.com/share'].length} articles`);
    console.log(`   share.google: ${urlTypes['share.google'].length} articles`);
    console.log(`   other: ${urlTypes['other'].length} articles\n`);

    // Show examples of each type
    Object.entries(urlTypes).forEach(([type, articles]) => {
      if (articles.length > 0) {
        console.log(`🔍 Examples of ${type}:`);
        articles.slice(0, 3).forEach(article => {
          console.log(`   ${article.title.substring(0, 60)}...`);
          console.log(`   URL: ${article.url}\n`);
        });
      }
    });

  } catch (error) {
    console.error('💥 Script failed:', error.message);
    process.exit(1);
  }
}

// Run the script
checkUrlTypes().then(() => {
  console.log('🏁 Script completed');
  process.exit(0);
}).catch(error => {
  console.error('💥 Unhandled error:', error);
  process.exit(1);
});
