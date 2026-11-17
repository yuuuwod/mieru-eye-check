import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  reload,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut,
  type User,
} from 'firebase/auth';
import { auth, firebaseConfigured } from '../lib/firebase';

type Mode = 'login' | 'register' | 'verify' | 'reset';

const passwordRequirements = [
  { label: '12文字以上', test: (value: string) => value.length >= 12 },
  { label: '英大文字を含む', test: (value: string) => /[A-Z]/.test(value) },
  { label: '英小文字を含む', test: (value: string) => /[a-z]/.test(value) },
  { label: '数字を含む', test: (value: string) => /\d/.test(value) },
  { label: '記号を含む', test: (value: string) => /[^A-Za-z0-9]/.test(value) },
];

function friendlyError(error: unknown) {
  const code = (error as { code?: string })?.code;
  if (code === 'auth/weak-password' || code === 'auth/password-does-not-meet-requirements') return 'パスワードが要件を満たしていません。';
  if (code === 'auth/invalid-email') return 'メールアドレスの形式を確認してください。';
  if (code === 'auth/too-many-requests') return '試行回数が多いため、しばらく待ってからお試しください。';
  if (code === 'auth/network-request-failed') return '通信できません。ネットワークを確認してください。';
  return '処理できませんでした。入力内容と通信を確認して、もう一度お試しください。';
}

export default function AuthGate({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(Boolean(auth));
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [, setVerificationCheck] = useState(0);

  useEffect(() => {
    if (!auth) return;
    return onAuthStateChanged(auth, (nextUser) => {
      setUser(nextUser);
      setMode(nextUser && !nextUser.emailVerified ? 'verify' : 'login');
      setLoading(false);
    });
  }, []);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await action();
    } catch (caught) {
      setError(friendlyError(caught));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <View style={styles.loading}><ActivityIndicator color="#71954c" /><Text style={styles.loadingText}>アカウントを確認しています</Text></View>;
  if (user?.emailVerified) return <>{children}</>;

  const passwordValid = passwordRequirements.every(({ test }) => test(password)) && password.length <= 128;

  async function register() {
    const instance = auth;
    if (!instance) return;
    if (!passwordValid) {
      setError('すべてのパスワード要件を満たしてください。');
      return;
    }
    await run(async () => {
      const credential = await createUserWithEmailAndPassword(instance, email.trim(), password);
      await sendEmailVerification(credential.user);
      setUser(credential.user);
      setMode('verify');
      setMessage('確認メールを送信しました。メール内のリンクを開いてください。');
      setPassword('');
    });
  }

  async function login() {
    const instance = auth;
    if (!instance) return;
    await run(async () => {
      const credential = await signInWithEmailAndPassword(instance, email.trim(), password);
      await reload(credential.user);
      setUser(credential.user);
      if (!credential.user.emailVerified) {
        setMode('verify');
        setMessage('検査を始める前に、メールアドレスを確認してください。');
      }
      setPassword('');
    });
  }

  async function refreshVerification() {
    const instance = auth;
    if (!instance?.currentUser) return;
    await run(async () => {
      await reload(instance.currentUser!);
      setVerificationCheck((check) => check + 1);
      if (instance.currentUser?.emailVerified) setMessage('メールアドレスを確認しました。');
      else setMessage('まだ確認できていません。メールのリンクを開いてから再確認してください。');
    });
  }

  async function resendVerification() {
    const instance = auth;
    if (!instance?.currentUser) return;
    await run(async () => {
      await sendEmailVerification(instance.currentUser!);
      setMessage('確認メールを再送信しました。');
    });
  }

  async function resetPassword() {
    const instance = auth;
    if (!instance) return;
    await run(async () => {
      await sendPasswordResetEmail(instance, email.trim());
      setMessage('該当するアカウントがある場合、パスワード再設定メールを送信しました。');
    });
  }

  if (!firebaseConfigured) {
    return <View style={styles.container}><Text style={styles.eyebrow}>アカウント設定</Text><Text style={styles.title}>Firebaseの設定が必要です</Text><Text style={styles.body}>アプリの登録・ログインを有効にするには、Firebaseプロジェクトを作成し、mobile/.env.local に設定値を追加してください。手順は mobile/README.md にあります。</Text><Text style={styles.notice}>設定が完了すると、メール確認とログイン状態の保存が使えます。</Text></View>;
  }

  const verificationMode = mode === 'verify' && user;
  const heading = verificationMode ? 'メールを確認してください' : mode === 'register' ? 'アカウントを作成' : mode === 'reset' ? 'パスワード再設定' : 'ログイン';

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Text style={styles.eyebrow}>みえる？ · アカウント</Text>
      <Text style={styles.title}>{heading}</Text>
      {verificationMode ? (
        <>
          <Text style={styles.body}>{user.email} 宛ての確認メールを開き、リンクを押してください。確認後、この画面に戻ってください。</Text>
          <ActionButton label="確認状態を更新" onPress={refreshVerification} disabled={busy} />
          <LinkButton label="確認メールを再送信" onPress={resendVerification} disabled={busy} />
          <LinkButton label="別のアカウントでログイン" onPress={() => { void signOut(auth!); setMode('login'); setUser(null); setMessage(''); }} disabled={busy} />
        </>
      ) : (
        <>
          <Text style={styles.body}>{mode === 'register' ? 'メールアドレスと強いパスワードを登録します。' : mode === 'reset' ? '登録したメールアドレスに再設定リンクを送ります。' : 'ログイン状態は端末に保持され、次回から自動で復元されます。'}</Text>
          <TextInput value={email} onChangeText={setEmail} placeholder="メールアドレス" placeholderTextColor="#8b968e" keyboardType="email-address" autoCapitalize="none" autoComplete="email" textContentType="emailAddress" style={styles.input} editable={!busy} />
          {mode !== 'reset' && <TextInput value={password} onChangeText={setPassword} placeholder="パスワード" placeholderTextColor="#8b968e" secureTextEntry autoCapitalize="none" autoComplete={mode === 'register' ? 'new-password' : 'current-password'} textContentType={mode === 'register' ? 'newPassword' : 'password'} style={styles.input} editable={!busy} maxLength={128} />}
          {mode === 'register' && <View style={styles.requirements}>{passwordRequirements.map(({ label, test }) => <Text key={label} style={[styles.requirement, test(password) && styles.requirementMet]}>{test(password) ? '✓' : '○'} {label}</Text>)}</View>}
          <ActionButton label={mode === 'register' ? '登録して確認メールを送る' : mode === 'reset' ? '再設定メールを送る' : 'ログイン'} onPress={mode === 'register' ? register : mode === 'reset' ? resetPassword : login} disabled={busy || !email.trim() || (mode === 'register' && !passwordValid) || (mode === 'login' && !password)} />
          {busy && <ActivityIndicator color="#71954c" style={styles.spinner} />}
          {mode === 'login' && <LinkButton label="パスワードを忘れた場合" onPress={() => { setMode('reset'); setError(''); setMessage(''); }} disabled={busy} />}
          <LinkButton label={mode === 'register' ? 'ログインに戻る' : mode === 'reset' ? 'ログインに戻る' : '新規アカウントを作成'} onPress={() => { setMode(mode === 'register' || mode === 'reset' ? 'login' : 'register'); setError(''); setMessage(''); }} disabled={busy} />
        </>
      )}
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      {message ? <Text accessibilityRole="status" style={styles.message}>{message}</Text> : null}
      <Text style={styles.notice}>パスワードは認証サービスで検証されます。アプリは入力したパスワードを保存しません。</Text>
    </KeyboardAvoidingView>
  );
}

function ActionButton({ label, onPress, disabled }: { label: string; onPress: () => void; disabled: boolean }) {
  return <Pressable onPress={onPress} disabled={disabled} style={[styles.button, disabled && styles.disabled]}><Text style={styles.buttonText}>{label}</Text></Pressable>;
}

function LinkButton({ label, onPress, disabled }: { label: string; onPress: () => void; disabled: boolean }) {
  return <Pressable onPress={onPress} disabled={disabled} style={styles.link}><Text style={styles.linkText}>{label}</Text></Pressable>;
}

const styles = StyleSheet.create({
  loading: { flex: 1, minHeight: 500, alignItems: 'center', justifyContent: 'center', backgroundColor: '#f4f5f1' },
  loadingText: { marginTop: 10, color: '#75817c', fontSize: 12 },
  container: { flex: 1, minHeight: '100%', backgroundColor: '#f4f5f1', justifyContent: 'center', paddingHorizontal: 26, paddingVertical: 38 },
  eyebrow: { color: '#607064', fontSize: 11, fontWeight: '700', letterSpacing: 1.2, marginBottom: 12 },
  title: { color: '#182321', fontSize: 30, lineHeight: 39, fontWeight: '800', marginBottom: 10 },
  body: { color: '#727d78', fontSize: 13, lineHeight: 21, marginBottom: 20 },
  input: { minHeight: 52, borderWidth: 1, borderColor: '#dfe5dc', borderRadius: 11, paddingHorizontal: 14, marginBottom: 11, backgroundColor: '#fff', color: '#182321', fontSize: 14 },
  requirements: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginVertical: 3, marginBottom: 15 },
  requirement: { color: '#8b968e', backgroundColor: '#e9ede6', borderRadius: 12, paddingVertical: 5, paddingHorizontal: 8, fontSize: 10 },
  requirementMet: { color: '#345b2c', backgroundColor: '#dff1c7' },
  button: { minHeight: 52, backgroundColor: '#b8f06a', borderRadius: 11, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  disabled: { opacity: 0.55 },
  buttonText: { color: '#193023', fontSize: 13, fontWeight: '800' },
  link: { alignSelf: 'center', paddingHorizontal: 12, paddingVertical: 11 },
  linkText: { color: '#64736a', fontSize: 11 },
  error: { color: '#bd4e3f', textAlign: 'center', fontSize: 11, lineHeight: 17, marginTop: 12 },
  message: { color: '#456b39', textAlign: 'center', fontSize: 11, lineHeight: 17, marginTop: 12 },
  notice: { color: '#9aa39d', fontSize: 9, lineHeight: 15, textAlign: 'center', marginTop: 18 },
  spinner: { marginTop: 10 },
});
