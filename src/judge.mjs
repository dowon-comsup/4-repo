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

// =====================================================================
// 가족종사자 판정 (점수 체크리스트) — 출처: insurance-tools 가족종사자 탭
// =====================================================================
export const FAMILY_RELATIONS = ['배우자','직계존속 (부모·조부모 등)','직계비속 (자녀·손자녀 등)','형제자매','기타 친족 (4촌 이내)'];
export const FAMILY_POSITIVE = [ // 근로자성 인정요소 (+)
 { id:'contract',    w:2, label:'서면 근로계약서 작성·보관' },
 { id:'transfer',    w:2, label:'타 근로자와 동일 조건 계좌이체 급여 지급' },
 { id:'payslip',     w:1, label:'임금명세서 정기 발급 (근기법 §48②)' },
 { id:'attendance',  w:2, label:'출근부·근태기록·업무지시 문서화' },
 { id:'benefit',     w:1, label:'타 근로자와 동일한 연차·퇴직금 적용' },
 { id:'withholding', w:1, label:'근로소득세(갑종) 원천징수 신고' },
];
export const FAMILY_NEGATIVE = [ // 근로자성 부인요소 (−)
 { id:'profitShare', w:1, label:'급여가 사업 이익에 따라 변동 또는 배당 성격' },
 { id:'noControl',   w:1, label:'근무시간·장소 지정 없이 자유롭게 업무 수행' },
 { id:'management',  w:1, label:'사업장 운영·경영 의사결정에 실질 참여' },
];

function _judgeFamilyOne({ name, rel, live, eAcq, sAcq, score, bizType }){
 const cutoff = CUTOFF;
 if(!live){
  return { name, rel, live:false, score:'—',
   empJ:'정상 (비동거)', empD:'비동거 가족은 일반 근로자와 동일 기준. 고용·산재 가입 정상.',
   accJ:'정상 (비동거)', accD:'비동거. 산재보험 가입 정상.', eTO:null, sTO:null, eAcq, sAcq };
 }
 const isClose = rel.startsWith('배우자')||rel.startsWith('직계존속')||rel.startsWith('직계비속')||rel.startsWith('형제자매');
 if(!isClose){
  return { name, rel, live:true, score:'—',
   empJ:'검토필요', empD:'기타 친족(4촌 이내)은 고용보험법상 명시 적용제외 조항 없음. 실질 근로관계 여부로 판단. 노무사 검토 권고.',
   accJ:'검토필요', accD:'산재보험도 실질 노무 제공 여부로 판단. 노무사 검토 권고.', eTO:null, sTO:null, eAcq, sAcq };
 }
 const bizNote = bizType==='sole'
  ? '개인사업자 동거친족 — 행정해석상 독립적 근로관계 성립을 더 엄격하게 판단.'
  : '법인 대표이사 동거가족 — 법인 소속 근로자로서 근로자성 성립 가능하나 실질 판단 필요.';
 let empJ, empD;
 if(score<=2){ empJ='취득취소 가능'; empD=`동거 ${rel} + 근로자성 낮음(${score}점) → 고용보험 적용제외 가능성 높음. 취득취소 검토. ${bizNote}`; }
 else if(score<=5){ empJ='검토필요'; empD=`동거 ${rel} + 근로자성 모호(${score}점) → 근로계약서·이체확인증·출근부 보강 후 재판단 필요. ${bizNote}`; }
 else { empJ='정상 (근로자성 인정)'; empD=`동거 ${rel}이나 근로자성 충분히 인정(${score}점) → 고용보험 가입 유지 권고. ${bizNote}`; }
 let accJ, accD;
 if(score<=1){ accJ='취득취소 가능'; accD=`동거 ${rel} + 근로자성 매우 낮음(${score}점) → 산재보험 적용제외 검토. 단, 산재는 일시적 노무 제공도 포함되므로 실질 확인 후 신중 판단.`; }
 else if(score<=4){ accJ='검토필요'; accD=`동거 ${rel} + 근로자성 낮음~모호(${score}점) → 산재보험은 적용 범위가 넓어 취득취소보다 상실신고·유지가 많음. 별도 검토 권고.`; }
 else { accJ='정상 (근로자성 인정)'; accD=`동거 ${rel}이나 근로자성 인정(${score}점) → 산재보험 가입 유지 권고.`; }
 const toStr=(acq,label)=>{ if(!acq)return null; if(acq<cutoff) return `${label} 취득일(${acq}) < 소멸시효 기준(${cutoff}) → 시효 내 기간(${cutoff} ~)만 환급 가능`; return `${label} 취득일(${acq}) → 전체 기간 시효 내 (기준: ${cutoff})`; };
 return { name, rel, live:true, score, empJ, empD, accJ, accD, eTO:toStr(eAcq,'고용보험'), sTO:toStr(sAcq,'산재보험'), eAcq, sAcq };
}

function sumWeights(catalog, ids){
 const set = new Set(ids||[]);
 return catalog.reduce((s,c)=> s + (set.has(c.id) ? c.w : 0), 0);
}

export function judgeFamily(members, bizType){
 CUTOFF = statuteCutoff(); TODAY = new Date().toISOString().slice(0,10);
 const bt = bizType==='sole' ? 'sole' : 'corp';
 const results = (members||[]).map(m=>{
  const pos = sumWeights(FAMILY_POSITIVE, m.positive_factors);
  const neg = sumWeights(FAMILY_NEGATIVE, m.negative_factors);
  const score = pos - neg;
  return _judgeFamilyOne({
   name: m.name||'(무명)', rel: m.relation||'', live: !!m.cohabiting,
   eAcq: fmtDate(m.emp_acquire_date), sAcq: fmtDate(m.acc_acquire_date),
   score, bizType: bt
  });
 });
 return { cutoff: CUTOFF, bizType: bt, results };
}

export function formatFamilyResult(res){
 const L=[`■ 가족종사자 4대보험 적용제외 판정 (사업장유형: ${res.bizType==='sole'?'개인사업자':'법인'})`,`소멸시효 기준일: ${res.cutoff}`];
 if(!res.results.length){ L.push('대상자가 없습니다.'); return L.join('\n'); }
 res.results.forEach((r,i)=>{
  L.push(`\n${i+1}. ${r.name} (${r.rel}) · ${r.live?'동거':'비동거'} · 근로자성점수 ${r.score}`);
  L.push(`   고용: ${r.empJ} — ${r.empD}`);
  L.push(`   산재: ${r.accJ} — ${r.accD}`);
  [r.eTO,r.sTO].filter(Boolean).forEach(t=>L.push(`   시효: ${t}`));
 });
 L.push(`\n※ 동거 여부는 주민등록등본상 동일 주소지 기준. 취득취소 가능 결과는 실업급여·고용지원금 수급 이력·이직확인서 처리 여부 확인 필수.`);
 L.push(`※ 참고 자료 — 최종 판단은 담당 노무사·관할 근로복지공단. 국민연금·건강보험 미대상.`);
 return L.join('\n');
}

// =====================================================================
// 비등기임원 판정 (점수 체크리스트) — 출처: insurance-tools 비등기임원 탭
// =====================================================================
export const NONREG_NEGATIVE = [ // 근로자성 부인요소 (적용제외 방향)
 { id:'delegation',   w:3, label:'임원위촉계약서(위임계약) 작성·보관' },
 { id:'management',   w:2, label:'이사회·경영회의 참여 및 경영의사결정 실질 관여' },
 { id:'freeWork',     w:2, label:'근무시간·장소 미규정, 출퇴근 자유' },
 { id:'authority',    w:1, label:'타 근로자 채용·지휘·감독 권한 보유' },
 { id:'remuneration', w:1, label:'임원보수로 처리 (갑종 근로소득세 아닌 임원보수세)' },
];
export const NONREG_POSITIVE = [ // 근로자성 인정요소 (정상 유지 방향)
 { id:'laborContract', w:3, label:'근로계약서 체결' },
 { id:'attendance',   w:2, label:'타 직원과 동일한 출퇴근·근태 관리' },
 { id:'benefit',      w:2, label:'타 직원과 동일 복리후생(연차·퇴직금 등) 적용' },
 { id:'withholding',  w:1, label:'갑종 근로소득세 원천징수 신고' },
 { id:'payslip',      w:1, label:'급여명세서 정기 발급 (근기법 §48②)' },
];

function _judgeNonregOne({ title, name, contract, eAcq, sAcq, neg, pos }){
 const cutoff = CUTOFF; const net = neg - pos;
 const baseNote = ({
  delegation:'임원위촉계약서(위임계약) — 상법상 위임관계. 원칙적으로 근로자성 낮음.',
  labor:'근로계약서 체결 — 근로자성 인정 가능성 높음.',
  none:'별도 계약 없음(구두) — 실질 근로관계 여부로 판단.',
 })[contract] || '계약유형 미선택 — 계약서 확인 필요.';
 let empJ, empD;
 // 근로계약서가 있어도 순점수>0(부인요소 우세)이면 아래 net 분기로 계속 평가됨
 if(contract==='labor' && net<=0){ empJ='정상 (근로자성 인정)'; empD=`근로계약서 체결 + 인정요소 우세(순점수 ${net}점) → 고용보험 가입 유지 권고. ${baseNote}`; }
 else if(net>=4){ empJ='취득취소 가능'; empD=`부인요소 우세(순점수 +${net}점) → 고용보험 적용제외 검토. ${baseNote}`; }
 else if(net>=1){ empJ='검토필요'; empD=`판단 모호(순점수 +${net}점) → 서류 보강 및 관할 근로복지공단 확인 권고. ${baseNote}`; }
 else { empJ='정상 (근로자성 인정)'; empD=`인정요소 우세(순점수 ${net}점) → 고용보험 가입 유지 권고. ${baseNote}`; }
 let accJ, accD;
 if(contract==='labor' && net<=0){ accJ='정상 (근로자성 인정)'; accD='근로계약서 체결 + 인정요소 우세 → 산재보험 가입 유지 권고.'; }
 else if(net>=5){ accJ='취득취소 가능'; accD=`부인요소 강함(순점수 +${net}점) → 산재보험 적용제외 검토. 단, 산재는 실질 노무 제공 기준이 넓어 신중 판단 필요.`; }
 else if(net>=2){ accJ='검토필요'; accD=`판단 모호(순점수 +${net}점) → 산재보험은 적용 범위가 넓어 취득취소보다 유지 결론이 많음. 별도 검토 권고.`; }
 else { accJ='정상 (근로자성 인정)'; accD=`인정요소 우세(순점수 ${net}점) → 산재보험 가입 유지 권고.`; }
 const toStr=(acq,label)=>{ if(!acq)return null; if(acq<cutoff) return `${label} 취득일(${acq}) < 소멸시효 기준(${cutoff}) → 시효 내(${cutoff}~)만 환급`; return `${label} 취득일(${acq}) → 전체 기간 시효 내 (기준: ${cutoff})`; };
 return { title, name, contract, neg, pos, net, empJ, empD, accJ, accD, eTO:toStr(eAcq,'고용보험'), sTO:toStr(sAcq,'산재보험'), eAcq, sAcq };
}

export function judgeNonreg(members){
 CUTOFF = statuteCutoff(); TODAY = new Date().toISOString().slice(0,10);
 const results = (members||[]).map(m=>{
  const neg = sumWeights(NONREG_NEGATIVE, m.negative_factors);
  const pos = sumWeights(NONREG_POSITIVE, m.positive_factors);
  const contract = ['delegation','labor','none'].includes(m.contract_type) ? m.contract_type : '';
  return _judgeNonregOne({
   title: m.title||'임원', name: m.name||'(무명)', contract,
   eAcq: fmtDate(m.emp_acquire_date), sAcq: fmtDate(m.acc_acquire_date), neg, pos
  });
 });
 return { cutoff: CUTOFF, results };
}

export function formatNonregResult(res){
 const cl={delegation:'임원위촉(위임)',labor:'근로계약서',none:'없음(구두)','':'미선택'};
 const L=[`■ 비등기임원 4대보험 적용제외 판정`,`소멸시효 기준일: ${res.cutoff}`];
 if(!res.results.length){ L.push('대상자가 없습니다.'); return L.join('\n'); }
 res.results.forEach((r,i)=>{
  L.push(`\n${i+1}. ${r.name} (${r.title}) · 계약유형 ${cl[r.contract]||r.contract} · 부인 ${r.neg}/인정 ${r.pos}/순점수 ${r.net>=0?'+':''}${r.net}`);
  L.push(`   고용: ${r.empJ} — ${r.empD}`);
  L.push(`   산재: ${r.accJ} — ${r.accD}`);
  [r.eTO,r.sTO].filter(Boolean).forEach(t=>L.push(`   시효: ${t}`));
 });
 L.push(`\n※ 임원위촉계약서가 있어도 실질 근로관계(출퇴근 통제·급여명세서 발급 등)가 인정되면 취득취소 불가. 비등기임원도 실질 지배종속 관계면 4대보험 의무가입.`);
 L.push(`※ 참고 자료 — 최종 판단은 담당 노무사·관할 근로복지공단. 국민연금·건강보험 미대상.`);
 return L.join('\n');
}
