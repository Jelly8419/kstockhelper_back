# Price Gap Monitor — 데이터 소스 PoC 검증 리포트

> 기획서(Price Gap Monitor PRD)의 §21 "개발 전 반드시 확인할 사항"에 대한 실측 검증 결과.
> 작성: 2026-06-14 / 검증 환경: 로컬(한국 IP) + 거래소·증권사 public API 직접 호출.
> PoC 스크립트: `scripts/probeExchangeWs.ts`, `scripts/probeKisWs.ts` (보존됨, 재실행 가능)

---

## 0. 한 줄 결론

**기능 전체가 기술적으로 실현 가능함이 확인됐다.** 핵심 데이터 소스(한국주식 실시간 체결가 / Binance·Bybit 한국주식 연계 perp / USD/KRW 환율)가 모두 실재하고, 전부 무료 수집 경로가 있다. 남은 것은 블로커가 아니라 구현 분기·배포 환경 재측정·정책 결정 몇 가지다.

---

## 1. 블로커 상태 요약

| ID | 항목 | 검증 전 | 검증 후 | 근거 |
| --- | --- | --- | --- | --- |
| C1 | Binance/Bybit 한국주식 연계 perp 실존 | 🔴 미확정 | ✅ 해소 | REST로 6계약 라이브 가격 수신 |
| C2 | KIS WebSocket 실시간 체결가 | 🔴 미확정 | ✅ 해소 | approval_key 발급 + 구독 ack 성공 |
| C3 | 실시간 USD/KRW 환율 | 🔴 미확정 | ✅ 해소 | 무료 분단위 소스 2종 실측 |
| R1 | 한국 유저 규제 충돌 | 🔴 신규 | ✅ 해소 | 타깃이 외국인 → 거래소 한국차단과 무관 |
| R2 | 수집 서버 리전 차단 | 🟡 신규 | 🟡 부분해소 | REST 양쪽 OK / Bybit WS OK / **Binance WS는 한국 IP 차단** |

---

## 2. C1 — 거래소 한국주식 연계 perp 실존 ✅

### 결과
2026년 6월 초 출시된 **실제 상품**. REST API로 직접 가격까지 확인.

| 거래소 | 심볼 | 검증 | 결과 |
| --- | --- | --- | --- |
| Binance | `SAMSUNGUSDT` | `fapi/v1/ticker/price` | last=220.21 |
| Binance | `SKHYNIXUSDT` | `fapi/v1/premiumIndex` | last=1499.28 mark=1499.52 funding=0.00039 |
| Binance | `HYUNDAIUSDT` | `fapi/v1/premiumIndex` | last=407.87 mark=408.26 |
| Bybit | `SAMSUNGUSDT` | `v5/market/instruments-info` | status=Trading settleCoin=USDT |
| Bybit | `SKHYNIXUSDT` | `v5/market/tickers` | last=1498.59 funding=0.00048 |
| Bybit | `HYUNDAIUSDT` | `v5/market/tickers` | last=408.97 mark=408.65 |

### 확정 계약 스펙
```
심볼:     SAMSUNGUSDT / SKHYNIXUSDT / HYUNDAIUSDT  (Binance·Bybit 동일 네이밍)
마진:     USDT-margined Linear Perpetual (무기한, 만료 없음)
펀딩:     8시간 주기
레버리지: 최대 20x
거래:     24/7
출시:     Binance 6/2, Bybit 6/4 (OKX도 출시)
```

### 부수 발견
- **거래소 간에도 갭 존재** (Samsung: Binance 220.21 vs Bybit 219.97). 기획서는 "KR기준가 vs 거래소"만 보지만, 거래소 간 갭도 콘텐츠가 될 수 있음.
- **last ≠ mark price**. 기획서 §7.3/§7.4는 "Last Price 기준"이라 명시했으나, perp는 mark price도 받을 수 있음. 갭 계산에 last를 쓸지 mark를 쓸지는 의도된 선택(기획대로 last 사용 가능).

---

## 3. C2 — KIS WebSocket 실시간 체결가 ✅

### 결과
approval_key 발급 → WS 연결 → 3종목 구독 전부 `SUBSCRIBE SUCCESS`. 연결성 완전 검증.

```
✅ approval_key 발급 성공 (POST /oauth2/Approval, 36자)
✅ WS 연결 (ws://ops.koreainvestment.com:21000)
✅ 구독 ack: 005930/000660/005380 모두 rt_cd=0 SUBSCRIBE SUCCESS
⚠️ 실시간 체결 틱 0건 — 측정 시각이 장 마감(KST 06:43)이라 체결 자체가 없음(차단 아님)
```

### 현 코드와의 차이 (중요)
현재 [src/config/kisAuth.ts](../src/config/kisAuth.ts)는 **REST용 `access_token`만** 발급한다. WebSocket은 별도 체계:

| 구분 | REST (현재 코드 있음) | WebSocket (신규 필요) |
| --- | --- | --- |
| 엔드포인트 | `POST /oauth2/tokenP` | `POST /oauth2/Approval` |
| body 시크릿 필드 | `appsecret` | **`secretkey`** (주의: 필드명 다름) |
| 산출물 | `access_token` | `approval_key` |
| 캐시 | 24h, 파일+메모리 | 세션 단위 |

→ 운영 컬렉터는 `getApprovalKey()`를 신규 추가해야 한다. 기존 REST 컬렉터([kisStock.ts](../src/collectors/kisStock.ts))는 재사용 불가.

### 확정 구현 스펙
```
구독 메시지:
{ header: { approval_key, custtype:'P', tr_type:'1', 'content-type':'utf-8' },
  body:   { input: { tr_id:'H0STCNT0', tr_key:'005930' } } }

응답 형식: "0|H0STCNT0|<건수>|<필드^필드^...>"
  - 첫 글자 0/1 = 암호화여부, 파이프(|)로 헤더 분리, 본문은 캐럿(^) 구분
  - 필드 index 1 = STCK_CNTG_HOUR(체결시각), index 2 = STCK_PRPR(체결가)
  - 한 프레임에 여러 체결이 올 수 있음(건수만큼 필드 반복)

PINGPONG: tr_id=='PINGPONG'이면 받은 메시지 그대로 echo (연결 유지)
세션 제한: 종목당 1구독, 세션당 41건 → 3종목이라 여유
```

### 미측정 (1건)
- **장중 체결 빈도/지연** — 평일 09:00~15:30 KST에 `scripts/probeKisWs.ts` 재실행 필요. "Premium 1초 push가 실데이터로 채워지는가"의 최종 확인. (지금은 연결성만 검증됨)

---

## 4. C3 — 갭 분모: USDT/KRW (거래소 시세, 합법) ✅

### 결정 (수정됨): 은행 환율 비공식 소스 폐기 → 거래소 USDT/KRW 채택
당초 무료 은행환율(Naver 하나은행/Yahoo)을 검토했으나 **두 가지 이유로 거래소 USDT/KRW로 전환**:

1. **라이선스 리스크**: Naver/Yahoo는 웹·앱 내부 **비공식 엔드포인트**라 ToS 위반·차단 위험. 거래소 public market API는 외부 이용을 전제로 제공(rate limit 공식 문서화)되어 리스크가 낮다.
2. **갭 정의 정합성 (더 중요)**: perp는 **USDT 기준**(SAMSUNGUSDT)인데 은행 USD/KRW를 분모로 쓰면 `USDT≠USD` 디페그 + 김치프리미엄이 갭에 노이즈로 섞인다. **USDT/KRW를 분모로 쓰면 perp와 단위가 통일**되어 "순수 KR주가 vs perp 괴리"만 남는다(김프 상쇄).

```
USD Reference = KR price / (USDT/KRW)   ← perp와 같은 USDT 단위
Gap %         = (perp USDT가 - USD Reference) / USD Reference × 100
```

### 후보 실측 (라이브 확인)

| 소스 | 키 | 갱신 | 라이선스 | 결과 | 판정 |
| --- | --- | --- | --- | --- | --- |
| **업비트 KRW-USDT** | ❌ | 초단위 | public API(rate limit 문서화) | trade_price=1511, 24h거래량 2,448만 | 🟢 1차 |
| **빗썸 USDT_KRW** | ❌ | 실시간 | public API | closing_price=1510 | 🟢 2차(폴백) |
| ~~Naver(하나은행)~~ | ❌ | 실시간 | ⚠️ 비공식 | (폐기) | ❌ ToS 리스크 |
| ~~Yahoo KRW=X~~ | ❌ | 1분봉 | ⚠️ 비공식 | (폐기) | ❌ ToS 리스크 |
| ~~open.er-api.com~~ | ❌ | 일1회 | OK | (폐기) | ❌ USD 단위라 USDT와 불일치 |

> 참고: 업비트 USDT/KRW=1,511 vs 은행 USD/KRW=1,519.5 — 약 0.6% 차이가 USDT 디페그+김프. 이게 USDT 단위로 통일해야 하는 실증.

### 구조: 2단 폴백 (둘 다 합법 public API)
```
1차: 업비트  https://api.upbit.com/v1/ticker?markets=KRW-USDT  → result[0].trade_price
2차: 빗썸    https://api.bithumb.com/public/ticker/USDT_KRW    → data.closing_price
→ 장중(09:00~15:35)만 1분 폴링. 둘 다 한국 거래소라 해외 배포에서도 접근 가능(공개 시세).
  둘 다 실패하면 store 마지막 값 stale 처리 → UI "FX delayed".
```

### 남은 확인 (운영 전)
- **업비트/빗썸 API 상업적 이용 약관** 직접 확인 필요(웹검색으론 미확정, 단 비공식 스크래이핑보다 명백히 안전).

### 현 코드 변경
[src/priceGap/fxFeed.ts](../src/priceGap/fxFeed.ts)를 업비트→빗썸 USDT/KRW 폴백으로 구현. (기존 market 수집의 exchangeRate.ts(은행 USD/KRW)는 별개 — 시장 카드용이라 그대로 둠)

---

## 5. R2 — 수집 서버 리전 차단 🟡 (부분 해소)

### 실측 (로컬 = 한국 IP 기준)

| | REST | WebSocket |
| --- | --- | --- |
| Binance | ✅ 정상 | ❌ **데이터 0건** (open은 되나 프레임 안 옴) |
| Bybit | ✅ 정상 | ✅ 정상 (tickers mark/funding 수신) |
| KIS | ✅ 정상 | ✅ 정상 |

### Binance WS 차단 — 격리 검증 결과
3단계로 원인 격리:
1. 한국주식 심볼 `markPrice@1s` → 0건
2. URL 형식 3종(combined/single/!arr) 전부 → 0건
3. `btcusdt@aggTrade`(세계 1위 거래량) → **0건**

→ 심볼/시간대 문제 배제. **한국 IP에서 `fstream.binance.com` 데이터 평면이 차단됨** (Binance의 한국 거주자 규제가 WS에도 적용). open 핸드셰이크만 통과하고 프레임 0 = 전형적 지역 차단.

### 해석 & 대응
- 이건 **로컬(한국 IP) 한정** 문제. 실제 배포는 해외 리전(타깃이 외국인이므로 당연)이라 거기선 풀릴 공산이 큼.
- **대응 2가지:**
  1. **배포 리전에서 재측정** — 해외 IP에서 `scripts/probeExchangeWs.ts` 1회 실행해 Binance WS 확정. "될 것이다" → "확인됨"으로 승격.
  2. **REST 폴백 구현** — WS 끊기면 1~2초 REST 폴링 자동 전환. REST는 한국에서도 뚫리므로 안전판. 3심볼 폴링은 rate limit 여유(Binance futures weight 충분).
- Bybit·KIS는 한국 IP에서도 WS 정상이라 무관.

---

## 6. 종합 — 데이터 수집 아키텍처 함의

```
[수집]
 KR 주식:  KIS WS (H0STCNT0)            — 실시간 push, 신규 approval_key 발급 모듈
 Binance:  Bybit WS push + Binance WS(해외) or REST 폴백
 Bybit:    WS push (tickers/publicTrade) — 한국 IP에서도 OK
 FX:       Naver→Yahoo→er-api 3단 폴백   — 장중 1분 폴링

[중요 설계 포인트]
 - "Premium 1초 push"는 WS push가 아니어도 충족 가능 — REST 1초 폴링도 소스 신선도만 맞으면 OK
 - 현재 코드는 전부 stateless cron(5분) → 1초 실시간·1분 OHLC·10분 버퍼는 stateful worker 신규 구축
 - is_premium() DB뷰 게이트(hot_news 패턴)는 SSE에 재사용 불가 → 스트림 레벨 JWT 인가 신규
```

---

## 7. 남은 의사결정 & 미측정 항목

| 항목 | 유형 | 비고 |
| --- | --- | --- |
| 장중 KIS 체결 빈도 재측정 | 미측정 | 평일 09:00~15:30 `probeKisWs.ts` 재실행 |
| 해외 배포 리전 Binance WS 재측정 | 미측정 | 배포 후보에서 `probeExchangeWs.ts` 실행 |
| FX 비공식 소스 ToS 리스크 수용 여부 | 결정 | 무료 채택 시 3단 폴백+stale로 완화 |
| 갭 분모 USDT vs USD 처리 | 결정 | MVP: USD 단순화 + UI 고지 권고 |
| last price vs mark price | 결정 | 기획대로 last 가능, mark도 선택지 |
| 한국을 제한국가 목록에 포함? | 결정 | 거래소가 한국 막으니 일관성 위해 포함 권고 |
| 수집 서버 분리 여부 | 결정 | 현 모놀리식에 SSE/tick worker 얹을지 별도 프로세스 |

---

## 8. 운영시간/공휴일 정합성 (기존 코드 재사용 가능)

- 기존 `isMarketOpen()`([publicCommon.ts](../src/collectors/publicCommon.ts))은 평일 **09:01~15:41** 사용. 기획서 §4는 **09:00~15:35**. 경계 불일치 → 통일 필요.
- 공휴일: 현재 코드는 "한투가 빈 응답 → 버림"으로 암묵 처리. WS는 빈 응답이 아니라 "체결 없음"이라 별도 휴장일 캘린더 또는 거래 정지 감지 필요.

---

## 부록 — PoC 스크립트

| 파일 | 용도 | 재실행 |
| --- | --- | --- |
| `scripts/probeExchangeWs.ts` | Binance/Bybit REST+WS 수신 검증 | `npx tsx scripts/probeExchangeWs.ts [ms]` |
| `scripts/probeKisWs.ts` | KIS approval_key+WS 체결가 검증 | `npx tsx scripts/probeKisWs.ts [ms]` |

> 두 스크립트는 일회성 진단용이며 운영 컬렉터가 아니다. 관측 후 자동 종료(좀비 방지).
> KIS 스크립트는 기존 `.env`(KIS_APP_KEY/KIS_APP_SECRET)를 그대로 사용한다.
