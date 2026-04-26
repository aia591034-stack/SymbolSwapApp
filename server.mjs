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

// アップロードされたファイルを配信するルート (静的配信を停止し、認証付きルートへ移行)
// app.use('/uploads', express.static(uploadDir));

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
            isVercel: !!process.env.VERCEL,
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

// データベースファイルの初期化（Vercel以外）
if (!process.env.VERCEL) {
    try {
        if (!fs.existsSync(DB_FILE)) {
            fs.writeFileSync(DB_FILE, JSON.stringify({ products: [] }, null, 2));
        }
        if (!fs.existsSync('uploads')) {
            fs.mkdirSync('uploads', { recursive: true });
        }
    } catch (e) {
        console.error("DB Initialization Error:", e);
    }
}

// facade の初期化を try-catch で囲む
let facade;
try {
    facade = new SymbolFacade('testnet');
} catch (e) {
    console.error("SymbolFacade initialization failed!", e);
}

const NODE_URL = process.env.NODE_URL || 'https://sym-test-01.opening-line.jp:3001'; 

const accounts = {
    A: { name: "運営", key: process.env.OPERATOR_KEY || 'CED3DD0A92ECC31FA33C32BF46356255145D9FA93FEE1FB9E11A10CDF39F44BC' }
};

let CURRENCY_ID = process.env.CURRENCY_ID || '72C0212E67A08BCE'; 

// 16進数文字列を安全に BigInt に変換するヘルパー
const toBigInt = (val) => {
    if (typeof val === 'bigint') return val;
    if (typeof val === 'number') return BigInt(Math.floor(val));
    const cleanHex = String(val).startsWith('0x') ? val : '0x' + val;
    return BigInt(cleanHex);
};

/**
 * オンチェーンで購入履歴を確認する
 */
async function verifyPurchaseOnChain(buyerAddress, sellerAddress, amount, productTitle) {
    try {
        // アドレスを正規化 (ハイフンを除去し大文字に統一)
        const cleanBuyer = (buyerAddress || '').replace(/-/g, '').toUpperCase();
        const cleanSeller = (sellerAddress || '').replace(/-/g, '').toUpperCase();
        const cleanCurrencyId = (CURRENCY_ID || '').toUpperCase();

        if (!cleanBuyer || !cleanSeller) {
             console.error("[ERROR] Invalid addresses for verification");
             return false;
        }

        console.log(`[DEBUG] Verifying purchase: ${cleanBuyer} -> ${cleanSeller}, ${amount} XYM`);
        
        // 1. 承認済み(Confirmed) と 未承認(Unconfirmed) の両方をチェックする
        const endpoints = [
            `${NODE_URL}/accounts/${cleanBuyer}/transactions/confirmed?pageSize=15`,
            `${NODE_URL}/accounts/${cleanBuyer}/transactions/unconfirmed?pageSize=15`
        ];

        for (const url of endpoints) {
            console.log(`[DEBUG] Querying node: ${url}`);
            const res = await fetch(url);
            if (!res.ok) {
                console.warn(`[WARN] Node API returned error: ${res.status} for ${url}`);
                continue;
            }
            const data = await res.json();
            if (!data.data || !Array.isArray(data.data)) continue;

            for (const txWrapper of data.data) {
                const tx = txWrapper.transaction;
                if (!tx) continue;
                
                // Aggregate Transaction (16705: Complete, 16961: Bonded)
                if (tx.type === 16705 || tx.type === 16961) {
                    const embeddedTransactions = tx.transactions || [];
                    const paymentTx = embeddedTransactions.find(etx => {
                        const e = etx.transaction;
                        if (!e || e.type !== 16717) return false;

                        const recipient = (e.recipientAddress || '').replace(/-/g, '').toUpperCase();
                        const isToSeller = recipient === cleanSeller;
                        
                        const hasAmount = e.mosaics && e.mosaics.some(m => {
                            const mId = (m.id || '').toUpperCase();
                            return mId === cleanCurrencyId && 
                                   BigInt(m.amount) === BigInt(Math.round(amount * 1000000));
                        });
                        
                        let hasCorrectMessage = true;
                        if (e.message) {
                            try {
                                const msgHex = e.message;
                                const msgStr = Buffer.from(msgHex.substring(2), 'hex').toString('utf-8');
                                // 判定をより柔軟に (タイトルの一部が含まれていればOK)
                                hasCorrectMessage = msgStr.includes(productTitle) || msgStr.includes("Nexus Swap");
                            } catch (err) {
                                console.warn("Message decode error:", err);
                            }
                        }
                        
                        return isToSeller && hasAmount && hasCorrectMessage;
                    });

                    if (paymentTx) {
                        console.log(`[SUCCESS] Found matching payment tx: ${txWrapper.meta.hash || 'unconfirmed'}`);
                        return true;
                    }
                }
                
                // Simple Transfer (16717)
                if (tx.type === 16717) {
                    const recipient = (tx.recipientAddress || '').replace(/-/g, '').toUpperCase();
                    if (recipient === cleanSeller) {
                        const hasAmount = tx.mosaics && tx.mosaics.some(m => {
                            const mId = (m.id || '').toUpperCase();
                            return mId === cleanCurrencyId && 
                                   BigInt(m.amount) === BigInt(Math.round(amount * 1000000));
                        });
                        if (hasAmount) {
                             console.log(`[SUCCESS] Found matching simple payment tx: ${txWrapper.meta.hash || 'unconfirmed'}`);
                             return true;
                        }
                    }
                }
            }
        }
        console.log(`[INFO] No matching purchase found for ${productTitle}`);
        return false;
    } catch (e) {
        console.error("verifyPurchaseOnChain Error:", e);
        return false;
    }
}

// Vercel等のDBがない環境用の一時的な保存先


// SSS連携: クライアントから「部分署名済みのアグリゲートトランザクション」を受け取り、運営(A)がアナウンスするエンドポイント
app.post('/api/purchase_sss', async (req, res) => {
    try {
        console.log(`[DEBUG - /api/purchase_sss] Received signedPayload: ${req.body.signedPayload ? req.body.signedPayload.substring(0, 100) + '...' : 'null'}`);
        const { signedPayload } = req.body;
        if (!signedPayload) {
            console.error("[ERROR - /api/purchase_sss] Signed payload is missing.");
            return res.status(400).json({ error: "署名済みデータがありません" });
        }

        console.log(`[DEBUG - /api/purchase_sss] Sending transaction to node: ${NODE_URL}/transactions`);
        console.log(`[DEBUG - /api/purchase_sss] Request body payload: ${signedPayload.substring(0, 100)}...`);

        const response = await fetch(`${NODE_URL}/transactions`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ payload: signedPayload })
        });

        console.log(`[DEBUG - /api/purchase_sss] Node response status: ${response.status}`);
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

// トランザクション構築エンドポイント（SDK v3を使用して正しい V2 アグリゲートを生成）
app.post('/api/build_transaction', async (req, res) => {
    try {
        const { productId, buyerPublicKey, activeAddress } = req.body;
        console.log(`[POST] build_transaction: productId=${productId}, buyerPublicKey=${buyerPublicKey}`);

        if (!productId || !buyerPublicKey) {
            return res.status(400).json({ error: "商品IDまたは公開鍵が不足しています" });
        }

        const products = await getProducts();
        // IDの型（数値/文字列）に関わらず比較できるように修正
        const p = products.find(item => item.id.toString() === productId.toString());
        
        if (!p) {
            console.error(`[404] Product not found: ${productId}`);
            return res.status(404).json({ error: "商品が見つかりません" });
        }

        console.log(`[INFO] Building transaction for: ${p.title}`);

        const operatorPrivateKey = new PrivateKey(utils.hexToUint8(accounts.A.key));
        const operatorKeyPair = new KeyPair(operatorPrivateKey);
        const buyerPubKeyObj = new PublicKey(utils.hexToUint8(buyerPublicKey));
        const sellerPubKeyObj = new PublicKey(utils.hexToUint8(p.sellerPublicKey));

        const networkType = facade.network.identifier;
        const epochAdjustment = 1667250467; // Testnet Epoch
        const symbolTime = BigInt(Date.now() - epochAdjustment * 1000 + 7200000);
        const deadline = symbolTime; // デスクリプタには生の BigInt を渡す

        const txs = [];

        // 1. 代金の支払い (Buyer -> Seller)
        txs.push(facade.transactionFactory.createEmbedded({
            type: 'transfer_transaction_v1',
            signerPublicKey: buyerPubKeyObj,
            recipientAddress: facade.network.publicKeyToAddress(sellerPubKeyObj),
            mosaics: [{ 
                mosaicId: toBigInt(CURRENCY_ID), 
                amount: toBigInt(p.price * 1000000)
            }],
            message: new Uint8Array([0, ...Buffer.from('Nexus Swap: ' + p.title)]) // Plain message
        }));

        // 2. NFTの移転 (Seller -> Buyer)
        if (p.saleType === 'nft' || p.saleType === 'both') {
            if (p.mosaicId) {
                txs.push(facade.transactionFactory.createEmbedded({
                    type: 'transfer_transaction_v1',
                    signerPublicKey: sellerPubKeyObj,
                    recipientAddress: facade.network.publicKeyToAddress(buyerPubKeyObj),
                    mosaics: [{ 
                        mosaicId: toBigInt(p.mosaicId), 
                        amount: 1n 
                    }],
                    message: new Uint8Array([0, ...Buffer.from('NFT Transfer: ' + p.title)])
                }));
            }
        }

        // 3. メッセージの記録 (Buyer -> Buyer)
        txs.push(facade.transactionFactory.createEmbedded({
            type: 'transfer_transaction_v1',
            signerPublicKey: buyerPubKeyObj,
            recipientAddress: facade.network.publicKeyToAddress(buyerPubKeyObj),
            mosaics: [],
            message: p.secret ? new Uint8Array([0, ...Buffer.from(p.secret)]) : new Uint8Array([0])
        }));

        // アグリゲートトランザクションの作成（最新のV2で統一）
        const merkleRoot = facade.constructor.hashEmbeddedTransactions(txs);
        const aggregateTx = facade.transactionFactory.create({
            type: 'aggregate_complete_transaction_v2',
            signerPublicKey: operatorKeyPair.publicKey,
            deadline: deadline,
            transactionsHash: merkleRoot,
            transactions: txs,
            fee: 1000000n
        });

        // 運営(Operator)が主署名者として署名
        // 【重要】SDK v3 では signTransaction がアグリゲートの特殊な署名範囲（先頭52バイト）を自動的に扱います
        const sig = facade.signTransaction(operatorKeyPair, aggregateTx);
        aggregateTx.signature = new models.Signature(sig.bytes);

        const payload = utils.uint8ToHex(aggregateTx.serialize());

        // ペイロードを返す
        res.json({ 
            success: true, 
            payload: payload,
            hash: facade.hashTransaction(aggregateTx).toString()
        });

    } catch (error) {
        console.error("Build Error Detail:", error);
        res.status(500).json({ success: false, error: error.message, stack: error.stack });
    }
});

// 署名を結合してアナウンスするエンドポイント
app.post('/api/announce_transaction', async (req, res) => {
    try {
        const { payload, cosignatures } = req.body;

            console.log(`[DEBUG] Received payload from client: ${payload.substring(0, 100)}...`);
            console.log(`[DEBUG] Received cosignatures from client: ${JSON.stringify(cosignatures)}`);

            if (!payload) {
                return res.status(400).json({ success: false, error: "Payload is required" });
            }

        // 【究極の修正】取引を再構築せず、クライアントから送られたペイロードを直接デシリアライズする。
        // これにより、署名時のデータ（DeadlineやMerkleRoot等）が100%保持されます。
        const aggregateTx = models.AggregateCompleteTransactionV2.deserialize(utils.hexToUint8(payload));

        // クライアントからのコサイン署名を追加
        if (cosignatures && Array.isArray(cosignatures)) {
            cosignatures.forEach(cs => {
                if (!cs.signerPublicKey || !cs.signature) return;
                const cosignature = new models.Cosignature();
                cosignature.version = 0n;
                cosignature.signerPublicKey = new models.PublicKey(utils.hexToUint8(cs.signerPublicKey));
                cosignature.signature = new models.Signature(utils.hexToUint8(cs.signature));
                aggregateTx.cosignatures.push(cosignature);
            });
        }

        // 最終的なペイロードとハッシュを作成
        const finalPayload = utils.uint8ToHex(aggregateTx.serialize());
        const finalHash = facade.hashTransaction(aggregateTx).toString();

        console.log(`[INFO] Announcing transaction. Hash: ${finalHash}`);

        // ノードにアナウンス
        console.log(`[DEBUG - /api/announce_transaction] Sending finalPayload to node: ${NODE_URL}/transactions`);
        console.log(`[DEBUG - /api/announce_transaction] Final payload body: ${finalPayload.substring(0, 100)}...`);
        const response = await fetch(`${NODE_URL}/transactions`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ payload: finalPayload }) // combinedPayload を finalPayload に修正
        });

        const responseText = await response.text();
        console.log(`[DEBUG - /api/announce_transaction] Node response status: ${response.status}`);
        console.log(`[DEBUG - /api/announce_transaction] Node response text: ${responseText}`);

        if (response.ok) {
            res.json({ success: true, message: "トランザクションを送信しました", hash: finalHash });
        } else {
            let errorDetails = responseText;
            try {
                const errorJson = JSON.parse(responseText);
                errorDetails = errorJson.message || errorJson.code || responseText;
            } catch (e) {
                // JSONパースエラーの場合はそのままテキストを使用
            }
            console.error(`[ERROR] Node announcement failed: ${errorDetails}`);
            res.status(response.status).json({ success: false, error: `Announce Error: ${errorDetails}` });
        }
    } catch (error) {
        console.error("Announce Error:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

async function getProducts() {
    try {
        const data = await kv.get("products");
        return data || [];
    } catch (error) {
        console.error("Vercel KV read error:", error);
        return [];
    }
}

app.get('/api/products', async (req, res) => {
    try {
        const products = await getProducts();
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
async function saveProducts(products) {
    try {
        console.log(`[DEBUG] Writing to Vercel KV with key 'products'`);
        await kv.set("products", products);
        console.log("[DEBUG] Successfully wrote to Vercel KV.");
    } catch (error) {
        console.error("Vercel KV write error:", error);
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

        // 許可されるのは、出品者、運営、または購入済みの人
        const isAuthorized = (requesterAddress === product.sellerAddress || requesterAddress === OPERATOR_ADDRESS);
        
        if (!isAuthorized && requesterAddress) {
            const purchased = await verifyPurchaseOnChain(requesterAddress, product.sellerAddress, product.price, product.title);
            if (purchased) {
                return res.json({ secret: product.secret });
            }
        }

        if (!isAuthorized) {
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
        const { address, publicKey, signature, timestamp } = req.query;
        
        console.log(`[GET] Download request for product ID: ${id} (Address: ${address})`);

        const products = await getProducts();
        const product = products.find(p => String(p.id) === String(id));
        if (!product) return res.status(404).json({ error: "商品が見つかりません" });

        // 1. 署名と権限の検証
        const operatorPrivateKey = new PrivateKey(utils.hexToUint8(accounts.A.key));
        const operatorKeyPair = new KeyPair(operatorPrivateKey);
        const OPERATOR_ADDRESS = facade.network.publicKeyToAddress(operatorKeyPair.publicKey).toString();

        let isAuthorized = (address === product.sellerAddress || address === OPERATOR_ADDRESS);

        if (!isAuthorized) {
            if (!address || !publicKey || !signature || !timestamp) {
                return res.status(403).json({ error: "認証情報が不足しています。署名付きリクエストが必要です。" });
            }

            // 署名の有効期限チェック (5分以内)
            if (Math.abs(Date.now() - parseInt(timestamp)) > 5 * 60 * 1000) {
                return res.status(403).json({ error: "署名の期限が切れています。もう一度お試しください。" });
            }

            // 署名の検証
            try {
                const message = `DownloadAsset:${id}:${timestamp}`;
                const isValidSignature = facade.verify(
                    new PublicKey(utils.hexToUint8(publicKey)),
                    new TextEncoder().encode(message),
                    new Signature(utils.hexToUint8(signature))
                );

                if (!isValidSignature) {
                    return res.status(403).json({ error: "署名検証に失敗しました。" });
                }

                // 公開鍵から導出されたアドレスが一致するか確認
                const derivedAddress = facade.network.publicKeyToAddress(new PublicKey(utils.hexToUint8(publicKey))).toString();
                if (derivedAddress !== address) {
                    return res.status(403).json({ error: "アドレスと公開鍵が一致しません。" });
                }

                // 購入履歴をオンチェーンで確認
                isAuthorized = await verifyPurchaseOnChain(address, product.sellerAddress, product.price, product.title);
            } catch (err) {
                console.error("Signature verify error:", err);
                return res.status(403).json({ error: "認証プロセス中にエラーが発生しました。" });
            }
        }

        if (!isAuthorized) {
            return res.status(403).json({ error: "ダウンロード権限がありません。商品を購入してください。" });
        }

        // 2. ファイルの送信
        const secretStr = product.secret.replace('URL: ', '');
        console.log(`[DEBUG] Delivering content: ${secretStr}`);

        if (secretStr.includes('/uploads/')) {
            const fileName = secretStr.split('/uploads/').pop();
            const filePath = path.join(uploadDir, fileName);
            if (fs.existsSync(filePath)) {
                return res.download(filePath, product.fileName || fileName);
            }
        }
        
        if (secretStr.startsWith('http')) {
            return res.redirect(secretStr);
        }
        
        res.status(404).json({ error: "ファイルがサーバー上に見つかりません" });
    } catch (error) {
        console.error("Download Error:", error);
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

app.post('/api/products', upload.single('file'), async (req, res) => {
    try {
        console.log(`[POST] /api/products started. Body:`, JSON.stringify(req.body));
        const { title, price, seller, sellerAddress, sellerPublicKey, description, imageUrl, saleType, mosaicId } = req.body;
        const file = req.file;
        
        if (!file) {
            console.error("[400] Registration failed: req.file is undefined. Check multipart/form-data config.");
            return res.status(400).json({ error: "ファイルがありません。商品には必ずデジタルファイルの添付が必要です。" });
        }

        console.log(`[INFO] Received file: ${file.originalname}, Size: ${file.size}, Path: ${file.path}`);

        // IPFS にアップロードを試みる
        let ipfsUrl = null;
        try {
            ipfsUrl = await uploadToPinata(file.path, file.originalname);
        } catch (pinataErr) {
            console.error(`[ERROR] uploadToPinata failed:`, pinataErr);
        }
        
        if (ipfsUrl) {
            console.log(`[SUCCESS] IPFS Upload: ${ipfsUrl}`);
        } else {
            console.log(`[INFO] IPFS Upload skipped or failed, falling back to local storage.`);
        }

        const protocol = req.protocol;
        const host = req.get('host');
        const productId = Date.now();
        
        // ローカル保存の場合、直接ファイルを指すのではなくダウンロードエンドポイントをシークレットとする
        const secretUrl = ipfsUrl || `${protocol}://${host}/api/products/${productId}/download`;

        console.log(`[DEBUG - /api/products] Final secretUrl: ${secretUrl}, using IPFS: ${!!ipfsUrl}`);

        const products = await getProducts();
        const newProduct = {
            id: productId,
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
app.patch('/api/products/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const { title, price, description, imageUrl, requesterAddress, saleType, mosaicId } = req.body;
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
        if (imageUrl) product.imageUrl = imageUrl;
        if (saleType) product.saleType = saleType;
        if (mosaicId) product.mosaicId = mosaicId;

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
