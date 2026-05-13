import express from 'express';
import cors from 'cors';
import fs from 'fs';
import { createClient } from '@vercel/kv';

// Vercel KV REST API のURLとトークンを使用
const kvRestApiUrl = process.env.KV_REST_API_URL;
const kvRestApiToken = process.env.KV_REST_API_TOKEN;

// 認証情報のログを追加
console.log(`[DEBUG] KV_REST_API_URL present: ${!!kvRestApiUrl}, KV_REST_API_TOKEN present: ${!!kvRestApiToken}`);

const kv = createClient({
    url: kvRestApiUrl,
    token: kvRestApiToken,
});
import path from 'path';
import { fileURLToPath } from 'url';
import multer from 'multer';

console.log('--- AETHER MARKET SERVER STARTING (v1.1.3) ---');

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
        version: '1.1.5', 
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
const PINATA_JWT = process.env.PINATA_JWT || ''; 

/**
 * Pinata にファイルをアップロードする関数
 */
async function uploadToPinata(filePath, fileName) {
    if (!PINATA_API_KEY || !PINATA_SECRET_API_KEY) {
        console.warn("[WARN] Pinata APIキーが設定されていないため、ローカル保存のみ行います。");
        console.log(`[DEBUG] PINATA_API_KEY present: ${!!PINATA_API_KEY}, PINATA_SECRET_API_KEY present: ${!!PINATA_SECRET_API_KEY}`);
        return null;
    }

    try {
        console.log(`[INFO] Uploading to Pinata: ${fileName}`);
        const formData = new FormData();
        const fileContent = fs.readFileSync(filePath);
        // Node.js 22 の Blob を使用
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
            console.log(`[DEBUG] Pinata upload successful. IPFS Hash: ${result.IpfsHash}`);
            return `https://gateway.pinata.cloud/ipfs/${result.IpfsHash}`;
        } else {
            const errorText = await response.text();
            console.error(`[ERROR] Pinata API Error (Status ${response.status}):`, errorText);
            return null;
        }
    } catch (error) {
        console.error(`[ERROR] Pinata Upload Process Failed:`, error);
        return null;
    }
}

// --- データベース・ストレージ設定 ---
const DB_FILE = path.join(__dirname, 'data.json');
const CURRENCY_ID = '51138C86FBF19505'; // Nexus Credit (NXC)
const PIONEER_MOSAIC_ID = '4E3FD79DC36A6474'; // Nexus Pioneer (NXP)
const NODE_URL = process.env.NODE_URL || 'https://sym-test-01.opening-line.jp:3001'; 

async function getProducts() {
    try {
        if (process.env.VERCEL || (kvRestApiUrl && kvRestApiToken)) {
            const data = await kv.get("products");
            return data || [];
        } else {
            // ローカル環境のフォールバック
            if (fs.existsSync(DB_FILE)) {
                const raw = fs.readFileSync(DB_FILE, 'utf8');
                return JSON.parse(raw).products || [];
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
            console.log(`[DEBUG] Writing to Vercel KV`);
            await kv.set("products", products);
        } else {
            // ローカル環境のフォールバック
            fs.writeFileSync(DB_FILE, JSON.stringify({ products }, null, 2));
            console.log("[DEBUG] Successfully wrote to local data.json.");
        }
    } catch (error) {
        console.error("Storage write error:", error);
    }
}

// データベースファイルの初期化（Vercel以外）
if (!process.env.VERCEL) {
    try {
        if (!fs.existsSync(DB_FILE)) {
            fs.writeFileSync(DB_FILE, JSON.stringify({ products: [] }, null, 2));
        }
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
    } catch (e) {
        console.error("DB Initialization Error:", e);
    }
}

app.get('/api/products/:id/secret', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const requesterAddress = req.query.address; 
        
        console.log(`[GET] Fetching secret for product ID: ${id} (requested by: ${requesterAddress})`);
        
        const products = await getProducts();
        const product = products.find(p => String(p.id) === String(id));
        
        if (!product) {
            return res.status(404).json({ error: "商品が見つかりません" });
        }

        const operatorPrivateKey = new PrivateKey(utils.hexToUint8(accounts.A.key));
        const operatorKeyPair = new KeyPair(operatorPrivateKey);
        const OPERATOR_ADDRESS = facade.network.publicKeyToAddress(operatorKeyPair.publicKey).toString();

        if (requesterAddress !== product.sellerAddress && requesterAddress !== OPERATOR_ADDRESS && !requesterAddress) {
             return res.json({ secret: "購入後に公開されます" });
        }
        
        console.log(`[SUCCESS] Secret found for product ID ${id}`);
        res.json({ secret: product.secret });
    } catch (error) {
        console.error(`[ERROR] Secret endpoint failed: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/products/:id/download', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const requesterAddress = req.query.address;
        
        const products = await getProducts();
        const product = products.find(p => String(p.id) === String(id));
        
        if (!product) return res.status(404).json({ error: "商品が見つかりません" });

        if (!requesterAddress) {
            return res.status(403).json({ error: "ダウンロード権限がありません。ウォレットを接続してください。" });
        }

        const secretStr = product.secret.replace('URL: ', '');
        console.log(`[DEBUG - /api/products/:id/download] secretStr: ${secretStr}`);
        
        if (secretStr.startsWith('http')) {
            // Pinata (IPFS) のURLの場合は直接リダイレクトする
            console.log(`[INFO] Redirecting to IPFS gateway: ${secretStr}`);
            return res.redirect(secretStr);
        } else if (secretStr.includes('/uploads/')) {
            // ローカルファイルパスが含まれている場合
            const fileName = secretStr.split('/').pop();
            const filePath = path.join(uploadDir, fileName);
            
            if (fs.existsSync(filePath)) {
                return res.download(filePath, product.fileName || fileName);
            } else {
                console.warn(`[WARN] Local file not found in /tmp or uploads: ${filePath}`);
                return res.status(404).json({ 
                    error: "ファイルがサーバー上に見つかりません", 
                    details: "Vercelの制限により一時ファイルが削除された可能性があります。IPFS(Pinata)の設定を推奨します。" 
                });
            }
        } else {
            return res.status(404).json({ error: "無効なダウンロードURLです" });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// SSS用：トランザクション生成に必要な公開鍵情報などを提供
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
        console.error("Config Error Detail:", error);
        res.status(500).json({ error: error.message, stack: error.stack });
    }
});

app.post('/api/products', upload.fields([{ name: 'file', maxCount: 1 }, { name: 'image', maxCount: 1 }]), async (req, res) => {
    try {
        console.log(`[POST] /api/products started. Body:`, JSON.stringify(req.body));
        const { title, price, seller, sellerAddress, sellerPublicKey, description, imageUrl, saleType, mosaicId } = req.body;
        
        const file = req.files['file'] ? req.files['file'][0] : null;
        const imageFile = req.files['image'] ? req.files['image'][0] : null;
        
        if (!file) {
            console.error("[400] Registration failed: data file is missing.");
            return res.status(400).json({ error: "ファイルがありません。商品には必ずデジタルファイルの添付が必要です。" });
        }

        console.log(`[INFO] Received data file: ${file.originalname}, image file: ${imageFile ? imageFile.originalname : 'none'}`);

        // データファイルを IPFS にアップロードを試みる
        let ipfsUrl = null;
        try {
            ipfsUrl = await uploadToPinata(file.path, file.originalname);
        } catch (pinataErr) {
            console.error(`[ERROR] uploadToPinata (data) failed:`, pinataErr);
        }
        
        // サムネイル画像を IPFS にアップロードを試みる
        let finalImageUrl = imageUrl || "https://images.unsplash.com/photo-1614850523296-d8c1af93d400?w=800&auto=format&fit=crop&q=60";
        if (imageFile) {
            try {
                const uploadedImageUrl = await uploadToPinata(imageFile.path, imageFile.originalname);
                if (uploadedImageUrl) {
                    finalImageUrl = uploadedImageUrl;
                } else {
                    // ローカルフォールバック
                    const protocol = req.protocol;
                    const host = req.get('host');
                    finalImageUrl = `${protocol}://${host}/uploads/${imageFile.filename}`;
                }
            } catch (imageErr) {
                console.error(`[ERROR] uploadToPinata (image) failed:`, imageErr);
            }
        }

        const protocol = req.protocol;
        const host = req.get('host');
        const secretUrl = ipfsUrl || `${protocol}://${host}/uploads/${file.filename}`;

        console.log(`[DEBUG - /api/products] Final secretUrl: ${secretUrl}, finalImageUrl: ${finalImageUrl}`);

        const products = await getProducts();
        const newProduct = {
            id: Date.now(),
            title,
            price: parseInt(price),
            seller,
            sellerAddress,
            sellerPublicKey,
            description: description || "",
            imageUrl: finalImageUrl,
            fileName: file.originalname,
            saleType: saleType || "file",
            mosaicId: mosaicId || null,
            secret: `URL: ${secretUrl}`
        };
        console.log("[DEBUG] Attempting to save products...");
        products.push(newProduct);
        await saveProducts(products);
        console.log("[DEBUG] Products save attempt completed.");
        res.json({ success: true, product: newProduct });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 商品の編集
app.patch('/api/products/:id', upload.single('image'), async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const { title, price, description, imageUrl, requesterAddress, saleType, mosaicId } = req.body;
        const imageFile = req.file;

        const products = await getProducts();
        const index = products.findIndex(p => p.id === id);

        if (index === -1) return res.status(404).json({ error: "商品が見つかりません" });

        const product = products[index];
        const operatorPrivateKey = new PrivateKey(utils.hexToUint8(accounts.A.key));
        const operatorKeyPair = new KeyPair(operatorPrivateKey);
        const OPERATOR_ADDRESS = facade.network.publicKeyToAddress(operatorKeyPair.publicKey).toString();
        
        if (requesterAddress !== product.sellerAddress && requesterAddress !== OPERATOR_ADDRESS) {
            return res.status(403).json({ error: "編集権限がありません" });
        }

        if (title) product.title = title;
        if (price) product.price = parseInt(price);
        if (description) product.description = description;
        if (saleType) product.saleType = saleType;
        if (mosaicId) product.mosaicId = mosaicId;

        // 画像の更新ロジック
        if (imageFile) {
            // 新しいファイルがアップロードされた場合
            try {
                const uploadedImageUrl = await uploadToPinata(imageFile.path, imageFile.originalname);
                if (uploadedImageUrl) {
                    product.imageUrl = uploadedImageUrl;
                } else {
                    const protocol = req.protocol;
                    const host = req.get('host');
                    product.imageUrl = `${protocol}://${host}/uploads/${imageFile.filename}`;
                }
            } catch (imageErr) {
                console.error(`[ERROR] Edit uploadToPinata failed:`, imageErr);
            }
        } else if (imageUrl) {
            // URLが直接指定された場合
            product.imageUrl = imageUrl;
        }

        await saveProducts(products);
        res.json({ success: true, product });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 商品の削除
app.delete('/api/products/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const { requesterAddress } = req.body;
        const products = await getProducts();
        const index = products.findIndex(p => p.id === id);

        if (index === -1) return res.status(404).json({ error: "商品が見つかりません" });

        const product = products[index];
        const operatorPrivateKey = new PrivateKey(utils.hexToUint8(accounts.A.key));
        const operatorKeyPair = new KeyPair(operatorPrivateKey);
        const OPERATOR_ADDRESS = facade.network.publicKeyToAddress(operatorKeyPair.publicKey).toString();

        if (requesterAddress !== product.sellerAddress && requesterAddress !== OPERATOR_ADDRESS) {
            return res.status(403).json({ error: "削除権限がありません" });
        }

        products.splice(index, 1);
        await saveProducts(products);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});

export default app;
