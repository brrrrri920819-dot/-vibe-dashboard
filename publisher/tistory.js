/**
 * publisher/tistory.js
 * Tistory Open API (OAuth 2.0) 를 통해 글 발행
 * https://tistory.github.io/document-tistory-apis/
 */

const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

const API_BASE = 'https://www.tistory.com/apis';

/**
 * 글 발행
 * @param {object} opts
 * @param {string} opts.accessToken  - OAuth 액세스 토큰
 * @param {string} opts.blogName     - 블로그명 (서브도메인)
 * @param {string} opts.title
 * @param {string} opts.content      - HTML 본문
 * @param {string[]} opts.tags
 * @param {string[]} opts.imagePaths - 업로드할 로컬 이미지 경로
 * @param {string} opts.categoryId   - 카테고리 ID (선택)
 * @param {string} opts.visibility   - '0' 비공개, '3' 공개 (기본 공개)
 */
async function publishToTistory({
  accessToken, blogName, title, content,
  tags = [], imagePaths = [], categoryId = '', visibility = '3',
}) {
  try {
    // ── 1. 이미지 먼저 업로드 후 URL 교체 ──────────
    let finalContent = content;
    if (imagePaths.length > 0) {
      finalContent = await uploadAndReplaceImages(accessToken, blogName, content, imagePaths);
    }

    // ── 2. 글 발행 ────────────────────────────────
    const params = new URLSearchParams({
      access_token: accessToken,
      output: 'json',
      blogName,
      title,
      content: finalContent,
      visibility,
      published: '',
      tag: tags.slice(0, 20).join(','),
    });

    if (categoryId) params.append('category', categoryId);

    const res = await axios.post(`${API_BASE}/post/write`, params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    const data = res.data?.tistory;
    if (data?.status === '200') {
      const postUrl = `https://${blogName}.tistory.com/${data.postId}`;
      console.log(`[Tistory] 발행 완료: ${postUrl}`);
      return { success: true, url: postUrl, postId: data.postId, platform: 'tistory' };
    }

    throw new Error(data?.error_message || '알 수 없는 오류');

  } catch (err) {
    console.error('[Tistory] 발행 실패:', err.message);
    return { success: false, error: err.message, platform: 'tistory' };
  }
}

/** 이미지 업로드 후 content 내 플레이스홀더를 실제 URL로 교체 */
async function uploadAndReplaceImages(accessToken, blogName, content, imagePaths) {
  let result = content;
  for (const imgPath of imagePaths) {
    if (!fs.existsSync(imgPath)) continue;
    try {
      const form = new FormData();
      form.append('access_token', accessToken);
      form.append('output', 'json');
      form.append('blogName', blogName);
      form.append('uploadedfile', fs.createReadStream(imgPath));

      const res = await axios.post(`${API_BASE}/post/attach`, form, {
        headers: form.getHeaders(),
      });

      const imgUrl = res.data?.tistory?.url;
      if (imgUrl) {
        const placeholder = `[IMG:${path.basename(imgPath)}]`;
        result = result.replace(placeholder, `<img src="${imgUrl}" alt="${path.basename(imgPath)}" style="max-width:100%">`);
        console.log(`[Tistory] 이미지 업로드 완료: ${imgUrl}`);
      }
    } catch (err) {
      console.warn(`[Tistory] 이미지 업로드 실패 (${imgPath}):`, err.message);
    }
  }
  return result;
}

/**
 * 카테고리 목록 조회
 */
async function getTistoryCategories(accessToken, blogName) {
  const res = await axios.get(`${API_BASE}/category/list`, {
    params: { access_token: accessToken, output: 'json', blogName },
  });
  return res.data?.tistory?.item?.categories || [];
}

/**
 * OAuth 인증 URL 생성 (사용자가 브라우저에서 열어서 토큰 받아오는 용)
 */
function getTistoryAuthUrl(clientId, redirectUri) {
  return `https://www.tistory.com/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code`;
}

/**
 * 인증 코드로 액세스 토큰 교환
 */
async function exchangeTistoryToken(clientId, clientSecret, code, redirectUri) {
  const res = await axios.get('https://www.tistory.com/oauth/access_token', {
    params: {
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      code,
      grant_type: 'authorization_code',
    },
  });
  // 응답: "access_token=xxxxx"
  const match = res.data.match(/access_token=([^&]+)/);
  if (!match) throw new Error(`티스토리 토큰 발급 실패 (응답: ${res.data.slice(0, 100)})`);
  return match[1];
}

module.exports = { publishToTistory, getTistoryCategories, getTistoryAuthUrl, exchangeTistoryToken };
