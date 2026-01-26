# GitHub Actions Workflow Troubleshooting

## Issue: Workflow Disabled Due to 60 Days of Inactivity

**GitHub automatically disables scheduled workflows if there's no repository activity for 60+ days.**

This is a GitHub policy to prevent abandoned repositories from consuming resources. If you see the message:
> "This scheduled workflow is disabled because there hasn't been activity in this repository for at least 60 days."

### Immediate Actions to Re-enable

1. **Manually Trigger the Workflow**
   - Go to: https://github.com/YOUR_REPO/actions
   - Click on "Daily Automation Trigger" workflow
   - Click "Run workflow" button (top right)
   - Select branch: `main`
   - Click green "Run workflow" button
   - This will test if the workflow works and may re-enable scheduling

2. **Check Workflow Settings**
   - Go to: Repo → Settings → Actions → General
   - Verify "Allow all actions and reusable workflows" is enabled
   - Check "Workflow permissions" - should allow read/write
   - Ensure scheduled workflows are not disabled

3. **Review Failed Run Logs**
   - Click on the failed run (#88) from Nov 12
   - Check the logs to see what error occurred
   - Common issues:
     - Railway URL changed
     - Railway service is down
     - Network timeout
     - Authentication issues

### Why Workflows Stop

GitHub may pause scheduled workflows if:
- Repository has been inactive for 60+ days
- Workflow fails multiple times in a row
- Repository settings changed
- GitHub Actions usage limits reached

### Solutions

#### Option 1: Re-enable via Manual Trigger
Manually triggering the workflow often re-enables the schedule.

#### Option 2: Update the Workflow File
Simply making a small change and committing can re-enable it:
```bash
# Make a tiny change to the workflow file
git add .github/workflows/daily-automation.yml
git commit -m "Re-enable scheduled workflow"
git push
```

#### Option 3: Use External Cron Service (Recommended Backup)
Set up a backup external cron service that calls the same endpoint:
- **cron-job.org** (free): https://cron-job.org
- **EasyCron** (free tier): https://www.easycron.com

Both can call: `POST https://microplastics-pulse-backend-production.up.railway.app/api/admin/trigger-automation`

#### Option 4: Keep Repository Active (Prevention)
A **weekly keep-alive workflow** (`.github/workflows/keep-alive.yml`) has been added to prevent this issue.
It runs every Monday to ensure the repository stays active. This prevents GitHub from disabling scheduled workflows.

**Manual prevention:** Make a commit at least once every 60 days to keep workflows active.

### Testing the Endpoint

Test if Railway is responding:
```bash
curl -X POST https://microplastics-pulse-backend-production.up.railway.app/api/admin/trigger-automation
```

Expected responses:
- `200` = Success
- `207` = Partial success (some tasks failed but automation ran)
- `500` = Server error (Railway might be sleeping)
- `000` or timeout = Railway is sleeping/not responding

### Current Workflow Improvements

The workflow has been updated to:
- ✅ Continue even if Railway is sleeping (won't fail the workflow)
- ✅ Handle timeouts gracefully
- ✅ Log warnings instead of failing
- ✅ Keep running daily even if individual runs have issues

This ensures the workflow keeps trying every day, even if Railway is temporarily unavailable.
