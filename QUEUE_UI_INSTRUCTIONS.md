# Mail Queue Management UI — Build Instructions for Claude Sonnet 4.6

## Goal

Add a "Mail Queue" tab to the WebUI that lets administrators view, delete, and retry messages across the three queue folders (queue, failed, temp). The backend API is already implemented.

## Available API Endpoints (already built)

```
GET    /api/queue/:folder          — List files (folder = queue, failed, or temp)
DELETE /api/queue/:folder/:filename — Delete a specific file
POST   /api/queue/failed/:filename/retry — Move a failed message back to queue
DELETE /api/queue/:folder          — Clear all files in a folder
```

Response format for `GET /api/queue/:folder`:
```json
[
  {
    "name": "abc123.eml",
    "size": 4096,
    "modified": "2026-04-09T22:00:00.000Z",
    "account": "contoso-relay",
    "retryCount": 2,
    "retryAfter": "2026-04-09T22:05:00.000Z"
  }
]
```

All state-changing requests MUST include header `X-Requested-With: XMLHttpRequest` (use the existing `apiFetch()` helper in app.js).

## Files to Modify

### 1. `src/webui/public/index.html`

Add a new tab button in the `.tab-bar` div, after the existing tabs:
```html
<button class="tab" data-tab="queue">Mail Queue</button>
```

Add a new tab content div after the existing tab content divs (before `#setup-wizard`):
```html
<div id="tab-queue" class="tab-content hidden">
    <!-- Toolbar with folder selector and actions -->
    <div class="toolbar">
        <select id="queue-folder-select" class="field" style="width: 120px;">
            <option value="queue">Queue</option>
            <option value="failed">Failed</option>
            <option value="temp">Temp</option>
        </select>
        <button class="btn" id="btn-refresh-queue">Refresh</button>
        <button class="btn" id="btn-clear-queue" style="margin-left: auto;">Clear All</button>
    </div>

    <!-- File listing -->
    <div class="listview">
        <div class="listview-header">
            <span class="col-qname">Filename</span>
            <span class="col-qsize">Size</span>
            <span class="col-qacct">Account</span>
            <span class="col-qdate">Modified</span>
            <span class="col-qstatus">Status</span>
            <span class="col-qactions">Actions</span>
        </div>
        <div class="listview-body" id="queue-rows">
            <!-- Populated by JavaScript -->
        </div>
    </div>
</div>
```

### 2. `src/webui/public/style.css`

Add column widths for the queue listview (place near the existing `.col-*` definitions):

```css
.col-qname { width: 220px; }
.col-qsize { width: 80px; }
.col-qacct { width: 120px; }
.col-qdate { width: 160px; }
.col-qstatus { width: 100px; }
.col-qactions { width: 180px; }
```

### 3. `src/webui/public/app.js`

Add the queue management logic. These functions should go in the main IIFE, near the accounts section.

**Tab switch handler** — add to the existing `switchTab` function:
```javascript
if(tabName === 'queue') loadQueue();
```

**Queue functions to add:**

```javascript
// ---- Mail Queue ----
function loadQueue() {
    var folder = document.getElementById('queue-folder-select').value;
    loadQueueFolder(folder);
}

async function loadQueueFolder(folder) {
    try {
        var res = await apiFetch('/api/queue/' + folder);
        var files = await res.json();
        renderQueueFiles(files, folder);
        setStatus(files.length + ' message(s) in ' + folder);
    } catch(e) {
        setStatus('Failed to load queue');
    }
}

function renderQueueFiles(files, folder) {
    var body = document.getElementById('queue-rows');
    body.innerHTML = '';

    if(files.length === 0) {
        var p = document.createElement('p');
        p.className = 'placeholder';
        p.textContent = 'No messages in ' + folder + '.';
        body.appendChild(p);
        return;
    }

    files.forEach(function(file) {
        var row = document.createElement('div');
        row.className = 'listview-row';

        var status = '';
        if(file.retryCount) {
            status = 'Retry ' + file.retryCount;
        } else if(folder === 'failed') {
            status = 'Failed';
        } else if(folder === 'temp') {
            status = 'Receiving';
        } else {
            status = 'Queued';
        }

        row.innerHTML =
            '<span class="col-qname" title="' + escapeHtml(file.name) + '">' + escapeHtml(file.name) + '</span>' +
            '<span class="col-qsize">' + formatSize(file.size) + '</span>' +
            '<span class="col-qacct">' + escapeHtml(file.account || '—') + '</span>' +
            '<span class="col-qdate">' + formatDate(file.modified) + '</span>' +
            '<span class="col-qstatus">' + status + '</span>' +
            '<span class="col-qactions"></span>';

        // Build action buttons
        var actions = row.querySelector('.col-qactions');

        if(folder === 'failed') {
            var retryBtn = document.createElement('button');
            retryBtn.className = 'btn';
            retryBtn.textContent = 'Retry';
            retryBtn.addEventListener('click', function(e) {
                e.stopPropagation();
                retryQueueFile(file.name);
            });
            actions.appendChild(retryBtn);
        }

        var delBtn = document.createElement('button');
        delBtn.className = 'btn';
        delBtn.textContent = 'Delete';
        delBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            deleteQueueFile(folder, file.name);
        });
        actions.appendChild(delBtn);

        body.appendChild(row);
    });
}

async function deleteQueueFile(folder, filename) {
    if(!confirm('Delete "' + filename + '" from ' + folder + '?')) return;
    try {
        var res = await apiFetch('/api/queue/' + folder + '/' + encodeURIComponent(filename), {method: 'DELETE'});
        if(res.ok) {
            loadQueue();
        } else {
            var data = await res.json();
            showAlert('Error', data.error || 'Failed to delete');
        }
    } catch(e) {
        showAlert('Error', 'Network error');
    }
}

async function retryQueueFile(filename) {
    try {
        var res = await apiFetch('/api/queue/failed/' + encodeURIComponent(filename) + '/retry', {method: 'POST'});
        if(res.ok) {
            loadQueue();
        } else {
            var data = await res.json();
            showAlert('Error', data.error || 'Failed to retry');
        }
    } catch(e) {
        showAlert('Error', 'Network error');
    }
}

async function clearQueueFolder() {
    var folder = document.getElementById('queue-folder-select').value;
    if(!confirm('Delete ALL messages from ' + folder + '? This cannot be undone.')) return;
    try {
        var res = await apiFetch('/api/queue/' + folder, {method: 'DELETE'});
        if(res.ok) {
            var data = await res.json();
            showAlert('Cleared', 'Removed ' + data.cleared + ' message(s) from ' + folder + '.');
            loadQueue();
        } else {
            showAlert('Error', 'Failed to clear folder');
        }
    } catch(e) {
        showAlert('Error', 'Network error');
    }
}

function formatSize(bytes) {
    if(bytes < 1024) return bytes + ' B';
    if(bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
}

function formatDate(iso) {
    try {
        var d = new Date(iso);
        return d.toLocaleString();
    } catch(e) {
        return iso;
    }
}
```

**Event listeners** — add near the existing event listener section:
```javascript
document.getElementById('btn-refresh-queue').addEventListener('click', loadQueue);
document.getElementById('btn-clear-queue').addEventListener('click', clearQueueFolder);
document.getElementById('queue-folder-select').addEventListener('change', loadQueue);
```

**Important:** The `setStatus` function updates the status bar text. If it doesn't exist yet, add it:
```javascript
function setStatus(text) {
    var el = document.getElementById('status-text');
    if(el) el.textContent = text;
}
```

## Code Style

- Use `var` not `const`/`let` in app.js (matches recent wizard code style)
- Use the existing `escapeHtml()` function for all user data in HTML
- Use `apiFetch()` for all API calls (adds CSRF header)
- Match the retro Windows 98 theme — use existing CSS classes (`.btn`, `.listview`, `.toolbar`, `.group-box`)
- Action buttons in listview rows should use `.btn` class with `font-size: 10px`

## Verification

1. Build: `npm run build`
2. Switch between Queue/Failed/Temp folders — files should list correctly
3. Delete individual files — should disappear from list
4. Retry failed messages — should move to queue folder
5. Clear All — should empty the selected folder
6. No console errors in browser

## Git Workflow

- Work on branch `claude/gallant-lewin`
- Push ONLY to `fork` remote: `git push fork claude/gallant-lewin`
- **NEVER** push to `origin` (upstream SMTP2Graph/SMTP2Graph)
