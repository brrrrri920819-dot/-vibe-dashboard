#!/bin/bash
# 블로그 자동 발행 시스템 초기 설정 스크립트
# 사용법: bash setup.sh

set -e

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " 블로그 자동 발행 시스템 설치"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Node.js 의존성 설치
echo "[1/3] npm 패키지 설치 중..."
npm install

# Playwright Chromium 설치
echo "[2/3] Playwright Chromium 설치 중..."
npx playwright install chromium

# .env 파일 생성
if [ ! -f .env ]; then
  echo "[3/3] .env 파일 생성 중..."
  cp .env.example .env
  echo ""
  echo "⚠️  .env 파일이 생성되었습니다."
  echo "    다음 정보를 입력해주세요:"
  echo "    - DASHBOARD_PASSWORD"
  echo "    - NAVER_ID, NAVER_PW, NAVER_BLOG_ID"
  echo "    - TISTORY_* (OAuth 인증 후 토큰)"
  echo "    - BLOGGER_* (OAuth 인증 후 토큰)"
else
  echo "[3/3] .env 파일이 이미 존재합니다. 스킵."
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " 설치 완료!"
echo ""
echo " 시작: npm start"
echo " 대시보드: http://localhost:3000"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
