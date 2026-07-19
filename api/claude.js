// api/claude.js
// 프론트엔드는 이 엔드포인트만 호출합니다. Anthropic API 키는 여기, 서버 환경변수에만 존재합니다.
// Vercel 배포 시: 프로젝트 설정 > Environment Variables 에 ANTHROPIC_API_KEY를 등록하세요.

const RATE_LIMIT_WINDOW_MS = 60_000; // 1분
const RATE_LIMIT_MAX = 15;           // IP당 1분에 최대 15요청
const MAX_PROMPT_CHARS = 12000;      // 과도하게 긴 요청으로 인한 비용 폭탄 방지 (통합 프롬프트가 로컬 표본 98개를 포함할 수 있어 여유있게 설정)

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 529]); // 529 = Anthropic "overloaded"
const MAX_RETRIES = 2;
const BASE_DELAY_MS = 600; // 재시도 간격: 600ms → 1200ms (지수 백오프)

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function callAnthropicWithRetry(apiKey, body) {
  let lastErrText = '';
  let lastStatus = 0;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body)
    });

    if (res.ok) return { ok: true, data: await res.json() };

    lastStatus = res.status;
    lastErrText = await res.text();

    const canRetry = RETRYABLE_STATUS.has(res.status) && attempt < MAX_RETRIES;
    if (!canRetry) break;

    const delay = BASE_DELAY_MS * Math.pow(2, attempt); // 600ms, 1200ms...
    console.warn(`Anthropic API ${res.status}, ${delay}ms 후 재시도 (${attempt + 1}/${MAX_RETRIES})`);
    await sleep(delay);
  }

  return { ok: false, status: lastStatus, errText: lastErrText };
}

// 주의: 서버리스 함수는 인스턴스가 재사용되지 않으면 이 메모리가 초기화됩니다.
// 트래픽이 늘어나면 Upstash Redis 등 외부 저장소 기반 rate limit으로 교체를 권장합니다.
const requestLog = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  const timestamps = (requestLog.get(ip) || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  timestamps.push(now);
  requestLog.set(ip, timestamps);
  return timestamps.length > RATE_LIMIT_MAX;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST 요청만 허용됩니다.' });
    return;
  }

  const ip =
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    'unknown';

  if (isRateLimited(ip)) {
    res.status(429).json({ error: '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.' });
    return;
  }

  const { messages } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: 'messages가 필요합니다.' });
    return;
  }

  const totalChars = messages.reduce(
    (sum, m) => sum + (typeof m.content === 'string' ? m.content.length : 0),
    0
  );
  if (totalChars > MAX_PROMPT_CHARS) {
    res.status(400).json({ error: '요청 내용이 너무 깁니다.' });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다.');
    res.status(500).json({ error: '서버 설정 오류입니다. 관리자에게 문의하세요.' });
    return;
  }

  try {
    const result = await callAnthropicWithRetry(apiKey, {
      // 모델과 max_tokens는 서버에서 고정합니다. 클라이언트가 임의로 바꿀 수 없게 하기 위함입니다.
      model: 'claude-sonnet-4-6',
      max_tokens: 1400,
      messages
    });

    if (!result.ok) {
      console.error('Anthropic API 오류 (재시도 후에도 실패):', result.status, result.errText);
      if (result.status === 429 || result.status === 529) {
        res.status(429).json({ error: '지금 이용자가 많아 잠시 지연되고 있습니다. 잠시 후 다시 시도해 주세요.' });
      } else {
        res.status(502).json({ error: 'AI 서비스 호출에 실패했습니다.' });
      }
      return;
    }

    res.status(200).json(result.data);
  } catch (err) {
    console.error('서버 오류:', err);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
};
