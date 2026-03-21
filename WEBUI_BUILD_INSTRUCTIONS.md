# SMTP2Graph WebUI + Multi-Account Relay — Build Instructions

> **Audience**: Claude Sonnet 4.6 (or any AI coding assistant)
> **Goal**: Add multi-account relay support and a retro-themed configuration/health WebUI to SMTP2Graph
> **Constraint**: Must layer on top — existing single-account deployments continue to work unchanged

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Architecture Summary](#2-architecture-summary)
3. [Multi-Account Core Changes](#3-multi-account-core-changes)
4. [WebUI Server Implementation](#4-webui-server-implementation)
5. [Frontend (Retro OS Theme)](#5-frontend-retro-os-theme)
6. [Build System & Docker Changes](#6-build-system--docker-changes)
7. [Code Style Conventions](#7-code-style-conventions)
8. [Verification & Testing](#8-verification--testing)

---

## 1. Project Overview

### What SMTP2Graph Does

SMTP2Graph is a TypeScript/Node.js application that runs an SMTP server and relays received emails to Microsoft 365/Exchange Online via the Microsoft Graph API. It currently supports a **single** Azure AD app registration (single tenant).

### Current Tech Stack

| Component | Technology |
|-----------|------------|
| Language | TypeScript 5.3, ES2017 target, strict mode |
| Bundler | Webpack 5 → single `dist/server.js` |
| SMTP | `smtp-server` npm package |
| Auth | `@azure/msal-node` (client credentials flow) |
| HTTP | `axios` for Graph API calls |
| Logging | `winston` with file rotation |
| Config | YAML (`config.yml`) with JSON schema validation |
| Queue | File-system based (`mailroot/temp`, `queue`, `failed`) with `chokidar` watcher |
| Concurrency | `async-mutex` (Mutex + Semaphore) |
| Docker | `node:20-alpine`, port 587, `/data` volume |

### Current File Structure

```
src/
  server.ts                    # Entry point
  classes/
    Config.ts                  # Static singleton, loads config.yml, validation, getters
    SMTPServer.ts              # SMTP server (smtp-server package wrapper)
    Mailer.ts                  # Graph API integration, MSAL auth, sendMail
    MailQueue.ts               # File-based queue with chokidar, retry logic
    MsalProxy.ts               # HTTP proxy support for MSAL auth
    Logger.ts                  # Winston logger with prefixedLog() helper
    Constants.ts               # UnrecoverableError class
  typings/
    global.d.ts                # Declares VERSION: string, DEBUG: boolean
config.yml                     # Runtime config (not in repo)
config.example.yml             # Example config template
config.schema.json             # JSON Schema for config validation
webpack.config.js              # Webpack build config
package.json                   # Dependencies
Dockerfile                     # Docker image definition
docker/
  startup.sh                   # Docker entrypoint
  test.sh                      # Docker test runner
```

### What We're Adding

1. **Multi-account relay** — IIS6 SMTP virtual server-style: multiple Azure AD app registrations on one instance, each with its own IP whitelist and allowed senders
2. **WebUI** — Express-based HTTP server with a retro Mac OS 9 / Windows 98 themed UI for configuration management and service health monitoring

---

## 2. Architecture Summary

### Multi-Account Routing Model

```
SMTP Client connects (IP: 10.0.1.50)
    ↓
Global IP whitelist check (receive.ipWhitelist) — pre-filter
    ↓
Check if IP matches ANY account's allowedIPs — reject if none
    ↓
MAIL FROM: noreply@contoso.com
    ↓
Config.findAccountForSender('10.0.1.50', 'noreply@contoso.com')
    ↓ iterates accounts[]
Account "contoso-relay" matches:
  - 10.0.1.0/24 contains 10.0.1.50 ✓
  - allowedFrom includes noreply@contoso.com ✓
    ↓
Store matched account on SMTP session
    ↓
DATA → write .eml + .meta.json (with accountName)
    ↓
MailQueue picks up file → reads .meta.json → Mailer.sendEml(file, account)
    ↓
Uses account's MSAL client → Graph API → /users/{sender}/sendMail
```

### Backward Compatibility

When the config has NO `accounts` array but has the existing `send.appReg` structure, the system synthesizes a single account from the legacy config. Zero changes needed for existing deployments.

### New Config Format

```yaml
# config.yml — multi-account example

mode: full

# NEW: Multi-account configuration (replaces send.appReg when present)
accounts:
  - name: contoso-relay
    appReg:
      tenant: contoso
      id: 01234567-89ab-cdef-0123-456789abcdef
      certificate:
        thumbprint: 0123456789ABCDEF0123456789ABCDEF01234567
        privateKeyPath: contoso-client.key
    allowedIPs:
      - 10.0.1.0/24
      - 192.168.1.50
    allowedFrom:
      - noreply@contoso.com
      - alerts@contoso.com
    forceMailbox: smtp-relay@contoso.com
    retryLimit: 3
    retryInterval: 5

  - name: fabrikam-relay
    appReg:
      tenant: fabrikam
      id: fedcba98-7654-3210-fedc-ba9876543210
      secret: VGhpcyBpcyB2ZXJ5IHNlY3JldCE=
    allowedIPs:
      - 10.0.2.0/24
    allowedFrom:
      - notifications@fabrikam.com

# LEGACY: Still works if accounts[] is not defined
send:
  appReg:
    tenant: contoso
    id: 01234567-89ab-cdef-0123-456789abcdef
    secret: VGhpcyBpcyB2ZXJ5IHNlY3JldCE=

# SMTP server config (unchanged)
receive:
  port: 587
  ipWhitelist:           # Global pre-filter (optional, applies before account matching)
    - 10.0.0.0/8
    - 192.168.0.0/16
  # ... all existing receive options still work

# NEW: WebUI configuration (optional — if absent, no HTTP server starts)
webui:
  enabled: true
  port: 3000             # Default: 3000
  listenAddress: 0.0.0.0 # Default: 0.0.0.0 (use 127.0.0.1 for local-only access)
  username: admin        # Required when enabled
  password: changeme     # Required when enabled
```

---

## 3. Multi-Account Core Changes

### 3a. Config Changes

**File: `src/classes/Config.ts`**

#### Add IAccount Interface

Add this interface above the existing `IConfig` interface:

```typescript
export interface IAccount
{
    /** Human-readable name for this relay account (used in WebUI and logs) */
    name: string;
    appReg: {
        tenant: string;
        id: string;
        secret?: string;
        certificate?: {
            thumbprint: string;
            privateKeyPath: string;
        };
    };
    /** IP addresses/CIDRs allowed to relay through this account */
    allowedIPs?: string[];
    /** FROM addresses this account can send as */
    allowedFrom?: string[];
    /** Always send from this mailbox (overrides FROM header) */
    forceMailbox?: string;
    /** Times to retry sending a message when it failed (0 = disable, default: 3) */
    retryLimit?: number;
    /** Minutes between retry attempts (default: 5) */
    retryInterval?: number;
}
```

#### Update IConfig Interface

Add these properties to `IConfig`:

```typescript
export interface IConfig
{
    // ... existing properties ...
    accounts?: IAccount[];
    webui?: {
        enabled?: boolean;
        port?: number;
        listenAddress?: string;
        username: string;
        password: string;
    };
}
```

#### Add Account-Related Static Getters/Methods

Add these to the `Config` class:

```typescript
/** Get all configured relay accounts. Falls back to legacy single-account config. */
static get accounts(): IAccount[]
{
    if(this.#config.accounts?.length)
        return this.#config.accounts;

    // Backward compatibility: synthesize single account from legacy send config
    if(this.#config.send?.appReg)
    {
        return [{
            name: 'default',
            appReg: this.#config.send.appReg,
            forceMailbox: this.#config.send.forceMailbox,
            retryLimit: this.#config.send.retryLimit,
            retryInterval: this.#config.send.retryInterval,
            // Legacy mode: use global ipWhitelist and allowedFrom
            allowedIPs: this.#config.receive?.ipWhitelist,
            allowedFrom: this.#config.receive?.allowedFrom,
        }];
    }

    return [];
}

/** Find the first account that matches the given client IP and FROM address */
static findAccountForSender(clientIp: string, fromAddress: string): IAccount | undefined
{
    for(const account of this.accounts)
    {
        // Check IP whitelist
        if(account.allowedIPs?.length)
        {
            let ipAllowed = false;
            for(const allowed of account.allowedIPs)
            {
                if(IPCIDR.isValidCIDR(allowed))
                {
                    if(new IPCIDR(allowed).contains(clientIp))
                    {
                        ipAllowed = true;
                        break;
                    }
                }
                else if(allowed === clientIp)
                {
                    ipAllowed = true;
                    break;
                }
            }
            if(!ipAllowed) continue;
        }

        // Check FROM address whitelist
        if(account.allowedFrom?.length)
        {
            if(!account.allowedFrom.some(a => a.toLowerCase() === fromAddress.toLowerCase()))
                continue;
        }

        return account;
    }

    return undefined;
}

/** Check if an IP matches ANY account's allowedIPs */
static isIpAllowedByAnyAccount(clientIp: string): boolean
{
    return this.accounts.some(account => {
        if(!account.allowedIPs?.length) return true; // No IP restriction = all allowed
        return account.allowedIPs.some(allowed => {
            if(IPCIDR.isValidCIDR(allowed))
                return new IPCIDR(allowed).contains(clientIp);
            return allowed === clientIp;
        });
    });
}
```

#### Add WebUI Getters

```typescript
static get webuiEnabled(): boolean
{
    return Boolean(this.#config.webui?.enabled);
}

static get webuiPort(): number
{
    return this.#config.webui?.port ?? 3000;
}

static get webuiListenAddress(): string
{
    return this.#config.webui?.listenAddress ?? '0.0.0.0';
}

static get webuiUsername(): string | undefined
{
    return this.#config.webui?.username;
}

static get webuiPassword(): string | undefined
{
    return this.#config.webui?.password;
}
```

#### Update validate() Method

Add validation for accounts and webui sections. In the `validate()` method, add:

```typescript
// Validate accounts (when using multi-account config)
if(this.#config.accounts?.length)
{
    for(const account of this.#config.accounts)
    {
        if(!isStringValue(account.name))
            throw new InvalidConfig('Each account must have a "name" property');
        if(!isStringValue(account.appReg?.id))
            throw new InvalidConfig(`Account "${account.name}": missing "appReg.id"`);
        if(!isStringValue(account.appReg?.secret) && !isStringValue(account.appReg?.certificate?.thumbprint))
            throw new InvalidConfig(`Account "${account.name}": missing "appReg.secret" or "appReg.certificate"`);
        if(!isStringValue(account.appReg?.tenant))
            throw new InvalidConfig(`Account "${account.name}": missing "appReg.tenant"`);
        if(account.appReg?.certificate?.privateKeyPath && !fs.existsSync(account.appReg.certificate.privateKeyPath))
            throw new InvalidConfig(`Account "${account.name}": key file "${account.appReg.certificate.privateKeyPath}" not found`);
        if(account.retryInterval !== undefined && account.retryInterval < 1)
            throw new InvalidConfig(`Account "${account.name}": retryInterval must be >= 1`);
    }
}
else if(this.mode !== 'receive') // Legacy single-account validation (existing code)
{
    // ... keep existing appReg validation ...
}

// Validate WebUI config
if(this.webuiEnabled)
{
    if(!isStringValue(this.webuiUsername) || !isStringValue(this.webuiPassword))
        throw new InvalidConfig('WebUI requires "webui.username" and "webui.password" when enabled');
    if(this.#config.webui?.listenAddress && !IPCIDR.isValidAddress(this.#config.webui.listenAddress))
        throw new InvalidConfig('WebUI "listenAddress" is not a valid IP address');
}
```

**IMPORTANT**: The existing single-account validation (`clientId`, `clientSecret`, etc.) should be wrapped in an `else` clause so it only runs when there's no `accounts` array. The existing `sendRetryLimit`, `sendRetryInterval`, and `forceMailbox` getters should continue to work for backward compat by reading from the first/default account.

---

**File: `config.schema.json`**

Add the `accounts` array and `webui` object to the root `properties`:

```json
"accounts": {
    "title": "Relay accounts",
    "description": "Multiple relay accounts with per-account app registrations, IP whitelists, and sender restrictions",
    "type": "array",
    "items": {
        "type": "object",
        "required": ["name", "appReg"],
        "properties": {
            "name": {
                "title": "Account name",
                "description": "Human-readable label for this relay account",
                "type": "string"
            },
            "appReg": {
                "title": "Entra ID application registration",
                "type": "object",
                "required": ["tenant", "id"],
                "oneOf": [
                    {"required": ["secret"]},
                    {"required": ["certificate"]}
                ],
                "properties": {
                    "tenant": {
                        "title": "Tenant name or GUID",
                        "type": "string"
                    },
                    "id": {
                        "title": "Client ID",
                        "type": "string"
                    },
                    "secret": {
                        "title": "Client secret",
                        "type": "string"
                    },
                    "certificate": {
                        "title": "Client certificate",
                        "type": "object",
                        "required": ["thumbprint", "privateKeyPath"],
                        "properties": {
                            "thumbprint": {"type": "string"},
                            "privateKeyPath": {"type": "string"}
                        }
                    }
                }
            },
            "allowedIPs": {
                "title": "Allowed sender IPs",
                "description": "IP addresses or CIDR ranges allowed to relay through this account",
                "type": "array",
                "items": {
                    "type": "string",
                    "anyOf": [
                        {"$ref": "#/definitions/ipaddress"},
                        {"$ref": "#/definitions/ipCIDR"}
                    ]
                }
            },
            "allowedFrom": {
                "allOf": [{"$ref": "#/definitions/emailArray"}],
                "title": "Allowed FROM addresses"
            },
            "forceMailbox": {
                "title": "Force sender mailbox",
                "type": "string"
            },
            "retryLimit": {
                "title": "Retry limit",
                "description": "Times to retry sending (0 = disable, default: 3)",
                "type": "integer"
            },
            "retryInterval": {
                "title": "Retry interval (minutes)",
                "description": "Default: 5",
                "type": "integer"
            }
        }
    }
},
"webui": {
    "title": "WebUI configuration",
    "type": "object",
    "properties": {
        "enabled": {
            "title": "Enable WebUI",
            "type": "boolean"
        },
        "port": {
            "title": "WebUI port",
            "description": "Default: 3000",
            "type": "integer"
        },
        "listenAddress": {
            "$ref": "#/definitions/ipaddress",
            "title": "WebUI listen address",
            "description": "Default: 0.0.0.0"
        },
        "username": {
            "title": "WebUI username",
            "type": "string"
        },
        "password": {
            "title": "WebUI password",
            "type": "string"
        }
    }
}
```

Also update the `oneOf` at the top of the schema to account for the `accounts` array as an alternative to `send` in `full` and `send` modes. Add a fourth option:

```json
{
    "properties": {
        "mode": {
            "const": "full"
        }
    },
    "required": ["accounts"]
}
```

---

**File: `config.example.yml`**

Add the following sections at the end (or alongside the existing examples):

```yaml
# Optional: Multiple relay accounts (replaces 'send' section when defined)
# Each account has its own app registration, IP whitelist, and sender restrictions.
# This works like IIS6 SMTP virtual servers — one SMTP2Graph instance, multiple tenants.
# accounts:
#   - name: contoso-relay
#     appReg:
#       tenant: contoso
#       id: 01234567-89ab-cdef-0123-456789abcdef
#       certificate:
#         thumbprint: 0123456789ABCDEF0123456789ABCDEF01234567
#         privateKeyPath: contoso-client.key
#     allowedIPs:
#       - 10.0.1.0/24
#       - 192.168.1.50
#     allowedFrom:
#       - noreply@contoso.com
#       - alerts@contoso.com
#     forceMailbox: smtp-relay@contoso.com
#     retryLimit: 3
#     retryInterval: 5
#
#   - name: fabrikam-relay
#     appReg:
#       tenant: fabrikam
#       id: fedcba98-7654-3210-fedc-ba9876543210
#       secret: VGhpcyBpcyB2ZXJ5IHNlY3JldCE=
#     allowedIPs:
#       - 10.0.2.0/24
#     allowedFrom:
#       - notifications@fabrikam.com

# Optional: WebUI for configuration management and health monitoring
# webui:
#   enabled: true
#   port: 3000
#   listenAddress: 127.0.0.1  # Use 0.0.0.0 for Docker or remote access
#   username: admin
#   password: changeme
```

---

### 3b. Mailer Changes

**File: `src/classes/Mailer.ts`**

#### Replace Single MSAL Client with Per-Account Map

The current code creates a single static `#msalClient` at class definition time. Replace this with a lazy map:

```typescript
import { IAccount } from './Config';

export class Mailer
{
    static #aquireTokenMutex = new Mutex();
    static #sendSemaphore = new Semaphore(4);

    // REMOVE the static #msalClient = ... line
    // REPLACE with:
    static #msalClients = new Map<string, ConfidentialClientApplication>();

    static #getClient(account: IAccount): ConfidentialClientApplication
    {
        let client = this.#msalClients.get(account.name);
        if(!client)
        {
            const certKeyPath = account.appReg.certificate?.privateKeyPath;
            const certKey = certKeyPath && fs.existsSync(certKeyPath)
                ? fs.readFileSync(certKeyPath).toString()
                : undefined;

            const tenantId = account.appReg.tenant;
            const authority = /^[0-9a-f]{8}\-[0-9a-f]{4}\-[0-9a-f]{4}\-[0-9a-f]{4}\-[0-9a-f]{12}$/i.test(tenantId)
                ? `https://login.microsoftonline.com/${tenantId}`
                : `https://login.microsoftonline.com/${tenantId}.onmicrosoft.com`;

            client = new ConfidentialClientApplication({
                auth: {
                    authority,
                    clientId: account.appReg.id,
                    clientSecret: account.appReg.secret,
                    clientCertificate: account.appReg.certificate ? {
                        thumbprint: account.appReg.certificate.thumbprint,
                        privateKey: certKey!,
                    } : undefined,
                },
                system: Config.httpProxyConfig ? {networkClient: new MsalProxy()} : undefined,
            });

            this.#msalClients.set(account.name, client);
        }
        return client;
    }
```

#### Update sendEml to Accept an Account

Change the signature and use the account parameter:

```typescript
    static async sendEml(filePath: string, account: IAccount)
    {
        return this.#sendSemaphore.runExclusive(async ()=>{
            let sender = account.forceMailbox;
            if(!sender)
            {
                const senderObj = await this.#findSender(filePath);
                if(!senderObj) throw new UnrecoverableError('No sender/from address defined');
                sender = senderObj.address;
            }

            const token = await this.#aquireToken(account);

            const readStream = fs.createReadStream(filePath);
            try {
                await this.#retryableRequest({
                    method: 'post',
                    url: `https://graph.microsoft.com/v1.0/users/${sender}/sendMail`,
                    data: readStream.pipe(new Base64Encode()),
                    headers: {
                        Authorization: `Bearer ${token}`,
                        'Content-Type': 'text/plain',
                        'User-Agent': `SMTP2Graph/${VERSION}`,
                    },
                    proxy: Config.httpProxyConfig,
                });
            } catch(error: any) {
                // ... existing error handling (unchanged) ...
            } finally {
                readStream.destroy();
            }
        });
    }
```

#### Update Token Acquisition

```typescript
    static async #aquireToken(account: IAccount): Promise<string>
    {
        return this.#aquireTokenMutex.runExclusive(async ()=>{
            const client = this.#getClient(account);
            const res = await client.acquireTokenByClientCredential({
                scopes: ['https://graph.microsoft.com/.default'],
            });
            return res?.accessToken!;
        });
    }
```

#### Add testConnection for Health Checks

```typescript
    /** Test if we can acquire a token for the given account (used by health dashboard) */
    static async testConnection(account: IAccount): Promise<{ok: boolean, error?: string}>
    {
        try {
            await this.#aquireToken(account);
            return {ok: true};
        } catch(error: any) {
            return {ok: false, error: String(error)};
        }
    }
```

---

### 3c. SMTPServer Changes

**File: `src/classes/SMTPServer.ts`**

The SMTP server needs to perform account matching during the SMTP transaction and pass account metadata to the queue.

#### Store Account on Session

TypeScript's `smtp-server` types define the session object. You'll need to augment it or cast to store the matched account. The simplest approach is to use `(session as any).matchedAccount`:

#### Update #onConnect

```typescript
    #onConnect: SMTPServerOptions['onConnect'] = (session, callback)=>
    {
        // Global IP whitelist check (existing behavior, now acts as pre-filter)
        if(!Config.isIpAllowed(session.remoteAddress))
        {
            callback(new Error(`IP ${session.remoteAddress} is not allowed to connect`));
            return;
        }

        // Multi-account check: does any account accept this IP?
        if(Config.accounts.length > 0 && !Config.isIpAllowedByAnyAccount(session.remoteAddress))
        {
            callback(new Error(`IP ${session.remoteAddress} has no relay account configured`));
            return;
        }

        this.#rateLimiter.consume('all').then(()=>{
            callback();
        }).catch((rateLimit: RateLimiterRes)=>{
            callback(new Error(`Rate limit exceeded. Try again in ${Math.ceil(rateLimit.msBeforeNext/1000)} seconds`));
        });
    };
```

#### Update #onMailFrom

```typescript
    #onMailFrom: SMTPServerOptions['onMailFrom'] = (address, session, callback)=>
    {
        // Existing FROM address check (for legacy single-account with SMTP users)
        if(!Config.isFromAllowed(address.address, session.user))
        {
            callback(new Error(`FROM "${address.address}" not allowed`));
            return;
        }

        // Multi-account routing: find matching account
        if(Config.accounts.length > 0)
        {
            const account = Config.findAccountForSender(session.remoteAddress, address.address);
            if(!account)
            {
                callback(new Error(`No relay account configured for "${address.address}" from IP ${session.remoteAddress}`));
                return;
            }
            (session as any).matchedAccount = account;
            log('verbose', `Matched account "${account.name}" for ${address.address} from ${session.remoteAddress}`);
        }

        callback();
    };
```

#### Update #onData — Write Sidecar .meta.json

At the end of the `writeStream.on('close', ...)` handler, after calling `this.#queue.add(tmpFile)`, also write the sidecar file:

```typescript
    writeStream.on('close', () => {
        if(stream.sizeExceeded)
        {
            // ... existing size-exceeded handling (unchanged) ...
        }
        else
        {
            // Write sidecar metadata file for multi-account routing
            const matchedAccount = (session as any).matchedAccount;
            if(matchedAccount)
            {
                const metaFile = tmpFile.replace(/\.eml$/, '.meta.json');
                try {
                    fs.writeFileSync(metaFile, JSON.stringify({
                        accountName: matchedAccount.name,
                        clientIp: session.remoteAddress,
                        fromAddress: session.envelope.mailFrom?.address,
                        timestamp: new Date().toISOString(),
                    }));
                } catch(error) {
                    log('error', `Failed to write metadata file`, {error});
                }
            }

            callback();
            this.#queue.add(tmpFile);
        }
    });
```

---

### 3d. MailQueue Changes

**File: `src/classes/MailQueue.ts`**

#### Import IAccount

```typescript
import { Config, IAccount } from './Config';
```

#### Update the Watcher to Handle .meta.json

The chokidar watcher currently watches `*.eml`. When we move an `.eml` file to the queue, we also need to move its `.meta.json` sidecar. Update the `add()` method:

```typescript
    add(filePath: string)
    {
        const filename = path.basename(filePath);
        const dest = path.join(this.#queuePath, filename);

        // Also move the sidecar .meta.json if it exists
        const metaSrc = filePath.replace(/\.eml$/, '.meta.json');
        const metaDest = dest.replace(/\.eml$/, '.meta.json');

        const attempt = (tries = 0) => {
            try {
                fs.renameSync(filePath, dest);
                // Move sidecar if it exists
                if(fs.existsSync(metaSrc))
                    fs.renameSync(metaSrc, metaDest);
                log('verbose', `Moved file "${filename}" to queue`);
            } catch(error: any) {
                if(error.code === 'EPERM' && process.platform === 'win32' && tries < 5) {
                    log('warn', `EPERM renaming "${filename}", retrying`, {tries});
                    setTimeout(() => attempt(tries + 1), 100);
                } else {
                    log('error', `Error while moving "${filename}" to queue`, {error, filename});
                }
            }
        };

        attempt();
    }
```

#### Update #onFileAdded to Read Sidecar and Pass Account

```typescript
    async #onFileAdded(filePath: string)
    {
        const filename = path.basename(filePath);
        log('verbose', `File "${filename}" appeared in the queue`);

        // Read sidecar metadata to determine which account to use
        let account: IAccount | undefined;
        const metaPath = filePath.replace(/\.eml$/, '.meta.json');
        try {
            if(fs.existsSync(metaPath))
            {
                const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
                account = Config.accounts.find(a => a.name === meta.accountName);
                if(!account)
                    log('warn', `Account "${meta.accountName}" from sidecar not found in config, using first account`);
            }
        } catch(error) {
            log('warn', `Failed to read sidecar for "${filename}"`, {error});
        }

        // Fallback to first account (or the only account in single-account mode)
        if(!account)
            account = Config.accounts[0];

        if(!account)
        {
            log('error', `No relay account available for "${filename}"`);
            return;
        }

        try {
            await Mailer.sendEml(filePath, account);
            this.remove(filePath);
            this.#removeSidecar(filePath);
            this.#removeFromRetryQueue(filename);
        } catch(error) {
            log('error', `Failed to send message "${filename}" via account "${account.name}"`, {error, filename});
            if(!(error instanceof UnrecoverableError))
                this.#addToRetryQueue(filename);
            else
                this.#moveToFailed(filename);
        }
    }
```

#### Add Sidecar Cleanup Helpers

```typescript
    #removeSidecar(filePath: string)
    {
        const metaPath = filePath.replace(/\.eml$/, '.meta.json');
        try {
            if(fs.existsSync(metaPath))
                fs.unlinkSync(metaPath);
        } catch(error) {
            log('warn', `Failed to remove sidecar for "${path.basename(filePath)}"`, {error});
        }
    }
```

Also update the existing code that moves files to the failed directory (in `#addToRetryQueue`) to also move the sidecar:

```typescript
    // Inside #addToRetryQueue, when moving to failed:
    fs.renameSync(path.join(this.#queuePath, filename), path.join(this.#failedPath, filename));
    // Add: move sidecar too
    const metaFile = filename.replace(/\.eml$/, '.meta.json');
    const metaSrc = path.join(this.#queuePath, metaFile);
    if(fs.existsSync(metaSrc))
        fs.renameSync(metaSrc, path.join(this.#failedPath, metaFile));
```

#### Add Health Metric Getters

```typescript
    /** Queue statistics for health dashboard */
    get queueStats(): {queued: number, failed: number, retrying: number, temp: number}
    {
        const countEml = (dir: string): number => {
            try {
                return fs.readdirSync(dir).filter(f => f.endsWith('.eml')).length;
            } catch { return 0; }
        };

        return {
            queued: countEml(this.#queuePath),
            failed: countEml(this.#failedPath),
            retrying: this.#retryQueue.size,
            temp: countEml(this.#tempPath),
        };
    }

    get isPaused(): boolean
    {
        return this.#paused;
    }

    get queuePath(): string
    {
        return this.#queuePath;
    }

    get failedPath(): string
    {
        return this.#failedPath;
    }
```

---

### 3e. SMTPServer — Add isListening Getter

**File: `src/classes/SMTPServer.ts`**

Add a public getter for the health dashboard:

```typescript
    get isListening(): boolean
    {
        return this.#server.server.listening;
    }
```

---

## 4. WebUI Server Implementation

### Dependencies to Add

Run:
```bash
npm install express ajv
npm install --save-dev @types/express
```

Or add to `package.json`:

```json
"dependencies": {
    "express": "^4.21.0",
    "ajv": "^8.17.0",
    // ... existing ...
},
"devDependencies": {
    "@types/express": "^5.0.0",
    // ... existing ...
}
```

### File Structure to Create

```
src/webui/
  WebServer.ts              # Express app setup, Basic Auth, static serving
  routes/
    configRoutes.ts         # GET/PUT /api/config endpoints
    healthRoutes.ts         # GET /api/health, /api/queue, /api/logs
    accountRoutes.ts        # GET/POST/PUT/DELETE /api/accounts
  services/
    ConfigService.ts        # Read/write/validate config.yml
    HealthService.ts        # Aggregate health metrics
  public/
    index.html              # Main SPA shell
    app.js                  # Frontend JavaScript (vanilla)
    style.css               # Retro OS theme CSS
```

### WebServer.ts

```typescript
import express, { Request, Response, NextFunction } from 'express';
import path from 'path';
import { Config } from '../classes/Config';
import { prefixedLog } from '../classes/Logger';
import { MailQueue } from '../classes/MailQueue';
import { SMTPServer } from '../classes/SMTPServer';
import { configRoutes } from './routes/configRoutes';
import { healthRoutes } from './routes/healthRoutes';
import { accountRoutes } from './routes/accountRoutes';

const log = prefixedLog('WebUI');

export class WebServer
{
    #app: express.Application;
    #queue: MailQueue;
    #smtpServer: SMTPServer;

    constructor(queue: MailQueue, smtpServer: SMTPServer)
    {
        this.#queue = queue;
        this.#smtpServer = smtpServer;
        this.#app = express();

        this.#setupMiddleware();
        this.#setupRoutes();
    }

    #setupMiddleware()
    {
        // JSON body parser
        this.#app.use(express.json());

        // Basic Auth
        this.#app.use((req: Request, res: Response, next: NextFunction) => {
            const auth = req.headers.authorization;
            if(!auth || !auth.startsWith('Basic '))
            {
                res.setHeader('WWW-Authenticate', 'Basic realm="SMTP2Graph WebUI"');
                res.status(401).send('Authentication required');
                return;
            }

            const decoded = Buffer.from(auth.substring(6), 'base64').toString();
            const [username, password] = decoded.split(':');

            if(username === Config.webuiUsername && password === Config.webuiPassword)
                next();
            else
            {
                res.setHeader('WWW-Authenticate', 'Basic realm="SMTP2Graph WebUI"');
                res.status(401).send('Invalid credentials');
            }
        });
    }

    #setupRoutes()
    {
        // API routes
        this.#app.use('/api', configRoutes());
        this.#app.use('/api', healthRoutes(this.#queue, this.#smtpServer));
        this.#app.use('/api', accountRoutes());

        // Static files — serve embedded HTML/JS/CSS
        // These files are loaded as strings via webpack asset/source
        // See Section 6 for webpack config changes
        this.#app.get('/', (req, res) => {
            res.type('html').send(require('./public/index.html'));
        });
        this.#app.get('/app.js', (req, res) => {
            res.type('js').send(require('./public/app.js'));
        });
        this.#app.get('/style.css', (req, res) => {
            res.type('css').send(require('./public/style.css'));
        });
    }

    listen(): Promise<void>
    {
        return new Promise((resolve) => {
            this.#app.listen(Config.webuiPort, Config.webuiListenAddress, () => {
                log('info', `WebUI started on ${Config.webuiListenAddress}:${Config.webuiPort}`);
                resolve();
            });
        });
    }
}
```

### routes/healthRoutes.ts

```typescript
import { Router } from 'express';
import { MailQueue } from '../../classes/MailQueue';
import { SMTPServer } from '../../classes/SMTPServer';
import { Mailer } from '../../classes/Mailer';
import { Config } from '../../classes/Config';
import fs from 'fs';
import path from 'path';

export function healthRoutes(queue: MailQueue, smtpServer: SMTPServer): Router
{
    const router = Router();

    // Overall health status
    router.get('/health', async (req, res) => {
        const accountHealth = [];
        for(const account of Config.accounts)
        {
            const connectivity = await Mailer.testConnection(account);
            accountHealth.push({
                name: account.name,
                tenant: account.appReg.tenant,
                graphApi: connectivity,
            });
        }

        res.json({
            smtp: {
                listening: smtpServer.isListening,
                port: Config.smtpPort,
                mode: Config.mode,
            },
            accounts: accountHealth,
            queue: queue.queueStats,
            paused: queue.isPaused,
            uptime: process.uptime(),
            version: VERSION,
        });
    });

    // Queue statistics
    router.get('/queue', (req, res) => {
        res.json(queue.queueStats);
    });

    // Recent log entries
    router.get('/logs', (req, res) => {
        const lines = parseInt(req.query.lines as string) || 100;
        const logFile = path.join('logs', 'combined.log');

        try {
            if(!fs.existsSync(logFile))
            {
                res.json([]);
                return;
            }

            const content = fs.readFileSync(logFile, 'utf-8');
            const allLines = content.trim().split('\n').filter(l => l);
            const recent = allLines.slice(-lines);

            // Parse JSON log entries
            const entries = recent.map(line => {
                try { return JSON.parse(line); }
                catch { return {message: line}; }
            });

            res.json(entries);
        } catch(error) {
            res.status(500).json({error: 'Failed to read logs'});
        }
    });

    return router;
}
```

### routes/configRoutes.ts

```typescript
import { Router } from 'express';
import { ConfigService } from '../services/ConfigService';

export function configRoutes(): Router
{
    const router = Router();
    const configService = new ConfigService();

    // Get current config
    router.get('/config', (req, res) => {
        try {
            const showSecrets = req.query.showSecrets === 'true';
            const config = configService.getConfig(showSecrets);
            res.json(config);
        } catch(error) {
            res.status(500).json({error: 'Failed to read config'});
        }
    });

    // Update config
    router.put('/config', (req, res) => {
        try {
            const result = configService.updateConfig(req.body);
            if(result.success)
                res.json({success: true, message: 'Config saved. Restart required for changes to take effect.'});
            else
                res.status(400).json({success: false, errors: result.errors});
        } catch(error) {
            res.status(500).json({error: 'Failed to save config'});
        }
    });

    // Get JSON schema
    router.get('/config/schema', (req, res) => {
        try {
            const schema = configService.getSchema();
            res.json(schema);
        } catch(error) {
            res.status(500).json({error: 'Failed to read schema'});
        }
    });

    return router;
}
```

### routes/accountRoutes.ts

```typescript
import { Router } from 'express';
import { Config } from '../../classes/Config';
import { Mailer } from '../../classes/Mailer';
import { ConfigService } from '../services/ConfigService';

export function accountRoutes(): Router
{
    const router = Router();
    const configService = new ConfigService();

    // List all accounts
    router.get('/accounts', (req, res) => {
        const showSecrets = req.query.showSecrets === 'true';
        const accounts = Config.accounts.map(account => ({
            name: account.name,
            tenant: account.appReg.tenant,
            clientId: account.appReg.id,
            hasSecret: Boolean(account.appReg.secret),
            hasCertificate: Boolean(account.appReg.certificate),
            allowedIPs: account.allowedIPs || [],
            allowedFrom: account.allowedFrom || [],
            forceMailbox: account.forceMailbox,
            retryLimit: account.retryLimit ?? 3,
            retryInterval: account.retryInterval ?? 5,
            // Only show secrets if requested
            ...(showSecrets ? {secret: account.appReg.secret} : {}),
        }));
        res.json(accounts);
    });

    // Test connectivity for a specific account
    router.get('/accounts/:name/test', async (req, res) => {
        const account = Config.accounts.find(a => a.name === req.params.name);
        if(!account)
        {
            res.status(404).json({error: `Account "${req.params.name}" not found`});
            return;
        }

        const result = await Mailer.testConnection(account);
        res.json(result);
    });

    // Add new account (writes to config.yml)
    router.post('/accounts', (req, res) => {
        try {
            const config = configService.getConfig(true);
            if(!config.accounts) config.accounts = [];
            config.accounts.push(req.body);
            const result = configService.updateConfig(config);
            if(result.success)
                res.json({success: true, message: 'Account added. Restart required.'});
            else
                res.status(400).json({success: false, errors: result.errors});
        } catch(error) {
            res.status(500).json({error: 'Failed to add account'});
        }
    });

    // Update existing account
    router.put('/accounts/:name', (req, res) => {
        try {
            const config = configService.getConfig(true);
            if(!config.accounts) config.accounts = [];
            const idx = config.accounts.findIndex((a: any) => a.name === req.params.name);
            if(idx === -1)
            {
                res.status(404).json({error: `Account "${req.params.name}" not found`});
                return;
            }
            config.accounts[idx] = req.body;
            const result = configService.updateConfig(config);
            if(result.success)
                res.json({success: true, message: 'Account updated. Restart required.'});
            else
                res.status(400).json({success: false, errors: result.errors});
        } catch(error) {
            res.status(500).json({error: 'Failed to update account'});
        }
    });

    // Delete account
    router.delete('/accounts/:name', (req, res) => {
        try {
            const config = configService.getConfig(true);
            if(!config.accounts)
            {
                res.status(404).json({error: 'No accounts configured'});
                return;
            }
            const idx = config.accounts.findIndex((a: any) => a.name === req.params.name);
            if(idx === -1)
            {
                res.status(404).json({error: `Account "${req.params.name}" not found`});
                return;
            }
            config.accounts.splice(idx, 1);
            const result = configService.updateConfig(config);
            if(result.success)
                res.json({success: true, message: 'Account removed. Restart required.'});
            else
                res.status(400).json({success: false, errors: result.errors});
        } catch(error) {
            res.status(500).json({error: 'Failed to delete account'});
        }
    });

    return router;
}
```

### services/ConfigService.ts

```typescript
import fs from 'fs';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import Ajv from 'ajv';

export class ConfigService
{
    #configFile: string;
    #schemaFile: string;

    constructor(configFile: string = 'config.yml', schemaFile: string = 'config.schema.json')
    {
        this.#configFile = configFile;
        this.#schemaFile = schemaFile;
    }

    getConfig(showSecrets: boolean = false): any
    {
        const content = fs.readFileSync(this.#configFile, 'utf-8');
        const config = parseYaml(content);

        if(!showSecrets)
            this.#maskSecrets(config);

        return config;
    }

    getSchema(): any
    {
        const content = fs.readFileSync(this.#schemaFile, 'utf-8');
        return JSON.parse(content);
    }

    updateConfig(newConfig: any): {success: boolean, errors?: string[]}
    {
        // Validate against JSON schema
        try {
            const schema = this.getSchema();
            const ajv = new Ajv({allErrors: true});
            const validate = ajv.compile(schema);
            const valid = validate(newConfig);

            if(!valid && validate.errors)
            {
                const errors = validate.errors.map(e =>
                    `${e.instancePath || '/'}: ${e.message}`
                );
                return {success: false, errors};
            }
        } catch(error) {
            return {success: false, errors: [`Schema validation error: ${String(error)}`]};
        }

        // Write YAML
        try {
            const yamlContent = stringifyYaml(newConfig, {indent: 2});
            fs.writeFileSync(this.#configFile, yamlContent, 'utf-8');
            return {success: true};
        } catch(error) {
            return {success: false, errors: [`Failed to write config: ${String(error)}`]};
        }
    }

    #maskSecrets(config: any)
    {
        // Mask send.appReg.secret
        if(config?.send?.appReg?.secret)
            config.send.appReg.secret = '********';

        // Mask account secrets
        if(config?.accounts)
        {
            for(const account of config.accounts)
            {
                if(account?.appReg?.secret)
                    account.appReg.secret = '********';
            }
        }

        // Mask user passwords
        if(config?.receive?.users)
        {
            for(const user of config.receive.users)
            {
                if(user?.password)
                    user.password = '********';
            }
        }

        // Mask webui password
        if(config?.webui?.password)
            config.webui.password = '********';
    }
}
```

### services/HealthService.ts

```typescript
import { MailQueue } from '../../classes/MailQueue';
import { SMTPServer } from '../../classes/SMTPServer';
import { Mailer } from '../../classes/Mailer';
import { Config, IAccount } from '../../classes/Config';

export class HealthService
{
    #queue: MailQueue;
    #smtpServer: SMTPServer;

    constructor(queue: MailQueue, smtpServer: SMTPServer)
    {
        this.#queue = queue;
        this.#smtpServer = smtpServer;
    }

    async getHealth()
    {
        const accountHealth = [];
        for(const account of Config.accounts)
        {
            const connectivity = await Mailer.testConnection(account);
            accountHealth.push({
                name: account.name,
                tenant: account.appReg.tenant,
                graphApi: connectivity,
            });
        }

        return {
            smtp: {
                listening: this.#smtpServer.isListening,
                port: Config.smtpPort,
                mode: Config.mode,
            },
            accounts: accountHealth,
            queue: this.#queue.queueStats,
            paused: this.#queue.isPaused,
            uptime: process.uptime(),
            version: VERSION,
        };
    }
}
```

### Entry Point Integration

**File: `src/server.ts`**

Add WebUI startup after the SMTP server starts:

```typescript
import { Config } from './classes/Config';
import { log } from './classes/Logger';
import { MailQueue } from './classes/MailQueue';
import { SMTPServer } from './classes/SMTPServer';

if(process.argv.includes('-v') || process.argv.includes('--version'))
    console.log(`SMTP2Graph v${VERSION}`);
else
{
    (async ()=>{
        try {
            Config.validate();
        } catch(error) {
            await log('error', `Invalid config. ${String(error)}`, {error});
            process.exit(1);
        }

        const queue = new MailQueue();
        const server = new SMTPServer(queue);
        try {
            await server.listen();
        } catch(error) {
            log('error', `Failed to start SMTP server. ${String(error)}`, {error});
            process.exit(1);
        }

        // Start WebUI if enabled
        if(Config.webuiEnabled)
        {
            try {
                const { WebServer } = await import('./webui/WebServer');
                const webServer = new WebServer(queue, server);
                await webServer.listen();
            } catch(error) {
                log('error', `Failed to start WebUI. ${String(error)}`, {error});
                // Don't exit — SMTP relay still works without WebUI
            }
        }
    })();
}

process.on('SIGINT', ()=>{ process.exit(0); });
process.on('SIGTERM', ()=>{ process.exit(0); });
```

---

## 5. Frontend (Retro OS Theme)

### Visual Design Reference

The UI uses a **Classic Mac OS 9 / Windows 98** aesthetic — all achievable with pure CSS.

### public/index.html

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>SMTP2Graph Control Panel</title>
    <link rel="stylesheet" href="/style.css">
</head>
<body>
    <div class="desktop">
        <div class="window" id="main-window">
            <div class="title-bar">
                <span class="title-bar-text">SMTP2Graph Control Panel</span>
                <div class="title-bar-controls">
                    <button class="title-btn minimize-btn"></button>
                    <button class="title-btn maximize-btn"></button>
                    <button class="title-btn close-btn"></button>
                </div>
            </div>

            <div class="menu-bar">
                <span class="menu-item">File</span>
                <span class="menu-item">View</span>
                <span class="menu-item">Help</span>
            </div>

            <div class="tab-bar">
                <button class="tab active" data-tab="dashboard">System Monitor</button>
                <button class="tab" data-tab="accounts">Network Accounts</button>
                <button class="tab" data-tab="config">System Properties</button>
            </div>

            <div class="tab-content" id="tab-dashboard">
                <div class="panel-row">
                    <div class="group-box" id="smtp-status">
                        <legend>SMTP Server Status</legend>
                        <div class="status-row">
                            <span class="status-icon" id="smtp-icon">●</span>
                            <span id="smtp-status-text">Checking...</span>
                        </div>
                        <div class="detail-row">
                            <span>Port:</span> <span id="smtp-port">—</span>
                        </div>
                        <div class="detail-row">
                            <span>Mode:</span> <span id="smtp-mode">—</span>
                        </div>
                        <div class="detail-row">
                            <span>Uptime:</span> <span id="smtp-uptime">—</span>
                        </div>
                        <div class="detail-row">
                            <span>Version:</span> <span id="smtp-version">—</span>
                        </div>
                    </div>

                    <div class="group-box" id="queue-status">
                        <legend>Mail Queue</legend>
                        <div class="detail-row">
                            <span>Queued:</span> <span id="queue-queued">—</span>
                        </div>
                        <div class="detail-row">
                            <span>Retrying:</span> <span id="queue-retrying">—</span>
                        </div>
                        <div class="detail-row">
                            <span>Failed:</span> <span id="queue-failed">—</span>
                        </div>
                        <div class="detail-row">
                            <span>In progress:</span> <span id="queue-temp">—</span>
                        </div>
                    </div>
                </div>

                <div class="group-box" id="accounts-health">
                    <legend>Relay Account Health</legend>
                    <div id="account-cards" class="account-cards">
                        <p class="placeholder">Loading...</p>
                    </div>
                </div>

                <div class="group-box" id="log-viewer">
                    <legend>Recent Activity</legend>
                    <div class="log-area" id="log-area">
                        <pre id="log-content">Loading logs...</pre>
                    </div>
                </div>
            </div>

            <div class="tab-content hidden" id="tab-accounts">
                <div class="toolbar">
                    <button class="btn" id="btn-add-account">Add Account</button>
                    <button class="btn" id="btn-refresh-accounts">Refresh</button>
                </div>

                <div class="listview" id="accounts-list">
                    <div class="listview-header">
                        <span class="col-name">Name</span>
                        <span class="col-tenant">Tenant</span>
                        <span class="col-auth">Auth</span>
                        <span class="col-ips">Allowed IPs</span>
                        <span class="col-from">Allowed From</span>
                        <span class="col-actions">Actions</span>
                    </div>
                    <div id="accounts-rows" class="listview-body">
                        <p class="placeholder">Loading...</p>
                    </div>
                </div>
            </div>

            <div class="tab-content hidden" id="tab-config">
                <div class="toolbar">
                    <button class="btn" id="btn-save-config">Save</button>
                    <button class="btn" id="btn-reload-config">Reload</button>
                </div>
                <div id="restart-banner" class="alert-banner hidden">
                    ⚠ Configuration changed. Restart SMTP2Graph for changes to take effect.
                </div>
                <div id="config-form" class="config-form">
                    <p class="placeholder">Loading configuration...</p>
                </div>
            </div>

            <div class="status-bar">
                <span id="statusbar-text">Ready</span>
                <span id="statusbar-time"></span>
            </div>
        </div>
    </div>

    <!-- Account Edit Dialog -->
    <div class="dialog-overlay hidden" id="account-dialog-overlay">
        <div class="window dialog" id="account-dialog">
            <div class="title-bar">
                <span class="title-bar-text" id="dialog-title">Add Relay Account</span>
                <div class="title-bar-controls">
                    <button class="title-btn close-btn" id="dialog-close"></button>
                </div>
            </div>
            <div class="dialog-body">
                <div class="form-group">
                    <label>Account Name:</label>
                    <input type="text" id="acct-name" class="field">
                </div>
                <div class="form-group">
                    <label>Tenant:</label>
                    <input type="text" id="acct-tenant" class="field" placeholder="contoso or GUID">
                </div>
                <div class="form-group">
                    <label>Client ID:</label>
                    <input type="text" id="acct-client-id" class="field">
                </div>
                <div class="form-group">
                    <label>Client Secret:</label>
                    <input type="password" id="acct-secret" class="field" placeholder="Leave blank for certificate auth">
                </div>
                <div class="form-group">
                    <label>Certificate Thumbprint:</label>
                    <input type="text" id="acct-cert-thumbprint" class="field">
                </div>
                <div class="form-group">
                    <label>Private Key Path:</label>
                    <input type="text" id="acct-cert-key-path" class="field">
                </div>
                <div class="form-group">
                    <label>Allowed IPs (one per line):</label>
                    <textarea id="acct-allowed-ips" class="field" rows="4" placeholder="10.0.1.0/24&#10;192.168.1.50"></textarea>
                </div>
                <div class="form-group">
                    <label>Allowed FROM Addresses (one per line):</label>
                    <textarea id="acct-allowed-from" class="field" rows="4" placeholder="noreply@contoso.com&#10;alerts@contoso.com"></textarea>
                </div>
                <div class="form-group">
                    <label>Force Mailbox (optional):</label>
                    <input type="text" id="acct-force-mailbox" class="field">
                </div>
                <div class="form-row">
                    <div class="form-group half">
                        <label>Retry Limit:</label>
                        <input type="number" id="acct-retry-limit" class="field" value="3">
                    </div>
                    <div class="form-group half">
                        <label>Retry Interval (min):</label>
                        <input type="number" id="acct-retry-interval" class="field" value="5">
                    </div>
                </div>
                <div class="dialog-buttons">
                    <button class="btn" id="btn-dialog-save">OK</button>
                    <button class="btn" id="btn-dialog-cancel">Cancel</button>
                </div>
            </div>
        </div>
    </div>

    <!-- Alert Dialog -->
    <div class="dialog-overlay hidden" id="alert-dialog-overlay">
        <div class="window dialog dialog-sm" id="alert-dialog">
            <div class="title-bar">
                <span class="title-bar-text" id="alert-title">SMTP2Graph</span>
                <div class="title-bar-controls">
                    <button class="title-btn close-btn" id="alert-close"></button>
                </div>
            </div>
            <div class="dialog-body">
                <p id="alert-message"></p>
                <div class="dialog-buttons">
                    <button class="btn" id="alert-ok">OK</button>
                </div>
            </div>
        </div>
    </div>

    <script src="/app.js"></script>
</body>
</html>
```

### public/style.css

```css
/* =============================================
   SMTP2Graph WebUI — Retro OS Theme
   Inspired by Mac OS 9 / Windows 98
   ============================================= */

/* Reset & Base */
*, *::before, *::after {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
}

body {
    font-family: "Chicago", "MS Sans Serif", "Tahoma", "Geneva", sans-serif;
    font-size: 11px;
    background: #008080;
    color: #000;
    overflow: hidden;
    height: 100vh;
}

/* Desktop */
.desktop {
    width: 100vw;
    height: 100vh;
    padding: 8px;
    display: flex;
    align-items: stretch;
    justify-content: center;
}

/* Window */
.window {
    background: #c0c0c0;
    border: 2px outset #dfdfdf;
    box-shadow: 2px 2px 0 #000;
    display: flex;
    flex-direction: column;
    width: 100%;
    max-width: 1100px;
}

/* Title Bar */
.title-bar {
    background: linear-gradient(90deg, #000080, #1084d0);
    color: #fff;
    padding: 2px 4px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-weight: bold;
    font-size: 12px;
    user-select: none;
}

.title-bar-text {
    flex: 1;
    padding-left: 2px;
}

.title-bar-controls {
    display: flex;
    gap: 2px;
}

.title-btn {
    width: 16px;
    height: 14px;
    background: #c0c0c0;
    border: 1px outset #dfdfdf;
    font-size: 8px;
    line-height: 1;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
}

.title-btn:active {
    border-style: inset;
}

.minimize-btn::after { content: "–"; }
.maximize-btn::after { content: "□"; }
.close-btn::after { content: "×"; font-size: 10px; }

/* Menu Bar */
.menu-bar {
    background: #c0c0c0;
    border-bottom: 1px solid #808080;
    padding: 2px 4px;
    display: flex;
    gap: 8px;
}

.menu-item {
    padding: 1px 6px;
    cursor: default;
}

.menu-item:hover {
    background: #000080;
    color: #fff;
}

/* Tab Bar */
.tab-bar {
    background: #c0c0c0;
    padding: 6px 6px 0 6px;
    display: flex;
    gap: 0;
    border-bottom: 2px solid #c0c0c0;
}

.tab {
    background: #c0c0c0;
    border: 1px solid #808080;
    border-bottom: none;
    padding: 4px 16px;
    cursor: pointer;
    font-family: inherit;
    font-size: 11px;
    position: relative;
    top: 2px;
    margin-right: -1px;
}

.tab.active {
    background: #c0c0c0;
    border-top: 2px solid #dfdfdf;
    border-left: 2px solid #dfdfdf;
    border-right: 2px solid #808080;
    border-bottom: 2px solid #c0c0c0;
    z-index: 1;
    font-weight: bold;
}

/* Tab Content */
.tab-content {
    flex: 1;
    overflow-y: auto;
    padding: 8px;
    background: #c0c0c0;
    border-top: 1px solid #808080;
}

.tab-content.hidden {
    display: none;
}

/* Group Box (etched fieldset) */
.group-box {
    border: 2px groove #dfdfdf;
    padding: 8px;
    margin-bottom: 8px;
    position: relative;
}

.group-box legend {
    background: #c0c0c0;
    padding: 0 4px;
    font-weight: bold;
    font-size: 11px;
}

/* Buttons */
.btn {
    background: #c0c0c0;
    border: 2px outset #dfdfdf;
    padding: 3px 12px;
    font-family: inherit;
    font-size: 11px;
    cursor: pointer;
    min-width: 75px;
}

.btn:hover {
    background: #d4d4d4;
}

.btn:active {
    border-style: inset;
    padding: 4px 11px 2px 13px;
}

.btn:focus {
    outline: 1px dotted #000;
    outline-offset: -4px;
}

/* Input Fields */
.field {
    background: #fff;
    border: 2px inset #c0c0c0;
    padding: 2px 4px;
    font-family: inherit;
    font-size: 11px;
    width: 100%;
}

textarea.field {
    resize: vertical;
    font-family: "Courier New", monospace;
}

/* Status Row */
.status-row {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    margin-bottom: 4px;
}

.status-icon {
    font-size: 14px;
}

.status-icon.ok { color: #008000; }
.status-icon.error { color: #ff0000; }
.status-icon.warning { color: #ff8c00; }

.detail-row {
    display: flex;
    justify-content: space-between;
    padding: 1px 0;
    border-bottom: 1px dotted #a0a0a0;
}

/* Panel Row (side by side) */
.panel-row {
    display: flex;
    gap: 8px;
}

.panel-row > .group-box {
    flex: 1;
}

/* Account Cards */
.account-cards {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
}

.account-card {
    border: 2px outset #dfdfdf;
    background: #c0c0c0;
    width: 220px;
}

.account-card .card-title {
    background: linear-gradient(90deg, #000080, #1084d0);
    color: #fff;
    padding: 2px 4px;
    font-size: 11px;
    font-weight: bold;
}

.account-card .card-body {
    padding: 6px;
}

.account-card .card-body .detail-row {
    font-size: 10px;
}

/* Log Area */
.log-area {
    background: #000;
    color: #00ff00;
    border: 2px inset #808080;
    padding: 4px;
    height: 200px;
    overflow-y: auto;
    font-family: "Courier New", "Lucida Console", monospace;
    font-size: 10px;
}

.log-area pre {
    white-space: pre-wrap;
    word-wrap: break-word;
}

/* Toolbar */
.toolbar {
    display: flex;
    gap: 4px;
    padding: 4px 0;
    border-bottom: 1px solid #808080;
    margin-bottom: 8px;
}

/* Listview */
.listview {
    border: 2px inset #c0c0c0;
    background: #fff;
}

.listview-header {
    display: flex;
    background: #c0c0c0;
    border-bottom: 2px outset #dfdfdf;
    font-weight: bold;
    font-size: 11px;
}

.listview-header span {
    padding: 2px 8px;
    border-right: 1px solid #808080;
    flex-shrink: 0;
}

.col-name { width: 140px; }
.col-tenant { width: 120px; }
.col-auth { width: 80px; }
.col-ips { flex: 1; min-width: 160px; }
.col-from { flex: 1; min-width: 160px; }
.col-actions { width: 160px; }

.listview-body {
    max-height: 400px;
    overflow-y: auto;
}

.listview-row {
    display: flex;
    padding: 2px 0;
    border-bottom: 1px solid #e0e0e0;
    align-items: center;
    cursor: default;
}

.listview-row:nth-child(even) {
    background: #f0f0f0;
}

.listview-row:hover {
    background: #000080;
    color: #fff;
}

.listview-row span {
    padding: 2px 8px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.listview-row .col-actions {
    display: flex;
    gap: 4px;
    padding: 2px 4px;
}

.listview-row .col-actions .btn {
    min-width: auto;
    padding: 1px 6px;
    font-size: 10px;
}

/* Status Bar */
.status-bar {
    background: #c0c0c0;
    border-top: 2px groove #dfdfdf;
    padding: 2px 8px;
    display: flex;
    justify-content: space-between;
    font-size: 10px;
}

/* Dialog Overlay */
.dialog-overlay {
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0,0,0,0.3);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
}

.dialog-overlay.hidden {
    display: none;
}

.dialog {
    width: 450px;
    max-height: 80vh;
    box-shadow: 4px 4px 0 #000;
}

.dialog-sm {
    width: 320px;
}

.dialog-body {
    padding: 12px;
    overflow-y: auto;
}

.dialog-buttons {
    display: flex;
    justify-content: center;
    gap: 8px;
    margin-top: 12px;
}

/* Form */
.form-group {
    margin-bottom: 8px;
}

.form-group label {
    display: block;
    margin-bottom: 2px;
    font-weight: bold;
}

.form-row {
    display: flex;
    gap: 8px;
}

.form-group.half {
    flex: 1;
}

/* Config Form */
.config-form {
    max-height: 500px;
    overflow-y: auto;
}

.config-section {
    margin-bottom: 12px;
}

.config-section h3 {
    font-size: 11px;
    padding: 2px 4px;
    background: #c0c0c0;
    border: 1px solid #808080;
    margin-bottom: 4px;
}

/* Alert Banner */
.alert-banner {
    background: #ffffe1;
    border: 2px outset #dfdfdf;
    padding: 6px 10px;
    margin-bottom: 8px;
    font-weight: bold;
    display: flex;
    align-items: center;
    gap: 6px;
}

.alert-banner.hidden {
    display: none;
}

/* Placeholder */
.placeholder {
    color: #808080;
    padding: 8px;
    text-align: center;
    font-style: italic;
}

/* Scrollbar styling (Webkit) */
::-webkit-scrollbar {
    width: 16px;
    height: 16px;
}

::-webkit-scrollbar-track {
    background: #c0c0c0;
    border: 1px inset #dfdfdf;
}

::-webkit-scrollbar-thumb {
    background: #c0c0c0;
    border: 2px outset #dfdfdf;
}

::-webkit-scrollbar-button {
    background: #c0c0c0;
    border: 2px outset #dfdfdf;
    width: 16px;
    height: 16px;
}

/* Responsive */
@media (max-width: 768px) {
    .panel-row {
        flex-direction: column;
    }
    .account-card {
        width: 100%;
    }
    .listview-header, .listview-row {
        font-size: 10px;
    }
}
```

### public/app.js

```javascript
/* =============================================
   SMTP2Graph WebUI — Frontend Logic
   ============================================= */

(function() {
    'use strict';

    // State
    let currentTab = 'dashboard';
    let healthPollInterval = null;
    let editingAccount = null; // null = adding new, string = editing existing

    // ---- Tab Navigation ----
    document.querySelectorAll('.tab').forEach(tab => {
        tab.addEventListener('click', () => {
            switchTab(tab.dataset.tab);
        });
    });

    function switchTab(tabName) {
        currentTab = tabName;
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));
        document.querySelector(`.tab[data-tab="${tabName}"]`).classList.add('active');
        document.getElementById(`tab-${tabName}`).classList.remove('hidden');

        if(tabName === 'dashboard') startHealthPolling();
        else stopHealthPolling();

        if(tabName === 'accounts') loadAccounts();
        if(tabName === 'config') loadConfig();
    }

    // ---- Dashboard ----
    function startHealthPolling() {
        fetchHealth();
        fetchLogs();
        healthPollInterval = setInterval(() => {
            fetchHealth();
            fetchLogs();
        }, 10000);
    }

    function stopHealthPolling() {
        if(healthPollInterval) {
            clearInterval(healthPollInterval);
            healthPollInterval = null;
        }
    }

    async function fetchHealth() {
        try {
            const res = await fetch('/api/health');
            const data = await res.json();
            updateDashboard(data);
            setStatus('Health data refreshed');
        } catch(err) {
            setStatus('Failed to fetch health data');
        }
    }

    function updateDashboard(data) {
        // SMTP Status
        const smtpIcon = document.getElementById('smtp-icon');
        const smtpText = document.getElementById('smtp-status-text');
        if(data.smtp.listening) {
            smtpIcon.className = 'status-icon ok';
            smtpText.textContent = 'Running';
        } else {
            smtpIcon.className = 'status-icon error';
            smtpText.textContent = 'Stopped';
        }
        document.getElementById('smtp-port').textContent = data.smtp.port;
        document.getElementById('smtp-mode').textContent = data.smtp.mode;
        document.getElementById('smtp-uptime').textContent = formatUptime(data.uptime);
        document.getElementById('smtp-version').textContent = 'v' + data.version;

        // Queue
        document.getElementById('queue-queued').textContent = data.queue.queued;
        document.getElementById('queue-retrying').textContent = data.queue.retrying;
        document.getElementById('queue-failed').textContent = data.queue.failed;
        document.getElementById('queue-temp').textContent = data.queue.temp;

        // Account Health Cards
        const container = document.getElementById('account-cards');
        container.innerHTML = '';
        if(data.accounts.length === 0) {
            container.innerHTML = '<p class="placeholder">No accounts configured</p>';
            return;
        }
        data.accounts.forEach(acct => {
            const card = document.createElement('div');
            card.className = 'account-card';
            const iconClass = acct.graphApi.ok ? 'ok' : 'error';
            const statusText = acct.graphApi.ok ? 'Connected' : (acct.graphApi.error || 'Error');
            card.innerHTML = `
                <div class="card-title">${escapeHtml(acct.name)}</div>
                <div class="card-body">
                    <div class="detail-row">
                        <span>Tenant:</span><span>${escapeHtml(acct.tenant)}</span>
                    </div>
                    <div class="detail-row">
                        <span>Graph API:</span>
                        <span><span class="status-icon ${iconClass}">●</span> ${escapeHtml(statusText)}</span>
                    </div>
                </div>
            `;
            container.appendChild(card);
        });
    }

    async function fetchLogs() {
        try {
            const res = await fetch('/api/logs?lines=50');
            const entries = await res.json();
            const logContent = document.getElementById('log-content');
            logContent.textContent = entries.map(e => {
                const ts = e.timestamp || '';
                const level = (e.level || '').toUpperCase().padEnd(7);
                return `[${ts}] ${level} ${e.message || JSON.stringify(e)}`;
            }).join('\n');

            // Auto-scroll to bottom
            const logArea = document.getElementById('log-area');
            logArea.scrollTop = logArea.scrollHeight;
        } catch(err) {
            // silent
        }
    }

    // ---- Accounts Tab ----
    async function loadAccounts() {
        try {
            const res = await fetch('/api/accounts');
            const accounts = await res.json();
            renderAccountsList(accounts);
            setStatus(`${accounts.length} account(s) loaded`);
        } catch(err) {
            setStatus('Failed to load accounts');
        }
    }

    function renderAccountsList(accounts) {
        const body = document.getElementById('accounts-rows');
        body.innerHTML = '';

        if(accounts.length === 0) {
            body.innerHTML = '<p class="placeholder">No accounts configured. Click "Add Account" to create one.</p>';
            return;
        }

        accounts.forEach(acct => {
            const row = document.createElement('div');
            row.className = 'listview-row';
            row.innerHTML = `
                <span class="col-name">${escapeHtml(acct.name)}</span>
                <span class="col-tenant">${escapeHtml(acct.tenant)}</span>
                <span class="col-auth">${acct.hasCertificate ? 'Cert' : 'Secret'}</span>
                <span class="col-ips" title="${escapeHtml(acct.allowedIPs.join(', '))}">${acct.allowedIPs.length ? acct.allowedIPs.join(', ') : 'Any'}</span>
                <span class="col-from" title="${escapeHtml(acct.allowedFrom.join(', '))}">${acct.allowedFrom.length ? acct.allowedFrom.join(', ') : 'Any'}</span>
                <span class="col-actions">
                    <button class="btn btn-test" data-name="${escapeHtml(acct.name)}">Test</button>
                    <button class="btn btn-edit" data-name="${escapeHtml(acct.name)}">Edit</button>
                    <button class="btn btn-delete" data-name="${escapeHtml(acct.name)}">Del</button>
                </span>
            `;
            body.appendChild(row);
        });

        // Event listeners
        body.querySelectorAll('.btn-test').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                testAccount(btn.dataset.name);
            });
        });
        body.querySelectorAll('.btn-edit').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                editAccount(btn.dataset.name);
            });
        });
        body.querySelectorAll('.btn-delete').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                deleteAccount(btn.dataset.name);
            });
        });
    }

    async function testAccount(name) {
        setStatus(`Testing connectivity for "${name}"...`);
        try {
            const res = await fetch(`/api/accounts/${encodeURIComponent(name)}/test`);
            const result = await res.json();
            if(result.ok)
                showAlert('Connection Test', `Account "${name}" connected successfully!`);
            else
                showAlert('Connection Test', `Account "${name}" failed: ${result.error}`);
        } catch(err) {
            showAlert('Error', `Failed to test account: ${err.message}`);
        }
    }

    async function editAccount(name) {
        try {
            const res = await fetch('/api/accounts?showSecrets=true');
            const accounts = await res.json();
            const acct = accounts.find(a => a.name === name);
            if(!acct) { showAlert('Error', 'Account not found'); return; }

            editingAccount = name;
            document.getElementById('dialog-title').textContent = `Edit Account: ${name}`;
            document.getElementById('acct-name').value = acct.name;
            document.getElementById('acct-tenant').value = acct.tenant;
            document.getElementById('acct-client-id').value = acct.clientId;
            document.getElementById('acct-secret').value = acct.secret || '';
            document.getElementById('acct-cert-thumbprint').value = '';
            document.getElementById('acct-cert-key-path').value = '';
            document.getElementById('acct-allowed-ips').value = acct.allowedIPs.join('\n');
            document.getElementById('acct-allowed-from').value = acct.allowedFrom.join('\n');
            document.getElementById('acct-force-mailbox').value = acct.forceMailbox || '';
            document.getElementById('acct-retry-limit').value = acct.retryLimit;
            document.getElementById('acct-retry-interval').value = acct.retryInterval;

            document.getElementById('account-dialog-overlay').classList.remove('hidden');
        } catch(err) {
            showAlert('Error', `Failed to load account: ${err.message}`);
        }
    }

    async function deleteAccount(name) {
        if(!confirm(`Delete account "${name}"? This requires a restart to take effect.`)) return;
        try {
            const res = await fetch(`/api/accounts/${encodeURIComponent(name)}`, {method: 'DELETE'});
            const result = await res.json();
            if(result.success) {
                showAlert('Success', result.message);
                loadAccounts();
            } else {
                showAlert('Error', result.errors?.join('\n') || 'Failed to delete');
            }
        } catch(err) {
            showAlert('Error', `Failed to delete account: ${err.message}`);
        }
    }

    // Add Account button
    document.getElementById('btn-add-account').addEventListener('click', () => {
        editingAccount = null;
        document.getElementById('dialog-title').textContent = 'Add Relay Account';
        document.querySelectorAll('#account-dialog .field').forEach(f => {
            if(f.tagName === 'TEXTAREA') f.value = '';
            else if(f.type === 'number') { /* keep defaults */ }
            else f.value = '';
        });
        document.getElementById('account-dialog-overlay').classList.remove('hidden');
    });

    document.getElementById('btn-refresh-accounts').addEventListener('click', loadAccounts);

    // Dialog save
    document.getElementById('btn-dialog-save').addEventListener('click', async () => {
        const account = buildAccountFromForm();
        const method = editingAccount ? 'PUT' : 'POST';
        const url = editingAccount
            ? `/api/accounts/${encodeURIComponent(editingAccount)}`
            : '/api/accounts';

        try {
            const res = await fetch(url, {
                method,
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(account),
            });
            const result = await res.json();
            if(result.success) {
                document.getElementById('account-dialog-overlay').classList.add('hidden');
                showAlert('Success', result.message);
                loadAccounts();
            } else {
                showAlert('Validation Error', result.errors?.join('\n') || 'Invalid account configuration');
            }
        } catch(err) {
            showAlert('Error', `Failed to save account: ${err.message}`);
        }
    });

    document.getElementById('btn-dialog-cancel').addEventListener('click', () => {
        document.getElementById('account-dialog-overlay').classList.add('hidden');
    });

    document.getElementById('dialog-close').addEventListener('click', () => {
        document.getElementById('account-dialog-overlay').classList.add('hidden');
    });

    function buildAccountFromForm() {
        const ips = document.getElementById('acct-allowed-ips').value.trim().split('\n').filter(l => l.trim());
        const froms = document.getElementById('acct-allowed-from').value.trim().split('\n').filter(l => l.trim());
        const secret = document.getElementById('acct-secret').value.trim();
        const thumbprint = document.getElementById('acct-cert-thumbprint').value.trim();
        const keyPath = document.getElementById('acct-cert-key-path').value.trim();

        const account = {
            name: document.getElementById('acct-name').value.trim(),
            appReg: {
                tenant: document.getElementById('acct-tenant').value.trim(),
                id: document.getElementById('acct-client-id').value.trim(),
            },
            allowedIPs: ips.length ? ips : undefined,
            allowedFrom: froms.length ? froms : undefined,
            forceMailbox: document.getElementById('acct-force-mailbox').value.trim() || undefined,
            retryLimit: parseInt(document.getElementById('acct-retry-limit').value) || 3,
            retryInterval: parseInt(document.getElementById('acct-retry-interval').value) || 5,
        };

        if(secret)
            account.appReg.secret = secret;
        if(thumbprint && keyPath)
            account.appReg.certificate = {thumbprint, privateKeyPath: keyPath};

        return account;
    }

    // ---- Config Tab ----
    async function loadConfig() {
        try {
            const res = await fetch('/api/config');
            const config = await res.json();
            renderConfigForm(config);
            setStatus('Configuration loaded');
        } catch(err) {
            setStatus('Failed to load configuration');
        }
    }

    function renderConfigForm(config) {
        const container = document.getElementById('config-form');
        container.innerHTML = '';

        // Mode
        addConfigSection(container, 'Operation Mode', [
            {key: 'mode', label: 'Mode', type: 'select', options: ['full', 'receive', 'send'], value: config.mode},
        ]);

        // SMTP (receive) settings
        if(config.receive) {
            addConfigSection(container, 'SMTP Server (Receive)', [
                {key: 'receive.port', label: 'Port', type: 'number', value: config.receive.port || 25},
                {key: 'receive.listenAddress', label: 'Listen Address', type: 'text', value: config.receive.listenAddress || ''},
                {key: 'receive.secure', label: 'Require TLS', type: 'checkbox', value: config.receive.secure || false},
                {key: 'receive.maxSize', label: 'Max Message Size', type: 'text', value: config.receive.maxSize || '100m'},
                {key: 'receive.banner', label: 'SMTP Banner', type: 'text', value: config.receive.banner || ''},
                {key: 'receive.requireAuth', label: 'Require Auth', type: 'checkbox', value: config.receive.requireAuth || false},
            ]);
        }

        // HTTP Proxy
        if(config.httpProxy) {
            addConfigSection(container, 'HTTP Proxy', [
                {key: 'httpProxy.host', label: 'Host', type: 'text', value: config.httpProxy.host || ''},
                {key: 'httpProxy.port', label: 'Port', type: 'number', value: config.httpProxy.port || ''},
                {key: 'httpProxy.protocol', label: 'Protocol', type: 'select', options: ['http', 'https'], value: config.httpProxy.protocol || 'http'},
            ]);
        }

        // WebUI settings
        if(config.webui) {
            addConfigSection(container, 'WebUI', [
                {key: 'webui.enabled', label: 'Enabled', type: 'checkbox', value: config.webui.enabled || false},
                {key: 'webui.port', label: 'Port', type: 'number', value: config.webui.port || 3000},
                {key: 'webui.listenAddress', label: 'Listen Address', type: 'text', value: config.webui.listenAddress || '0.0.0.0'},
            ]);
        }
    }

    function addConfigSection(container, title, fields) {
        const section = document.createElement('div');
        section.className = 'group-box config-section';
        let html = `<legend>${escapeHtml(title)}</legend>`;

        fields.forEach(f => {
            html += '<div class="form-group">';
            html += `<label>${escapeHtml(f.label)}:</label>`;

            if(f.type === 'select') {
                html += `<select class="field" data-key="${f.key}">`;
                f.options.forEach(opt => {
                    html += `<option value="${opt}" ${opt === f.value ? 'selected' : ''}>${opt}</option>`;
                });
                html += '</select>';
            } else if(f.type === 'checkbox') {
                html += `<input type="checkbox" data-key="${f.key}" ${f.value ? 'checked' : ''}>`;
            } else {
                html += `<input type="${f.type}" class="field" data-key="${f.key}" value="${escapeHtml(String(f.value || ''))}">`;
            }

            html += '</div>';
        });

        section.innerHTML = html;
        container.appendChild(section);
    }

    document.getElementById('btn-save-config').addEventListener('click', async () => {
        try {
            // Read current config with secrets, then apply form changes
            const res = await fetch('/api/config?showSecrets=true');
            const config = await res.json();

            // Apply form values
            document.querySelectorAll('#config-form [data-key]').forEach(el => {
                const keys = el.dataset.key.split('.');
                let obj = config;
                for(let i = 0; i < keys.length - 1; i++) {
                    if(!obj[keys[i]]) obj[keys[i]] = {};
                    obj = obj[keys[i]];
                }
                const lastKey = keys[keys.length - 1];
                if(el.type === 'checkbox')
                    obj[lastKey] = el.checked;
                else if(el.type === 'number')
                    obj[lastKey] = el.value ? parseInt(el.value) : undefined;
                else
                    obj[lastKey] = el.value || undefined;
            });

            const saveRes = await fetch('/api/config', {
                method: 'PUT',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(config),
            });
            const result = await saveRes.json();

            if(result.success) {
                document.getElementById('restart-banner').classList.remove('hidden');
                setStatus('Configuration saved');
            } else {
                showAlert('Validation Error', result.errors?.join('\n') || 'Invalid configuration');
            }
        } catch(err) {
            showAlert('Error', `Failed to save config: ${err.message}`);
        }
    });

    document.getElementById('btn-reload-config').addEventListener('click', loadConfig);

    // ---- Alert Dialog ----
    function showAlert(title, message) {
        document.getElementById('alert-title').textContent = title;
        document.getElementById('alert-message').textContent = message;
        document.getElementById('alert-dialog-overlay').classList.remove('hidden');
    }

    document.getElementById('alert-ok').addEventListener('click', () => {
        document.getElementById('alert-dialog-overlay').classList.add('hidden');
    });
    document.getElementById('alert-close').addEventListener('click', () => {
        document.getElementById('alert-dialog-overlay').classList.add('hidden');
    });

    // ---- Status Bar ----
    function setStatus(text) {
        document.getElementById('statusbar-text').textContent = text;
    }

    // Clock
    function updateClock() {
        const now = new Date();
        document.getElementById('statusbar-time').textContent = now.toLocaleTimeString();
    }
    setInterval(updateClock, 1000);
    updateClock();

    // ---- Utilities ----
    function formatUptime(seconds) {
        const d = Math.floor(seconds / 86400);
        const h = Math.floor((seconds % 86400) / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        if(d > 0) return `${d}d ${h}h ${m}m`;
        if(h > 0) return `${h}h ${m}m`;
        return `${m}m`;
    }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    // ---- Init ----
    switchTab('dashboard');
})();
```

---

## 6. Build System & Docker Changes

### Webpack Changes

**File: `webpack.config.js`**

```javascript
const webpack = require('webpack');
const path = require('path');

module.exports = (env, argv) => ({
    target: 'node',
    entry: {
        server: './src/server.ts',
    },
    output: {
        path: path.resolve(__dirname, 'dist'),
        filename: '[name].js',
    },
    module: {
        rules: [
            {
                exclude: /node_modules/,
                test: /\.ts$/,
                loader: 'ts-loader'
            },
            // Embed WebUI static files as strings
            {
                test: /\.(html|css)$/,
                include: path.resolve(__dirname, 'src/webui/public'),
                type: 'asset/source',
            },
            {
                test: /\.js$/,
                include: path.resolve(__dirname, 'src/webui/public'),
                type: 'asset/source',
            },
        ],
    },
    resolve: {
        extensions: ['.ts', '.js'],
    },
    // Express and ajv must be loaded at runtime (not bundled)
    externals: {
        'express': 'commonjs express',
        'ajv': 'commonjs ajv',
    },
    plugins: [
        new webpack.DefinePlugin({
            VERSION: JSON.stringify(require("./package.json").version),
            DEBUG: (argv.mode!=='production'),
        }),
    ],
    devtool: argv.mode==='production'?undefined:'inline-source-map',
    performance: {
        hints: false,
    },
    stats: {
        builtAt: true,
        chunks: false,
        chunkModules: false,
        chunkOrigins: false,
        modules: false,
        entrypoints: false,
        warnings: false,
    },
});
```

**Key changes from original**:
1. Added `asset/source` rules for `.html`, `.css`, and `.js` files under `src/webui/public/`
2. Added `externals` for `express` and `ajv` — these packages use dynamic `require()` that webpack cannot bundle; they'll be loaded from `node_modules` at runtime

### Docker Changes

**File: `Dockerfile`**

Add these lines:

```dockerfile
# After the existing EXPOSE 587 line:
EXPOSE 3000
```

Since `express` and `ajv` are externals (not bundled), the Docker image needs `node_modules`. Add before the `WORKDIR` line:

```dockerfile
# Install runtime dependencies for WebUI
COPY package.json package-lock.json /opt/smtp2graph/
RUN cd /opt/smtp2graph && npm ci --omit=dev && rm package.json package-lock.json
ENV NODE_PATH=/opt/smtp2graph/node_modules
```

**Alternative approach**: If the project prefers to keep the Docker image minimal and self-contained, consider bundling Express differently or using a simpler HTTP server (Node.js built-in `http` module). However, Express as an external is the simpler and more maintainable approach.

---

## 7. Code Style Conventions

Follow these patterns when writing code for this project:

| Convention | Example |
|-----------|---------|
| Private fields | `#fieldName` (not `_fieldName`) |
| Config access | Static getters on `Config` class |
| Logging | `const log = prefixedLog('ComponentName');` then `log('info', 'message')` |
| Async | `async/await` throughout, no raw `.then()` chains |
| Error types | Extend `UnrecoverableError` for non-retryable errors |
| Callbacks | Arrow functions: `(param) => { ... }` |
| Braces | Opening brace on same line for functions/methods, next line for class/control flow (matching existing inconsistent style — follow the surrounding code's style) |
| Naming | camelCase for variables/methods, PascalCase for classes/interfaces |
| Types | TypeScript strict mode, explicit return types on public APIs |
| Concurrency | `Mutex` for single-access, `Semaphore` for bounded parallel access |
| File ops | Synchronous (`fs.readFileSync`, `fs.existsSync`) for config/simple operations; async streams for large data |

---

## 8. Verification & Testing

### Manual Verification Checklist

1. **Backward Compatibility**
   - Use an existing `config.yml` with single `send.appReg` format
   - Build and start: `npm run build && node dist/server.js`
   - Verify SMTP server starts normally with no errors
   - Verify no WebUI starts (no `webui` config present)

2. **Multi-Account Routing**
   - Create a config with two accounts having different `allowedIPs` and `allowedFrom`
   - Send test email from IP matching account 1 with account 1's FROM address → should succeed
   - Send test email from IP matching account 2 with account 1's FROM address → should reject
   - Check logs show correct account name in messages

3. **WebUI Authentication**
   - Add `webui` config with `enabled: true`, username, password
   - Browse to `http://localhost:3000`
   - Should be prompted for Basic Auth
   - Wrong credentials → 401
   - Correct credentials → dashboard loads

4. **Dashboard**
   - Shows SMTP server status (green/running)
   - Shows per-account health cards with Graph API connectivity status
   - Shows queue counts (queued, retrying, failed, temp)
   - Shows recent log entries in console-style viewer
   - Auto-refreshes every 10 seconds

5. **Accounts Management**
   - "Network Accounts" tab lists all configured accounts
   - "Add Account" opens dialog, fill in details, save → "restart required"
   - "Edit" → pre-fills form with current values
   - "Test" → shows connectivity result dialog
   - "Del" → removes account from config (with confirm)

6. **Configuration Editor**
   - "System Properties" tab shows current SMTP, proxy, WebUI settings
   - Edit a value, click Save → config.yml updated on disk
   - "Restart required" banner appears
   - Invalid values → validation error dialog

7. **Queue Sidecar Files**
   - Send an email through multi-account relay
   - Check `mailroot/queue/` — should have `.eml` and `.meta.json` files
   - `.meta.json` contains `{ accountName, clientIp, fromAddress, timestamp }`
   - After successful send, both files are cleaned up
   - After max retries, both files moved to `mailroot/failed/`

8. **Docker Build**
   - `docker build -t smtp2graph .`
   - `docker run -p 587:587 -p 3000:3000 -v ./data:/data smtp2graph`
   - Verify both SMTP and WebUI are accessible

### Build Commands

```bash
# Install dependencies
npm install

# Development build (with source maps)
npm run dev

# Production build
npm run build

# Run
node dist/server.js

# Run with custom config
node dist/server.js --config=myconfig.yml

# Run tests
npm test
```

---

## Appendix: File Change Summary

### Files to Create

| File | Purpose |
|------|---------|
| `src/webui/WebServer.ts` | Express app, Basic Auth, static serving, route mounting |
| `src/webui/routes/configRoutes.ts` | Config API endpoints |
| `src/webui/routes/healthRoutes.ts` | Health/queue/logs API endpoints |
| `src/webui/routes/accountRoutes.ts` | Account CRUD API endpoints |
| `src/webui/services/ConfigService.ts` | Config read/write/validate logic |
| `src/webui/services/HealthService.ts` | Health metric aggregation |
| `src/webui/public/index.html` | SPA shell with retro OS theme |
| `src/webui/public/app.js` | Frontend JavaScript |
| `src/webui/public/style.css` | Retro CSS theme |

### Files to Modify

| File | Changes |
|------|---------|
| `src/classes/Config.ts` | Add IAccount, accounts getter, findAccountForSender(), webui getters, validation |
| `src/classes/Mailer.ts` | Per-account MSAL client map, sendEml(file, account), testConnection() |
| `src/classes/MailQueue.ts` | Sidecar .meta.json handling, account-aware send, queueStats getter |
| `src/classes/SMTPServer.ts` | Account matching in onConnect/onMailFrom, sidecar writing, isListening getter |
| `src/server.ts` | Conditional WebUI startup after SMTP server |
| `config.schema.json` | accounts array schema, webui schema |
| `config.example.yml` | Multi-account example, webui example |
| `webpack.config.js` | asset/source rules, express/ajv externals |
| `Dockerfile` | Expose 3000, install runtime deps for externals |
| `package.json` | Add express, ajv, @types/express |
