import fs from 'fs';
import { randomBytes } from 'crypto';
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

    /** Get config, always with secrets masked unless internal=true */
    getConfig(internal: boolean = false): any
    {
        const content = fs.readFileSync(this.#configFile, 'utf-8');
        const config = parseYaml(content);

        if(!internal)
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
        // Preserve secrets where masked placeholder was submitted
        try {
            const current = this.getConfig(true);
            this.#preserveMaskedSecrets(newConfig, current);
        } catch {
            // If we can't read current config (e.g. first save), proceed
        }

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

        // Atomic write: write to tmp file then rename
        const tmpPath = this.#configFile + '.tmp.' + randomBytes(4).toString('hex');
        try {
            const yamlContent = stringifyYaml(newConfig, {indent: 2});
            fs.writeFileSync(tmpPath, yamlContent, 'utf-8');
            fs.renameSync(tmpPath, this.#configFile);
            return {success: true};
        } catch(error) {
            try { fs.unlinkSync(tmpPath); } catch {}
            return {success: false, errors: [`Failed to write config: ${String(error)}`]};
        }
    }

    #preserveMaskedSecrets(newConfig: any, current: any)
    {
        // Legacy send.appReg.secret
        if(newConfig?.send?.appReg?.secret === '********' && current?.send?.appReg?.secret)
            newConfig.send.appReg.secret = current.send.appReg.secret;

        // Per-account secrets
        if(newConfig?.accounts && current?.accounts)
        {
            for(const account of newConfig.accounts)
            {
                if(account?.appReg?.secret !== '********') continue;
                const existing = current.accounts.find((a: any) => a.name === account.name);
                if(existing?.appReg?.secret)
                    account.appReg.secret = existing.appReg.secret;
            }
        }

        // SMTP user passwords
        if(newConfig?.receive?.users && current?.receive?.users)
        {
            for(const user of newConfig.receive.users)
            {
                if(user?.password !== '********') continue;
                const existing = current.receive.users.find((u: any) => u.username === user.username);
                if(existing?.password)
                    user.password = existing.password;
            }
        }

        // WebUI password
        if(newConfig?.webui?.password === '********' && current?.webui?.password)
            newConfig.webui.password = current.webui.password;
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
