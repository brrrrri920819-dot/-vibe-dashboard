/**
 * publisher/session.js
 * 아이디·비밀번호로 매번 로그인하는 대신, 이미 로그인된 쿠키를 쓴다.
 *
 * 왜 바꿨나:
 *   네이버·티스토리는 자동 로그인을 적극적으로 막는다.
 *   로그인 버튼 선택자를 맞춰놔도 캡차·기기 인증·화면 개편으로 금방 다시 깨진다.
 *   실제로 "로그인 버튼을 30초 기다리다 실패", "요소가 화면 밖" 같은 실패가 반복됐다.
 *
 *   쿠키를 한 번 넣어두면 로그인 단계를 통째로 건너뛴다.
 *   막힐 구간이 사라지므로 훨씬 덜 깨지고, 캡차도 마주치지 않는다.
 *   쿠키는 보통 몇 주에서 몇 달 유지된다.
 *
 * 넣는 방법(사람이 하는 일):
 *   브라우저에서 네이버/티스토리에 로그인한 상태로 쿠키를 복사해 설정에 붙여넣는다.
 *   확장앱이 뽑아주는 JSON 배열도, "a=1; b=2" 형태의 문자열도 모두 받는다.
 */

'use strict';

/**
 * 사람이 붙여넣은 쿠키를 플레이라이트가 쓰는 형태로 바꾼다.
 * @param {string} raw  JSON 배열 또는 "name=value; name2=value2"
 * @param {string} domain  기본 도메인 (예: '.naver.com')
 * @returns {{ok:boolean, cookies?:Array, error?:string}}
 */
function parseCookies(raw, domain) {
  const text = String(raw || '').trim();
  if (!text) return { ok: false, error: '쿠키가 비어 있습니다' };

  // 1) 확장앱이 내보낸 JSON 배열
  if (text.startsWith('[') || text.startsWith('{')) {
    let json;
    try { json = JSON.parse(text); } catch (e) {
      return { ok: false, error: `쿠키 JSON을 읽지 못했습니다 — 복사가 잘렸을 수 있습니다 (${e.message})` };
    }
    const list = Array.isArray(json) ? json : [json];
    const cookies = list
      .filter(c => c && c.name && c.value !== undefined)
      .map(c => normalize({
        name: String(c.name),
        value: String(c.value),
        domain: c.domain || domain,
        path: c.path || '/',
        expires: typeof c.expirationDate === 'number' ? Math.floor(c.expirationDate)
               : typeof c.expires === 'number' ? Math.floor(c.expires) : undefined,
        httpOnly: !!c.httpOnly,
        secure: c.secure !== false,
      }));
    if (!cookies.length) return { ok: false, error: '쿠키 목록이 비어 있습니다' };
    return { ok: true, cookies };
  }

  // 2) 브라우저 개발자도구에서 그대로 복사한 "a=1; b=2" 형태
  const cookies = text.split(/;\s*/)
    .map(part => {
      const i = part.indexOf('=');
      if (i <= 0) return null;
      return normalize({
        name: part.slice(0, i).trim(),
        value: part.slice(i + 1).trim(),
        domain, path: '/', httpOnly: false, secure: true,
      });
    })
    .filter(Boolean);

  if (!cookies.length) return { ok: false, error: '쿠키 형식을 알아보지 못했습니다' };
  return { ok: true, cookies };
}

/** 플레이라이트가 거부하지 않도록 값을 다듬는다 */
function normalize(c) {
  const out = {
    name: c.name,
    value: c.value,
    domain: c.domain.startsWith('.') || c.domain.startsWith('http') ? c.domain : `.${c.domain}`,
    path: c.path || '/',
    httpOnly: !!c.httpOnly,
    secure: c.secure !== false,
    sameSite: 'Lax',
  };
  // 만료가 이미 지났거나 이상하면 세션 쿠키로 둔다 (넣자마자 사라지는 걸 막는다)
  if (typeof c.expires === 'number' && c.expires > Date.now() / 1000) out.expires = c.expires;
  return out;
}

/**
 * 컨텍스트에 쿠키를 심는다.
 * @returns {{ok:boolean, count?:number, error?:string}}
 */
async function applyCookies(context, raw, domain) {
  const parsed = parseCookies(raw, domain);
  if (!parsed.ok) return parsed;
  try {
    await context.addCookies(parsed.cookies);
    return { ok: true, count: parsed.cookies.length };
  } catch (e) {
    return { ok: false, error: `쿠키를 넣지 못했습니다 — ${e.message}` };
  }
}

/** 로그인된 상태인지 확인 (로그인 화면으로 튕기면 쿠키가 만료된 것) */
function looksLoggedOut(url) {
  return /nid\.naver\.com|nidlogin|accounts\.kakao\.com|\/auth\/login|logIn/i.test(String(url || ''));
}

module.exports = { parseCookies, applyCookies, looksLoggedOut };
