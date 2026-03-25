import { Router } from 'express';
import { MailQueue } from '../../classes/MailQueue';
import { SMTPServer } from '../../classes/SMTPServer';
import { Mailer } from '../../classes/Mailer';
import { Config } from '../../classes/Config';
import fs from 'fs';
import path from 'path';

const sensitiveKeys = /secret|password|token|authorization|certificate|privatekey|thumbprint/i;

function scrubObject(obj: any): void
{
    if(!obj || typeof obj !== 'object') return;
    for(const key of Object.keys(obj))
    {
        if(sensitiveKeys.test(key))
            obj[key] = '[REDACTED]';
        else if(typeof obj[key] === 'object')
            scrubObject(obj[key]);
    }
}

function scrubString(line: string): string
{
    return line.replace(/(secret|password|token|authorization)['":\s]*['"]?[^\s'",$}\]]+/gi, '$1=[REDACTED]');
}

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
        const rawLines = parseInt(req.query.lines as string) || 100;
        const lines = Math.min(Math.max(rawLines, 1), 1000);
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

            // Parse JSON log entries and scrub sensitive fields
            const entries = recent.map(line => {
                try {
                    const entry = JSON.parse(line);
                    scrubObject(entry);
                    return entry;
                }
                catch { return {message: scrubString(line)}; }
            });

            res.json(entries);
        } catch(error) {
            res.status(500).json({error: 'Failed to read logs'});
        }
    });

    return router;
}
