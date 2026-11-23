# みえる？

iOS / Android 向けの Expo アプリです。

## 開発

```sh
npx expo start --dev-client
```

カメラ検出にはネイティブモジュールを使うため、Expo Go ではなく開発ビルドが必要です。

```sh
npx expo prebuild
npx expo run:ios
npx expo run:android
```

または EAS Build の development profile を使います。

```sh
npx eas-cli build --profile development --platform all
```

## iOSプロジェクトをXcodeで開く

`ios/` はGitで共有しています。クローン後、Node.jsとXcodeを用意して次を実行します。

```sh
cd mobile
npm ci
cp .env.example .env.local
# .env.local にFirebaseとPython APIの設定値を記入
npx pod-install
open ios/app.xcworkspace
```

Xcodeで `app` scheme と実行先を選んで起動します。実機へインストールする場合は、各開発者のXcodeでApple AccountとSigning Teamを設定してください。`Pods/`、ビルド成果物、Xcodeのユーザー別設定はGitに含めず、`Podfile.lock`で依存バージョンを共有します。Expoの設定やネイティブ依存を変更したときは、`npx expo prebuild --platform ios` で `ios/` を更新し、その差分をコミットしてください。

## カメラ校正

開始すると前面カメラが起動し、顔を安定して検出した時点で校正用静止画をPython APIへ送り、自動で校正します。校正時はスマホを顔から約40cmに持ちます。カメラID別の補正値は端末内に保存します。距離確認中は約1.8秒ごとに低解像度画像をAPIへ送って深度を推定します。API実装は受信画像をメモリ上で処理し、ファイルには保存しません。

Python APIの起動方法と接続設定は [`../depth_service/README.md`](../depth_service/README.md) を参照してください。アプリを使う間はAPIへの接続が必要です。ストア配布時はHTTPSのAPI URLをEASの環境変数 `EXPO_PUBLIC_DEPTH_API_URL` に設定します。

## メールアドレス登録とログイン

認証にはFirebase Authenticationを使います。パスワードをアプリやPython深度APIへ保存せず、Firebaseへ送って認証します。認証状態はAsyncStorage連携で端末に保持するため、通常はアプリを開くたびにログインし直す必要はありません。ログアウト、アプリデータ削除、端末変更時は再ログインが必要です。登録後はメール確認を終えるまで検査画面を使えません。

1. [Firebase Console](https://console.firebase.google.com/) でプロジェクトを作成し、Authenticationの「メール/パスワード」プロバイダを有効にします。
2. Authenticationのパスワードポリシーを「要件を適用」にして、12文字以上、英大文字・英小文字・数字・記号を必須にします。アプリ側でも同じ要件をチェックします。
3. Authenticationのユーザー操作設定でメール列挙保護（Email enumeration protection）を有効にします。
4. プロジェクト設定からアプリのFirebase設定値を取得し、`.env.example` を参考に `mobile/.env.local` へ `EXPO_PUBLIC_FIREBASE_API_KEY`、`EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN`、`EXPO_PUBLIC_FIREBASE_PROJECT_ID`、`EXPO_PUBLIC_FIREBASE_APP_ID` を追加します。`.env.local` はGitに登録しないでください。既存の `EXPO_PUBLIC_DEPTH_API_URL` も残します。
5. 設定後、Metroを再起動して開発ビルドを作り直します。配布ビルドでは同じ値をEASの環境変数に登録してください。

Firebaseのクライアント設定値はアプリに含まれる公開識別子です。サービスアカウントの秘密鍵や管理者認証情報はアプリへ入れないでください。Firebaseプロジェクトの設定がまだない場合、アプリは設定案内を表示し、登録画面へは進みません。

## 視力の表示段階

ランドルト環を0.1刻みの0.1〜2.0で確認します。各段階は3問中2問正解で通過とし、通過した最高段階を表示します。刻みを細かくしたため、最後まで見分けられる場合は片目あたり最大60問になります。画面サイズ・表示倍率・照明・距離推定に左右される簡易スクリーニングで、眼科の視力検査や処方値ではありません。

将来のコンタクトレンズ案内では、この結果だけからレンズの種類や度数を推薦しないでください。コンタクトレンズは眼科で目の状態、レンズのカーブや装用状態を確認して選ぶ必要があります。

10円玉を使う画面校正はありません。視標の表示サイズは標準値を使うため、端末ごとの実寸校正を行う専用検査と比べて結果は目安です。ストア提出前にはカメラ校正と250cm判定を実機で確認してください。

## ストア提出前

- `app.json` の bundle identifier / package name を、配布者のストアアカウントに登録できる値へ確認してください。
- 実機でiOS・Androidのカメラ権限、カメラごとの校正、250cm検出を確認してください。
- ストア用のアイコン、スクリーンショット、プライバシーポリシーを用意してください。
- [`PRIVACY.md`](./PRIVACY.md) は公開前の確認用ドラフトです。運営者と実際のホスティング条件を追記して公開してください。
- Apple Developer / Google Play Console のアカウントを設定し、EAS Build / Submit に接続してください。
