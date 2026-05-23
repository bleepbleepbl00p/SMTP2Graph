import fs from 'fs';
import path from 'path';
import chokidar from 'chokidar';
import { Mutex } from 'async-mutex';
import { Mailer } from './Mailer';
import { prefixedLog } from './Logger';
import { Config, IAccount } from './Config';
import { UnrecoverableError } from './Constants';

const log = prefixedLog('MailQueue');

export class MailQueue
{
    /** While true, no files from the queue folder will be processed */
    #paused = false;
    #rootPath: string;
    #tempPath: string;
    #queuePath: string;
    #failedPath: string;
    #watcher: chokidar.FSWatcher|undefined;
    /** Remember mails to retry. Key = filename */
    #retryQueue = new Map<string, {retryAfter: Date, retryCount: number}>();
    #retryQueueInterval: NodeJS.Timeout|undefined;
    /** Prevent multiple retries from running simultaneous */
    #retryMutex = new Mutex();

    /**
     * Create a mail queue
     * @param rootPath Path where the queue, temp and failed folders are located/created
     */
    constructor(rootPath: string = 'mailroot')
    {
        this.#paused = Config.mode === 'receive';
        this.#rootPath = rootPath;
        this.#tempPath = path.join(rootPath, 'temp');
        this.#queuePath = path.join(rootPath, 'queue');
        this.#failedPath = path.join(rootPath, 'failed');
        this.#ensureFolderStructure();
        this.#startWatcher();
    }

    get tempPath(): string
    {
        return this.#tempPath;
    }

    get queuePath(): string
    {
        return this.#queuePath;
    }

    get failedPath(): string
    {
        return this.#failedPath;
    }

    get isPaused(): boolean
    {
        return this.#paused;
    }

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

    #startWatcher()
    {
        if(this.#paused) return; // Don't start the watcher when it's paused

        this.#watcher = chokidar.watch(path.join(this.#queuePath, '*.eml'));
        this.#watcher.on('error', (error)=>{
            log('error', `An error occured watching the queue folder`, {error});
        });
        this.#watcher.on('add', this.#onFileAdded.bind(this));
    }

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
            log('warn', `No relay account available for "${filename}"`);
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

    #moveToFailed(filename: string)
    {
        try {
            this.#retryQueue.delete(filename);
            fs.renameSync(path.join(this.#queuePath, filename), path.join(this.#failedPath, filename));
            const metaFile = filename.replace(/\.eml$/, '.meta.json');
            const metaSrc = path.join(this.#queuePath, metaFile);
            if(fs.existsSync(metaSrc))
                fs.renameSync(metaSrc, path.join(this.#failedPath, metaFile));
        } catch(error) {
            log('error', `Error moving file "${filename}" to failed dir`, {error, filename});
        }
    }

    #addToRetryQueue(filename: string)
    {
        // Get retry limit from first account (or legacy config)
        const retryLimit = Config.accounts[0]?.retryLimit ?? Config.sendRetryLimit;
        if(retryLimit) // Retrying is enabled?
        {
            const data = this.#retryQueue.get(filename);
            if(data && data.retryCount >= retryLimit) // This file is already in the queue and exceeded the retry limit?
            {
                this.#moveToFailed(filename);
            }
            else // This file should be retried
            {
                const retryInterval = Config.accounts[0]?.retryInterval ?? Config.sendRetryInterval;
                const retryAfter = new Date();
                retryAfter.setMinutes(retryAfter.getMinutes()+retryInterval);
                this.#retryQueue.set(filename, {retryAfter, retryCount: (data?.retryCount || 0)+1});
            }

            // Start/stop the queue if necessary
            this.#startStopRetryQueue();
        }
    }

    #removeFromRetryQueue(filename: string)
    {
        if(this.#retryQueue.has(filename)) // Was this file in the retry queue?
        {
            this.#retryQueue.delete(filename);
            this.#startStopRetryQueue(); // Stop the queue if it's empty
        }
    }

    /** Start the retry queue if it's not already started and it's not empty */
    #startStopRetryQueue()
    {
        if(!this.#retryQueueInterval && this.#retryQueue.size > 0) // The queue is not started, but there are items waiting?
            this.#retryQueueInterval = setInterval(this.#retry.bind(this), 30000); // Fire retry every 30 seconds
        else if(this.#retryQueueInterval && this.#retryQueue.size === 0) // The queue is started, but it's empty?
        {
            clearInterval(this.#retryQueueInterval);
            this.#retryQueueInterval = undefined;
        }
    }

    async #retry()
    {
        if(this.#retryQueue.size === 0) return;
        if(this.#retryMutex.isLocked()) return; // Skip if it's already retrying

        await this.#retryMutex.runExclusive(async ()=>{
            for(const [filename,data] of this.#retryQueue)
            {
                if(data.retryAfter.getTime() < Date.now()) // This item should be retried?
                    await this.#onFileAdded(path.join(this.#queuePath, filename));
            }
        });
    }

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
                // On Windows the file may still be locked for a brief moment after
                // the stream closes.  Instead of failing permanently we retry a few
                // times with a small backoff.
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

    remove(filePath: string)
    {
        try {
            fs.unlinkSync(filePath);
        } catch(error) {
            log('error', `Error while deleting "${filePath}" from queue`, {error});
        }
    }

    /** List files in a queue folder with metadata */
    listFiles(folder: 'queue'|'failed'|'temp'): {name: string, size: number, modified: string, account?: string}[]
    {
        const dir = folder === 'queue' ? this.#queuePath
            : folder === 'failed' ? this.#failedPath
            : this.#tempPath;

        try {
            return fs.readdirSync(dir)
                .filter(f => f.endsWith('.eml'))
                .map(name => {
                    const filePath = path.join(dir, name);
                    const stat = fs.statSync(filePath);
                    let account: string | undefined;

                    // Read sidecar for account info
                    const metaPath = filePath.replace(/\.eml$/, '.meta.json');
                    try {
                        if(fs.existsSync(metaPath))
                        {
                            const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
                            account = meta.accountName;
                        }
                    } catch {}

                    const retry = this.#retryQueue.get(name);
                    return {
                        name,
                        size: stat.size,
                        modified: stat.mtime.toISOString(),
                        account,
                        ...(retry ? {retryCount: retry.retryCount, retryAfter: retry.retryAfter.toISOString()} : {}),
                    };
                })
                .sort((a, b) => b.modified.localeCompare(a.modified));
        } catch { return []; }
    }

    /** Delete a specific file from queue, failed, or temp */
    deleteFile(folder: 'queue'|'failed'|'temp', filename: string): boolean
    {
        // Sanitize filename — prevent path traversal
        const safe = path.basename(filename);
        if(!safe.endsWith('.eml')) return false;

        const dir = folder === 'queue' ? this.#queuePath
            : folder === 'failed' ? this.#failedPath
            : this.#tempPath;

        const filePath = path.join(dir, safe);
        try {
            if(!fs.existsSync(filePath)) return false;
            fs.unlinkSync(filePath);
            this.#removeFromRetryQueue(safe);

            // Also clean up sidecar
            const metaPath = filePath.replace(/\.eml$/, '.meta.json');
            try { if(fs.existsSync(metaPath)) fs.unlinkSync(metaPath); } catch {}

            log('info', `Deleted "${safe}" from ${folder}`);
            return true;
        } catch(error) {
            log('error', `Failed to delete "${safe}" from ${folder}`, {error});
            return false;
        }
    }

    /** Retry a failed message by moving it back to the queue */
    retryFile(filename: string): boolean
    {
        const safe = path.basename(filename);
        if(!safe.endsWith('.eml')) return false;

        const src = path.join(this.#failedPath, safe);
        const dest = path.join(this.#queuePath, safe);
        try {
            if(!fs.existsSync(src)) return false;
            fs.renameSync(src, dest);

            // Also move sidecar if it exists
            const metaSrc = src.replace(/\.eml$/, '.meta.json');
            const metaDest = dest.replace(/\.eml$/, '.meta.json');
            try { if(fs.existsSync(metaSrc)) fs.renameSync(metaSrc, metaDest); } catch {}

            log('info', `Moved "${safe}" from failed back to queue for retry`);
            return true;
        } catch(error) {
            log('error', `Failed to retry "${safe}"`, {error});
            return false;
        }
    }

    /** Clear all files from a folder */
    clearFolder(folder: 'queue'|'failed'|'temp'): number
    {
        const dir = folder === 'queue' ? this.#queuePath
            : folder === 'failed' ? this.#failedPath
            : this.#tempPath;

        let count = 0;
        try {
            for(const file of fs.readdirSync(dir))
            {
                try {
                    fs.unlinkSync(path.join(dir, file));
                    if(file.endsWith('.eml'))
                    {
                        this.#removeFromRetryQueue(file);
                        count++;
                    }
                } catch {}
            }
            log('info', `Cleared ${count} message(s) from ${folder}`);
        } catch(error) {
            log('error', `Failed to clear ${folder}`, {error});
        }
        return count;
    }

    #ensureFolderStructure()
    {
        if(!this.#pathExists(this.#rootPath)?.isDirectory())
            fs.mkdirSync(this.#rootPath);

        if(!this.#pathExists(this.#tempPath)?.isDirectory())
            fs.mkdirSync(this.#tempPath);

        if(!this.#pathExists(this.#queuePath)?.isDirectory())
            fs.mkdirSync(this.#queuePath);

        if(!this.#pathExists(this.#failedPath)?.isDirectory())
            fs.mkdirSync(this.#failedPath);
    }

    #pathExists(path: string)
    {
        try {
            return fs.statSync(path);
        } catch(error: any) {
            if(!('code' in error) || error.code !== 'ENOENT')
                throw error;
        }
    }
}
