const screens = [...document.querySelectorAll('.screen')];
const distancesCm = 250;
const acuityLevels = [0.1, 0.2, 0.3, 0.5, 0.7, 0.8, 1.0, 1.2];
const directions = ['up', 'up-right', 'right', 'down-right', 'down', 'down-left', 'left', 'up-left'];
const directionAngle = {
  right: 0,
  'down-right': 45,
  down: 90,
  'down-left': 135,
  left: 180,
  'up-left': 225,
  up: 270,
  'up-right': 315,
};
let cardWidthPx = 150;
let eye = 'right';
let levelIndex = 0;
let trialIndex = 0;
let correctThisLevel = 0;
let bestAcuity = 0;
let results = { right: null, left: null };
let targetDirection = 'up';
let directionDeck = [];
let previousDirection = null;

function showScreen(id) {
  screens.forEach(screen => screen.classList.toggle('active', screen.id === id));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

document.getElementById('startBtn').addEventListener('click', () => showScreen('calibrate'));
document.getElementById('calibratedBtn').addEventListener('click', () => showScreen('ready'));
document.querySelectorAll('.back-btn').forEach(button => button.addEventListener('click', () => showScreen(button.dataset.back)));

const calibration = document.getElementById('calibration');
function fitCalibrationSlider() {
  const available = Math.max(120, document.querySelector('.calibration-stage').clientWidth - 30);
  calibration.max = String(Math.min(320, available));
  calibration.value = String(Math.min(150, Number(calibration.max)));
  updateCalibration();
}
function updateCalibration() {
  cardWidthPx = Number(calibration.value);
  const coin = document.querySelector('.coin-outline');
  coin.style.width = `${cardWidthPx}px`;
  coin.style.height = `${cardWidthPx}px`;
  coin.style.borderRadius = '50%';
  const delta = Math.round((cardWidthPx - 150) / 150 * 100);
  document.getElementById('scaleReadout').textContent = delta === 0 ? '標準' : `${delta > 0 ? '+' : ''}${delta}%`;
}
calibration.addEventListener('input', updateCalibration);
fitCalibrationSlider();
window.addEventListener('resize', fitCalibrationSlider);

document.getElementById('beginTestBtn').addEventListener('click', () => beginEye('right'));
document.getElementById('quitBtn').addEventListener('click', () => showScreen('intro'));
document.getElementById('otherEyeBtn').addEventListener('click', () => beginEye('left'));
document.getElementById('finishBtn').addEventListener('click', () => showScreen('intro'));
document.getElementById('restartBtn').addEventListener('click', () => {
  results = { right: null, left: null };
  showScreen('calibrate');
});

function beginEye(which) {
  eye = which;
  levelIndex = 0;
  trialIndex = 0;
  correctThisLevel = 0;
  bestAcuity = 0;
  directionDeck = [];
  previousDirection = null;
  document.getElementById('eyeLabel').textContent = `${which === 'right' ? '右' : '左'}目をチェック中`;
  showScreen('test');
  nextQuestion();
}

function drawRandomDirection() {
  if (directionDeck.length === 0) {
    directionDeck = [...directions];
    for (let i = directionDeck.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [directionDeck[i], directionDeck[j]] = [directionDeck[j], directionDeck[i]];
    }
    // Avoid an identical direction where two shuffled groups meet.
    if (directionDeck[0] === previousDirection) {
      const swapIndex = 1 + Math.floor(Math.random() * (directionDeck.length - 1));
      [directionDeck[0], directionDeck[swapIndex]] = [directionDeck[swapIndex], directionDeck[0]];
    }
  }
  previousDirection = directionDeck.shift();
  return previousDirection;
}

function nextQuestion() {
  if (levelIndex >= acuityLevels.length) return finishEye(bestAcuity);
  const level = acuityLevels[levelIndex];
  targetDirection = drawRandomDirection();
  trialIndex += 1;
  document.getElementById('progressLabel').textContent = `段階 ${levelIndex + 1} / ${acuityLevels.length} ・ 問題 ${trialIndex} / 3`;
  document.getElementById('progressBar').style.width = `${Math.min(100, ((levelIndex * 3 + trialIndex - 1) / (acuityLevels.length * 3)) * 100)}%`;

  // A Landolt C is five times the angular width of its gap. At acuity 1.0,
  // the gap subtends one arcminute at the selected viewing distance.
  const distanceMm = distancesCm * 10;
  const gapMm = distanceMm * Math.tan((Math.PI / 180 / 60) / level);
  const diameterMm = gapMm * 5;
  const pixelsPerMm = cardWidthPx / 23.5;
  const diameterPx = diameterMm * pixelsPerMm;
  document.getElementById('optotype').style.setProperty('--ring-size', `${diameterPx}px`);
  // Draw the complete ring, then cut a radial slot from its center outward.
  // Rotating the slot makes all eight gap directions unambiguous.
  const angle = directionAngle[targetDirection];
  document.getElementById('optotype').innerHTML = `
    <circle cx="50" cy="50" r="40" fill="none" stroke="#17241f" stroke-width="20"/>
    <rect x="50" y="40" width="60" height="20" fill="#f4f5f1" transform="rotate(${angle} 50 50)"/>
  `;
}

function answer(direction) {
  if (direction === targetDirection) correctThisLevel += 1;
  if (trialIndex < 3) {
    nextQuestion();
    return;
  }
  if (correctThisLevel >= 2) {
    bestAcuity = acuityLevels[levelIndex];
    levelIndex += 1;
    trialIndex = 0;
    correctThisLevel = 0;
    nextQuestion();
  } else {
    finishEye(bestAcuity);
  }
}

document.querySelectorAll('.answer-btn').forEach(button => button.addEventListener('click', () => answer(button.dataset.dir)));
document.getElementById('unsureBtn').addEventListener('click', () => answer('unsure'));

function finishEye(value) {
  results[eye] = value;
  document.getElementById('resultEye').textContent = `${eye === 'right' ? '右' : '左'}目の目安`;
  document.getElementById('resultValue').textContent = value ? value.toFixed(1) : '0.1未満';
  document.getElementById('resultMeter').style.width = `${value ? Math.max(7, Math.min(100, value / 1.5 * 100)) : 3}%`;
  const message = value >= 1 ? 'この条件では、1.0以上の段階まで見分けられました。' : value > 0 ? '見え方が気になる場合は、眼科での検査もご検討ください。' : 'この条件では、最初の段階を見分けにくかったようです。眼科での検査をご検討ください。';
  document.getElementById('resultMessage').textContent = message;
  const otherEyeBtn = document.getElementById('otherEyeBtn');
  otherEyeBtn.style.display = eye === 'right' ? '' : 'none';
  if (eye === 'right') otherEyeBtn.textContent = '左目もチェックする　→';
  showScreen('result');
}
