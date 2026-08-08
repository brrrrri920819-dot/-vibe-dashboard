/**
 * affiliates/tracking.js
 * 상품 링크에 '내 추적 ID'를 붙인다.
 *
 * 이게 없으면 수익은 0원이다.
 * 제휴 수익은 "누가 소개해서 팔렸는지"를 추적 ID로 판별한다.
 * 추적 ID 없는 상품 링크는 그냥 남의 쇼핑몰 링크일 뿐이고,
 * 독자가 아무리 눌러 구매해도 한 푼도 들어오지 않는다.
 *
 * 예전에는 제휴 블록에 제휴사 '가입 페이지' 주소(partners.coupang.com 등)를
 * 넣고 있었다. 독자가 누르면 쿠팡 가입 화면으로 갔다. 수익이 날 수 없는 구조였다.
 */

'use strict';

/** 추적 ID가 없으면 수익이 없다는 것을 호출한 쪽이 알 수 있게 한다 */
function trackingStatus(tokens) {
  const coupang = (tokens.get('COUPANG_PARTNERS_TAG') || '').trim();
  const naver   = (tokens.get('NAVER_CONNECT_ID') || '').trim();
  const any = !!(coupang || naver);
  return {
    ok: any,
    coupang: !!coupang,
    naver: !!naver,
    reason: any ? null
      : '제휴 추적 ID가 없습니다 — 지금 넣는 링크로는 수익이 발생하지 않습니다. '
      + '쿠팡파트너스(COUPANG_PARTNERS_TAG) 또는 네이버 쇼핑커넥트(NAVER_CONNECT_ID) ID를 설정에 넣으세요',
  };
}

/**
 * 상품 주소에 추적 ID를 붙인다.
 * 붙일 수 없으면 붙이지 않고, 그 사실을 함께 돌려준다 (속이지 않는다).
 * @returns {{url:string, tracked:boolean, network:string|null}}
 */
function withTracking(rawUrl, tokens) {
  const url = String(rawUrl || '').trim();
  if (!/^https?:\/\//i.test(url)) return { url, tracked: false, network: null };

  let u;
  try { u = new URL(url); } catch { return { url, tracked: false, network: null }; }

  // ── 쿠팡 ────────────────────────────────────────────────
  if (/(^|\.)coupang\.com$/i.test(u.hostname)) {
    const tag = (tokens.get('COUPANG_PARTNERS_TAG') || '').trim();
    if (!tag) return { url, tracked: false, network: 'coupang' };
    // 쿠팡파트너스는 lptag 로 추적한다. 이미 있으면 덮어쓰지 않는다.
    if (!u.searchParams.get('lptag')) u.searchParams.set('lptag', tag);
    return { url: u.toString(), tracked: true, network: 'coupang' };
  }

  // ── 네이버 쇼핑 / 스마트스토어 ──────────────────────────
  if (/(^|\.)(naver\.com|smartstore\.naver\.com|shopping\.naver\.com)$/i.test(u.hostname)) {
    const id = (tokens.get('NAVER_CONNECT_ID') || '').trim();
    if (!id) return { url, tracked: false, network: 'naver' };
    if (!u.searchParams.get('nt_source')) {
      u.searchParams.set('nt_source', 'connect');
      u.searchParams.set('nt_medium', 'affiliate');
      u.searchParams.set('nt_detail', id);
    }
    return { url: u.toString(), tracked: true, network: 'naver' };
  }

  return { url, tracked: false, network: null };
}

/**
 * 상품 목록 전체에 추적 ID를 붙인다.
 * @returns {{products:Array, trackedCount:number, total:number}}
 */
function trackAll(products, tokens) {
  const list = Array.isArray(products) ? products : [];
  let trackedCount = 0;
  const out = list.map(p => {
    const t = withTracking(p.link, tokens);
    if (t.tracked) trackedCount++;
    return { ...p, link: t.url, tracked: t.tracked, network: t.network };
  });
  return { products: out, trackedCount, total: out.length };
}

/** 추적 ID가 없을 때 화면에 띄울 경고 (글에는 넣지 않는다) */
function warnIfUntracked(status) {
  if (status.ok) return null;
  return {
    key: 'no_affiliate_tracking',
    severity: 'high',
    title: '제휴 링크에 수익 추적이 안 붙어 있습니다',
    detail: '지금 넣는 상품 링크로는 구매가 일어나도 수익이 0원입니다.',
    action: '설정 탭에서 쿠팡파트너스 ID(COUPANG_PARTNERS_TAG) 입력',
  };
}

module.exports = { withTracking, trackAll, trackingStatus, warnIfUntracked };
