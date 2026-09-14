# wf — git 커밋을 보고용 작업 요약과 진척도로

여러 프로젝트 저장소의 커밋을 한 곳에 모아, **비개발 관리자에게 보낼 일일 작업 요약**과
**진척도(progress.md)** 를 만드는 도구입니다. 단일 파일 Node CLI(`wf.js`, 외부 의존성 없음)와
Claude Code · Codex 양쪽에서 같은 이름으로 쓰는 스킬(`daily`)로 이루어져 있습니다.

```
프로젝트 저장소들 ──wf add──▶ repos/*.git (mirror)
                                   │
                        wf daily   │  내 커밋만, 저장소·브랜치별, [제품명] 태그
                                   ▼
      Claude Code /daily · Codex $daily ──▶ 보고용 요약 (대화에 출력)
                                        └─▶ progress.md 진척도 갱신
```

개인 데이터(`repos/`, `config.json`, `progress.md`)는 gitignore 대상이라 저장소를 그대로 공유해도
다른 사람의 커밋·설정이 섞이지 않습니다. 각자 clone 해서 자기 저장소를 등록해 쓰면 됩니다.

## 요구사항

- Node.js 18 이상, git
- (선택) [Claude Code](https://claude.com/claude-code) 또는 [Codex CLI](https://github.com/openai/codex) — 요약 스킬을 쓰려면 둘 중 하나

## 설치

```bash
git clone <이 저장소 URL> wf && cd wf
alias wf='node "$PWD/wf.js"'       # 셸 설정에 넣어 두면 어디서나 wf. 또는 npm link
```

아래 명령은 전부 `wf` 로 적지만, alias 없이 저장소 루트에서 `node wf.js` 로 실행해도 됩니다.

## 설정

```bash
cp config.example.json config.json
wf add git@github.com:org/my-monorepo.git     # repos/my-monorepo.git 에 mirror clone
wf add git@github.com:org/homepage.git
wf ls                                         # 등록 저장소·작성자 필터·제품 매핑 확인
```

`config.json` 은 두 항목입니다.

| 키         | 뜻                                                                                               |
| `authors`  | 집계할 커밋 작성자 이메일 목록. `wf add` 가 저장소의 작성자 통계를 보여 주니 거기서 고르세요. 비워 두면 `git config user.email` 하나만 씁니다. |
| `products` | 커밋 → **보고용 제품명** 규칙(선택). `wf daily` 가 커밋마다 `[제품명]` 태그를 붙이고, 요약 스킬이 그 이름으로 제목과 진척도 항목을 씁니다. |

`products` 는 규칙 배열이고 위에서부터 평가합니다.

```json
{ "repo": "my-monorepo", "scope": ["web", "admin"], "path": ["apps/web"], "name": "웹 관리자" }
```

- `repo` — 저장소 이름(`repos/<이름>.git`). 생략하면 모든 저장소에 적용.
- `scope` — 커밋 제목의 `type(scope):` 접두에 든 scope. **먼저 본다**(작성자의 의도).
- `path` — 변경 파일 경로 접두. scope 가 없거나 안 맞을 때 본다. 여러 제품에 걸치면 `[A · B]` 로 붙는다.
- `scope`·`path` 가 둘 다 없는 규칙은 그 저장소의 **기본값**(맨 뒤에 둔다).
- `name` — 독자가 아는 제품명. 공용 패키지처럼 별도 주제로 세우지 않을 것은 이름에 안내를 붙여 두면
  스킬이 따른다(예: `"공용 계층 (소비하는 앱 주제에 흡수)"`).

매핑이 없어도 동작합니다 — 태그 없이 저장소 이름만 나오고, 스킬이 규칙 추가를 안내합니다.

## 일상 사용

```bash
# 작업 → 커밋 → 푸시 후
wf daily                  # 오늘 커밋 (자동 fetch) + progress.md 를 마크다운으로 출력
wf daily yesterday        # 어제
wf daily -7..today        # 최근 1주
wf daily 2026-09-10 --json
wf sync                   # fetch 만

wf progress                                   # 최신 날짜 섹션 출력 (그대로 복사해서 전달)
wf progress --date=2026-09-10                 # 특정 날짜 섹션
wf progress set "웹 관리자 - 설정 화면" 30 "재설계안 반영 시작"   # 진척률 갱신 + 메모 (없는 제목이면 새 항목)
wf progress note "웹 관리자 - 설정 화면" "차트 컴포넌트 완료"
wf progress rm "알림"
wf progress history                           # 항목별 진척률 추이 (09-10 30% → 09-11 90%)
```

`progress.md` 는 `## YYYY-MM-DD` 섹션으로 날짜별로 쌓입니다. `wf daily` 를 돌리면 보고일 섹션이 없을 때
직전 날짜에서 100% 미만인 항목만 복사해 새로 만들고(완료 항목은 완료한 날에만 남음), `set/note/rm` 은
오늘 섹션(`--date=` 로 변경 가능)에만 적용되므로 지난 날짜의 기록은 그대로 남습니다. 제목은 정확히
일치하거나 유일하게 부분 일치하면 됩니다. 직접 편집해도 됩니다.

## AI 에이전트로 요약하기 (Claude Code · Codex)

스킬 `daily` 가 `wf daily` 출력을 읽어 **관리자 보고용 요약 + 갱신된 진척도** 두 블록을 대화에
출력합니다. 커밋을 나열하지 않고 주제로 묶고, 저장소를 열어봐야 아는 이름(훅·파일 경로·심볼)은 역할
설명으로 바꿔 씁니다. 자세한 규칙은 `.agents/skills/daily/SKILL.md`.

**이 저장소 루트에서** 에이전트를 열고:

| 도구        | 호출     | 준비                                                                                     |
| ----------- | -------- | ---------------------------------------------------------------------------------------- |
| Claude Code | `/daily` | 없음. `.claude/skills` 가 `.agents/skills` 를 가리키는 심볼릭 링크라 그대로 보입니다.      |
| Codex CLI   | `$daily` | 처음 열 때 신뢰 여부를 물으면 **trusted** 로 답합니다. trusted 가 아니면 저장소 스킬(`.agents/skills/`)을 읽지 않습니다(Codex 0.154 에서 확인). |

"오늘 한 일 정리해줘", "standup" 처럼 말해도 스킬이 잡힙니다. `wf daily yesterday` 처럼 범위를 바꾸고
싶으면 "어제 커밋 요약" 이라고 하면 됩니다.

### 두 도구가 같은 파일을 읽는 구조

- `AGENTS.md` 가 에이전트 지침의 정본이고 `CLAUDE.md` 는 그것을 `@AGENTS.md` 로 import 하는 포인터입니다.
  규칙은 `AGENTS.md` 에만 적습니다.
- 스킬 정본은 `.agents/skills/` 이고 `.claude/skills` 는 그 디렉토리 전체를 가리키는 심볼릭 링크입니다.
  스킬을 추가할 때는 `.agents/skills/<이름>/SKILL.md` 만 만들면 양쪽에 동시에 보입니다.
- Windows 에서 clone 하면 심볼릭 링크가 일반 파일로 풀릴 수 있습니다. 개발자 모드를 켜고
  `git clone -c core.symlinks=true ...` 로 받거나, WSL 에서 쓰세요.

## 구조

```
wf.js                      CLI 본체 (add · ls · sync · daily · progress)
config.example.json        설정 양식 → 복사해서 config.json (gitignore)
AGENTS.md                  에이전트 지침 정본 (Codex 가 직접 읽음)
CLAUDE.md                  → @AGENTS.md 포인터
.agents/skills/daily/      요약 스킬 정본 (Codex $daily)
.claude/skills → ../.agents/skills   Claude Code 용 링크 (/daily)
repos/                     mirror clone 저장소 (gitignore)
progress.md                진척도 — 날짜 섹션별로 누적 (gitignore)
```

## 라이선스

[MIT](LICENSE)
