# SMTP2Graph WebUI — Security Fixes & Project Recommendations

This document provides implementation instructions for addressing security vulnerabilities
identified in the WebUI and broader project improvements. Items are ordered by priority.

---

## Table of Contents

1. [Critical: HTTPS / Reverse Proxy Requirement](#1-critical-https--reverse-proxy-requirement)
2. [Critical: Security Headers via Helmet](#2-critical-security-headers-via-helmet)
3. [Critical: Rate Limiting on WebUI Auth](#3-critical-rate-limiting-on-webui-auth)
4. [High: CSRF Protection](#4-high-csrf-protection)
5. [High: Input Validation on Query Parameters](#5-high-input-validation-on-query-parameters)
6. [High: Restrict Secret Exposure](#6-high-restrict-secret-exposure)
7. [Medium: XSS Hardening — Replace innerHTML](#7-medium-xss-hardening--replace-innerhtml)
8. [Medium: Atomic Config Writes](#8-medium-atomic-config-writes)
9. [Medium: Docker Container Hardening](#9-medium-docker-container-hardening)
10. [Medium: Schema Validation Improvements](#10-medium-schema-validation-improvements)
11. [Low: Bug Fix — httpProxyPassword](#11-low-bug-fix--httpproxypassword)
12. [Low: Audit Logging](#12-low-audit-logging)
13. [Project Recommendations](#13-project-recommendations)

---

## 1. Critical: HTTPS / Reverse Proxy Requirement

### Problem
Basic Auth transmits credentials in cleartext over HTTP. The WebUI has no TLS support.

### Recommended Approach
Rather than adding TLS directly to the Express server (which requires certificate management),
document and enforce a **reverse proxy requirement**. This is the standard pattern for
containerized services.

### Instructions

**Option A — Document reverse proxy as required (recommended for Docker deployments):**

Add to `config.example.yml`:
```yaml
# ╔══════════════════════════════════════════════════════════════════╗
# ║  WARNING: The WebUI uses Basic Auth. You MUST place it behind  ║
# ║  a TLS-terminating reverse proxy (Traefik, Caddy, nginx) or   ║
# ║  bind to localhost only (listenAddress: 127.0.0.1).            ║
# ╚══════════════════════════════════════════════════════════════════╝
webui:
  enabled: true
  port: 3000
  listenAddress: 127.0.0.1   # Default to localhost, not 0.0.0.0
```

Add a startup warning in `WebServer.ts`:
```typescript
if (listenAddress === '0.0.0.0' || listenAddress === '::') {
    log.warn('WebUI is listening on all interfaces WITHOUT TLS. ' +
             'Place behind a TLS-terminating reverse proxy or bind to 127.0.0.1.');
}
```

Change the default `listenAddress` in `Config.ts` from `'0.0.0.0'` to `'127.0.0.1'`.

**Option B — Native TLS support (optional enhancement):**

Add optional TLS config:
```yaml
webui:
  tls:
    cert: /path/to/cert.pem
    key: /path/to/key.pem
```

In `WebServer.ts`, conditionally create an HTTPS server:
```typescript
import https from 'https';
import fs from 'fs';

const tlsConfig = Config.webuiTls;
if (tlsConfig?.cert && tlsConfig?.key) {
    const server = https.createServer({
        cert: fs.readFileSync(tlsConfig.cert),
        key: fs.readFileSync(tlsConfig.key),
    }, this.#app);
    server.listen(port, listenAddress);
} else {
    this.#app.listen(port, listenAddress);
}
```

Add a `docker-compose.example.yml` showing Traefik or Caddy as a sidecar:
```yaml
version: '3.8'
services:
  smtp2graph:
    image: smtp2graph:latest
    ports:
      - "587:587"
    # WebUI NOT exposed directly
    volumes:
      - ./config.yml:/data/config.yml

  caddy:
    image: caddy:2-alpine
    ports:
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
    depends_on:
      - smtp2graph
```

With a minimal `Caddyfile`:
```
webui.internal.example.com {
    reverse_proxy smtp2graph:3000
}
```

---

## 2. Critical: Security Headers via Helmet

### Problem
No security headers are set. Vulnerable to clickjacking, MIME sniffing, and XSS.

### Instructions

Install `helmet`:
```bash
npm install helmet
```

Add to `WebServer.ts` **before** any route definitions:
```typescript
import helmet from 'helmet';

// Inside constructor, before auth middleware:
this.#app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],  // needed for inline styles in retro theme
            imgSrc: ["'self'", "data:"],
            connectSrc: ["'self'"],
            frameSrc: ["'none'"],
            objectSrc: ["'none'"],
        }
    },
    hsts: false,  // Let reverse proxy handle HSTS
}));
```

Add `helmet` to webpack `externals` alongside `express` and `ajv`:
```javascript
externals: {
    express: 'commonjs express',
    ajv: 'commonjs ajv',
    helmet: 'commonjs helmet',
}
```

---

## 3. Critical: Rate Limiting on WebUI Auth

### Problem
No brute-force protection on the Basic Auth endpoint.

### Instructions

Install `express-rate-limit`:
```bash
npm install express-rate-limit
```

Add to `WebServer.ts` **before** the auth middleware:
```typescript
import rateLimit from 'express-rate-limit';

// Rate limit all requests (applies before auth check)
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,  // 15 minutes
    max: 50,                    // 50 requests per window
    standardHeaders: true,
    legacyHeaders: false,
    message: 'Too many requests, please try again later.',
});
this.#app.use(limiter);

// Stricter limit on failed auth (401 responses)
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,                    // 10 failed attempts per window
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
});
this.#app.use(authLimiter);
```

Add to webpack `externals`:
```javascript
'express-rate-limit': 'commonjs express-rate-limit',
```

**Also add logging for failed auth attempts** in the auth middleware:
```typescript
if (!username || !password || username !== expectedUser || password !== expectedPass) {
    log.warn(`Failed WebUI auth attempt from ${req.ip} — user: "${username || '(empty)'}"`);
    res.set('WWW-Authenticate', 'Basic realm="SMTP2Graph"');
    return res.status(401).send('Authentication required');
}
```

---

## 4. High: CSRF Protection

### Problem
Basic Auth credentials are sent automatically by browsers, making state-changing requests
(PUT, DELETE) vulnerable to cross-site request forgery.

### Instructions

**Approach: Custom header check (simplest for API-only backends).**

Browsers block cross-origin requests with custom headers by default (CORS preflight).
Require a custom header on all mutating requests:

In `WebServer.ts`, add middleware after auth:
```typescript
// CSRF protection: require custom header on state-changing requests
this.#app.use((req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        return next();
    }
    if (req.headers['x-requested-with'] !== 'XMLHttpRequest') {
        return res.status(403).json({ error: 'Missing CSRF header' });
    }
    next();
});
```

In `app.js`, add the header to all fetch calls that mutate state:
```javascript
// Update the existing fetch helper or add to all PUT/POST/DELETE calls:
function apiFetch(url, options = {}) {
    options.headers = {
        ...options.headers,
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
    };
    return fetch(url, options);
}
```

Then replace all `fetch()` calls in `app.js` that use PUT/POST/DELETE with `apiFetch()`.

---

## 5. High: Input Validation on Query Parameters

### Problem
The `lines` parameter in `healthRoutes.ts` has no upper bound, enabling memory exhaustion.

### Instructions

In `healthRoutes.ts`, replace:
```typescript
const lines = parseInt(req.query.lines as string) || 100;
```

With:
```typescript
const rawLines = parseInt(req.query.lines as string) || 100;
const lines = Math.min(Math.max(rawLines, 1), 1000);  // Clamp to 1–1000
```

Apply the same pattern to any other numeric query params across all routes.

---

## 6. High: Restrict Secret Exposure

### Problem
`showSecrets=true` exposes all credentials to any authenticated user with no audit trail.

### Instructions

**Option A — Remove `showSecrets` entirely (recommended):**

Secrets should be write-only through the WebUI. Users can set new secrets but never view
existing ones. In `configRoutes.ts` and `accountRoutes.ts`:

- Remove the `showSecrets` query parameter handling
- Always mask secrets in responses
- When saving config, treat `'********'` as "keep existing value" (don't overwrite)

In `ConfigService.ts`, update the save logic:
```typescript
static updateConfig(newConfig: any): void {
    const currentConfig = this.getConfig(true);  // get with real secrets

    // Preserve secrets that weren't changed (still masked)
    if (newConfig.webui?.password === '********') {
        newConfig.webui.password = currentConfig.webui?.password;
    }
    for (const account of newConfig.accounts || []) {
        const existing = currentConfig.accounts?.find((a: any) => a.name === account.name);
        if (existing && account.appReg?.secret === '********') {
            account.appReg.secret = existing.appReg?.secret;
        }
    }

    // Validate and write...
}
```

**Option B — If you must keep `showSecrets`, add audit logging:**
```typescript
if (req.query.showSecrets === 'true') {
    log.warn(`Secrets accessed by ${req.ip} via ${req.originalUrl}`);
}
```

---

## 7. Medium: XSS Hardening — Replace innerHTML

### Problem
`innerHTML` with `escapeHtml()` is currently safe but fragile. A future edit could introduce XSS.

### Instructions

Refactor `app.js` to use DOM APIs exclusively. Example for account cards:

**Before:**
```javascript
card.innerHTML = '<div class="card-title">' + escapeHtml(acct.name) + '</div>' +
    '<div class="card-detail">Tenant: ' + escapeHtml(acct.tenant || '') + '</div>';
```

**After:**
```javascript
function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text) e.textContent = text;
    return e;
}

card.appendChild(el('div', 'card-title', acct.name));
card.appendChild(el('div', 'card-detail', 'Tenant: ' + (acct.tenant || '')));
```

Apply this pattern to all places where `innerHTML` is used with dynamic data:
- Account cards (~line 86–108)
- Account list rows (~line 142–168)
- Config form rendering (~line 337–403)

The `escapeHtml()` function can then be removed entirely.

---

## 8. Medium: Atomic Config Writes

### Problem
`fs.writeFileSync()` can corrupt `config.yml` on crash or power loss.

### Instructions

In `ConfigService.ts`, replace direct write with atomic write:
```typescript
import { randomBytes } from 'crypto';

static updateConfig(newConfig: any): void {
    // ... validation ...

    const configPath = Config.configFilePath;  // or however the path is resolved
    const tmpPath = configPath + '.tmp.' + randomBytes(4).toString('hex');

    try {
        fs.writeFileSync(tmpPath, yaml.stringify(newConfig), 'utf8');
        fs.renameSync(tmpPath, configPath);  // atomic on same filesystem
    } catch (err) {
        // Clean up temp file on failure
        try { fs.unlinkSync(tmpPath); } catch {}
        throw err;
    }
}
```

`fs.renameSync` is atomic on POSIX systems (including Linux/Docker). This ensures the
config file is never in a half-written state.

---

## 9. Medium: Docker Container Hardening

### Problem
Container runs as root. No health check defined.

### Instructions

Update `Dockerfile`:
```dockerfile
FROM node:20-alpine

# ... existing COPY and RUN steps ...

# Add non-root user
RUN addgroup -S smtp2graph && adduser -S smtp2graph -G smtp2graph

# Create data directory with correct permissions
RUN mkdir -p /data/logs /data/queue /data/failed && \
    chown -R smtp2graph:smtp2graph /data

EXPOSE 587 3000
WORKDIR /data

# Health check — probe SMTP port (adjust if WebUI is enabled)
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD nc -z localhost 587 || exit 1

# Switch to non-root user
USER smtp2graph

ENTRYPOINT ["/bin/sh", "/docker/startup.sh"]
```

**Note:** If the SMTP server binds to port 25 (privileged), you'll need to use port 587
(already the Docker default) or add `NET_BIND_SERVICE` capability. Port 587 as non-root
works fine.

Add `set -e` to `startup.sh`:
```bash
#!/bin/sh
set -e
# ... rest of script
```

---

## 10. Medium: Schema Validation Improvements

### Problem
IP regex accepts invalid values like `999.999.999.999`. Email regex is non-RFC-compliant.

### Instructions

In `config.schema.json`, replace the IP pattern:

**Before:**
```json
"pattern": "^[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}$"
```

**After (validates 0–255 per octet):**
```json
"pattern": "^((25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\\.){3}(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$"
```

For CIDR notation, validate the prefix length separately:
```json
"pattern": "^((25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\\.){3}(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\\/(3[0-2]|[12]?[0-9])$"
```

Add `minLength` constraints for passwords:
```json
"password": {
    "type": "string",
    "minLength": 8,
    "description": "WebUI password (minimum 8 characters)"
}
```

For email validation, consider using `"format": "email"` with AJV's format plugin
(`ajv-formats`) instead of a custom regex:
```bash
npm install ajv-formats
```
```typescript
import addFormats from 'ajv-formats';
const ajv = new Ajv();
addFormats(ajv);
```

---

## 11. Low: Bug Fix — httpProxyPassword

### Problem
Copy-paste error in `Config.ts` — `httpProxyPassword` returns `username` instead of `password`.

### Instructions

In `Config.ts`, find:
```typescript
static get httpProxyPassword() {
    return this.#config.httpProxy?.username;
}
```

Replace with:
```typescript
static get httpProxyPassword() {
    return this.#config.httpProxy?.password;
}
```

---

## 12. Low: Audit Logging

### Problem
No logging of configuration changes, secret access, or failed auth attempts.

### Instructions

Add audit log entries at key points using the existing Winston logger:

In `WebServer.ts` auth middleware (failed attempts — covered in section 3 above).

In `configRoutes.ts`:
```typescript
router.put('/', (req, res) => {
    log.info(`Config updated by ${req.ip}`);
    // ... existing logic
});
```

In `accountRoutes.ts`:
```typescript
router.post('/', (req, res) => {
    log.info(`Account "${req.body.name}" created by ${req.ip}`);
    // ...
});

router.put('/:name', (req, res) => {
    log.info(`Account "${req.params.name}" updated by ${req.ip}`);
    // ...
});

router.delete('/:name', (req, res) => {
    log.warn(`Account "${req.params.name}" deleted by ${req.ip}`);
    // ...
});
```

---

## 13. Project Recommendations

Beyond the security fixes above, here are broader improvements for the project:

### 13.1 — WebUI Test Coverage

The existing Mocha test suite covers SMTP receive and Graph send, but the WebUI has no tests.
Add tests for:

- **Route tests**: Use `supertest` to test each API endpoint (auth, CRUD, validation)
- **ConfigService tests**: Test config read/write, secret masking, merge logic
- **HealthService tests**: Test metric aggregation with mocked data

```bash
npm install --save-dev supertest @types/supertest
```

Example test skeleton (`test/03webui/01routes.spec.ts`):
```typescript
import request from 'supertest';
import { WebServer } from '../../src/webui/WebServer';

describe('WebUI Routes', () => {
    let app: Express.Application;

    before(() => {
        // Initialize app with test config
    });

    it('should require authentication', async () => {
        const res = await request(app).get('/api/health');
        expect(res.status).to.equal(401);
    });

    it('should return health status when authenticated', async () => {
        const res = await request(app)
            .get('/api/health')
            .auth('admin', 'testpass');
        expect(res.status).to.equal(200);
    });
});
```

### 13.2 — CI Workflow for WebUI

Add a GitHub Actions job to `test-basic.yml` that:
1. Builds the project with WebUI enabled
2. Starts the server with a test config
3. Runs `supertest` suite against it
4. Validates that `helmet` headers are present

### 13.3 — Config Hot-Reload

Currently, config changes via WebUI require a restart. Consider:
- Using `chokidar` (already a dependency) to watch `config.yml`
- Emitting a reload event when the file changes
- Having each class re-read its relevant config section
- **Caution**: SMTP server and MSAL clients may need graceful restart, not just re-read

### 13.4 — WebUI Session Auth (Future)

Replace Basic Auth with session-based authentication:
- Use `express-session` with a signed cookie
- Login page instead of browser-native auth dialog
- Session timeout (e.g., 30 minutes)
- Logout button
- This eliminates the CSRF concern (use `SameSite=Strict` cookies)

### 13.5 — Multi-Instance Management (Future)

If you ever need the WebUI to manage multiple SMTP2Graph instances:
- Extract the WebUI into a separate container
- Each SMTP2Graph instance exposes a lightweight status API (health + queue stats only)
- WebUI aggregates status from multiple instances
- This is a significant architecture change — only pursue if needed

### 13.6 — Dependency Audit

Add to CI pipeline:
```yaml
- name: Audit dependencies
  run: npm audit --audit-level=high
```

Consider adding `npm audit` as a pre-commit or pre-push hook.

### 13.7 — Log Sensitive Data Review

While no obvious leaks were found, add a policy:
- Never log email bodies or attachments
- Never log bearer tokens or client secrets
- Redact email addresses in logs to `u***@domain.com` if privacy is a concern
- Review logging when adding new features

### 13.8 — Graceful Shutdown

Ensure the WebUI Express server shuts down cleanly alongside the SMTP server:
```typescript
// In server.ts shutdown handler:
process.on('SIGTERM', async () => {
    log.info('Shutting down...');
    await webServer?.close();   // close HTTP server
    await smtpServer?.close();  // close SMTP server
    await mailQueue?.drain();   // finish in-flight sends
    process.exit(0);
});
```

The existing Docker stop issue (#45) was fixed, but verify the WebUI server is included
in the shutdown sequence.

---

## Implementation Order

For a developer picking these up, the suggested order is:

| Phase | Items | New Dependencies |
|-------|-------|-----------------|
| **Phase 1** — Quick wins | #5, #11, #12 | None |
| **Phase 2** — Core security | #1, #2, #3, #4 | `helmet`, `express-rate-limit` |
| **Phase 3** — Hardening | #6, #7, #8, #9, #10 | `ajv-formats` (optional) |
| **Phase 4** — Testing | #13.1, #13.2 | `supertest` |
| **Phase 5** — Future | #13.3–#13.8 | Varies |

Phases 1 and 2 should be completed before any production deployment.
