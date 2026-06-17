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
import { z } from 'zod';
import { judgeDirector, formatDirectorResult } from './judge.mjs';

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
    '보험료 소멸시효 3년(징수법 §41)을 반영하며, 외국인은 등록번호 6자리로 동일인 매칭한다. ' +
    '사용법: 사용자가 올린 등기부등본 PDF와 고용현황(PDF/엑셀)을 너(Claude)가 읽어 ' +
    '원문 텍스트를 그대로 추출한 뒤 registry_text·employment_text 로 전달하라. ' +
    '등기부 텍스트에는 직위·성명·등록번호(앞 6자리)·취임/사임/중임/퇴임 등 날짜를, ' +
    '고용현황에는 성명·등록번호 앞 6자리·취득일·상실일·보험구분(고용/산재)을 최대한 보존할 것.',
   inputSchema: {
    registry_text: z.string().min(1).describe('법인등기부등본 원문 텍스트(임원 직위·성명·등록번호 6자리·취임/사임 등 날짜 포함)'),
    employment_text: z.string().min(1).describe('4대보험 고용현황 원문 텍스트(성명·등록번호 6자리·취득일·상실일·보험구분 포함)')
   }
  },
  async ({ registry_text, employment_text }) => {
   const res = judgeDirector(registry_text, employment_text);
   const text = formatDirectorResult(res);
   return {
    content: [
     { type: 'text', text },
     { type: 'text', text: '\n[구조화 결과 JSON]\n' + JSON.stringify(res, null, 2) }
    ]
   };
  }
 );

 return server;
}

const app = express();
app.use(express.json({ limit: '4mb' }));

// 헬스체크 (Render)
app.get('/', (_req, res) => res.json({ ok: true, service: 'dowon-insurance-mcp', tool: 'judge_director' }));

app.post('/mcp', async (req, res) => {
 if (AUTH_TOKEN) {
  const auth = req.headers['authorization'] || '';
  if (auth !== `Bearer ${AUTH_TOKEN}`) {
   return res.status(401).json({ jsonrpc:'2.0', error:{ code:-32001, message:'Unauthorized' }, id:null });
  }
 }
 try {
  const server = buildServer();
  // stateless: 요청마다 새 transport (세션 ID 미사용)
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
 } catch (e) {
  console.error('MCP 처리 오류:', e);
  if (!res.headersSent) {
   res.status(500).json({ jsonrpc:'2.0', error:{ code:-32603, message:'Internal server error' }, id:null });
  }
 }
});

// stateless 모드에서는 GET/DELETE /mcp(SSE 스트림·세션 종료)를 사용하지 않음
app.get('/mcp', (_req, res) => res.status(405).json({ jsonrpc:'2.0', error:{ code:-32000, message:'Method not allowed (stateless)' }, id:null }));
app.delete('/mcp', (_req, res) => res.status(405).json({ jsonrpc:'2.0', error:{ code:-32000, message:'Method not allowed (stateless)' }, id:null }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`dowon-insurance-mcp listening on :${PORT} (POST /mcp)`));
