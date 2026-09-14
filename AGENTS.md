# AGENTS.md

**이 파일이 에이전트 지침의 정본이다.** Codex 는 `AGENTS.md` 를 설정 없이 읽고, Claude Code 는 옆의
`CLAUDE.md` 가 이 파일을 import 해 읽는다(그 파일에 규칙을 적지 말 것 — 두 도구가 서로 다른 지침을
보게 된다). 사용자에게 보내는 응답은 한국어로 작성한다.

## 이 저장소

프로젝트 코드가 아니라, **여러 프로젝트 저장소의 mirror(`repos/*.git`)를 모아 두고 그날의 커밋을
보고용 요약과 진척도로 바꾸는 도구**다. 코드는 `wf.js` 하나이고 외부 의존성이 없다.

- 커밋 수집은 반드시 `node wf.js daily ...` 로 한다. mirror 에 `git log` 를 직접 치지 않는다 — 작성자
  필터(`config.json` 의 `authors`)와 제품 태그(`products`)가 그 명령 안에서 적용된다.
- 진척도는 `node wf.js progress set|note|rm` 으로만 바꾼다. `progress.md` 를 손으로 편집하지 않는다.
- `config.json`·`progress.md`·`repos/` 는 개인 데이터라 gitignore 대상이다. 커밋하거나 내용을
  다른 곳에 옮기지 않는다. 설정 양식은 `config.example.json` 이다.
- 명령은 저장소 루트 기준 상대 경로(`node wf.js`)로 쓴다. 절대 경로(`~/...`)를 문서·스킬에 박지 않는다 —
  이 저장소는 누구나 clone 해서 쓰는 것이 전제다.

## 스킬

훅·스킬의 정본은 `.agents/` 이고, `.claude/skills` 는 그 디렉토리를 통째로 가리키는 심볼릭 링크다.
Codex 는 `.agents/skills/` 를 설정 없이 읽고(`$이름`), Claude Code 는 링크를 통해 같은 파일을 읽는다
(`/이름`). 스킬을 추가하거나 고칠 때는 `.agents/skills/<이름>/SKILL.md` 만 만진다. `.claude/skills/`
아래에 실파일을 두거나 스킬 단위로 링크를 쪼개지 말 것 — 한쪽 도구에서만 보이는 스킬이 생긴다.

| 스킬     | 호출                                    | 하는 일                                                          |
| -------- | --------------------------------------- | ---------------------------------------------------------------- |
| `daily`  | Claude Code `/daily` · Codex `$daily`   | 오늘 커밋 → 관리자 보고용 요약 + `progress.md` 진척도 갱신           |
| `weekly` | Claude Code `/weekly` · Codex `$weekly` | 한 주(또는 며칠) 커밋 → 결과 단위로 압축한 주간 요약 + 완료 항목 + 진척도 |

사용자가 "오늘 한 일 정리", "standup", "작업 로그" 류로 말하면 스킬명을 부르지 않아도 `daily` 를, "주간 보고",
"이번 주 정리", "지난주" 류면 `weekly` 를 쓴다. `weekly` 는 `daily` 의 규칙 위에 차이만 얹은 것이라 둘을 같이 읽는다.
