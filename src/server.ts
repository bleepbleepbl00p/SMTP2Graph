import { Config } from './classes/Config';
import { log } from './classes/Logger';
import { MailQueue } from './classes/MailQueue';
import { SMTPServer } from './classes/SMTPServer';

if(process.argv.includes('-v') || process.argv.includes('--version')) // We're asked for our version?
    console.log(`SMTP2Graph v${VERSION}`);
else
{
    (async ()=>{
        // Validate the config before continuing
        try {
            Config.validate();
        } catch(error) {
            await log('error', `Invalid config. ${String(error)}`, {error});
            process.exit(1);
        }

        if(Config.setupMode)
        {
            log('info', 'Setup Mode — no send configuration found.');
            log('info', `Complete setup via WebUI at http://${Config.webuiListenAddress}:${Config.webuiPort}`);

            try {
                const { WebServer } = await import('./webui/WebServer');
                const webServer = new WebServer(null, null);
                await webServer.listen();
            } catch(error) {
                log('error', `Failed to start WebUI. ${String(error)}`, {error});
                process.exit(1);
            }

            log('info', 'Waiting for configuration to be completed via WebUI...');
        }
        else
        {
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
        }
    })();
}

// Exit with code 0 on Ctrl+C
process.on('SIGINT', ()=>{
    process.exit(0);
});

// Exit with code 0 when container is stopped
process.on('SIGTERM', ()=>{
    process.exit(0);
});
