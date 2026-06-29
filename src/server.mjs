/**
 * 도원 4대보험 판정 MCP 서버 (원격 / Streamable HTTP, stateless)
 * - claude.ai 커스텀 커넥터 / Claude Desktop / Claude Code 에서 연결.
 * - OCR은 클라이언트(Claude)가 담당: 대화창에 올린 등기부·고용현황 PDF를
 *   Claude가 읽어 텍스트로 추출한 뒤 judge_director 도구에 넘긴다(서버에 API 키 불필요).
 */
import express from 'express';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
 judgeDirector, formatDirectorResult,
 judgeFamily, formatFamilyResult, FAMILY_RELATIONS, FAMILY_POSITIVE, FAMILY_NEGATIVE,
 judgeNonreg, formatNonregResult, NONREG_NEGATIVE, NONREG_POSITIVE,
 analyzeCeoFamily, formatCeoFamilyResult
} from './judge.mjs';

const cat = arr => arr.map(f => `${f.id}(${f.w}): ${f.label}`).join(' / ');

// 선택적 보호: AUTH_TOKEN 환경변수가 있으면 Authorization: Bearer 검사
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';

function buildServer(){
 const server = new McpServer({ name: 'dowon-insurance-mcp', version: '1.0.0' });

 server.registerTool(
  'judge_director',
  {
   title: '등기임원 4대보험 적용제외 판정',
   description:
    '법인등기부등본 텍스트와 4대보험 고용현황 텍스트를 받아, 등기임원(대표이사·이사·감사 등)별로 ' +
    '고용·산재보험 적용제외 여부(취득취소/상실신고/상실일정정/시효경과/정상)와 환급구간을 판정한다. ' +
    '보험료 소멸시효 3년(징수법 §41)을 KST 기준으로 반영하며, 외국인은 등록번호 6자리로 동일인 매칭한다. ' +
    '【직위 판정강도】 적용제외는 직위가 아니라 근로자성 부인으로 성립한다(대법 2003다5061). ' +
    '대표이사·이사장은 적용제외 원칙으로 날짜 판정을 그대로 내고, 사내이사·이사·감사는 근로자성 인정 여지가 커 ' +
    "기본적으로 '검토필요'로 보수적 하향(잠정판정은 사유에 보존)한다. " +
    '사내이사·이사·감사의 근로자성(상근/업무집행권/지휘감독/위임계약 여부)을 사용자 문답이나 서류로 확인했다면 ' +
    'officer_status 로 전달해 확정하라(non_worker=취득취소 등 액션 유지 / worker=정상). ' +
    '사용법: 사용자가 올린 등기부등본 PDF와 고용현황(PDF/엑셀)을 너(Claude)가 읽어 ' +
    '원문 텍스트를 그대로 추출한 뒤 registry_text·employment_text 로 전달하라. ' +
    '등기부 텍스트에는 직위·성명·등록번호(앞 6자리)·취임/사임/중임/퇴임 등 날짜를, ' +
    '고용현황에는 성명·등록번호 앞 6자리·취득일·상실일·보험구분(고용/산재)을 최대한 보존할 것. ' +
    '국민연금·건강보험(무보수 대표 적용제외 등)은 본 도구 범위 밖이다.',
   inputSchema: {
    registry_text: z.string().min(1).describe('법인등기부등본 원문 텍스트(임원 직위·성명·등록번호 6자리·취임/사임 등 날짜 포함)'),
    employment_text: z.string().min(1).describe('4대보험 고용현황 원문 텍스트(성명·등록번호 6자리·취득일·상실일·보험구분 포함)'),
    officer_status: z.array(z.object({
     name: z.string().describe('등기부상 성명(영문명 포함, 등기부 표기와 동일하게)'),
     rrn6: z.string().optional().describe('등록번호 앞 6자리(생년월일). 동명이인 구분용, 가능하면 함께 전달'),
     worker_status: z.enum(['non_worker','worker','unknown']).describe("근로자성 확정값: non_worker(근로자 아님 → 취득취소 등 액션 유지) | worker(근로자 인정 → 정상) | unknown(미확인, 기본)")
    })).optional().describe("사내이사·이사·감사의 근로자성을 확인한 경우에만 전달. 대표이사·이사장은 보통 불필요. 미확인 임원은 생략(기본 '검토필요').")
   }
  },
  async ({ registry_text, employment_text, officer_status }) => {
   const res = judgeDirector(registry_text, employment_text, officer_status);
   const text = formatDirectorResult(res);
   return {
    content: [
     { type: 'text', text },
     { type: 'text', text: '\n[구조화 결과 JSON]\n' + JSON.stringify(res, null, 2) }
    ]
   };
  }
 );

 server.registerTool(
  'judge_family',
  {
   title: '가족종사자 4대보험 적용제외 판정',
   description:
    '동거 가족 근로자(배우자·직계존비속·형제자매 등)의 근로자성을 체크리스트 점수로 평가해 ' +
    '고용·산재보험 적용제외(취득취소 가능/검토필요/정상) 여부를 판정한다. ' +
    '사용자와의 문답 또는 제출 서류로 각 대상자의 관계·동거여부·취득일과 아래 근로자성 요소 해당 여부를 파악해 전달하라.\n' +
    `관계(relation) 후보: ${FAMILY_RELATIONS.join(' / ')}\n` +
    `근로자성 인정요소 positive_factors 후보: ${cat(FAMILY_POSITIVE)}\n` +
    `근로자성 부인요소 negative_factors 후보: ${cat(FAMILY_NEGATIVE)}\n` +
    '점수=인정요소 가중치 합 − 부인요소 가중치 합. 점수가 낮을수록 적용제외(취득취소) 가능성↑.',
   inputSchema: {
    business_type: z.enum(['corp','sole']).default('corp').describe('사업장 유형: corp(법인) | sole(개인사업자)'),
    members: z.array(z.object({
     name: z.string().describe('성명'),
     relation: z.string().describe(`대표자와의 관계 (${FAMILY_RELATIONS.join(' / ')})`),
     cohabiting: z.boolean().describe('동거 여부(주민등록등본상 동일 주소지)'),
     emp_acquire_date: z.string().optional().describe('고용보험 취득일 YYYY-MM-DD'),
     acc_acquire_date: z.string().optional().describe('산재보험 취득일 YYYY-MM-DD'),
     positive_factors: z.array(z.string()).default([]).describe('해당하는 근로자성 인정요소 id 목록'),
     negative_factors: z.array(z.string()).default([]).describe('해당하는 근로자성 부인요소 id 목록')
    })).min(1)
   }
  },
  async ({ business_type, members }) => {
   const res = judgeFamily(members, business_type);
   return { content: [
    { type:'text', text: formatFamilyResult(res) },
    { type:'text', text: '\n[구조화 결과 JSON]\n' + JSON.stringify(res, null, 2) }
   ] };
  }
 );

 server.registerTool(
  'judge_nonreg',
  {
   title: '비등기임원 4대보험 적용제외 판정',
   description:
    '등기되지 않은 임원(비등기임원)의 근로자성을 계약유형 + 체크리스트 점수로 평가해 ' +
    '고용·산재보험 적용제외(취득취소 가능/검토필요/정상) 여부를 판정한다. ' +
    '사용자 문답 또는 제출 서류로 계약유형과 아래 요소 해당 여부를 파악해 전달하라.\n' +
    '계약유형(contract_type): delegation(임원위촉·위임계약) | labor(근로계약서) | none(구두·없음)\n' +
    `근로자성 부인요소 negative_factors 후보: ${cat(NONREG_NEGATIVE)}\n` +
    `근로자성 인정요소 positive_factors 후보: ${cat(NONREG_POSITIVE)}\n` +
    '순점수=부인요소 합 − 인정요소 합. 순점수가 높을수록 적용제외(취득취소) 가능성↑.',
   inputSchema: {
    members: z.array(z.object({
     title: z.string().default('임원').describe('직위(예: 전무, 본부장)'),
     name: z.string().describe('성명'),
     contract_type: z.enum(['delegation','labor','none']).describe('계약유형'),
     emp_acquire_date: z.string().optional().describe('고용보험 취득일 YYYY-MM-DD'),
     acc_acquire_date: z.string().optional().describe('산재보험 취득일 YYYY-MM-DD'),
     negative_factors: z.array(z.string()).default([]).describe('해당하는 근로자성 부인요소 id 목록'),
     positive_factors: z.array(z.string()).default([]).describe('해당하는 근로자성 인정요소 id 목록')
    })).min(1)
   }
  },
  async ({ members }) => {
   const res = judgeNonreg(members);
   return { content: [
    { type:'text', text: formatNonregResult(res) },
    { type:'text', text: '\n[구조화 결과 JSON]\n' + JSON.stringify(res, null, 2) }
   ] };
  }
 );

 server.registerTool(
  'analyze_ceo_family',
  {
   title: '대표이사 공동대표·친족 분석',
   description:
    '법인등기부등본 텍스트에서 대표이사 임기 이력을 추출해 (1) 공동대표이사 체제(겹치는 재임 구간), ' +
    '(2) 대표이사 변경 이력, (3) 대표이사 간 등기부 주소 동일/유사(동일 건물+호수)에 따른 친족·친족의심 쌍을 분석한다. ' +
    '주소가 일치하면 친족(동거친족 등 적용제외 검토 대상) 가능성을 환기하나, 등기부 주소만으로는 한계가 있어 ' +
    '가족관계증명서·주민등록등본 별도 확인이 필요하다. ' +
    '사용법: 사용자가 올린 등기부등본 PDF를 너(Claude)가 읽어 대표이사·이사장 직위·성명·등록번호 6자리·주소·취임/사임 날짜를 보존한 원문 텍스트로 전달하라.',
   inputSchema: {
    registry_text: z.string().min(1).describe('법인등기부등본 원문 텍스트(대표이사·이사장 직위·성명·등록번호 6자리·주소·취임/사임 날짜 포함)')
   }
  },
  async ({ registry_text }) => {
   const res = analyzeCeoFamily(registry_text);
   return { content: [
    { type:'text', text: formatCeoFamilyResult(res) },
    { type:'text', text: '\n[구조화 결과 JSON]\n' + JSON.stringify(res, null, 2) }
   ] };
  }
 );

 return server;
}

const app = express();
app.use(express.json({ limit: '4mb' }));

// 헬스체크 (Render)
app.get('/', (_req, res) => res.json({ ok: true, service: 'dowon-insurance-mcp', tools: ['judge_director','judge_family','judge_nonreg','analyze_ceo_family'] }));

function checkAuth(req, res){
 if (!AUTH_TOKEN) return true;
 const auth = req.headers['authorization'] || '';
 if (auth !== `Bearer ${AUTH_TOKEN}`){
  res.status(401).json({ jsonrpc:'2.0', error:{ code:-32001, message:'Unauthorized' }, id:null });
  return false;
 }
 return true;
}

// 세션ID → transport (stateful Streamable HTTP — claude.ai 웹 호환)
const transports = {};

app.post('/mcp', async (req, res) => {
 if (!checkAuth(req, res)) return;
 try {
  const sid = req.headers['mcp-session-id'];
  let transport;
  if (sid && transports[sid]) {
   transport = transports[sid];                       // 기존 세션 재사용
  } else if (!sid && isInitializeRequest(req.body)) {
   // 새 세션 초기화
   transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (newId) => { transports[newId] = transport; }
   });
   transport.onclose = () => { if (transport.sessionId) delete transports[transport.sessionId]; };
   const server = buildServer();
   await server.connect(transport);
  } else {
   return res.status(400).json({ jsonrpc:'2.0', error:{ code:-32000, message:'Bad Request: 유효한 세션 ID가 없습니다' }, id:null });
  }
  await transport.handleRequest(req, res, req.body);
 } catch (e) {
  console.error('MCP 처리 오류:', e);
  if (!res.headersSent) res.status(500).json({ jsonrpc:'2.0', error:{ code:-32603, message:'Internal server error' }, id:null });
 }
});

// GET=SSE 스트림 / DELETE=세션 종료 (세션ID 필요)
async function handleSession(req, res){
 if (!checkAuth(req, res)) return;
 const sid = req.headers['mcp-session-id'];
 if (!sid || !transports[sid]) return res.status(400).send('유효한 세션 ID가 없습니다');
 await transports[sid].handleRequest(req, res);
}
app.get('/mcp', handleSession);
app.delete('/mcp', handleSession);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`dowon-insurance-mcp listening on :${PORT} (Streamable HTTP /mcp, stateful)`));
