import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { createClient } from '@vercel/kv';
import { fileURLToPath } from 'url';
import * as symbolSdkModule from 'symbol-sdk';

const { SymbolFacade, PrivateKey, PublicKey, Signature, KeyPair, utils } = symbolSdkModule;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const port = process.env.PORT || 3000;

const kv = createClient({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

app.use(cors());
app.use(express.json());

const facade = new SymbolFacade('testnet');
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

// 秘密鍵モードのトランザクション構築用エンドポイント
app.post('/api/build_transaction', async (req, res) => {
    try {
        const { productId, buyerPublicKey } = req.body;
        const products = await getProducts();
        const p = products.find(prod => String(prod.id) === String(productId));
        if (!p) return res.status(404).json({ error: "商品が見つかりません" });

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

        // 成功を期して Bonded で構築
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
    } catch (e) { 
        res.status(500).json({ error: e.message }); 
    }
});

// 静的ファイルの提供
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadDir));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

if (process.env.NODE_ENV !== 'production') {
    app.listen(port, () => console.log(`Server running at http://localhost:${port}`));
}
export default app;
