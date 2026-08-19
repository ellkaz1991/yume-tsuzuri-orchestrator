# 夢綴り Cloudflare Orchestrator

夢綴りの小説・挿絵生成を、PWAを閉じたあともCloudflare Workflows上で継続するためのWorkerです。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ellkaz1991/yume-tsuzuri-cloudflare-orchestrator)

## ブラウザだけで接続する

1. 上の **Deploy to Cloudflare** を押します。
2. Cloudflareへログインします。Googleログインを選んでも構いません。
3. 画面に従ってWorkerを配備し、完成した `workers.dev` のURLを開きます。
4. 夢綴りの「設定 → バックグラウンド生成」で接続コードを発行します。
5. Workerの画面に接続コードを貼り、「夢綴りと接続」を押します。

Cloudflare APIトークン、アカウントID、Windows PC、コマンド操作は不要です。接続専用の秘密鍵はWorker内で生成され、SQLite-backed Durable Objectに保存されます。ソースコードやGitHubリポジトリには秘密情報を含みません。

## 構成

- Cloudflare Worker: 接続画面と認証済みジョブAPI
- Cloudflare Workflows: 長時間の生成処理を耐久実行
- Durable Object: 夢綴りとの接続専用秘密鍵を強整合で保存

## ローカル確認

```sh
npm ci
npm run check
npm run deploy
```

配備時にCloudflareがWorkflowとDurable Objectを作成します。
