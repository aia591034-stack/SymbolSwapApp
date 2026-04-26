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

// グローバルスコープで SDK 関連を保持
let SymbolFacade, PrivateKey, PublicKey, Signature, KeyPair, utils, facade;

async function initSDK() {
    if (facade) return;
    const mod = await import('symbol-sdk');
    const SDK = mod.SymbolFacade ? mod : (mod.default || mod);
    SymbolFacade = SDK.SymbolFacade;
    PrivateKey = SDK.PrivateKey;
    PublicKey = SDK.PublicKey;
    Signature = SDK.Signature;
    KeyPair = SDK.KeyPair;
    utils = SDK.utils;
    facade = new SymbolFacade('testnet');
}

// SDK 初期化用ミドルウェア
app.use(async (req, res, next) => {
    try { await initSDK(); next(); } catch (e) { res.status(500).json({ error: "SDK Init Error" }); }
});

const kv = createClient({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

app.use(cors());
app.use(express.json());

const CURRENCY_ID = '72C0212E67A08BCE'; 
const NODE_URL = process.env.NODE_URL || 'https://sym-test-01.opening-line.jp:3001';
const OPERATOR_KEY = process.env.OPERATOR_PRIVATE_KEY || '55145D9FA93FEE1FB9E11A10CDF39F44BC';

const uploadDir = process.env.VERCEL ? '/tmp' : path.join(__dirname, 'uploads');
if (!process.env.VERCEL && !fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

async function getProducts() { try { return (await kv.get("products")) || []; } catch (e) { return []; } }
async function saveProducts(products) { try { await kv.set("products", products); } catch (e) { } }

// API Routes
app.get('/api/config', (req, res) => {
    const opPrivKey = new PrivateKey(utils.hexToUint8(OPERATOR_KEY));
    const opPubKey = facade.createPublicKeysFromPrivateKeys(opPrivKey);
    res.json({ operatorPublicKey: opPubKey.toString(), currencyId: CURRENCY_ID, status: "ready" });
});

app.get('/api/products', async (req, res) => {
    const products = await getProducts();
    res.json(products.map(({ secret, ...p }) => p));
});

app.post('/api/build_transaction', async (req, res) => {
    try {
        const { productId, buyerPublicKey } = req.body;
        const products = await getProducts();
        const p = products.find(prod => String(prod.id) === String(productId));
        const opPrivKey = new PrivateKey(utils.hexToUint8(OPERATOR_KEY));
        const opKeyPair = new KeyPair(opPrivKey);
        
        const tx1 = facade.transactionFactory.createEmbedded({
            type: 'transfer_transaction_v1',
            signerPublicKey: new PublicKey(utils.hexToUint8(buyerPublicKey)),
            recipientAddress: facade.network.publicKeyToAddress(new PublicKey(utils.hexToUint8(p.sellerPublicKey))),
            mosaics: [{ mosaicId: BigInt('0x' + CURRENCY_ID), amount: BigInt(p.price * 1000000) }],
            message: new TextEncoder().encode('Nexus Swap: ' + p.title)
        });
        
        const tx2 = facade.transactionFactory.createEmbedded({
            type: 'transfer_transaction_v1',
            signerPublicKey: opKeyPair.publicKey,
            recipientAddress: facade.network.publicKeyToAddress(new PublicKey(utils.hexToUint8(buyerPublicKey))),
            message: new TextEncoder().encode(p.secret)
        });

        const aggregateTx = facade.transactionFactory.create({
            type: 'aggregate_bonded_transaction_v2',
            signerPublicKey: opKeyPair.publicKey,
            deadline: BigInt(Date.now() - 1667250467000 + 7200000),
            transactionsHash: facade.constructor.hashEmbeddedTransactions([tx1, tx2]),
            transactions: [tx1, tx2]
        });
        
        facade.constructor.attachMaxFee(aggregateTx, 100);
        aggregateTx.signature = facade.sign(aggregateTx, opPrivKey);

        res.json({ 
            success: true, 
            payload: utils.uint8ToHex(aggregateTx.serialize()), 
            hash: facade.hashTransaction(aggregateTx).toString() 
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/announce_transaction', async (req, res) => {
    try {
        const { payload, cosignatures } = req.body;
        const txBytes = utils.hexToUint8(payload);
        let finalBytes = new Uint8Array(txBytes.length + (cosignatures.length * 104));
        finalBytes.set(txBytes);
        let offset = txBytes.length;
        for (const cosig of cosignatures) {
            const view = new DataView(finalBytes.buffer, finalBytes.byteOffset + offset, 8);
            view.setBigUint64(0, 0n, true); offset += 8;
            finalBytes.set(utils.hexToUint8(cosig.signerPublicKey), offset); offset += 32;
            finalBytes.set(utils.hexToUint8(cosig.signature), offset); offset += 64;
        }
        const response = await fetch(`${NODE_URL}/transactions`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ payload: utils.uint8ToHex(finalBytes) })
        });
        if (!response.ok) throw new Error(await response.text());
        res.json({ success: true, hash: facade.hashTransaction(facade.transactionFactory.createFromPayload(txBytes)).toString() });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

if (process.env.NODE_ENV !== 'production') {
    app.listen(port, () => console.log(`Server running at http://localhost:${port}`));
}
export default app;
