# Motel Nowhere — Midjourney Prompt Pack

미드저니 Discord(또는 웹) 계정에 그대로 붙여넣으면 되는 프롬프트입니다.
`/imagine prompt:` 뒤에 붙이세요. 버전은 최신 모델(`--v 7`) 기준, 필요시 자신의 계정에서 사용 가능한 최신 버전으로 바꾸세요.

공통 스타일 코드(브랜드 일관성 유지용): 세 장 모두 생성한 뒤 마음에 드는 결과 이미지 URL을 `--sref [URL]`로 다음 프롬프트들에 넣으면 커버 간 톤이 통일됩니다.

---

## Cover 1 — Vacancy (시그니처 / 채널 아이콘·배너용)

```
/imagine prompt: retro pop-art travel poster of a glowing neon motel sign at dusk,
"MOTEL" stacked bold letters on a teal neon tube sign, pink "VACANCY" badge glowing,
lone American desert highway, huge warm yellow moon, dusty purple-to-orange gradient sky,
Ben-Day halftone dot texture, palm and saguaro silhouettes, parked vintage pickup truck,
flat bold shapes, limited palette cream pink teal orange gold navy, 1960s travel poster
illustration style, screen-print texture, no photorealism, wide cinematic composition,
YouTube thumbnail energy, high contrast --ar 16:9 --v 7 --stylize 300
```

## Cover 2 — Open All Night (다이너 무드)

```
/imagine prompt: retro pop-art illustration of a steaming diner coffee cup on a
bold teal polka-dot background, "OPEN ALL NIGHT" bold condensed typography,
1960s Americana diner poster style, flat bold shapes, limited palette teal pink
cream navy, screen-print halftone texture, thick outlines, warm nostalgic mood,
square album cover composition --ar 1:1 --v 7 --stylize 300
```

## Cover 3 — Channel 0AM (화이트노이즈 / TV 스태틱)

```
/imagine prompt: retro pop-art illustration of an old CRT television glowing in a
dark room, screen showing "0:00 AM" in bold retro digits with soft static texture,
teal television body, warm neon pink and gold accents, antenna silhouette,
Ben-Day halftone dot background, 1960s Americana poster style, flat bold shapes,
thick outlines, square album cover composition --ar 1:1 --v 7 --stylize 300
```

## YouTube 썸네일 (1280×720, 가로형)

```
/imagine prompt: YouTube thumbnail, retro pop-art neon motel sign glowing on the
left side, huge bold white title space on the right reads "RAIN ON A MOTEL ROOF",
warm dusk gradient sky, big yellow moon, rain streaks, Ben-Day halftone texture,
1960s Americana travel poster style, ultra high contrast, thick bold shapes,
flat colors, no photorealism, cinematic wide composition --ar 16:9 --v 7 --stylize 400
```

---

### 사용 팁
- `--stylize 300~500` 사이로 조절하면 브랜드다움과 미드저니 특유의 화려함 사이 균형 조정 가능
- 결과 4장 중 마음에 드는 그리드를 골라 `U1~U4`로 업스케일
- 세 커버 모두 만든 뒤, 가장 마음에 드는 한 장의 이미지 URL을 `--sref`로 다른 프롬프트에 추가하면 시리즈 톤이 통일됨
- 완성 이미지는 `channel-plan/cover-art/`에 저장 → 이후 8시간 영상 렌더 파이프라인(ffmpeg 루프+오디오 합성)에 그대로 교체 투입 가능
