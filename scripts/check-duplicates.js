require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');

// Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
    console.error('❌ Error: SUPABASE_URL or SUPABASE_SERVICE_KEY missing in .env');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

async function checkDuplicateUrls() {
    console.log('🔍 Checking for duplicate URLs in latest_news table...\n');
    
    try {
        // First get the total count
        console.log('📊 Getting total record count...');
        const { count, error: countError } = await supabase
            .from('latest_news')
            .select('*', { count: 'exact', head: true });
            
        if (countError) {
            console.error('❌ Error getting count:', countError.message);
            return;
        }
        
        console.log(`📊 Total records in database: ${count}`);
        
        // Fetch all URLs using pagination
        console.log('📊 Fetching all URLs from database...');
        let allUrls = [];
        const pageSize = 1000;
        let page = 0;
        
        while (true) {
            const { data: pageData, error } = await supabase
                .from('latest_news')
                .select('id, url, processed_at, title')
                .order('processed_at', { ascending: true })
                .range(page * pageSize, (page + 1) * pageSize - 1);
                
            if (error) {
                console.error('❌ Error fetching URLs:', error.message);
                return;
            }
            
            if (!pageData || pageData.length === 0) {
                break;
            }
            
            allUrls.push(...pageData);
            console.log(`   📄 Fetched page ${page + 1}: ${pageData.length} records (total: ${allUrls.length})`);
            
            if (pageData.length < pageSize) {
                break; // Last page
            }
            
            page++;
        }
        
        console.log(`✅ Fetched ${allUrls.length} URLs (database count: ${count})\n`);
        
        // Check for duplicates
        const urlMap = new Map();
        const duplicates = [];
        
        for (const record of allUrls) {
            const url = record.url;
            
            if (urlMap.has(url)) {
                // This is a duplicate
                const original = urlMap.get(url);
                duplicates.push({
                    url: url,
                    original: original,
                    duplicate: record
                });
            } else {
                urlMap.set(url, record);
            }
        }
        
        // Report results
        console.log('📈 DUPLICATE URL ANALYSIS');
        console.log('=' .repeat(50));
        console.log(`Total URLs in database: ${allUrls.length}`);
        console.log(`Unique URLs: ${urlMap.size}`);
        console.log(`Duplicate URLs found: ${duplicates.length}`);
        console.log(`Duplicate percentage: ${((duplicates.length / allUrls.length) * 100).toFixed(2)}%\n`);
        
        if (duplicates.length === 0) {
            console.log('🎉 No duplicate URLs found! Database is clean.');
            return;
        }
        
        // Show detailed duplicate information
        console.log('🔍 DETAILED DUPLICATE ANALYSIS');
        console.log('=' .repeat(50));
        
        // Group duplicates by URL
        const duplicateGroups = new Map();
        for (const dup of duplicates) {
            const url = dup.url;
            if (!duplicateGroups.has(url)) {
                duplicateGroups.set(url, []);
            }
            duplicateGroups.get(url).push(dup);
        }
        
        let totalDuplicateRecords = 0;
        for (const [url, dups] of duplicateGroups) {
            console.log(`\n🔗 URL: ${url}`);
            console.log(`   Appears ${dups.length + 1} times total:`);
            
            // Show original
            const original = urlMap.get(url);
            console.log(`   📅 Original: ID ${original.id} (${original.processed_at})`);
            console.log(`      Title: "${original.title?.substring(0, 80)}..."`);
            
            // Show duplicates
            for (const dup of dups) {
                console.log(`   🔄 Duplicate: ID ${dup.duplicate.id} (${dup.duplicate.processed_at})`);
                console.log(`      Title: "${dup.duplicate.title?.substring(0, 80)}..."`);
                totalDuplicateRecords++;
            }
        }
        
        console.log('\n📊 SUMMARY');
        console.log('=' .repeat(50));
        console.log(`URLs that have duplicates: ${duplicateGroups.size}`);
        console.log(`Total duplicate records (can be deleted): ${totalDuplicateRecords}`);
        console.log(`Space savings if cleaned: ${totalDuplicateRecords} records`);
        
        // Show most duplicated URLs
        console.log('\n🏆 TOP DUPLICATED URLS');
        console.log('=' .repeat(50));
        const sortedDuplicates = Array.from(duplicateGroups.entries())
            .sort((a, b) => b[1].length - a[1].length)
            .slice(0, 5);
            
        for (const [url, dups] of sortedDuplicates) {
            console.log(`${dups.length + 1}x: ${url.substring(0, 80)}...`);
        }
        
    } catch (error) {
        console.error('❌ Unexpected error:', error.message);
    }
}

async function generateCleanupScript() {
    console.log('\n🧹 Generating cleanup script...');
    
    try {
        // Get duplicates for cleanup script
        const { data: allUrls, error } = await supabase
            .from('latest_news')
            .select('id, url, processed_at')
            .order('processed_at', { ascending: true })
            .range(0, 9999);
            
        if (error) throw error;
        
        const urlMap = new Map();
        const duplicateIds = [];
        
        for (const record of allUrls) {
            if (urlMap.has(record.url)) {
                // Keep the first (oldest) record, mark later ones for deletion
                duplicateIds.push(record.id);
            } else {
                urlMap.set(record.url, record);
            }
        }
        
        if (duplicateIds.length === 0) {
            console.log('✅ No cleanup needed - no duplicates found.');
            return;
        }
        
        console.log(`\n🗑️  CLEANUP SCRIPT (removes ${duplicateIds.length} duplicate records):`);
        console.log('=' .repeat(70));
        console.log('-- Run this SQL in your Supabase SQL editor:');
        console.log('-- WARNING: This will permanently delete duplicate records!');
        console.log('-- Always backup your database first!\n');
        
        // Split into batches of 100 for manageable queries
        const batchSize = 100;
        for (let i = 0; i < duplicateIds.length; i += batchSize) {
            const batch = duplicateIds.slice(i, i + batchSize);
            console.log(`DELETE FROM latest_news WHERE id IN (${batch.join(', ')});`);
        }
        
        console.log(`\n-- This will delete ${duplicateIds.length} duplicate records`);
        console.log('-- and keep the oldest version of each duplicate URL');
        
    } catch (error) {
        console.error('❌ Error generating cleanup script:', error.message);
    }
}

// Main execution
async function main() {
    await checkDuplicateUrls();
    await generateCleanupScript();
    console.log('\n✅ Duplicate check complete!');
}

main().catch(console.error);
