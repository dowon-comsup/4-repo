// 판정 로직 스모크 테스트 (의존성 불필요): node test/smoke.mjs
import { judgeDirector, formatDirectorResult, judgeFamily, judgeNonreg } from '../src/judge.mjs';

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

// ① 시효 버그 수정 확인: 홍길동 산재(2019가입,2019임원,상실없음) → 시효경과 아님, 상실신고
const hong = byName['홍길동'];
check('홍길동', `산재=상실신고 (시효경과 아님), 종합=${hong?.judgment}`, hong && hong.judgmentS === '상실신고');
check('홍길동', `환급구간이 CUTOFF(${res.cutoff})부터 — 시효 내 부분만`, hong && /환급구간/.test(hong.reason) && hong.reason.includes(res.cutoff));

// ② 외국인 매칭: JOHN SMITH(등기) ↔ 존스미스(고용) 등록번호로 매칭 + 이름 표기 상이 안내
const john = byName['JOHN SMITH'];
check('JOHN SMITH', `등록번호로 매칭되어 고용 판정 산출(취득취소), 종합=${john?.judgment}`, john && john.judgmentE === '취득취소');
check('JOHN SMITH', `이름 표기 상이 안내 노출`, john && /이름 표기 상이/.test(john.confirm) && john.confirm.includes('존스미스'));

// ③ 과거 임기 재취득: 이순신(2015~2018 임원, 가입 2015~2018) → 정상 또는 대상아님 류(부지급 아님 단정 X)
const lee = byName['이순신'];
check('이순신', `과거 임기 케이스 정상 산출(판정=${lee?.judgment})`, lee && lee.judgment);

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

console.log('\n검증 종료. exitCode=', process.exitCode||0);
