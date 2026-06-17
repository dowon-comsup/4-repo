// MCP 서버 통합 테스트: 서버가 떠 있는 상태에서 node test/client.mjs
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = process.env.MCP_URL || 'http://localhost:3000/mcp';
const transport = new StreamableHTTPClientTransport(new URL(url));
const client = new Client({ name: 'smoke-client', version: '1.0.0' });
await client.connect(transport);

const tools = await client.listTools();
const names = tools.tools.map(t => t.name);
console.log('tools:', names.join(', '));
const has4 = ['judge_director','judge_family','judge_nonreg','analyze_ceo_family'].every(n => names.includes(n));

const r1 = await client.callTool({ name:'judge_director', arguments:{
 registry_text:'사내이사 홍길동 800101-*******\n2019년 12월 02일 취임\n',
 employment_text:'산재보험 근로자 자격 이력\n800101-1****** 홍길동 2019-11-02\n'
}});
const t1 = r1.content.map(c=>c.text).join('\n');

const r2 = await client.callTool({ name:'judge_family', arguments:{
 business_type:'corp',
 members:[{ name:'배우자A', relation:'배우자', cohabiting:true, positive_factors:[], negative_factors:[] }]
}});
const t2 = r2.content.map(c=>c.text).join('\n');

console.log('---- judge_family 응답(앞부분) ----');
console.log(t2.split('\n').slice(0,5).join('\n'));
const r3 = await client.callTool({ name:'analyze_ceo_family', arguments:{
 registry_text:'대표이사 김대표 600101-*******  서울특별시 강남구 역삼로 212, 706호\n2018년 01월 01일 취임\n대표이사 김배우 650505-*******  서울특별시 강남구 역삼로 212, 706호\n2018년 01월 01일 취임\n'
}});
const t3 = r3.content.map(c=>c.text).join('\n');

const ok = has4 && /상실신고/.test(t1) && !/홍길동.*시효경과/.test(t1) && /취득취소 가능/.test(t2) && /공동대표/.test(t3) && /친족/.test(t3);
console.log(ok ? '\n✅ MCP 통합 OK (4개 도구 노출 + director/family/ceo 정상)' : '\n❌ 예상과 다름');
await client.close();
process.exit(ok ? 0 : 1);
