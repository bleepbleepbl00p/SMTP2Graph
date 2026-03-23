import express, { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
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
        // API routes
        this.#app.use('/api', configRoutes());
        this.#app.use('/api', healthRoutes(this.#queue, this.#smtpServer));
        this.#app.use('/api', accountRoutes());

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
