/* eslint-disable react-hooks/set-state-in-effect -- Native camera frames and permission-backed measurements are external streams. */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFaceDetector } from '@noma4i/vision-camera-face-detector';
import { useCameraDevices, useCameraPermission, usePhotoOutput, Camera } from 'react-native-vision-camera';
import Svg, { Circle, Rect } from 'react-native-svg';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { signOut } from 'firebase/auth';
import AuthGate from '../components/AuthGate';
import { auth } from '../lib/firebase';
import {
  ActivityIndicator,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

const STORAGE_KEY = 'mieru.camera-calibrations.v2';
const SCREEN_SCALE_PX_PER_MM = 150 / 23.5;
const REFERENCE_CM = 40;
const CALIBRATION_STABLE_FRAMES = 20;
const DEPTH_API_URL = process.env.EXPO_PUBLIC_DEPTH_API_URL?.replace(/\/$/, '');
const TARGET_CM = 250;
const ACCEPTANCE_RANGE_CM = 20;
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
type Step = 'home' | 'camera' | 'distance' | 'test' | 'result';
type CameraCalibration = { cameraId: string; cameraName: string; modelId: string; depthScaleFactor: number; referenceCm: number; updatedAt: string };
type CalibrationMap = Record<string, CameraCalibration>;

function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
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
  const photoOutput = usePhotoOutput({ targetResolution: { width: 640, height: 480 }, containerFormat: 'jpeg', quality: 0.5, qualityPrioritization: 'speed' });
  const detector = useFaceDetector({ preset: 'accurate', guide: 'none', fps: 10, outputs: photoOutput });
  const [step, setStep] = useState<Step>('home');
  const [cameraActive, setCameraActive] = useState(false);
  const [calibrationProgress, setCalibrationProgress] = useState(0);
  const [selectedCameraId, setSelectedCameraId] = useState('');
  const [calibrations, setCalibrations] = useState<CalibrationMap>({});
  const [cameraError, setCameraError] = useState('');
  const [depthError, setDepthError] = useState('');
  const [distanceCm, setDistanceCm] = useState<number | null>(null);
  const [distanceValid, setDistanceValid] = useState(false);
  const [distanceStable, setDistanceStable] = useState(false);
  const [testEye, setTestEye] = useState<'right' | 'left'>('right');
  const [levelIndex, setLevelIndex] = useState(0);
  const [trialIndex, setTrialIndex] = useState(0);
  const [levelCorrect, setLevelCorrect] = useState(0);
  const [bestAcuity, setBestAcuity] = useState(0);
  const [currentDirection, setCurrentDirection] = useState<(typeof DIRECTIONS)[number]>('up');
  const [testResults, setTestResults] = useState<{ right?: number; left?: number }>({});
  const calibrationSamples = useRef<number[]>([]);
  const calibrationSaved = useRef(false);
  const estimateRequestId = useRef(0);
  const depthRequestInFlight = useRef(false);
  const directionDeck = useRef<(typeof DIRECTIONS)[number][]>([]);
  const previousDirection = useRef<string | undefined>(undefined);

  const selectedCamera = useMemo(
    () => devices.find((device) => device.id === selectedCameraId)
      ?? devices.find((device) => device.position === 'front')
      ?? devices[0],
    [devices, selectedCameraId],
  );
  const activeCalibration = selectedCamera ? calibrations[selectedCamera.id] : undefined;
  const faceWidth = detector.result.primaryFace?.bounds.width ?? 0;
  const faceDetected = faceWidth > 0;
  const ringSize = LEVELS[levelIndex]
    ? Math.max(8, Math.min(420, 2500 * Math.tan((Math.PI / 180 / 60) / LEVELS[levelIndex]) * 5 * SCREEN_SCALE_PX_PER_MM))
    : 100;

  const postCameraImage = useCallback(async (path: '/calibrate' | '/estimate', scaleFactor?: number) => {
    if (!DEPTH_API_URL) throw new Error('DEPTH_API_URL_NOT_SET');
    const photo = await photoOutput.capturePhoto({ flashMode: 'off', enableShutterSound: false }, {});
    try {
      const imageBytes = await photo.getFileDataAsync();
      const headers: Record<string, string> = { 'Content-Type': 'image/jpeg' };
      if (scaleFactor !== undefined) headers['X-Depth-Scale-Factor'] = String(scaleFactor);
      const response = await fetch(`${DEPTH_API_URL}${path}`, { method: 'POST', headers, body: imageBytes });
      if (!response.ok) throw new Error(`DEPTH_API_HTTP_${response.status}`);
      return await response.json() as { depth_scale_factor?: number; raw_distance_cm?: number; distance_cm?: number };
    } finally {
      photo.dispose();
    }
  }, [photoOutput]);

  const saveCameraCalibration = useCallback(async () => {
    if (!selectedCamera) return;
    try {
      const result = await postCameraImage('/calibrate');
      if (!result.depth_scale_factor || !Number.isFinite(result.depth_scale_factor)) throw new Error('INVALID_CALIBRATION');
      const record: CameraCalibration = {
        cameraId: selectedCamera.id,
        cameraName: selectedCamera.localizedName,
        modelId: selectedCamera.modelID,
        depthScaleFactor: result.depth_scale_factor,
        referenceCm: REFERENCE_CM,
        updatedAt: new Date().toISOString(),
      };
      const updated = { ...calibrations, [selectedCamera.id]: record };
      setCalibrations(updated);
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
      setDistanceCm(REFERENCE_CM);
      setDistanceValid(false);
      setDistanceStable(false);
      setStep('distance');
    } catch {
      calibrationSaved.current = false;
      calibrationSamples.current = [];
      setCalibrationProgress(0);
      setCameraError(DEPTH_API_URL ? 'Python深度モデルで校正できませんでした。顔を中央に合わせて再試行してください。' : 'Python深度APIのURLが未設定です。mobile/.env に EXPO_PUBLIC_DEPTH_API_URL を設定してください。');
    }
  }, [calibrations, postCameraImage, selectedCamera]);

  useEffect(() => {
    (async () => {
      try {
        const savedCameras = await AsyncStorage.getItem(STORAGE_KEY);
        if (savedCameras) setCalibrations(JSON.parse(savedCameras) as CalibrationMap);
      } catch {
        setCameraError('保存済みの校正値を読み込めませんでした。もう一度校正してください。');
      }
    })();
  }, []);

  // Once the face stays still, capture one calibration image for the Python model.
  useEffect(() => {
    if (!cameraActive || step !== 'camera' || faceWidth <= 0 || calibrationSaved.current) return;
    const samples = calibrationSamples.current;
    const recent = [...samples.slice(-(CALIBRATION_STABLE_FRAMES - 1)), faceWidth];
    const center = median(recent);
    const relativeSpread = center > 0 ? (Math.max(...recent) - Math.min(...recent)) / center : 1;
    calibrationSamples.current = relativeSpread <= 0.08 ? recent : [faceWidth];
    setCalibrationProgress(Math.min(1, calibrationSamples.current.length / CALIBRATION_STABLE_FRAMES));
    if (calibrationSamples.current.length >= CALIBRATION_STABLE_FRAMES) {
      calibrationSaved.current = true;
      void saveCameraCalibration();
    }
  }, [faceWidth, cameraActive, step, saveCameraCalibration]);

  // Periodically send a camera JPEG to the configured Python metric-depth API.
  useEffect(() => {
    if (!cameraActive || !activeCalibration || (step !== 'distance' && step !== 'test')) return;
    if (!DEPTH_API_URL) {
      setDepthError('Python深度推定APIが未設定です。mobile/.env に EXPO_PUBLIC_DEPTH_API_URL を設定してください。');
      setDistanceCm(null);
      setDistanceValid(false);
      return;
    }
    if (!faceDetected) {
      setDistanceCm(null);
      setDistanceValid(false);
      return;
    }

    let active = true;
    const requestEstimate = async () => {
      if (depthRequestInFlight.current) return;
      depthRequestInFlight.current = true;
      const requestId = ++estimateRequestId.current;
      setDepthError('');
      try {
        const result = await postCameraImage('/estimate', activeCalibration.depthScaleFactor);
        if (!active || requestId !== estimateRequestId.current) return;
        if (result.distance_cm === undefined) throw new Error('INVALID_ESTIMATE');
        setDistanceCm(result.distance_cm);
        setDistanceValid(Math.abs(result.distance_cm - TARGET_CM) <= ACCEPTANCE_RANGE_CM);
      } catch {
        if (!active || requestId !== estimateRequestId.current) return;
        setDepthError('Python距離推定APIに接続できません。端末とPythonサーバーの接続を確認してください。');
        setDistanceCm(null);
        setDistanceValid(false);
      } finally {
        depthRequestInFlight.current = false;
      }
    };
    void requestEstimate();
    const timer = setInterval(() => { void requestEstimate(); }, 1800);
    return () => {
      active = false;
      estimateRequestId.current += 1;
      clearInterval(timer);
    };
  }, [activeCalibration, cameraActive, faceDetected, postCameraImage, step]);

  // Delay acceptance until the native distance estimate remains in range briefly.
  useEffect(() => {
    if (!distanceValid) {
      setDistanceStable(false);
      return;
    }
    const timer = setTimeout(() => setDistanceStable(true), 1400);
    return () => clearTimeout(timer);
  }, [distanceValid]);

  function nextDirection() {
    if (!directionDeck.current.length) directionDeck.current = shuffledDirections(previousDirection.current);
    const direction = directionDeck.current.shift()!;
    previousDirection.current = direction;
    return direction;
  }

  async function startCamera() {
    setStep('camera');
    setCameraError('');
    calibrationSamples.current = [];
    calibrationSaved.current = false;
    setCalibrationProgress(0);
    setDistanceCm(null);
    setDistanceValid(false);
    setDistanceStable(false);
    setDepthError('');
    let granted = permission.hasPermission;
    if (!granted && permission.canRequestPermission) granted = await permission.requestPermission();
    if (!granted) {
      setCameraError('距離確認にはカメラの許可が必要です。端末の設定からカメラを許可してください。');
      return;
    }
    if (!selectedCamera) {
      setCameraError('利用できるカメラが見つかりません。');
      return;
    }
    setCameraActive(true);
    setStep('camera');
  }

  function beginTest() {
    if (!distanceStable) return;
    setTestEye('right');
    setLevelIndex(0);
    setTrialIndex(0);
    setLevelCorrect(0);
    setBestAcuity(0);
    directionDeck.current = [];
    previousDirection.current = undefined;
    setCurrentDirection(nextDirection());
    setStep('test');
  }

  function completeEye(value: number) {
    const updated = { ...testResults, [testEye]: value };
    setTestResults(updated);
    setStep('result');
  }

  function answer(direction?: string) {
    if (!distanceValid) return;
    const nextCorrect = levelCorrect + (direction === currentDirection ? 1 : 0);
    if (trialIndex < 2) {
      setLevelCorrect(nextCorrect);
      setTrialIndex(trialIndex + 1);
      setCurrentDirection(nextDirection());
      return;
    }
    if (nextCorrect >= 2) {
      const passed = LEVELS[levelIndex];
      setBestAcuity(passed);
      if (levelIndex < LEVELS.length - 1) {
        setLevelIndex(levelIndex + 1);
        setTrialIndex(0);
        setLevelCorrect(0);
        setCurrentDirection(nextDirection());
      } else completeEye(passed);
    } else completeEye(bestAcuity);
  }

  function finish() {
    setCameraActive(false);
    setStep('home');
  }

  function chooseCamera(cameraId: string) {
    calibrationSamples.current = [];
    calibrationSaved.current = false;
    setCalibrationProgress(0);
    setSelectedCameraId(cameraId);
    setDistanceCm(null);
    setDistanceValid(false);
    setDistanceStable(false);
  }

  function useFrontCameraForTest() {
    const front = devices.find((device) => device.position === 'front');
    if (!front) {
      setCameraError('画面を見ながら距離を確認するには前面カメラが必要です。');
      return;
    }
    chooseCamera(front.id);
    setCameraError('');
    setStep(calibrations[front.id] ? 'distance' : 'camera');
  }

  const stepLabel = {
    home: 'かんたんセルフチェック',
    camera: '顔を映して自動校正',
    distance: '250cmの距離確認',
    test: `${testEye === 'right' ? '右' : '左'}目のチェック`,
    result: 'チェック結果',
  }[step];

  return (
    <AuthGate>
    <View style={styles.root}>
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
              <Text style={styles.body}>8方向のランドルト環を見て、切れ目の向きを選びます。顔を映すと距離を自動校正して、約2分でチェックします。</Text>
              <View style={styles.artCard}><Ring direction="right" size={128} /><Text style={styles.artCaption}>切れ目の向きを選んでチェック</Text></View>
              <View style={styles.infoCard}><Text style={styles.infoIcon}>↔</Text><View style={{ flex: 1 }}><Text style={styles.cardTitle}>測定距離</Text><Text style={styles.cardBody}>スマホから250cmを目安にします</Text></View><Text style={styles.cardArrow}>›</Text></View>
              <Button label="顔を映してチェックをはじめる" onPress={startCamera} />
              <View style={styles.accountRow}><Text style={styles.accountEmail}>{auth?.currentUser?.email}</Text><TextButton label="ログアウト" onPress={() => { if (auth) void signOut(auth); }} /></View>
              <Text style={styles.helper}>視力の目安を0.1刻みで、最大2.0まで確認します。</Text>
              <Text style={styles.disclaimer}>このチェックは医療診断ではありません。見え方が気になる場合は眼科を受診してください。</Text>
            </View>
          )}

          {step === 'camera' && (
            <View style={styles.content}>
              <Text style={styles.eyebrow}>顔の自動校正</Text>
              <Text style={styles.title}>顔を映して{ '\n' }距離を自動校正</Text>
              <Text style={styles.body}>画面の枠に顔を合わせてください。顔が安定して映ると自動で校正します。校正中はスマホを顔から約40cmに保ちます。</Text>
              <View style={styles.cameraPicker}>
                {devices.map((device) => (
                  <Pressable key={device.id} style={[styles.cameraChip, selectedCamera?.id === device.id && styles.cameraChipSelected]} onPress={() => chooseCamera(device.id)}>
                    <Text style={[styles.cameraChipTitle, selectedCamera?.id === device.id && styles.cameraChipTitleSelected]}>{device.localizedName || (device.position === 'front' ? '前面カメラ' : '背面カメラ')}</Text>
                    <Text style={[styles.cameraChipCaption, selectedCamera?.id === device.id && styles.cameraChipCaptionSelected]}>{device.position === 'front' ? '前面' : '背面'} · {device.type}</Text>
                  </Pressable>
                ))}
                {devices.length === 0 && <ActivityIndicator color="#89ae53" />}
              </View>
              {cameraActive && selectedCamera && <View style={styles.preview}><Camera key={`camera-${selectedCamera.id}`} {...detector.camera} style={StyleSheet.absoluteFill} device={selectedCamera} isActive mirrorMode={selectedCamera.position === 'front' ? 'on' : 'off'} /><Text style={styles.previewTop}>選択中: {selectedCamera.localizedName || 'カメラ'}</Text><View style={styles.faceOval} /><Text style={styles.previewBottom}>{faceWidth > 0 ? '顔を検出しています' : '顔をカメラに向けてください'}</Text></View>}
              <View style={styles.distanceCard}><Text style={styles.distanceIcon}>◎</Text><View style={{ flex: 1 }}><Text style={styles.cardTitle}>顔を自動検出して校正</Text><Text style={styles.cardBody}>{cameraActive ? (faceDetected ? `顔を検出中 · 安定度 ${Math.round(calibrationProgress * 100)}%` : '顔を枠に合わせてください') : (activeCalibration ? `前回の校正 · ${new Date(activeCalibration.updatedAt).toLocaleDateString('ja-JP')}` : 'まだ校正されていません')}</Text></View>{cameraActive && <ActivityIndicator color="#71954c" />}</View>
              {cameraError ? <Text style={styles.error}>{cameraError}</Text> : null}
              {!cameraActive && <Button label="カメラを起動する" onPress={startCamera} />}
              {cameraActive && <Text style={styles.helper}>顔を約40cmの位置で中央に合わせてください。安定して検出すると自動で校正し、この端末に保存します。</Text>}
              <Text style={styles.disclaimer}>校正時に静止画を1枚、距離確認中は約1.8秒ごとに低解像度画像を設定済みPythonサーバーへ送信します。APIコードは画像を保存しません。推定距離は目安です。</Text>
              <Text style={styles.disclaimer}>視標の大きさは端末の標準画面サイズから計算する目安です。</Text>
              <TextButton label="戻る" onPress={() => { setCameraActive(false); setStep('home'); }} />
            </View>
          )}

          {step === 'distance' && (
            <View style={styles.content}>
              <Text style={styles.eyebrow}>距離チェック</Text>
              <Text style={styles.title}>スマホを固定して{ '\n' }250cm離れてください</Text>
              <Text style={styles.body}>画面を目の高さに固定し、顔をカメラ枠の中央に合わせて立ちます。Python深度モデルで距離を推定します。</Text>
              {selectedCamera?.position !== 'front' && <View style={styles.frontCameraNotice}><Text style={styles.frontCameraNoticeText}>テスト中も画面を見ながら距離を確認できるよう、前面カメラに切り替えてください。</Text><Button label="前面カメラを使う" onPress={useFrontCameraForTest} /></View>}
              {cameraActive && selectedCamera && <View style={styles.preview}><Camera key={`camera-${selectedCamera.id}`} {...detector.camera} style={StyleSheet.absoluteFill} device={selectedCamera} isActive mirrorMode={selectedCamera.position === 'front' ? 'on' : 'off'} /><Text style={styles.previewTop}>{selectedCamera.localizedName || 'カメラ'}</Text><View style={styles.faceOval} /><Text style={styles.previewBottom}>{faceWidth > 0 ? '顔を検出中' : '顔が映る位置に立ってください'}</Text></View>}
              <View style={styles.distanceReadout}><Text style={styles.distanceBig}>{distanceCm ? `約 ${Math.round(distanceCm)} cm` : '— cm'}</Text><Text style={[styles.statusPill, distanceValid && styles.statusPillOk]}>{distanceStable ? '距離を確認しました' : distanceValid ? 'その位置を保ってください' : '250cmの位置に移動してください'}</Text></View>
              {depthError ? <Text style={styles.error}>{depthError}</Text> : null}
              {distanceStable && selectedCamera?.position === 'front' ? <Button label="この距離でチェックを始める" onPress={beginTest} /> : <Button label="距離を確認中…" onPress={() => {}} disabled />}
              <TextButton label="カメラを選び直す" onPress={() => setStep('camera')} />
              <Text style={styles.disclaimer}>Pythonの単眼深度モデルを40cmでカメラごとに校正した推定値です。正確な測距を保証する機能ではありません。</Text>
            </View>
          )}

          {step === 'test' && (
            <View style={styles.testContent}>
              <Text style={styles.eyebrow}>{testEye === 'right' ? '右目' : '左目'}をチェック中 · 段階 {levelIndex + 1} / {LEVELS.length}</Text>
              <Text style={styles.body}>ランドルト環の切れ目はどちら？</Text>
              <View style={styles.ringStage}><Ring direction={currentDirection} size={ringSize} /></View>
              {!distanceValid && <Text style={styles.warning}>250cmの位置から離れました。位置に戻ってください。</Text>}
              {cameraActive && selectedCamera && <View style={styles.cameraPip}><Camera key={`camera-${selectedCamera.id}`} {...detector.camera} style={StyleSheet.absoluteFill} device={selectedCamera} isActive mirrorMode={selectedCamera.position === 'front' ? 'on' : 'off'} /><Text style={styles.cameraPipText}>{distanceCm ? `${Math.round(distanceCm)}cm` : '距離確認中'}</Text></View>}
              <View style={styles.answerGrid}>
                <View style={styles.answerRow}>{(['up-left', 'up', 'up-right'] as const).map((dir) => <AnswerButton key={dir} dir={dir} disabled={!distanceValid} onPress={() => answer(dir)} />)}</View>
                <View style={styles.answerRow}><AnswerButton dir="left" disabled={!distanceValid} onPress={() => answer('left')} /><View style={styles.answerPlaceholder} /><AnswerButton dir="right" disabled={!distanceValid} onPress={() => answer('right')} /></View>
                <View style={styles.answerRow}>{(['down-left', 'down', 'down-right'] as const).map((dir) => <AnswerButton key={dir} dir={dir} disabled={!distanceValid} onPress={() => answer(dir)} />)}</View>
              </View>
              <TextButton label="わからない" onPress={() => answer()} disabled={!distanceValid} />
              <Text style={styles.testFoot}>問題 {trialIndex + 1} / 3 ・ 距離を保って回答してください</Text>
            </View>
          )}

          {step === 'result' && (
            <View style={styles.content}>
              <Text style={styles.eyebrow}>● チェック完了</Text>
              <Text style={styles.title}>おつかれさまでした。</Text>
              <Text style={styles.body}>{testEye === 'right' ? '右' : '左'}目の簡易チェック結果です。</Text>
              <View style={styles.resultCard}><Text style={styles.resultLabel}>{testEye === 'right' ? '右' : '左'}目の目安</Text><Text style={styles.resultNumber}>{bestAcuity ? bestAcuity.toFixed(1) : '0.1未満'}</Text><Text style={styles.resultCaption}>今回の条件で見分けられた段階</Text></View>
              {testEye === 'right' && <Button label="左目もチェックする" onPress={() => { setTestEye('left'); setLevelIndex(0); setTrialIndex(0); setLevelCorrect(0); setBestAcuity(0); directionDeck.current = []; setCurrentDirection(nextDirection()); setStep('test'); }} />}
              {testEye === 'right' && <Button label="今日はここまで" onPress={finish} />}
              {cameraActive && selectedCamera && <View style={styles.resultCamera}><Camera key={`camera-${selectedCamera.id}`} {...detector.camera} style={StyleSheet.absoluteFill} device={selectedCamera} isActive mirrorMode={selectedCamera.position === 'front' ? 'on' : 'off'} /><Text style={styles.cameraPipText}>{distanceCm ? `距離 約${Math.round(distanceCm)}cm` : '距離確認中'}</Text></View>}
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

function Button({ label, onPress, disabled = false }: { label: string; onPress: () => void; disabled?: boolean }) {
  return <Pressable disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.button, pressed && styles.buttonPressed, disabled && styles.buttonDisabled]}><Text style={styles.buttonText}>{label}<Text style={styles.buttonArrow}>  →</Text></Text></Pressable>;
}

function TextButton({ label, onPress, disabled = false }: { label: string; onPress: () => void; disabled?: boolean }) {
  return <Pressable disabled={disabled} onPress={onPress} style={styles.textButton}><Text style={[styles.textButtonText, disabled && { opacity: 0.4 }]}>{label}</Text></Pressable>;
}

function AnswerButton({ dir, disabled, onPress }: { dir: (typeof DIRECTIONS)[number]; disabled: boolean; onPress: () => void }) {
  return <Pressable disabled={disabled} style={({ pressed }) => [styles.answerBtn, pressed && styles.answerPressed, disabled && styles.answerDisabled]} onPress={onPress}><Text style={styles.answerText}>{ARROWS[dir]}</Text></Pressable>;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#f4f5f1' },
  safe: { flex: 1, backgroundColor: '#f4f5f1' },
  header: { minHeight: 58, paddingHorizontal: 22, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#e3e7e1', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  brandRow: { flexDirection: 'row', gap: 9, alignItems: 'center' }, brandMark: { width: 27, height: 27, borderRadius: 14, backgroundColor: '#b8f06a', alignItems: 'center', justifyContent: 'center' }, brandMarkText: { fontSize: 11, color: '#213c31' }, brand: { fontSize: 17, fontWeight: '800', color: '#182321' }, topNote: { color: '#75817c', fontSize: 10, letterSpacing: 1 },
  scroll: { flexGrow: 1, paddingBottom: 24 }, content: { width: '100%', maxWidth: 500, alignSelf: 'center', paddingHorizontal: 24, paddingTop: 30, paddingBottom: 36 },
  eyebrow: { color: '#607064', fontSize: 11, fontWeight: '700', letterSpacing: 1.4, marginBottom: 15 }, heroTitle: { color: '#182321', fontSize: 39, fontWeight: '800', lineHeight: 51, letterSpacing: -1.8, marginBottom: 14 }, title: { color: '#182321', fontSize: 31, fontWeight: '800', lineHeight: 43, letterSpacing: -1, marginBottom: 10 }, body: { color: '#727d78', fontSize: 13, lineHeight: 22, marginBottom: 20 },
  artCard: { minHeight: 185, marginBottom: 17, borderRadius: 18, backgroundColor: '#e9ede6', alignItems: 'center', justifyContent: 'center' }, artCaption: { color: '#75817c', fontSize: 10, marginTop: 7 }, infoCard: { flexDirection: 'row', alignItems: 'center', gap: 13, padding: 15, marginBottom: 13, borderRadius: 12, borderWidth: 1, borderColor: '#e0e5dc', backgroundColor: 'rgba(255,255,255,0.45)' }, infoIcon: { width: 34, height: 34, borderRadius: 10, backgroundColor: '#e8eddf', textAlign: 'center', textAlignVertical: 'center', fontSize: 22, color: '#65775e', overflow: 'hidden' }, cardTitle: { color: '#182321', fontSize: 12, fontWeight: '700', marginBottom: 4 }, cardBody: { color: '#7a857f', fontSize: 10, lineHeight: 15 }, cardArrow: { color: '#99a39e', fontSize: 25 },
  button: { minHeight: 53, backgroundColor: '#b8f06a', borderRadius: 11, alignItems: 'center', justifyContent: 'center', marginTop: 4 }, buttonPressed: { backgroundColor: '#a9e657', transform: [{ scale: 0.99 }] }, buttonDisabled: { backgroundColor: '#dbe2d4' }, buttonText: { color: '#193023', fontSize: 13, fontWeight: '800' }, buttonArrow: { fontSize: 17, fontWeight: '500' }, textButton: { alignSelf: 'center', padding: 15 }, textButtonText: { color: '#7e8981', fontSize: 11 }, disclaimer: { color: '#9aa39d', fontSize: 9, lineHeight: 16, textAlign: 'center', marginTop: 16 },
  cameraPicker: { gap: 8, marginBottom: 15 }, cameraChip: { borderWidth: 1, borderColor: '#dfe5dc', borderRadius: 10, paddingVertical: 11, paddingHorizontal: 13 }, cameraChipSelected: { backgroundColor: '#21382f', borderColor: '#21382f' }, cameraChipTitle: { fontSize: 11, color: '#34443b', fontWeight: '700' }, cameraChipTitleSelected: { color: '#fff' }, cameraChipCaption: { marginTop: 3, fontSize: 9, color: '#849087' }, cameraChipCaptionSelected: { color: '#c1cec3' },
  preview: { height: 220, borderRadius: 15, backgroundColor: '#1d3028', overflow: 'hidden', alignItems: 'center', justifyContent: 'center', marginBottom: 15 }, previewTop: { position: 'absolute', top: 12, color: '#fff', fontSize: 10, zIndex: 2 }, previewBottom: { position: 'absolute', bottom: 12, color: '#d4dfd5', fontSize: 10, zIndex: 2 }, faceOval: { width: 120, height: 158, borderWidth: 1.5, borderColor: '#b8f06a', borderRadius: 70, opacity: 0.8 }, distanceCard: { flexDirection: 'row', gap: 12, alignItems: 'center', padding: 15, backgroundColor: '#e9ede6', borderRadius: 12, marginBottom: 14 }, distanceIcon: { fontSize: 23, color: '#71954c' }, error: { color: '#bd4e3f', fontSize: 11, lineHeight: 17, marginBottom: 10 }, helper: { color: '#858f88', fontSize: 10, lineHeight: 16, textAlign: 'center', marginTop: 12 },
  frontCameraNotice: { backgroundColor: '#e9ede6', borderRadius: 12, padding: 13, marginBottom: 12 }, frontCameraNoticeText: { color: '#526157', fontSize: 10, lineHeight: 16, marginBottom: 8 }, distanceReadout: { alignItems: 'center', paddingVertical: 23 }, distanceBig: { color: '#21382f', fontSize: 38, fontWeight: '700', letterSpacing: -1 }, statusPill: { color: '#718073', fontSize: 11, marginTop: 8, backgroundColor: '#e9ede6', borderRadius: 20, overflow: 'hidden', paddingHorizontal: 13, paddingVertical: 7 }, statusPillOk: { color: '#2b5036', backgroundColor: '#dff1c7' },
  testContent: { flex: 1, alignItems: 'center', paddingHorizontal: 20, paddingTop: 24, paddingBottom: 15 }, ringStage: { flex: 1, minHeight: 230, width: '100%', alignItems: 'center', justifyContent: 'center' }, warning: { color: '#a54436', fontSize: 11, marginVertical: 8, textAlign: 'center' }, cameraPip: { width: 120, height: 76, borderRadius: 9, backgroundColor: '#1d3028', overflow: 'hidden', alignSelf: 'flex-end', marginBottom: 8, justifyContent: 'flex-end' }, cameraPipText: { color: '#fff', fontSize: 9, backgroundColor: 'rgba(29,48,40,0.7)', padding: 4, textAlign: 'center' }, answerGrid: { width: 204, gap: 7, marginBottom: 6 }, answerRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 7 }, answerBtn: { width: 62, height: 56, borderRadius: 11, borderWidth: 1, borderColor: '#e0e5de', backgroundColor: 'rgba(255,255,255,0.75)', alignItems: 'center', justifyContent: 'center' }, answerPlaceholder: { width: 62, height: 56 }, answerPressed: { backgroundColor: '#b8f06a' }, answerDisabled: { opacity: 0.45 }, answerText: { color: '#283a32', fontSize: 24 }, testFoot: { color: '#9aa39d', fontSize: 9, marginTop: 6 },
  resultCard: { backgroundColor: '#20382f', borderRadius: 15, padding: 22, marginVertical: 24, alignItems: 'center' }, resultLabel: { color: '#c2d0c5', fontSize: 11 }, resultNumber: { color: '#fff', fontSize: 58, fontWeight: '500', marginVertical: 4 }, resultCaption: { color: '#c2d0c5', fontSize: 10 }, resultSummary: { width: '100%', padding: 14, backgroundColor: '#e9ede6', borderRadius: 12, marginBottom: 12 }, resultCamera: { width: 140, height: 84, borderRadius: 9, backgroundColor: '#1d3028', overflow: 'hidden', marginBottom: 16, justifyContent: 'flex-end' },
  accountRow: { marginTop: 16, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#dfe5dc', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, accountEmail: { color: '#75817c', fontSize: 10, flexShrink: 1 },
});
