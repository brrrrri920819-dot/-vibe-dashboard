/**
 * content/adsense-pages.js
 * 애드센스 심사에 필요한 고정 페이지 3종 생성
 *
 * 심사에서 "소개 / 개인정보처리방침 / 문의" 페이지가 없거나 부실하면
 * 사이트 신뢰도가 낮게 평가되어 거절 사유가 된다. 글 개수를 채워도
 * 이 3개가 빠지면 통과가 어렵기 때문에 별도로 발행할 수 있게 한다.
 */

const S = 'font-size:15px;line-height:1.9;color:#333';

function introPage({ blogName, topic, ownerName }) {
  return {
    title: '블로그 소개',
    tags: ['블로그소개', '소개'],
    content: `<div style="${S}">
<h2>${blogName} 을(를) 찾아주셔서 감사합니다</h2>
<p>이 블로그는 <strong>${topic}</strong> 분야의 정보를 정리해 두는 공간입니다.
검색으로 들어오신 분이 궁금한 점을 한 번에 해결하고 돌아가실 수 있도록,
한 주제를 끝까지 다루는 글을 쓰려고 합니다.</p>

<h2>어떤 글을 다루나요</h2>
<ul>
<li>${topic} 관련 제도·조건·절차를 실제로 따라 할 수 있게 정리한 글</li>
<li>선택지가 여러 개일 때 조건별로 비교한 글</li>
<li>흔히 놓치는 주의사항과 예외 사항을 짚은 글</li>
</ul>

<h2>글을 쓰는 기준</h2>
<p>내용은 공식 자료와 공개된 통계를 우선 근거로 삼습니다.
확인되지 않은 내용은 단정하지 않고, 기준일이나 출처가 필요한 정보에는 이를 함께 적습니다.
제도나 금액처럼 시간이 지나면 달라지는 정보는 확인 시점을 밝히니,
실제 이용 전에는 해당 기관의 최신 공지를 한 번 더 확인해 주세요.</p>

<h2>운영자</h2>
<p>${ownerName}</p>
<p>문의는 <strong>문의하기</strong> 페이지를 이용해 주세요. 정정이 필요한 내용을 알려주시면 확인 후 반영하겠습니다.</p>
</div>`,
  };
}

function privacyPage({ blogName, contactEmail, siteUrl }) {
  const today = new Date().toISOString().slice(0, 10);
  return {
    title: '개인정보처리방침',
    tags: ['개인정보처리방침'],
    content: `<div style="${S}">
<p>${blogName}(이하 '본 사이트')은 이용자의 개인정보를 중요하게 생각하며,
「개인정보 보호법」 등 관련 법령을 준수합니다. 본 방침은 본 사이트가 어떤 정보를
어떤 목적으로 수집·이용하는지 안내합니다.</p>

<h2>1. 수집하는 정보와 방법</h2>
<p>본 사이트는 회원가입 절차가 없으며, 이름·연락처 등을 직접 입력받아 수집하지 않습니다.
다만 서비스 이용 과정에서 아래 정보가 자동으로 생성·수집될 수 있습니다.</p>
<ul>
<li>접속 IP 주소, 브라우저 종류 및 버전, 운영체제</li>
<li>방문 일시, 방문한 페이지, 이전 방문 경로</li>
<li>쿠키(Cookie)에 저장되는 이용 기록</li>
</ul>

<h2>2. 이용 목적</h2>
<ul>
<li>사이트 이용 현황 분석 및 콘텐츠 개선</li>
<li>이용자 환경에 맞는 광고 제공</li>
<li>부정 이용 방지 및 서비스 안정성 확보</li>
</ul>

<h2>3. 광고 및 쿠키</h2>
<p>본 사이트는 제3자 광고 서비스를 이용하며, 구글을 포함한 광고 사업자는
쿠키를 사용해 이용자의 이전 방문 기록을 바탕으로 광고를 제공할 수 있습니다.</p>
<ul>
<li>구글의 광고 쿠키 사용에 대한 안내: <a href="https://policies.google.com/technologies/ads" target="_blank" rel="nofollow noopener">Google 광고 정책</a></li>
<li>맞춤 광고를 원하지 않으시면 <a href="https://adssettings.google.com" target="_blank" rel="nofollow noopener">Google 광고 설정</a>에서 해제할 수 있습니다.</li>
<li>브라우저 설정에서 쿠키 저장을 거부할 수 있으며, 이 경우 일부 기능 이용에 제한이 생길 수 있습니다.</li>
</ul>

<h2>4. 보유 및 이용 기간</h2>
<p>자동 수집된 정보는 수집 목적이 달성되면 지체 없이 파기합니다.
다만 관련 법령에서 별도의 보존 기간을 정한 경우 해당 기간 동안 보관합니다.</p>

<h2>5. 제3자 제공</h2>
<p>본 사이트는 이용자의 개인정보를 제3자에게 제공하지 않습니다.
다만 법령에 따라 수사기관이 적법한 절차로 요구하는 경우에는 예외로 합니다.</p>

<h2>6. 이용자의 권리</h2>
<p>이용자는 언제든지 자신의 정보에 대한 열람·정정·삭제를 요청할 수 있습니다.
요청은 아래 연락처로 접수해 주시면 지체 없이 처리하겠습니다.</p>

<h2>7. 링크된 사이트</h2>
<p>본 사이트에는 외부 사이트로 연결되는 링크가 포함될 수 있습니다.
링크된 사이트의 개인정보 처리에 대해서는 본 사이트가 책임지지 않으므로,
해당 사이트의 방침을 별도로 확인해 주세요.</p>

<h2>8. 문의처</h2>
<ul>
<li>사이트: ${siteUrl || '-'}</li>
<li>이메일: ${contactEmail}</li>
</ul>

<h2>9. 방침 변경</h2>
<p>법령이나 서비스 내용이 바뀌면 본 방침을 개정할 수 있으며,
변경 시 이 페이지를 통해 공지합니다.</p>

<p><strong>시행일: ${today}</strong></p>
</div>`,
  };
}

function contactPage({ blogName, contactEmail }) {
  return {
    title: '문의하기',
    tags: ['문의', '연락처'],
    content: `<div style="${S}">
<h2>문의 안내</h2>
<p>${blogName} 에 관한 문의는 아래 이메일로 보내주세요.
확인 후 순서대로 답변드리며, 보통 2~3일 이내에 회신하고 있습니다.</p>

<p style="font-size:17px;margin:20px 0"><strong>📮 ${contactEmail}</strong></p>

<h2>이런 내용을 보내주세요</h2>
<ul>
<li><strong>내용 정정 요청</strong> — 글에 잘못되거나 오래된 정보가 있는 경우,
해당 글 주소와 함께 알려주시면 확인 후 수정하겠습니다.</li>
<li><strong>저작권 관련</strong> — 이미지나 인용에 문제가 있다면 알려주세요. 확인 즉시 조치하겠습니다.</li>
<li><strong>제휴·광고 문의</strong> — 제안 내용과 연락 가능한 정보를 함께 적어주세요.</li>
<li><strong>주제 제안</strong> — 다뤘으면 하는 주제가 있으면 편하게 알려주세요.</li>
</ul>

<h2>답변이 어려운 문의</h2>
<p>본 사이트의 글은 일반적인 정보 제공을 목적으로 합니다.
개인의 구체적인 사정에 대한 법률·세무·의료 판단은 드릴 수 없으니,
해당 분야의 전문가나 관계 기관에 문의해 주세요.</p>
</div>`,
  };
}

/** 3종 페이지 일괄 생성 */
function buildAdsensePages(opts = {}) {
  const cfg = {
    blogName:     opts.blogName     || '이 블로그',
    topic:        opts.topic        || '생활 정보',
    ownerName:    opts.ownerName    || '블로그 운영자',
    contactEmail: opts.contactEmail || '',
    siteUrl:      opts.siteUrl      || '',
  };
  if (!cfg.contactEmail) throw new Error('연락받을 이메일 주소가 필요합니다');
  return [introPage(cfg), privacyPage(cfg), contactPage(cfg)];
}

module.exports = { buildAdsensePages };
