import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

console.log('--- AETHER MARKET SERVER STARTING (v1.0.2) ---');

// ESMでサブモジュールのインポートが不安定な場合があるため、より明示的なパス指定を検討
import { PrivateKey } from 'symbol-sdk';
import * as symbol_pkg from 'symbol-sdk/symbol';
const { SymbolFacade, KeyPair } = symbol_pkg;
import multer from 'multer';

// multerの設定: アップロードされたファイルを保存
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = process.env.VERCEL ? '/tmp' : 'uploads/';
        if (!process.env.VERCEL && !fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir);
        }
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        // ファイル名をユニークにする（タイムスタンプ + 元の拡張子）
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;

// 絶対パスを使用して静的ファイルを配信
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ヘルスチェック用のテストエンドポイント
app.get('/api/test', (req, res) => {
    res.json({ status: 'ok', version: '1.0.3', node: process.version });
});

const DB_FILE = path.join(__dirname, 'data.json');

// --- Pinata (IPFS) 設定 ---
const PINATA_API_KEY = process.env.PINATA_API_KEY || ''; 
const PINATA_SECRET_API_KEY = process.env.PINATA_SECRET_API_KEY || ''; 
const PINATA_JWT = process.env.PINATA_JWT || ''; 

/**
 * Pinata にファイルをアップロードする関数
 */
async function uploadToPinata(filePath, fileName) {
    if (!PINATA_API_KEY || !PINATA_SECRET_API_KEY) {
        console.warn("Pinata APIキーが設定されていないため、ローカル保存のみ行います。");
        return null;
    }

    try {
        const formData = new FormData();
        const fileContent = fs.readFileSync(filePath);
        const blob = new Blob([fileContent]);
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
            console.error("Pinata Upload Error:", await response.text());
            return null;
        }
    } catch (error) {
        console.error("IPFS Upload Failed:", error);
        return null;
    }
}

if (!process.env.VERCEL) {
    if (!fs.existsSync(DB_FILE)) {
        fs.writeFileSync(DB_FILE, JSON.stringify({ products: [] }, null, 2));
    }
    if (!fs.existsSync('uploads')) {
        fs.mkdirSync('uploads');
    }
}

const facade = new SymbolFacade('testnet');
const NODE_URL = 'https://sym-test-01.opening-line.jp:3001'; 

const accounts = {
    A: { name: "運営", key: process.env.OPERATOR_KEY || 'CED3DD0A92ECC31FA33C32BF46356255145D9FA93FEE1FB9E11A10CDF39F44BC' }
};

let CURRENCY_ID = '72C0212E67A08BCE'; 

// Vercel等のDBがない環境用の一時的な保存先
let memoryProducts = [];

// SSS連携: クライアントから「部分署名済みのアグリゲートトランザクション」を受け取り、運営(A)がアナウンスするエンドポイント
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
            res.json({ success: true, message: "トランザクションをネットワークに送信しました" });
        } else {
            const errorData = await response.json();
            console.error("Node Error:", errorData);
            res.status(response.status).json({ 
                success: false, 
                error: errorData.code || "トランザクション送信失敗", 
                details: errorData.message || JSON.stringify(errorData) 
            });
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: error.message });
    }
});

function getProducts() {
    try {
        if (process.env.VERCEL) {
            // data.json の初期データとメモリ内のデータを合体させる
            let initialProducts = [];
            if (fs.existsSync(DB_FILE)) {
                const data = JSON.parse(fs.readFileSync(DB_FILE));
                initialProducts = data.products || [];
            }
            return [...initialProducts, ...memoryProducts];
        }

        if (!fs.existsSync(DB_FILE)) {
            return [];
        }
        const data = JSON.parse(fs.readFileSync(DB_FILE));
        return data.products || [];
    } catch (error) {
        console.error("Database read error:", error);
        return [];
    }
}

app.get('/api/products', (req, res) => {
    try {
        const products = getProducts();
        console.log(`[GET] Fetching products list. Count: ${products.length}`);
        const safeProducts = products.map(p => {
            const { secret, ...safeProduct } = p;
            return safeProduct;
        });
        res.json(safeProducts);
    } catch (error) {
        console.error(`[ERROR] Products endpoint failed: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

// 秘密情報(secret)をクライアントに送る。
// 本来は署名検証等が必要だが、デモとして「リクエストしたアドレス」を信用して送信する
function saveProducts(products) {
    if (process.env.VERCEL) {
        // Vercelではファイルに書けないのでメモリに保存
        // 既存の data.json にない新規追加分のみを抽出して保持
        let initialIds = [];
        try {
            if (fs.existsSync(DB_FILE)) {
                const data = JSON.parse(fs.readFileSync(DB_FILE));
                initialIds = (data.products || []).map(p => p.id);
            }
        } catch (e) {}
        memoryProducts = products.filter(p => !initialIds.includes(p.id));
        return;
    }
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify({ products }, null, 2));
    } catch (error) {
        console.error("Database write error:", error);
    }
}

app.get('/api/products/:id/secret', (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const requesterAddress = req.query.address; 
        
        console.log(`[GET] Fetching secret for product ID: ${id} (requested by: ${requesterAddress})`);
        
        const products = getProducts();
        const product = products.find(p => String(p.id) === String(id));
        
        if (!product) {
            return res.status(404).json({ error: "商品が見つかりません" });
        }

        const OPERATOR_ADDRESS = facade.network.publicKeyToAddress(new KeyPair(new PrivateKey(accounts.A.key)).publicKey).toString();

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

app.get('/api/products/:id/download', (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const requesterAddress = req.query.address;
        
        const products = getProducts();
        const product = products.find(p => String(p.id) === String(id));
        
        if (!product) return res.status(404).json({ error: "商品が見つかりません" });

        if (!requesterAddress) {
            return res.status(403).json({ error: "ダウンロード権限がありません。ウォレットを接続してください。" });
        }

        const secretStr = product.secret.replace('URL: ', '');
        if (secretStr.startsWith('http')) {
            const filename = path.basename(secretStr);
            const filePath = path.join(__dirname, 'uploads', filename);
            
            if (fs.existsSync(filePath)) {
                res.download(filePath, product.fileName || filename);
            } else {
                res.status(404).json({ error: "ファイルがサーバー上に見つかりません" });
            }
        } else {
            res.json({ message: "外部URLのため、直接ブラウザで開いてください", url: secretStr });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// SSS用：トランザクション生成に必要な公開鍵情報などを提供
app.get('/api/config', (req, res) => {
    const operatorKeyPair = new KeyPair(new PrivateKey(accounts.A.key));
    res.json({
        operatorPublicKey: operatorKeyPair.publicKey.toString(),
        currencyId: CURRENCY_ID,
        networkType: 'testnet',
        generationHash: '49D6E1CE276A85B70E1FDAD5093008F24BC3D0B66FE300B4E6517BC2AF227E2C'
    });
});

app.post('/api/products', upload.single('file'), async (req, res) => {
    try {
        const { title, price, seller, sellerAddress, sellerPublicKey, description, imageUrl, saleType, mosaicId } = req.body;
        const file = req.file;
        if (!file) {
            console.error("[400] Registration failed: No file uploaded");
            return res.status(400).json({ error: "ファイルがありません。商品には必ずデジタルファイルの添付が必要です。" });
        }

        // IPFS にアップロードを試みる
        const ipfsUrl = await uploadToPinata(file.path, file.originalname);
        
        // Vercel環境での警告（Pinataがない場合）
        if (process.env.VERCEL && !ipfsUrl) {
            console.warn("Vercel環境ですが Pinata APIキーが設定されていないため、ファイルは一時保存のみとなります（数分で消えます）");
        }

        const protocol = req.protocol;
        const host = req.get('host');
        const secretUrl = ipfsUrl || `${protocol}://${host}/uploads/${file.filename}`;

        const products = getProducts();
        const newProduct = {
            id: Date.now(),
            title,
            price: parseInt(price),
            seller,
            sellerAddress,
            sellerPublicKey,
            description: description || "",
            imageUrl: imageUrl || "https://images.unsplash.com/photo-1614850523296-d8c1af93d400?w=800&auto=format&fit=crop&q=60",
            fileName: file.originalname,
            saleType: saleType || "file",
            mosaicId: mosaicId || null,
            secret: `URL: ${secretUrl}`
        };
        products.push(newProduct);
        saveProducts(products);
        res.json({ success: true, product: newProduct });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 商品の編集
app.patch('/api/products/:id', (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const { title, price, description, imageUrl, requesterAddress, saleType, mosaicId } = req.body;
        const products = getProducts();
        const index = products.findIndex(p => p.id === id);

        if (index === -1) return res.status(404).json({ error: "商品が見つかりません" });

        const product = products[index];
        const OPERATOR_ADDRESS = facade.network.publicKeyToAddress(new KeyPair(new PrivateKey(accounts.A.key)).publicKey).toString();
        
        if (requesterAddress !== product.sellerAddress && requesterAddress !== OPERATOR_ADDRESS) {
            return res.status(403).json({ error: "編集権限がありません" });
        }

        if (title) product.title = title;
        if (price) product.price = parseInt(price);
        if (description) product.description = description;
        if (imageUrl) product.imageUrl = imageUrl;
        if (saleType) product.saleType = saleType;
        if (mosaicId !== undefined) product.mosaicId = mosaicId;

        saveProducts(products);
        res.json({ success: true, product });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/products/:id', (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const { requesterAddress } = req.body;
        const products = getProducts();
        const index = products.findIndex(p => p.id === id);

        if (index === -1) return res.status(404).json({ error: "商品が見つかりません" });

        const product = products[index];
        const OPERATOR_ADDRESS = facade.network.publicKeyToAddress(new KeyPair(new PrivateKey(accounts.A.key)).publicKey).toString();

        if (requesterAddress !== product.sellerAddress && requesterAddress !== OPERATOR_ADDRESS) {
            return res.status(403).json({ error: "削除権限がありません" });
        }

        products.splice(index, 1);
        saveProducts(products);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// API 404 ハンドラー (HTML ではなく JSON を返すようにする)
// Express 5.x では '*' にパラメータ名が必要なため、単に '/api' を使用（接頭辞一致）
app.use('/api', (req, res) => {
    console.warn(`[404] API route not found: ${req.originalUrl}`);
    res.status(404).json({ error: `API route not found: ${req.originalUrl}. もしこのURLが正しいはずなら、サーバーを再起動して最新のコードが反映されているか確認してください。` });
});

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
    app.listen(port, () => {
        console.log(`サーバーが正常に起動しました: http://localhost:${port}`);
    });
}

export default app;
