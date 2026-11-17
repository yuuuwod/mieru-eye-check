# 共同開発ガイド

## 開発を始める

1. リポジトリをcloneし、`mobile/`で `npm ci` を実行します。
2. `mobile/.env.example` を `mobile/.env.local` にコピーし、FirebaseとPython APIの開発用設定値を入れます。
3. 起動・認証設定は [`mobile/README.md`](./mobile/README.md)、深度APIは [`depth_service/README.md`](./depth_service/README.md) を確認します。

カメラ検出などのネイティブ機能にはiOSまたはAndroidの開発ビルドが必要です。シミュレータではカメラ入力を試せないため、カメラ校正・距離推定は実機で確認してください。

## Pull Request

- 変更内容と実機確認の有無をPRに記載します。
- モバイルアプリの変更では `cd mobile && npx expo lint && npx tsc --noEmit` を実行します。
- `.env.local`、認証情報、個人情報を含む画像、モデルチェックポイント、仮想環境、生成済み `ios/`・`android/` はコミットしません。
- 視力の表示は医療診断として扱わず、コンタクトレンズの処方や製品推薦につなげないでください。
