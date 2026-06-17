/**
 * 도원 4대보험 적용제외(근로자성) 판정 — 순수 로직 모듈
 * 출처: insurance-tools/tools/director-insurance-v2.html 의 판정 로직을 그대로 이식.
 * 서버(장기 실행) 환경이므로 CUTOFF/TODAY는 모듈 로드 시점이 아니라
 * judgeDirector() 호출 시점에 재계산한다(매일 갱신되도록).
 *
 * 근거: 고용보험및산업재해보상보험의보험료징수등에관한법률 §41(보험료 소멸시효 3년),
 *       근로기준법 §2①1, 고용보험법 §2①1, 대법원 2003다5061(2003.9.26.)
 */

// ── 상수 ──────────────────────────────────────────────
const STATUTE_YEARS = 3;
const REAPPOINT_GAP_DAYS = 365;   // 사임 후 재취임 갭이 짧으면 실질 연속근무 의심
const LOSS_TOLERANCE_DAYS = 1;    // 보험상실일 vs 등기 사임일 허용 시차
const J_RANK = { '취득취소':7,'상실신고':6,'상실일정정':5,'사업장확인필요':4,'검토필요':3,'정상':2,'시효경과':1,'미가입':1,'대상아님':0 };

// CUTOFF/TODAY는 judgeDirector()에서 매 호출 시 재계산
let CUTOFF = statuteCutoff();
let TODAY = new Date().toISOString().slice(0, 10);

function statuteCutoff(){
 const d = new Date(); d.setFullYear(d.getFullYear() - STATUTE_YEARS);
 return d.toISOString().slice(0, 10);
}

// ── 공통 헬퍼 ─────────────────────────────────────────
function fmtDate(v){
 if(!v) return null;
 const s = String(v).trim();
 const m = s.match(/(\d{4})[-./](\d{1,2})[-./](\d{1,2})/);
 return m ? `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}` : null;
}
function daysBetween(a,b){ if(!a||!b) return null; return Math.round((new Date(b)-new Date(a))/86400000); }

function buildOfficerPeriods(events){
 const T = ['사임','퇴임','해임','사망','임기만료'];
 // 같은 날짜면 종료이벤트(사임 등)를 취임보다 앞에 — parseRegistry 정렬과 일관(다중 기록 꼬임 방지)
 const ev = (events||[]).slice().sort((a,b)=>a.date.localeCompare(b.date)||(T.includes(a.type)?-1:1));
 const ps = []; let st = null;
 ev.forEach(e=>{
  if(e.type==='취임'||e.type==='중임'){ if(!st) st=e.date; }
  else if(T.includes(e.type)){ if(st){ ps.push({start:st,end:e.date}); st=null; } }
 });
 if(st) ps.push({start:st,end:null});
 return ps;
}
function findShortReappointGap(events){
 const ps = buildOfficerPeriods(events);
 for(let i=0;i<ps.length-1;i++){
  if(ps[i].end && ps[i+1].start){
   const d = daysBetween(ps[i].end, ps[i+1].start);
   if(d!==null && d>=0 && d<=REAPPOINT_GAP_DAYS) return {prevEnd:ps[i].end,nextStart:ps[i+1].start,days:d};
  }
 }
 return null;
}
function inAnyPeriod(date,events){
 const ps = buildOfficerPeriods(events);
 return ps.some(p=>date>=p.start && (!p.end || date<=p.end));
}

// ── 소멸시효 환급구간 산출 ─────────────────────────────
// startWrong: 잘못 납부가 시작된 날(취득취소=보험취득일 / 상실누락·정정=임원취임일)
// loss      : 보험상실일(없으면 현재까지 계속 납부 중)
// 핵심: 시효는 "환급 가능 기간을 CUTOFF 이후로 단축"할 뿐.
//       잘못 납부가 CUTOFF 이후까지 이어졌다면 전체 부지급(시효경과)이 아니라
//       CUTOFF~현재(또는 상실일) 구간이 환급 대상이다.
function refundWindow(startWrong, loss){
 if(!startWrong) return {expired:false,start:null,endLabel:loss||'현재',partial:false};
 const end = loss || TODAY;
 if(end < CUTOFF) return {expired:true};
 const partial = startWrong < CUTOFF;
 return {expired:false,start:partial?CUTOFF:startWrong,endLabel:loss||'현재',partial,origStart:startWrong};
}
function fmtWindow(w){
 if(!w || w.start==null) return '';
 return `환급구간: ${w.start} ~ ${w.endLabel}`
  + (w.partial?` (잘못 납부 시작 ${w.origStart}은 소멸시효(${STATUTE_YEARS}년·기준 ${CUTOFF}) 밖 → ${CUTOFF}부터만 환급 가능)`:'');
}

// ── 등기부등본 파싱 ───────────────────────────────────
// 이름: 한글뿐 아니라 영문·혼용(외국인 풀네임)도 허용 — 등록번호(6자리)로 종료 앵커
function parseRegistry(text){
 const posRe = /(이사장|대표이사|사내이사|사외이사|감사|이사)\s*([가-힣A-Za-z]{2,}[가-힣A-Za-z. ]*?)\s*(\d{6})\s*-?\s*\*+/;
 const dateRe = /(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일\s*(취임|중임|퇴임|사임|해임|사망|임기만료)/g;
 const TERM = ['사임','퇴임','해임','사망','임기만료'];
 const lines = text.split('\n');
 const blocks = []; let cur = null;
 lines.forEach(L=>{
  const m = L.match(posRe);
  if(m){ if(cur)blocks.push(cur); cur={pos:m[1],name:m[2].trim(),rrn:m[3],lines:[]}; }
  else if(cur) cur.lines.push(L);
 });
 if(cur) blocks.push(cur);

 const grouped = {};
 blocks.forEach(b=>{
  const key = b.name + b.rrn;
  if(!grouped[key]) grouped[key]={pos:b.pos,name:b.name,rrn:b.rrn,events:[]};
  grouped[key].pos = b.pos;
  const bTxt = b.lines.join('\n');
  let mm; dateRe.lastIndex = 0;
  while((mm=dateRe.exec(bTxt))){
   grouped[key].events.push({
    date:`${mm[1]}-${String(mm[2]).padStart(2,'0')}-${String(mm[3]).padStart(2,'0')}`,
    type:mm[4], sourcePos:b.pos
   });
  }
 });
 const result = [];
 Object.entries(grouped).forEach(([key,g])=>{
  const seen = new Set();
  const uniqEvents = g.events.filter(e=>{const k=e.date+e.type+e.sourcePos;if(seen.has(k))return false;seen.add(k);return true;});
  uniqEvents.sort((a,b)=>a.date.localeCompare(b.date)||(TERM.includes(a.type)?-1:1));
  const drop = new Set();
  for(let i=0;i<uniqEvents.length-1;i++){
   if(TERM.includes(uniqEvents[i].type)
      && (uniqEvents[i+1].type==='취임'||uniqEvents[i+1].type==='중임')
      && uniqEvents[i].date===uniqEvents[i+1].date
      && uniqEvents[i].sourcePos===uniqEvents[i+1].sourcePos){
    drop.add(i); drop.add(i+1);
   }
  }
  const merged = uniqEvents.filter((_,i)=>!drop.has(i));

  const periods = []; let pStart = null;
  merged.forEach(e=>{
   if(e.type==='취임'||e.type==='중임'){ if(!pStart) pStart=e.date; }
   else if(TERM.includes(e.type)){ if(pStart){ periods.push({start:pStart,end:e.date,endType:e.type}); pStart=null; } }
  });
  if(pStart) periods.push({start:pStart,end:null,endType:null});

  if(periods.length<=1){
   const firstAppoint = merged.find(e=>e.type==='취임'||e.type==='중임');
   let appoint=null, resign=null;
   merged.forEach(e=>{
    if(e.type==='취임') appoint=e.date;
    if(TERM.includes(e.type)) resign=e.date;
   });
   result.push({
    pos:g.pos,name:g.name,rrn:g.rrn,
    appoint: firstAppoint ? firstAppoint.date : appoint,
    resign, active: !resign, events: merged,
    periodIdx:0, totalPeriods:1, isLatestPeriod:true, isHistorical:false
   });
  } else {
   periods.forEach((p,idx)=>{
    const isLatest = (idx===periods.length-1);
    result.push({
     pos:g.pos,name:g.name,rrn:g.rrn,
     appoint:p.start, resign:p.end, active:!p.end, events:merged,
     periodIdx:idx, totalPeriods:periods.length,
     isLatestPeriod:isLatest, isHistorical:!isLatest,
     periodLabel:`${idx+1}/${periods.length}차 임기`
    });
   });
  }
 });
 return result;
}

// ── 고용현황 텍스트 파싱 ───────────────────────────────
function detectType(line, cur){
 const s = line.replace(/\s+/g,'');
 if(/보험구분[:：\s]*산재/.test(s)) return '산재';
 if(/보험구분[:：\s]*고용/.test(s)) return '고용';
 if(/산재보험.{0,6}(근로자|피보험|가입자|자격|현황|내역|조회)/.test(s)) return '산재';
 if(/고용보험.{0,6}(근로자|피보험|가입자|자격|현황|내역|조회)/.test(s)) return '고용';
 if(/산업재해보상보험/.test(s)) return '산재';
 const has산재 = /산재보험|산재\s*보험/.test(line);
 const has고용 = /고용보험|고용\s*보험/.test(line);
 if(has산재 && !has고용) return '산재';
 if(has고용 && !has산재) return '고용';
 if(!/\d{6}/.test(line)){
  if(/산재/.test(line) && !/고용/.test(line)) return '산재';
  if(/고용/.test(line) && !/산재/.test(line)) return '고용';
 }
 return cur;
}
function parseEmpText(txt){
 const lines = txt.split('\n');
 const rows = [];
 let curType = '고용';
 lines.forEach(L=>{
  curType = detectType(L, curType);
  // 패턴A: 주민번호-마스킹 성명 날짜
  let m = L.match(/(\d{6})\s*-?\s*\d?\s*\*+\s*([가-힣A-Za-z]{2,}[가-힣A-Za-z. ]*?)\s+(\d{4}[-./]\d{1,2}[-./]\d{1,2})(?:\s+(\d{4}[-./]\d{1,2}[-./]\d{1,2}))?/);
  // 패턴B: 성명이 주민번호 앞에 오는 형식
  if(!m){
   const mb = L.match(/([가-힣A-Za-z]{2,}[가-힣A-Za-z. ]*?)\s+(\d{6})\s*-?\s*\d?\s*\*+\s+(\d{4}[-./]\d{1,2}[-./]\d{1,2})(?:\s+(\d{4}[-./]\d{1,2}[-./]\d{1,2}))?/);
   if(mb) m=[mb[0],mb[2],mb[1],mb[3],mb[4]];
  }
  // 패턴C: 이름과 날짜 사이 추가 필드
  if(!m){
   const mc = L.match(/(\d{6})\s*-?\s*\d?\s*\*+\s*([가-힣A-Za-z]{2,}[가-힣A-Za-z. ]*?)\s+\S+\s+(\d{4}[-./]\d{1,2}[-./]\d{1,2})(?:\s+(\d{4}[-./]\d{1,2}[-./]\d{1,2}))?/);
   if(mc) m=mc;
  }
  if(m){
   let rowType = curType;
   const before = L.slice(0,m.index||0), after = L.slice((m.index||0)+m[0].length);
   const ctx = before+' '+after;
   if(/산재/.test(ctx) && !/고용/.test(ctx)) rowType='산재';
   else if(/고용/.test(ctx) && !/산재/.test(ctx)) rowType='고용';
   rows.push({rrn:m[1],name:String(m[2]).trim(),acq:fmtDate(m[3]),loss:fmtDate(m[4]),type:rowType});
  }
 });
 if(rows.length>0) return rows;

 // 형식2 (도원 어드민): 주민번호+성명 리스트, 취득/상실 리스트를 같은 순서로 zip
 const persons=[]; const dates=[];
 curType='고용';
 let personTypeChanged=false, dateTypeChanged=false;
 lines.forEach(L=>{
  const prevType=curType; curType=detectType(L,curType);
  const typeJustChanged=(curType!==prevType);
  const s=L.trim();
  const pm=s.match(/^(\d{6})-(\d{7})\s+([가-힣]{2,6}|[A-Z][A-Z\s]+|[가-힣A-Za-z]+)/);
  if(pm){ if(typeJustChanged)personTypeChanged=true; persons.push({rrn:pm[1],name:pm[3].trim(),type:curType,explicit:personTypeChanged}); return; }
  const dm=s.match(/^[YN]\s+(?:\S.*?\s+)?(\d{4}-\d{2}-\d{2})(?:\s+(\d{4}-\d{2}-\d{2}))?/);
  if(dm){ if(typeJustChanged)dateTypeChanged=true; dates.push({acq:dm[1],loss:dm[2]||null,type:curType,explicit:dateTypeChanged}); }
 });
 const n=Math.min(persons.length,dates.length);
 const out=[];
 for(let i=0;i<n;i++){
  let type='고용';
  const pEx=persons[i].explicit, dEx=dates[i].explicit;
  if(dEx) type=dates[i].type;
  else if(pEx) type=persons[i].type;
  else if(persons[i].type===dates[i].type) type=persons[i].type;
  else type=dates[i].type;
  out.push({rrn:persons[i].rrn.slice(0,6),name:persons[i].name,acq:dates[i].acq,loss:dates[i].loss,type});
 }
 return out;
}

function extractBizInfo(text){
 const info = {bizNo:'',bizName:''};
 const noM = text.match(/(?:사업장\s*)?(?:관리\s*번호|관리번호)\s*[:：]?\s*(\d{3,6}\s*-\s*\d{2}\s*-\s*\d{4,6}(?:\s*-\s*\d)?)/);
 if(noM) info.bizNo = noM[1].replace(/\s/g,'');
 const nmM = text.match(/사업장\s*(?:명칭?|명)\s*[:：]?\s*([^\n]{2,40}?)(?:\s{2,}|\t|$)/);
 if(nmM) info.bizName = nmM[1].trim();
 return info;
}

// ── 매칭 ──────────────────────────────────────────────
// 외국인: 등기부=풀네임(영문 가능), 고용현황=축약·한영혼용 → 이름 불일치 빈번.
// 등록번호(생년월일 6자리)는 양쪽 공통이므로 1차 조인키로 사용.
// ※ 6자리만 보유(뒷자리 마스킹) → 동일 생년월일 임원 동시 재임 시 오매칭 가능(이름 표기 상이 안내로 환기).
function recMatchesOfficer(rec, off){
 if(rec.rrn && off.rrn) return rec.rrn===off.rrn;
 return !!off.name && rec.name===off.name && rec.rrn===off.rrn;
}
function filterRecsForPeriod(recs, appoint, resign){
 if(!appoint) return recs;
 return recs.filter(r=>{
  if(!r.acq) return true;
  const end = resign||'9999-12-31';
  const rEnd = r.loss||'9999-12-31';
  return r.acq<=end && rEnd>=appoint;
 });
}
function pickLatest(recs){
 if(!recs.length) return null;
 return recs.slice().sort((a,b)=>(b.acq||'').localeCompare(a.acq||''))[0];
}

// ── 개인 단위 판정 (고용/산재 각각) ─────────────────────
function judgeOne(off, r, label){
 const exemptPos = ['대표이사','이사장','사내이사','감사','이사'];
 const isExempt = exemptPos.includes(off.pos);
 if(off.pos==='사외이사') return {j:'검토필요',reason:`[${label}] 사외이사 - 상근/비상근 확인 필요 (비상근이면 적용제외)`,confirm:''};
 if(!isExempt) return {j:'검토필요',reason:`[${label}] 직위 확인 필요`,confirm:''};
 if(!off.appoint) return {j:'검토필요',reason:`[${label}] 임원 취임일 미확인`,confirm:''};
 if(!r) return {j:'미가입',reason:`[${label}] 가입이력 없음`,confirm:''};
 const acq=r.acq, loss=r.loss, app=off.appoint, res=off.resign;
 if(res && acq && acq>res){
  return {j:'정상',reason:`[${label}] 임원 퇴임(${res}) 이후 가입(${acq}) → 근로자 자격 재취득(적법)`,confirm:''};
 }
 const reGap = findShortReappointGap(off.events);
 if(acq && acq>=app){
  if(!inAnyPeriod(acq,off.events)){
   return {j:'사업장확인필요',
    reason:`[${label}] 보험취득일(${acq}) ≥ 최초 임원취임일(${app})이나, 해당 시점이 임원 임기 갭 구간(사임~재취임 사이)에 위치 → 취득취소 단정 불가`,
    confirm:`취득일(${acq}) 시점에 임원 신분이었는지(보수 수령·이사회 참여 등) 사업장 확인 필요. 임원이었다면 취득취소, 아니면 정상`};
  }
  const wA = refundWindow(acq,loss);
  if(reGap){
   return {j:'사업장확인필요',
    reason:`[${label}] 보험취득일(${acq}) ≥ 임원취임일(${app}) → 1차 판정 취득취소. 다만 ${reGap.prevEnd} 사임 후 ${reGap.nextStart} 재취임(갭 ${reGap.days}일) 이력 존재`,
    confirm:`임기 사이 갭이 짧음(${reGap.days}일) → 임기만료 후 재취임 절차일 가능성. 실질 연속근무 입증 시 취득취소(전기간), 단절 시 일부기간만 해당. 사업장 확인 필요. ${wA.expired?'(잘못 납부 구간이 전부 소멸시효 밖)':'추정 '+fmtWindow(wA)}`};
  }
  if(wA.expired){
   return {j:'시효경과',reason:`[${label}] 보험취득일(${acq}) ≥ 임원취임일(${app}) → 취득취소 대상이나, 잘못 납부 구간(${acq} ~ ${loss||'현재'})이 전부 소멸시효(${STATUTE_YEARS}년·기준 ${CUTOFF}) 경과 → 환급 불가`,confirm:''};
  }
  return {j:'취득취소',reason:`[${label}] 보험취득일(${acq}) ≥ 임원취임일(${app}) → 처음부터 적용제외 대상. 취득 자체를 무효화(취득취소). ${fmtWindow(wA)}`,confirm:''};
 }
 if(acq && acq<app){
  if(!loss){
   // 상실 미신고 = 현재까지 납부 중 → 잘못 납부가 항상 시효 내(CUTOFF~현재)까지 이어짐.
   // 따라서 전체 부지급(시효경과)은 성립하지 않는다.
   const wB = refundWindow(app,null);
   if(reGap){
    return {j:'사업장확인필요',
     reason:`[${label}] 근로자 가입(${acq}) 후 임원 취임(${app}) → 1차 판정 상실신고. 단, ${reGap.prevEnd} 사임 후 ${reGap.nextStart} 재취임(갭 ${reGap.days}일) — 등기 정리용 형식적 사임 가능성`,
     confirm:`임기 갭(${reGap.days}일)이 짧음. 실질 연속 임원근무가 확인되면 가입 자체가 부적법 → 취득취소 대상으로 변경. 보수 지급내역·이사회 출석·실무 직책 확인 필요. ${fmtWindow(wB)}`};
   }
   return {j:'상실신고',reason:`[${label}] 근로자 가입(${acq}) 후 임원 취임(${app}) → 취임일에 근로자성 상실, 상실신고 누락. 상실일을 ${app}로 신고. ${fmtWindow(wB)}`,confirm:''};
  }
  if(loss<=app){
   return {j:'정상',reason:`[${label}] 임원 취임(${app}) 이전(또는 당일)에 이미 상실(${loss}) → 처리 완료`,confirm:''};
  }
  const diff = daysBetween(app,loss);
  if(diff!==null && diff<=LOSS_TOLERANCE_DAYS){
   return {j:'사업장확인필요',
    reason:`[${label}] 보험상실일(${loss})과 임원취임일(${app})의 차이가 ${diff}일 — 최종근무일 vs 퇴직처리일 기준차이로 추정`,
    confirm:`사업장이 등기상 날짜를 최종근무일로 보는지/익일 처리일로 보는지 확인 필요. 동일 의미일 경우 정정 불요(정상 처리), 아닐 경우 상실일정정`};
  }
  const wC = refundWindow(app,loss);
  if(wC.expired){
   return {j:'시효경과',reason:`[${label}] 가입(${acq}) 후 임원 취임(${app}), 상실일(${loss})이 늦으나 정정 대상 구간(${app} ~ ${loss})이 전부 소멸시효(${STATUTE_YEARS}년·기준 ${CUTOFF}) 경과 → 소급 정정 실익 없음`,confirm:''};
  }
  if(reGap){
   return {j:'사업장확인필요',
    reason:`[${label}] 가입(${acq}) 후 임원 취임(${app}), 상실일(${loss})이 늦음 → 1차 판정 상실일정정. 단, ${reGap.prevEnd} 사임 후 ${reGap.nextStart} 재취임(갭 ${reGap.days}일) 존재`,
    confirm:`임기 갭이 짧아 실질 연속근무 가능성. 입증되면 취득취소로 격상 가능. ${fmtWindow(wC)}`};
  }
  return {j:'상실일정정',reason:`[${label}] 가입(${acq}) 후 임원 취임(${app}), 상실일(${loss})이 늦음 → 상실일을 ${app}로 정정. ${fmtWindow(wC)}`,confirm:''};
 }
 return {j:'검토필요',reason:`[${label}] 보험 취득일 미확인`,confirm:''};
}

// ── 임원 1인 종합 판정 (고용·산재) ─────────────────────
function judge(off, recs){
 const mine = recs.filter(r=>recMatchesOfficer(r,off));
 const _diffNames = [...new Set(mine.map(r=>r.name).filter(n=>n&&n!==off.name))];
 const nameNote = _diffNames.length
  ? `[이름 표기 상이] 등기부 "${off.name}" ↔ 고용현황 "${_diffNames.join('", "')}" — 등록번호(${off.rrn}) 일치로 동일인 매칭(외국인 등 표기 차이 가능). 본인 여부 확인 권장.`
  : '';

 if(off.isHistorical){
  const periodMine = filterRecsForPeriod(mine, off.appoint, off.resign);
  const eRec = pickLatest(periodMine.filter(r=>r.type==='고용'));
  const sRec = pickLatest(periodMine.filter(r=>r.type==='산재'));
  if(!eRec && !sRec){
   return [{...off,judgment:'대상아님',judgmentE:'-',judgmentS:'-',
    reason:`[${off.periodLabel}] 해당 임기(${off.appoint} ~ ${off.resign}) 구간 내 고용·산재 가입이력 없음`,
    confirm:'',eAcq:'',eLoss:'',sAcq:'',sLoss:''}];
  }
  const ej = judgeOne(off,eRec,'고용');
  const sj = judgeOne(off,sRec,'산재');
  const top = (J_RANK[ej.j]||0)>=(J_RANK[sj.j]||0)?ej.j:sj.j;
  let reason = `[${off.periodLabel}: ${off.appoint} ~ ${off.resign}]\n`+ej.reason+'\n'+sj.reason;
  reason += `\n⚠ 과거 임기 — 고용현황 크로스체크 결과이며, 현행 임기와 별도로 확인 필요`;
  const confirms = [];
  if(ej.confirm) confirms.push(`[고용] ${ej.confirm}`);
  if(sj.confirm) confirms.push(`[산재] ${sj.confirm}`);
  confirms.push(`[과거임기] 해당 구간(${off.appoint}~${off.resign}) 중 보험 가입이력이 존재하므로 환급 대상 여부 별도 확인 필요`);
  if(nameNote) confirms.push(nameNote);
  return [{...off,judgment:top,judgmentE:ej.j,judgmentS:sj.j,reason,confirm:confirms.join('\n'),
   eAcq:eRec?.acq||'',eLoss:eRec?.loss||'',sAcq:sRec?.acq||'',sLoss:sRec?.loss||''}];
 }

 const eRecs = mine.filter(r=>r.type==='고용');
 const sRecs = mine.filter(r=>r.type==='산재');
 const eRec = pickLatest(eRecs);
 const sRec = pickLatest(sRecs);
 if(!eRec && !sRec){
  return [{...off,judgment:'대상아님',judgmentE:'-',judgmentS:'-',reason:'고용·산재 모두 가입이력 없음',confirm:'',eAcq:'',eLoss:'',sAcq:'',sLoss:''}];
 }
 const ej = judgeOne(off,eRec,'고용');
 const sj = judgeOne(off,sRec,'산재');
 const top = (J_RANK[ej.j]||0) >= (J_RANK[sj.j]||0) ? ej.j : sj.j;
 const notes = [];
 if(eRecs.length>1) notes.push(`고용 ${eRecs.length}건 중 최신 사용`);
 if(sRecs.length>1) notes.push(`산재 ${sRecs.length}건 중 최신 사용`);
 let reason = ej.reason + '\n' + sj.reason + (notes.length?'\n⚠ '+notes.join(' / '):'');
 if(off.totalPeriods>1) reason = `[${off.periodLabel}: ${off.appoint} ~ 현재]\n`+reason;
 const confirms = [];
 if(ej.confirm) confirms.push(`[고용] ${ej.confirm}`);
 if(sj.confirm) confirms.push(`[산재] ${sj.confirm}`);
 if(nameNote) confirms.push(nameNote);
 return [{...off,judgment:top,judgmentE:ej.j,judgmentS:sj.j,reason,confirm:confirms.join('\n'),
  eAcq:eRec?.acq||'',eLoss:eRec?.loss||'',sAcq:sRec?.acq||'',sLoss:sRec?.loss||''}];
}

// ── 진입점 ────────────────────────────────────────────
export function judgeDirector(registryText, employmentText){
 // 서버 장기 실행 대응: 시효 기준일을 호출 시점마다 갱신
 CUTOFF = statuteCutoff();
 TODAY = new Date().toISOString().slice(0,10);

 const officers = parseRegistry(registryText || '');
 // 공동대표 친족분석은 MVP 범위 외 → 플래그 기본값
 officers.forEach(o=>{ o.isCoCeo=false; o.coCeoPartners=[]; o.isActiveCoCeo=false; });
 const biz = extractBizInfo(registryText || '');
 const recs = parseEmpText(employmentText || '');

 const results = [];
 officers.forEach(o=>{ judge(o,recs).forEach(j=>results.push(j)); });

 return {
  cutoff: CUTOFF, today: TODAY,
  biz, officerCount: officers.length, recordCount: recs.length,
  results: results.map(r=>({
   pos:r.pos, name:r.name, rrn:r.rrn ? r.rrn+'-*' : '',
   periodLabel:r.periodLabel||'', appoint:r.appoint||'', resign:r.resign||'',
   judgment:r.judgment, judgmentE:r.judgmentE, judgmentS:r.judgmentS,
   eAcq:r.eAcq, eLoss:r.eLoss, sAcq:r.sAcq, sLoss:r.sLoss,
   reason:r.reason, confirm:r.confirm
  }))
 };
}

// 사람이 읽기 좋은 텍스트 요약 (Claude가 그대로 전달하기 좋도록)
export function formatDirectorResult(res){
 const lines = [];
 lines.push(`■ 4대보험 적용제외(근로자성) 판정 결과`);
 if(res.biz?.bizName || res.biz?.bizNo) lines.push(`사업장: ${res.biz.bizName||''} ${res.biz.bizNo||''}`.trim());
 lines.push(`소멸시효 기준일(오늘-3년): ${res.cutoff} / 기준일: ${res.today}`);
 lines.push(`임원 ${res.officerCount}명 · 고용현황 레코드 ${res.recordCount}건`);
 if(res.officerCount===0){
  lines.push(`\n⚠ 등기부에서 임원을 추출하지 못했습니다. 입력한 등기부 텍스트가 임원 직위/성명/등록번호(6자리) 형식을 포함하는지 확인하세요.`);
  return lines.join('\n');
 }
 const cnt = {};
 res.results.forEach(r=>cnt[r.judgment]=(cnt[r.judgment]||0)+1);
 lines.push(`요약: ` + Object.entries(cnt).map(([k,v])=>`${k} ${v}건`).join(' / '));
 res.results.forEach((r,i)=>{
  lines.push(`\n${i+1}. ${r.name} (${r.pos})${r.periodLabel?' ['+r.periodLabel+']':''} ${r.rrn}`);
  lines.push(`   임원 취임:${r.appoint||'-'} 퇴임:${r.resign||'-'} | 고용 취득:${r.eAcq||'-'} 상실:${r.eLoss||'-'} / 산재 취득:${r.sAcq||'-'} 상실:${r.sLoss||'-'}`);
  lines.push(`   판정: 고용=${r.judgmentE} · 산재=${r.judgmentS} (종합 ${r.judgment})`);
  if(r.reason) lines.push(`   사유: ${r.reason.replace(/\n/g,'\n         ')}`);
  if(r.confirm) lines.push(`   확인필요: ${r.confirm.replace(/\n/g,'\n         ')}`);
 });
 lines.push(`\n※ 본 판정은 체크리스트·등기부 크로스체크 기반 참고 자료입니다. 최종 판단은 담당 노무사·관할 근로복지공단이 확인합니다.`);
 lines.push(`※ 국민연금·건강보험은 본 도구에서 다루지 않습니다.`);
 return lines.join('\n');
}
