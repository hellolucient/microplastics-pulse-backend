const missingImagesPage = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Generate missing images</title>
  <style>
    :root { color-scheme: light; }
    body { margin: 0; font-family: Georgia, "Times New Roman", serif; background: #f6f4ef; color: #1f2933; }
    main { max-width: 760px; margin: 0 auto; padding: 40px 20px 64px; }
    h1 { font-size: 1.8rem; font-weight: 600; margin: 0 0 8px; }
    p { line-height: 1.5; }
    .lede { color: #52606d; margin-top: 0; }
    .count { font-size: 2.4rem; margin: 8px 0 0; font-variant-numeric: tabular-nums; }
    .row { display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-end; justify-content: space-between; margin: 28px 0; }
    button { font: inherit; border: 0; border-radius: 8px; padding: 10px 16px; cursor: pointer; }
    button:disabled { cursor: not-allowed; opacity: 0.55; }
    .primary { background: #3d4a3e; color: white; }
    .stop { background: #8c3a32; color: white; }
    .quiet { background: #e4e0d8; color: #1f2933; }
    .status { background: white; border: 1px solid #e4e0d8; border-radius: 10px; padding: 14px 16px; min-height: 1.4em; }
    .working { margin: 8px 0 0; color: #3d4a3e; }
    ul { list-style: none; padding: 0; margin: 18px 0 0; }
    li { background: white; border: 1px solid #e4e0d8; border-radius: 8px; padding: 10px 12px; margin-bottom: 8px; display: flex; justify-content: space-between; gap: 12px; }
    li.fail { border-color: #e7c7c3; }
    .tag { font-family: ui-sans-serif, system-ui, sans-serif; font-size: 0.75rem; letter-spacing: 0.04em; }
    .note { color: #52606d; font-size: 0.95rem; }
  </style>
</head>
<body>
  <main>
    <h1>Generate missing images</h1>
    <p class="lede">Works through every Latest News article that has no image. Each image finishes and is saved before the next one starts.</p>
    <p class="note">Articles missing an image</p>
    <p class="count" id="count">—</p>
    <div class="row">
      <div>
        <button class="quiet" id="refresh" type="button">Refresh count</button>
      </div>
      <div>
        <button class="primary" id="start" type="button">Generate all missing images</button>
        <button class="stop" id="stop" type="button" hidden>Stop after this image</button>
      </div>
    </div>
    <div class="status">
      <div id="status">Ready.</div>
      <div class="working" id="working"></div>
    </div>
    <ul id="log"></ul>
    <p class="note">Leave this page open until the run finishes. Stop waits for the image already in progress. A failed article is skipped for the rest of that pass; run again to retry anything still missing.</p>
  </main>
  <script>
    const countEl = document.getElementById('count');
    const statusEl = document.getElementById('status');
    const workingEl = document.getElementById('working');
    const logEl = document.getElementById('log');
    const startBtn = document.getElementById('start');
    const stopBtn = document.getElementById('stop');
    const refreshBtn = document.getElementById('refresh');
    let stopRequested = false;

    function setBusy(busy) {
      startBtn.hidden = busy;
      stopBtn.hidden = !busy;
      stopBtn.disabled = false;
      refreshBtn.disabled = busy;
    }

    async function refreshCount() {
      refreshBtn.disabled = true;
      try {
        const response = await fetch('/api/find-missing-images');
        const data = await response.json();
        if (!response.ok) throw new Error(data.details || data.error || 'Could not check missing images');
        countEl.textContent = String(data.count ?? 0);
        startBtn.disabled = (data.count ?? 0) === 0;
        return data.count ?? 0;
      } catch (error) {
        statusEl.textContent = error.message;
        return null;
      } finally {
        if (stopBtn.hidden) refreshBtn.disabled = false;
      }
    }

    function addResult(result) {
      const item = document.createElement('li');
      if (!result.success) item.className = 'fail';
      const title = document.createElement('span');
      title.textContent = result.title || result.id;
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = result.success ? 'SAVED' : 'FAILED';
      item.append(title, tag);
      if (!result.success && result.message) {
        const detail = document.createElement('div');
        detail.textContent = result.message;
        item.append(detail);
      }
      logEl.prepend(item);
    }

    async function generateAll() {
      stopRequested = false;
      setBusy(true);
      logEl.replaceChildren();
      workingEl.textContent = '';
      statusEl.textContent = 'Starting. Each image finishes before the next one starts.';
      let afterId = null;
      let generated = 0;
      let failed = 0;
      let finished = false;

      try {
        while (!stopRequested) {
          const response = await fetch('/api/generate-next-missing-image', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ after_id: afterId })
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(data.details || data.error || 'Image request failed');

          if (data.done) {
            finished = true;
            const remaining = data.remaining ?? 0;
            countEl.textContent = String(remaining);
            statusEl.textContent = remaining > 0
              ? 'Finished this pass. Generated ' + generated + '. ' + remaining + ' could not be generated and are still missing.'
              : 'All missing images are generated. ' + generated + ' created.';
            break;
          }

          const result = data.result;
          if (!result || !result.id) throw new Error('Image response did not include an article.');
          workingEl.textContent = 'Working on: ' + (result.title || result.id);
          addResult(result);
          if (result.success) {
            generated += 1;
            if (typeof data.remaining === 'number') countEl.textContent = String(data.remaining);
          } else {
            failed += 1;
            afterId = result.id;
          }
          const left = typeof data.remaining === 'number' ? ' ' + data.remaining + ' still missing.' : '';
          const failedText = failed ? ' ' + failed + ' failed and will be skipped for the rest of this pass.' : '';
          statusEl.textContent = 'Generated ' + generated + '.' + left + failedText;
          if (stopRequested) break;
        }

        if (stopRequested && !finished) {
          statusEl.textContent = 'Stopped after the current image finished. Generated ' + generated + '.' + (failed ? ' ' + failed + ' failed.' : '');
        }
      } catch (error) {
        statusEl.textContent = 'Stopped because of an error: ' + error.message + '. Generated ' + generated + '.';
      } finally {
        workingEl.textContent = '';
        setBusy(false);
        refreshCount();
      }
    }

    startBtn.addEventListener('click', generateAll);
    stopBtn.addEventListener('click', () => {
      stopRequested = true;
      stopBtn.disabled = true;
      statusEl.textContent = 'Stopping after the current image finishes...';
    });
    refreshBtn.addEventListener('click', refreshCount);
    refreshCount();
  </script>
</body>
</html>`;

module.exports = missingImagesPage;
