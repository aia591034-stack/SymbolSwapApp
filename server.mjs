import express from 'express';
import cors from 'cors';
import fs from 'fs';
import { createClient } from '@vercel/kv';
import path from 'path';
import { fileURLToPath } from 'url';
import multer from 'multer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Vercel KV REST API
const kvRestApiUrl = process.env.KV_REST_API_URL;
const kvRestApiToken = process.env.KV_REST_API_TOKEN;
const kv = createClient({ url: kvRestApiUrl, token: kvRestApiToken });

console.log('--- NEXUS NODE SERVER STARTING (v1.1.7) ---');

const app = express();
app.use(cors());
app.use(express.json());

// Request Logger
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
});

// ESM Imports for Symbol SDK
import * as symbol_pkg_main from 'symbol-sdk';
import * as symbol_pkg_core from 'symbol-sdk/symbol';
const { SymbolFacade, KeyPair, models } = symbol_pkg_core;
const { PrivateKey, PublicKey, Signature, utils } = symbol_pkg_main;

// Settings
const CURRENCY_ID = '51138C86FBF19505'; 
const PIONEER_MOSAIC_ID = '4E3FD79DC36A6474'; 
const NODE_URL = process.env.NODE_URL || 'https://sym-test-01.opening-line.jp:3001'; 
const uploadDir = process.env.VERCEL ? '/tmp' : path.join(__dirname, 'uploads');
const DB_FILE = path.join(__dirname, 'data.json');
const accounts = {
    A: { name: "Operator", key: process.env.OPERATOR_KEY || 'CED3DD0A92ECC31FA33C32BF46356255145D9FA93FEE1FB9E11A10CDF39F44BC' }
};

const toBigInt = (val) => {
    if (typeof val === 'bigint') return val;
    if (typeof val === 'number') return BigInt(Math.floor(val));
    const cleanHex = String(val).startsWith('0x') ? val : '0x' + val;
    return BigInt(cleanHex);
};

let facade;
try { facade = new SymbolFacade('testnet'); } catch (e) { console.error("Facade Init Failed", e); }

// Storage Helpers
async function getProducts() {
    try {
        if (process.env.VERCEL || (kvRestApiUrl && kvRestApiToken)) {
            return await kv.get("products") || [];
        }
        if (fs.existsSync(DB_FILE)) return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')).products || [];
        return [];
    } catch (e) { return []; }
}

async function saveProducts(products) {
    try {
        if (process.env.VERCEL || (kvRestApiUrl && kvRestApiToken)) await kv.set("products", products);
        else fs.writeFileSync(DB_FILE, JSON.stringify({ products }, null, 2));
    } catch (e) { console.error("Save Failed", e); }
}

// --- API ROUTES (Priority) ---

app.get('/api/config', (req, res) => {
    try {
        const opPriv = new PrivateKey(utils.hexToUint8(accounts.A.key));
        const opKP = new KeyPair(opPriv);
        res.json({
            operatorPublicKey: opKP.publicKey.toString(),
            currencyId: CURRENCY_ID,
            networkType: 'testnet',
            generationHash: '49D6E1CE276A85B70EAFE52349AACCA389302E7A9754BCF1221E79494FC665A4'
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/products', async (req, res) => {
    try {
        const products = await getProducts();
        res.json(products.map(({ secret, ...p }) => p));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/purchase_sss', async (req, res) => {
    try {
        const { signedPayload } = req.body;
        if (!signedPayload) return res.status(400).json({ error: "Missing payload" });
        const response = await fetch(`${NODE_URL}/transactions`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ payload: signedPayload })
        });
        if (response.ok) res.json({ success: true });
        else res.status(response.status).json({ error: "Node error" });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/claim_bonus', async (req, res) => {
    try {
        const { address } = req.body;
        if (!address) return res.status(400).json({ error: "Missing address" });
        const bonusKey = `bonus_claimed_${address}`;
        if (await kv.get(bonusKey)) return res.status(400).json({ error: "Already claimed" });

        const countKey = 'pioneer_claim_count';
        const currentCount = (await kv.get(countKey)) || 0;
        const isEligible = currentCount < 30;

        const opPriv = new PrivateKey(utils.hexToUint8(accounts.A.key));
        const opKP = new KeyPair(opPriv);
        const deadline = BigInt(Date.now() - 1667250467 * 1000 + 7200000);

        const mosaics = [
            { mosaicId: toBigInt(CURRENCY_ID), amount: 500n * 1000000n },
            { mosaicId: toBigInt('72C0212E67A08BCE'), amount: 10n * 1000000n }
        ];
        if (isEligible) mosaics.push({ mosaicId: toBigInt(PIONEER_MOSAIC_ID), amount: 1n });

        const tx = facade.transactionFactory.create({
            type: 'transfer_transaction_v1',
            signerPublicKey: opKP.publicKey,
            fee: 200000n,
            deadline: deadline,
            recipientAddress: address,
            mosaics: mosaics,
            message: new Uint8Array([0, ...Buffer.from('Welcome to Nexus!')])
        });
        const sig = facade.signTransaction(opKP, tx);
        tx.signature = new models.Signature(sig.bytes);

        const resp = await fetch(`${NODE_URL}/transactions`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ payload: utils.uint8ToHex(tx.serialize()) })
        });

        if (resp.ok) {
            await kv.set(bonusKey, true);
            if (isEligible) await kv.set(countKey, currentCount + 1);
            res.json({ success: true, isPioneer: isEligible });
        } else res.status(500).json({ error: "Broadcast failed" });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/achievements/:address', async (req, res) => {
    try {
        const count = await kv.get(`user_sales_count_${req.params.address}`) || 0;
        const amount = await kv.get(`user_sales_amount_${req.params.address}`) || 0;
        res.json({ count, amount });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/products/:id/download', async (req, res) => {
    try {
        const products = await getProducts();
        const p = products.find(item => String(item.id) === String(req.params.id));
        if (!p) return res.status(404).json({ error: "Not found" });
        if (!req.query.address) return res.status(403).json({ error: "Unauthorized" });

        const url = p.secret.replace('URL: ', '');
        if (url.startsWith('http')) return res.redirect(url);
        
        const fileName = url.split('/').pop();
        const filePath = path.join(uploadDir, fileName);
        if (fs.existsSync(filePath)) return res.download(filePath, p.fileName || fileName);
        res.status(404).json({ error: "File gone (Vercel limit)" });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/products/:id/secret', async (req, res) => {
    try {
        const products = await getProducts();
        const p = products.find(item => String(item.id) === String(req.params.id));
        if (!p) return res.status(404).json({ error: "Not found" });
        
        const opPriv = new PrivateKey(utils.hexToUint8(accounts.A.key));
        const opKP = new KeyPair(opPriv);
        const opAddr = facade.network.publicKeyToAddress(opKP.publicKey).toString();

        if (req.query.address === p.sellerAddress || req.query.address === opAddr) {
            return res.json({ secret: p.secret });
        }
        res.json({ secret: "Locked until purchase" });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

const upload = multer({ storage: multer.diskStorage({
    destination: (req, file, cb) => {
        if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
})});

app.post('/api/products', upload.fields([{ name: 'file', maxCount: 1 }, { name: 'image', maxCount: 1 }]), async (req, res) => {
    try {
        const { title, price, sellerAddress, sellerPublicKey, description } = req.body;
        const file = req.files['file']?.[0];
        if (!file) return res.status(400).json({ error: "No file" });

        // Pinata Upload (Optional but recommended)
        let secretUrl = `${req.protocol}://${req.get('host')}/uploads/${file.filename}`;
        const PINATA_API_KEY = process.env.PINATA_API_KEY;
        const PINATA_SECRET = process.env.PINATA_SECRET_API_KEY;
        
        if (PINATA_API_KEY && PINATA_SECRET) {
            try {
                const formData = new FormData();
                formData.append('file', new Blob([fs.readFileSync(file.path)]), file.originalname);
                const resp = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
                    method: 'POST',
                    headers: { 'pinata_api_key': PINATA_API_KEY, 'pinata_secret_api_key': PINATA_SECRET },
                    body: formData
                });
                if (resp.ok) {
                    const data = await resp.json();
                    secretUrl = `https://gateway.pinata.cloud/ipfs/${data.IpfsHash}`;
                }
            } catch (pinErr) { console.error("Pinata Failed", pinErr); }
        }

        const products = await getProducts();
        const newProduct = {
            id: Date.now(),
            title,
            price: parseInt(price),
            sellerAddress,
            sellerPublicKey,
            description,
            imageUrl: req.body.imageUrl || "https://images.unsplash.com/photo-1614850523296-d8c1af93d400?w=800",
            fileName: file.originalname,
            secret: `URL: ${secretUrl}`
        };
        products.push(newProduct);
        await saveProducts(products);
        res.json({ success: true, product: newProduct });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/products/:id', async (req, res) => {
    try {
        const products = await getProducts();
        const idx = products.findIndex(p => String(p.id) === String(req.params.id));
        if (idx === -1) return res.status(404).json({ error: "Not found" });
        
        const opPriv = new PrivateKey(utils.hexToUint8(accounts.A.key));
        const opKP = new KeyPair(opPriv);
        const opAddr = facade.network.publicKeyToAddress(opKP.publicKey).toString();

        if (req.body.requesterAddress === products[idx].sellerAddress || req.body.requesterAddress === opAddr) {
            products.splice(idx, 1);
            await saveProducts(products);
            return res.json({ success: true });
        }
        res.status(403).json({ error: "Forbidden" });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- STATIC FILES & FALLBACK ---
app.use('/uploads', express.static(uploadDir));
app.use(express.static(path.join(__dirname, 'public')));

// Catch-all to log unmatched requests
app.use((req, res) => {
    console.warn(`[404] No route matched for ${req.method} ${req.url}`);
    res.status(404).json({ error: "Route not found" });
});

const port = process.env.PORT || 3000;
if (!process.env.VERCEL) {
    app.listen(port, () => console.log(`Server running at http://localhost:${port}`));
}

export default app;
