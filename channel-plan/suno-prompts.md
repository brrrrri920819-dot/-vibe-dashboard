# Motel Nowhere — Album 1 «Vacancy» Suno Prompt Pack

공통 규칙: 드럼 없음 · 보컬 없음 · 50–60 BPM · 페이드인/아웃 · 트랙당 4–6개 생성 후 베스트 선별.
Suno **Pro 이상 구독 계정**에서 생성해야 상업적 권리가 확보됩니다. DistroKid 업로드 시 AI 사용 고지 필수.

## 공통 베이스 프롬프트

```
ambient sleep music, warm analog synth pads, slow evolving drones, tape hiss texture,
no drums, no vocals, 55 bpm, nostalgic late-night American roadside atmosphere,
soft Rhodes piano, distant highway hum, gentle and hypnotic, seamless loop
```

## 트랙별 추가 프롬프트 (베이스 뒤에 덧붙임)

| # | 트랙 | 추가 프롬프트 |
|---|------|--------------|
| 1 | Check-In (12:04 AM) | soft door chime intro, warm hum of a lobby at midnight |
| 2 | Rain on a Motel Roof | gentle rain on tin roof, distant thunder, cozy interior warmth |
| 3 | Neon Through Curtains | slow pulsing warm synth swells, flickering neon ambience |
| 4 | Ice Machine Hum | deep mechanical drone, soft white noise bed, hypnotic low end |
| 5 | Highway Lullaby | faraway passing cars, doppler swells, warm tape saturation |
| 6 | Room 7, Lights Off | near-silent drone, sub-bass warmth, air conditioner texture |
| 7 | Diner Closing Time | muffled jazz through a wall, clinking fading, melancholic warmth |
| 8 | Static Channel | soft TV static bed, slow dreamy pad washes underneath |
| 9 | 3AM Pool Glow | underwater-feeling pads, gentle chlorine-blue shimmer, weightless |
| 10 | Check-Out (Dawn) | first birdsong far away, warming major drone, hopeful sunrise resolve |

## 후처리 (반드시 사람 손으로 — 정책 방어 + Content ID 경로)

1. DAW(Reaper/Ableton)에서 EQ, 리버브, 트랙 간 크로스페이드
2. 마스터링 타깃 **−20 LUFS** (수면용은 일반 음원보다 훨씬 조용하게)
3. 10트랙 1시간 앨범본 + 동일 소스 8시간 루프 확장본 렌더
4. ffmpeg: 커버 아트 루프 애니메이션(4K) + 오디오 합성

```bash
ffmpeg -stream_loop -1 -i cover-loop.mp4 -i album-8h.wav -shortest \
  -c:v libx264 -preset slow -crf 18 -c:a aac -b:a 384k motel-nowhere-8h.mp4
```
