# Vercel デプロイガイド

このプロジェクトを Vercel にデプロイするための設定を行いました。以下の点に注意してください。

## 1. 永続ストレージの制限（重要）
Vercel は **Serverless Functions** で動作するため、以下の制限があります。
- **data.json**: ファイルへの書き込みは一時的であり、関数が再起動するたびに Git にコミットされている初期状態に戻ります。
- **uploads/**: 同様に、サーバーにアップロードされたファイルは永続化されません。

### 解決策
- **データベース**: 商品情報を永続化するには、[MongoDB Atlas](https://www.mongodb.com/cloud/atlas) や [Supabase](https://supabase.com/) などの外部データベースの使用を検討してください。
- **ファイルストレージ**: 現在 `server.js` に実装されている **Pinata (IPFS)** を有効にすることで、ファイルを分散ストレージに永続化できます。

## 2. 環境変数の設定
Vercel のダッシュボード（Settings > Environment Variables）で以下の変数を設定してください。

| 変数名 | 説明 |
| :--- | :--- |
| `OPERATOR_KEY` | 運営アカウントの秘密鍵（アグリゲートの起案用） |
| `PINATA_API_KEY` | Pinata API Key (IPFSアップロード用) |
| `PINATA_SECRET_API_KEY` | Pinata Secret API Key |
| `PINATA_JWT` | Pinata JWT (オプション) |

## 3. デプロイ手順
1. このリポジトリを GitHub にプッシュします。
2. Vercel で「New Project」を作成し、GitHub リポジトリを選択します。
3. 上記の環境変数を設定して「Deploy」をクリックします。
