import express from 'express';
import cors from 'cors';
import fs from 'fs';
import { createClient } from '@vercel/kv';
import path from 'path';
import { fileURLToPath } from 'url';
import multer from 'multer';

// Vercel KV REST API のURLとトークンを使用
const kvRestApiUrl = process.env.KV_REST_API_URL;
const kvRestApiToken = process.env.KV_REST_API_TOKEN;

// 認証情報のログを追加
console.log(`[DEBUG] KV_REST_API_URL present: ${!!kvRestApiUrl}, KV_REST_API_TOKEN present: ${!!kvRestApiToken}`);

const kv = createClient({
    url: kvRestApiUrl,
    token: kvRestApiToken,
});

console.log('--- AETHER MARKET SERVER STARTING (v1.1.6) ---');

// ESMでサブモジュールのインポートが不安定な場合があるため、より明示的なパス指定を検討
import * as symbol_pkg_main from 'symbol-sdk';
import * as symbol_pkg_core from 'symbol-sdk/symbol';

// SDK v3 の正しいクラス参照を定義
const { SymbolFacade, KeyPair, models } = symbol_pkg_core;
const { PrivateKey, PublicKey, Signature, utils } = symbol_pkg_main;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// アップロード先の設定 (Vercel環境では /tmp を使用)
const uploadDir = process.env.VERCEL ? '/tmp' : path.join(__dirname, 'uploads');

// multerの設定: アップロードされたファイルを保存
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        try {
            if (!fs.existsSync(uploadDir)) {
                fs.mkdirSync(uploadDir, { recursive: true });
            }
            cb(null, uploadDir);
        } catch (e) {
            cb(e);
        }
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

const app = express();
app.use(cors());
const port = process.env.PORT || 3000;

// 絶対パスを使用して静的ファイルを配信
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// アップロードされたファイルを配信するルート (IPFS失敗時のフォールバック用)
app.use('/uploads', express.static(uploadDir));

// Symbol SDK v3 のブラウザ用バイナリを配信
app.get('/lib/symbol-sdk-v3.js', (req, res) => {
    try {
        const bundlePath = path.join(__dirname, 'node_modules/symbol-sdk/dist/bundle.web.js');
        if (fs.existsSync(bundlePath)) {
            res.sendFile(bundlePath);
        } else {
            res.status(404).send('Symbol SDK Bundle not found');
        }
    } catch (e) {
        res.status(500).send(e.message);
    }
});

// ヘルスチェック用のテストエンドポイント
app.get('/api/test', (req, res) => {
    res.json({ 
        status: 'ok', 
        version: '1.1.6', 
        node: process.version,
        sdk: {
            hasPrivateKey: typeof PrivateKey === 'function',
            hasSymbolFacade: typeof SymbolFacade === 'function'
        },
        env: {
            isVercelEnv: !!process.env.VERCEL,
            hasPinata: !!process.env.PINATA_API_KEY,
            nodeUrl: process.env.NODE_URL,
            operatorKey: process.env.OPERATOR_KEY ? '******' + process.env.OPERATOR_KEY.substring(process.env.OPERATOR_KEY.length - 6) : null,
            currencyId: process.env.CURRENCY_ID
        }
    });
});

// --- Pinata (IPFS) 設定 ---
const PINATA_API_KEY = process.env.PINATA_API_KEY || ''; 
const PINATA_SECRET_API_KEY = process.env.PINATA_SECRET_API_KEY || ''; 

async function uploadToPinata(filePath, fileName) {
    if (!PINATA_API_KEY || !PINATA_SECRET_API_KEY) {
        console.warn("[WARN] Pinata APIキーが設定されていないため、ローカル保存のみ行います。");
        return null;
    }
    try {
        console.log(`[INFO] Uploading to Pinata: ${fileName}`);
        const formData = new FormData();
        const fileContent = fs.readFileSync(filePath);
        const blob = new Blob([fileContent], { type: 'application/octet-stream' });
        formData.append('file', blob, fileName);

        const response = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
            method: 'POST',
            headers: {
                'pinata_api_key': PINATA_API_KEY,
                'pinata_secret_api_key': PINATA_SECRET_API_KEY
            },
            body: formData
        });

        if (response.ok) {
            const result = await response.json();
            return `https://gateway.pinata.cloud/ipfs/${result.IpfsHash}`;
        } else {
            const errorText = await response.text();
            console.error(`[ERROR] Pinata API Error:`, errorText);
            return null;
        }
    } catch (error) {
        console.error(`[ERROR] Pinata Upload Process Failed:`, error);
        return null;
    }
}

// --- ネットワーク・通貨設定 ---
const DB_FILE = path.join(__dirname, 'data.json');
const CURRENCY_ID = '51138C86FBF19505'; // Nexus Credit (NXC)
const PIONEER_MOSAIC_ID = '4E3FD79DC36A6474'; // Nexus Pioneer (NXP)
const NODE_URL = process.env.NODE_URL || 'https://sym-test-01.opening-line.jp:3001'; 

const accounts = {
    A: { name: "運営", key: process.env.OPERATOR_KEY || 'CED3DD0A92ECC31FA33C32BF46356255145D9FA93FEE1FB9E11A10CDF39F44BC' }
};

const toBigInt = (val) => {
    if (typeof val === 'bigint') return val;
    if (typeof val === 'number') return BigInt(Math.floor(val));
    const cleanHex = String(val).startsWith('0x') ? val : '0x' + val;
    return BigInt(cleanHex);
};

let facade;
try {
    facade = new SymbolFacade('testnet');
} catch (e) {
    console.error("SymbolFacade initialization failed!", e);
}

// ストレージ関数
async function getProducts() {
    try {
        if (process.env.VERCEL || (kvRestApiUrl && kvRestApiToken)) {
            const data = await kv.get("products");
            return data || [];
        } else {
            if (fs.existsSync(DB_FILE)) {
                return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')).products || [];
            }
            return [];
        }
    } catch (error) {
        console.error("Storage read error:", error);
        return [];
    }
}

async function saveProducts(products) {
    try {
        if (process.env.VERCEL || (kvRestApiUrl && kvRestApiToken)) {
            await kv.set("products", products);
        } else {
            fs.writeFileSync(DB_FILE, JSON.stringify({ products }, null, 2));
        }
    } catch (error) {
        console.error("Storage write error:", error);
    }
}

// --- API Endpoints ---

app.get('/api/products', async (req, res) => {
    try {
        const products = await getProducts();
        const safeProducts = products.map(p => {
            const { secret, ...safeProduct } = p;
            return safeProduct;
        });
        res.json(safeProducts);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/purchase_sss', async (req, res) => {
    try {
        const { signedPayload } = req.body;
        if (!signedPayload) return res.status(400).json({ error: "署名済みデータがありません" });

        const response = await fetch(`${NODE_URL}/transactions`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ payload: signedPayload })
        });

        if (response.ok) {
            res.json({ success: true, message: "トランザクションを送信しました" });
        } else {
            const errorData = await response.json();
            res.status(response.status).json({ success: false, error: errorData.code });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/record_sale', async (req, res) => {
    try {
        const { hash, productId, sellerAddress } = req.body;
        if (!hash || !sellerAddress) return res.status(400).json({ error: "パラメータ不足" });

        const saleRecordKey = `sale_recorded_${hash}`;
        if (await kv.get(saleRecordKey)) return res.json({ success: true });

        const products = await getProducts();
        const p = products.find(item => item.id.toString() === productId.toString());
        if (!p) return res.status(404).json({ error: "商品不明" });

        const countKey = `user_sales_count_${sellerAddress}`;
        const amountKey = `user_sales_amount_${sellerAddress}`;
        const newCount = (Number(await kv.get(countKey)) || 0) + 1;
        const newAmount = (Number(await kv.get(amountKey)) || 0) + p.price;

        await kv.set(countKey, newCount);
        await kv.set(amountKey, newAmount);
        await kv.set(saleRecordKey, true);

        let promoted = false;
        if (newCount >= 30 || newAmount >= 50000) {
            const meritPioneerKey = `pioneer_merit_${sellerAddress}`;
            if (!(await kv.get(meritPioneerKey))) {
                const operatorPrivateKey = new PrivateKey(utils.hexToUint8(accounts.A.key));
                const operatorKeyPair = new KeyPair(operatorPrivateKey);
                const symbolTime = BigInt(Date.now() - 1667250467 * 1000 + 7200000);

                const tx = facade.transactionFactory.create({
                    type: 'transfer_transaction_v1',
                    signerPublicKey: operatorKeyPair.publicKey,
                    fee: 100000n,
                    deadline: symbolTime,
                    recipientAddress: sellerAddress,
                    mosaics: [{ mosaicId: toBigInt(PIONEER_MOSAIC_ID), amount: 1n }],
                    message: new Uint8Array([0, ...Buffer.from('Merit: Nexus Pioneer!')])
                });
                const sig = facade.signTransaction(operatorKeyPair, tx);
                tx.signature = new models.Signature(sig.bytes);
                await fetch(`${NODE_URL}/transactions`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ payload: utils.uint8ToHex(tx.serialize()) }) });
                await kv.set(meritPioneerKey, true);
                promoted = true;
            }
        }
        res.json({ success: true, promoted });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/achievements/:address', async (req, res) => {
    try {
        const { address } = req.params;
        const count = await kv.get(`user_sales_count_${address}`) || 0;
        const amount = await kv.get(`user_sales_amount_${address}`) || 0;
        res.json({ count, amount });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/claim_bonus', async (req, res) => {
    try {
        const { address } = req.body;
        if (!address) return res.status(400).json({ error: "アドレスなし" });

        const bonusKey = `bonus_claimed_${address}`;
        if (await kv.get(bonusKey)) return res.status(400).json({ error: "配布済み" });

        const countKey = 'pioneer_claim_count';
        const currentCount = (await kv.get(countKey)) || 0;
        const isPioneerEligible = currentCount < 30;

        const operatorPrivateKey = new PrivateKey(utils.hexToUint8(accounts.A.key));
        const operatorKeyPair = new KeyPair(operatorPrivateKey);
        const symbolTime = BigInt(Date.now() - 1667250467 * 1000 + 7200000);

        const mosaics = [
            { mosaicId: toBigInt(CURRENCY_ID), amount: 500n * 1000000n },
            { mosaicId: toBigInt('72C0212E67A08BCE'), amount: 10n * 1000000n }
        ];
        if (isPioneerEligible) mosaics.push({ mosaicId: toBigInt(PIONEER_MOSAIC_ID), amount: 1n });

        const tx = facade.transactionFactory.create({
            type: 'transfer_transaction_v1',
            signerPublicKey: operatorKeyPair.publicKey,
            fee: 200000n,
            deadline: symbolTime,
            recipientAddress: address,
            mosaics: mosaics,
            message: new Uint8Array([0, ...Buffer.from('Welcome to Nexus!')])
        });
        const sig = facade.signTransaction(operatorKeyPair, tx);
        tx.signature = new models.Signature(sig.bytes);

        const response = await fetch(`${NODE_URL}/transactions`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ payload: utils.uint8ToHex(tx.serialize()) })
        });

        if (response.ok) {
            await kv.set(bonusKey, true);
            if (isPioneerEligible) await kv.set(countKey, currentCount + 1);
            res.json({ success: true, isPioneer: isPioneerEligible });
        } else {
            const err = await response.json();
            res.status(500).json({ error: "配布失敗", details: err });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/products/:id/secret', async (req, res) => {
    try {
        const id = req.params.id;
        const requesterAddress = req.query.address; 
        const products = await getProducts();
        const product = products.find(p => String(p.id) === String(id));
        if (!product) return res.status(404).json({ error: "商品不明" });

        const operatorPrivateKey = new PrivateKey(utils.hexToUint8(accounts.A.key));
        const operatorKeyPair = new KeyPair(operatorPrivateKey);
        const OPERATOR_ADDRESS = facade.network.publicKeyToAddress(operatorKeyPair.publicKey).toString();

        if (requesterAddress !== product.sellerAddress && requesterAddress !== OPERATOR_ADDRESS && !requesterAddress) {
             return res.json({ secret: "購入後に公開されます" });
        }
        res.json({ secret: product.secret });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/products/:id/download', async (req, res) => {
    try {
        const id = req.params.id;
        const requesterAddress = req.query.address;
        const products = await getProducts();
        const product = products.find(p => String(p.id) === String(id));
        if (!product) return res.status(404).json({ error: "商品不明" });
        if (!requesterAddress) return res.status(403).json({ error: "要ウォレット接続" });

        const secretStr = product.secret.replace('URL: ', '');
        if (secretStr.startsWith('http')) {
            return res.redirect(secretStr);
        } else if (secretStr.includes('/uploads/')) {
            const fileName = secretStr.split('/').pop();
            const filePath = path.join(uploadDir, fileName);
            if (fs.existsSync(filePath)) return res.download(filePath, product.fileName || fileName);
            return res.status(404).json({ error: "ファイル消失（Vercel制限）", details: "IPFS推奨" });
        }
        res.status(404).json({ error: "無効なURL" });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/config', (req, res) => {
    try {
        const operatorPrivateKey = new PrivateKey(utils.hexToUint8(accounts.A.key));
        const operatorKeyPair = new KeyPair(operatorPrivateKey);
        res.json({
            operatorPublicKey: operatorKeyPair.publicKey.toString(),
            currencyId: CURRENCY_ID,
            networkType: 'testnet',
            generationHash: '49D6E1CE276A85B70EAFE52349AACCA389302E7A9754BCF1221E79494FC665A4'
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/products', upload.fields([{ name: 'file', maxCount: 1 }, { name: 'image', maxCount: 1 }]), async (req, res) => {
    try {
        const { title, price, sellerAddress, sellerPublicKey, description, imageUrl } = req.body;
        const file = req.files['file']?.[0];
        const imageFile = req.files['image']?.[0];
        if (!file) return res.status(400).json({ error: "ファイルなし" });

        let ipfsUrl = await uploadToPinata(file.path, file.originalname);
        let finalImageUrl = imageUrl || "https://images.unsplash.com/photo-1614850523296-d8c1af93d400?w=800";
        if (imageFile) {
            const uploadedImageUrl = await uploadToPinata(imageFile.path, imageFile.originalname);
            finalImageUrl = uploadedImageUrl || `${req.protocol}://${req.get('host')}/uploads/${imageFile.filename}`;
        }

        const secretUrl = ipfsUrl || `${req.protocol}://${req.get('host')}/uploads/${file.filename}`;
        const products = await getProducts();
        const newProduct = {
            id: Date.now(),
            title,
            price: parseInt(price),
            sellerAddress,
            sellerPublicKey,
            description,
            imageUrl: finalImageUrl,
            fileName: file.originalname,
            secret: `URL: ${secretUrl}`
        };
        products.push(newProduct);
        await saveProducts(products);
        res.json({ success: true, product: newProduct });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/products/:id', async (req, res) => {
    try {
        const id = req.params.id;
        const { requesterAddress } = req.body;
        const products = await getProducts();
        const index = products.findIndex(p => String(p.id) === String(id));
        if (index === -1) return res.status(404).json({ error: "商品不明" });

        const operatorPrivateKey = new PrivateKey(utils.hexToUint8(accounts.A.key));
        const operatorKeyPair = new KeyPair(operatorPrivateKey);
        const OPERATOR_ADDRESS = facade.network.publicKeyToAddress(operatorKeyPair.publicKey).toString();

        if (requesterAddress !== products[index].sellerAddress && requesterAddress !== OPERATOR_ADDRESS) {
            return res.status(403).json({ error: "権限なし" });
        }

        products.splice(index, 1);
        await saveProducts(products);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.listen(port, () => console.log(`Server running at http://localhost:${port}`));
export default app;
