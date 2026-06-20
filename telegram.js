/**
 * telegram.js — 텔레그램 봇 발행 완료 알림
 * Bot Token: @BotFather 에서 발급
 * Chat ID: @userinfobot 에서 확인
 */

const https = require('https');

function sendTelegram(token, chatId, text) {
  if (!token || !chatId) return Promise.resolve(); // 미설정 시 조용히 스킵

  const body = JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' });
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${token}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      res.resume();
      res.on('end', resolve);
    });
    req.on('error', (err) => {
      console.error('[Telegram] 전송 실패:', err.message);
      resolve();
    });
    req.write(body);
    req.end();
  });
}

/**
 * 발행 완료 메시지 생성 후 전송
 * @param {string} title - 글 제목
 * @param {object} results - { naver: {success, url}, tistory: ..., blogger: ... }
 */
async function notifyPublished(title, results) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  const ICONS = { naver: '🟢 네이버', tistory: '🟠 티스토리', blogger: '🔵 블로그스팟' };
  const lines = [];

  for (const [platform, r] of Object.entries(results)) {
    const label = ICONS[platform] || platform;
    if (r.success) {
      lines.push(`${label} ✅ <a href="${r.url}">${r.url}</a>`);
    } else {
      lines.push(`${label} ❌ ${r.error || '실패'}`);
    }
  }

  const allOk  = Object.values(results).every(r => r.success);
  const header = allOk ? '🚀 발행 완료!' : '⚠️ 일부 플랫폼 발행 실패';

  const msg = `${header}\n\n<b>${title}</b>\n\n${lines.join('\n')}`;
  await sendTelegram(token, chatId, msg);
  console.log('[Telegram] 알림 전송 완료');
}

module.exports = { notifyPublished };
