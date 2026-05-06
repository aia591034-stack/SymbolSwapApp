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

// --- ネットワーク・通貨設定 ---
const CURRENCY_ID = '51138C86FBF19505'; // Nexus Credit (NXC)
const PIONEER_MOSAIC_ID = '4E3FD79DC36A6474'; // Nexus Pioneer (NXP)
const NODE_URL = process.env.NODE_URL || 'https://testnet.symbol.services:3001'; 

const accounts = {
    A: { name: "運営", key: process.env.OPERATOR_KEY || 'CED3DD0A92ECC31FA33C32BF46356255145D9FA93FEE1FB9E11A10CDF39F44BC' }
};

// 16進数文字列を安全に BigInt に変換するヘルパー
const toBigInt = (val) => {
    if (typeof val === 'bigint') return val;
    if (typeof val === 'number') return BigInt(Math.floor(val));
    const cleanHex = String(val).startsWith('0x') ? val : '0x' + val;
    return BigInt(cleanHex);
};

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
            type: 'aggregate_complete_transaction_v1',
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
    // ... (既存のコード)
});

// 売上を記録し、一定条件で Pioneer に昇格させるエンドポイント
app.post('/api/record_sale', async (req, res) => {
    try {
        const { hash, productId, sellerAddress } = req.body;
        if (!hash || !sellerAddress) return res.status(400).json({ error: "パラメータが不足しています" });

        // 重複記録の防止
        const saleRecordKey = `sale_recorded_${hash}`;
        if (await kv.get(saleRecordKey)) return res.json({ success: true, message: "記録済みです" });

        // トランザクションの検証（簡易版：ノードに問い合わせて確認済みかチェック）
        const nodeRes = await fetch(`${NODE_URL}/transactionStatus/${hash}`);
        const status = await nodeRes.json();
        if (status.group !== 'confirmed') {
            return res.status(400).json({ error: "トランザクションがまだ承認されていません" });
        }

        // 商品情報の取得（価格計算のため）
        const products = await getProducts();
        const p = products.find(item => item.id.toString() === productId.toString());
        if (!p) return res.status(404).json({ error: "商品が見つかりません" });

        // 実績の加算
        const countKey = `user_sales_count_${sellerAddress}`;
        const amountKey = `user_sales_amount_${sellerAddress}`;
        
        const newCount = (Number(await kv.get(countKey)) || 0) + 1;
        const newAmount = (Number(await kv.get(amountKey)) || 0) + p.price;

        await kv.set(countKey, newCount);
        await kv.set(amountKey, newAmount);
        await kv.set(saleRecordKey, true);

        console.log(`[ACHIEVEMENT] Seller ${sellerAddress}: Count=${newCount}, Amount=${newAmount}`);

        // Pioneer 昇格チェック (30回販売 または 50,000 NXC)
        const meritPioneerKey = `pioneer_merit_${sellerAddress}`;
        const welcomePioneerKey = `bonus_claimed_${sellerAddress}`; // Welcomeボーナスで既に持ってるか
        
        const alreadyPioneer = await kv.get(meritPioneerKey) || await kv.get(welcomePioneerKey);
        
        let promoted = false;
        if (!alreadyPioneer && (newCount >= 30 || newAmount >= 50000)) {
            console.log(`[PROMOTION] Promoting ${sellerAddress} to Pioneer by Merit!`);
            
            // バッジ送金トランザクションの実行
            const operatorPrivateKey = new PrivateKey(utils.hexToUint8(accounts.A.key));
            const operatorKeyPair = new KeyPair(operatorPrivateKey);
            const symbolTime = BigInt(Date.now() - 1667250467 * 1000 + 7200000);

            const descriptor = {
                type: 'transfer_transaction_v1',
                signerPublicKey: operatorKeyPair.publicKey,
                fee: 100000n,
                deadline: symbolTime,
                recipientAddress: sellerAddress,
                mosaics: [{ mosaicId: toBigInt(PIONEER_MOSAIC_ID), amount: 1n }],
                message: new Uint8Array([0, ...Buffer.from('Merit Achievement: Nexus Pioneer Promotion!')])
            };

            const tx = facade.transactionFactory.create(descriptor);
            const sig = facade.signTransaction(operatorKeyPair, tx);
            tx.signature = new models.Signature(sig.bytes);

            await fetch(`${NODE_URL}/transactions`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ payload: utils.uint8ToHex(tx.serialize()) })
            });

            await kv.set(meritPioneerKey, true);
            promoted = true;
        }

        res.json({ 
            success: true, 
            count: newCount, 
            amount: newAmount, 
            promoted: promoted 
        });

    } catch (error) {
        console.error("Record Sale Error:", error);
        res.status(500).json({ error: error.message });
    }
});

// 秘密鍵からアドレスを導出するエンドポイント (スマホ用)
app.post('/api/derive_address', async (req, res) => {
    try {
        const { privateKey } = req.body;
        if (!privateKey) return res.status(400).json({ error: "秘密鍵が必要です" });
        
        const userPrivateKey = new PrivateKey(utils.hexToUint8(privateKey));
        const userKeyPair = new KeyPair(userPrivateKey);
        const address = facade.network.publicKeyToAddress(userKeyPair.publicKey).toString();
        
        res.json({ address, publicKey: utils.uint8ToHex(userKeyPair.publicKey.bytes) });
    } catch (error) {
        res.status(400).json({ error: "不正な秘密鍵です" });
    }
});

// 秘密鍵を直接使用してスワップを実行するエンドポイント (スマホ用)
app.post('/api/purchase_direct', async (req, res) => {
    try {
        console.log(`[DIRECT] Purchase request received. ProductId: ${req.body.productId}`);
        const { privateKey, productId } = req.body;
        if (!privateKey || !productId) return res.status(400).json({ error: "パラメータが不足しています" });

        const products = await getProducts();
        const p = products.find(item => item.id.toString() === productId.toString());
        if (!p) return res.status(404).json({ error: "商品が見つかりません" });

        // 秘密を抽出
        const secret = p.secret.replace('URL: ', '');

        // ユーザー（購入者）のキーペア作成
        const buyerPrivateKey = new PrivateKey(utils.hexToUint8(privateKey));
        const buyerKeyPair = new KeyPair(buyerPrivateKey);
        const buyerAddress = facade.network.publicKeyToAddress(buyerKeyPair.publicKey);

        console.log(`[DIRECT] Buyer derived: ${buyerAddress.toString()}`);

        // 運営（手数料支払者）のキーペア作成
        const operatorPrivateKey = new PrivateKey(utils.hexToUint8(accounts.A.key));
        const operatorKeyPair = new KeyPair(operatorPrivateKey);

        const epochAdjustment = 1667250467;
        const deadline = BigInt(Date.now() - epochAdjustment * 1000 + 7200000);

        // トランザクション1: 支払い
        const txPayment = facade.transactionFactory.createEmbedded({
            type: 'transfer_transaction_v1',
            signerPublicKey: buyerKeyPair.publicKey,
            recipientAddress: p.sellerAddress,
            mosaics: [{ mosaicId: toBigInt(CURRENCY_ID), amount: BigInt(p.price) * 1000000n }],
            message: new Uint8Array([0, ...Buffer.from('Nexus Swap: ' + p.title)])
        });

        // トランザクション2: 秘密の鍵渡し
        const txData = facade.transactionFactory.createEmbedded({
            type: 'transfer_transaction_v1',
            signerPublicKey: operatorKeyPair.publicKey,
            recipientAddress: buyerAddress.toString(),
            mosaics: [],
            message: new Uint8Array([0, ...Buffer.from(secret)])
        });

        console.log(`[DIRECT] Embedded transactions created.`);

        // アグリゲートトランザクションの作成
        const transactions = [txPayment, txData];
        const transactionsHash = facade.constructor.hashEmbeddedTransactions(transactions);

        const aggregateTx = facade.transactionFactory.create({
            type: 'aggregate_complete_transaction_v1', // 互換性重視のV1
            signerPublicKey: operatorKeyPair.publicKey,
            deadline: deadline,
            fee: 500000n,
            transactionsHash: transactionsHash,
            transactions: transactions
        });

        // 1. 主署名 (運営)
        const sigOperator = facade.signTransaction(operatorKeyPair, aggregateTx);
        aggregateTx.signature = new models.Signature(sigOperator.bytes);
        
        // 2. 連署 (購入者)
        const cosignature = facade.cosignTransaction(buyerKeyPair, aggregateTx);
        const cosig = new models.Cosignature();
        cosig.version = 0n;
        cosig.signerPublicKey = new models.PublicKey(buyerKeyPair.publicKey.bytes);
        cosig.signature = new models.Signature(cosignature.signature.bytes);
        aggregateTx.cosignatures.push(cosig);

        const payload = utils.uint8ToHex(aggregateTx.serialize());
        const hash = facade.hashTransaction(aggregateTx).toString();

        console.log(`[DIRECT] Transaction built. Hash: ${hash}`);

        const response = await fetch(`${NODE_URL}/transactions`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ payload })
        });

        if (response.ok) {
            console.log(`[DIRECT] Success: ${hash}`);
            res.json({ success: true, hash });
        } else {
            const errText = await response.text();
            console.error(`[DIRECT] Node Error:`, errText);
            res.status(500).json({ error: "トランザクション送信失敗", details: errText });
        }
    } catch (error) {
        console.error("[DIRECT] Critical Error:", error);
        res.status(500).json({ error: error.message });
    }
});

// 各ユーザーの販売実績を取得するエンドポイント
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

// プランA: 新規ユーザーへの初回ボーナス配布エンドポイント
app.post('/api/claim_bonus', async (req, res) => {
    try {
        const { address } = req.body;
        if (!address) return res.status(400).json({ error: "アドレスがありません" });

        // すでに配布済みかチェック
        const bonusKey = `bonus_claimed_${address}`;
        const alreadyClaimed = await kv.get(bonusKey);
        
        if (alreadyClaimed) {
            return res.status(400).json({ error: "ボーナスは既に配布済みです" });
        }

        // 先着30名のカウントチェック
        const countKey = 'pioneer_claim_count';
        const currentCount = (await kv.get(countKey)) || 0;
        const isPioneerEligible = currentCount < 30;

        console.log(`[BONUS] Processing bonus for ${address}. Pioneer status: ${isPioneerEligible} (${currentCount}/30)`);

        const operatorPrivateKey = new PrivateKey(utils.hexToUint8(accounts.A.key));
        const operatorKeyPair = new KeyPair(operatorPrivateKey);
        
        const networkType = facade.network.identifier;
        const epochAdjustment = 1667250467;
        const symbolTime = BigInt(Date.now() - epochAdjustment * 1000 + 7200000);
        const deadline = symbolTime;

        // 500 NXC (Divisibility 6)
        const amountNXC = 500n * 1000000n;
        const mosaics = [{ mosaicId: toBigInt(CURRENCY_ID), amount: amountNXC }];
        
        // 100名以内ならバッジを追加
        if (isPioneerEligible) {
            mosaics.push({ mosaicId: toBigInt(PIONEER_MOSAIC_ID), amount: 1n });
        }

        const descriptor = {
            type: 'transfer_transaction_v1',
            signerPublicKey: operatorKeyPair.publicKey,
            fee: 200000n,
            deadline: deadline,
            recipientAddress: address,
            mosaics: mosaics,
            message: new Uint8Array([0, ...Buffer.from(isPioneerEligible ? 'Nexus Welcome! 500 NXC + Pioneer Badge' : 'Nexus Welcome! 500 NXC')])
        };

        const tx = facade.transactionFactory.create(descriptor);
        const sig = facade.signTransaction(operatorKeyPair, tx);
        tx.signature = new models.Signature(sig.bytes);

        const payload = utils.uint8ToHex(tx.serialize());

        const response = await fetch(`${NODE_URL}/transactions`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ payload })
        });

        if (response.ok) {
            // 配布済みフラグを保存
            await kv.set(bonusKey, true);
            // カウントをインクリメント（バッジを配った場合のみ）
            if (isPioneerEligible) {
                await kv.set(countKey, currentCount + 1);
            }
            res.json({ 
                success: true, 
                isPioneer: isPioneerEligible,
                message: isPioneerEligible ? "500 NXC と Pioneerバッジを配布しました！" : "500 NXC を配布しました！" 
            });
        } else {
            const errorData = await response.json();
            res.status(500).json({ error: "配布に失敗しました", details: errorData });
        }
    } catch (error) {
        console.error("Bonus Error:", error);
        res.status(500).json({ error: error.message });
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
            res.redirect(secretStr);
        } else {
            // Pinata URLではない場合、ファイルが見つからないというエラーを返す
            console.log(`[WARN] Non-IPFS URL or local path attempted for download: ${secretStr}`);
            res.status(404).json({ error: "ファイルがサーバー上に見つかりません" });
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
