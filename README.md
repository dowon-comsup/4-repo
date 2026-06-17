# 도원 4대보험 판정 MCP 서버

법인등기부등본 + 4대보험 고용현황 텍스트를 받아 **등기임원별 적용제외(근로자성) 판정 + 환급구간**을 산출하는 원격 MCP 서버. `insurance-tools`의 「적용제외 근로자성 판단」 판정 로직(소멸시효 3년 반영·외국인 등록번호 매칭 포함)을 그대로 이식했다.

claude.ai / Claude Desktop / Claude Code 에서 커넥터로 붙이면 대화로 호출할 수 있다.

## 도구
- **`judge_director`** — 등기임원 판정. 입력 `registry_text`(등기부 원문), `employment_text`(고용현황 원문) → 임원별 적용제외/환급구간.
- **`judge_family`** — 가족종사자 판정. 관계·동거여부·근로자성 점수 요소(인정/부인) → 취득취소 가능/검토필요/정상.
- **`judge_nonreg`** — 비등기임원 판정. 계약유형 + 근로자성 점수 요소 → 동일.
  - OCR은 **Claude(클라이언트)가 담당**: 대화창에 PDF/엑셀을 올리면 Claude가 읽어 텍스트·점수 요소를 추출 → 도구에 전달. 서버에 API 키 불필요.
  - 가족·비등기는 체크리스트 점수형 — Claude가 사용자 문답 또는 서류로 요소(요소 id는 도구 설명에 카탈로그로 노출)를 채워 호출.

## 로컬 실행·테스트
```bash
npm install
npm test              # 판정 로직 스모크(의존성 무관)
npm start             # 서버 기동 (POST /mcp, 헬스 GET /)
node test/client.mjs  # 다른 터미널에서 MCP 통합 테스트
```

## Render 배포 (claude.ai 웹용 — 외부 접속 필요)
1. 이 폴더를 **GitHub 저장소**로 올린다(단독 repo 권장).
2. Render → New → **Web Service** → 해당 repo 연결.
3. 설정: Runtime `Node`, Build `npm install`, Start `npm start`, Health Check Path `/`.
   (repo 하위 폴더로 둔 경우 **Root Directory** = `02_automation/insurance-mcp`)
4. 배포 후 URL 확인: `https://<서비스명>.onrender.com` → MCP 엔드포인트는 **`https://<서비스명>.onrender.com/mcp`**
5. (선택) 보호: Render 환경변수 `AUTH_TOKEN` 설정 → 호출 시 `Authorization: Bearer <값>` 필요.

> 무료 플랜은 유휴 시 슬립 → 첫 호출이 수십 초 지연될 수 있음.

## claude.ai 커넥터 등록
- claude.ai → Settings → **Connectors → Add custom connector** → URL에 `https://<서비스명>.onrender.com/mcp` 입력.
- 등록 후 대화에서: *"이 등기부등본이랑 고용현황으로 4대보험 적용제외 판정해줘"* + 파일 첨부 → Claude가 텍스트 추출 후 `judge_director` 호출.

## Claude Code / Desktop 연결
```bash
# Claude Code (원격 HTTP)
claude mcp add --transport http dowon-insurance https://<서비스명>.onrender.com/mcp
# 로컬 테스트라면
claude mcp add --transport http dowon-insurance http://localhost:3000/mcp
```
Claude Desktop은 설정의 커넥터(원격 MCP URL) 또는 `mcp-remote` 브리지로 동일 URL 등록.

## 사용 예 (대화)
> 등기부등본.pdf, 고용현황.xlsx 첨부 → "4대보험 적용제외 판정해줘"

Claude가 두 파일을 읽어 텍스트를 뽑고 `judge_director`를 호출하면, 임원별로
`취득취소 / 상실신고 / 상실일정정 / 시효경과 / 정상` 판정과 **시효 반영 환급구간**, 외국인 이름 표기 상이 안내가 반환된다.

## 한계
- 판정 3종(등기임원·가족종사자·비등기임원) 제공. **공동대표 친족분석은 미포함**(Phase 2 잔여 — `analyze_ceo_family` 예정).
- 가족·비등기 판정의 소멸시효는 취득일 기준 "시효 내(기준일~)만 환급" 안내까지(등기임원 `refundWindow`처럼 전체 부지급 판정은 하지 않음 — 원본 웹툴과 동일).
- 판정은 **참고 자료** — 최종 판단은 담당 노무사·관할 근로복지공단. 국민연금·건강보험 미대상.
- 정확도는 Claude가 추출한 텍스트 품질에 의존(등기부 직위·성명·등록번호 6자리·날짜, 고용현황 성명·등록번호·취득/상실일·보험구분 보존 필요).
