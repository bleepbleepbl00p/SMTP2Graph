import { Router } from 'express';
import { Config } from '../../classes/Config';
import { Mailer } from '../../classes/Mailer';
import { ConfigService } from '../services/ConfigService';
import { prefixedLog } from '../../classes/Logger';

const log = prefixedLog('WebUI');

export function accountRoutes(): Router
{
    const router = Router();
    const configService = new ConfigService();

    // List all accounts (secrets never exposed)
    router.get('/accounts', (req, res) => {
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
        }));
        res.json(accounts);
    });

    // Test connectivity for a specific account
    router.get('/accounts/:name/test', async (req, res) => {
        const account = Config.accounts.find(a => a.name === req.params.name);
        if(!account)
        {
            res.status(404).json({error: 'Account not found'});
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
            {
                log('info', `Account "${req.body.name}" created by ${req.ip}`);
                res.json({success: true, message: 'Account added. Restart required.'});
            }
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
                res.status(404).json({error: 'Account not found'});
                return;
            }
            // Preserve existing secret if masked placeholder sent
            if(req.body.appReg?.secret === '********' && config.accounts[idx]?.appReg?.secret)
                req.body.appReg.secret = config.accounts[idx].appReg.secret;
            config.accounts[idx] = req.body;
            const result = configService.updateConfig(config);
            if(result.success)
            {
                log('info', `Account "${req.params.name}" updated by ${req.ip}`);
                res.json({success: true, message: 'Account updated. Restart required.'});
            }
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
                res.status(404).json({error: 'Account not found'});
                return;
            }
            config.accounts.splice(idx, 1);
            const result = configService.updateConfig(config);
            if(result.success)
            {
                log('warn', `Account "${req.params.name}" deleted by ${req.ip}`);
                res.json({success: true, message: 'Account removed. Restart required.'});
            }
            else
                res.status(400).json({success: false, errors: result.errors});
        } catch(error) {
            res.status(500).json({error: 'Failed to delete account'});
        }
    });

    return router;
}
