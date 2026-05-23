import { Router } from 'express';
import { MailQueue } from '../../classes/MailQueue';
import { prefixedLog } from '../../classes/Logger';

const log = prefixedLog('WebUI');

export function queueRoutes(queue: MailQueue): Router
{
    const router = Router();

    // List files in a folder
    router.get('/queue/:folder', (req, res) => {
        const folder = req.params.folder as 'queue'|'failed'|'temp';
        if(!['queue', 'failed', 'temp'].includes(folder))
        {
            res.status(400).json({error: 'Invalid folder. Use: queue, failed, or temp'});
            return;
        }

        res.json(queue.listFiles(folder));
    });

    // Delete a specific file
    router.delete('/queue/:folder/:filename', (req, res) => {
        const folder = req.params.folder as 'queue'|'failed'|'temp';
        if(!['queue', 'failed', 'temp'].includes(folder))
        {
            res.status(400).json({error: 'Invalid folder'});
            return;
        }

        const success = queue.deleteFile(folder, req.params.filename);
        if(success)
        {
            log('info', `File "${req.params.filename}" deleted from ${folder} by ${req.ip}`);
            res.json({success: true});
        }
        else
            res.status(404).json({error: 'File not found or could not be deleted'});
    });

    // Retry a failed message
    router.post('/queue/failed/:filename/retry', (req, res) => {
        const success = queue.retryFile(req.params.filename);
        if(success)
        {
            log('info', `File "${req.params.filename}" queued for retry by ${req.ip}`);
            res.json({success: true, message: 'Moved to queue for retry'});
        }
        else
            res.status(404).json({error: 'File not found or could not be retried'});
    });

    // Clear all files in a folder
    router.delete('/queue/:folder', (req, res) => {
        const folder = req.params.folder as 'queue'|'failed'|'temp';
        if(!['queue', 'failed', 'temp'].includes(folder))
        {
            res.status(400).json({error: 'Invalid folder'});
            return;
        }

        const count = queue.clearFolder(folder);
        log('warn', `Cleared ${count} message(s) from ${folder} by ${req.ip}`);
        res.json({success: true, cleared: count});
    });

    return router;
}
