/* eslint-disable react-hooks/set-state-in-effect -- Native camera frames and permission-backed measurements are external streams. */
import { useFaceDetector } from '@noma4i/vision-camera-face-detector';
import { useCameraDevices, useCameraPermission, Camera } from 'react-native-vision-camera';
import Svg, { Circle, Rect } from 'react-native-svg';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { signOut } from 'firebase/auth';
import AuthGate from '../components/AuthGate';
import { auth } from '../lib/firebase';
import {
  Pressable,
  PixelRatio,
  Platform,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';

const SCREEN_DENSITY_PPI = Platform.OS === 'ios'
  ? (PixelRatio.get() >= 3 ? 460 : 326)
  : 160 * PixelRatio.get();
const SCREEN_POINTS_PER_MM = SCREEN_DENSITY_PPI / (PixelRatio.get() * 25.4);
const FACE_LOST_GRACE_MS = 2500;
const AVERAGE_FACE_WIDTH_CM = 14;
const FULL_FRAME_PORTRAIT_WIDTH_MM = 24;
const FULL_FRAME_LANDSCAPE_WIDTH_MM = 36;
const DEFAULT_FOCAL_LENGTH_35MM = 24;
const MAX_TEST_DISTANCE_CM = 600;
const MAX_TRIALS_PER_LEVEL = 5;
const REQUIRED_CORRECT_PER_LEVEL = 4;
const LEVELS = Array.from({ length: 20 }, (_, index) => Number(((index + 1) / 10).toFixed(1)));
const DIRECTIONS = ['up', 'up-right', 'right', 'down-right', 'down', 'down-left', 'left', 'up-left'] as const;
const DIRECTION_ANGLES: Record<(typeof DIRECTIONS)[number], number> = {
  right: 0,
  'down-right': 45,
  down: 90,
  'down-left': 135,
  left: 180,
  'up-left': 225,
  up: 270,
  'up-right': 315,
};
const ARROWS: Record<(typeof DIRECTIONS)[number], string> = {
  'up-left': '↖', up: '↑', 'up-right': '↗',
  left: '←', right: '→',
  'down-left': '↙', down: '↓', 'down-right': '↘',
};
type Step = 'home' | 'test' | 'result';

function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function estimateFaceDistanceCm(faceWidthPx: number, previewWidthPx: number, focalLength35mm: number, portrait: boolean) {
  if (!Number.isFinite(faceWidthPx) || faceWidthPx <= 0 || !Number.isFinite(previewWidthPx) || previewWidthPx <= 0) {
    return null;
  }
  const sensorWidth35mm = portrait ? FULL_FRAME_PORTRAIT_WIDTH_MM : FULL_FRAME_LANDSCAPE_WIDTH_MM;
  const focalLengthPx = focalLength35mm * previewWidthPx / sensorWidth35mm;
  const distanceCm = AVERAGE_FACE_WIDTH_CM * focalLengthPx / faceWidthPx;
  return Number.isFinite(distanceCm) && distanceCm > 0 ? distanceCm : null;
}

function shuffledDirections(previous?: string) {
  const deck = [...DIRECTIONS];
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  if (deck[0] === previous) [deck[0], deck[1]] = [deck[1], deck[0]];
  return deck;
}

export default function HomeRoute() {
  const devices = useCameraDevices();
  const permission = useCameraPermission();
  const windowSize = useWindowDimensions();
  const detector = useFaceDetector({ preset: 'accurate', guide: 'none', fps: 10 });
  const [step, setStep] = useState<Step>('home');
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const [faceDetected, setFaceDetected] = useState(false);
  const [distanceCm, setDistanceCm] = useState<number | null>(null);
  const [distanceValid, setDistanceValid] = useState(false);
  const [testEye, setTestEye] = useState<'right' | 'left'>('right');
  const [levelIndex, setLevelIndex] = useState(0);
  const [trialIndex, setTrialIndex] = useState(0);
  const [levelCorrect, setLevelCorrect] = useState(0);
  const [bestAcuity, setBestAcuity] = useState(0);
  const [currentDirection, setCurrentDirection] = useState<(typeof DIRECTIONS)[number]>('up');
  const [testResults, setTestResults] = useState<{ right?: number; left?: number }>({});
  const distanceSamplesRef = useRef<number[]>([]);
  const directionDeck = useRef<(typeof DIRECTIONS)[number][]>([]);
  const previousDirection = useRef<string | undefined>(undefined);

  const selectedCamera = useMemo(
    () => devices.find((device) => device.position === 'front'),
    [devices],
  );
  const nativeFaceDetected = detector.result.faces.length > 0;
  const detectorStatusLabel = detector.status === 'unavailable'
    ? '顔検出機能を利用できません'
    : detector.status === 'idle'
      ? 'カメラ映像を確認中'
      : detector.status === 'misaligned'
        ? '顔を枠の中央に合わせてください'
        : '顔を検出しています';
  const gapAngleRadians = (Math.PI / 180 / 60) / LEVELS[levelIndex];
  const ringSize = distanceValid && distanceCm !== null
    ? distanceCm * 10 * Math.tan(gapAngleRadians) * 5 * SCREEN_POINTS_PER_MM
    : 0;

  useEffect(() => {
    if (nativeFaceDetected) {
      setFaceDetected(true);
      return;
    }
    if (!faceDetected) return;
    const timer = setTimeout(() => setFaceDetected(false), FACE_LOST_GRACE_MS);
    return () => clearTimeout(timer);
  }, [faceDetected, nativeFaceDetected]);

  useEffect(() => {
    const faceWidthPx = detector.result.primaryFaceRect?.width ?? 0;
    if (!cameraActive || step !== 'test' || !faceDetected || faceWidthPx <= 0) return;
    const estimate = estimateFaceDistanceCm(
      faceWidthPx,
      windowSize.width,
      selectedCamera?.focalLength ?? DEFAULT_FOCAL_LENGTH_35MM,
      windowSize.height >= windowSize.width,
    );
    if (estimate === null) return;
    distanceSamplesRef.current = [...distanceSamplesRef.current, estimate].slice(-3);
    const smoothedDistance = median(distanceSamplesRef.current);
    setDistanceCm(smoothedDistance);
    setDistanceValid(smoothedDistance > 0 && smoothedDistance <= MAX_TEST_DISTANCE_CM);
  }, [cameraActive, detector.result.primaryFaceRect?.width, faceDetected, selectedCamera?.focalLength, step, windowSize.height, windowSize.width]);

  useEffect(() => {
    if (faceDetected || step !== 'test') return;
    setDistanceCm(null);
    setDistanceValid(false);
    distanceSamplesRef.current = [];
  }, [faceDetected, step]);

  const nextDirection = useCallback(() => {
    if (!directionDeck.current.length) directionDeck.current = shuffledDirections(previousDirection.current);
    const direction = directionDeck.current.shift()!;
    previousDirection.current = direction;
    return direction;
  }, []);

  const beginTest = useCallback(() => {
    setTestEye('right');
    setLevelIndex(0);
    setTrialIndex(0);
    setLevelCorrect(0);
    setBestAcuity(0);
    directionDeck.current = [];
    previousDirection.current = undefined;
    setCurrentDirection(nextDirection());
    setStep('test');
  }, [nextDirection]);

  async function startCamera() {
    setCameraError('');
    setFaceDetected(false);
    setDistanceCm(null);
    setDistanceValid(false);
    distanceSamplesRef.current = [];
    let granted = permission.hasPermission;
    if (!granted && permission.canRequestPermission) granted = await permission.requestPermission();
    if (!granted) {
      setCameraError('距離測定にはカメラの許可が必要です。端末の設定からカメラを許可してください。');
      return;
    }
    if (!selectedCamera) {
      setCameraError('前面カメラが見つかりません。');
      return;
    }
    setCameraActive(true);
    beginTest();
  }

  function completeEye(value: number) {
    const updated = { ...testResults, [testEye]: value };
    setTestResults(updated);
    setStep('result');
  }

  function answer(direction?: string) {
    if (!distanceValid || distanceCm === null) return;
    const nextCorrect = levelCorrect + (direction === currentDirection ? 1 : 0);
    const trialsAnswered = trialIndex + 1;
    const remainingTrials = MAX_TRIALS_PER_LEVEL - trialsAnswered;
    if (nextCorrect >= REQUIRED_CORRECT_PER_LEVEL) {
      const passed = LEVELS[levelIndex];
      setBestAcuity(passed);
      if (levelIndex < LEVELS.length - 1) {
        setLevelIndex(levelIndex + 1);
        setTrialIndex(0);
        setLevelCorrect(0);
        setCurrentDirection(nextDirection());
      } else completeEye(passed);
    } else if (trialsAnswered >= MAX_TRIALS_PER_LEVEL || nextCorrect + remainingTrials < REQUIRED_CORRECT_PER_LEVEL) {
      completeEye(bestAcuity);
    } else {
      setLevelCorrect(nextCorrect);
      setTrialIndex(trialsAnswered);
      setCurrentDirection(nextDirection());
    }
  }

  function finish() {
    setCameraActive(false);
    setStep('home');
  }

  const stepLabel = {
    home: 'かんたんセルフチェック',
    test: `${testEye === 'right' ? '右' : '左'}目のチェック`,
    result: 'チェック結果',
  }[step];

  return (
    <AuthGate>
    <View style={styles.root}>
      {cameraActive && selectedCamera && (
        <Camera
          key={`distance-camera-${selectedCamera.id}`}
          {...detector.camera}
          style={[StyleSheet.absoluteFill, styles.distanceCamera]}
          device={selectedCamera}
          isActive
          mirrorMode="on"
        />
      )}
      <SafeAreaView style={styles.safe}>
        <View style={styles.header}>
          <View style={styles.brandRow}><View style={styles.brandMark}><Text style={styles.brandMarkText}>●</Text></View><Text style={styles.brand}>みえる？</Text></View>
          <Text style={styles.topNote}>{stepLabel}</Text>
        </View>
        <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
          {step === 'home' && (
            <View style={styles.content}>
              <Text style={styles.eyebrow}>● かんたんセルフチェック</Text>
              <Text style={styles.heroTitle}>いまの視力、{ '\n' }ためしてみよう。</Text>
              <Text style={styles.body}>前面カメラで顔との距離を測り、距離に合わせて視標の大きさを調整しながらチェックします。</Text>
              <EyeProgress />
              <Text style={styles.helper}>右目から始めて左目へ進みます。測定中は反対側の目を手で隠してください。</Text>
              <View style={styles.artCard}><Ring direction="right" size={128} /><Text style={styles.artCaption}>切れ目の向きを選んでチェック</Text></View>
              <Button label="顔を映してチェックをはじめる" onPress={startCamera} />
              {cameraError ? <Text style={styles.error}>{cameraError}</Text> : null}
              <View style={styles.accountRow}><Text style={styles.accountEmail}>{auth?.currentUser?.email}</Text><TextButton label="ログアウト" onPress={() => { if (auth) void signOut(auth); }} /></View>
              <Text style={styles.helper}>視力の目安を0.1刻みで、最大2.0まで確認します。</Text>
              <Text style={styles.disclaimer}>このチェックは医療診断ではありません。見え方が気になる場合は眼科を受診してください。</Text>
            </View>
          )}

          {step === 'test' && (
            <View style={styles.testContent}>
              <EyeProgress
                activeEye={testEye}
                rightComplete={testResults.right !== undefined}
                leftComplete={false}
              />
              <Text style={styles.eyebrow}>{testEye === 'right' ? '1/2 右目' : '2/2 左目'}をチェック中 · 段階 {levelIndex + 1} / {LEVELS.length}</Text>
              <Text style={styles.body}>{testEye === 'right' ? '左目を手で隠してください。' : '右目を手で隠してください。'}距離を測定して視標サイズを自動調整します。切れ目の向きを選んでください。</Text>
              <View style={styles.ringStage}>
                {distanceValid && ringSize > 0
                  ? <Ring direction={currentDirection} size={ringSize} />
                  : <Text style={styles.distancePrompt}>{distanceCm !== null ? '顔との距離を600cm以内にしてください' : '前面カメラで顔との距離を自動測定中…'}</Text>}
              </View>
              <View style={styles.liveDistance}><Text style={styles.liveDistanceText}>{distanceValid && distanceCm !== null ? `距離 約${Math.round(distanceCm)}cm · 視標サイズを自動調整中` : distanceCm !== null ? `距離 約${Math.round(distanceCm)}cm。600cm以内で顔を映してください` : faceDetected ? '顔を検出中。距離が安定すると検査が始まります' : detectorStatusLabel}</Text></View>
              {distanceValid && (
                <>
                  <View style={styles.answerGrid}>
                    <View style={styles.answerRow}>{(['up-left', 'up', 'up-right'] as const).map((dir) => <AnswerButton key={dir} dir={dir} onPress={() => answer(dir)} />)}</View>
                    <View style={styles.answerRow}><AnswerButton dir="left" onPress={() => answer('left')} /><View style={styles.answerPlaceholder} /><AnswerButton dir="right" onPress={() => answer('right')} /></View>
                    <View style={styles.answerRow}>{(['down-left', 'down', 'down-right'] as const).map((dir) => <AnswerButton key={dir} dir={dir} onPress={() => answer(dir)} />)}</View>
                  </View>
                  <TextButton label="わからない" onPress={() => answer()} />
                  <Text style={styles.testFoot}>問題 {trialIndex + 1} / {MAX_TRIALS_PER_LEVEL} ・ 視標サイズは測定距離に応じて変化します</Text>
                </>
              )}
              <TextButton label="検査をやめる" onPress={finish} />
            </View>
          )}

          {step === 'result' && (
            <View style={styles.content}>
              <EyeProgress
                rightComplete={testResults.right !== undefined}
                leftComplete={testEye === 'left'}
              />
              <Text style={styles.eyebrow}>{testEye === 'right' ? '1/2 右目完了' : '2/2 両目完了'}</Text>
              <Text style={styles.title}>おつかれさまでした。</Text>
              <Text style={styles.body}>{testEye === 'right' ? '右目の測定が終わりました。続けて左目を測定します。' : '右目・左目の簡易チェック結果です。'}</Text>
              <View style={styles.resultCard}><Text style={styles.resultLabel}>{testEye === 'right' ? '右' : '左'}目の目安</Text><Text style={styles.resultNumber}>{bestAcuity ? bestAcuity.toFixed(1) : '0.1未満'}</Text><Text style={styles.resultCaption}>今回の条件で見分けられた段階</Text></View>
              {testEye === 'right' && <Button label="次へ：左目をチェック" onPress={() => { setTestEye('left'); setLevelIndex(0); setTrialIndex(0); setLevelCorrect(0); setBestAcuity(0); directionDeck.current = []; setCurrentDirection(nextDirection()); setStep('test'); }} />}
              {testEye === 'right' && <Button label="今日はここまで" onPress={finish} />}
              {cameraActive && <Text style={styles.helper}>{distanceCm !== null ? `最後の推定距離: 約${Math.round(distanceCm)}cm` : '距離推定値なしで検査を続けました'}</Text>}
              {testEye === 'left' && <View style={styles.resultSummary}><Text style={styles.cardTitle}>両目の結果</Text><Text style={styles.cardBody}>右目 {testResults.right?.toFixed(1) ?? '—'}　/　左目 {bestAcuity ? bestAcuity.toFixed(1) : '0.1未満'}</Text></View>}
              {testEye === 'left' && <Button label="終了する" onPress={finish} />}
              <Text style={styles.disclaimer}>この結果は目安です。医療機器による検査や診断の代わりにはなりません。</Text>
            </View>
          )}
        </ScrollView>
      </SafeAreaView>
    </View>
    </AuthGate>
  );
}

function Ring({ direction, size }: { direction: (typeof DIRECTIONS)[number]; size: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100">
      <Circle cx="50" cy="50" r="40" fill="none" stroke="#17241f" strokeWidth="20" />
      <Rect x="50" y="40" width="60" height="20" fill="#f4f5f1" rotation={DIRECTION_ANGLES[direction]} origin="50, 50" />
    </Svg>
  );
}

function EyeProgress({
  activeEye,
  rightComplete = false,
  leftComplete = false,
}: {
  activeEye?: 'right' | 'left';
  rightComplete?: boolean;
  leftComplete?: boolean;
}) {
  const eyes = [
    { eye: 'right' as const, label: '右目', number: '1', complete: rightComplete },
    { eye: 'left' as const, label: '左目', number: '2', complete: leftComplete },
  ];

  return (
    <View style={styles.eyeProgress}>
      {eyes.map(({ eye, label, number, complete }, index) => (
        <React.Fragment key={eye}>
          {index > 0 && <Text style={styles.eyeProgressArrow}>→</Text>}
          <View style={[
            styles.eyeProgressStep,
            activeEye === eye && styles.eyeProgressActive,
            complete && styles.eyeProgressComplete,
          ]}>
            <Text style={[
              styles.eyeProgressNumber,
              activeEye === eye && styles.eyeProgressActiveText,
              complete && styles.eyeProgressCompleteText,
            ]}>{complete ? '✓' : number}</Text>
            <Text style={[
              styles.eyeProgressLabel,
              activeEye === eye && styles.eyeProgressActiveText,
              complete && styles.eyeProgressCompleteText,
            ]}>{label}</Text>
          </View>
        </React.Fragment>
      ))}
    </View>
  );
}

function Button({ label, onPress, disabled = false }: { label: string; onPress: () => void; disabled?: boolean }) {
  return <Pressable disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.button, pressed && styles.buttonPressed, disabled && styles.buttonDisabled]}><Text style={styles.buttonText}>{label}<Text style={styles.buttonArrow}>  →</Text></Text></Pressable>;
}

function TextButton({ label, onPress, disabled = false }: { label: string; onPress: () => void; disabled?: boolean }) {
  return <Pressable disabled={disabled} onPress={onPress} style={styles.textButton}><Text style={[styles.textButtonText, disabled && { opacity: 0.4 }]}>{label}</Text></Pressable>;
}

function AnswerButton({ dir, onPress }: { dir: (typeof DIRECTIONS)[number]; onPress: () => void }) {
  return <Pressable style={({ pressed }) => [styles.answerBtn, pressed && styles.answerPressed]} onPress={onPress}><Text style={styles.answerText}>{ARROWS[dir]}</Text></Pressable>;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#f4f5f1' },
  safe: { flex: 1, backgroundColor: '#f4f5f1' },
  header: { minHeight: 58, paddingHorizontal: 22, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#e3e7e1', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  brandRow: { flexDirection: 'row', gap: 9, alignItems: 'center' }, brandMark: { width: 27, height: 27, borderRadius: 14, backgroundColor: '#b8f06a', alignItems: 'center', justifyContent: 'center' }, brandMarkText: { fontSize: 11, color: '#213c31' }, brand: { fontSize: 17, fontWeight: '800', color: '#182321' }, topNote: { color: '#75817c', fontSize: 10, letterSpacing: 1 },
  scroll: { flexGrow: 1, paddingBottom: 24 }, content: { width: '100%', maxWidth: 500, alignSelf: 'center', paddingHorizontal: 24, paddingTop: 30, paddingBottom: 36 },
  eyebrow: { color: '#607064', fontSize: 11, fontWeight: '700', letterSpacing: 1.4, marginBottom: 15 }, heroTitle: { color: '#182321', fontSize: 39, fontWeight: '800', lineHeight: 51, letterSpacing: -1.8, marginBottom: 14 }, title: { color: '#182321', fontSize: 31, fontWeight: '800', lineHeight: 43, letterSpacing: -1, marginBottom: 10 }, body: { color: '#727d78', fontSize: 13, lineHeight: 22, marginBottom: 20 },
  artCard: { minHeight: 185, marginBottom: 17, borderRadius: 18, backgroundColor: '#e9ede6', alignItems: 'center', justifyContent: 'center' }, artCaption: { color: '#75817c', fontSize: 10, marginTop: 7 }, cardTitle: { color: '#182321', fontSize: 12, fontWeight: '700', marginBottom: 4 }, cardBody: { color: '#7a857f', fontSize: 10, lineHeight: 15 },
  eyeProgress: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 12, marginBottom: 14 }, eyeProgressStep: { flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 13, paddingVertical: 8, borderRadius: 18, backgroundColor: '#e9ede6' }, eyeProgressActive: { backgroundColor: '#20382f' }, eyeProgressComplete: { backgroundColor: '#b8f06a' }, eyeProgressNumber: { color: '#75817c', fontSize: 11, fontWeight: '800' }, eyeProgressLabel: { color: '#43564a', fontSize: 11, fontWeight: '700' }, eyeProgressActiveText: { color: '#fff' }, eyeProgressCompleteText: { color: '#193023' }, eyeProgressArrow: { color: '#9aa39d', fontSize: 14, fontWeight: '700' },
  button: { minHeight: 53, backgroundColor: '#b8f06a', borderRadius: 11, alignItems: 'center', justifyContent: 'center', marginTop: 4 }, buttonPressed: { backgroundColor: '#a9e657', transform: [{ scale: 0.99 }] }, buttonDisabled: { backgroundColor: '#dbe2d4' }, buttonText: { color: '#193023', fontSize: 13, fontWeight: '800' }, buttonArrow: { fontSize: 17, fontWeight: '500' }, textButton: { alignSelf: 'center', padding: 15 }, textButtonText: { color: '#7e8981', fontSize: 11 }, disclaimer: { color: '#9aa39d', fontSize: 9, lineHeight: 16, textAlign: 'center', marginTop: 16 },
  distanceCamera: { opacity: 0.01 }, liveDistance: { alignSelf: 'stretch', padding: 9, backgroundColor: '#e9ede6', borderRadius: 9, marginBottom: 8 }, liveDistanceText: { color: '#43564a', fontSize: 11, textAlign: 'center' }, distancePrompt: { color: '#75817c', fontSize: 13, textAlign: 'center' }, error: { color: '#bd4e3f', fontSize: 11, lineHeight: 17, marginBottom: 10 }, helper: { color: '#858f88', fontSize: 10, lineHeight: 16, textAlign: 'center', marginTop: 12 },
  testContent: { flex: 1, alignItems: 'center', paddingHorizontal: 20, paddingTop: 24, paddingBottom: 15 }, ringStage: { flex: 1, minHeight: 230, width: '100%', alignItems: 'center', justifyContent: 'center' }, warning: { color: '#a54436', fontSize: 11, marginVertical: 8, textAlign: 'center' }, answerGrid: { width: 204, gap: 7, marginBottom: 6 }, answerRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 7 }, answerBtn: { width: 62, height: 56, borderRadius: 11, borderWidth: 1, borderColor: '#e0e5de', backgroundColor: 'rgba(255,255,255,0.75)', alignItems: 'center', justifyContent: 'center' }, answerPlaceholder: { width: 62, height: 56 }, answerPressed: { backgroundColor: '#b8f06a' }, answerText: { color: '#283a32', fontSize: 24 }, testFoot: { color: '#9aa39d', fontSize: 9, marginTop: 6 },
  resultCard: { backgroundColor: '#20382f', borderRadius: 15, padding: 22, marginVertical: 24, alignItems: 'center' }, resultLabel: { color: '#c2d0c5', fontSize: 11 }, resultNumber: { color: '#fff', fontSize: 58, fontWeight: '500', marginVertical: 4 }, resultCaption: { color: '#c2d0c5', fontSize: 10 }, resultSummary: { width: '100%', padding: 14, backgroundColor: '#e9ede6', borderRadius: 12, marginBottom: 12 },
  accountRow: { marginTop: 16, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#dfe5dc', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, accountEmail: { color: '#75817c', fontSize: 10, flexShrink: 1 },
});
