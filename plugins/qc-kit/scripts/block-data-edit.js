#!/usr/bin/env node
// PreToolUse 훅: data/ 아래 원본 검사 데이터의 편집·삭제·이동을 차단한다.
// 읽기(cat, openpyxl load_workbook 등)는 허용하고, 결과물은 out/ 에 쓰도록 안내한다.
const path = require("path");

const IS_WIN = process.platform === "win32";
const norm = (p) => (IS_WIN ? p.toLowerCase() : p);

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    })
  );
  process.exit(0);
}

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    process.exit(0); // 입력을 해석할 수 없으면 통과
  }

  // cwd 는 세션 중 바뀔 수 있으므로 프로젝트 루트를 우선한다.
  const root = path.resolve(process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd());
  const dataDir = path.join(root, "data");
  const outDir = path.join(root, "out");
  const tool = input.tool_name;
  const ti = input.tool_input || {};

  const isInData = (p) => {
    if (!p) return false;
    const rel = path.relative(norm(dataDir), norm(path.resolve(root, String(p))));
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  };

  // ── 파일 편집 도구: 경로로 정확히 판정 ─────────────────────────
  if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(tool)) {
    const target = ti.file_path || ti.notebook_path;
    if (isInData(target)) {
      const suggest = path.join(outDir, path.basename(String(target)));
      deny(
        `data/ 아래 원본 검사 데이터는 편집할 수 없습니다 (${target}). ` +
          `결과 파일은 out/ 에 저장하세요. 예: ${suggest}`
      );
    }
    process.exit(0);
  }

  // ── 셸 명령: 최선 노력(best-effort) 판정 ─────────────────────
  if (tool === "Bash" || tool === "PowerShell") {
    const cmd = String(ti.command || "");
    // data 를 경로 요소로 언급하는지 (data/x, "data", cd data, .\data 등)
    const D = String.raw`(?:^|[\s"'=(/\\])data(?=[/\\\s"';&|)]|$)`;
    const mentionsData = new RegExp(D, "i").test(cmd);
    if (!mentionsData) process.exit(0);

    // 디렉터리를 data 로 옮긴 뒤 쓰는 경우까지 잡기 위해, cd/Set-Location data 가 있으면
    // 이후 모든 쓰기성 명령을 data 대상으로 간주한다.
    const cdIntoData = new RegExp(String.raw`(?:^|[;&|\s])(?:cd|pushd|Set-Location|sl)\s+` + `["']?[^\\s;&|"']*` + String.raw`\bdata\b`, "i").test(cmd);

    const rules = [
      // 삭제·이동·이름변경: data 언급만 있어도 원본이 사라질 수 있으므로 차단
      /(?:^|[\s;&|(])(?:rm|rmdir|unlink|shred|mv|del|erase|rd|ren|rename|move|Remove-Item|Move-Item|Rename-Item|Clear-Content|ri|mi|rni)\b/i,
      // 파일을 제자리에서 바꾸는 명령
      /(?:^|[\s;&|(])(?:sed\s+-i|perl\s+-i|truncate|touch|chmod|attrib)\b/i,
      // 리다이렉션·tee·PowerShell 쓰기 cmdlet 의 대상이 data
      new RegExp(String.raw`(?:>>?|\btee(?:\s+-a)?|\bSet-Content|\bAdd-Content|\bOut-File|\bNew-Item|\bsc|\bac)\s*(?:-\w+\s+)*["']?` + String.raw`[^\s"';&|]*\bdata[/\\]`, "i"),
      // 복사: 목적지(마지막 인자)가 data 인 경우만 차단 — data → out 복사는 허용
      new RegExp(String.raw`(?:^|[\s;&|(])(?:cp|copy|xcopy|robocopy|Copy-Item|cpi)\b[^;&|]*\s["']?(?:\.[/\\])?data(?:[/\\][^\s;&|"']*)?["']?\s*(?:$|[;&|])`, "i"),
      // 스크립트 안에서 data 경로로 저장 (load_workbook 등 읽기는 해당 없음)
      new RegExp(String.raw`(?:\.save|\.to_excel|\.to_csv|writeFile(?:Sync)?|appendFile(?:Sync)?|write_text|write_bytes|copyfile|copy2?|move)\s*\(\s*(?:r|f)?["'][^"']*\bdata[/\\]`, "i"),
      // open("data/...", "w"/"a"/"x"/"r+") — 읽기 모드 open 은 허용
      new RegExp(String.raw`open\s*\(\s*(?:r|f)?["'][^"']*\bdata[/\\][^"']*["']\s*,\s*(?:mode\s*=\s*)?["'][^"']*[wax+]`, "i"),
    ];

    const writesToData = rules.some((re) => re.test(cmd));

    const genericWrite =
      /(?:^|[\s;&|(])(?:rm|mv|cp|tee|touch|del|move|copy|Remove-Item|Move-Item|Copy-Item|Set-Content|Add-Content|Out-File|New-Item)\b|>>?|\.save\(|to_excel|writeFile/i;

    if (writesToData || (cdIntoData && genericWrite.test(cmd))) {
      deny(
        "data/ 아래 원본 검사 데이터는 편집·삭제·이동할 수 없습니다. " +
          "읽기는 허용되며, 결과 파일은 out/ 에 저장하세요."
      );
    }
  }

  process.exit(0);
});
