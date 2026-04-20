const express = require('express');
const fs = require('fs');
const path = require('path');
const { PrivateKey } = require('symbol-sdk');
const { SymbolFacade, KeyPair, MessageEncoder } = require('symbol-sdk/symbol');
const multer = require('multer');

const app = express();
const port = 3000;

const upload = multer({ dest: 'uploads/' });
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));
app.use(express.json());

const DB_FILE = path.join(__dirname, 'data.json');

if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ products: [] }, null, 2));
}
if (!fs.existsSync('uploads')) {
    fs.mkdirSync('uploads');
}

const facade = new SymbolFacade('testnet');
// 安定して V3 を受け入れるノードを使用
const NODE_URL = 'https://sym-test-01.opening-line.jp:3001'; 

// 秘密鍵をサーバーで保持しない (SSS連携へ移行するため削除)
const accounts = {
    // 運営アカウントはトランザクションの手数料支払い（アグリゲートの起案）のみ行う
    A: { name: "運営", key: 'CED3DD0A92ECC31FA33C32BF46356255145D9FA93FEE1FB9E11A10CDF39F44BC' }
};

let CURRENCY_ID = '72C0212E67A08BCE'; 

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
            const errorData = await response.text();
            console.error("Node Error:", errorData);
            res.json({ success: false, error: "トランザクション送信失敗", details: errorData });
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/products', (req, res) => {
    try {
        const data = JSON.parse(fs.readFileSync(DB_FILE));
        res.json(data.products);
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
        networkType: 'testnet'
    });
});

app.post('/api/products', upload.single('file'), (req, res) => {
    try {
        const { title, price, seller } = req.body;
        const file = req.file;
        if (!file) return res.status(400).json({ error: "ファイルがありません" });

        const data = JSON.parse(fs.readFileSync(DB_FILE));
        const newProduct = {
            id: Date.now(),
            title,
            price: parseInt(price),
            seller,
            fileName: file.originalname,
            secret: `URL: http://localhost:3000/uploads/${file.filename}`
        };
        data.products.push(newProduct);
        fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
        res.json({ success: true, product: newProduct });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: error.message });
    }
});


app.listen(port, () => {
    console.log(`サーバーが正常に起動しました: http://localhost:${port}`);
});
