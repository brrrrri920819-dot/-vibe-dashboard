/**
 * publisher/blogger.js
 * Google Blogger API v3 를 통해 Blogspot 글 발행
 * https://developers.google.com/blogger/docs/3.0/reference
 */

const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

const BLOGGER_API = 'https://www.googleapis.com/blogger/v3';
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const OAUTH_AUTH_URL  = 'https://accounts.google.com/o/oauth2/v2/auth';

/**
 * Refresh Token으로 Access Token 갱신
 */
async function refreshAccessToken(clientId, clientSecret, refreshToken) {
  const res = await axios.post(OAUTH_TOKEN_URL, new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  }).toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  return res.data.access_token;
}

/**
 * 글 발행
 */
async function publishToBlogger({
  clientId, clientSecret, refreshToken,
  blogId, title, content,
  tags = [], imagePaths = [], isDraft = false,
}) {
  try {
    const accessToken = await refreshAccessToken(clientId, clientSecret, refreshToken);

    // 이미지가 있으면 Google Photos API로 업로드 (또는 base64 embed)
    let finalContent = content;
    if (imagePaths.length > 0) {
      finalContent = await embedImages(content, imagePaths);
    }

    const body = {
      kind: 'blogger#post',
      title,
      content: finalContent,
      labels: tags,
    };

    const url = `${BLOGGER_API}/blogs/${blogId}/posts${isDraft ? '?isDraft=true' : ''}`;

    const res = await axios.post(url, body, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    const postUrl = res.data.url;
    console.log(`[Blogger] 발행 완료: ${postUrl}`);
    return { success: true, url: postUrl, postId: res.data.id, platform: 'blogger' };

  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    console.error('[Blogger] 발행 실패:', msg);
    return { success: false, error: msg, platform: 'blogger' };
  }
}

/** 로컬 이미지를 base64로 인라인 임베드 (소용량 전용, 대용량은 Cloudinary 사용 권장) */
async function embedImages(content, imagePaths) {
  let result = content;
  for (const imgPath of imagePaths) {
    if (!fs.existsSync(imgPath)) continue;
    try {
      const ext = path.extname(imgPath).toLowerCase().replace('.', '');
      const mimeMap = { jpg: 'jpeg', jpeg: 'jpeg', png: 'png', gif: 'gif', webp: 'webp' };
      const mime = `image/${mimeMap[ext] || 'jpeg'}`;
      const b64 = fs.readFileSync(imgPath).toString('base64');
      const dataUri = `data:${mime};base64,${b64}`;
      const placeholder = `[IMG:${path.basename(imgPath)}]`;
      result = result.replace(
        placeholder,
        `<img src="${dataUri}" alt="${path.basename(imgPath)}" style="max-width:100%;height:auto;display:block;margin:16px auto">`,
      );
    } catch (err) {
      console.warn(`[Blogger] 이미지 임베드 실패 (${imgPath}):`, err.message);
    }
  }
  return result;
}

/**
 * OAuth 인증 URL 생성
 */
function getBloggerAuthUrl(clientId, redirectUri) {
  const scope = 'https://www.googleapis.com/auth/blogger';
  return `${OAUTH_AUTH_URL}?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scope)}&response_type=code&access_type=offline&prompt=consent`;
}

/**
 * 인증 코드 → Refresh Token 교환
 */
async function exchangeBloggerToken(clientId, clientSecret, code, redirectUri) {
  const res = await axios.post(OAUTH_TOKEN_URL, new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  }).toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  return { accessToken: res.data.access_token, refreshToken: res.data.refresh_token };
}

/**
 * 블로그 ID 조회 (소유한 블로그 목록에서 찾기)
 */
async function getBloggerBlogId(clientId, clientSecret, refreshToken) {
  const accessToken = await refreshAccessToken(clientId, clientSecret, refreshToken);
  const res = await axios.get(`${BLOGGER_API}/users/self/blogs`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return res.data.items || [];
}

module.exports = { publishToBlogger, getBloggerAuthUrl, exchangeBloggerToken, getBloggerBlogId };
