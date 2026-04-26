import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { createClient } from '@vercel/kv';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const port = process.env.PORT || 3000;

// Symbol SDKをAPIリクエスト内で安全にロードするためのキャッシュ用
let sdkCache = null;
async function getSDK() {
    if (sdkCache) return sdkCache;
    try {
        const mod = await import('symbol-sdk');
        const SDK = mod.SymbolFacade ? mod : (mod.default || mod);
        sdkCache = {
            SymbolFacade: SDK.SymbolFacade,
            PrivateKey: SDK.PrivateKey,
            PublicKey: SDK.PublicKey,
            Signature: SDK.Signature,
            KeyPair: SDK.KeyPair,
            utils: SDK.utils,
            facade: new SDK.SymbolFacade('testnet')
        };
        return sdkCache;
    } catch (e) {
        console.error("SDK Load Fail:", e);
        throw e;
    }
}

const kv = createClient({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

app.use(cors());
app.use(express.json());

// APIルート
app.get('/api/config', async (req, res) => {
    try {
        const { facade, PrivateKey, utils } = await getSDK();
        const opPrivKey = new PrivateKey(utils.hexToUint8(process.env.OPERATOR_PRIVATE_KEY || '55145D9FA93FEE1FB9E11A10CDF39F44BC'));
        const opPubKey = facade.createPublicKeysFromPrivateKeys(opPrivKey);
        res.json({ operatorPublicKey: opPubKey.toString(), currencyId: '72C0212E67A08BCE', status: "ready" });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/products', async (req, res) => {
    try {
        const products = await kv.get("products") || [];
        console.log("Products found:", products.length);
        res.json(products.map(({ secret, ...p }) => p));
    } catch (e) { 
        console.error("Products error:", e);
        res.status(500).json({ error: e.message }); 
    }
});

// 静的ファイルの提供
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

if (process.env.NODE_ENV !== 'production') {
    app.listen(port, () => console.log(`Server running at http://localhost:${port}`));
}
export default app;
