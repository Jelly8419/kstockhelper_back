# Price Gap 백필 가능성 조사 리포트

> Price Gap 개선 §13.1 "백필(시작일 2026-06-02)" 실현 가능성 실측 검증.
> 작성: 2026-06-16 / 검증 환경: 로컬(한국 IP) + 각 소스 public/REST API 직접 호출.
> 관련: [price_gap_monitor_poc_report.md](price_gap_monitor_poc_report.md)

---

## 0. 한 줄 결론

**백필은 기술적으로 가능하다.** 갭 계산에 필요한 세 소스 — KR 체결가 / 거래소 perp / USDT/KRW — 가 **모두 과거 1분봉을 제공**함을 실측으로 확인했다. 단, 이는 "raw 분봉 백필 가능"이지 "기존 실시간 파이프라인 재사용 가능"이 아니다. 백필은 **현재 실시간 수집기와 완전히 별개인 새 배치 작업**으로 만들어야 하며, 세 소스를 같은 분 경계에 정렬해 갭을 재계산하는 로직이 필요하다.

---

## 1. 소스별 과거 데이터 가용성 (실측)

| 소스 | API | 과거 1분봉 | 시작 한계 | 판정 |
| --- | --- | --- | --- | --- |
| **KR 체결가** | KIS `inquire-time-dailychartprice` (FHKST03010230) | ✅ | 과거 영업일 임의 지정 (6/2, 5/12 확인) | 🟢 |
| **Binance perp** | `fapi/v1/klines` interval=1m | ✅ | **2026-06-02 09:50 KST부터 전량 보존** | 🟢 |
| **Bybit perp** | `v5/market/kline` interval=1 | ✅ | 6/4 출시 이후 (6/2엔 데이터 없음 = 정상) | 🟢 |
| **USDT/KRW** | Upbit `candles/minutes/1` (`to` 파라미터) | ✅ | `to=2026-06-02T...`로 임의 과거 분봉 정확 반환 | 🟢 |

### 1.1 KR 체결가 — KIS 과거 분봉 ✅ (가장 불확실했던 항목)
실시간 KIS WS(H0STCNT0)는 과거를 못 주지만, **별도 REST API가 과거 영업일 1분봉을 준다.**
```
GET /uapi/domestic-stock/v1/quotations/inquire-time-dailychartprice
TR: FHKST03010230
params: FID_INPUT_DATE_1=20260602, FID_INPUT_HOUR_1=153000 (기준시각, 역순)
실측: 2026-06-02 / 2026-05-12 모두 rt_cd=0, output2에 OHLC 분봉 반환
응답: stck_bsop_date, stck_cntg_hour(KST HHMMSS), stck_prpr(종가), stck_oprc/hgpr/lwpr
```
- **페이징**: 한 호출당 최대 ~120건(약 2시간). `FID_INPUT_HOUR_1`을 당겨가며 09:00까지 역순 수집.
  하루치(09:00~15:30 ≈ 387분) = 약 4~5콜/종목/일. 종목 3 × 일수로 곱해도 부담 적음.
- **유량제한**: 기존 `KIS_CALL_GAP_MS` 간격 + `withRetry`(EGW00201 대응) 재사용 가능.

### 1.2 Binance perp ✅
```
GET fapi/v1/klines?symbol=SAMSUNGUSDT&interval=1m&startTime=0&limit=1
→ 가장 이른 봉: 1780369800000 = 2026-06-02 09:50 KST. 출시 이후 전량 보존.
```
한 콜당 최대 1500봉(=25시간). 하루치를 1콜로 커버. startTime 페이징.

### 1.3 Bybit perp ✅ (단 6/4 출시)
```
GET v5/market/kline?category=linear&symbol=SAMSUNGUSDT&interval=1&end=<ms>&limit=1000
→ 최신부터 역순. end로 과거 페이징. 6/2 요청 시 빈 배열(미출시, 정상).
```
**백필 시작일이 거래소별로 다르다**: Binance 6/2, Bybit 6/4. UI가 "데이터 있는 구간만" 처리해야 함(이미 availableDays 플래그로 대응 설계됨).

### 1.4 USDT/KRW — Upbit 과거 분봉 ✅
```
GET api.upbit.com/v1/candles/minutes/1?market=KRW-USDT&to=2026-06-02T01:00:00Z&count=2
→ 2026-06-02 09:59 KST candle 정확 반환 (trade_price=1457).
```
- 한 콜당 최대 200봉. `to`를 당겨가며 역순 페이징. 거래량 풍부(24h 7천만+)라 분봉 결손 거의 없음.
- 빗썸은 1분봉 과거 API가 빈약 → **백필은 Upbit 단일 소스 권장**(실시간은 업비트→빗썸 폴백 그대로).

---

## 2. 핵심 난점 — 정렬과 재계산 (raw 가용 ≠ 백필 완료)

세 소스 raw가 다 있어도, 갭은 **같은 분에 세 값을 조합**해야 나온다. 백필 배치가 풀어야 할 것:

### 2.1 타임존/경계 정렬
| 소스 | 시각 형식 | 정렬 키로 변환 |
| --- | --- | --- |
| KIS | KST `stck_cntg_hour` (HHMMSS) | KST 분 → UTC 분 경계 |
| Binance/Bybit | UTC epoch ms (openTime) | floor(ms/60000) |
| Upbit | `candle_date_time_utc` (UTC 분) | 그대로 UTC 분 |

→ 전부 **UTC 분 경계(`floor(ms/60000)`)로 통일**해 조인. 현재 실시간 OHLC가 이미 UTC `timestamp_minute`라 스키마 호환됨.

### 2.2 분봉 close 기준 재계산
- 실시간 파이프라인은 **1초 tick의 gap을 OHLC로 누산**한다. 백필은 1초 raw가 없으므로
  **각 소스의 1분봉 close끼리** 갭을 계산할 수밖에 없다:
  `gap = (perp_close − KRclose/USDTKRWclose) / (KRclose/USDTKRWclose) × 100`
- → 백필분의 OHLC는 **close_gap만 정확**하고 open/high/low_gap은 근사(분내 1초 변동 불가복원).
  차트 평균선·테이블 과거평균은 **close_gap만 쓰므로 영향 없음**. (OHLC 캔들 자체를 과거에 그릴 게 아니면 OK)
- 결손 분(어느 소스든 그 분 봉이 없으면) → 해당 분 갭 null. 직전 유효값 보간은 정책 선택.

### 2.3 결손/휴장 처리
- 거래소는 24/7이라 한국 장시간(09:00~15:35) 밖에도 봉이 있지만, **KR 체결가가 없는 시간대는 갭 계산 불가** → 한국 장중 분만 백필.
- 공휴일/휴장일: KIS가 해당일 빈 응답 → 그 날 스킵 ([holiday.ts](../src/priceGap/holiday.ts) 로직 재사용 가능).

---

## 3. 작업 규모 추정

```
대상: 3종목 × 2거래소 × (6/2~현재 약 10영업일) × ~387분/일
API 콜:
  KIS:     3종목 × 10일 × ~5콜  = ~150콜  (유량제한 간격 두면 수분)
  Binance: 3종목 × 10일 × 1콜   = ~30콜
  Bybit:   3종목 × 8일  × 1콜   = ~24콜
  Upbit:   10일 × ~3콜(387분/200) = ~30콜  (USDT/KRW는 종목 무관 공통)
적재: price_gap_ohlc 에 upsert (기존 멱등 스키마 그대로). 약 3×2×10×387 ≈ 23,000행.
```
**1회성 배치로 수십 분 내 완료 가능 규모.** 매일 증분 백필은 cron 1회/일로 전일분만 추가.

---

## 4. 권고

1. **백필은 별도 1회성 스크립트 + 일일 증분 cron**으로 구현 (실시간 수집기와 분리).
2. **USDT/KRW는 Upbit 단일**, KR가는 **KIS 일별분봉 REST**, perp는 **거래소 klines** 사용.
3. 백필 OHLC는 **close_gap만 신뢰**(open/high/low는 close 복제 또는 근사) — 평균선/과거평균은 close만 쓰므로 무방.
4. **Bybit 시작일 6/4** 등 거래소별 데이터 시작 차이를 `availableDays`로 노출.
5. 정렬은 **UTC 분 경계 통일** — 기존 `timestamp_minute` 스키마와 호환.

### 미해결/후속
- KIS 일별분봉 API의 **하루 페이징 정확한 상한**(120건 고정인지 종목·시각별 변동인지) — 백필 스크립트 작성 시 루프 종료조건으로 실측 필요.
- 1분봉 close만으로 만든 백필 갭과 실시간(1초 누산) 갭의 **접합부 일관성** — 백필↔실시간 경계 분에서 미세 차이 가능(허용 범위로 판단되나 시각적 점검 권장).
