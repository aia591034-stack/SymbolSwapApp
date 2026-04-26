import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { createClient } from '@vercel/kv';
import { fileURLToPath } from 'url';
import {
    PrivateKey,
    PublicKey,
    Signature,
    KeyPair,
    SymbolFacade,
    utils,
    models
} from 'symbol-sdk';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;

// Vercel KV REST API のURLとトークン
const kv = createClient({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

app.use(cors());
app.use(express.json());

const facade = new SymbolFacade('testnet');
const CURRENCY_ID = '72C0212E67A08BCE'; 
const NODE_URL = process.env.NODE_URL || 'https://sym-test-01.opening-line.jp:3001';

const accounts = {
    A: { name: 'A (Operator)', key: process.env.OPERATOR_PRIVATE_KEY || '55145D9FA93FEE1FB9E11A10CDF39F44BC', pub: '1A10CDF39F44BC...' }, // ダミー。実際は環境変数
};

// 16進数文字列を安全に BigInt に変換
const toBigInt = (val) => {
    if (typeof val === 'bigint') return val;
    if (typeof val === 'number') return BigInt(Math.floor(val));
    const cleanHex = String(val).startsWith('0x') ? val : '0x' + val;
    return BigInt(cleanHex);
};

/**
 * オンチェーンで購入履歴を確認する
 */
async function _verifyPurchaseOnce(buyerAddress, sellerAddress, amount, productTitle) {
    try {
        const cleanBuyer = (buyerAddress || '').replace(/-/g, '').toUpperCase();
        const cleanSeller = (sellerAddress || '').replace(/-/g, '').toUpperCase();
        const cleanCurrencyId = (CURRENCY_ID || '').replace(/^0X/i, '').toUpperCase();
        const targetAmount = BigInt(Math.round(Number(amount) * 1000000));

        const endpoints = [
            `${NODE_URL}/accounts/${cleanBuyer}/transactions/unconfirmed?pageSize=50`,
            `${NODE_URL}/accounts/${cleanBuyer}/transactions/confirmed?pageSize=50`
        ];

        for (const url of endpoints) {
            try {
                const res = await fetch(url);
                if (!res.ok) continue;
                const data = await res.json();
                if (!data.data) continue;

                for (const txWrapper of data.data) {
                    const tx = txWrapper.transaction;
                    if (!tx) continue;
                    
                    const isMatchingTransfer = (e) => {
                        if (!e || (e.type !== 16717 && e.type !== 'TRANSFER')) return false;
                        let recipient = (e.recipientAddress || e.recipient || '');
                        if (typeof recipient === 'object' && recipient.address) recipient = recipient.address;
                        const cleanRecipient = String(recipient).replace(/-/g, '').toUpperCase();
                        
                        const mosaics = e.mosaics || [];
                        const hasAmount = mosaics.some(m => {
                            const mId = String(m.id || '').replace(/^0X/i, '').toUpperCase();
                            return mId === cleanCurrencyId && BigInt(m.amount) === targetAmount;
                        });

                        return cleanRecipient === cleanSeller && hasAmount;
                    };

                    if (tx.type === 16705 || tx.type === 16961) {
                        const embedded = tx.transactions || [];
                        if (embedded.some(etx => isMatchingTransfer(etx.transaction))) return true;
                    }
                    if (isMatchingTransfer(tx)) return true;
                }
            } catch (e) { console.warn("Fetch error for verify:", url); }
        }
        return false;
    } catch (e) {
        console.error("[VERIFY_ONCE] Error:", e);
        return false;
    }
}

async function verifyPurchaseOnChain(buyerAddress, sellerAddress, amount, productTitle) {
    console.log(`[VERIFY] Start logic for ${buyerAddress} -> ${sellerAddress} (${amount} XYM)`);
    const maxRetries = 4;
    for (let i = 0; i < maxRetries; i++) {
        const found = await _verifyPurchaseOnce(buyerAddress, sellerAddress, amount, productTitle);
        if (found) return true;
        if (i < maxRetries - 1) await new Promise(r => setTimeout(r, 2500));
    }
    return false;
}

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

async function getProducts() {
    try {
        const data = await kv.get("products");
        return data || [];
    } catch (e) { return []; }
}

async function saveProducts(products) {
    await kv.set("products", products);
}

// API Routes
app.get('/api/products', async (req, res) => {
    const products = await getProducts();
    res.json(products.map(({ secret, ...p }) => p));
});

app.get('/api/products/:id/secret', async (req, res) => {
    const { address } = req.query;
    const products = await getProducts();
    const p = products.find(prod => String(prod.id) === String(req.params.id));
    if (!p) return res.status(404).json({ error: "Not found" });

    const opKey = process.env.OPERATOR_PRIVATE_KEY || accounts.A.key;
    const opAddr = facade.network.publicKeyToAddress(new KeyPair(new PrivateKey(utils.hexToUint8(opKey))).publicKey).toString();

    const isAuthorized = (address === p.sellerAddress || address === opAddr);
    if (!isAuthorized && address) {
        const purchased = await verifyPurchaseOnChain(address, p.sellerAddress, p.price, p.title);
        if (purchased) return res.json({ secret: p.secret });
    }
    res.json({ secret: isAuthorized ? p.secret : "購入後に公開されます" });
});

app.get('/api/products/:id/download', async (req, res) => {
    try {
        const id = req.params.id;
        const { address, publicKey, signature, timestamp } = req.query;
        const products = await getProducts();
        const product = products.find(p => String(p.id) === String(id));
        if (!product) return res.status(404).json({ error: "商品が見つかりません" });

        const opKey = process.env.OPERATOR_PRIVATE_KEY || accounts.A.key;
        const opKeyPair = new KeyPair(new PrivateKey(utils.hexToUint8(opKey)));
        const OP_ADDR = facade.network.publicKeyToAddress(opKeyPair.publicKey).toString();

        let isAuthorized = (address === product.sellerAddress || address === OP_ADDR);

        if (!isAuthorized) {
            if (!address) return res.status(403).json({ error: "Address missing" });

            if (signature === 'SSS_AUTH') {
                isAuthorized = await verifyPurchaseOnChain(address, product.sellerAddress, product.price, product.title);
            } else {
                if (!publicKey || !signature || !timestamp) return res.status(403).json({ error: "Auth missing" });
                if (Math.abs(Date.now() - parseInt(timestamp)) > 5 * 60 * 1000) return res.status(403).json({ error: "Expired" });

                const message = `DownloadAsset:${id}:${timestamp}`;
                const isValid = facade.verify(new PublicKey(utils.hexToUint8(publicKey)), new TextEncoder().encode(message), new Signature(utils.hexToUint8(signature)));
                if (!isValid) return res.status(403).json({ error: "Invalid signature" });

                const derived = facade.network.publicKeyToAddress(new PublicKey(utils.hexToUint8(publicKey))).toString();
                if (derived.replace(/-/g,'').toUpperCase() !== address.replace(/-/g,'').toUpperCase()) return res.status(403).json({ error: "Address mismatch" });

                isAuthorized = await verifyPurchaseOnChain(address, product.sellerAddress, product.price, product.title);
            }
        }

        if (!isAuthorized) return res.status(403).json({ error: "Unauthorized" });

        const secretStr = product.secret.replace('URL: ', '');
        if (secretStr.startsWith('http')) return res.redirect(secretStr);
        
        const fileName = path.basename(secretStr);
        const filePath = path.join(uploadDir, fileName);
        if (fs.existsSync(filePath)) return res.download(filePath, product.fileName || fileName);
        
        res.status(404).json({ error: "File not found" });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/products', upload.single('file'), async (req, res) => {
    try {
        const { title, price, sellerAddress, sellerPublicKey, description, imageUrl } = req.body;
        if (!req.file) return res.status(400).json({ error: "No file" });

        const productId = Date.now();
        const host = req.get('host');
        const secretUrl = `${req.protocol}://${host}/api/products/${productId}/download`;

        const products = await getProducts();
        const newProduct = {
            id: productId, title, price: parseInt(price), sellerAddress, sellerPublicKey,
            description: description || "", imageUrl: imageUrl || "",
            fileName: req.file.originalname, secret: `URL: ${secretUrl}`
        };
        products.push(newProduct);
        await saveProducts(products);
        res.json({ success: true, product: newProduct });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/purchase_sss', async (req, res) => {
    try {
        const { signedPayload } = req.body;
        const response = await fetch(`${NODE_URL}/transactions`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ payload: signedPayload })
        });
        if (!response.ok) throw new Error(await response.text());
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/build_transaction', async (req, res) => {
    try {
        const { productId, buyerPublicKey } = req.body;
        const products = await getProducts();
        const p = products.find(prod => String(prod.id) === String(productId));
        const opKey = process.env.OPERATOR_PRIVATE_KEY || accounts.A.key;
        const opKeyPair = new KeyPair(new PrivateKey(utils.hexToUint8(opKey)));

        const tx1 = facade.transactionFactory.createEmbedded({
            type: 'transfer_transaction_v1',
            signerPublicKey: new PublicKey(utils.hexToUint8(buyerPublicKey)),
            recipientAddress: facade.network.publicKeyToAddress(new PublicKey(utils.hexToUint8(p.sellerPublicKey))),
            mosaics: [{ mosaicId: toBigInt(CURRENCY_ID), amount: toBigInt(p.price * 1000000) }],
            message: new TextEncoder().encode('Nexus Swap: ' + p.title)
        });
        const tx2 = facade.transactionFactory.createEmbedded({
            type: 'transfer_transaction_v1',
            signerPublicKey: opKeyPair.publicKey,
            recipientAddress: facade.network.publicKeyToAddress(new PublicKey(utils.hexToUint8(buyerPublicKey))),
            message: new TextEncoder().encode(p.secret)
        });

        const txs = [tx1, tx2];
        const aggregateTx = facade.transactionFactory.create({
            type: 'aggregate_complete_transaction_v2',
            signerPublicKey: opKeyPair.publicKey,
            deadline: BigInt(Date.now() - 1667250467000 + 7200000),
            transactionsHash: facade.constructor.hashEmbeddedTransactions(txs),
            transactions: txs
        });
        facade.constructor.attachMaxFee(aggregateTx, 100);
        aggregateTx.signature = facade.sign(aggregateTx, opKeyPair.privateKey);

        res.json({ success: true, payload: utils.uint8ToHex(aggregateTx.serialize()), hash: facade.hashTransaction(aggregateTx).toString() });
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

app.get('/api/config', (req, res) => {
    const opKey = process.env.OPERATOR_PRIVATE_KEY || accounts.A.key;
    const opPubKey = new KeyPair(new PrivateKey(utils.hexToUint8(opKey))).publicKey;
    res.json({ operatorPublicKey: opPubKey.toString(), currencyId: CURRENCY_ID });
});

app.use(express.static('public'));
app.use('/uploads', express.static(uploadDir));

app.listen(port, () => console.log(`Server running at http://localhost:${port}`));
export default app;
