<?php
// Roody credits proxy — Hostinger/PHP version.
// The extension POSTs { code, kind, model, body }; we validate the invite
// code, burn a credit on brain calls, and forward to Gemini with the
// founder's key (which lives in roody-config.php, never in the extension).

header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Headers: content-type');
header('Access-Control-Allow-Methods: POST, OPTIONS');
header('Content-Type: application/json');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(200); exit; }
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
  http_response_code(405); echo json_encode(['error' => 'method']); exit;
}

// Config: prefer the copy ABOVE public_html (not web-accessible), fall back
// to same folder for quick tests.
$configPath = file_exists(__DIR__ . '/../roody-config.php')
  ? __DIR__ . '/../roody-config.php'
  : __DIR__ . '/roody-config.php';
if (!file_exists($configPath)) {
  http_response_code(500); echo json_encode(['error' => 'no-config']); exit;
}
$cfg = require $configPath;

// Only the models Roody uses — nobody farms the key as a general endpoint.
$ALLOWED_MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-preview-tts'];

$payload = json_decode(file_get_contents('php://input'), true);
$code  = isset($payload['code'])  ? trim($payload['code'])  : '';
$kind  = isset($payload['kind'])  ? $payload['kind']         : '';
$model = isset($payload['model']) ? $payload['model']        : '';
$body  = isset($payload['body'])  ? $payload['body']         : null;

if ($code === '' || $model === '' || $body === null) {
  http_response_code(400); echo json_encode(['error' => 'missing-fields']); exit;
}
if (!in_array($model, $ALLOWED_MODELS, true)) {
  http_response_code(400); echo json_encode(['error' => 'model-not-allowed']); exit;
}
if (!in_array($kind, ['brain', 'tts', 'stt'], true)) {
  http_response_code(400); echo json_encode(['error' => 'bad-kind']); exit;
}

try {
  $pdo = new PDO(
    "mysql:host={$cfg['db_host']};dbname={$cfg['db_name']};charset=utf8mb4",
    $cfg['db_user'], $cfg['db_pass'],
    [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]
  );

  // Validate the code.
  $stmt = $pdo->prepare('SELECT daily_limit FROM codes WHERE code = ? AND active = 1');
  $stmt->execute([$code]);
  $row = $stmt->fetch(PDO::FETCH_ASSOC);
  if (!$row) {
    http_response_code(403); echo json_encode(['error' => 'invalid-code']); exit;
  }

  // Brain calls burn a credit; tts/stt ride along on a valid code.
  if ($kind === 'brain') {
    $limit = (int)$row['daily_limit'];
    // Atomic increment, then check — slight overcount past the limit is
    // harmless since the request gets rejected anyway.
    $pdo->prepare(
      'INSERT INTO usage_log (code, day, count) VALUES (?, CURDATE(), 1)
       ON DUPLICATE KEY UPDATE count = count + 1'
    )->execute([$code]);
    $q = $pdo->prepare('SELECT count FROM usage_log WHERE code = ? AND day = CURDATE()');
    $q->execute([$code]);
    $used = (int)$q->fetchColumn();
    if ($used > $limit) {
      http_response_code(402);
      echo json_encode(['error' => 'out-of-credits', 'used' => $used, 'limit' => $limit]);
      exit;
    }
  }
} catch (Exception $e) {
  http_response_code(500); echo json_encode(['error' => 'db', 'detail' => $e->getMessage()]); exit;
}

// Forward to Gemini.
$ch = curl_init("https://generativelanguage.googleapis.com/v1beta/models/{$model}:generateContent");
curl_setopt_array($ch, [
  CURLOPT_POST => true,
  CURLOPT_RETURNTRANSFER => true,
  CURLOPT_HTTPHEADER => [
    'Content-Type: application/json',
    'x-goog-api-key: ' . $cfg['gemini_key'],
  ],
  CURLOPT_POSTFIELDS => json_encode($body),
  CURLOPT_TIMEOUT => 60,       // TTS can take ~10s; leave headroom
  CURLOPT_CONNECTTIMEOUT => 10,
]);
$response = curl_exec($ch);
$status   = curl_getinfo($ch, CURLINFO_HTTP_CODE);
$err      = curl_error($ch);
curl_close($ch);

if ($response === false) {
  http_response_code(502); echo json_encode(['error' => 'gemini-unreachable', 'detail' => $err]); exit;
}
http_response_code($status ?: 200);
echo $response;
