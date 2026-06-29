// 판정 로직 스모크 테스트 (의존성 불필요): node test/smoke.mjs
import { judgeDirector, formatDirectorResult, judgeFamily, judgeNonreg, analyzeCeoFamily } from '../src/judge.mjs';

const registry = `
법인등기부등본
사업장 명칭: 테스트주식회사
사내이사 홍길동 800101-*******
2019년 12월 02일 취임
대표이사 JOHN SMITH 750203-*******
2024년 03월 10일 취임
감사 이순신 700505-*******
2015년 01월 01일 취임
2018년 06월 30일 사임
`;

const employment = `
산재보험 근로자 자격 이력
800101-1****** 홍길동 2019-11-02
고용보험 근로자 현황
750203-5****** 존스미스 2024-03-10
700505-2****** 이순신 2015-01-01 2018-06-30
`;

const res = judgeDirector(registry, employment);
console.log(formatDirectorResult(res));
console.log('\n================ 검증 ================');
const byName = Object.fromEntries(res.results.map(r => [r.name, r]));

function check(name, label, cond){ console.log(`${cond?'✅':'❌'} ${name}: ${label}`); if(!cond) process.exitCode=1; }

// ⓪ 시간대: cutoff/today가 KST 기준 YYYY-MM-DD이고 cutoff = today − 3년
check('시간대', `cutoff(${res.cutoff})·today(${res.today}) KST 형식 + 3년차`,
 /^\d{4}-\d{2}-\d{2}$/.test(res.cutoff) && /^\d{4}-\d{2}-\d{2}$/.test(res.today)
 && Number(res.today.slice(0,4)) - Number(res.cutoff.slice(0,4)) === 3
 && res.cutoff.slice(5) === res.today.slice(5));

// ① 티어 분기: 홍길동=사내이사(TIER2) 산재 잠정 상실신고 → 기본 '검토필요'로 하향, 잠정·근로자성 사유 보존
const hong = byName['홍길동'];
check('홍길동', `사내이사 기본 하향: 산재=검토필요 (종합=${hong?.judgment})`, hong && hong.judgmentS === '검토필요');
check('홍길동', `잠정판정(상실신고)·근로자성 안내 사유 보존`, hong && /상실신고/.test(hong.reason) && /근로자성/.test(hong.reason));
check('홍길동', `환급구간이 CUTOFF(${res.cutoff})부터 — 시효 내 부분만`, hong && /환급구간/.test(hong.reason) && hong.reason.includes(res.cutoff));

// ①-b 오버레이: 홍길동을 non_worker로 확정 → 잠정 상실신고가 액션으로 복원
const resHongNW = judgeDirector(registry, employment, [{ name:'홍길동', rrn6:'800101', worker_status:'non_worker' }]);
const hongNW = resHongNW.results.find(r=>r.name==='홍길동');
check('홍길동(non_worker)', `근로자성 부인 확정 → 산재=상실신고 복원 (종합=${hongNW?.judgment})`, hongNW && hongNW.judgmentS === '상실신고');
// ①-c 오버레이: 홍길동을 worker로 확정 → 정상
const resHongW = judgeDirector(registry, employment, [{ name:'홍길동', worker_status:'worker' }]);
const hongW = resHongW.results.find(r=>r.name==='홍길동');
check('홍길동(worker)', `근로자성 인정 확정 → 산재=정상 (종합=${hongW?.judgment})`, hongW && hongW.judgmentS === '정상');

// ② TIER1 유지 + 외국인 매칭: JOHN SMITH=대표이사 → 하향 없이 취득취소, 등록번호 매칭·이름 상이 안내
const john = byName['JOHN SMITH'];
check('JOHN SMITH', `대표이사(TIER1)는 하향 없음: 고용=취득취소 (종합=${john?.judgment})`, john && john.judgmentE === '취득취소');
check('JOHN SMITH', `이름 표기 상이 안내 노출`, john && /이름 표기 상이/.test(john.confirm) && john.confirm.includes('존스미스'));
// ②-b TIER1 worker 오버레이(예외적 대표 근로자성 인정): 취득취소 → 정상
const resJohnW = judgeDirector(registry, employment, [{ name:'JOHN SMITH', worker_status:'worker' }]);
const johnW = resJohnW.results.find(r=>r.name==='JOHN SMITH');
check('JOHN SMITH(worker)', `대표 근로자성 인정 입력 → 고용=정상 (종합=${johnW?.judgment})`, johnW && johnW.judgmentE === '정상');

// ③ 과거 임기 재취득: 이순신=감사(TIER2)·시효경과(비액션) → 하향 대상 아님, 시효경과 유지
const lee = byName['이순신'];
check('이순신', `과거임기·시효경과(비액션) 유지(판정=${lee?.judgment})`, lee && lee.judgment === '시효경과');

// ── 가족종사자 ──────────────────────────────────────
const fam = judgeFamily([
 { name:'배우자A', relation:'배우자', cohabiting:true, positive_factors:[], negative_factors:[] },
 { name:'자녀B', relation:'직계비속 (자녀·손자녀 등)', cohabiting:true,
   positive_factors:['contract','transfer','payslip','attendance','benefit','withholding'], negative_factors:[] },
 { name:'사촌C', relation:'기타 친족 (4촌 이내)', cohabiting:true, positive_factors:[], negative_factors:[] },
], 'corp');
const fByName = Object.fromEntries(fam.results.map(r=>[r.name,r]));
check('가족-배우자A', `점수0 → 취득취소 가능 (고용=${fByName['배우자A']?.empJ})`, fByName['배우자A']?.empJ==='취득취소 가능');
check('가족-자녀B', `요소 다수 → 정상 (고용=${fByName['자녀B']?.empJ})`, /정상/.test(fByName['자녀B']?.empJ||''));
check('가족-사촌C', `기타친족 → 검토필요 (고용=${fByName['사촌C']?.empJ})`, fByName['사촌C']?.empJ==='검토필요');

// ── 비등기임원 ──────────────────────────────────────
const nr = judgeNonreg([
 { title:'전무', name:'위임D', contract_type:'delegation',
   negative_factors:['delegation','management','freeWork','authority','remuneration'], positive_factors:[] },
 { title:'본부장', name:'근로E', contract_type:'labor',
   positive_factors:['laborContract','attendance','benefit','withholding','payslip'], negative_factors:[] },
]);
const nByName = Object.fromEntries(nr.results.map(r=>[r.name,r]));
check('비등기-위임D', `순점수 높음 → 취득취소 가능 (고용=${nByName['위임D']?.empJ})`, nByName['위임D']?.empJ==='취득취소 가능');
check('비등기-근로E', `근로계약+인정우세 → 정상 (고용=${nByName['근로E']?.empJ})`, /정상/.test(nByName['근로E']?.empJ||''));

// ── 공동대표·친족 분석 ──────────────────────────────
const ceo = analyzeCeoFamily(
 '대표이사 김대표 600101-*******  서울특별시 강남구 역삼로 212, 706호\n2018년 01월 01일 취임\n' +
 '대표이사 김배우 650505-*******  서울특별시 강남구 역삼로 212, 706호\n2018년 01월 01일 취임\n'
);
check('공동대표', `공동대표 감지(isCoCeo=${ceo.isCoCeo}, 현재 ${ceo.activeCoCeo.count}인)`, ceo.isCoCeo && ceo.activeCoCeo.isActive);
check('친족판정', `주소 동일 → 친족 (kinRows=${ceo.kinRows.length})`, ceo.kinRows.some(k=>k.kind==='친족'));

console.log('\n검증 종료. exitCode=', process.exitCode||0);
