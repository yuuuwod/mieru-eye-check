# みえる？

iOS / Android 向けの視力セルフチェックアプリです。ランドルト環の切れ目を8方向から回答し、カメラ画像を使った顔の距離推定とメールアドレス認証を行います。結果は医療診断や眼鏡・コンタクトレンズの処方ではありません。

## プロジェクト構成

- `mobile/` — Expo / React Native アプリ
- `depth_service/` — 顔画像から距離を推定するPython API
- `index.html`, `app.js`, `style.css` — 初期のWeb画面試作
- `Depth-Anything-V2/` — **Gitには含めません。** APIを動かす場合は手順に沿って別途取得し、モデルチェックポイントもダウンロードしてください。

## モバイルアプリを起動する

Node.js、Xcode（iOSの場合）、Android Studio（Androidの場合）が必要です。カメラ検出にネイティブモジュールを使うため、Expo Goではなく開発ビルドを使います。

```sh
cd mobile
cp .env.example .env.local
npm ci
npx expo run:ios
```

`.env.local` にFirebase Authenticationのプロジェクト設定値と、Python APIの `EXPO_PUBLIC_DEPTH_API_URL` を入れてください。設定項目とFirebase Consoleの手順は [`mobile/README.md`](./mobile/README.md) を参照してください。`.env.local` やサービスアカウント秘密鍵はコミットしないでください。

カメラ機能は実機で確認してください。iOSシミュレータにはカメラ入力がありません。

## Python距離推定API

APIの依存関係、Depth Anything V2の取得、モデルチェックポイント、起動方法は [`depth_service/README.md`](./depth_service/README.md) にあります。深度モデルとPython仮想環境はリポジトリに含めていません。

## 開発時の確認

```sh
cd mobile
npx expo lint
npx tsc --noEmit
```

## 医療上の注意

このアプリは表示サイズ、照明、距離推定などの影響を受ける簡易スクリーニングです。眼科の視力検査の代わりにはなりません。コンタクトレンズの種類や度数はこの結果から推薦せず、眼科での検査・処方を受けてください。

共同開発の手順は [`CONTRIBUTING.md`](./CONTRIBUTING.md) を参照してください。
