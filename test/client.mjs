// MCP 서버 통합 테스트: 서버가 떠 있는 상태에서 node test/client.mjs
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = process.env.MCP_URL || 'http://localhost:3000/mcp';
const transport = new StreamableHTTPClientTransport(new URL(url));
const client = new Client({ name: 'smoke-client', version: '1.0.0' });
await client.connect(transport);

const tools = await client.listTools();
console.log('tools:', tools.tools.map(t => t.name).join(', '));

const result = await client.callTool({
 name: 'judge_director',
 arguments: {
  registry_text: '사내이사 홍길동 800101-*******\n2019년 12월 02일 취임\n',
  employment_text: '산재보험 근로자 자격 이력\n800101-1****** 홍길동 2019-11-02\n'
 }
});
const text = result.content.map(c => c.text).join('\n');
console.log('---- tool result (앞부분) ----');
console.log(text.split('\n').slice(0, 8).join('\n'));
const ok = /상실신고/.test(text) && !/홍길동.*시효경과/.test(text);
console.log(ok ? '\n✅ MCP 통합 OK (judge_director 정상 응답)' : '\n❌ 예상과 다름');
await client.close();
process.exit(ok ? 0 : 1);
