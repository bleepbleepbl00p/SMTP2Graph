import express, { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { Config } from '../classes/Config';
import { prefixedLog } from '../classes/Logger';
import { MailQueue } from '../classes/MailQueue';
import { SMTPServer } from '../classes/SMTPServer';
import { ConfigService } from './services/ConfigService';
import { configRoutes } from './routes/configRoutes';
import { healthRoutes } from './routes/healthRoutes';
import { accountRoutes } from './routes/accountRoutes';

const log = prefixedLog('WebUI');

export class WebServer
{
    #app: express.Application;
    #queue: MailQueue | null;
    #smtpServer: SMTPServer | null;
    #setupMode: boolean;

    constructor(queue: MailQueue | null, smtpServer: SMTPServer | null)
    {
        this.#queue = queue;
        this.#smtpServer = smtpServer;
        this.#setupMode = (queue === null || smtpServer === null);
        this.#app = express();

        this.#setupMiddleware();
        this.#setupRoutes();
    }

    #setupMiddleware()
    {
        // Security headers
        this.#app.use(helmet({
            contentSecurityPolicy: {
                directives: {
                    defaultSrc: ["'self'"],
                    scriptSrc: ["'self'"],
                    styleSrc: ["'self'", "'unsafe-inline'"],
                    imgSrc: ["'self'", 'data:'],
                    connectSrc: ["'self'"],
                    frameSrc: ["'none'"],
                    objectSrc: ["'none'"],
                },
            },
            hsts: false, // Let reverse proxy handle HSTS
        }));

        // JSON body parser
        this.#app.use(express.json());

        // Rate limiting — general (before auth)
        this.#app.use(rateLimit({
            windowMs: 15 * 60 * 1000, // 15 minutes
            max: 50,
            standardHeaders: true,
            legacyHeaders: false,
            message: 'Too many requests, please try again later.',
        }));

        // Rate limiting — failed auth attempts
        this.#app.use(rateLimit({
            windowMs: 15 * 60 * 1000,
            max: 10,
            standardHeaders: true,
            legacyHeaders: false,
            skipSuccessfulRequests: true,
        }));

        // Basic Auth
        this.#app.use((req: Request, res: Response, next: NextFunction) => {
            // Setup status is public — needed before credentials are known
            if(req.path === '/api/setup-status')
                return next();

            const auth = req.headers.authorization;
            if(!auth || !auth.startsWith('Basic '))
            {
                res.setHeader('WWW-Authenticate', 'Basic realm="SMTP2Graph WebUI"');
                res.status(401).send('Authentication required');
                return;
            }

            const decoded = Buffer.from(auth.substring(6), 'base64').toString();
            const colonIdx = decoded.indexOf(':');
            const username = decoded.substring(0, colonIdx);
            const password = decoded.substring(colonIdx + 1);

            if(username === Config.webuiUsername && password === Config.webuiPassword)
            {
                next();
            }
            else
            {
                log('warn', `Failed WebUI auth attempt from ${req.ip} — user: "${username || '(empty)'}"`);
                res.setHeader('WWW-Authenticate', 'Basic realm="SMTP2Graph WebUI"');
                res.status(401).send('Invalid credentials');
            }
        });

        // CSRF protection: require custom header on state-changing requests
        this.#app.use((req: Request, res: Response, next: NextFunction) => {
            if(['GET', 'HEAD', 'OPTIONS'].includes(req.method))
                return next();
            if(req.headers['x-requested-with'] !== 'XMLHttpRequest')
                return res.status(403).json({error: 'Missing CSRF header'});
            next();
        });
    }

    #setupRoutes()
    {
        // Always mount config and account routes (needed for setup wizard)
        this.#app.use('/api', configRoutes());
        this.#app.use('/api', accountRoutes());

        // Setup status endpoint — always available
        this.#app.get('/api/setup-status', (_req, res) => {
            res.json({ setupMode: this.#setupMode });
        });

        if(this.#setupMode)
        {
            // Minimal health endpoint for setup mode
            this.#app.get('/api/health', (_req, res) => {
                res.json({
                    setupMode: true,
                    smtp: { status: 'not started', message: 'Complete setup to start SMTP relay' },
                    accounts: [],
                    queue: { queued: 0, retrying: 0, failed: 0, inProgress: 0 },
                    uptime: process.uptime(),
                    version: VERSION,
                });
            });

            // Setup complete endpoint — validates config and restarts
            this.#app.post('/api/setup/complete', async (_req, res) => {
                try {
                    const configService = new ConfigService();
                    const config = configService.getConfig(true);

                    const hasAccounts = config.accounts && Array.isArray(config.accounts) && config.accounts.length > 0;
                    const hasSendConfig = config.send?.appReg?.tenant && config.send?.appReg?.id;
                    const isReceiveOnly = config.mode === 'receive';

                    if(!hasAccounts && !hasSendConfig && !isReceiveOnly)
                    {
                        res.status(400).json({
                            error: 'Configuration incomplete',
                            missing: 'Add at least one relay account or configure send.appReg with tenant and client ID',
                        });
                        return;
                    }

                    res.json({ success: true, message: 'Configuration complete. Restarting...' });

                    setTimeout(() => {
                        log('info', 'Setup complete — restarting with full configuration...');
                        process.exit(0);
                    }, 1000);
                } catch(err) {
                    res.status(500).json({ error: 'Failed to validate configuration' });
                }
            });
        }
        else
        {
            // Full health routes — only available in normal mode
            this.#app.use('/api', healthRoutes(this.#queue!, this.#smtpServer!));
        }

        // Static files — serve embedded HTML/JS/CSS
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
        const listenAddress = Config.webuiListenAddress;
        const port = Config.webuiPort;

        if(listenAddress === '0.0.0.0' || listenAddress === '::')
        {
            log('warn', 'WebUI is listening on all interfaces WITHOUT TLS. ' +
                'Place behind a TLS-terminating reverse proxy or bind to 127.0.0.1.');
        }

        return new Promise((resolve) => {
            this.#app.listen(port, listenAddress, () => {
                log('info', `WebUI started on ${listenAddress}:${port}`);
                resolve();
            });
        });
    }
}
