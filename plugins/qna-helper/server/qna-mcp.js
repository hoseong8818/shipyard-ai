#!/usr/bin/env node
// 사내 QnA 게시판 MCP 서버. 외부 패키지 없음, stdio JSON-RPC(한 줄에 메시지 하나).
// 게시판 주소는 환경 변수 QNA_API (예: http://localhost:3001). API는 board-api.md 참고.

const BASE = (process.env.QNA_API || '').replace(/\/+$/, '');
const PROTOCOL_VERSION = '2024-11-05';
const TIMEOUT_MS = 10000;

const TOOLS = [
  {
    name: 'search_questions',
    description:
      '사내 QnA 게시판에서 질문을 검색한다. 검색어는 핵심 용어 1~3개만 쓴다(예: "선미 블록 도면"). ' +
      '문장 전체를 넣지 않는다. 모든 용어가 들어간 질문만 찾으므로 결과가 없으면 용어를 줄이거나 바꿔 다시 검색한다. ' +
      '검색 결과는 요약뿐이다. 답하기 전에 반드시 get_question으로 원문과 답변을 읽는다.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '핵심 용어 1~3개, 공백으로 구분 (1~100자)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_question',
    description:
      '질문 번호로 질문 원문과 모든 답변(채택 여부 포함)을 가져온다. ' +
      '답하기 전에 search_questions 결과의 질문을 이 도구로 읽고, 채택된 답변과 채택되지 않은 답변을 구분해서 답한다.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', minimum: 1, description: '질문 번호' },
      },
      required: ['id'],
    },
  },
];

const link = (id) => `${BASE}/q/${id}`;

async function api(path) {
  if (!BASE) throw new Error('환경 변수 QNA_API(게시판 주소)가 설정되지 않았습니다.');
  let res;
  try {
    res = await fetch(BASE + path, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new Error(`게시판에 연결하지 못했습니다. 주소(${BASE})와 서버 상태를 확인하세요.`);
  }
  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error(`게시판 응답을 읽지 못했습니다 (HTTP ${res.status}).`);
  }
  if (!res.ok || body.error) {
    const e = body.error || {};
    const err = new Error(e.message || `HTTP ${res.status}`);
    err.code = e.code;
    err.status = res.status;
    throw err;
  }
  return body.data;
}

function formatSummary(q) {
  const parts = [`#${q.id} ${q.title}`, `${q.dept}`, q.hullNo, q.stage].filter(Boolean);
  const state = q.hasAccepted ? '채택 답변 있음' : q.answerCount > 0 ? '답변 있음(채택 없음)' : '답변 없음';
  return `- ${parts.join(' | ')} | 답변 ${q.answerCount}개, ${state}\n  링크: ${link(q.id)}`;
}

async function searchQuestions({ query }) {
  const q = typeof query === 'string' ? query.trim() : '';
  if (!q) throw new Error('query가 비어 있습니다. 핵심 용어 1~3개를 넣으세요.');
  const data = await api(`/search?q=${encodeURIComponent(q)}`);
  if (!data.items.length) {
    return `결과 없음: "${q}"에 해당하는 질문이 게시판에 없습니다. 용어를 줄이거나 다른 표현으로 다시 검색해 보세요.`;
  }
  return `"${q}" 검색 결과 ${data.items.length}건 (채택 답변 있는 질문 먼저). 답하기 전에 get_question으로 원문을 읽으세요.\n` +
    data.items.map(formatSummary).join('\n');
}

async function getQuestion({ id }) {
  const n = Number(id);
  if (!Number.isInteger(n) || n < 1) throw new Error('id는 1 이상의 정수여야 합니다.');
  let q;
  try {
    q = await api(`/questions/${n}`);
  } catch (e) {
    if (e.status === 404) return `결과 없음: ${n}번 질문이 없습니다.`;
    throw e;
  }
  const lines = [
    `# #${q.id} ${q.title}`,
    `부서: ${q.dept} | 호선: ${q.hullNo} | 공정: ${q.stage} | 작성자: ${q.authorName} | 등록: ${q.createdAt}`,
    `링크: ${link(q.id)}`,
    '',
    '## 질문 본문',
    q.body,
    '',
    `## 답변 ${q.answers.length}개`,
  ];
  if (!q.answers.length) lines.push('(답변 없음)');
  for (const a of q.answers) {
    lines.push('', `### ${a.accepted ? '[채택된 답변]' : '[채택되지 않은 답변]'} ${a.authorName} (${a.createdAt})`, a.body);
  }
  if (q.answers.length && !q.answers.some((a) => a.accepted)) {
    lines.push('', '※ 채택된 답변이 없습니다.');
  }
  return lines.join('\n');
}

const HANDLERS = { search_questions: searchQuestions, get_question: getQuestion };

async function callTool(name, args) {
  const fn = HANDLERS[name];
  if (!fn) return null;
  try {
    return { content: [{ type: 'text', text: await fn(args || {}) }] };
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: `게시판 조회 실패: ${e.message}` }] };
  }
}

async function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  const ok = (result) => isRequest && send({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => isRequest && send({ jsonrpc: '2.0', id, error: { code, message } });

  switch (method) {
    case 'initialize':
      return ok({
        protocolVersion: params?.protocolVersion || PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'qna', version: '1.0.0' },
      });
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: TOOLS });
    case 'tools/call': {
      const result = await callTool(params?.name, params?.arguments);
      return result ? ok(result) : fail(-32602, `알 수 없는 도구: ${params?.name}`);
    }
    default:
      if (!isRequest) return; // notifications/initialized 등은 무시
      return fail(-32601, `지원하지 않는 메서드: ${method}`);
  }
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      continue;
    }
    handle(msg).catch((e) => {
      if (msg.id !== undefined && msg.id !== null) {
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: e.message } });
      }
    });
  }
});
