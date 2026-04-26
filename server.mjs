import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { createClient } from '@vercel/kv';
import { fileURLToPath } from 'url';
import * as symbolSdk from 'symbol-sdk';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const port = process.env.PORT || 3000;

// Symbol SDKの安全な抽出
const SDK = symbolSdk.SymbolFacade ? symbolSdk : (symbolSdk.default || symbolSdk);
const { SymbolFacade, PrivateKey, PublicKey, Signature, KeyPair, utils } = SDK;

const facade = SymbolFacade ? new SymbolFacade('testnet') : null;
const kv = createClient({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });

app.use(cors());
app.use(express.json());

// 設定
const CURRENCY_ID = '72C0212E67A08BCE'; 
const NODE_URL = process.env.NODE_URL || 'https://sym-test-01.opening-line.jp:3001';
const OPERATOR_KEY = process.env.OPERATOR_PRIVATE_KEY || '55145D9FA93FEE1FB9E11A10CDF39F44BC';

// パス解決
const uploadDir = process.env.VERCEL ? '/tmp' : path.join(__dirname, 'uploads');
if (!process.env.VERCEL && !fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadDir));

// API
app.get('/api/config', (req, res) => {
    try {
        if (!facade) throw new Error("SDK not initialized");
        const opPrivKey = new PrivateKey(utils.hexToUint8(OPERATOR_KEY));
        const opPubKey = facade.createPublicKeysFromPrivateKeys(opPrivKey);
        res.json({ operatorPublicKey: opPubKey.toString(), currencyId: CURRENCY_ID, status: "ready" });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

if (process.env.NODE_ENV !== 'production') {
    app.listen(port, () => console.log(`Server running at http://localhost:${port}`));
}

export default app;
